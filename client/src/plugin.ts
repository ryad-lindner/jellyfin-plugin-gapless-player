import type { AppHostApi, AppSettingsApi, EventsApi, PlaybackManagerApi, PluginDeps } from './deps';

const TICKS_PER_MS = 10000;
const VOLUME_EXPONENT = 3;
const TIMEUPDATE_INTERVAL_MS = 1000;
const BLOCKING_LOOKAHEAD_THRESHOLD_MS = 30000;
const LOG_PREFIX = '[GaplessPlayer]';

const SETTING_ENABLED = 'enableWebAudioGapless';
const SETTING_DEBUG = 'enableWebAudioGaplessDebug';
const SETTING_VOLUME = 'volume';

type AudioContextConstructor = typeof AudioContext;
type RepeatMode = 'RepeatNone' | 'RepeatOne' | 'RepeatAll';
type QueueShuffleMode = 'Sorted' | 'Shuffle';

interface WebkitAudioWindow extends Window {
    webkitAudioContext?: AudioContextConstructor;
}

interface GaplessMediaSource {
    Id?: string | null;
    Path?: string | null;
    RunTimeTicks?: number | null;
    MediaStreams?: unknown[];
    StreamUrl?: string | null;
}

interface GaplessItem {
    Id?: string | null;
    Name?: string | null;
    Path?: string | null;
    MediaType?: string | null;
    RunTimeTicks?: number | null;
    PlaylistItemId?: string | null;
    PresetMediaSource?: GaplessMediaSource | null;
    Url?: string | null;
}

interface GaplessPlayOptions {
    item?: GaplessItem | null;
    items?: GaplessItem[] | null;
    startIndex?: number;
    startPositionTicks?: number;
    fullscreen?: boolean;
    enableWebAudioGapless?: boolean;
}

interface ScheduleEntry {
    startTime: number;
    playbackId: number;
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
    return window.AudioContext || (window as WebkitAudioWindow).webkitAudioContext;
}

function isFiniteDuration(item?: GaplessItem | null): boolean {
    return typeof item?.RunTimeTicks === 'number' && Number.isFinite(item.RunTimeTicks) && item.RunTimeTicks > 0;
}

function getMediaSource(item?: GaplessItem | null): GaplessMediaSource {
    return item?.PresetMediaSource || {
        Id: item?.Id,
        RunTimeTicks: item?.RunTimeTicks,
        MediaStreams: []
    };
}

function getStreamUrl(item?: GaplessItem | null): string | null | undefined {
    return item?.PresetMediaSource?.StreamUrl || item?.PresetMediaSource?.Path || item?.Url || item?.Path;
}

function clonePlaylistItems(items?: GaplessItem[] | null): GaplessItem[] {
    return (items || []).map((item) => ({ ...item }));
}

function isGaplessItem(item: GaplessItem | null | undefined): item is GaplessItem {
    return item != null;
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}

/** Inclusive random integer in [min, max]. Mirrors jellyfin-web utils/number. */
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * The web client normally derives this from config.json. For a same-origin
 * deployment (web client served by the same server) same-origin credentials
 * are correct; cross-origin setups can override via window.__gaplessCors.
 */
function getIncludeCorsCredentials(): boolean {
    return (window as unknown as { __gaplessCors?: boolean }).__gaplessCors === true;
}

class WebAudioGaplessPlayer {
    name = 'Web Audio Gapless Player';
    type = 'mediaplayer';
    id = 'webaudiogaplessplayer';
    priority = 0;
    isLocalPlayer = true;
    supportsProgress = true;
    fallbackOnPlayError = true;

    private readonly _events: EventsApi;
    private readonly _appSettings: AppSettingsApi;
    private readonly _playbackManager: PlaybackManagerApi;
    private readonly _appHost: AppHostApi;

    private _playlist: GaplessItem[] = [];
    private _sortedPlaylist: GaplessItem[] = [];
    private _currentIndex = 0;
    private _decoded = new Map<number, AudioBuffer>();
    private _decoding = new Map<number, Promise<AudioBuffer>>();
    private _decodeAborts = new Map<number, AbortController>();
    private _scheduled = new Map<number, AudioBufferSourceNode>();
    private _scheduledStartTimes = new Map<number, number>();
    private _schedule = new Map<number, ScheduleEntry>();
    private _volume = 100;
    private _muted = false;
    private _isPaused = true;
    private _started = false;
    private _repeatMode: RepeatMode = 'RepeatNone';
    private _shuffleMode: QueueShuffleMode = 'Sorted';
    private _audioStreamIndex: number | null = null;
    private _subtitleStreamIndex: number | null = null;
    private _secondarySubtitleStreamIndex: number | null = null;
    private _baseContextTime = 0;
    private _basePositionMs = 0;
    private _pausePositionMs = 0;
    private _playOptions: GaplessPlayOptions = {};
    private _playbackId = 0;
    private _audioContext: AudioContext | null = null;
    private _gainNode: GainNode | null = null;
    private _timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

