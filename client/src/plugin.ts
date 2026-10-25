import type { AppHostApi, AppSettingsApi, EventsApi, PlaybackManagerApi, PluginDeps } from './deps';
import { initNotifications } from './notifications';
import { getServerConfig } from './serverConfig';
import { setToggleDeps } from './toggle';

const TICKS_PER_MS = 10000;
const VOLUME_EXPONENT = 3;
const TIMEUPDATE_INTERVAL_MS = 1000;
// Repaint cadence for download progress; the now-playing bar throttles
// timeupdate to 700ms anyway, so finer granularity would be wasted.
const DOWNLOAD_PROGRESS_EVENT_MS = 500;
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
    GaplessFallback?: boolean;
}

interface GaplessPlayOptions {
    item?: GaplessItem | null;
    items?: GaplessItem[] | null;
    startIndex?: number;
    startPositionTicks?: number;
    fullscreen?: boolean;
    enableWebAudioGapless?: boolean;
}

interface OwedStop {
    item: GaplessItem;
    positionMs: number;
    // False for the awaited item of a boundary recovery: never announced.
    started: boolean;
}

interface PendingStart {
    playbackId: number;
    targetKey: string | null;
    positionMs: number;
    waitForNext: boolean;
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

let nextPlaylistItemId = 0;

// playbackManager assigns PlaylistItemIds only in its own play queue, not for
// a self-managed player; without them the queue UI cannot remove, move or
// select items. Appended items always get a fresh id: the same objects may be
// queued twice, and a shared id would remove or move both.
function clonePlaylistItems(items?: GaplessItem[] | null, freshIds = false): GaplessItem[] {
    return (items || []).map((item) => ({
        ...item,
        PlaylistItemId: (!freshIds && item.PlaylistItemId) || `gaplessItem${nextPlaylistItemId++}`
    }));
}

function isGaplessItem(item: GaplessItem | null | undefined): item is GaplessItem {
    return item != null;
}

/**
 * Returns a copy of the item without the gapless-only stream source, so
 * playbackManager re-resolves the media source through the normal path when
 * handing playback to the fallback player.
 */
function stripPresetSource(item: GaplessItem): GaplessItem {
    const clone = { ...item };
    delete clone.PresetMediaSource;
    delete clone.Url;
    return clone;
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}

/**
 * Identity key for "is this the same queue entry" checks across playlist
 * mutations, where the index alone is not stable. Items lacking both ids are
 * indistinguishable and compare as equal.
 */
function itemKey(item?: GaplessItem | null): string | null {
    return item?.PlaylistItemId ?? item?.Id ?? null;
}

/** Inclusive random integer in [min, max]. Mirrors jellyfin-web utils/number. */
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Strips a leading ID3v2 tag if present. Browsers' decodeAudioData requires the
 * container magic (e.g. "fLaC") at byte 0 and fails on ID3-prefixed files,
 * which are common on tagged FLAC rips; ffmpeg/<audio> skip the tag but Web
 * Audio does not. Returns the original buffer when there is no ID3 header.
 */
function stripLeadingId3(buffer: ArrayBuffer): ArrayBuffer {
    const bytes = new Uint8Array(buffer);
    // "ID3"
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return buffer;
    }

    // Syncsafe 28-bit size (7 bits per byte), plus the 10-byte header, plus a
    // 10-byte footer when the footer flag (bit 4 of the flags byte) is set.
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const hasFooter = (bytes[5] & 0x10) !== 0;
    const start = 10 + size + (hasFooter ? 10 : 0);

