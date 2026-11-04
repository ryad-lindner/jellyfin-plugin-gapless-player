import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FlacChunker, type FlacChunk, type FlacHeader, id3TagLength, probeFlac } from '../src/flac';
import { flacBytes, flacTrack } from './fakes';

// The bundled test runs from .test-build, next to test/.
const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures');

function fixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(fixtures, name)));
}

function header(bytes: Uint8Array): FlacHeader {
    const probe = probeFlac(bytes);
    assert.equal(probe.kind, 'flac');
    return (probe as { header: FlacHeader }).header;
}

/** Feeds the audio frames in odd-sized parts and cuts chunks of about targetBytes. */
function chunkAll(bytes: Uint8Array, targetBytes: number, partBytes = 1000): FlacChunk[] {
    const h = header(bytes);
    const chunker = new FlacChunker(h);
    const chunks: FlacChunk[] = [];
    for (let pos = h.firstFrame; pos < bytes.length; pos += partBytes) {
        chunker.push(bytes.subarray(pos, Math.min(bytes.length, pos + partBytes)));
        let chunk;
        while ((chunk = chunker.take(targetBytes))) {
            chunks.push(chunk);
        }
    }
    const last = chunker.take(targetBytes, true);
    if (last) {
        chunks.push(last);
    }
    return chunks;
}

function frameBytes(chunk: FlacChunk): Uint8Array {
    return new Uint8Array(chunk.file).subarray(8 + 34);
}

for (const [name, sampleRate, totalSamples] of [
    ['id3-picture-16bit.flac', 44_100, 66_150],
    ['ffmpeg-24bit-96k.flac', 96_000, 96_000]
] as const) {
    test(`${name}: chunks cover every sample and frame byte exactly once`, () => {
        const bytes = fixture(name);
        const h = header(bytes);
        assert.equal(h.sampleRate, sampleRate);
        assert.equal(h.totalSamples, totalSamples);

        const chunks = chunkAll(bytes, 16 * 1024);
        assert.ok(chunks.length > 2, 'the fixture splits into several chunks');
        let sample = 0;
        for (const chunk of chunks) {
            assert.equal(chunk.startSample, sample);
            sample += chunk.samples;
        }
        assert.equal(sample, totalSamples);

        const joined = new Uint8Array(chunks.reduce((n, c) => n + frameBytes(c).length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            joined.set(frameBytes(chunk), offset);
            offset += frameBytes(chunk).length;
        }
        assert.deepEqual(joined, bytes.subarray(h.firstFrame));
    });

    test(`${name}: each chunk is a standalone FLAC file of its own frames`, () => {
        for (const chunk of chunkAll(fixture(name), 16 * 1024)) {
            const file = new Uint8Array(chunk.file);
            const h = header(file);
            assert.equal(h.sampleRate, sampleRate);
            assert.equal(h.totalSamples, 0, 'the total is declared unknown');
            assert.deepEqual(h.streamInfo.subarray(18), new Uint8Array(16), 'the MD5 is declared unknown');

            const [again] = chunkAll(file, Infinity);
            assert.equal(again.samples, chunk.samples);
        }
    });
}

test('sync code look-alikes inside frame data do not split frames', () => {
    const bytes = fixture('id3-picture-16bit.flac').slice();
    const h = header(bytes);
    const reference = chunkAll(bytes, 16 * 1024);

    // A copy of frame 0's header (valid CRC-8, wrong frame number) and a sync
    // code with a broken header, written into the payload of later frames.
    const first = bytes.subarray(h.firstFrame, h.firstFrame + 16);
    const target = h.firstFrame + 3000;
    bytes.set(first, target);
    bytes.set([0xff, 0xf8, 0x69, 0x18, 0x00, 0x00], target + 2000);

    const chunks = chunkAll(bytes, 16 * 1024);
    assert.deepEqual(chunks.map(c => c.samples), reference.map(c => c.samples));
});

test('probe asks for more bytes until the metadata is complete', () => {
    const bytes = fixture('id3-picture-16bit.flac');
    const h = header(bytes);
    assert.equal(probeFlac(bytes.subarray(0, 2)).kind, 'more');
    assert.equal(probeFlac(bytes.subarray(0, h.firstFrame - 1)).kind, 'more');
    assert.equal(probeFlac(bytes.subarray(0, h.firstFrame)).kind, 'flac');
});

test('probe skips a leading ID3v2 tag and rejects other formats', () => {
    const bytes = fixture('id3-picture-16bit.flac');
    assert.equal(id3TagLength(bytes), 110);
    assert.equal(id3TagLength(new TextEncoder().encode('fLaC')), 0);

    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
    assert.equal(probeFlac(mp3).kind, 'other');
    assert.equal(probeFlac(new TextEncoder().encode('RIFF....WAVE')).kind, 'other');
});

test('variable block size streams continue by sample number', () => {
    flacTrack('V', 10, { blockSize: 3000, variableBlocks: true });
    const bytes = flacBytes('V');
    const chunks = chunkAll(bytes, 64 * 1024);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.reduce((n, c) => n + c.samples, 0), 480_000);
});

test('probe reads a 36-bit total sample count', () => {
    const bytes = fixture('id3-picture-16bit.flac').slice();
    // STREAMINFO body: after the 110-byte ID3 tag, "fLaC" and the block header.
    const info = 110 + 8;
    bytes[info + 13] = (bytes[info + 13] & 0xf0) | 0x2;
    bytes.set([0, 0, 0, 5], info + 14);
    assert.equal(header(bytes).totalSamples, 2 ** 33 + 5);
});
