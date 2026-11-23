import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { ELEMENT_START_TIMEOUT_MS, setMediaPosition } from '../src/mediaElementOutput';
import { FakeAudio, FakeAudioContext, type FakeGain, START_LEAD_SEC, createHarness, disposeAll, fetches, flacTrack, flush, holdFetch, mediaPositions, track } from './fakes';

const TICKS_PER_MS = 10_000;

afterEach(disposeAll);

type Harness = ReturnType<typeof createHarness>;

async function playAlbum(h: Harness, items: ReturnType<typeof track>[]): Promise<void> {
    void h.player.play({ items });
    await flush();
}

function element(): FakeAudio {
    const last = FakeAudio.instances.at(-1);
    assert.ok(last, 'an <audio> element was created');
    return last;
}

function gainOutput(h: Harness): unknown {
    const gain = (h.player as unknown as { _gainNode: FakeGain })._gainNode;
    assert.equal(gain.outputs.size, 1, 'the gain node feeds exactly one output');
    return [...gain.outputs][0];
}

test('playback runs through the media element so the OS media session sees it', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(element().playing, true);
    assert.equal(element().srcObject, h.ctx().streamDestination?.stream);
    assert.equal(gainOutput(h), h.ctx().streamDestination);
});

test('the element plays from the initial load on', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120)]);
    assert.equal(element().playing, true);

    release();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('the initial load downloads while the element play is pending', async () => {
    const h = createHarness();
    FakeAudio.holdPlay = true;
    await playAlbum(h, [track('A', 120)]);

    assert.deepEqual(fetches, ['A']);
    assert.deepEqual(h.ctx().audible(), []);
    element().releasePlay();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('pause pauses the element, and unpause schedules audio only once it plays', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    await h.ctx().advance(5 + START_LEAD_SEC);

    h.player.pause();
    await flush();
    assert.equal(element().paused, true);
    assert.equal(h.player.paused(), true);

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    assert.deepEqual(h.ctx().audible(), [], 'the live stream would drop audio before the element plays');

    element().releasePlay();
    await flush();
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(h.player.paused(), false);
});

test('pause then unpause before the queued pause event keeps playing', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);

    h.player.pause();
    void h.player.unpause();
    await flush();

    assert.equal(h.player.paused(), false);
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('pause while the element play is pending plays it again on unpause', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    await flush();

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    h.player.pause();
    await flush();
    assert.equal(element().paused, true);

    void h.player.unpause();
    await flush();
    element().releasePlay();
    await flush();
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('removing the target of a start waiting on the element leaves it paused', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90), track('C', 90)]);
    h.player.pause();
    await flush();

    FakeAudio.holdPlay = true;
    void h.player.nextTrack();
    await flush();
    await h.player.removeFromPlaylist(h.player.getPlaylistSync().find(i => i.Id === 'B')?.PlaylistItemId as string);
    await flush();

    assert.equal(h.player.paused(), true);
    assert.equal(element().paused, true);
    assert.deepEqual(h.ctx().audible(), []);
});

test('a play the browser aborts falls back to direct output', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    assert.deepEqual(h.ctx().audible(), []);

    element().abortPlay();
    await flush();

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);
});

test('seek while the element play is pending starts at the seek target once it plays', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    await flush();

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    h.player.seek(60_000 * TICKS_PER_MS);
    await flush();
    assert.deepEqual(h.ctx().audible(), []);

    element().releasePlay();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(Math.round(h.player.currentTime() / 1000), 60);
});

test('next while the element play is pending starts the next track once it plays', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90)]);
    h.player.pause();
    await flush();

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    void h.player.nextTrack();
    await flush();
    assert.deepEqual(h.ctx().audible(), []);

    element().releasePlay();
    await flush();
    assert.deepEqual(h.ctx().audible(), ['B']);
    assert.deepEqual(h.log(), ['start A', 'stop A@0>B', 'start B']);
});