    return start < bytes.length ? buffer.slice(start) : buffer;
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
    private _downloadProgress = new Map<number, { loaded: number; total: number }>();
    // Item for which an optimistic itemstarted was fired (so the now-playing
    // bar appears and paints download progress) but audio has not started yet.
    // Non-null only during the initial load window of play().
    private _loadingItem: GaplessItem | null = null;
    // A seek landed during the load window; the deferred start then skips the
    // blocking next-track wait, like a seek while playing.
    private _seekedWhileLoading = false;
    // waitForNext of the latest _startFrom, for restarting it after a mutation.
    private _startWaitsForNext = true;
    // A start waiting for a suspended AudioContext to resume; it has not
    // touched the playback state yet, so pause, seek, next and previous act on
    // its target. With a running context this window is one microtask.
    private _pendingStart: PendingStart | null = null;
    private _lastProgressTriggerMs = 0;
    private _scheduled = new Map<number, AudioBufferSourceNode>();
    private _scheduledStartTimes = new Map<number, number>();
    private _schedule = new Map<number, ScheduleEntry>();
    private _volume = 100;
    private _muted = false;
    private _isPaused = true;
    // Stop reporting: the item announced by itemstarted and not yet stopped,
    // the next item a boundary itemstopped promised but which has not started
    // yet (boundary recovery), and the position at which the reported item's
    // audio was interrupted by a start still in flight.
    private _reportedItem: GaplessItem | null = null;
    private _awaitedItem: GaplessItem | null = null;
    private _interruptedAtMs: number | null = null;
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
        // Let the now-playing-bar toggle restart the queue on the other player.
        setToggleDeps(deps);
        initNotifications(deps);
    }

    // --- Local settings (localStorage via appSettings) ---------------------

    /** Installed = enabled: default true when the setting has never been set. */
    private isGaplessEnabled(): boolean {
        const value = this._appSettings.get(SETTING_ENABLED);
        return value == null ? true : value === 'true';
    }

    /** A local setting wins; otherwise the server-wide default applies. */
    private isDebugEnabled(): boolean {
        const value = this._appSettings.get(SETTING_DEBUG);
        return value == null ? getServerConfig().debugLogging : value === 'true';
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

        if (playOptions.enableWebAudioGapless === false || item?.GaplessFallback) {
            return false;
        }

        if (!getAudioContextConstructor()) {
            return false;
        }

        if (playOptions.items) {
            return playOptions.items.length > 1
                && playOptions.items.every((i) => i?.MediaType === 'Audio' && isFiniteDuration(i));
        }

        // An item already in our queue stays ours even when only one is left
        // (remove-current): playbackManager resolves the itemstopped nextItem
        // through here and would otherwise destroy this player mid-start.
        return item?.MediaType === 'Audio'
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

        // Optimistic itemstarted before the (potentially long) fetch+decode:
        // the now-playing bar appears immediately and paints download progress
        // via getBufferedRanges(). _startFrom() then only fires timeupdate for
        // this item (the _reportedItem gate), not a second itemstarted. Known
        // limit: SyncPlay would see "ready" at position 0.
        this._loadingItem = this.currentItem();
        this._seekedWhileLoading = false;
        this._emitItemStarted();
        const loadId = this._playbackId;

        try {
            await this._ensureAudioGraph();
            await this._decodeIndex(this._currentIndex);
        } catch (err) {
            // decodeAudioData cannot be aborted, so a superseded or paused
            // load can still fail here; only the live load may hand off.
            if (isAbortError(err) || loadId !== this._playbackId) {
                return;
            }
            // The browser could not decode this track (e.g. some high-res
            // FLAC). Fall back to the normal player instead of rejecting,
            // which would surface a playback-error dialog. Stock jellyfin-web
            // has no self-managed-player fallback, so the plugin does it here.
            console.warn(`${LOG_PREFIX} initial decode failed; handing off to normal playback`, err);
            this._handoffToNormalPlayback(this._currentIndex, Math.round(this._basePositionMs * TICKS_PER_MS));
            return;
        }
        if (!this._loadingItem || loadId !== this._playbackId) {
            // Paused during the load (stay paused at the target position), or
            // superseded by a stop, a newer play() or a mutation restart.
            return;
        }
        this._preloadNext();
        await this._startFrom(this._currentIndex, this._basePositionMs, { waitForNext: !this._seekedWhileLoading });
    }

    /**
     * playbackManager relies on a self-managed player's itemstopped for both
     * stop(true) and the stop(false) before a play() on this player: it only
     * reports players whose playlist it manages. stop(false) must report
     * synchronously, while playbackManager's stream state still exists (it
     * clears it right after), and names the replaced item as next so
     * playbackManager keeps this player. A never-started awaited item is not
     * owed there.
     */
    stop(destroyPlayer: boolean): Promise<void> {
        const owed = this._owedStop();
        const replacing = !destroyPlayer && owed?.started ? owed : null;
        this._resetReportState();

        this._playbackId++;
        this._stopScheduledSources();
        this._stopTimeUpdates();
        this._clearDecodedAfterMutation();
        this._isPaused = true;
        this._lastProgressTriggerMs = 0;
        this._pausePositionMs = 0;

        if (destroyPlayer) {
            this._clearPlaylistState();
            this.destroy();
        }

        if (destroyPlayer && owed) {
            this._emitItemStopped(owed.item, null, owed.positionMs);
        } else if (replacing) {
            this._emitItemStopped(replacing.item, replacing.item, replacing.positionMs);
            this._awaitedItem = null;
        }

        return Promise.resolve();
    }

    destroy(): void {
        // Silent: playbackManager destroys the player after it handled the
        // stop, and stop() takes its report before calling here.
        this._resetReportState();
        this._isPaused = true;
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
        const pending = this._pendingTarget();
        if (this._isPaused && !this._loadingItem && !pending) {
            return;
        }

        // Without a source a start is still in flight (the initial load, a
        // seek, next or boundary recovery): the bump keeps it from starting
        // audio behind the pause. Ending the load window makes paused() true;
        // play() then stays paused, and unpause() restarts the start.
        if (pending) {
            // Pause on the waiting start's target as if it had started; the
            // item it replaces stops where it was audible.
            if (this._reportedItem && this._interruptedAtMs == null) {
                this._interruptedAtMs = this.getCurrentTimeMs();
            }
            this._currentIndex = pending.index;
            this._basePositionMs = pending.positionMs;
        }
        this._pausePositionMs = pending ? pending.positionMs : this.getCurrentTimeMs();
        if (this._reportedItem && itemKey(this._reportedItem) === itemKey(this.currentItem())) {
            // A retired seek on the same item: its stop position is the pause
            // position. A retired next keeps the old item's.
            this._interruptedAtMs = null;
        }
        this._loadingItem = null;
        this._seekedWhileLoading = false;
        this._playbackId++;
        this._stopScheduledSources();
        this._stopTimeUpdates();
        this._isPaused = true;
        this._events.trigger(this, 'pause');
    }

    resume(): Promise<void> {
        return this.unpause();
    }

    unpause(): Promise<void> {
        // A start waiting for the AudioContext unpauses by itself; restarting
        // here would drop its target (e.g. a next pressed while paused).
        if (!this._isPaused || !this._playlist.length || this._pendingTarget()) {
            return Promise.resolve();
        }

        return this._startFrom(this._currentIndex, this._pausePositionMs, { waitForNext: false });
    }

    paused(): boolean {
        // During the optimistic load window the track is "playing" from the
        // user's point of view (play/pause icon, server report), even though
        // _isPaused is still true and currentTime() stays frozen at the start
        // position until _startFrom() schedules audio.
        return this._loadingItem ? false : this._isPaused;
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
        if (!this._scheduled.has(this._currentIndex)) {
            // A start is in flight (decode, boundary recovery wait): nothing
            // plays yet, so the position stays at its target.
            return this._basePositionMs;
        }

        // The source starts slightly after scheduling; never report a
        // position before its target.
        return this._basePositionMs + Math.max(0, (this._audioContext.currentTime - this._baseContextTime) * 1000);
    }

    duration(): number | null {
        // The player contract expects milliseconds (see getNowPlayingItemForReporting).
        const ticks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
        return ticks ? ticks / TICKS_PER_MS : null;
    }

    seekable(): boolean {
        return true;
    }

    getBufferedRanges(): { start: number; end: number }[] {
        const runTimeTicks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
        if (!runTimeTicks) {
            return [];
        }

        if (this._decoded.has(this._currentIndex)) {
            return [{ start: 0, end: runTimeTicks }];
        }

        // Byte fraction as a stand-in for the time fraction (inexact for VBR,
        // fine for a loading indicator). Without a Content-Length total there
        // is nothing meaningful to paint.
        const progress = this._downloadProgress.get(this._currentIndex);
        if (!progress?.total) {
            return [];
        }

        const fraction = Math.min(1, progress.loaded / progress.total);
        return [{ start: 0, end: Math.floor(runTimeTicks * fraction) }];
    }

    seek(positionTicks: number): Promise<void> {
        return this._seekToMs(positionTicks / TICKS_PER_MS);
    }

    private _seekToMs(positionMs: number): Promise<void> {
        const pending = this._pendingTarget();
        if (this._isPaused) {
            // Seeking must not unpause; just move the resume position. A start
            // waiting for the AudioContext is restarted below, and anything
            // that restarts it before then must find the new position too.
            if (this._loadingItem) {
                this._seekedWhileLoading = true;
            }
            if (pending && this._reportedItem && this._interruptedAtMs == null
                && itemKey(this._reportedItem) !== itemKey(this._playlist[pending.index])) {
                // The paused position is the replaced item's stop position
                // until the waiting start runs; keep it before moving it.
                this._interruptedAtMs = this.getCurrentTimeMs();
            }
            this._basePositionMs = positionMs;
            this._pausePositionMs = positionMs;
            if (!pending) {
                this._events.trigger(this, 'timeupdate');
                return Promise.resolve();
            }
        }

        return this._startFrom(pending ? pending.index : this._currentIndex, positionMs, { waitForNext: false });
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
        // Count from a start still waiting for the AudioContext, not from the
        // item it is about to replace.
        const nextIndex = this._nextIndex(this._pendingTarget()?.index ?? this._currentIndex);
        if (nextIndex == null) {
            return Promise.resolve();
        }

        return this._startFrom(nextIndex, 0);
    }

    previousTrack(): Promise<void> {
        const pending = this._pendingTarget();
        const index = pending?.index ?? this._currentIndex;
        if ((pending?.positionMs ?? this.getCurrentTimeMs()) > 3000) {
            return this._startFrom(index, 0);
        }

        return this._startFrom(Math.max(0, index - 1), 0);
    }

    queue(items: GaplessItem[]): void {
        this._playlist.push(...clonePlaylistItems(items, true));
        // Indexes are unchanged by an append, but the current track may have
        // been the last one, so a new lookahead may be needed.
        if (!this._isPaused) {
            this._scheduleLookaheadForCurrent();
            this._preloadNext();
        }
        this._events.trigger(this, 'playlistitemadd');
    }

    queueNext(items: GaplessItem[]): void {
        this._playlist.splice(this._currentIndex + 1, 0, ...clonePlaylistItems(items, true));
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
        if (isCurrentRemoved && this._reportedItem && this._interruptedAtMs == null) {
            // Read the stop position while the source is still keyed under the
            // old index; _startFrom would read it under the shifted one.
            this._interruptedAtMs = this.getCurrentTimeMs();
        }

        this._playlist = this._playlist.filter(item => !item.PlaylistItemId || !ids.has(item.PlaylistItemId));
        this._currentIndex = Math.min(
            Math.max(0, oldCurrentIndex - removedBeforeCurrent),
            Math.max(0, this._playlist.length - 1)
        );
        this._events.trigger(this, 'playlistitemremove', [{ playlistItemIds }]);
        const pending = this._pendingStart;
        if (pending && pending.playbackId === this._playbackId && !this._pendingTarget()) {
            // Its target is gone: act now, not when the AudioContext resumes,
            // so an unpause before then starts from the right position.
            this._pendingStart = null;
            this._restoreInterruptedPosition();
        }

        if (!this._playlist.length) {
            return this.stop(true);
        }

        if (isCurrentRemoved) {
            // The playing track was removed; start the one that took its place,
            // unless a skip waiting for the AudioContext already chose one.
            this._clearDecodedAfterMutation();
            if (this._restartPendingStart()) {
                return Promise.resolve();
            }
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

        if (this._loadingItem) {
            // The mutation aborted the pending initial decode, so the play()
            // that fired the optimistic itemstarted bails on its AbortError
            // and would leave the start unresolved. Restart the load for the
            // re-keyed current index in its place. The bump retires play()'s
            // _startFrom if it is already waiting on the boundary decode: that
            // abort is swallowed, and it would schedule under the stale index.
            // A start waiting for the AudioContext already superseded play();
            // restart that one instead.
            if (this._restartPendingStart()) {
                return;
            }
            const playbackId = ++this._playbackId;
            this._decodeIndex(newCurrentIndex)
                .then(() => {
                    if (playbackId !== this._playbackId || !this._loadingItem) {
                        return Promise.resolve();
                    }
                    // Read the position now: a seek may have moved it meanwhile.
                    return this._startFrom(newCurrentIndex, this._pausePositionMs, { waitForNext: !this._seekedWhileLoading });
                })
                .catch((err) => {
                    if (isAbortError(err) || playbackId !== this._playbackId) {
                        return;
                    }
                    console.error(`${LOG_PREFIX} failed to restart load after playlist mutation`, err);
                    this._handoffToNormalPlayback(newCurrentIndex, Math.round(this._pausePositionMs * TICKS_PER_MS));
                });
            return;
        }

        if (!this._isPaused && !currentSource) {
            // A start was in flight (seek, next or boundary recovery) and the
            // mutation aborted its decode, which it treats as superseded:
            // restart it for the re-keyed index or playback stays silent. The
            // bump retires the superseded start, which a swallowed boundary
            // decode abort would otherwise let schedule under the stale index.
            if (this._restartPendingStart()) {
                return;
            }
            this._playbackId++;
            this._recoverAtIndex(newCurrentIndex, this._basePositionMs, { waitForNext: this._startWaitsForNext });
            return;
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

        // iOS Safari reports 'interrupted' during an audio-session interruption.
        const state: string = this._audioContext.state;
        if (state === 'suspended' || state === 'interrupted') {
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
        // Progress updates are validated by _decodeAborts identity, the same
        // discipline as the _decoding identity check below: a superseded
        // fetch must not repaint the bar for its index.
        const onProgress = (loaded: number, total: number): void => {
            if (this._decodeAborts.get(index) !== abortController) {
                return;
            }
            this._downloadProgress.set(index, { loaded, total });
            if (index === this._currentIndex) {
                this._triggerDownloadProgress();
            }
        };
        const decode = this._fetchAndDecode(url, abortController.signal, onProgress)
            .then((audioBuffer) => {
                // Cache only while this decode is still the registered one for
                // the index. stop() and playlist mutations clear _decoding to
                // invalidate stale results; _playbackId must not be used here
                // because _startFrom() bumps it after preloads were dispatched,
                // which would discard every lookahead decode.
                if (this._decoding.get(index) === decode) {
                    this._decoding.delete(index);
                    this._decodeAborts.delete(index);
                    this._downloadProgress.delete(index);
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
                    this._downloadProgress.delete(index);
                }
                throw err;
            });

        this._decoding.set(index, decode);
        this._decodeAborts.set(index, abortController);
        return decode;
    }

    private async _fetchAndDecode(
        url: string,
        signal: AbortSignal,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<AudioBuffer> {
        const response = await fetch(url, {
            credentials: getIncludeCorsCredentials() ? 'include' : 'same-origin',
            signal
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch gapless audio: ${response.status}`);
        }

        const arrayBuffer = await this._readBody(response, onProgress);
        if (!this._audioContext) {
            throw new Error('AudioContext was closed before decode completed');
        }

        return this._audioContext.decodeAudioData(stripLeadingId3(arrayBuffer));
    }

    /**
     * Reads the response body in chunks so download progress can be reported.
     * Transcoded universal-audio streams may omit Content-Length; without a
     * total there is no fraction to report, so read opaquely as before. An
     * abort of the fetch signal rejects the chunk read with an AbortError,
     * which callers already treat as "superseded".
     */
    private async _readBody(
        response: Response,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<ArrayBuffer> {
        const total = Number(response.headers.get('Content-Length')) || 0;
        if (!response.body || !onProgress || total <= 0) {
            return response.arrayBuffer();
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            loaded += value.byteLength;
            onProgress(loaded, total);
        }

        const buffer = new ArrayBuffer(loaded);
        const combined = new Uint8Array(buffer);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return buffer;
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

    /**
     * Starts `index` at `positionMs`. With `waitForNext`, a start within the
     * last BLOCKING_LOOKAHEAD_THRESHOLD_MS first waits for the next item's
     * decode so a short remainder still transitions gaplessly. Seek and
     * unpause (including a seek during the load window) pass false:
     * the user expects audio right away, and blocking on a full next-track
     * download is silence (repeated on every click). The lookahead then
     * schedules from the decode callback (_scheduleDecodedLookahead), or
     * the boundary recovers in place.
     */
    private async _startFrom(index: number, positionMs: number, { waitForNext = true } = {}): Promise<void> {
        // Bump before the await: a pause or stop while a suspended
        // AudioContext resumes must retire this start.
        this._playbackId++;
        const playbackId = this._playbackId;
        const targetKey = itemKey(this._playlist[index]);
        this._pendingStart = { playbackId, targetKey, positionMs, waitForNext };
        // Callers do not await this start (playbackManager ignores the
        // unpause/seek promise), so a failure to get the audio graph or the
        // decode hands off here instead of rejecting; a superseded one is
        // dropped.
        const handOff = (err: unknown): void => {
            if (isAbortError(err) || playbackId !== this._playbackId) {
                return;
            }
            console.error(`${LOG_PREFIX} failed to start; handing off to normal playback`, err);
            this._handoffToNormalPlayback(index, Math.round(positionMs * TICKS_PER_MS));
        };
        try {
            await this._ensureAudioGraph();
        } catch (err) {
            handOff(err);
            return;
        } finally {
            if (this._pendingStart?.playbackId === playbackId) {
                this._pendingStart = null;
            }
        }
        if (itemKey(this._playlist[index]) !== targetKey) {
            // A mutation that does not retire starts re-keyed the queue while
            // the AudioContext resumed: follow the item, not the index.
            // A removed target leaves the current track as it was.
            const movedIndex = this._playlist.findIndex(i => itemKey(i) === targetKey);
            if (movedIndex < 0) {
                // removeFromPlaylist already dropped this start and restored
                // the position.
                return;
            }
            index = movedIndex;
        }
        const audioContext = this._audioContext;
        if (playbackId !== this._playbackId || !audioContext) {
            return;
        }
        if (this._reportedItem && this._interruptedAtMs == null) {
            this._interruptedAtMs = this.getCurrentTimeMs();
        }
        this._stopScheduledSources();
        this._stopTimeUpdates();

        this._currentIndex = index;
        this._startWaitsForNext = waitForNext;
        this._basePositionMs = positionMs;
        this._pausePositionMs = positionMs;
        this._isPaused = false;

        const currentBuffer = await this._decodeIndex(index).catch((err) => {
            handOff(err);
            return null;
        });
        if (!currentBuffer) {
            return;
        }
        const remainingMs = Math.max(0, (currentBuffer.duration * 1000) - positionMs);
        if (waitForNext && remainingMs <= BLOCKING_LOOKAHEAD_THRESHOLD_MS) {
            await this._decodeNextForBoundary(index);
        }

        if (playbackId !== this._playbackId) {
            // Superseded by a newer play/seek/stop while decoding.
            return;
        }

        const startedAt = audioContext.currentTime + 0.05;
        const endsAt = startedAt + currentBuffer.duration - (positionMs / 1000);

        this._scheduleIndex(index, currentBuffer, startedAt, positionMs / 1000, playbackId);
        // Count from when the audio starts, not from before the decode.
        this._baseContextTime = startedAt;
        // Virtual position-0 start time, so startTime + duration = end of track.
        this._schedule.set(index, { startTime: startedAt - (positionMs / 1000), playbackId });

        const nextIndex = this._nextIndex(index);
        if (nextIndex != null && nextIndex !== index) {
            this._schedule.set(nextIndex, { startTime: endsAt, playbackId });
            this._scheduleNextIfReady(nextIndex, endsAt, playbackId);
        }
        this._preloadNext();
        this._startTimeUpdates();

        const startedItem = this.currentItem();
        if (this._loadingItem && itemKey(this._loadingItem) !== itemKey(startedItem)) {
            // The item under this index is not the one the optimistic
            // itemstarted announced (e.g. remove-current mid-load replaced
            // it): close that start with its itemstopped first.
            this._abandonOptimisticStart(startedItem);
        } else {
            // Audio is scheduled; the optimistic-start window (if any) ends
            // here without an itemstopped — playback continues on this item.
            this._loadingItem = null;
        }

        if (this._reportedItem && itemKey(this._reportedItem) !== itemKey(startedItem)) {
            // Next/previous/select/remove-current: close the item that was
            // playing before announcing the new one.
            this._emitItemStopped(this._reportedItem, startedItem, this._interruptedAtMs ?? 0);
        }
        if (playbackId !== this._playbackId) {
            // playbackManager tore this player down in an itemstopped handler.
            return;
        }
        this._interruptedAtMs = null;

        // Keyed on the announced item, not the index: next-then-previous
        // within a decode wait returns to the announced item, which must not
        // be announced again.
        if (!this._reportedItem) {
            this._emitItemStarted();
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

        const endPositionMs = item?.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_MS : 0;

        if (nextIndex == null || !nextItem) {
            this._isPaused = true;
            this._emitItemStopped(item, null, endPositionMs);
            return;
        }

        const nextStartTime = this._scheduledStartTimes.get(nextIndex);
        const isNextScheduled = nextStartTime != null
            && nextStartTime <= audioContext.currentTime + 0.25;
        const isNextDecoded = this._decoded.has(nextIndex);

        this._emitItemStopped(item, nextItem, endPositionMs);

        if (playbackId !== this._playbackId) {
            return;
        }

        if (!isNextScheduled && !isNextDecoded) {
            // Move to the awaited item now: a seek or a same-player play()
            // during the wait must target it, not the finished track.
            this._currentIndex = nextIndex;
            this._basePositionMs = 0;
            this._pausePositionMs = 0;
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
        this._emitItemStarted();
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
    private _recoverAtIndex(index: number, positionMs = 0, { waitForNext = true } = {}): void {
        const playbackId = this._playbackId;
        this._startWaitsForNext = waitForNext;

        this._decodeIndex(index)
            .then(() => {
                if (playbackId !== this._playbackId) {
                    return;
                }

                return this._startFrom(index, positionMs, { waitForNext });
            })
            .catch((err) => {
                if (isAbortError(err) || playbackId !== this._playbackId) {
                    return;
                }

                console.error(`${LOG_PREFIX} failed to recover gapless playback`, err);
                this._handoffToNormalPlayback(index, Math.round(positionMs * TICKS_PER_MS));
            });
    }

    private _handoffToNormalPlayback(startIndex: number, startPositionTicks = 0): void {
        // Drop the gapless preset source so the normal player resolves a fresh
        // media source (correct container/transcode decision) instead of
        // replaying the raw stream URL we decoded for Web Audio.
        // The mark keeps canPlayItem from claiming the rest of this queue again:
        // playbackManager.play rebuilds the play options and drops
        // enableWebAudioGapless, which would loop the handoff on an
        // undecodable track.
        const items = this._playlist.slice(startIndex)
            .map(item => ({ ...stripPresetSource(item), GaplessFallback: true }));
        // Close the announced item, optimistic or playing (nextItem set: the
        // fallback player continues, so the now-playing bar must not hide).
        // playbackManager does not report a self-managed player on the switch.
        const owed = this._owedStop();
        if (owed?.started) {
            this._emitItemStopped(owed.item, this._playlist[startIndex] ?? null, owed.positionMs);
        }
        // The normal player owns these items now; playbackManager's player
        // switch calls stop(true) here, which must not report or cancel them.
        this._resetReportState();
        this._isPaused = true;
        this._stopScheduledSources();
        this._stopTimeUpdates();

        this._playbackManager.play({
            items,
            fullscreen: this._playOptions.fullscreen,
            startIndex: 0,
            startPositionTicks,
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
        this._downloadProgress.clear();
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

        for (const index of this._downloadProgress.keys()) {
            if (!keep.has(index)) {
                this._downloadProgress.delete(index);
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

    /**
     * Fires the itemstopped that pairs with an optimistic itemstarted whose
     * audio never started because a different item started.
     * playbackManager only resets its per-item stream state on the next
     * itemstarted, so skipping this would leave a dangling play session on
     * the server. No-op outside the load window.
     */
    private _abandonOptimisticStart(nextItem: GaplessItem | null = null): void {
        const item = this._loadingItem;
        if (!item) {
            return;
        }

        this._loadingItem = null;
        this._emitItemStopped(item, nextItem, this._interruptedAtMs ?? this._pausePositionMs);
    }

    /** The start still waiting for the AudioContext, if live, and where its target is now. */
    private _pendingTarget(): { index: number; positionMs: number; waitForNext: boolean } | null {
        const pending = this._pendingStart;
        if (!pending || pending.playbackId !== this._playbackId) {
            return null;
        }
        const index = this._playlist.findIndex(i => itemKey(i) === pending.targetKey);
        return index >= 0 ? { index, positionMs: pending.positionMs, waitForNext: pending.waitForNext } : null;
    }

    /**
     * Restarts a start waiting for the AudioContext for its re-keyed target,
     * superseding the load or start a mutation aborted. _startFrom registers
     * the new pending start synchronously, so pause, seek and skips keep
     * acting on it while it waits.
     */
    private _restartPendingStart(): boolean {
        const pending = this._pendingTarget();
        if (!pending) {
            return false;
        }
        void this._startFrom(pending.index, pending.positionMs, { waitForNext: pending.waitForNext });
        return true;
    }

    /**
     * A paused seek on a waiting start moved the position to its target; once
     * that target is gone the current item stays where it was. Only while
     * paused: a playing start of the same item also sets _interruptedAtMs.
     */
    private _restoreInterruptedPosition(): void {
        if (this._isPaused && this._interruptedAtMs != null
            && itemKey(this._reportedItem) === itemKey(this.currentItem())) {
            this._basePositionMs = this._interruptedAtMs;
            this._pausePositionMs = this._interruptedAtMs;
            this._interruptedAtMs = null;
        }
    }

    private _owedStop(): OwedStop | null {
        if (this._loadingItem) {
            // A start in flight for another index already moved
            // _pausePositionMs to its target; _interruptedAtMs kept ours.
            return { item: this._loadingItem, positionMs: this._interruptedAtMs ?? this._pausePositionMs, started: true };
        }
        if (this._reportedItem) {
            return { item: this._reportedItem, positionMs: this._interruptedAtMs ?? this.getCurrentTimeMs(), started: true };
        }
        // Boundary recovery still waiting: cancel the promised next item
        // instead of reporting the finished one twice (a second stop at its
        // end would count it as played again).
        if (this._awaitedItem) {
            return { item: this._awaitedItem, positionMs: 0, started: false };
        }
        return null;
    }

    private _resetReportState(): void {
        this._loadingItem = null;
        this._reportedItem = null;
        this._awaitedItem = null;
        this._interruptedAtMs = null;
    }

    private _emitItemStarted(): void {
        this._reportedItem = this.currentItem();
        this._awaitedItem = null;
        this._interruptedAtMs = null;
        this._events.trigger(this, 'itemstarted', [this.currentItem(), this.currentMediaSource()]);
    }

    private _emitItemStopped(item: GaplessItem, nextItem: GaplessItem | null, positionMs = 0): void {
        this._reportedItem = null;
        this._awaitedItem = nextItem;
        this._events.trigger(this, 'itemstopped', [{
            item,
            mediaSource: getMediaSource(item),
            // Whole ms: playbackManager reports positionMs * 10000 as Int64
            // ticks, and a fractional value fails the server's validation (400).
            positionMs: Math.round(positionMs),
            nextItem: nextItem ? { item: nextItem } : null,
            nextMediaType: nextItem ? nextItem.MediaType : null
        }]);
    }

    private _triggerDownloadProgress(): void {
        const now = performance.now();
        if (now - this._lastProgressTriggerMs < DOWNLOAD_PROGRESS_EVENT_MS) {
            return;
        }

        this._lastProgressTriggerMs = now;
        this._events.trigger(this, 'timeupdate');
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
