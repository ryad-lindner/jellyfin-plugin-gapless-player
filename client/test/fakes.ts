/**
 * Test doubles for driving the real player in Node: a Web Audio context with a
 * manual clock, gated fetches and decodes, and an events/playbackManager pair
 * that mirrors stock jellyfin-web's handling of a self-managed player.
 */
import { FlacChunker, probeFlac } from '../src/flac';
import WebAudioGaplessPlayer from '../src/plugin';

export interface TestItem {
    Id: string;
    Name: string;
    MediaType: 'Audio';
    RunTimeTicks: number;
    Url: string;
    ServerId: string;
    PlaylistItemId?: string;
    GaplessFallback?: boolean;
}

interface Track {
    durationSec: number;
    undecodable: boolean;
    flac?: FlacTrack;
}

interface FlacTrack {
    bytes: Uint8Array;
    sampleRate: number;
    /** Extra samples the fake decoder adds to every chunk (a padding decoder). */
    padSamples: number;
}

const tracks = new Map<string, Track>();
// FLAC tracks carry their number in STREAMINFO's minimum frame size, which
// chunk files keep, so the fake decoder knows which track a chunk belongs to.
const flacIds: string[] = [];

export function track(id: string, durationSec: number, { undecodable = false } = {}): TestItem {
    tracks.set(id, { durationSec, undecodable });
    return {
        Id: id,
        Name: id,
        MediaType: 'Audio',
        RunTimeTicks: durationSec * 10_000_000,
        Url: `https://jf.test/Audio/${id}/stream`,
        ServerId: 'server'
    };
}

