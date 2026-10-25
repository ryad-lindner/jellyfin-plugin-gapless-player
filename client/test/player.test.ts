import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { START_LEAD_SEC, createHarness, disposeAll, flush, holdDecode, holdFetch, track } from './fakes';

const TICKS_PER_MS = 10_000;

afterEach(disposeAll);

async function playAlbum(h: ReturnType<typeof createHarness>, items: ReturnType<typeof track>[], startIndex = 0): Promise<void> {
    void h.player.play({ items, startIndex });
    await flush();
}

function itemId(h: ReturnType<typeof createHarness>, id: string): string {
    return h.player.getPlaylistSync().find(i => i.Id === id)?.PlaylistItemId as string;
}

test('gapless boundary schedules the next track at the exact end and pairs reports', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    const [a] = h.ctx().live('A');
    const [b] = h.ctx().live('B');
    assert.ok(b, 'B is scheduled before A ends');
    assert.equal(b.startedAt, a.endsAt);

    await h.ctx().advance(121);
    assert.deepEqual(h.ctx().audible(), ['B']);
    await h.ctx().advance(90);

    assert.deepEqual(h.log(), ['start A', 'stop A@120000>B', 'start B', 'stop B@90000>-']);
});

test('next reports the interrupted position and starts the next item once', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    await h.ctx().advance(30 + START_LEAD_SEC);

    void h.player.nextTrack();
    await flush();

    assert.deepEqual(h.log(), ['start A', 'stop A@30000>B', 'start B']);
    assert.deepEqual(h.ctx().audible(), ['B']);
});

test('previous within 3 s goes to the previous item', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)], 1);
    await h.ctx().advance(1 + START_LEAD_SEC);

    void h.player.previousTrack();
    await flush();

    assert.deepEqual(h.log(), ['start B', 'stop B@1000>A', 'start A']);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('stop(true) reports the playing item once and ends the session', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    await h.ctx().advance(10 + START_LEAD_SEC);

    await h.player.stop(true);
    await h.ctx().advance(200);

    assert.deepEqual(h.log(), ['start A', 'stop A@10000>-']);
    assert.equal(h.destroyed(), true);
});

test('album switch reports the replaced item before the stream state is cleared', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    await h.ctx().advance(42 + START_LEAD_SEC);

    await h.switchTo([track('C', 100), track('D', 100)]);

    assert.equal(h.destroyed(), false);
    assert.deepEqual(h.log(), ['start A', 'stop A@42000>A', 'start C']);
    assert.deepEqual(h.ctx().audible(), ['C']);
});

test('pause during the initial load stays silent until unpause', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    assert.equal(h.player.paused(), false);

    h.player.pause();
    assert.equal(h.player.paused(), true);
    release();
    await flush();
    assert.deepEqual(h.ctx().audible(), []);

    void h.player.unpause();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.deepEqual(h.log(), ['start A']);
});

test('pause while next is still downloading stays silent until unpause', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90), track('C', 90)]);
    await h.ctx().advance(20 + START_LEAD_SEC);
    const release = holdFetch('C');

    void h.player.setCurrentPlaylistItem(itemId(h, 'C'));
    await flush();
    h.player.pause();
    release();
    await flush();
    await h.ctx().advance(5);
    assert.deepEqual(h.ctx().audible(), []);
    assert.equal(h.player.currentTime(), 0);

    void h.player.unpause();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['C']);
    assert.deepEqual(h.log(), ['start A', 'stop A@20000>C', 'start C']);
});

test('seek during the initial load starts at the seek target', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    void h.player.seek(30_000 * TICKS_PER_MS);
    release();
    await flush();
    await h.ctx().advance(1 + START_LEAD_SEC);

    assert.equal(Math.round(h.player.currentTime()), 31_000);
    assert.equal(h.ctx().live('A')[0].offset, 30);
    assert.deepEqual(h.log(), ['start A']);
});

test('undecodable first track hands off once and the player switch stays silent', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120, { undecodable: true }), track('B', 90)]);

    assert.equal(h.handoffs.length, 1);
    assert.deepEqual(h.handoffs[0].items.map(i => [i.Id, i.GaplessFallback]), [['A', true], ['B', true]]);
    assert.equal(h.destroyed(), true);
    assert.deepEqual(h.log(), ['start A', 'stop A@0>A']);
});