    constructor(deps: PluginDeps) {
        this._events = deps.events;
        this._appSettings = deps.appSettings;
        this._playbackManager = deps.playbackManager;
        this._appHost = deps.appHost;
        this._volume = this.getSavedVolumeLevel();
    }

    // --- Local settings (localStorage via appSettings) ---------------------

    /** Installed = enabled: default true when the setting has never been set. */
    private isGaplessEnabled(): boolean {
        const value = this._appSettings.get(SETTING_ENABLED);
        return value == null ? true : value === 'true';
    }

    private isDebugEnabled(): boolean {
        return this._appSettings.get(SETTING_DEBUG) === 'true';
    }

    private getSavedVolumeLevel(): number {
        const saved = Number.parseFloat(String(this._appSettings.get(SETTING_VOLUME) ?? 1));
        return Math.min(Math.round(Math.pow(saved, 1 / VOLUME_EXPONENT) * 100), 100);
    }

    private saveVolume(value: number): void {
        if (value) {
            this._appSettings.set(SETTING_VOLUME, String(value));
        }
    }

    private debugLog(message: string, data?: unknown): void {
        if (!this.isDebugEnabled()) {
            return;
        }

        if (data === undefined) {
            console.debug(`${LOG_PREFIX} ${message}`);
        } else {
            console.debug(`${LOG_PREFIX} ${message}`, data);
        }
    }

    // --- Player contract ---------------------------------------------------

    canPlayMediaType(mediaType?: string): boolean {
        return (mediaType || '').toLowerCase() === 'audio';
    }

    canPlayItem(item?: GaplessItem | null, playOptions: GaplessPlayOptions = {}): boolean {
        if (!this.isGaplessEnabled()) {
            return false;
        }

        if (playOptions.enableWebAudioGapless === false) {
            return false;
        }

        if (!getAudioContextConstructor()) {
            return false;
        }

        if (playOptions.items) {
            return playOptions.items.length > 1
                && playOptions.items.every((i) => i?.MediaType === 'Audio' && isFiniteDuration(i));
        }

        return this._playlist.length > 1
            && item?.MediaType === 'Audio'
            && isFiniteDuration(item)
            && this._playlist.some(i => (item.Id != null && i.Id === item.Id)
                || (item.PlaylistItemId != null && i.PlaylistItemId === item.PlaylistItemId));
    }

    getDeviceProfile(item?: GaplessItem | null): unknown {
        if (this._appHost.getDeviceProfile) {
            return this._appHost.getDeviceProfile(item);
        }

        return {};
    }

    async play(options: GaplessPlayOptions): Promise<void> {
        await this.stop(false);

        this._playOptions = options || {};
        this._playlist = clonePlaylistItems(options.items || [options.item].filter(isGaplessItem));
        this._sortedPlaylist = [];
        this._currentIndex = options.startIndex || 0;
        this._currentIndex = Math.max(0, Math.min(this._currentIndex, this._playlist.length - 1));
        this._basePositionMs = (options.startPositionTicks || 0) / TICKS_PER_MS;
        this._pausePositionMs = this._basePositionMs;
        // Mirror PlayQueueManager.setPlaylist: a new queue resets the modes.
        this._repeatMode = 'RepeatNone';
        this._shuffleMode = 'Sorted';

        if (!this._playlist.length) {
            return Promise.reject(new Error('No items to play'));
        }

        this.debugLog('starting gapless queue', {
            items: this._playlist.length,
            startIndex: this._currentIndex
        });

        await this._ensureAudioGraph();
        try {
            await this._decodeIndex(this._currentIndex);
        } catch (err) {
            if (isAbortError(err)) {
                // Superseded by a newer play/stop request.
                return;
            }
            throw err;
        }
        this._preloadNext();
        await this._startFrom(this._currentIndex, this._basePositionMs);
    }

    stop(destroyPlayer: boolean): Promise<void> {
        this._playbackId++;
        this._stopScheduledSources();
        this._stopTimeUpdates();
        this._clearDecodedAfterMutation();
        this._isPaused = true;
        this._started = false;
        this._pausePositionMs = 0;

        if (destroyPlayer) {
            this._clearPlaylistState();
            this.destroy();
        }

        return Promise.resolve();
    }