function crc8(bytes: number[]): number {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

/** FLAC's UTF-8-style number coding: 1 byte up to 7 bits, then 5 * length + 1 bits. */
function codedNumber(n: number): number[] {
    if (n < 0x80) {
        return [n];
    }
    let length = 2;
    while (n >= 2 ** (5 * length + 1)) {
        length++;
    }
    const bytes: number[] = [];
    for (let i = 1; i < length; i++) {
        bytes.unshift(0x80 | (n & 0x3f));
        n = Math.floor(n / 64);
    }
    bytes.unshift(((0xff00 >> length) & 0xff) | n);
    return bytes;
}

/**
 * A FLAC stream of fake frames: valid frame headers (CRC-8, frame numbers),
 * payload bytes that never form a sync code. Only the fake decoder reads it.
 */
export function flacTrack(id: string, durationSec: number, {
    sampleRate = 48_000,
    blockSize = 4096,
    frameBytes = 1024,
    padSamples = 0,
    variableBlocks = false,
    // STREAMINFO's total when it should differ from the frames actually sent.
    declaredSec = durationSec,
    pictureBytes = 0
} = {}): TestItem {
    const item = track(id, durationSec);
    const totalSamples = Math.round(durationSec * sampleRate);
    const declaredSamples = Math.round(declaredSec * sampleRate);
    flacIds.push(id);
    const tag = flacIds.length;

    const streamInfo = new Uint8Array(34);
    streamInfo.set([blockSize >> 8, blockSize & 0xff, blockSize >> 8, blockSize & 0xff]);
    streamInfo.set([(tag >> 16) & 0xff, (tag >> 8) & 0xff, tag & 0xff], 4);
    // 20-bit rate, 3-bit channels - 1 (stereo), 5-bit bits - 1 (16), 36-bit total.
    streamInfo[10] = (sampleRate >> 12) & 0xff;
    streamInfo[11] = (sampleRate >> 4) & 0xff;
    streamInfo[12] = ((sampleRate & 0x0f) << 4) | (1 << 1);
    streamInfo[13] = (15 << 4) | Math.floor(declaredSamples / 2 ** 32);
    streamInfo[14] = (declaredSamples >>> 24) & 0xff;
    streamInfo[15] = (declaredSamples >>> 16) & 0xff;
    streamInfo[16] = (declaredSamples >>> 8) & 0xff;
    streamInfo[17] = declaredSamples & 0xff;

    const parts: number[] = [0x66, 0x4c, 0x61, 0x43, pictureBytes ? 0 : 0x80, 0, 0, 34, ...streamInfo];
    if (pictureBytes) {
        // A PICTURE block (type 6) as the last metadata block.
        parts.push(0x86, (pictureBytes >> 16) & 0xff, (pictureBytes >> 8) & 0xff, pictureBytes & 0xff);
        for (let i = 0; i < pictureBytes; i++) {
            parts.push(0x11);
        }
    }
    const payload = new Array<number>(frameBytes).fill(0x5a);
    for (let frame = 0, sample = 0; sample < totalSamples; frame++, sample += blockSize) {
        const size = Math.min(blockSize, totalSamples - sample);
        // Block size code 7: 16-bit size - 1 after the frame (or, with
        // variable blocks, sample) number.
        const number = variableBlocks ? sample : frame;
        const header = [0xff, variableBlocks ? 0xf9 : 0xf8, 0x70, 0x10, ...codedNumber(number), (size - 1) >> 8, (size - 1) & 0xff];
        parts.push(...header, crc8(header), ...payload);
    }

    tracks.set(id, { durationSec, undecodable: false, flac: { bytes: Uint8Array.from(parts), sampleRate, padSamples } });
    return item;
}

const STREAM_PART_BYTES = 64 * 1024;

interface Throttle {
    limit: number;
    failed: boolean;
    wake: (() => void) | null;
}

const throttles = new Map<string, Throttle>();

/**
 * Delivers only the first `bytes` of a FLAC track's download until send()
 * releases more; fail() breaks the connection.
 */
export function throttle(id: string, bytes: number): { send(more?: number): void; fail(): void } {
    const state: Throttle = { limit: bytes, failed: false, wake: null };
    throttles.set(id, state);
    const wake = (): void => {
        const resolve = state.wake;
        state.wake = null;
        resolve?.();
    };
    return {
        send(more = Infinity) {
            state.limit += more;
            wake();
        },
        fail() {
            state.failed = true;
            wake();
        }
    };
}

/** Track ids in the order their downloads started. */
export const fetches: string[] = [];
/** Track ids whose FLAC download was aborted mid-stream. */
export const aborts: string[] = [];
/** Track ids whose FLAC download the player cancelled after reading enough. */
export const cancels: string[] = [];

/** The encoded bytes of a flacTrack(). */
export function flacBytes(id: string): Uint8Array {
    const flac = tracks.get(id)?.flac;
    if (!flac) {
        throw new Error(`${id} is not a FLAC track`);
    }
    return flac.bytes;
}

/** Lets pending promise chains (fetch, decode, start) run to completion. */
export async function flush(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function gate(map: Map<string, Promise<void>>, id: string): () => void {
    let release!: () => void;
    map.set(id, new Promise<void>(resolve => {
        release = () => {
            map.delete(id);
            resolve();
        };
    }));
    return release;
}

const fetchGates = new Map<string, Promise<void>>();
const decodeGates = new Map<string, Promise<void>>();

/** Holds downloads of this track until release(); an abort rejects them. */
export function holdFetch(id: string): () => void {
    return gate(fetchGates, id);
}

/** Holds decodes of this track until release(); like decodeAudioData, not abortable. */
export function holdDecode(id: string): () => void {
    return gate(decodeGates, id);
}

function abortError(): Error {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
}

async function fakeFetch(url: string, init?: { signal?: AbortSignal }): Promise<Response> {
    const id = /\/Audio\/([^/]+)\//.exec(url)?.[1] ?? '';
    const held = fetchGates.get(id);
    if (held) {
        await new Promise<void>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()));
            held.then(resolve);
        });
    }
    if (init?.signal?.aborted) {
        throw abortError();
    }
    fetches.push(id);
    const flac = tracks.get(id)?.flac;
    if (flac) {
        return new Response(flacBody(id, flac.bytes, init?.signal), {
            headers: { 'Content-Length': String(flac.bytes.byteLength) }
        });
    }
    const body = new TextEncoder().encode(id);
    return new Response(body, { headers: { 'Content-Length': String(body.byteLength) } });
}