test('a sample-rate switch while the element play is pending waits for it on the new context', async () => {
    const h = createHarness();
    FakeAudio.holdPlay = true;
    await playAlbum(h, [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)]);

    assert.equal(element().srcObject, h.ctx().streamDestination?.stream);
    assert.deepEqual(h.ctx().audible(), []);

    element().releasePlay();
    await flush();
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('pause during the initial load pauses the element', async () => {
    const h = createHarness();
    const release = holdFetch('A');
    await playAlbum(h, [track('A', 120)]);

    h.player.pause();
    release();
    await flush();
    assert.equal(element().paused, true);
    assert.deepEqual(h.ctx().audible(), []);

    void h.player.unpause();
    await flush();
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('seek while paused leaves the element paused', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();

    h.player.seek(60_000 * TICKS_PER_MS);
    await flush();

    assert.equal(h.player.paused(), true);
    assert.equal(element().paused, true);
});

test('a browser pause of the element pauses the player, and unpause restarts it', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    await h.ctx().advance(5 + START_LEAD_SEC);

    element().pause();
    await flush();
    assert.equal(h.player.paused(), true);
    assert.deepEqual(h.ctx().audible(), []);

    void h.player.unpause();
    await flush();
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('an album switch whose element play is refused keeps playing', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);

    FakeAudio.playRejection = 'NotAllowedError';
    await h.switchTo([track('C', 100)]);

    assert.equal(h.player.paused(), false, 'the queued pause of the switch is not taken for a browser pause');
    assert.deepEqual(h.ctx().audible(), ['C']);
    assert.equal(gainOutput(h), h.ctx().destination);
});

test('an album switch keeps the media element and its session', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    const audio = element();

    await h.switchTo([track('C', 100)]);

    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(audio.playing, true);
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.deepEqual(h.ctx().audible(), ['C']);
});

test('unpause after a failed handoff plays through a new output', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90, { undecodable: true }), track('C', 90)]);
    (h.player as unknown as { _playbackManager: { play: () => Promise<void> } })._playbackManager.play =
        () => Promise.reject(new Error('handoff failed'));

    void h.player.nextTrack();
    await flush();
    assert.equal(element().srcObject, null);

    void h.player.nextTrack();
    await flush();
    assert.equal(element().playing, true);
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.deepEqual(h.ctx().audible(), ['C']);
});

test('concurrent starts share the element timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    await flush();

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    t.mock.timers.tick(ELEMENT_START_TIMEOUT_MS - 100);
    h.player.seek(30_000 * TICKS_PER_MS);
    await flush();
    t.mock.timers.tick(100);
    await flush();

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);
});

test('stop empties the hidden element and keeps it in the DOM for the next queue', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    const audio = element();
    assert.equal(audio.attached, true);
    assert.equal(audio.hidden, true);

    await h.player.stop(true);
    await flush();
    assert.equal(audio.pauseEvents, 1, 'Plasma Browser Integration leaves the playing state only on this event');
    assert.equal(audio.srcObject, null);
    assert.equal(audio.attached, true, 'Plasma Browser Integration forgets the page actions when it leaves');

    const next = createHarness({ samePage: true });
    await playAlbum(next, [track('B', 90)]);
    assert.equal(FakeAudio.instances.length, 1, 'the next player reuses it');
    assert.equal(audio.playing, true);
});

function lastPosition(): { duration?: number; position: number } | null | undefined {
    const last = mediaPositions.at(-1);
    return last ? { duration: last.duration, position: Math.round(last.position ?? 0) } : last;
}

test('the media session position follows the track, not the element clock', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 20), track('B', 90)]);
    assert.deepEqual(lastPosition(), { duration: 20, position: 0 });

    await h.ctx().advance(5 + START_LEAD_SEC);
    h.player.pause();
    assert.deepEqual(lastPosition(), { duration: 20, position: 5 });

    h.player.seek(12_000 * TICKS_PER_MS);
    await flush();
    assert.deepEqual(lastPosition(), { duration: 20, position: 12 });

    void h.player.unpause();
    await flush();
    await h.ctx().advance(9);
    assert.deepEqual(lastPosition(), { duration: 90, position: 0 }, 'the next track starts at 0');

    await h.player.stop(true);
    assert.equal(mediaPositions.at(-1), null, 'cleared when playback ends');
});

test('the end of the queue pauses and destroy releases the element', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 10)]);
    const audio = element();

    await h.ctx().advance(11);

    assert.equal(h.destroyed(), true);
    assert.equal(audio.paused, true);
    await flush();
    assert.equal(audio.pauseEvents, 1);
    assert.equal(audio.srcObject, null);
});

test('a handoff to the normal player pauses the element', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120), track('B', 90, { undecodable: true })]);
    const audio = element();

    void h.player.nextTrack();
    await flush();

    assert.equal(h.handoffs.length, 1);
    assert.equal(audio.paused, true);
    assert.equal(audio.srcObject, null, 'the OS media session ends');
});

