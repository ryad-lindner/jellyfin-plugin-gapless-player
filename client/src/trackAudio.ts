/**
 * A track's decoded audio, either one buffer for the whole track or chunks
 * that arrive while the track downloads, and the sources that play it.
 */

/**
 * Rounds a context time to a whole sample frame. Sources started between
 * frames are interpolated at their edges, which breaks the sample-exact joins
 * between chunks and tracks.
 */
export function snapToFrame(seconds: number, sampleRate: number): number {
    return Number.isFinite(sampleRate) && sampleRate > 0
        ? Math.round(seconds * sampleRate) / sampleRate
        : seconds;
}

export interface TrackChunk {
    /** Track position of the chunk's first sample, in seconds. */
    startTime: number;
    buffer: AudioBuffer;
    /** Playable length in seconds; shorter than the buffer when its tail is cut. */
    duration: number;
}

export class TrackAudio {
    readonly chunks: TrackChunk[] = [];
    complete = false;
    error: unknown = null;
    private _decodedDuration = 0;
    private _decodedFrames = 0;
    private readonly _listeners = new Set<() => void>();

    constructor(
        /** Full track length in seconds, known before all chunks are decoded. */
        readonly duration: number,
        private readonly _abortController: AbortController | null = null
    ) {}

    static fromBuffer(buffer: AudioBuffer): TrackAudio {
        const track = new TrackAudio(buffer.duration);
        track.chunks.push({ startTime: 0, buffer, duration: buffer.duration });
        track._decodedDuration = buffer.duration;
        track.finish();
        return track;
    }

    get decodedDuration(): number {
        return this._decodedDuration;
    }

    get settled(): boolean {
        return this.complete || this.error != null;
    }

    /**
     * Appends a decoded chunk, of which only the first `frames` play.
     * Positions come from whole frame counts, not summed durations.
     */
    append(buffer: AudioBuffer, frames = buffer.length): void {
        this.chunks.push({ startTime: this._decodedFrames / buffer.sampleRate, buffer, duration: frames / buffer.sampleRate });
        this._decodedFrames += frames;
        this._decodedDuration = this._decodedFrames / buffer.sampleRate;
        this._notify();
    }

    finish(): void {
        this.complete = true;
        this._notify();
    }

    fail(error: unknown): void {
        if (this.settled) {
            return;
        }
        this.error = error;
        this._notify();
    }

    /** Stops the download of a track that is still loading. */
    abort(): void {
        if (!this.settled) {
            this._abortController?.abort();
        }
    }

    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** Resolves once the track is decoded past positionSec (or complete); rejects if it fails first. */
    waitUntilDecoded(positionSec: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const check = (): boolean => {
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

    whenSettled(): Promise<void> {
        return new Promise<void>((resolve) => {
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

    private _notify(): void {
        for (const listener of [...this._listeners]) {
            listener();
        }
    }
}

/** Seconds a chunk must still be ahead of the clock to be scheduled seamlessly. */
const SCHEDULE_MARGIN_SEC = 0.01;

/**
 * Plays a track from an offset with one source per chunk, back to back on the
 * context timeline. Chunks decoded later are scheduled as they arrive. If the
 * last scheduled chunk ends before the next one is decoded, onstalled reports
 * the track position where the audio stopped; onended fires only at the end of
 * the complete track. Like a source node, the callbacks are read at dispatch
 * time, so they can be rebound.
 */
export class TrackVoice {
    onended: (() => void) | null = null;
    onstalled: ((positionSec: number) => void) | null = null;
    private readonly _sources: AudioBufferSourceNode[] = [];
    private _nextChunk = 0;
    private _stopped = false;
    private _stalled = false;
    private readonly _unsubscribe: () => void;
    // Context time of track position 0.
    private readonly _zeroTime: number;

    constructor(
        private readonly _context: BaseAudioContext,
        private readonly _destination: AudioNode,
        private readonly _track: TrackAudio,
        startTime: number,
        offsetSec: number
    ) {
        this._zeroTime = startTime - offsetSec;
        this._startFirst(startTime, offsetSec);
        this._unsubscribe = _track.subscribe(() => this._scheduleArrived());
    }

    stop(): void {
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
                // Source may not have started yet or may already have ended.
            }
        }
    }

    private _startFirst(startTime: number, offsetSec: number): void {
        const chunks = this._track.chunks;
        let index = chunks.findIndex(c => c.startTime + c.duration > offsetSec);
        if (index < 0) {
            // At or past the end: like a single source started past its
            // buffer, play nothing and end right away.
            index = chunks.length - 1;
        }
        const chunk = chunks[index];
        this._nextChunk = index + 1;
        this._play(chunk, startTime, Math.max(0, offsetSec - chunk.startTime));
        this._scheduleArrived();
    }

    private _scheduleArrived(): void {
        if (this._stopped || this._stalled) {
            return;
        }
        const chunks = this._track.chunks;
        while (this._nextChunk < chunks.length) {
            const chunk = chunks[this._nextChunk];
            const when = snapToFrame(this._zeroTime + chunk.startTime, this._context.sampleRate);
            if (when < this._context.currentTime + SCHEDULE_MARGIN_SEC) {
                // Decoded too late to join seamlessly; the previous chunk's
                // end reports the stall.
                return;
            }
            this._nextChunk++;
            this._play(chunk, when, 0);
        }
    }

    private _play(chunk: TrackChunk, when: number, offset: number): void {
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

    private _onSourceEnded(chunk: TrackChunk): void {
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
}