function flacBody(id: string, bytes: Uint8Array, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const state = throttles.get(id) ?? { limit: Infinity, failed: false, wake: null };
    let sent = 0;
    let aborted = false;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            signal?.addEventListener('abort', () => {
                aborted = true;
                aborts.push(id);
                controller.error(abortError());
                state.wake?.();
            });
        },
        async pull(controller) {
            while (sent < bytes.length && sent >= state.limit && !state.failed && !aborted) {
                await new Promise<void>(resolve => {
                    state.wake = resolve;
                });
            }
            if (aborted) {
                return;
            }
            if (state.failed) {
                controller.error(new TypeError('network error'));
                return;
            }
            if (sent >= bytes.length) {
                controller.close();
                return;
            }
            const end = Math.min(bytes.length, sent + STREAM_PART_BYTES, state.limit);
            controller.enqueue(bytes.slice(sent, end));
            sent = end;
        },
        cancel() {
            cancels.push(id);
        }
    });
}

/** The player schedules every start this far ahead of currentTime. */
export const START_LEAD_SEC = 0.05;

/** Web Audio delivers 'ended' after the render quantum that played the last frame. */
const ENDED_DELAY_SEC = 128 / 48_000;

export interface FakeBuffer {
    duration: number;
    id: string;
    length?: number;
    sampleRate?: number;
}

export class FakeSource {
    buffer: FakeBuffer | null = null;
    onended: (() => void) | null = null;
    startedAt: number | null = null;
    offset = 0;
    duration: number | null = null;
    stopped = false;
    ended = false;

    connect(): void {}

    start(when = 0, offset = 0, duration?: number): void {
        this.startedAt = when;
        this.offset = offset;
        this.duration = duration ?? null;
    }

    stop(): void {
        if (this.stopped || this.ended) {
            return;
        }
        this.stopped = true;
        // Real sources fire 'ended' after stop() too, read at dispatch time.
        setImmediate(() => this.onended?.());
    }

    get endsAt(): number {
        return (this.startedAt ?? 0) + (this.duration ?? (this.buffer?.duration ?? 0) - this.offset);
    }

    get playing(): boolean {
        return this.startedAt != null && !this.stopped && !this.ended;
    }
}

