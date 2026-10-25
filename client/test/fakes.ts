/**
 * Test doubles for driving the real player in Node: a Web Audio context with a
 * manual clock, gated fetches and decodes, and an events/playbackManager pair
 * that mirrors stock jellyfin-web's handling of a self-managed player.
 */
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
}

const tracks = new Map<string, Track>();

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
    const body = new TextEncoder().encode(id);
    return new Response(body, { headers: { 'Content-Length': String(body.byteLength) } });
}

/** The player schedules every start this far ahead of currentTime. */
export const START_LEAD_SEC = 0.05;

/** Web Audio delivers 'ended' after the render quantum that played the last frame. */
const ENDED_DELAY_SEC = 128 / 48_000;

export class FakeSource {
    buffer: { duration: number; id: string } | null = null;
    onended: (() => void) | null = null;
    startedAt: number | null = null;
    offset = 0;
    stopped = false;
    ended = false;

    connect(): void {}

    start(when = 0, offset = 0): void {
        this.startedAt = when;
        this.offset = offset;
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
        return (this.startedAt ?? 0) + (this.buffer?.duration ?? 0) - this.offset;
    }

    get playing(): boolean {
        return this.startedAt != null && !this.stopped && !this.ended;
    }
}

export class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    currentTime = 0;
    state = 'running';
    destination = {};
    sources: FakeSource[] = [];

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createGain(): { gain: { value: number }; connect(): void } {
        return { gain: { value: 1 }, connect() {} };
    }

    createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }

    async decodeAudioData(data: ArrayBuffer): Promise<{ duration: number; id: string }> {
        const id = new TextDecoder().decode(data);
        await decodeGates.get(id);
        const info = tracks.get(id);
        if (!info || info.undecodable) {
            throw new Error('Unable to decode audio data');
        }
        return { duration: info.durationSec, id };
    }

    resume(): Promise<void> {
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.state = 'closed';
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
    tracks.clear();
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
            const ctx = FakeAudioContext.instances.at(-1);
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