test('pause during an undecodable load hands off only on unpause', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120, { undecodable: true }), track('B', 90)]);
    h.player.pause();
    release();
    await flush();
    assert.equal(h.handoffs.length, 0);

    void h.player.unpause();
    await flush();

    assert.equal(h.handoffs.length, 1);
    assert.deepEqual(h.log(), ['start A', 'stop A@0>A']);
});

test('next onto an undecodable track reports the old item and hands off once', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90, { undecodable: true }), track('C', 90)]);
    await h.ctx().advance(20 + START_LEAD_SEC);

    void h.player.nextTrack();
    await flush();

    assert.equal(h.handoffs.length, 1);
    assert.deepEqual(h.handoffs[0].items.map(i => i.Id), ['B', 'C']);
    assert.equal(h.destroyed(), true);
    assert.deepEqual(h.log(), ['start A', 'stop A@20000>B']);
});

test('stop while the initial decode is still running ignores its late result', async () => {
    const h = createHarness();
    const release = holdDecode('A');
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    await h.player.stop(true);
    release();
    await flush();

    assert.deepEqual(h.ctx().sources.filter(s => s.playing), []);
    assert.equal(h.handoffs.length, 0);
    assert.deepEqual(h.log(), ['start A', 'stop A@0>-']);
});

test('removing the loading item starts its successor and ignores the late decode', async () => {
    const h = createHarness();
    const release = holdDecode('A');
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    await h.player.removeFromPlaylist(itemId(h, 'A'));
    await flush();
    release();
    await flush();

    assert.deepEqual(h.log(), ['start A', 'stop A@0>B', 'start B']);
    assert.deepEqual(h.ctx().sources.filter(s => s.playing).map(s => s.buffer?.id), ['B']);
    assert.equal(h.handoffs.length, 0);
});

test('position does not count the download time of a start', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90), track('C', 90)]);
    const release = holdFetch('C');

    void h.player.setCurrentPlaylistItem(itemId(h, 'C'));
    await flush();
    await h.ctx().advance(3);
    assert.equal(Math.round(h.player.currentTime()), 0);

    release();
    await flush();
    await h.ctx().advance(1 + START_LEAD_SEC);
    assert.equal(Math.round(h.player.currentTime()), 1000);
});

test('removing the current last track reports its real position', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 120)], 1);
    await h.ctx().advance(60 + START_LEAD_SEC);

    await h.player.removeFromPlaylist(itemId(h, 'B'));
    await flush();

    assert.deepEqual(h.log(), ['start B', 'stop B@60000>A', 'start A']);
});

test('missed boundary recovers in place with a frozen position', async () => {
    const h = createHarness();
    const release = holdFetch('B');
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    await h.ctx().advance(125);
    assert.deepEqual(h.log(), ['start A', 'stop A@120000>B']);
    assert.equal(h.player.currentTime(), 0);

    release();
    await flush();
    assert.deepEqual(h.log(), ['start A', 'stop A@120000>B', 'start B']);
    assert.deepEqual(h.ctx().audible(), ['B']);
});

test('stop during boundary recovery cancels the awaited item at 0', async () => {
    const h = createHarness();
    holdFetch('B');
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    await h.ctx().advance(125);

    await h.player.stop(true);

    assert.deepEqual(h.log(), ['start A', 'stop A@120000>B', 'stop B@0>-']);
});

test('RepeatOne restarts the track at its end', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 60), track('B', 90)]);
    h.player.setRepeatMode('RepeatOne');

    await h.ctx().advance(61);

    assert.deepEqual(h.log(), ['start A', 'stop A@60000>A', 'start A']);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('RepeatAll wraps from the last track to the first', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 60), track('B', 60)], 1);
    h.player.setRepeatMode('RepeatAll');
    await flush();

    await h.ctx().advance(61);

    assert.deepEqual(h.log(), ['start B', 'stop B@60000>A', 'start A']);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('queue edit during the initial load still starts the item once', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    h.player.queueNext([track('X', 60)]);
    release();
    await flush();

    assert.deepEqual(h.log(), ['start A']);
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(h.handoffs.length, 0);
});

test('stop after a seek reports the position rounded to whole milliseconds', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    await h.ctx().advance(5 + START_LEAD_SEC);

    void h.player.seek(50_000 * TICKS_PER_MS);
    await flush();
    await h.ctx().advance(2.0004 + START_LEAD_SEC);
    await h.player.stop(true);

    assert.deepEqual(h.log(), ['start A', 'stop A@52000>-']);
});
