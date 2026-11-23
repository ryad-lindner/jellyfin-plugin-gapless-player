const LOG_PREFIX = '[GaplessPlayer]';

// Only a position this module set is cleared, so repeated releases (handoff, then destroy) do not clear again.
let positionSet = false;

/**
 * Tells the media session where playback is. Without it the OS reads the
 * element's clock, which runs on across tracks and pauses. Null clears it.
 */
export function setMediaPosition(positionMs: number, durationMs: number | null): void {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session?.setPositionState) {
        return;
    }
    try {
        if (durationMs == null || !(durationMs > 0)) {
            if (positionSet) {
                positionSet = false;
                session.setPositionState();
            }
            return;
        }
        const duration = durationMs / 1000;
        const position = Number.isFinite(positionMs) ? Math.min(Math.max(0, positionMs / 1000), duration) : 0;
        session.setPositionState({ duration, playbackRate: 1, position });
        positionSet = true;
    } catch (err) {
        console.warn(`${LOG_PREFIX} failed to set the media position`, err);
    }
}

// ready() waits this long for a pending play(), then routes past the element.
export const ELEMENT_START_TIMEOUT_MS = 1000;

const ELEMENT_CLASS = 'gaplessPlayerAudio';

// The output whose stream the shared element plays.
let elementOwner: MediaElementOutput | null = null;

/**
 * One hidden element in the DOM for the page's lifetime, like the stock
 * player's: Plasma Browser Integration forgets the page's media session
 * actions (next/previous, play) when its element leaves the DOM and never
 * asks for them again.
 */
function sharedElement(): HTMLAudioElement {
    let element = document.querySelector<HTMLAudioElement>(`audio.${ELEMENT_CLASS}`);
    if (!element) {
        element = new Audio();
        element.classList.add(ELEMENT_CLASS);
        element.hidden = true;
        document.body.appendChild(element);
    }
    return element;
}

/**
 * Plays an AudioContext's output through a hidden <audio> element.
 * Browsers register a page with the OS media session (media keys, MPRIS,
 * lock screen) and derive its playing/paused state only from media elements;
 * Web Audio output alone never qualifies, so without this the session's
 * action handlers are unreachable. Falls back to the context's destination
 * when the browser lacks the API or does not play the element, so audio never
 * depends on it.
 *
 * The route only changes in ready(), which the player awaits before it
 * schedules audio, so a play() settling late never switches it mid-track.
 */
export class MediaElementOutput {
    private readonly _destination: AudioNode;
    private readonly _streamNode: MediaStreamAudioDestinationNode | null = null;
    private readonly _element: HTMLAudioElement | null = null;
    private _viaElement: boolean;
    // Set once a play() of ours took effect, cleared by our own pause: a
    // 'pause' event while set comes from the browser.
    private _playing = false;
    // The pending play(): settles true when the element plays, false on any
    // failure. Our own pause or dispose drops it.
    private _starting: Promise<boolean> | null = null;
    // ready()'s deadline for the pending play(), shared by concurrent calls.
    private _startDeadline: { starting: Promise<boolean>; expired: Promise<void> } | null = null;
    private _disposed = false;
    private _refusalLogged = false;
    // 'pause' events our pause() queued that were not dispatched yet.
    private _queuedPauses = 0;
    private readonly _pauseListener = (): void => {
        this._queuedPauses = Math.max(0, this._queuedPauses - 1);
        if (!this._disposed) {
            this._onElementPause();
        } else if (this._queuedPauses === 0) {
            this._release();
        }
    };

    constructor(context: AudioContext, private readonly _input: AudioNode, private readonly _onExternalPause: () => void) {
        this._destination = context.destination;
        if (typeof context.createMediaStreamDestination === 'function' && typeof Audio === 'function') {
            try {
                const streamNode = context.createMediaStreamDestination();
                const element = sharedElement();
                // Frees the previous owner's listener early; its events are
                // cancelled by the new source, and _release() checks ownership.
                elementOwner?._detach();
                elementOwner = this;
                element.srcObject = streamNode.stream;
                element.addEventListener('pause', this._pauseListener);
                this._streamNode = streamNode;
                this._element = element;
            } catch (err) {
                console.warn(`${LOG_PREFIX} media element output unavailable`, err);
            }
        }
        this._viaElement = this._streamNode != null;
        _input.connect(this._streamNode ?? this._destination);
    }

    start(): void {
        const element = this._element;
        if (!element || this._disposed || this._starting || !element.paused) {
            return;
        }
        const starting: Promise<boolean> = element.play().then(() => true, (err: unknown) => {
            if (this._starting === starting && !this._refusalLogged) {
                this._refusalLogged = true;
                console.warn(`${LOG_PREFIX} media element did not play; using direct output`, err);
            }
            return false;
        }).then((played) => {
            if (this._starting === starting) {
                this._starting = null;
                this._playing = played;
            }
            return played;
        });
        this._starting = starting;
    }

    /**
     * Settles the route before audio is scheduled: through the element once it
     * plays (the stream is live, so audio rendered before would be lost),
     * otherwise past it. Waits for a pending play() until
     * ELEMENT_START_TIMEOUT_MS after the first ready() for it. Never rejects.
     */
    async ready(): Promise<void> {
        const starting = this._starting;
        if (starting) {
            await Promise.race([starting, this._deadlineFor(starting)]);
        }
        if (!this._disposed) {
            this._route(this._playing);
        }
    }

    private _deadlineFor(starting: Promise<boolean>): Promise<void> {
        if (this._startDeadline?.starting !== starting) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expired = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ELEMENT_START_TIMEOUT_MS);
            });
            void starting.then(() => clearTimeout(timer));
            this._startDeadline = { starting, expired };
        }
        return this._startDeadline.expired;
    }

    pause(): void {
        this._playing = false;
        this._starting = null;
        if (this._element && !this._element.paused) {
            this._queuedPauses++;
            this._element.pause();
        }
    }

    /** Releases the element; emptying it ends its OS media session playback. */
    dispose(): void {
        this._disposed = true;
        this.pause();
        this._input.disconnect();
        // Clearing the source cancels queued 'pause' events, which Plasma
        // Browser Integration needs to leave the playing state: the last one
        // releases it instead.
        if (this._queuedPauses === 0) {
            this._release();
        }
    }

    private _release(): void {
        this._detach();
        if (elementOwner === this && this._element) {
            elementOwner = null;
            this._element.srcObject = null;
        }
    }

    private _detach(): void {
        this._element?.removeEventListener('pause', this._pauseListener);
    }

    private _route(viaElement: boolean): void {
        if (!this._streamNode || viaElement === this._viaElement) {
            return;
        }
        this._input.disconnect();
        this._input.connect(viaElement ? this._streamNode : this._destination);
        this._viaElement = viaElement;
    }

    private _onElementPause(): void {
        // The event is queued: a play() of ours since then left the element playing.
        if (this._playing && this._element?.paused && !this._disposed) {
            this._playing = false;
            this._onExternalPause();
        }
    }
}