export class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    /** The device rate a context gets without (or ignoring) a sampleRate option. */
    static defaultSampleRate = 48_000;
    /** False: like a browser that ignores the sampleRate option. */
    static honorsSampleRate = true;
    /** True: a context created with a sampleRate stays suspended (no user gesture). */
    static rateContextsStaySuspended = false;
    currentTime = 0;
    state = 'running';
    destination = {};
    sources: FakeSource[] = [];
    readonly sampleRate: number;

    constructor(options?: { sampleRate?: number }) {
        this.sampleRate = (FakeAudioContext.honorsSampleRate && options?.sampleRate) || FakeAudioContext.defaultSampleRate;
        FakeAudioContext.instances.push(this);
        if (options?.sampleRate && FakeAudioContext.rateContextsStaySuspended) {
            this.suspendUntilReleased();
        }
    }

    createGain(): { gain: { value: number }; connect(): void } {
        return { gain: { value: 1 }, connect() {} };
    }

    createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }

    async decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
        const bytes = new Uint8Array(data);
        const probe = probeFlac(bytes);
        if (probe.kind === 'flac') {
            const info = probe.header.streamInfo;
            const id = flacIds[((info[4] << 16) | (info[5] << 8) | info[6]) - 1];
            await decodeGates.get(id);
            const flac = tracks.get(id)?.flac;
            if (!flac) {
                throw new Error('Unable to decode audio data');
            }
            const chunker = new FlacChunker(probe.header);
            chunker.push(bytes.subarray(probe.header.firstFrame));
            const length = (chunker.take(0, true)?.samples ?? 0) + flac.padSamples;
            return { duration: length / flac.sampleRate, id, length, sampleRate: flac.sampleRate };
        }
        const id = new TextDecoder().decode(data);
        await decodeGates.get(id);
        const info = tracks.get(id);
        if (!info || info.undecodable) {
            throw new Error('Unable to decode audio data');
        }
        return { duration: info.durationSec, id };
    }

    private resumeGate: Promise<void> | null = null;
    /** Releases the latest suspendUntilReleased(). */
    releaseResume: (() => void) | null = null;

    /** Suspends the context; resume() then waits until release() (e.g. a mobile background interruption). */
    suspendUntilReleased(state: 'suspended' | 'interrupted' = 'suspended'): () => void {
        this.state = state;
        let release!: () => void;
        const resumeGate: Promise<void> = new Promise<void>(resolve => {
            release = () => {
                if (this.resumeGate === resumeGate) {
                    this.resumeGate = null;
                }
                resolve();
            };
        });
        this.resumeGate = resumeGate;
        this.releaseResume = release;
        return release;
    }

    async resume(): Promise<void> {
        if (this.state === 'closed') {
            throw new DOMException('Cannot resume a closed AudioContext', 'InvalidStateError');
        }
        await this.resumeGate;
        if (this.state === 'closed') {
            // Like browsers, a resume pending while the context closes rejects.
            throw new DOMException('The AudioContext was closed', 'InvalidStateError');
        }
        this.state = 'running';
    }

    close(): Promise<void> {
        this.state = 'closed';
        this.releaseResume?.();
        return Promise.resolve();
    }

    /** Live (started, not stopped or ended) sources of a track. */
    live(id: string): FakeSource[] {
        return this.sources.filter(s => s.playing && s.buffer?.id === id);
    }

    /** Tracks audible now or within the player's start lead. */
    audible(): string[] {
        return this.sources
            .filter(s => s.playing && (s.startedAt ?? 0) <= this.currentTime + START_LEAD_SEC + 1e-6 && s.endsAt > this.currentTime)
            .map(s => s.buffer?.id ?? '?');
    }

    /** Moves the clock forward, firing 'ended' in end order, one quantum late. */
    async advance(seconds: number): Promise<void> {
        if (this.state !== 'running') {
            throw new Error(`advance() on a ${this.state} AudioContext: its clock is frozen`);
        }
        const target = this.currentTime + seconds;
        for (;;) {
            const next = this.sources
                .filter(s => s.playing && s.endsAt + ENDED_DELAY_SEC <= target)
                .sort((a, b) => a.endsAt - b.endsAt)[0];
            if (!next) {
                break;
            }
            this.currentTime = Math.max(this.currentTime, next.endsAt + ENDED_DELAY_SEC);
            next.ended = true;
            next.onended?.();
            await flush();
        }
        this.currentTime = target;
        await flush();
    }
}

export interface Report {
    type: 'start' | 'stop';
    id: string;
    positionMs?: number;
    next?: string | null;
}

type Handler = (...args: unknown[]) => void;

export interface Harness {
    player: WebAudioGaplessPlayer;
    reports: Report[];
    handoffs: { items: TestItem[]; startPositionTicks?: number }[];
    destroyed: () => boolean;
    ctx: () => FakeAudioContext;
    /** playbackManager.play() on the active player: stop(false), then play(). */
    switchTo: (items: TestItem[]) => Promise<void>;
    /** Report log as compact strings, e.g. "start A", "stop A@1000>B". */
    log: () => string[];
}

function installGlobals(): void {
    const g = globalThis as Record<string, unknown>;
    const storage = new Map<string, string>();
    g.window = Object.assign(globalThis, {
        AudioContext: FakeAudioContext,
        location: { href: 'https://jf.test/web/' }
    });
    g.document = { getElementById: () => null, hidden: false, hasFocus: () => true };
    g.localStorage = {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v)
    };
    g.fetch = fakeFetch;
}

const live: WebAudioGaplessPlayer[] = [];

/** Destroys every player a test created; their timers keep Node alive. */
export function disposeAll(): void {
    for (const player of live.splice(0)) {
        player.destroy();
    }
}