    destroy(): void {
        this._playbackId++;
        this._stopScheduledSources();
        this._stopTimeUpdates();
        this._clearDecodedAfterMutation();
        this._clearPlaylistState();

        if (this._audioContext) {
            this._audioContext.close().catch((err) => {
                console.warn(`${LOG_PREFIX} failed to close AudioContext`, err);
            });
            this._audioContext = null;
        }

        this._gainNode = null;
    }

    pause(): void {
        if (this._isPaused) {
            return;
        }

        this._pausePositionMs = this.getCurrentTimeMs();
        this._stopScheduledSources();
        this._stopTimeUpdates();
        this._isPaused = true;
        this._events.trigger(this, 'pause');
    }

    resume(): Promise<void> {
        return this.unpause();
    }

    unpause(): Promise<void> {
        if (!this._isPaused) {
            return Promise.resolve();
        }

        return this._startFrom(this._currentIndex, this._pausePositionMs);
    }

    paused(): boolean {
        return this._isPaused;
    }

    currentTime(val?: number): number {
        if (val != null) {
            this._seekToMs(val).catch((err) => {
                console.error(`${LOG_PREFIX} failed to seek`, err);
            });
        }

        return this.getCurrentTimeMs();
    }

    private getCurrentTimeMs(): number {
        if (this._isPaused || !this._audioContext) {
            return this._pausePositionMs;
        }

        return this._basePositionMs + ((this._audioContext.currentTime - this._baseContextTime) * 1000);
    }

    duration(): number | null {
        // The player contract expects milliseconds (see getNowPlayingItemForReporting).
        const ticks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
        return ticks ? ticks / TICKS_PER_MS : null;
    }

    seekable(): boolean {
        return true;
    }

    getBufferedRanges(): never[] {
        return [];
    }

    seek(positionTicks: number): Promise<void> {
        return this._seekToMs(positionTicks / TICKS_PER_MS);
    }

    private _seekToMs(positionMs: number): Promise<void> {
        if (this._isPaused) {
            // Seeking must not unpause; just move the resume position.
            this._basePositionMs = positionMs;
            this._pausePositionMs = positionMs;
            this._events.trigger(this, 'timeupdate');
            return Promise.resolve();
        }

        return this._startFrom(this._currentIndex, positionMs);
    }

    setVolume(val: number): void {
        this._volume = Math.max(0, Math.min(val, 100));
        this.saveVolume(Math.pow(this._volume / 100, VOLUME_EXPONENT));
        this._applyVolume();
        this._events.trigger(this, 'volumechange');
    }

    getVolume(): number {
        return this._volume;
    }