test('a refused element play falls back to direct output and keeps the audio', async () => {
    const h = createHarness();
    FakeAudio.playRejection = 'NotAllowedError';
    await playAlbum(h, [track('A', 120)]);

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);
    assert.equal(h.player.paused(), false);

    h.player.pause();
    FakeAudio.playRejection = null;
    void h.player.unpause();
    await flush();
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.equal(element().playing, true);
});

test('an element play that never settles falls back to direct output after the timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = createHarness();
    FakeAudio.holdPlay = true;
    await playAlbum(h, [track('A', 120)]);
    assert.deepEqual(h.ctx().audible(), []);

    t.mock.timers.tick(ELEMENT_START_TIMEOUT_MS);
    await flush();
    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);

    element().releasePlay();
    await flush();
    assert.equal(gainOutput(h), h.ctx().destination, 'a late play does not switch the output mid-track');

    h.player.seek(30_000 * TICKS_PER_MS);
    await flush();
    assert.equal(gainOutput(h), h.ctx().streamDestination, 'the next start moves the output to the element');
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('the timeout counts from the context resume, not from the play() call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    await flush();
    const release = h.ctx().suspendUntilReleased();

    FakeAudio.holdPlay = true;
    void h.player.unpause();
    await flush();
    t.mock.timers.tick(ELEMENT_START_TIMEOUT_MS);
    release();
    await flush();
    assert.deepEqual(h.ctx().audible(), [], 'still waiting for the element');

    element().releasePlay();
    await flush();
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('a browser that cannot create a media stream plays directly', async () => {
    const h = createHarness();
    FakeAudioContext.supportsMediaStream = false;
    await playAlbum(h, [track('A', 120)]);

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);
    assert.equal(FakeAudio.instances.length, 0);
});

test('a browser without Audio plays directly', async () => {
    const h = createHarness();
    delete (globalThis as Record<string, unknown>).Audio;
    await playAlbum(h, [track('A', 120)]);

    assert.deepEqual(h.ctx().audible(), ['A']);
    assert.equal(gainOutput(h), h.ctx().destination);
});

test('a sample-rate switch moves the element to the new context', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)]);

    assert.equal(FakeAudio.instances.length, 1, 'the element is reused');
    assert.equal(element().srcObject, h.ctx().streamDestination?.stream);
    assert.equal(element().playing, true);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('after a sample-rate switch, a pause keeps the new context stream on the element', async () => {
    const h = createHarness();
    await playAlbum(h, [flacTrack('A', 60, { sampleRate: 44_100 }), track('B', 90)]);
    const stream = h.ctx().streamDestination?.stream;

    h.player.pause();
    await flush();
    assert.equal(element().srcObject, stream, 'the replaced output does not release the element');

    void h.player.unpause();
    await flush();
    assert.equal(element().playing, true);
    assert.equal(gainOutput(h), h.ctx().streamDestination);
    assert.deepEqual(h.ctx().audible(), ['A']);
});

test('stop releases the element only after every queued pause event', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    const audio = element();

    h.player.pause();
    void h.player.unpause();
    h.player.pause();
    await h.player.stop(true);
    assert.notEqual(audio.srcObject, null, 'releasing now would cancel both events');

    await flush();
    assert.equal(audio.pauseEvents, 2);
    assert.equal(audio.srcObject, null);
});

test('stop after the pause event was dispatched releases the element at once', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    h.player.pause();
    await flush();

    await h.player.stop(true);

    assert.equal(element().srcObject, null);
});

test('the media position ignores a non-finite position and clears only once', () => {
    createHarness();
    setMediaPosition(Number.NaN, 120_000);
    assert.deepEqual(mediaPositions.at(-1), { duration: 120, playbackRate: 1, position: 0 });

    setMediaPosition(0, null);
    setMediaPosition(0, null);
    assert.deepEqual(mediaPositions.slice(-2), [{ duration: 120, playbackRate: 1, position: 0 }, null]);
});

test('a new queue right after stop takes over the element before the pause event', async () => {
    const h = createHarness();
    await playAlbum(h, [track('A', 120)]);
    await h.player.stop(true);

    void h.player.play({ items: [track('C', 100)] });
    await flush();
    assert.equal(element().srcObject, h.ctx().streamDestination?.stream);
    assert.equal(element().playing, true);

    h.player.pause();
    await flush();
    assert.equal(element().srcObject, h.ctx().streamDestination?.stream, 'the stopped output does not release it');
});