export function createHarness(): Harness {
    installGlobals();
    FakeAudioContext.instances = [];
    FakeAudioContext.defaultSampleRate = 48_000;
    FakeAudioContext.honorsSampleRate = true;
    FakeAudioContext.rateContextsStaySuspended = false;
    tracks.clear();
    flacIds.length = 0;
    throttles.clear();
    fetches.length = 0;
    aborts.length = 0;
    cancels.length = 0;
    fetchGates.clear();
    decodeGates.clear();

    const handlers = new Map<unknown, Map<string, Handler[]>>();
    const reports: Report[] = [];
    const handoffs: Harness['handoffs'] = [];
    let destroyed = false;
    // playbackManager's per-player stream state: set by itemstarted, nulled
    // by onPlaybackChanging; its itemstopped handler dereferences it.
    let streamInfo: { ended?: boolean } | null = null;

    const events = {
        on(target: unknown, name: string, handler: Handler): void {
            const byName = handlers.get(target) ?? new Map<string, Handler[]>();
            handlers.set(target, byName);
            byName.set(name, [...(byName.get(name) ?? []), handler]);
        },
        off(target: unknown, name: string, handler: Handler): void {
            const list = handlers.get(target)?.get(name) ?? [];
            handlers.get(target)?.set(name, list.filter(h => h !== handler));
        },
        trigger(target: unknown, name: string, args: unknown[] = []): void {
            for (const handler of handlers.get(target)?.get(name) ?? []) {
                handler({ type: name }, ...args);
            }
        }
    };

    let player!: WebAudioGaplessPlayer;
    const playbackManager = {
        // A handoff item is not claimable by the gapless player, so stock
        // switches players: onPlaybackChanging calls stop(true) on it.
        async play(options: unknown): Promise<unknown> {
            const request = options as Harness['handoffs'][number] & { startIndex?: number };
            handoffs.push(request);
            await Promise.resolve();
            // Stock rebuilds the play options (dropping enableWebAudioGapless),
            // so only the item's GaplessFallback mark keeps it from this player.
            if (!player.canPlayItem(request.items[request.startIndex ?? 0] as never, {})) {
                await player.stop(true);
                streamInfo = null;
                destroyed = true;
            }
            return undefined;
        }
    };

    const settings = new Map<string, string>();
    player = new WebAudioGaplessPlayer({
        events,
        appSettings: { get: k => settings.get(k), set: (k, v) => settings.set(k, v) },
        playbackManager,
        appHost: {}
    });
    live.push(player);

    events.on(player, 'itemstarted', (_e, item) => {
        streamInfo = {};
        reports.push({ type: 'start', id: (item as TestItem).Id });
    });
    // Mirrors onPlaybackStoppedFromSelfManagingPlayer. getPlayer() is reduced
    // to canPlayItem: nothing outranks the gapless player for audio it claims.
    events.on(player, 'itemstopped', (_e, info) => {
        const stop = info as { item: TestItem; positionMs: number; nextItem: { item: TestItem } | null };
        if (!streamInfo) {
            throw new TypeError("Cannot set properties of null (setting 'ended')");
        }
        streamInfo.ended = true;
        const next = stop.nextItem?.item ?? null;
        reports.push({ type: 'stop', id: stop.item.Id, positionMs: stop.positionMs, next: next?.Id ?? null });
        if (!next || !player.canPlayItem(next as never, {})) {
            destroyed = true;
            player.destroy();
        }
    });

    return {
        player,
        reports,
        handoffs,
        destroyed: () => destroyed,
        ctx: () => {
            // A context the player tried and discarded is closed; skip it.
            const ctx = FakeAudioContext.instances.filter(c => c.state !== 'closed').at(-1)
                ?? FakeAudioContext.instances.at(-1);
            if (!ctx) {
                throw new Error('no AudioContext created');
            }
            return ctx;
        },
        switchTo: async (items) => {
            await player.stop(false);
            streamInfo = null;
            void player.play({ items });
            await flush();
        },
        log: () => reports.map(r => r.type === 'start'
            ? `start ${r.id}`
            : `stop ${r.id}@${r.positionMs}>${r.next ?? '-'}`)
    };
}
