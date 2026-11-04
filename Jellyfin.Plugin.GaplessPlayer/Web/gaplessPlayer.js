"use strict";
(() => {
  // src/flac.ts
  var STREAMINFO_LENGTH = 34;
  var BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -1, -1, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  function id3TagLength(bytes) {
    if (bytes.length < 3) {
      return null;
    }
    if (bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) {
      return 0;
    }
    if (bytes.length < 10) {
      return null;
    }
    const size = (bytes[6] & 127) << 21 | (bytes[7] & 127) << 14 | (bytes[8] & 127) << 7 | bytes[9] & 127;
    return 10 + size + ((bytes[5] & 16) !== 0 ? 10 : 0);
  }
  function probeFlac(bytes) {
    const tagLength = id3TagLength(bytes);
    if (tagLength == null) {
      return { kind: "more" };
    }
    let pos = tagLength;
    if (bytes.length < pos + 4) {
      return { kind: "more" };
    }
    if (bytes[pos] !== 102 || bytes[pos + 1] !== 76 || bytes[pos + 2] !== 97 || bytes[pos + 3] !== 67) {
      return { kind: "other" };
    }
    pos += 4;
    let streamInfo = null;
    for (; ; ) {
      if (bytes.length < pos + 4) {
        return { kind: "more" };
      }
      const last = (bytes[pos] & 128) !== 0;
      const type = bytes[pos] & 127;
      const length = bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3];
      if (bytes.length < pos + 4 + length) {
        return { kind: "more" };
      }
      if (type === 0) {
        if (length !== STREAMINFO_LENGTH) {
          return { kind: "other" };
        }
        streamInfo = bytes.slice(pos + 4, pos + 4 + length);
      }
      pos += 4 + length;
      if (last) {
        break;
      }
    }
    if (!streamInfo) {
      return { kind: "other" };
    }
    const sampleRate = streamInfo[10] << 12 | streamInfo[11] << 4 | streamInfo[12] >> 4;
    const totalSamples = (streamInfo[13] & 15) * 2 ** 32 + (streamInfo[14] << 24 >>> 0) + (streamInfo[15] << 16) + (streamInfo[16] << 8) + streamInfo[17];
    return { kind: "flac", header: { sampleRate, totalSamples, streamInfo, firstFrame: pos } };
  }
  function crc8(bytes, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 128 ? (crc << 1 ^ 7) & 255 : crc << 1 & 255;
      }
    }
    return crc;
  }
  function parseFrameHeader(bytes, pos) {
    if (bytes.length < pos + 4) {
      return "more";
    }
    if (bytes[pos] !== 255 || (bytes[pos + 1] & 254) !== 248) {
      return null;
    }
    const variable = (bytes[pos + 1] & 1) === 1;
    const blockSizeCode = bytes[pos + 2] >> 4;
    const sampleRateCode = bytes[pos + 2] & 15;
    const channelCode = bytes[pos + 3] >> 4;
    const sampleSizeCode = bytes[pos + 3] >> 1 & 7;
    if (blockSizeCode === 0 || sampleRateCode === 15 || channelCode > 10 || sampleSizeCode === 3 || bytes[pos + 3] & 1) {
      return null;
    }
    let p = pos + 4;
    if (bytes.length <= p) {
      return "more";
    }
    const first = bytes[p];
    let length;
    let number;
    if (first < 128) {
      length = 1;
      number = first;
    } else if ((first & 224) === 192) {
      length = 2;
      number = first & 31;
    } else if ((first & 240) === 224) {
      length = 3;
      number = first & 15;
    } else if ((first & 248) === 240) {
      length = 4;
      number = first & 7;
    } else if ((first & 252) === 248) {
      length = 5;
      number = first & 3;
    } else if ((first & 254) === 252) {
      length = 6;
      number = first & 1;
    } else if (first === 254) {
      length = 7;
      number = 0;
    } else {
      return null;
    }
    if (bytes.length < p + length) {
      return "more";
    }
    for (let i = 1; i < length; i++) {
      if ((bytes[p + i] & 192) !== 128) {
        return null;
      }
      number = number * 64 + (bytes[p + i] & 63);
    }
    p += length;
    let blockSize = BLOCK_SIZES[blockSizeCode];
    if (blockSizeCode === 6 || blockSizeCode === 7) {
      const extra = blockSizeCode === 6 ? 1 : 2;
      if (bytes.length < p + extra) {
        return "more";
      }
      blockSize = (blockSizeCode === 6 ? bytes[p] : bytes[p] << 8 | bytes[p + 1]) + 1;
      p += extra;
    }
    if (sampleRateCode === 12) {
      p += 1;
    } else if (sampleRateCode === 13 || sampleRateCode === 14) {
      p += 2;
    }
    if (bytes.length <= p) {
      return "more";
    }
    if (crc8(bytes, pos, p) !== bytes[p]) {
      return null;
    }
    return { blockSize, number, variable };
  }
  var FlacChunker = class {
    constructor(header) {
      this._buffer = new Uint8Array(1 << 20);
      this._length = 0;
      // Buffer offsets of the frames found so far; the first is always 0.
      this._frames = [];
      this._frameSamples = [];
      this._scanPos = 0;
      this._nextSample = 0;
      this._expected = null;
      this._streamInfo = header.streamInfo.slice();
      this._streamInfo[13] &= 240;
      this._streamInfo.fill(0, 14, STREAMINFO_LENGTH);
    }
    push(bytes) {
      if (this._length + bytes.length > this._buffer.length) {
        const grown = new Uint8Array(Math.max(this._buffer.length * 2, this._length + bytes.length));
        grown.set(this._buffer.subarray(0, this._length));
        this._buffer = grown;
      }
      this._buffer.set(bytes, this._length);
      this._length += bytes.length;
      this._scan();
    }
    /**
     * Cuts the complete frames into a chunk once they reach targetBytes. With
     * final, the stream has ended and every remaining frame is complete.
     */
    take(targetBytes, final = false) {
      if (!this._frames.length) {
        if (final && this._length) {
          throw new Error("FLAC stream has data but no valid frame");
        }
        return null;
      }
      let end;
      let frameCount;
      if (final) {
        end = this._length;
        frameCount = this._frames.length;
      } else {
        const cut = this._frames.findIndex((offset, i) => i > 0 && offset >= targetBytes);
        if (cut < 0) {
          return null;
        }
        end = this._frames[cut];
        frameCount = cut;
      }
      const startSample = this._frameSamples[0];
      let samples = 0;
      for (let i = 0; i < frameCount; i++) {
        samples += this._frameSampleCount(i);
      }
      const file = new Uint8Array(8 + STREAMINFO_LENGTH + end);
      file.set([102, 76, 97, 67, 128, 0, 0, STREAMINFO_LENGTH]);
      file.set(this._streamInfo, 8);
      file.set(this._buffer.subarray(0, end), 8 + STREAMINFO_LENGTH);
      this._buffer.copyWithin(0, end, this._length);
      this._length -= end;
      this._scanPos -= end;
      this._frames = this._frames.slice(frameCount).map((offset) => offset - end);
      this._frameSamples = this._frameSamples.slice(frameCount);
      return { file: file.buffer, startSample, samples };
    }
    _frameSampleCount(i) {
      return i + 1 < this._frameSamples.length ? this._frameSamples[i + 1] - this._frameSamples[i] : this._nextSample - this._frameSamples[i];
    }
    _scan() {
      const bytes = this._buffer.subarray(0, this._length);
      while (this._scanPos + 1 < this._length) {
        if (bytes[this._scanPos] !== 255 || (bytes[this._scanPos + 1] & 254) !== 248) {
          this._scanPos++;
          continue;
        }
        const header = parseFrameHeader(bytes, this._scanPos);
        if (header === "more") {
          return;
        }
        const continues = header != null && (this._expected == null ? this._scanPos === 0 : header.number === this._expected);
        if (!continues) {
          if (this._expected == null && this._scanPos === 0) {
            throw new Error("FLAC audio data does not start with a frame");
          }
          this._scanPos++;
          continue;
        }
        this._frames.push(this._scanPos);
        this._frameSamples.push(this._nextSample);
        this._nextSample += header.blockSize;
        this._expected = header.number + (header.variable ? header.blockSize : 1);
        this._scanPos += 2;
      }
    }
  };

  // src/serverConfig.ts
  var SCRIPT_ID = "gapless-player-plugin";
  function getServerConfig() {
    const data = document.getElementById(SCRIPT_ID)?.dataset ?? {};
    return {
      debugLogging: data.debugLogging === "true",
      notifications: data.notifications === "true",
      // Default on: a notification for the tab you are looking at is noise.
      notificationsBackgroundOnly: data.notificationsBackgroundOnly !== "false"
    };
  }

  // src/notifications.ts
  var LOG_PREFIX = "[GaplessPlayer]";
  var NOTIFICATION_TAG = "gapless-player-now-playing";
  var ICON_MAX_HEIGHT = 256;
  var DUPLICATE_WINDOW_MS = 5e3;
  var initialized = false;
  var permissionRequest = null;
  var lastNotified = null;
  function isSupported() {
    return typeof window.Notification !== "undefined";
  }
  function artistLine(item) {
    const names = item.ArtistItems?.map((a) => a.Name).filter((n) => !!n);
    if (names?.length) {
      return names.join(", ");
    }
    if (item.Artists?.length) {
      return item.Artists.join(", ");
    }
    return item.AlbumArtist || "";
  }
  function imageUrl(deps2, item) {
    let id;
    let tag;
    if (item.AlbumId && item.AlbumPrimaryImageTag) {
      id = item.AlbumId;
      tag = item.AlbumPrimaryImageTag;
    } else if (item.Id && item.ImageTags?.Primary) {
      id = item.Id;
      tag = item.ImageTags.Primary;
    }
    if (!id || !tag) {
      return void 0;
    }
    try {
      const apiClient = deps2.ServerConnections?.getApiClient?.(item);
      return apiClient?.getScaledImageUrl?.(id, { type: "Primary", tag, maxHeight: ICON_MAX_HEIGHT });
    } catch {
      return void 0;
    }
  }
  async function show(deps2, item) {
    const title = item.Name || "Now playing";
    const options = {
      body: [artistLine(item), item.Album].filter(Boolean).join(" \u2014 "),
      icon: imageUrl(deps2, item),
      tag: NOTIFICATION_TAG,
      renotify: true,
      // The music is the sound; a notification chime over it is not wanted.
      silent: true
    };
    try {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      return;
    } catch {
    }
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.showNotification(title, options);
    } catch (err) {
      console.warn(`${LOG_PREFIX} could not show now-playing notification`, err);
    }
  }
  function requestPermission() {
    if (!permissionRequest) {
      permissionRequest = Promise.resolve(Notification.requestPermission()).then(() => Notification.permission).catch(() => Notification.permission).finally(() => {
        permissionRequest = null;
      });
    }
    return permissionRequest;
  }
  function onPlaybackStart(deps2, state) {
    const config = getServerConfig();
    if (!config.notifications || !isSupported()) {
      return;
    }
    const item = state?.NowPlayingItem;
    if (!item || item.MediaType !== "Audio") {
      return;
    }
    const now = Date.now();
    if (item.Id && lastNotified?.id === item.Id && now - lastNotified.at < DUPLICATE_WINDOW_MS) {
      return;
    }
    const notify = () => {
      if (config.notificationsBackgroundOnly && !document.hidden && document.hasFocus()) {
        return;
      }
      lastNotified = item.Id ? { id: item.Id, at: now } : null;
      void show(deps2, item);
    };
    if (Notification.permission === "granted") {
      notify();
    } else if (Notification.permission === "default") {
      void requestPermission().then((permission) => {
        if (permission === "granted") {
          notify();
        }
      });
    }
  }
  function initNotifications(deps2) {
    if (initialized) {
      return;
    }
    initialized = true;
    deps2.events.on(deps2.playbackManager, "playbackstart", (...args) => {
      onPlaybackStart(deps2, args[2]);
    });
  }

  // src/toggle.ts
  var SETTING_ENABLED = "enableWebAudioGapless";
  var BUTTON_CLASS = "gaplessToggleButton";
  var LOG_PREFIX2 = "[GaplessPlayer]";
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
      icon.textContent = "all_inclusive";
    }
  }
  function stripPresetSource(item) {
    const clone = { ...item };
    delete clone.PresetMediaSource;
    delete clone.Url;
    return clone;
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
      const raw = typeof pm.getPlaylist === "function" ? await pm.getPlaylist() : null;
      if (!Array.isArray(raw) || raw.length === 0) {
        return false;
      }
      const items = raw.map((it) => enabled ? { ...it, GaplessFallback: void 0 } : stripPresetSource(it));
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
      console.warn(`${LOG_PREFIX2} live toggle restart failed; applies on next playback`, err);
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
    button.innerHTML = '<span class="material-icons" aria-hidden="true">all_inclusive</span>';
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

  // src/trackAudio.ts
  function snapToFrame(seconds, sampleRate) {
    return Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(seconds * sampleRate) / sampleRate : seconds;
  }
  var TrackAudio = class _TrackAudio {
    constructor(duration, _abortController = null) {
      this.duration = duration;
      this._abortController = _abortController;
      this.chunks = [];
      this.complete = false;
      this.error = null;
      this._decodedDuration = 0;
      this._decodedFrames = 0;
      this._listeners = /* @__PURE__ */ new Set();
    }
    static fromBuffer(buffer, maxDuration = Infinity) {
      const duration = Math.min(buffer.duration, snapToFrame(maxDuration, buffer.sampleRate));
      const track = new _TrackAudio(duration);
      track.chunks.push({ startTime: 0, buffer, duration });
      track._decodedDuration = duration;
      track.finish();
      return track;
    }
    get decodedDuration() {
      return this._decodedDuration;
    }
    get settled() {
      return this.complete || this.error != null;
    }
    /**
     * Appends a decoded chunk, of which only the first `frames` play.
     * Positions come from whole frame counts, not summed durations.
     */
    append(buffer, frames = buffer.length) {
      this.chunks.push({ startTime: this._decodedFrames / buffer.sampleRate, buffer, duration: frames / buffer.sampleRate });
      this._decodedFrames += frames;
      this._decodedDuration = this._decodedFrames / buffer.sampleRate;
      this._notify();
    }
    finish() {
      this.complete = true;
      this._notify();
    }
    fail(error) {
      if (this.settled) {
        return;
      }
      this.error = error;
      this._notify();
    }
    /** Stops the download of a track that is still loading. */
    abort() {
      if (!this.settled) {
        this._abortController?.abort();
      }
    }
    subscribe(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    /** Resolves once the track is decoded past positionSec (or complete); rejects if it fails first. */
    waitUntilDecoded(positionSec) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this.complete || this._decodedDuration > positionSec) {
            resolve();
            return true;
          }
          if (this.error != null) {
            reject(this.error);
            return true;
          }
          return false;
        };
        if (check()) {
          return;
        }
        const unsubscribe = this.subscribe(() => {
          if (check()) {
            unsubscribe();
          }
        });
      });
    }
    whenSettled() {
      return new Promise((resolve) => {
        if (this.settled) {
          resolve();
          return;
        }
        const unsubscribe = this.subscribe(() => {
          if (this.settled) {
            unsubscribe();
            resolve();
          }
        });
      });
    }
    _notify() {
      for (const listener of [...this._listeners]) {
        listener();
      }
    }
  };
  var SCHEDULE_MARGIN_SEC = 0.01;
  var TrackVoice = class {
    constructor(_context, _destination, _track, startTime, offsetSec) {
      this._context = _context;
      this._destination = _destination;
      this._track = _track;
      this.onended = null;
      this.onstalled = null;
      this._sources = [];
      this._nextChunk = 0;
      this._stopped = false;
      this._stalled = false;
      this._zeroTime = startTime - offsetSec;
      this._startFirst(startTime, offsetSec);
      this._unsubscribe = _track.subscribe(() => this._scheduleArrived());
    }
    stop() {
      if (this._stopped) {
        return;
      }
      this._stopped = true;
      this._unsubscribe();
      for (const source of this._sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
        }
      }
    }
    _startFirst(startTime, offsetSec) {
      const chunks = this._track.chunks;
      let index = chunks.findIndex((c) => c.startTime + c.duration > offsetSec);
      if (index < 0) {
        index = chunks.length - 1;
      }
      const chunk = chunks[index];
      this._nextChunk = index + 1;
      this._play(chunk, startTime, Math.max(0, offsetSec - chunk.startTime));
      this._scheduleArrived();
    }
    _scheduleArrived() {
      if (this._stopped || this._stalled) {
        return;
      }
      const chunks = this._track.chunks;
      while (this._nextChunk < chunks.length) {
        const chunk = chunks[this._nextChunk];
        const when = snapToFrame(this._zeroTime + chunk.startTime, this._context.sampleRate);
        if (when < this._context.currentTime + SCHEDULE_MARGIN_SEC) {
          return;
        }
        this._nextChunk++;
        this._play(chunk, when, 0);
      }
    }
    _play(chunk, when, offset) {
      const source = this._context.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(this._destination);
      source.onended = () => this._onSourceEnded(chunk);
      if (chunk.duration < chunk.buffer.duration) {
        source.start(when, offset, Math.max(0, chunk.duration - offset));
      } else {
        source.start(when, offset);
      }
      this._sources.push(source);
    }
    _onSourceEnded(chunk) {
      if (this._stopped || this._track.chunks[this._nextChunk - 1] !== chunk) {
        return;
      }
      if (this._track.complete && this._nextChunk >= this._track.chunks.length) {
        this._stopped = true;
        this._unsubscribe();
        this.onended?.();
        return;
      }
      this._stalled = true;
      this._unsubscribe();
      this.onstalled?.(chunk.startTime + chunk.duration);
    }
  };

  // src/plugin.ts
  var TICKS_PER_MS = 1e4;
  var VOLUME_EXPONENT = 3;
  var TIMEUPDATE_INTERVAL_MS = 1e3;
  var DOWNLOAD_PROGRESS_EVENT_MS = 500;
  var BLOCKING_LOOKAHEAD_THRESHOLD_MS = 3e4;
  var FIRST_CHUNK_BYTES = 256 * 1024;
  var CHUNK_BYTES = 1024 * 1024;
  var CONTEXT_SWITCH_TIMEOUT_MS = 300;
  var START_MARGIN_SEC = 1e-3;
  var LOG_PREFIX3 = "[GaplessPlayer]";
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
  var nextPlaylistItemId = 0;
  function clonePlaylistItems(items, freshIds = false) {
    return (items || []).map((item) => ({
      ...item,
      PlaylistItemId: !freshIds && item.PlaylistItemId || `gaplessItem${nextPlaylistItemId++}`
    }));
  }
  function isGaplessItem(item) {
    return item != null;
  }
  function stripPresetSource2(item) {
    const clone = { ...item };
    delete clone.PresetMediaSource;
    delete clone.Url;
    return clone;
  }
  function isAbortError(err) {
    return err instanceof Error && err.name === "AbortError";
  }
  function itemKey(item) {
    return item?.PlaylistItemId ?? item?.Id ?? null;
  }
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function stripLeadingId3(buffer) {
    const start = id3TagLength(new Uint8Array(buffer)) ?? 0;
    return start > 0 && start < buffer.byteLength ? buffer.slice(start) : buffer;
  }
  function concatBytes(parts, length) {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function getIncludeCorsCredentials() {
    return window.__gaplessCors === true;
  }
  async function decodeChunk(audioContext, chunk) {
    const buffer = await audioContext.decodeAudioData(chunk.file);
    if (buffer.length !== chunk.samples) {
      throw new Error(`FLAC chunk decoded to ${buffer.length} samples, expected ${chunk.samples}`);
    }
    return buffer;
  }
  var ByteStream = class {
    constructor(_reader, _total, _onProgress) {
      this._reader = _reader;
      this._total = _total;
      this._onProgress = _onProgress;
      this.loaded = 0;
      this.done = false;
      this._parts = [];
      this._retainedLength = 0;
      this._retain = true;
    }
    /** The next part, or null at the end of the stream. */
    async read() {
      const { done, value } = await this._reader.read();
      if (done) {
        this.done = true;
        return null;
      }
      if (this._retain) {
        this._parts.push(value);
        this._retainedLength += value.byteLength;
      }
      this.loaded += value.byteLength;
      if (this._total > 0) {
        this._onProgress?.(this.loaded, this._total);
      }
      return value;
    }
    /** Everything read so far; only valid before release(). */
    bytes() {
      if (this._parts.length !== 1) {
        this._parts = [concatBytes(this._parts, this._retainedLength)];
      }
      return this._parts[0] ?? new Uint8Array(0);
    }
    async readAll() {
      while (await this.read()) {
      }
      return this.bytes();
    }
    cancel() {
      this.done = true;
      this._reader.cancel().catch(() => void 0);
    }
    release() {
      this._retain = false;
      this._parts = [];
      this._retainedLength = 0;
    }
  };
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
      this._preloadWaiters = /* @__PURE__ */ new WeakSet();
      this._downloadProgress = /* @__PURE__ */ new Map();
      // Item for which an optimistic itemstarted was fired (so the now-playing
      // bar appears and paints download progress) but audio has not started yet.
      // Non-null only during the initial load window of play().
      this._loadingItem = null;
      // A seek landed during the load window; the deferred start then skips the
      // blocking next-track wait, like a seek while playing.
      this._seekedWhileLoading = false;
      // waitForNext of the latest _startFrom, for restarting it after a mutation.
      this._startWaitsForNext = true;
      // A start waiting for a suspended AudioContext to resume; it has not
      // touched the playback state yet, so pause, seek, next and previous act on
      // its target. With a running context this window is one microtask.
      this._pendingStart = null;
      this._lastProgressTriggerMs = 0;
      this._scheduled = /* @__PURE__ */ new Map();
      this._scheduledStartTimes = /* @__PURE__ */ new Map();
      this._schedule = /* @__PURE__ */ new Map();
      this._volume = 100;
      this._muted = false;
      this._isPaused = true;
      // Stop reporting: the item announced by itemstarted and not yet stopped,
      // the next item a boundary itemstopped promised but which has not started
      // yet (boundary recovery), and the position at which the reported item's
      // audio was interrupted by a start still in flight.
      this._reportedItem = null;
      this._awaitedItem = null;
      this._interruptedAtMs = null;
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
      initNotifications(deps2);
    }
    // --- Local settings (localStorage via appSettings) ---------------------
    /** Installed = enabled: default true when the setting has never been set. */
    isGaplessEnabled() {
      const value = this._appSettings.get(SETTING_ENABLED2);
      return value == null ? true : value === "true";
    }
    /** A local setting wins; otherwise the server-wide default applies. */
    isDebugEnabled() {
      const value = this._appSettings.get(SETTING_DEBUG);
      return value == null ? getServerConfig().debugLogging : value === "true";
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
        console.debug(`${LOG_PREFIX3} ${message}`);
      } else {
        console.debug(`${LOG_PREFIX3} ${message}`, data);
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
      if (playOptions.enableWebAudioGapless === false || item?.GaplessFallback) {
        return false;
      }
      if (!getAudioContextConstructor()) {
        return false;
      }
      if (playOptions.items) {
        return playOptions.items.length > 1 && playOptions.items.every((i) => i?.MediaType === "Audio" && isFiniteDuration(i));
      }
      return item?.MediaType === "Audio" && isFiniteDuration(item) && this._playlist.some((i) => item.Id != null && i.Id === item.Id || item.PlaylistItemId != null && i.PlaylistItemId === item.PlaylistItemId);
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
      this._loadingItem = this.currentItem();
      this._seekedWhileLoading = false;
      this._emitItemStarted();
      const loadId = this._playbackId;
      try {
        await this._ensureAudioGraph();
        await this._decodeIndex(this._currentIndex);
      } catch (err) {
        if (isAbortError(err) || loadId !== this._playbackId) {
          return;
        }
        console.warn(`${LOG_PREFIX3} initial decode failed; handing off to normal playback`, err);
        this._handoffToNormalPlayback(this._currentIndex, Math.round(this._basePositionMs * TICKS_PER_MS));
        return;
      }
      if (!this._loadingItem || loadId !== this._playbackId) {
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
    stop(destroyPlayer) {
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
    destroy() {
      this._resetReportState();
      this._isPaused = true;
      this._playbackId++;
      this._stopScheduledSources();
      this._stopTimeUpdates();
      this._clearDecodedAfterMutation();
      this._clearPlaylistState();
      if (this._audioContext) {
        this._audioContext.close().catch((err) => {
          console.warn(`${LOG_PREFIX3} failed to close AudioContext`, err);
        });
        this._audioContext = null;
      }
      this._gainNode = null;
    }
    pause() {
      const pending = this._pendingTarget();
      if (this._isPaused && !this._loadingItem && !pending) {
        return;
      }
      if (pending) {
        if (this._reportedItem && this._interruptedAtMs == null) {
          this._interruptedAtMs = this.getCurrentTimeMs();
        }
        this._currentIndex = pending.index;
        this._basePositionMs = pending.positionMs;
      }
      this._pausePositionMs = pending ? pending.positionMs : this.getCurrentTimeMs();
      if (this._reportedItem && itemKey(this._reportedItem) === itemKey(this.currentItem())) {
        this._interruptedAtMs = null;
      }
      this._loadingItem = null;
      this._seekedWhileLoading = false;
      this._playbackId++;
      this._stopScheduledSources();
      this._stopTimeUpdates();
      this._isPaused = true;
      this._events.trigger(this, "pause");
    }
    resume() {
      return this.unpause();
    }
    unpause() {
      if (!this._isPaused || !this._playlist.length || this._pendingTarget()) {
        return Promise.resolve();
      }
      return this._startFrom(this._currentIndex, this._pausePositionMs, { waitForNext: false });
    }
    paused() {
      return this._loadingItem ? false : this._isPaused;
    }
    currentTime(val) {
      if (val != null) {
        this._seekToMs(val).catch((err) => {
          console.error(`${LOG_PREFIX3} failed to seek`, err);
        });
      }
      return this.getCurrentTimeMs();
    }
    getCurrentTimeMs() {
      if (this._isPaused || !this._audioContext) {
        return this._pausePositionMs;
      }
      if (!this._scheduled.has(this._currentIndex)) {
        return this._basePositionMs;
      }
      return this._basePositionMs + Math.max(0, (this._audioContext.currentTime - this._baseContextTime) * 1e3);
    }
    duration() {
      const ticks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
      return ticks ? ticks / TICKS_PER_MS : null;
    }
    seekable() {
      return true;
    }
    getBufferedRanges() {
      const runTimeTicks = this.currentMediaSource()?.RunTimeTicks || this.currentItem()?.RunTimeTicks;
      if (!runTimeTicks) {
        return [];
      }
      const track = this._decoded.get(this._currentIndex);
      if (track) {
        const fraction2 = track.complete ? 1 : Math.min(1, track.decodedDuration / track.duration);
        return [{ start: 0, end: Math.floor(runTimeTicks * fraction2) }];
      }
      const progress = this._downloadProgress.get(this._currentIndex);
      if (!progress?.total) {
        return [];
      }
      const fraction = Math.min(1, progress.loaded / progress.total);
      return [{ start: 0, end: Math.floor(runTimeTicks * fraction) }];
    }
    seek(positionTicks) {
      return this._seekToMs(positionTicks / TICKS_PER_MS);
    }
    _seekToMs(positionMs) {
      const pending = this._pendingTarget();
      if (this._isPaused) {
        if (this._loadingItem) {
          this._seekedWhileLoading = true;
        }
        if (pending && this._reportedItem && this._interruptedAtMs == null && itemKey(this._reportedItem) !== itemKey(this._playlist[pending.index])) {
          this._interruptedAtMs = this.getCurrentTimeMs();
        }
        this._basePositionMs = positionMs;
        this._pausePositionMs = positionMs;
        if (!pending) {
          this._events.trigger(this, "timeupdate");
          return Promise.resolve();
        }
      }
      return this._startFrom(pending ? pending.index : this._currentIndex, positionMs, { waitForNext: false });
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
      const nextIndex = this._nextIndex(this._pendingTarget()?.index ?? this._currentIndex);
      if (nextIndex == null) {
        return Promise.resolve();
      }
      return this._startFrom(nextIndex, 0);
    }
    previousTrack() {
      const pending = this._pendingTarget();
      const index = pending?.index ?? this._currentIndex;
      if ((pending?.positionMs ?? this.getCurrentTimeMs()) > 3e3) {
        return this._startFrom(index, 0);
      }
      return this._startFrom(Math.max(0, index - 1), 0);
    }
    queue(items) {
      this._playlist.push(...clonePlaylistItems(items, true));
      if (!this._isPaused) {
        this._scheduleLookaheadForCurrent();
        this._preloadNext();
      }
      this._events.trigger(this, "playlistitemadd");
    }
    queueNext(items) {
      const anchor = this._pendingTarget()?.index ?? this._currentIndex;
      const added = clonePlaylistItems(items, true);
      const oldCurrentIndex = this._currentIndex;
      this._playlist.splice(anchor + 1, 0, ...added);
      if (anchor < oldCurrentIndex) {
        this._currentIndex += added.length;
      }
      this._handlePlaylistMutation(oldCurrentIndex);
      this._events.trigger(this, "playlistitemadd");
    }
    removeFromPlaylist(playlistItemIds) {
      const ids = new Set(Array.isArray(playlistItemIds) ? playlistItemIds : [playlistItemIds]);
      const oldCurrentIndex = this._currentIndex;
      const currentItemId = this.getCurrentPlaylistItemId();
      const isCurrentRemoved = currentItemId != null && ids.has(currentItemId);
      const removedBeforeCurrent = this._playlist.slice(0, oldCurrentIndex).filter((item) => item.PlaylistItemId && ids.has(item.PlaylistItemId)).length;
      if (isCurrentRemoved && this._reportedItem && this._interruptedAtMs == null) {
        this._interruptedAtMs = this.getCurrentTimeMs();
      }
      this._playlist = this._playlist.filter((item) => !item.PlaylistItemId || !ids.has(item.PlaylistItemId));
      this._currentIndex = Math.min(
        Math.max(0, oldCurrentIndex - removedBeforeCurrent),
        Math.max(0, this._playlist.length - 1)
      );
      this._events.trigger(this, "playlistitemremove", [{ playlistItemIds }]);
      const pending = this._pendingStart;
      if (pending && pending.playbackId === this._playbackId && !this._pendingTarget()) {
        this._pendingStart = null;
        this._restoreInterruptedPosition();
      }
      if (!this._playlist.length) {
        return this.stop(true);
      }
      if (isCurrentRemoved) {
        this._clearDecodedAfterMutation();
        if (this._restartPendingStart()) {
          return Promise.resolve();
        }
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
      this._clearDecodedAfterMutation(currentBuffer);
      const newCurrentIndex = this._currentIndex;
      if (currentSource) {
        const playbackId = this._playbackId;
        currentSource.onended = () => this._onSourceEnded(newCurrentIndex, playbackId);
        currentSource.onstalled = (positionSec) => this._onVoiceStalled(newCurrentIndex, playbackId, positionSec);
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
        if (this._restartPendingStart()) {
          return;
        }
        const playbackId = ++this._playbackId;
        this._decodeIndex(newCurrentIndex).then(() => {
          if (playbackId !== this._playbackId || !this._loadingItem) {
            return Promise.resolve();
          }
          return this._startFrom(newCurrentIndex, this._pausePositionMs, { waitForNext: !this._seekedWhileLoading });
        }).catch((err) => {
          if (isAbortError(err) || playbackId !== this._playbackId) {
            return;
          }
          console.error(`${LOG_PREFIX3} failed to restart load after playlist mutation`, err);
          this._handoffToNormalPlayback(newCurrentIndex, Math.round(this._pausePositionMs * TICKS_PER_MS));
        });
        return;
      }
      if (!this._isPaused && !currentSource) {
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
      const audioContext = this._audioContext;
      const state = audioContext.state;
      if (state === "suspended" || state === "interrupted") {
        try {
          await audioContext.resume();
        } catch (err) {
          if (this._audioContext && this._audioContext !== audioContext) {
            return this._ensureAudioGraph();
          }
          throw err;
        }
      }
    }
    /**
     * Moves a queue that has not started yet onto an AudioContext running at
     * the first track's sample rate, so progressive FLAC decodes need no
     * resampling and the system resamples the output as one stream. Keeps the
     * current context when the browser ignores the rate or will not start the
     * new context without a user gesture.
     */
    async _switchContextRate(sampleRate, index, signal) {
      const current = this._audioContext;
      const AudioContextCtor = getAudioContextConstructor();
      if (!current || !AudioContextCtor) {
        return;
      }
      let next;
      try {
        next = new AudioContextCtor({ sampleRate });
      } catch {
        return;
      }
      const discard = () => {
        next.close().catch(() => {
        });
      };
      if (next.sampleRate !== sampleRate) {
        discard();
        return;
      }
      if (next.state !== "running") {
        const started = await Promise.race([
          next.resume().then(() => true, () => false),
          delay(CONTEXT_SWITCH_TIMEOUT_MS).then(() => false)
        ]);
        if (!started || next.state !== "running") {
          discard();
          return;
        }
      }
      if (this._audioContext !== current || signal.aborted || !this._canSwitchContextRate(index)) {
        discard();
        return;
      }
      this.debugLog("switched AudioContext sample rate", { from: current.sampleRate, to: sampleRate });
      this._audioContext = next;
      this._gainNode = next.createGain();
      this._gainNode.connect(next.destination);
      this._applyVolume();
      current.close().catch((err) => {
        console.warn(`${LOG_PREFIX3} failed to close AudioContext`, err);
      });
    }
    /**
     * Only the initial load of a queue may replace the context, for its
     * current item: nothing plays, is decoded or is decoding on the old one.
     * A load superseded since it probed is aborted; callers check the signal.
     */
    _canSwitchContextRate(index) {
      return this._loadingItem != null && index === this._currentIndex && !this._scheduled.size && !this._decoded.size && this._decoding.size <= 1;
    }
    _applyVolume() {
      if (this._gainNode) {
        const volume = this._muted ? 0 : Math.pow(this._volume / 100, VOLUME_EXPONENT);
        this._gainNode.gain.value = volume;
      }
    }
    /** Resolves once the track is playable: fully decoded, or its first chunk for progressive FLAC. */
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
      const onProgress = (loaded, total) => {
        if (this._decodeAborts.get(index) !== abortController) {
          return;
        }
        this._downloadProgress.set(index, { loaded, total });
        if (index === this._currentIndex) {
          this._triggerDownloadProgress();
        }
      };
      const decode = this._fetchAndDecode(url, index, abortController, onProgress).then((audioBuffer) => {
        if (this._decoding.get(index) === decode) {
          this._decoding.delete(index);
          this._decodeAborts.delete(index);
          this._downloadProgress.delete(index);
          this._decoded.set(index, audioBuffer);
          if (!audioBuffer.settled) {
            audioBuffer.subscribe(() => {
              if (this._decoded.get(this._currentIndex) === audioBuffer) {
                this._triggerDownloadProgress();
              }
            });
          }
          this._scheduleDecodedLookahead(index, audioBuffer);
          this._pruneDecoded();
        } else {
          audioBuffer.abort();
        }
        return audioBuffer;
      }).catch((err) => {
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
    /**
     * Downloads and decodes a track. A FLAC stream at the context's sample
     * rate resolves after its first chunk is decoded and keeps decoding into
     * the returned track while it downloads; anything else resolves after the
     * full download and decode. An abort of the controller rejects with an
     * AbortError (or fails the track), which callers treat as "superseded".
     */
    async _fetchAndDecode(url, index, abortController, onProgress) {
      const response = await fetch(url, {
        credentials: getIncludeCorsCredentials() ? "include" : "same-origin",
        signal: abortController.signal
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch gapless audio: ${response.status}`);
      }
      if (!response.body) {
        return this._decodeFull(new Uint8Array(await response.arrayBuffer()));
      }
      const total = Number(response.headers.get("Content-Length")) || 0;
      const stream = new ByteStream(response.body.getReader(), total, onProgress);
      let probe = probeFlac(new Uint8Array(0));
      let probeAt = 0;
      while (probe.kind === "more" && await stream.read()) {
        if (stream.loaded >= probeAt) {
          probe = probeFlac(stream.bytes());
          probeAt = stream.loaded * 2;
        }
      }
      if (probe.kind === "more") {
        probe = probeFlac(stream.bytes());
      }
      let maxDuration = Infinity;
      if (probe.kind === "flac") {
        const { header } = probe;
        if (header.totalSamples > 0) {
          maxDuration = header.totalSamples / header.sampleRate;
        }
        if (this._audioContext && header.sampleRate !== this._audioContext.sampleRate && this._canSwitchContextRate(index)) {
          await this._switchContextRate(header.sampleRate, index, abortController.signal);
          abortController.signal.throwIfAborted();
        }
        const audioContext = this._audioContext;
        if (audioContext && header.sampleRate === audioContext.sampleRate && header.totalSamples > 0) {
          return this._decodeProgressive(audioContext, header, stream, abortController, maxDuration);
        }
      }
      return this._decodeFull(await stream.readAll(), maxDuration);
    }
    /** Audio past `maxDuration` (the STREAMINFO length) is cut, as in the progressive path. */
    async _decodeFull(bytes, maxDuration = Infinity) {
      if (!this._audioContext) {
        throw new Error("AudioContext was closed before decode completed");
      }
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
      return TrackAudio.fromBuffer(await this._audioContext.decodeAudioData(stripLeadingId3(buffer)), maxDuration);
    }
    async _decodeProgressive(audioContext, header, stream, abortController, maxDuration) {
      const chunker = new FlacChunker(header);
      let track;
      let first;
      try {
        chunker.push(stream.bytes().subarray(header.firstFrame));
        let chunk = chunker.take(FIRST_CHUNK_BYTES, stream.done);
        while (!chunk && !stream.done) {
          const part = await stream.read();
          if (part) {
            chunker.push(part);
          }
          chunk = chunker.take(FIRST_CHUNK_BYTES, stream.done);
        }
        if (!chunk) {
          throw new Error("FLAC stream has no audio frames");
        }
        first = chunk;
        track = new TrackAudio(header.totalSamples / header.sampleRate, abortController);
        track.append(await decodeChunk(audioContext, first), Math.min(first.samples, header.totalSamples));
        abortController.signal.throwIfAborted();
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        console.warn(`${LOG_PREFIX3} progressive FLAC decode failed; decoding the full file`, err);
        return this._decodeFull(await stream.readAll(), maxDuration);
      }
      stream.release();
      void this._continueProgressive(audioContext, header, chunker, stream, track, first.samples);
      return track;
    }
    async _continueProgressive(audioContext, header, chunker, stream, track, decodedSamples) {
      try {
        while (decodedSamples < header.totalSamples) {
          const chunk = chunker.take(CHUNK_BYTES, stream.done);
          if (chunk) {
            const playable = Math.min(chunk.samples, header.totalSamples - decodedSamples);
            track.append(await decodeChunk(audioContext, chunk), playable);
            decodedSamples += chunk.samples;
          } else if (stream.done) {
            throw new Error(`FLAC stream ended after ${decodedSamples} of ${header.totalSamples} samples`);
          } else {
            const part = await stream.read();
            if (part) {
              chunker.push(part);
            }
          }
        }
        if (!stream.done) {
          stream.cancel();
        }
        if (decodedSamples > header.totalSamples) {
          console.warn(`${LOG_PREFIX3} FLAC stream is longer than its STREAMINFO total of ${header.totalSamples} samples; the rest is cut`);
        }
        track.finish();
      } catch (err) {
        if (!isAbortError(err)) {
          console.warn(`${LOG_PREFIX3} progressive FLAC decode failed mid-track`, err);
        }
        track.fail(err);
      }
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
      if (nextIndex == null || this._decoded.has(nextIndex) || this._decoding.has(nextIndex)) {
        return;
      }
      const current = this._decoded.get(this._currentIndex);
      if (current && !current.settled) {
        if (!this._preloadWaiters.has(current)) {
          this._preloadWaiters.add(current);
          current.whenSettled().then(() => {
            if (this._decoded.get(this._currentIndex) === current) {
              this._preloadNext();
            }
          });
        }
        return;
      }
      this._decodeIndex(nextIndex).catch((err) => {
        if (!isAbortError(err)) {
          console.warn(`${LOG_PREFIX3} failed to preload next item`, err);
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
    async _startFrom(index, positionMs, { waitForNext = true } = {}) {
      this._playbackId++;
      const playbackId = this._playbackId;
      const targetKey = itemKey(this._playlist[index]);
      this._pendingStart = { playbackId, targetKey, positionMs, waitForNext };
      const handOff = (err) => {
        if (isAbortError(err) || playbackId !== this._playbackId) {
          return;
        }
        console.error(`${LOG_PREFIX3} failed to start; handing off to normal playback`, err);
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
        const movedIndex = this._playlist.findIndex((i) => itemKey(i) === targetKey);
        if (movedIndex < 0) {
          return;
        }
        index = movedIndex;
      }
      if (playbackId !== this._playbackId || !this._audioContext) {
        return;
      }
      if (this._reportedItem && this._interruptedAtMs == null) {
        this._interruptedAtMs = this.getCurrentTimeMs();
      }
      this._stopScheduledSources();
      this._stopTimeUpdates();
      this._currentIndex = index;
      this._pruneDecoded();
      this._startWaitsForNext = waitForNext;
      this._basePositionMs = positionMs;
      this._pausePositionMs = positionMs;
      this._isPaused = false;
      const currentBuffer = await this._decodeIndex(index).then(async (track) => {
        await track.waitUntilDecoded(positionMs / 1e3 + START_MARGIN_SEC);
        return track;
      }).catch((err) => {
        handOff(err);
        return null;
      });
      if (!currentBuffer) {
        return;
      }
      const remainingMs = Math.max(0, currentBuffer.duration * 1e3 - positionMs);
      if (waitForNext && remainingMs <= BLOCKING_LOOKAHEAD_THRESHOLD_MS) {
        await this._decodeNextForBoundary(index);
      }
      const audioContext = this._audioContext;
      if (playbackId !== this._playbackId || !audioContext) {
        return;
      }
      const startedAt = snapToFrame(audioContext.currentTime + 0.05, audioContext.sampleRate);
      const offsetSec = snapToFrame(positionMs / 1e3, audioContext.sampleRate);
      const endsAt = startedAt + currentBuffer.duration - offsetSec;
      this._scheduleIndex(index, currentBuffer, startedAt, offsetSec, playbackId);
      this._baseContextTime = startedAt;
      this._schedule.set(index, { startTime: startedAt - offsetSec, playbackId });
      const nextIndex = this._nextIndex(index);
      if (nextIndex != null && nextIndex !== index) {
        this._schedule.set(nextIndex, { startTime: endsAt, playbackId });
        this._scheduleNextIfReady(nextIndex, endsAt, playbackId);
      }
      this._preloadNext();
      this._startTimeUpdates();
      const startedItem = this.currentItem();
      if (this._loadingItem && itemKey(this._loadingItem) !== itemKey(startedItem)) {
        this._abandonOptimisticStart(startedItem);
      } else {
        this._loadingItem = null;
      }
      if (this._reportedItem && itemKey(this._reportedItem) !== itemKey(startedItem)) {
        this._emitItemStopped(this._reportedItem, startedItem, this._interruptedAtMs ?? 0);
      }
      if (playbackId !== this._playbackId) {
        return;
      }
      this._interruptedAtMs = null;
      if (!this._reportedItem) {
        this._emitItemStarted();
      } else {
        this._events.trigger(this, "timeupdate");
      }
      this._events.trigger(this, "unpause");
    }
    _scheduleIndex(index, track, startTime, offsetSeconds, playbackId = this._playbackId) {
      if (!this._audioContext || !this._gainNode || playbackId !== this._playbackId) {
        return;
      }
      const source = new TrackVoice(this._audioContext, this._gainNode, track, startTime, offsetSeconds);
      source.onended = () => this._onSourceEnded(index, playbackId);
      source.onstalled = (positionSec) => this._onVoiceStalled(index, playbackId, positionSec);
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
          console.warn(`${LOG_PREFIX3} failed to decode next item before boundary`, err);
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
      const endPositionMs = item?.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_MS : 0;
      if (nextIndex == null || !nextItem) {
        this._isPaused = true;
        this._emitItemStopped(item, null, endPositionMs);
        return;
      }
      const nextStartTime = this._scheduledStartTimes.get(nextIndex);
      const isNextScheduled = nextStartTime != null && nextStartTime <= audioContext.currentTime + 0.25;
      const isNextDecoded = this._decoded.has(nextIndex);
      this._emitItemStopped(item, nextItem, endPositionMs);
      if (playbackId !== this._playbackId) {
        return;
      }
      if (!isNextScheduled && !isNextDecoded) {
        this._currentIndex = nextIndex;
        this._basePositionMs = 0;
        this._pausePositionMs = 0;
        console.warn(`${LOG_PREFIX3} boundary missed; recovering in place`, {
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
          const startTime = snapToFrame(audioContext.currentTime, audioContext.sampleRate);
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
      this._emitItemStarted();
      this._preloadNext();
      this._pruneDecoded();
    }
    /**
     * A progressive track's download fell behind playback: its decoded audio
     * ran out mid-track. Restart in place once the stall position is decoded,
     * like a seek; a failed download hands off from there.
     */
    _onVoiceStalled(index, playbackId, positionSec) {
      if (playbackId !== this._playbackId || index !== this._currentIndex || this._isPaused) {
        return;
      }
      const positionMs = positionSec * 1e3;
      console.warn(`${LOG_PREFIX3} progressive download fell behind playback; waiting`, {
        index,
        positionMs
      });
      this._stopScheduledSources();
      this._basePositionMs = positionMs;
      this._pausePositionMs = positionMs;
      this._recoverAtIndex(index, positionMs, { waitForNext: false });
    }
    /**
     * The next item was not ready when the current source ended. Try to keep
     * playback inside the gapless player and only hand off to the regular
     * player stack if decoding fails. Calling playbackManager.play() from here
     * while a user-initiated play request is in flight would let the two
     * requests race (e.g. a stale handoff resuming the old album over a newly
     * selected one), so this stays inside the plugin whenever possible.
     */
    _recoverAtIndex(index, positionMs = 0, { waitForNext = true } = {}) {
      const playbackId = this._playbackId;
      this._startWaitsForNext = waitForNext;
      this._decodeIndex(index).then(() => {
        if (playbackId !== this._playbackId) {
          return;
        }
        return this._startFrom(index, positionMs, { waitForNext });
      }).catch((err) => {
        if (isAbortError(err) || playbackId !== this._playbackId) {
          return;
        }
        console.error(`${LOG_PREFIX3} failed to recover gapless playback`, err);
        this._handoffToNormalPlayback(index, Math.round(positionMs * TICKS_PER_MS));
      });
    }
    _handoffToNormalPlayback(startIndex, startPositionTicks = 0) {
      const items = this._playlist.slice(startIndex).map((item) => ({ ...stripPresetSource2(item), GaplessFallback: true }));
      const owed = this._owedStop();
      if (owed?.started) {
        this._emitItemStopped(owed.item, this._playlist[startIndex] ?? null, owed.positionMs);
      }
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
        console.error(`${LOG_PREFIX3} failed to hand off to normal playback`, err);
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
    /** Drops all decode state; keep is a track that stays playing (re-keyed by the caller). */
    _clearDecodedAfterMutation(keep) {
      for (const abortController of this._decodeAborts.values()) {
        abortController.abort();
      }
      for (const track of this._decoded.values()) {
        if (track !== keep) {
          track.abort();
        }
      }
      this._decodeAborts.clear();
      this._decoded.clear();
      this._decoding.clear();
      this._downloadProgress.clear();
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
      for (const [index, track] of this._decoded) {
        if (!keep.has(index)) {
          track.abort();
          this._decoded.delete(index);
        }
      }
      for (const [index, abortController] of this._decodeAborts) {
        if (!keep.has(index)) {
          abortController.abort();
          this._decodeAborts.delete(index);
          this._decoding.delete(index);
          this._downloadProgress.delete(index);
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
    /**
     * Fires the itemstopped that pairs with an optimistic itemstarted whose
     * audio never started because a different item started.
     * playbackManager only resets its per-item stream state on the next
     * itemstarted, so skipping this would leave a dangling play session on
     * the server. No-op outside the load window.
     */
    _abandonOptimisticStart(nextItem = null) {
      const item = this._loadingItem;
      if (!item) {
        return;
      }
      this._loadingItem = null;
      this._emitItemStopped(item, nextItem, this._interruptedAtMs ?? this._pausePositionMs);
    }
    /** The start still waiting for the AudioContext, if live, and where its target is now. */
    _pendingTarget() {
      const pending = this._pendingStart;
      if (!pending || pending.playbackId !== this._playbackId) {
        return null;
      }
      const index = this._playlist.findIndex((i) => itemKey(i) === pending.targetKey);
      return index >= 0 ? { index, positionMs: pending.positionMs, waitForNext: pending.waitForNext } : null;
    }
    /**
     * Restarts a start waiting for the AudioContext for its re-keyed target,
     * superseding the load or start a mutation aborted. _startFrom registers
     * the new pending start synchronously, so pause, seek and skips keep
     * acting on it while it waits.
     */
    _restartPendingStart() {
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
    _restoreInterruptedPosition() {
      if (this._isPaused && this._interruptedAtMs != null && itemKey(this._reportedItem) === itemKey(this.currentItem())) {
        this._basePositionMs = this._interruptedAtMs;
        this._pausePositionMs = this._interruptedAtMs;
        this._interruptedAtMs = null;
      }
    }
    _owedStop() {
      if (this._loadingItem) {
        return { item: this._loadingItem, positionMs: this._interruptedAtMs ?? this._pausePositionMs, started: true };
      }
      if (this._reportedItem) {
        return { item: this._reportedItem, positionMs: this._interruptedAtMs ?? this.getCurrentTimeMs(), started: true };
      }
      if (this._awaitedItem) {
        return { item: this._awaitedItem, positionMs: 0, started: false };
      }
      return null;
    }
    _resetReportState() {
      this._loadingItem = null;
      this._reportedItem = null;
      this._awaitedItem = null;
      this._interruptedAtMs = null;
    }
    _emitItemStarted() {
      this._reportedItem = this.currentItem();
      this._awaitedItem = null;
      this._interruptedAtMs = null;
      this._events.trigger(this, "itemstarted", [this.currentItem(), this.currentMediaSource()]);
    }
    _emitItemStopped(item, nextItem, positionMs = 0) {
      this._reportedItem = null;
      this._awaitedItem = nextItem;
      this._events.trigger(this, "itemstopped", [{
        item,
        mediaSource: getMediaSource(item),
        // Whole ms: playbackManager reports positionMs * 10000 as Int64
        // ticks, and a fractional value fails the server's validation (400).
        positionMs: Math.round(positionMs),
        nextItem: nextItem ? { item: nextItem } : null,
        nextMediaType: nextItem ? nextItem.MediaType : null
      }]);
    }
    _triggerDownloadProgress() {
      const now = performance.now();
      if (now - this._lastProgressTriggerMs < DOWNLOAD_PROGRESS_EVENT_MS) {
        return;
      }
      this._lastProgressTriggerMs = now;
      this._events.trigger(this, "timeupdate");
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
