import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { FakeAudioContext, type FakeSource, START_LEAD_SEC, aborts, createHarness, disposeAll, fetches, flacTrack, flush, holdFetch, throttle, track } from './fakes';

const TICKS_PER_MS = 10_000;
// Enough for the first chunk (256 KB) of a fake FLAC track, about 21 s of audio.
const FIRST_CHUNK_DOWNLOAD = 300_000;

afterEach(disposeAll);

async function playAlbum(h: ReturnType<typeof createHarness>, items: ReturnType<typeof track>[]): Promise<void> {
    void h.player.play({ items });
    await flush();
}

function sourcesOf(h: ReturnType<typeof createHarness>, id: string): FakeSource[] {
    return h.ctx().sources
        .filter(s => s.buffer?.id === id && !s.stopped)
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function assertBackToBack(sources: FakeSource[]): void {
    for (let i = 1; i < sources.length; i++) {
        assert.ok(Math.abs((sources[i].startedAt ?? 0) - sources[i - 1].endsAt) < 1e-9,
            `chunk ${i} starts where chunk ${i - 1} ends`);
    }
}

test('progressive FLAC starts after the first chunk and plays the chunks back to back', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);

    assert.deepEqual(h.ctx().audible(), ['A'], 'A plays before its download completes');
    assert.deepEqual(fetches, ['A'], 'B waits for the download of A');
    const [buffered] = h.player.getBufferedRanges();
    assert.ok(buffered.end > 0 && buffered.end < 180 * 1000 * TICKS_PER_MS);

    download.send();
    await flush();
    const chunks = sourcesOf(h, 'A');
    assert.ok(chunks.length > 2);
    assertBackToBack(chunks);
    assert.ok(Math.abs(chunks.at(-1)!.endsAt - (chunks[0].startedAt! + 180)) < 1e-9, 'the chunks add up to the track');
    assert.deepEqual(h.player.getBufferedRanges(), [{ start: 0, end: 180 * 1000 * TICKS_PER_MS }]);
    assert.deepEqual(fetches, ['A', 'B']);

    const [b] = h.ctx().live('B');
    assert.ok(b, 'B is scheduled before A ends');
    assert.ok(Math.abs(b.startedAt! - chunks.at(-1)!.endsAt) < 1e-9);
    await h.ctx().advance(181);
    assert.deepEqual(h.ctx().audible(), ['B']);
    assert.deepEqual(h.log(), ['start A', 'stop A@180000>B', 'start B']);
});

test('a FLAC queue at another sample rate moves to a context at that rate', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)]);

    const [first, second] = FakeAudioContext.instances;
    assert.equal(first.state, 'closed');
    assert.equal(second.sampleRate, 44_100);
    assert.equal(h.ctx(), second);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('a browser that ignores the sampleRate option decodes the whole file first', async () => {
    const h = createHarness();
    FakeAudioContext.honorsSampleRate = false;
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)]);

    assert.deepEqual(h.ctx().audible(), []);
    download.send();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(sourcesOf(h, 'A').length, 1, 'one source for the whole track');
    assert.equal(h.ctx().sampleRate, 48_000);
});

test('a decoder that pads chunks falls back to the full-file decode', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 60, { padSamples: 1 }), track('B', 90)]);

    assert.deepEqual(h.ctx().audible(), []);
    download.send();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(sourcesOf(h, 'A').length, 1);
});

test('a download that falls behind freezes the position and resumes there', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);

    await h.ctx().advance(30);
    const stalledAt = h.player.currentTime();
    assert.ok(stalledAt > 20_000 && stalledAt < 25_000, `stalled at the end of the first chunk (${stalledAt})`);
    assert.deepEqual(h.ctx().audible(), []);
    await h.ctx().advance(5);
    assert.equal(h.player.currentTime(), stalledAt);

    download.send();
    await flush();
    await h.ctx().advance(1 + START_LEAD_SEC);
    assert.ok(Math.abs(h.player.currentTime() - (stalledAt + 1000)) < 1);
    assertBackToBack(h.ctx().live('A'));
    assert.deepEqual(h.log(), ['start A'], 'the stall is not reported as a stop');
});