    volumeUp(): void {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown(): void {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute: boolean): void {
        this._muted = mute;
        this._applyVolume();
        this._events.trigger(this, 'volumechange');
    }

    isMuted(): boolean {
        return this._muted;
    }

    getPlaybackRate(): number {
        return 1;
    }

    setPlaybackRate(): void {
        // Playback-rate parity is out of scope for the gapless MVP.
    }

    getRepeatMode(): RepeatMode {
        return this._repeatMode;
    }

    setRepeatMode(value: RepeatMode): void {
        if (value !== this._repeatMode) {
            this._repeatMode = value;
            // The scheduled lookahead may now point at the wrong track
            // (e.g. RepeatOne wants the current one again, RepeatAll wraps).
            this._resyncLookahead();
        }
        this._events.trigger(this, 'repeatmodechange');
    }

    getQueueShuffleMode(): QueueShuffleMode {
        return this._shuffleMode;
    }

    setQueueShuffleMode(value: QueueShuffleMode): void {
        if (value !== this._shuffleMode) {
            const oldCurrentIndex = this._currentIndex;

            if (value === 'Shuffle') {
                this._shufflePlaylist();
            } else {
                this._sortPlaylist();
            }

            this._shuffleMode = value;
            this._handlePlaylistMutation(oldCurrentIndex);
        }
        this._events.trigger(this, 'shufflequeuemodechange');
    }

    toggleQueueShuffleMode(): void {
        this.setQueueShuffleMode(this._shuffleMode === 'Shuffle' ? 'Sorted' : 'Shuffle');
    }

    getAudioStreamIndex(): number | null {
        return this._audioStreamIndex;
    }

    setAudioStreamIndex(index: number | null): void {
        this._audioStreamIndex = index;
    }

    canSetAudioStreamIndex(): boolean {
        return false;
    }

    getSubtitleStreamIndex(): number | null {
        return this._subtitleStreamIndex;
    }

    setSubtitleStreamIndex(index: number | null): void {
        this._subtitleStreamIndex = index;
    }

    getSecondarySubtitleStreamIndex(): number | null {
        return this._secondarySubtitleStreamIndex;
    }

    audioTracks(): never[] {
        return [];
    }

    subtitleTracks(): never[] {
        return [];
    }

    currentItem(): GaplessItem | null {
        return this._playlist[this._currentIndex] || null;
    }

    currentMediaSource(): GaplessMediaSource | null {
        const item = this.currentItem();
        return item ? getMediaSource(item) : null;
    }

    playMethod(): 'DirectPlay' {
        return 'DirectPlay';
    }

    playSessionId(): string | null {
        // The universal audio stream URL built by playbackManager carries the
        // PlaySessionId; report the same one so server-side session tracking
        // matches what is actually being streamed.
        const url = getStreamUrl(this.currentItem());
        if (!url) {
            return null;
        }

        try {
            return new URL(url, window.location.href).searchParams.get('PlaySessionId');
        } catch {
            return null;
        }
    }

    currentSrc(): string | null | undefined {
        return getStreamUrl(this.currentItem());
    }

    getPlaylist(): Promise<GaplessItem[]> {
        return Promise.resolve(this._playlist);
    }

    getPlaylistSync(): GaplessItem[] {
        return this._playlist;
    }

    getCurrentPlaylistIndex(): number {
        return this._currentIndex;
    }

    getCurrentPlaylistItemId(): string | null | undefined {
        return this.currentItem()?.PlaylistItemId;
    }

    setCurrentPlaylistItem(playlistItemId: string): Promise<void> {
        const index = this._playlist.findIndex(item => item.PlaylistItemId === playlistItemId);
        if (index === -1) {
            return Promise.resolve();
        }

        return this._startFrom(index, 0);
    }

    nextTrack(): Promise<void> {
        // Mirrors PlayQueueManager.getNextItemInfo: manual "next" honors
        // RepeatOne (replays current) and RepeatAll (wraps to the start).
        const nextIndex = this._nextIndex(this._currentIndex);
        if (nextIndex == null) {
            return Promise.resolve();
        }

        return this._startFrom(nextIndex, 0);
    }

    previousTrack(): Promise<void> {
        if (this.getCurrentTimeMs() > 3000) {
            return this._startFrom(this._currentIndex, 0);
        }

        return this._startFrom(Math.max(0, this._currentIndex - 1), 0);
    }

    queue(items: GaplessItem[]): void {
        this._playlist.push(...clonePlaylistItems(items));
        // Indexes are unchanged by an append, but the current track may have
        // been the last one, so a new lookahead may be needed.
        if (!this._isPaused) {
            this._scheduleLookaheadForCurrent();
            this._preloadNext();
        }
        this._events.trigger(this, 'playlistitemadd');
    }

    queueNext(items: GaplessItem[]): void {
        this._playlist.splice(this._currentIndex + 1, 0, ...clonePlaylistItems(items));
        this._handlePlaylistMutation(this._currentIndex);
        this._events.trigger(this, 'playlistitemadd');
    }

    removeFromPlaylist(playlistItemIds: string | string[]): Promise<void> {
        const ids = new Set(Array.isArray(playlistItemIds) ? playlistItemIds : [playlistItemIds]);
        const oldCurrentIndex = this._currentIndex;
        const currentItemId = this.getCurrentPlaylistItemId();
        const isCurrentRemoved = currentItemId != null && ids.has(currentItemId);
        const removedBeforeCurrent = this._playlist
            .slice(0, oldCurrentIndex)
            .filter(item => item.PlaylistItemId && ids.has(item.PlaylistItemId))
            .length;

        this._playlist = this._playlist.filter(item => !item.PlaylistItemId || !ids.has(item.PlaylistItemId));
        this._currentIndex = Math.min(
            Math.max(0, oldCurrentIndex - removedBeforeCurrent),
            Math.max(0, this._playlist.length - 1)
        );
        this._events.trigger(this, 'playlistitemremove', [{ playlistItemIds }]);

        if (!this._playlist.length) {
            return this.stop(true);
        }

        if (isCurrentRemoved) {
            // The playing track was removed; start the one that took its place.
            this._clearDecodedAfterMutation();
            return this._startFrom(this._currentIndex, 0);
        }

        this._handlePlaylistMutation(oldCurrentIndex);
        return Promise.resolve();
    }

    movePlaylistItem(playlistItemId: string, newIndex: number): void {
        const currentItemId = this.getCurrentPlaylistItemId();
        const oldCurrentIndex = this._currentIndex;
        const oldIndex = this._playlist.findIndex(item => item.PlaylistItemId === playlistItemId);
        if (oldIndex === -1 || oldIndex === newIndex) {
            return;
        }

        const [item] = this._playlist.splice(oldIndex, 1);
        this._playlist.splice(newIndex, 0, item);
        this._currentIndex = this._playlist.findIndex(i => i.PlaylistItemId === currentItemId);
        if (this._currentIndex === -1) {
            this._currentIndex = 0;
        }
        this._handlePlaylistMutation(oldCurrentIndex);
        this._events.trigger(this, 'playlistitemmove', [{ playlistItemId, newIndex }]);
    }

    /**
     * Re-keys per-index playback state after a playlist mutation. The
     * currently playing source keeps playing under its new index; everything
     * scheduled or decoded for other (now stale) indexes is discarded and
     * rebuilt, otherwise a previously scheduled source would still fire at the
     * boundary and play the wrong track.
     */
    private _handlePlaylistMutation(oldCurrentIndex: number): void {
        const currentSource = this._scheduled.get(oldCurrentIndex);
        const currentStartTime = this._scheduledStartTimes.get(oldCurrentIndex);
        const currentSchedule = this._schedule.get(oldCurrentIndex);
        const currentBuffer = this._decoded.get(oldCurrentIndex);

        for (const [index, source] of this._scheduled) {
            if (index === oldCurrentIndex) {
                continue;
            }

            source.onended = null;
            try {
                source.stop();
            } catch {
                // Source may not have started yet or may already have ended.
            }
        }

        this._scheduled.clear();
        this._scheduledStartTimes.clear();
        this._schedule.clear();
        this._clearDecodedAfterMutation();

        const newCurrentIndex = this._currentIndex;
        if (currentSource) {
            const playbackId = this._playbackId;
            currentSource.onended = () => this._onSourceEnded(newCurrentIndex, playbackId);
            this._scheduled.set(newCurrentIndex, currentSource);
        }
        if (currentStartTime != null) {
            this._scheduledStartTimes.set(newCurrentIndex, currentStartTime);
        }
        if (currentSchedule) {
            this._schedule.set(newCurrentIndex, currentSchedule);
        }
        if (currentBuffer) {
            this._decoded.set(newCurrentIndex, currentBuffer);
        }

        if (!this._isPaused) {
            this._scheduleLookaheadForCurrent();
            this._preloadNext();
        }
    }

    private async _ensureAudioGraph(): Promise<void> {
        if (!this._audioContext) {
            const AudioContextCtor = getAudioContextConstructor();
            if (!AudioContextCtor) {
                throw new Error('Web Audio API is not available');
            }
            this._audioContext = new AudioContextCtor();
            this._gainNode = this._audioContext.createGain();
            this._gainNode.connect(this._audioContext.destination);
            this._applyVolume();
        }

        if (this._audioContext.state === 'suspended') {
            await this._audioContext.resume();
        }
    }

    private _applyVolume(): void {
        if (this._gainNode) {
            const volume = this._muted ? 0 : Math.pow(this._volume / 100, VOLUME_EXPONENT);
            this._gainNode.gain.value = volume;
        }
    }

    private async _decodeIndex(index: number): Promise<AudioBuffer> {
        if (this._decoded.has(index)) {
            return this._decoded.get(index) as AudioBuffer;
        }

        if (this._decoding.has(index)) {
            return this._decoding.get(index) as Promise<AudioBuffer>;
        }

        const item = this._playlist[index];
        const url = getStreamUrl(item);
        if (!url) {
            throw new Error('Gapless item has no stream URL');
        }

        const abortController = new AbortController();
        const decode = this._fetchAndDecode(url, abortController.signal)
            .then((audioBuffer) => {
                // Cache only while this decode is still the registered one for
                // the index. stop() and playlist mutations clear _decoding to
                // invalidate stale results; _playbackId must not be used here
                // because _startFrom() bumps it after preloads were kicked off,
                // which would discard every lookahead decode.
                if (this._decoding.get(index) === decode) {
                    this._decoding.delete(index);
                    this._decodeAborts.delete(index);
                    this._decoded.set(index, audioBuffer);
                    this._scheduleDecodedLookahead(index, audioBuffer);
                    this._pruneDecoded();
                }

                return audioBuffer;
            })
            .catch((err) => {
                if (this._decoding.get(index) === decode) {
                    this._decoding.delete(index);
                    this._decodeAborts.delete(index);
                }
                throw err;
            });

        this._decoding.set(index, decode);
        this._decodeAborts.set(index, abortController);
        return decode;
    }

    private async _fetchAndDecode(url: string, signal: AbortSignal): Promise<AudioBuffer> {
        const response = await fetch(url, {
            credentials: getIncludeCorsCredentials() ? 'include' : 'same-origin',
            signal
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch gapless audio: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (!this._audioContext) {
            throw new Error('AudioContext was closed before decode completed');
        }

        return this._audioContext.decodeAudioData(arrayBuffer);
    }

    /**
     * Resolves the index that should play after the given one, honoring the
     * repeat mode. Returns null when playback should stop at the end.
     */
    private _nextIndex(index: number): number | null {
        if (!this._playlist.length) {
            return null;
        }

        if (this._repeatMode === 'RepeatOne') {
            return index;
        }

        const next = index + 1;
        if (next < this._playlist.length) {
            return next;
        }

        return this._repeatMode === 'RepeatAll' ? 0 : null;
    }

    private _preloadNext(): void {
        const nextIndex = this._nextIndex(this._currentIndex);
        if (nextIndex == null || this._decoded.has(nextIndex)) {
            return;
        }

        this._decodeIndex(nextIndex).catch((err) => {
            if (!isAbortError(err)) {
                console.warn(`${LOG_PREFIX} failed to preload next item`, err);
            }
        });
    }

    private async _startFrom(index: number, positionMs: number): Promise<void> {
        await this._ensureAudioGraph();
        const audioContext = this._audioContext;
        if (!audioContext) {
            throw new Error('AudioContext was not initialized');
        }
        const previousIndex = this._currentIndex;
        this._stopScheduledSources();
        this._stopTimeUpdates();

        this._currentIndex = index;
        this._playbackId++;
        const playbackId = this._playbackId;
        this._basePositionMs = positionMs;
        this._pausePositionMs = positionMs;
        this._baseContextTime = audioContext.currentTime;
        this._isPaused = false;

        const currentBuffer = await this._decodeIndex(index).catch((err) => {
            if (isAbortError(err)) {
                // Superseded by a newer play/seek/stop request.
                return null;
            }
            throw err;
        });
        if (!currentBuffer) {
            return;
        }
        const remainingMs = Math.max(0, (currentBuffer.duration * 1000) - positionMs);
        if (remainingMs <= BLOCKING_LOOKAHEAD_THRESHOLD_MS) {
            await this._decodeNextForBoundary(index);
        }

        if (playbackId !== this._playbackId) {
            // Superseded by a newer play/seek/stop while decoding.
            return;
        }

        const startedAt = audioContext.currentTime + 0.05;
        const endsAt = startedAt + currentBuffer.duration - (positionMs / 1000);

        this._scheduleIndex(index, currentBuffer, startedAt, positionMs / 1000, playbackId);
        // Virtual position-0 start time, so startTime + duration = end of track.
        this._schedule.set(index, { startTime: startedAt - (positionMs / 1000), playbackId });

        const nextIndex = this._nextIndex(index);
        if (nextIndex != null && nextIndex !== index) {
            this._schedule.set(nextIndex, { startTime: endsAt, playbackId });
            this._scheduleNextIfReady(nextIndex, endsAt, playbackId);
        }
        this._preloadNext();
        this._startTimeUpdates();

        if (!this._started || previousIndex !== index) {
            this._started = true;
            this._events.trigger(this, 'itemstarted', [this.currentItem(), this.currentMediaSource()]);
        } else {
            this._events.trigger(this, 'timeupdate');
        }

        this._events.trigger(this, 'unpause');
    }

    private _scheduleIndex(index: number, audioBuffer: AudioBuffer, startTime: number, offsetSeconds: number, playbackId = this._playbackId): void {
        if (!this._audioContext || !this._gainNode || playbackId !== this._playbackId) {
            return;
        }

        const source = this._audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this._gainNode);
        source.onended = () => this._onSourceEnded(index, playbackId);
        source.start(startTime, offsetSeconds);
        this._scheduled.set(index, source);
        this._scheduledStartTimes.set(index, startTime);
    }

    private async _decodeNextForBoundary(index: number): Promise<void> {
        const nextIndex = this._nextIndex(index);
        if (nextIndex == null || nextIndex === index) {
            return;
        }

        this.debugLog('waiting for next item before near-boundary start', {
            index: nextIndex,
            name: this._playlist[nextIndex]?.Name
        });

        try {
            await this._decodeIndex(nextIndex);
        } catch (err) {
            // A failed lookahead must not fail the current track; the
            // boundary recovery path will retry when the track ends.
            if (!isAbortError(err)) {
                console.warn(`${LOG_PREFIX} failed to decode next item before boundary`, err);
            }
        }
    }

    private _scheduleNextIfReady(nextIndex: number, startTime: number, playbackId = this._playbackId): void {
        const nextBuffer = this._decoded.get(nextIndex);

        if (!nextBuffer || this._scheduled.has(nextIndex) || playbackId !== this._playbackId) {
            return;
        }

        this._scheduleIndex(nextIndex, nextBuffer, startTime, 0, playbackId);
        this.debugLog('scheduled next item gaplessly', {
            index: nextIndex,
            name: this._playlist[nextIndex]?.Name
        });
    }

    private _scheduleDecodedLookahead(index: number, audioBuffer: AudioBuffer): void {
        const schedule = this._schedule.get(index);
        if (!schedule || this._isPaused || this._scheduled.has(index) || schedule.playbackId !== this._playbackId || !this._audioContext) {
            return;
        }

        if (schedule.startTime <= this._audioContext.currentTime) {
            return;
        }

        this._scheduleIndex(index, audioBuffer, schedule.startTime, 0, schedule.playbackId);
    }

    private _onSourceEnded(index: number, playbackId: number): void {
        const audioContext = this._audioContext;
        if (playbackId !== this._playbackId || !audioContext) {
            return;
        }

        this._scheduled.delete(index);
        this._scheduledStartTimes.delete(index);
        this._schedule.delete(index);

        if (this._isPaused || index !== this._currentIndex) {
            return;
        }

        const item = this._playlist[index];
        const nextIndex = this._nextIndex(index);
        const nextItem = nextIndex != null ? this._playlist[nextIndex] : null;

        if (nextIndex == null || !nextItem) {
            this._isPaused = true;
            this._events.trigger(this, 'itemstopped', [{
                item,
                mediaSource: getMediaSource(item),
                positionMs: item?.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_MS : 0,
                nextItem: null,
                nextMediaType: null
            }]);
            return;
        }

        const nextStartTime = this._scheduledStartTimes.get(nextIndex);
        const isNextScheduled = nextStartTime != null
            && nextStartTime <= audioContext.currentTime + 0.25;
        const isNextDecoded = this._decoded.has(nextIndex);

        this._events.trigger(this, 'itemstopped', [{
            item,
            mediaSource: getMediaSource(item),
            positionMs: item?.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_MS : 0,
            nextItem: { item: nextItem },
            nextMediaType: nextItem.MediaType
        }]);

        if (playbackId !== this._playbackId) {
            return;
        }

        if (!isNextScheduled && !isNextDecoded) {
            console.warn(`${LOG_PREFIX} boundary missed; recovering in place`, {
                index,
                nextIndex,
                currentTime: audioContext.currentTime,
                nextStartTime,
                scheduledStartIndexes: Array.from(this._scheduledStartTimes.keys()),
                decodedIndexes: Array.from(this._decoded.keys())
            });
            this._recoverAtIndex(nextIndex);
            return;
        }

        this._currentIndex = nextIndex;
        this._basePositionMs = 0;
        this._pausePositionMs = 0;

        if (!this._scheduled.has(nextIndex)) {
            // Decoded but never scheduled (its start time had already passed
            // when the decode finished): start it now instead of going silent.
            const nextBuffer = this._decoded.get(nextIndex);
            if (nextBuffer) {
                const startTime = audioContext.currentTime;
                this._schedule.set(nextIndex, { startTime, playbackId });
                this._scheduleIndex(nextIndex, nextBuffer, startTime, 0, playbackId);
            }
        }

        const nextSchedule = this._schedule.get(this._currentIndex);
        this._baseContextTime = nextSchedule?.startTime || audioContext.currentTime;
        this._scheduleLookaheadForCurrent();
        this.debugLog('transitioned to next item', {
            index: this._currentIndex,
            name: this.currentItem()?.Name
        });
        this._events.trigger(this, 'itemstarted', [this.currentItem(), this.currentMediaSource()]);
        this._preloadNext();
        this._pruneDecoded();
    }

    /**
     * The next item was not ready when the current source ended. Try to keep
     * playback inside the gapless player and only hand off to the regular
     * player stack if decoding fails. Calling playbackManager.play() from here
     * while a user-initiated play request is in flight would let the two
     * requests race (e.g. a stale handoff resuming the old album over a newly
     * selected one), so this stays inside the plugin whenever possible.
     */
    private _recoverAtIndex(index: number): void {
        const playbackId = this._playbackId;

        this._decodeIndex(index)
            .then(() => {
                if (playbackId !== this._playbackId) {
                    return;
                }

                return this._startFrom(index, 0);
            })
            .catch((err) => {
                if (isAbortError(err) || playbackId !== this._playbackId) {
                    return;
                }

                console.error(`${LOG_PREFIX} failed to recover gapless playback`, err);
                this._handoffToNormalPlayback(index);
            });
    }

    private _handoffToNormalPlayback(startIndex: number): void {
        const items = this._playlist.slice(startIndex);
        this._isPaused = true;
        this._stopScheduledSources();
        this._stopTimeUpdates();

        this._playbackManager.play({
            items,
            fullscreen: this._playOptions.fullscreen,
            startIndex: 0,
            enableWebAudioGapless: false
        }).catch((err) => {
            console.error(`${LOG_PREFIX} failed to hand off to normal playback`, err);
        });
    }

    private _scheduleLookaheadForCurrent(): void {
        const currentBuffer = this._decoded.get(this._currentIndex);
        const currentSchedule = this._schedule.get(this._currentIndex);
        if (!currentBuffer || !currentSchedule) {
            return;
        }

        const nextIndex = this._nextIndex(this._currentIndex);
        if (nextIndex == null || nextIndex === this._currentIndex) {
            // RepeatOne restarts the current track at the boundary instead;
            // the same index cannot be scheduled twice.
            return;
        }

        const nextStartTime = currentSchedule.startTime + currentBuffer.duration;
        this._schedule.set(nextIndex, { startTime: nextStartTime, playbackId: this._playbackId });
        this._scheduleNextIfReady(nextIndex, nextStartTime, this._playbackId);
    }

    private _stopScheduledSources(): void {
        this._scheduled.forEach((source) => {
            source.onended = null;
            try {
                source.stop();
            } catch {
                // Source may not have started yet or may already have ended.
            }
        });
        this._scheduled.clear();
        this._scheduledStartTimes.clear();
        this._schedule.clear();
    }

    private _clearDecodedAfterMutation(): void {
        for (const abortController of this._decodeAborts.values()) {
            abortController.abort();
        }
        this._decodeAborts.clear();
        this._decoded.clear();
        this._decoding.clear();
    }

    private _clearPlaylistState(): void {
        this._playlist = [];
        this._sortedPlaylist = [];
        this._currentIndex = 0;
        this._baseContextTime = 0;
        this._basePositionMs = 0;
        this._pausePositionMs = 0;
        this._playOptions = {};
    }

    private _pruneDecoded(): void {
        const keep = new Set([this._currentIndex]);
        const nextIndex = this._nextIndex(this._currentIndex);
        if (nextIndex != null) {
            keep.add(nextIndex);
        }

        for (const index of this._decoded.keys()) {
            if (!keep.has(index)) {
                this._decoded.delete(index);
            }
        }
    }

    /**
     * Cancels the scheduled lookahead (keeping the current source and decode
     * cache) and rebuilds it. Used when the repeat mode changes and the
     * already-scheduled next track may no longer be the right one.
     */
    private _resyncLookahead(): void {
        for (const [index, source] of this._scheduled) {
            if (index === this._currentIndex) {
                continue;
            }

            source.onended = null;
            try {
                source.stop();
            } catch {
                // Source may not have started yet or may already have ended.
            }
            this._scheduled.delete(index);
            this._scheduledStartTimes.delete(index);
        }

        for (const index of this._schedule.keys()) {
            if (index !== this._currentIndex) {
                this._schedule.delete(index);
            }
        }

        if (!this._isPaused) {
            this._scheduleLookaheadForCurrent();
            this._preloadNext();
        }
    }

    /** Mirrors PlayQueueManager.shufflePlaylist: current track moves to the front. */
    private _shufflePlaylist(): void {
        if (!this._playlist.length) {
            return;
        }

        this._sortedPlaylist = [...this._playlist];
        const [currentItem] = this._playlist.splice(this._currentIndex, 1);

        for (let i = this._playlist.length - 1; i > 0; i--) {
            const j = randomInt(0, i - 1);
            [this._playlist[i], this._playlist[j]] = [this._playlist[j], this._playlist[i]];
        }

        this._playlist.unshift(currentItem);
        this._currentIndex = 0;
    }

    /**
     * Mirrors PlayQueueManager.sortShuffledPlaylist, including its limitation
     * that queue mutations made while shuffled are lost on un-shuffle.
     */
    private _sortPlaylist(): void {
        if (!this._sortedPlaylist.length) {
            return;
        }

        const currentItemId = this.getCurrentPlaylistItemId();
        const currentItem = this.currentItem();

        this._playlist = [...this._sortedPlaylist];
        this._sortedPlaylist = [];

        const index = this._playlist.findIndex(i => (currentItemId != null && i.PlaylistItemId === currentItemId)
            || (currentItem?.Id != null && i.Id === currentItem.Id));
        this._currentIndex = Math.max(0, index);
    }

    private _startTimeUpdates(): void {
        this._stopTimeUpdates();
        this._timeUpdateInterval = setInterval(() => {
            if (!this._isPaused) {
                this._events.trigger(this, 'timeupdate');
            }
        }, TIMEUPDATE_INTERVAL_MS);
    }

    private _stopTimeUpdates(): void {
        if (this._timeUpdateInterval) {
            clearInterval(this._timeUpdateInterval);
            this._timeUpdateInterval = null;
        }
    }
}

export default WebAudioGaplessPlayer;
