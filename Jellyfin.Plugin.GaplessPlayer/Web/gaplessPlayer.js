"use strict";
(() => {
  // src/toggle.ts
  var SETTING_ENABLED = "enableWebAudioGapless";
  var BUTTON_CLASS = "gaplessToggleButton";
  var LOG_PREFIX = "[GaplessPlayer]";
  var deps = null;
  function setToggleDeps(value) {
    deps = value;
  }
  function isEnabled() {
    const value = localStorage.getItem(SETTING_ENABLED);
    return value == null ? true : value === "true";
  }
  function setEnabled(value) {
    localStorage.setItem(SETTING_ENABLED, String(value));
  }
  function showToast(message) {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = [
      "position:fixed",
      "bottom:8em",
      "left:50%",
      "transform:translateX(-50%)",
      "background:rgba(0,0,0,0.85)",
      "color:#fff",
      "padding:0.6em 1em",
      "border-radius:0.3em",
      "z-index:10000",
      "font-size:0.9em",
      "transition:opacity 0.4s",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
    }, 1800);
    setTimeout(() => {
      el.remove();
    }, 2300);
  }
  function updateButton(button) {
    const enabled = isEnabled();
    button.title = enabled ? "Gapless playback: on" : "Gapless playback: off";
    button.style.opacity = enabled ? "1" : "0.4";
    const icon = button.querySelector(".material-icons");
    if (icon) {
      icon.textContent = "graphic_eq";
    }
  }
  async function restartCurrentQueue(enabled) {
    const pm = deps?.playbackManager;
    if (!pm) {
      return false;
    }
    try {
      if (typeof pm.isPlaying === "function" && !pm.isPlaying()) {
        return false;
      }
      const items = typeof pm.getPlaylist === "function" ? await pm.getPlaylist() : null;
      if (!Array.isArray(items) || items.length === 0) {
        return false;
      }
      const index = typeof pm.getCurrentPlaylistIndex === "function" ? Number(pm.getCurrentPlaylistIndex()) : 0;
      const positionMs = typeof pm.currentTime === "function" ? Number(pm.currentTime()) : 0;
      await pm.play({
        items,
        startIndex: Math.max(0, index),
        startPositionTicks: Math.max(0, Math.round(positionMs * 1e4)),
        enableWebAudioGapless: enabled
      });
      return true;
    } catch (err) {
      console.warn(`${LOG_PREFIX} live toggle restart failed; applies on next playback`, err);
      return false;
    }
  }
  function onClick(button) {
    const enabled = !isEnabled();
    setEnabled(enabled);
    updateButton(button);
    void restartCurrentQueue(enabled).then((restarted) => {
      const base = enabled ? "Gapless playback enabled" : "Gapless playback disabled";
      showToast(restarted ? base : `${base} (applies on next playback)`);
    });
  }
  function createButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${BUTTON_CLASS} paper-icon-button-light mediaButton`;
    button.setAttribute("is", "paper-icon-button-light");
    button.innerHTML = '<span class="material-icons" aria-hidden="true">graphic_eq</span>';
    button.addEventListener("click", () => onClick(button));
    updateButton(button);
    return button;
  }
  function injectInto(container) {
    if (container.querySelector(`.${BUTTON_CLASS}`)) {
      return;
    }
    const button = createButton();
    const anchor = container.querySelector(".btnToggleContextMenu");
    if (anchor) {
      container.insertBefore(button, anchor);
    } else {
      container.appendChild(button);
    }
  }
  function initToggleUi() {
    const tryInject = () => {
      document.querySelectorAll(".nowPlayingBarRight").forEach(injectInto);
    };
    tryInject();
    const observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // src/plugin.ts
  var TICKS_PER_MS = 1e4;
  var VOLUME_EXPONENT = 3;
  var TIMEUPDATE_INTERVAL_MS = 1e3;
  var BLOCKING_LOOKAHEAD_THRESHOLD_MS = 3e4;
  var LOG_PREFIX2 = "[GaplessPlayer]";
  var SETTING_ENABLED2 = "enableWebAudioGapless";
  var SETTING_DEBUG = "enableWebAudioGaplessDebug";
  var SETTING_VOLUME = "volume";
  function getAudioContextConstructor() {
    return window.AudioContext || window.webkitAudioContext;
  }
  function isFiniteDuration(item) {
    return typeof item?.RunTimeTicks === "number" && Number.isFinite(item.RunTimeTicks) && item.RunTimeTicks > 0;
  }
  function getMediaSource(item) {
    return item?.PresetMediaSource || {
      Id: item?.Id,
      RunTimeTicks: item?.RunTimeTicks,
      MediaStreams: []
    };
  }
  function getStreamUrl(item) {
    return item?.PresetMediaSource?.StreamUrl || item?.PresetMediaSource?.Path || item?.Url || item?.Path;
  }
  function clonePlaylistItems(items) {
    return (items || []).map((item) => ({ ...item }));
  }
  function isGaplessItem(item) {
    return item != null;
  }
  function isAbortError(err) {
    return err instanceof Error && err.name === "AbortError";
  }
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function stripLeadingId3(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 10 || bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) {
      return buffer;
    }
    const size = (bytes[6] & 127) << 21 | (bytes[7] & 127) << 14 | (bytes[8] & 127) << 7 | bytes[9] & 127;
    const hasFooter = (bytes[5] & 16) !== 0;
    const start = 10 + size + (hasFooter ? 10 : 0);
    return start < bytes.length ? buffer.slice(start) : buffer;
  }
  function getIncludeCorsCredentials() {
    return window.__gaplessCors === true;
  }
  var WebAudioGaplessPlayer = class {
    constructor(deps2) {
      this.name = "Web Audio Gapless Player";
      this.type = "mediaplayer";
      this.id = "webaudiogaplessplayer";
      this.priority = 0;
      this.isLocalPlayer = true;
      this.supportsProgress = true;
      this.fallbackOnPlayError = true;
      this._playlist = [];
      this._sortedPlaylist = [];
      this._currentIndex = 0;
      this._decoded = /* @__PURE__ */ new Map();
      this._decoding = /* @__PURE__ */ new Map();
      this._decodeAborts = /* @__PURE__ */ new Map();
      this._scheduled = /* @__PURE__ */ new Map();
      this._scheduledStartTimes = /* @__PURE__ */ new Map();
      this._schedule = /* @__PURE__ */ new Map();
      this._volume = 100;
      this._muted = false;
      this._isPaused = true;
      this._started = false;
      this._repeatMode = "RepeatNone";
      this._shuffleMode = "Sorted";
      this._audioStreamIndex = null;
      this._subtitleStreamIndex = null;
      this._secondarySubtitleStreamIndex = null;
      this._baseContextTime = 0;
      this._basePositionMs = 0;
      this._pausePositionMs = 0;
      this._playOptions = {};
      this._playbackId = 0;
      this._audioContext = null;
      this._gainNode = null;
      this._timeUpdateInterval = null;
      this._events = deps2.events;
      this._appSettings = deps2.appSettings;
      this._playbackManager = deps2.playbackManager;
      this._appHost = deps2.appHost;
      this._volume = this.getSavedVolumeLevel();
      setToggleDeps(deps2);
    }
    // --- Local settings (localStorage via appSettings) ---------------------
    /** Installed = enabled: default true when the setting has never been set. */
    isGaplessEnabled() {
      const value = this._appSettings.get(SETTING_ENABLED2);
      return value == null ? true : value === "true";
    }
    isDebugEnabled() {
      return this._appSettings.get(SETTING_DEBUG) === "true";
    }
    getSavedVolumeLevel() {
      const saved = Number.parseFloat(String(this._appSettings.get(SETTING_VOLUME) ?? 1));
      return Math.min(Math.round(Math.pow(saved, 1 / VOLUME_EXPONENT) * 100), 100);
    }
    saveVolume(value) {
      if (value) {
        this._appSettings.set(SETTING_VOLUME, String(value));
      }
    }
    debugLog(message, data) {
      if (!this.isDebugEnabled()) {
        return;
      }
      if (data === void 0) {
        console.debug(`${LOG_PREFIX2} ${message}`);
      } else {
        console.debug(`${LOG_PREFIX2} ${message}`, data);
      }
    }
    // --- Player contract ---------------------------------------------------
    canPlayMediaType(mediaType) {
      return (mediaType || "").toLowerCase() === "audio";
    }
    canPlayItem(item, playOptions = {}) {
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
        return playOptions.items.length > 1 && playOptions.items.every((i) => i?.MediaType === "Audio" && isFiniteDuration(i));
      }
      return this._playlist.length > 1 && item?.MediaType === "Audio" && isFiniteDuration(item) && this._playlist.some((i) => item.Id != null && i.Id === item.Id || item.PlaylistItemId != null && i.PlaylistItemId === item.PlaylistItemId);
    }
    getDeviceProfile(item) {
      if (this._appHost.getDeviceProfile) {
        return this._appHost.getDeviceProfile(item);
      }
      return {};
    }
    async play(options) {
      await this.stop(false);
      this._playOptions = options || {};
      this._playlist = clonePlaylistItems(options.items || [options.item].filter(isGaplessItem));
      this._sortedPlaylist = [];
      this._currentIndex = options.startIndex || 0;
      this._currentIndex = Math.max(0, Math.min(this._currentIndex, this._playlist.length - 1));
      this._basePositionMs = (options.startPositionTicks || 0) / TICKS_PER_MS;
      this._pausePositionMs = this._basePositionMs;
      this._repeatMode = "RepeatNone";
      this._shuffleMode = "Sorted";
      if (!this._playlist.length) {
        return Promise.reject(new Error("No items to play"));
      }
      this.debugLog("starting gapless queue", {
        items: this._playlist.length,
        startIndex: this._currentIndex
      });
      await this._ensureAudioGraph();
      try {
        await this._decodeIndex(this._currentIndex);
      } catch (err) {
        if (isAbortError(err)) {
          return;
        }
        console.warn(`${LOG_PREFIX2} initial decode failed; handing off to normal playback`, err);
        this._handoffToNormalPlayback(this._currentIndex, Math.round(this._basePositionMs * TICKS_PER_MS));
        return;
      }
      this._preloadNext();
      await this._startFrom(this._currentIndex, this._basePositionMs);
    }
    stop(destroyPlayer) {
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
    destroy() {
      this._playbackId++;
      this._stopScheduledSources();
      this._stopTimeUpdates();
      this._clearDecodedAfterMutation();
      this._clearPlaylistState();
      if (this._audioContext) {
        this._audioContext.close().catch((err) => {
          console.warn(`${LOG_PREFIX2} failed to close AudioContext`, err);
        });
        this._audioContext = null;
      }
      this._gainNode = null;
    }
    pause() {
      if (this._isPaused) {
        return;
      }
      this._pausePositionMs = this.getCurrentTimeMs();
      this._stopScheduledSources();
      this._stopTimeUpdates();
      this._isPaused = true;
      this._events.trigger(this, "pause");
    }
    resume() {
      return this.unpause();
    }
    unpause() {
      if (!this._isPaused) {
        return Promise.resolve();
      }
      return this._startFrom(this._currentIndex, this._pausePositionMs);
    }
    paused() {
      return this._isPaused;
    }
    currentTime(val) {
      if (val != null) {
        this._seekToMs(val).catch((err) => {
          console.error(`${LOG_PREFIX2} failed to seek`, err);
        });
      }
      return this.getCurrentTimeMs();
    }
    getCurrentTimeMs() {
      if (this._isPaused || !this._audioContext) {
        return this._pausePositionMs;
      }
      return this._basePositionMs + (this._audioContext.currentTime - this._baseContextTime) * 1e3;
    }
    duration() {
      const ticks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
      return ticks ? ticks / TICKS_PER_MS : null;
    }
    seekable() {
      return true;
    }
    getBufferedRanges() {
      return [];
    }
    seek(positionTicks) {
      return this._seekToMs(positionTicks / TICKS_PER_MS);
    }
    _seekToMs(positionMs) {
      if (this._isPaused) {
        this._basePositionMs = positionMs;
        this._pausePositionMs = positionMs;
        this._events.trigger(this, "timeupdate");
        return Promise.resolve();
      }
      return this._startFrom(this._currentIndex, positionMs);
    }
    setVolume(val) {
      this._volume = Math.max(0, Math.min(val, 100));
      this.saveVolume(Math.pow(this._volume / 100, VOLUME_EXPONENT));
      this._applyVolume();
      this._events.trigger(this, "volumechange");
    }
    getVolume() {
      return this._volume;
    }
    volumeUp() {
      this.setVolume(Math.min(this.getVolume() + 2, 100));
    }
    volumeDown() {
      this.setVolume(Math.max(this.getVolume() - 2, 0));
    }
    setMute(mute) {
      this._muted = mute;
      this._applyVolume();
      this._events.trigger(this, "volumechange");
    }
    isMuted() {
      return this._muted;
    }
    getPlaybackRate() {
      return 1;
    }
    setPlaybackRate() {
    }
    getRepeatMode() {
      return this._repeatMode;
    }
    setRepeatMode(value) {
      if (value !== this._repeatMode) {
        this._repeatMode = value;
        this._resyncLookahead();
      }
      this._events.trigger(this, "repeatmodechange");
    }
    getQueueShuffleMode() {
      return this._shuffleMode;
    }
    setQueueShuffleMode(value) {
      if (value !== this._shuffleMode) {
        const oldCurrentIndex = this._currentIndex;
        if (value === "Shuffle") {
          this._shufflePlaylist();
        } else {
          this._sortPlaylist();
        }
        this._shuffleMode = value;
        this._handlePlaylistMutation(oldCurrentIndex);
      }
      this._events.trigger(this, "shufflequeuemodechange");
    }
    toggleQueueShuffleMode() {
      this.setQueueShuffleMode(this._shuffleMode === "Shuffle" ? "Sorted" : "Shuffle");
    }
    getAudioStreamIndex() {
      return this._audioStreamIndex;
    }
    setAudioStreamIndex(index) {
      this._audioStreamIndex = index;
    }
    canSetAudioStreamIndex() {
      return false;
    }
    getSubtitleStreamIndex() {
      return this._subtitleStreamIndex;
    }
    setSubtitleStreamIndex(index) {
      this._subtitleStreamIndex = index;
    }
    getSecondarySubtitleStreamIndex() {
      return this._secondarySubtitleStreamIndex;
    }
    audioTracks() {
      return [];
    }
    subtitleTracks() {
      return [];
    }
    currentItem() {
      return this._playlist[this._currentIndex] || null;
    }
    currentMediaSource() {
      const item = this.currentItem();
      return item ? getMediaSource(item) : null;
    }
    playMethod() {
      return "DirectPlay";
    }
    playSessionId() {
      const url = getStreamUrl(this.currentItem());
      if (!url) {
        return null;
      }
      try {
        return new URL(url, window.location.href).searchParams.get("PlaySessionId");
      } catch {
        return null;
      }
    }
    currentSrc() {
      return getStreamUrl(this.currentItem());
    }
    getPlaylist() {
      return Promise.resolve(this._playlist);
    }
    getPlaylistSync() {
      return this._playlist;
    }
    getCurrentPlaylistIndex() {
      return this._currentIndex;
    }
    getCurrentPlaylistItemId() {
      return this.currentItem()?.PlaylistItemId;
    }
    setCurrentPlaylistItem(playlistItemId) {
      const index = this._playlist.findIndex((item) => item.PlaylistItemId === playlistItemId);
      if (index === -1) {
        return Promise.resolve();
      }
      return this._startFrom(index, 0);
    }
    nextTrack() {
      const nextIndex = this._nextIndex(this._currentIndex);
      if (nextIndex == null) {
        return Promise.resolve();
      }
      return this._startFrom(nextIndex, 0);
    }
    previousTrack() {
      if (this.getCurrentTimeMs() > 3e3) {
        return this._startFrom(this._currentIndex, 0);
      }
      return this._startFrom(Math.max(0, this._currentIndex - 1), 0);
    }
    queue(items) {
      this._playlist.push(...clonePlaylistItems(items));
      if (!this._isPaused) {
        this._scheduleLookaheadForCurrent();
        this._preloadNext();
      }
      this._events.trigger(this, "playlistitemadd");
    }
    queueNext(items) {
      this._playlist.splice(this._currentIndex + 1, 0, ...clonePlaylistItems(items));
      this._handlePlaylistMutation(this._currentIndex);
      this._events.trigger(this, "playlistitemadd");
    }
    removeFromPlaylist(playlistItemIds) {
      const ids = new Set(Array.isArray(playlistItemIds) ? playlistItemIds : [playlistItemIds]);
      const oldCurrentIndex = this._currentIndex;
      const currentItemId = this.getCurrentPlaylistItemId();
      const isCurrentRemoved = currentItemId != null && ids.has(currentItemId);
      const removedBeforeCurrent = this._playlist.slice(0, oldCurrentIndex).filter((item) => item.PlaylistItemId && ids.has(item.PlaylistItemId)).length;
      this._playlist = this._playlist.filter((item) => !item.PlaylistItemId || !ids.has(item.PlaylistItemId));
      this._currentIndex = Math.min(
        Math.max(0, oldCurrentIndex - removedBeforeCurrent),
        Math.max(0, this._playlist.length - 1)
      );
      this._events.trigger(this, "playlistitemremove", [{ playlistItemIds }]);
      if (!this._playlist.length) {
        return this.stop(true);
      }
      if (isCurrentRemoved) {
        this._clearDecodedAfterMutation();
        return this._startFrom(this._currentIndex, 0);
      }
      this._handlePlaylistMutation(oldCurrentIndex);
      return Promise.resolve();
    }
    movePlaylistItem(playlistItemId, newIndex) {
      const currentItemId = this.getCurrentPlaylistItemId();
      const oldCurrentIndex = this._currentIndex;
      const oldIndex = this._playlist.findIndex((item2) => item2.PlaylistItemId === playlistItemId);
      if (oldIndex === -1 || oldIndex === newIndex) {
        return;
      }
      const [item] = this._playlist.splice(oldIndex, 1);
      this._playlist.splice(newIndex, 0, item);
      this._currentIndex = this._playlist.findIndex((i) => i.PlaylistItemId === currentItemId);
      if (this._currentIndex === -1) {
        this._currentIndex = 0;
      }
      this._handlePlaylistMutation(oldCurrentIndex);
      this._events.trigger(this, "playlistitemmove", [{ playlistItemId, newIndex }]);
    }
    /**
     * Re-keys per-index playback state after a playlist mutation. The
     * currently playing source keeps playing under its new index; everything
     * scheduled or decoded for other (now stale) indexes is discarded and
     * rebuilt, otherwise a previously scheduled source would still fire at the
     * boundary and play the wrong track.
     */
    _handlePlaylistMutation(oldCurrentIndex) {
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
    async _ensureAudioGraph() {
      if (!this._audioContext) {
        const AudioContextCtor = getAudioContextConstructor();
        if (!AudioContextCtor) {
          throw new Error("Web Audio API is not available");
        }
        this._audioContext = new AudioContextCtor();
        this._gainNode = this._audioContext.createGain();
        this._gainNode.connect(this._audioContext.destination);
        this._applyVolume();
      }
      if (this._audioContext.state === "suspended") {
        await this._audioContext.resume();
      }
    }
    _applyVolume() {
      if (this._gainNode) {
        const volume = this._muted ? 0 : Math.pow(this._volume / 100, VOLUME_EXPONENT);
        this._gainNode.gain.value = volume;
      }
    }
    async _decodeIndex(index) {
      if (this._decoded.has(index)) {
        return this._decoded.get(index);
      }
      if (this._decoding.has(index)) {
        return this._decoding.get(index);
      }
      const item = this._playlist[index];
      const url = getStreamUrl(item);
      if (!url) {
        throw new Error("Gapless item has no stream URL");
      }
      const abortController = new AbortController();
      const decode = this._fetchAndDecode(url, abortController.signal).then((audioBuffer) => {
        if (this._decoding.get(index) === decode) {
          this._decoding.delete(index);
          this._decodeAborts.delete(index);
          this._decoded.set(index, audioBuffer);
          this._scheduleDecodedLookahead(index, audioBuffer);
          this._pruneDecoded();
        }
        return audioBuffer;
      }).catch((err) => {
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
    async _fetchAndDecode(url, signal) {
      const response = await fetch(url, {
        credentials: getIncludeCorsCredentials() ? "include" : "same-origin",
        signal
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch gapless audio: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      if (!this._audioContext) {
        throw new Error("AudioContext was closed before decode completed");
      }
      return this._audioContext.decodeAudioData(stripLeadingId3(arrayBuffer));
    }
    /**
     * Resolves the index that should play after the given one, honoring the
     * repeat mode. Returns null when playback should stop at the end.
     */
    _nextIndex(index) {
      if (!this._playlist.length) {
        return null;
      }
      if (this._repeatMode === "RepeatOne") {
        return index;
      }
      const next = index + 1;
      if (next < this._playlist.length) {
        return next;
      }
      return this._repeatMode === "RepeatAll" ? 0 : null;
    }
    _preloadNext() {
      const nextIndex = this._nextIndex(this._currentIndex);
      if (nextIndex == null || this._decoded.has(nextIndex)) {
        return;
      }
      this._decodeIndex(nextIndex).catch((err) => {
        if (!isAbortError(err)) {
          console.warn(`${LOG_PREFIX2} failed to preload next item`, err);
        }
      });
    }
    async _startFrom(index, positionMs) {
      await this._ensureAudioGraph();
      const audioContext = this._audioContext;
      if (!audioContext) {
        throw new Error("AudioContext was not initialized");
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
          return null;
        }
        throw err;
      });
      if (!currentBuffer) {
        return;
      }
      const remainingMs = Math.max(0, currentBuffer.duration * 1e3 - positionMs);
      if (remainingMs <= BLOCKING_LOOKAHEAD_THRESHOLD_MS) {
        await this._decodeNextForBoundary(index);
      }
      if (playbackId !== this._playbackId) {
        return;
      }
      const startedAt = audioContext.currentTime + 0.05;
      const endsAt = startedAt + currentBuffer.duration - positionMs / 1e3;
      this._scheduleIndex(index, currentBuffer, startedAt, positionMs / 1e3, playbackId);
      this._schedule.set(index, { startTime: startedAt - positionMs / 1e3, playbackId });
      const nextIndex = this._nextIndex(index);
      if (nextIndex != null && nextIndex !== index) {
        this._schedule.set(nextIndex, { startTime: endsAt, playbackId });
        this._scheduleNextIfReady(nextIndex, endsAt, playbackId);
      }
      this._preloadNext();
      this._startTimeUpdates();
      if (!this._started || previousIndex !== index) {
        this._started = true;
        this._events.trigger(this, "itemstarted", [this.currentItem(), this.currentMediaSource()]);
      } else {
        this._events.trigger(this, "timeupdate");
      }
      this._events.trigger(this, "unpause");
    }
    _scheduleIndex(index, audioBuffer, startTime, offsetSeconds, playbackId = this._playbackId) {
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
    async _decodeNextForBoundary(index) {
      const nextIndex = this._nextIndex(index);
      if (nextIndex == null || nextIndex === index) {
        return;
      }
      this.debugLog("waiting for next item before near-boundary start", {
        index: nextIndex,
        name: this._playlist[nextIndex]?.Name
      });
      try {
        await this._decodeIndex(nextIndex);
      } catch (err) {
        if (!isAbortError(err)) {
          console.warn(`${LOG_PREFIX2} failed to decode next item before boundary`, err);
        }
      }
    }
    _scheduleNextIfReady(nextIndex, startTime, playbackId = this._playbackId) {
      const nextBuffer = this._decoded.get(nextIndex);
      if (!nextBuffer || this._scheduled.has(nextIndex) || playbackId !== this._playbackId) {
        return;
      }
      this._scheduleIndex(nextIndex, nextBuffer, startTime, 0, playbackId);
      this.debugLog("scheduled next item gaplessly", {
        index: nextIndex,
        name: this._playlist[nextIndex]?.Name
      });
    }
    _scheduleDecodedLookahead(index, audioBuffer) {
      const schedule = this._schedule.get(index);
      if (!schedule || this._isPaused || this._scheduled.has(index) || schedule.playbackId !== this._playbackId || !this._audioContext) {
        return;
      }
      if (schedule.startTime <= this._audioContext.currentTime) {
        return;
      }
      this._scheduleIndex(index, audioBuffer, schedule.startTime, 0, schedule.playbackId);
    }
    _onSourceEnded(index, playbackId) {
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
        this._events.trigger(this, "itemstopped", [{
          item,
          mediaSource: getMediaSource(item),
          positionMs: item?.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_MS : 0,
          nextItem: null,
          nextMediaType: null
        }]);
        return;
      }
      const nextStartTime = this._scheduledStartTimes.get(nextIndex);
      const isNextScheduled = nextStartTime != null && nextStartTime <= audioContext.currentTime + 0.25;
      const isNextDecoded = this._decoded.has(nextIndex);
      this._events.trigger(this, "itemstopped", [{
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
        console.warn(`${LOG_PREFIX2} boundary missed; recovering in place`, {
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
      this.debugLog("transitioned to next item", {
        index: this._currentIndex,
        name: this.currentItem()?.Name
      });
      this._events.trigger(this, "itemstarted", [this.currentItem(), this.currentMediaSource()]);
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
    _recoverAtIndex(index) {
      const playbackId = this._playbackId;
      this._decodeIndex(index).then(() => {
        if (playbackId !== this._playbackId) {
          return;
        }
        return this._startFrom(index, 0);
      }).catch((err) => {
        if (isAbortError(err) || playbackId !== this._playbackId) {
          return;
        }
        console.error(`${LOG_PREFIX2} failed to recover gapless playback`, err);
        this._handoffToNormalPlayback(index);
      });
    }
    _handoffToNormalPlayback(startIndex, startPositionTicks = 0) {
      const items = this._playlist.slice(startIndex);
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
        console.error(`${LOG_PREFIX2} failed to hand off to normal playback`, err);
      });
    }
    _scheduleLookaheadForCurrent() {
      const currentBuffer = this._decoded.get(this._currentIndex);
      const currentSchedule = this._schedule.get(this._currentIndex);
      if (!currentBuffer || !currentSchedule) {
        return;
      }
      const nextIndex = this._nextIndex(this._currentIndex);
      if (nextIndex == null || nextIndex === this._currentIndex) {
        return;
      }
      const nextStartTime = currentSchedule.startTime + currentBuffer.duration;
      this._schedule.set(nextIndex, { startTime: nextStartTime, playbackId: this._playbackId });
      this._scheduleNextIfReady(nextIndex, nextStartTime, this._playbackId);
    }
    _stopScheduledSources() {
      this._scheduled.forEach((source) => {
        source.onended = null;
        try {
          source.stop();
        } catch {
        }
      });
      this._scheduled.clear();
      this._scheduledStartTimes.clear();
      this._schedule.clear();
    }
    _clearDecodedAfterMutation() {
      for (const abortController of this._decodeAborts.values()) {
        abortController.abort();
      }
      this._decodeAborts.clear();
      this._decoded.clear();
      this._decoding.clear();
    }
    _clearPlaylistState() {
      this._playlist = [];
      this._sortedPlaylist = [];
      this._currentIndex = 0;
      this._baseContextTime = 0;
      this._basePositionMs = 0;
      this._pausePositionMs = 0;
      this._playOptions = {};
    }
    _pruneDecoded() {
      const keep = /* @__PURE__ */ new Set([this._currentIndex]);
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
    _resyncLookahead() {
      for (const [index, source] of this._scheduled) {
        if (index === this._currentIndex) {
          continue;
        }
        source.onended = null;
        try {
          source.stop();
        } catch {
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
    _shufflePlaylist() {
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
    _sortPlaylist() {
      if (!this._sortedPlaylist.length) {
        return;
      }
      const currentItemId = this.getCurrentPlaylistItemId();
      const currentItem = this.currentItem();
      this._playlist = [...this._sortedPlaylist];
      this._sortedPlaylist = [];
      const index = this._playlist.findIndex((i) => currentItemId != null && i.PlaylistItemId === currentItemId || currentItem?.Id != null && i.Id === currentItem.Id);
      this._currentIndex = Math.max(0, index);
    }
    _startTimeUpdates() {
      this._stopTimeUpdates();
      this._timeUpdateInterval = setInterval(() => {
        if (!this._isPaused) {
          this._events.trigger(this, "timeupdate");
        }
      }, TIMEUPDATE_INTERVAL_MS);
    }
    _stopTimeUpdates() {
      if (this._timeUpdateInterval) {
        clearInterval(this._timeUpdateInterval);
        this._timeUpdateInterval = null;
      }
    }
  };
  var plugin_default = WebAudioGaplessPlayer;

  // src/index.ts
  window.GaplessPlayer = async () => plugin_default;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initToggleUi);
  } else {
    initToggleUi();
  }
})();