test('a download that breaks mid-track hands off at the position where audio stopped', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);
    download.fail();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A'], 'the decoded part keeps playing');

    await h.ctx().advance(30);
    assert.equal(h.handoffs.length, 1);
    const stalledAtMs = (h.handoffs[0].startPositionTicks ?? 0) / TICKS_PER_MS;
    assert.ok(stalledAtMs > 20_000 && stalledAtMs < 25_000);
    assert.equal(h.handoffs[0].items[0].Id, 'A');
    assert.deepEqual(h.log(), ['start A', `stop A@${Math.round(stalledAtMs)}>A`]);
});

test('a seek past the decoded part waits for it, then starts at the target', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);

    void h.player.seek(100_000 * TICKS_PER_MS);
    await flush();
    assert.deepEqual(h.ctx().audible(), []);
    assert.equal(h.player.currentTime(), 100_000);

    download.send();
    await flush();
    await h.ctx().advance(1 + START_LEAD_SEC);
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.ok(Math.abs(h.player.currentTime() - 101_000) < 1);
    assert.deepEqual(h.log(), ['start A']);
});

test('stop during a progressive download leaves no sources behind', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);
    const ctx = h.ctx();

    await h.player.stop(true);
    assert.deepEqual(aborts, ['A']);
    const created = ctx.sources.length;
    download.send();
    await flush();
    assert.equal(ctx.sources.length, created);
    assert.deepEqual(ctx.audible(), []);
    assert.deepEqual(fetches, ['A']);
});

async function stallFirstChunk(h: ReturnType<typeof createHarness>, items: ReturnType<typeof track>[]): Promise<{ send(more?: number): void; stalledAt: number }> {
    const download = throttle(items[0].Id, FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, items);
    await h.ctx().advance(30);
    const stalledAt = h.player.currentTime();
    assert.deepEqual(h.ctx().audible(), [], 'stalled');
    return { send: download.send, stalledAt };
}

test('a stall restart does not loop while nothing new is decoded', async () => {
    const h = createHarness();
    // 1202-sample frames put the stall on a position that rounding through
    // milliseconds once moved onto the last decoded frame.
    throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 60, { blockSize: 1202 }), track('B', 90)]);
    await h.ctx().advance(7);
    const created = h.ctx().sources.length;
    const stalledAt = h.player.currentTime();

    await h.ctx().advance(2);
    assert.equal(h.ctx().sources.length, created);
    assert.equal(h.player.currentTime(), stalledAt);
});

test('pause and unpause during a stall resume at the stall position', async () => {
    const h = createHarness();
    const { send, stalledAt } = await stallFirstChunk(h, [flacTrack('A', 180), track('B', 90)]);

    h.player.pause();
    assert.equal(h.player.currentTime(), stalledAt);
    void h.player.unpause();
    await flush();
    assert.deepEqual(h.ctx().audible(), []);
    assert.equal(h.player.currentTime(), stalledAt);

    send();
    await flush();
    await h.ctx().advance(1 + START_LEAD_SEC);
    assert.ok(Math.abs(h.player.currentTime() - (stalledAt + 1000)) < 1);
    assert.deepEqual(h.log(), ['start A']);
});

test('next during a stall reports the stall position and stops the stalled download', async () => {
    const h = createHarness();
    const { stalledAt } = await stallFirstChunk(h, [flacTrack('A', 180), track('B', 90)]);

    void h.player.nextTrack();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['B']);
    assert.deepEqual(h.log(), ['start A', `stop A@${Math.round(stalledAt)}>B`, 'start B']);
    assert.deepEqual(aborts, ['A']);
});

test('a stall after the current item moved in the queue still resumes', async () => {
    const h = createHarness();
    const download = throttle('A', FIRST_CHUNK_DOWNLOAD);
    void h.player.play({ items: [track('B', 90), flacTrack('A', 180)], startIndex: 1 });
    await flush();
    const itemA = h.player.getPlaylistSync().find(i => i.Id === 'A')?.PlaylistItemId as string;
    h.player.movePlaylistItem(itemA, 0);

    await h.ctx().advance(30);
    const stalledAt = h.player.currentTime();
    assert.ok(stalledAt > 20_000 && stalledAt < 25_000);
    download.send();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.deepEqual(h.log(), ['start A']);
});

test('RepeatOne restarts a progressive track at its end', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 30), track('B', 90)]);
    h.player.setRepeatMode('RepeatOne');

    await h.ctx().advance(31);
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.deepEqual(h.log(), ['start A', 'stop A@30000>A', 'start A']);
});

test('a skip during the initial load schedules on the context it ends up with', async () => {
    const h = createHarness();
    holdFetch('A');
    void h.player.play({ items: [track('A', 120), flacTrack('B', 60, { sampleRate: 44_100 }), track('C', 90)] });
    await flush();
    // A context reused from an earlier queue has a running clock.
    h.ctx().currentTime = 1000;

    void h.player.nextTrack();
    await flush();
    assert.equal(h.ctx().sampleRate, 44_100);
    assert.deepEqual(h.ctx().audible(), ['B']);
    const [b] = h.ctx().live('B');
    assert.ok(b.startedAt! < h.ctx().currentTime + 1, `B starts on the new clock (${b.startedAt})`);
});

test('replacing a queue while its FLAC downloads does not preload for the new queue early', async () => {
    const h = createHarness();
    throttle('A', FIRST_CHUNK_DOWNLOAD);
    await playAlbum(h, [flacTrack('A', 180), track('B', 90)]);

    holdFetch('X');
    await h.switchTo([track('X', 120), track('Y', 90)]);
    await flush();
    assert.ok(!fetches.includes('Y'), `Y waits for the load of X (${fetches.join(',')})`);
});

test('a context at the new rate that does not start keeps the current one', async () => {
    const h = createHarness();
    FakeAudioContext.rateContextsStaySuspended = true;
    void h.player.play({ items: [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)] });
    await new Promise(resolve => setTimeout(resolve, 400));
    await flush();

    const [first, second] = FakeAudioContext.instances;
    assert.equal(second.state, 'closed');
    assert.equal(h.ctx(), first);
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(sourcesOf(h, 'A').length, 1, 'full-file decode at the device rate');
});

test('next then previous while the new-rate context starts plays the first item', async () => {
    const h = createHarness();
    FakeAudioContext.rateContextsStaySuspended = true;
    void h.player.play({ items: [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)] });
    await flush();

    void h.player.nextTrack();
    await flush();
    void h.player.previousTrack();
    await new Promise(resolve => setTimeout(resolve, 400));
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.deepEqual(h.handoffs, []);
});

test('a download that ends short of the STREAMINFO total hands off where it stops', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 40, { declaredSec: 60 }), track('B', 90)]);

    await h.ctx().advance(41);
    assert.equal(h.handoffs.length, 1);
    assert.ok(Math.abs((h.handoffs[0].startPositionTicks ?? 0) / TICKS_PER_MS - 40_000) < 1);
});

test('a stream longer than its STREAMINFO total is cut where the next item starts', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 31, { declaredSec: 30 }), track('B', 90)]);

    const chunks = sourcesOf(h, 'A');
    const [b] = h.ctx().live('B');
    assert.ok(Math.abs(chunks.at(-1)!.endsAt - (chunks[0].startedAt! + 30)) < 1e-9, 'A ends at the declared length');
    assert.ok(Math.abs(b.startedAt! - chunks.at(-1)!.endsAt) < 1e-9);
    await h.ctx().advance(30.5);
    assert.deepEqual(h.ctx().audible(), ['B']);
    assert.deepEqual(h.handoffs, []);
});

test('a skip that resumes the old context while the queue moves to a new one continues there', async () => {
    const h = createHarness();
    FakeAudioContext.rateContextsStaySuspended = true;
    void h.player.play({ items: [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)] });
    await flush();
    const [old, next] = FakeAudioContext.instances;
    old.suspendUntilReleased();

    void h.player.nextTrack();
    await flush();
    next.releaseResume?.();
    await flush();
    assert.equal(old.state, 'closed');
    assert.equal(h.ctx(), next);
    assert.deepEqual(h.ctx().audible(), ['B']);
    assert.deepEqual(h.handoffs, []);
});

test('metadata larger than the first reads still streams progressively', async () => {
    const h = createHarness();
    throttle('A', FIRST_CHUNK_DOWNLOAD + 200_000);
    await playAlbum(h, [flacTrack('A', 180, { pictureBytes: 200_000 }), track('B', 90)]);

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.ok(sourcesOf(h, 'A').length >= 1);
    assert.ok(h.player.getBufferedRanges()[0].end < 180 * 1000 * TICKS_PER_MS);
});
