/**
 * Splits a FLAC byte stream into standalone FLAC files at frame boundaries, so
 * decodeAudioData can decode a track progressively. FLAC frames carry no
 * encoder delay or padding: decoded chunks concatenate sample-exactly.
 */

export interface FlacHeader {
    sampleRate: number;
    totalSamples: number;
    /** STREAMINFO block body (34 bytes). */
    streamInfo: Uint8Array;
    /** Offset of the first audio frame, including a leading ID3v2 tag. */
    firstFrame: number;
}

export interface FlacChunk {
    /** A complete FLAC file: fLaC, STREAMINFO, then the chunk's frames. */
    file: ArrayBuffer;
    startSample: number;
    samples: number;
}

export type FlacProbe = { kind: 'flac'; header: FlacHeader } | { kind: 'other' } | { kind: 'more' };

const STREAMINFO_LENGTH = 34;
const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -1, -1, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];

/**
 * Length of a leading ID3v2 tag (header, body and optional footer), 0 when
 * there is none, or null when there are too few bytes to tell.
 */
export function id3TagLength(bytes: Uint8Array): number | null {
    if (bytes.length < 3) {
        return null;
    }
    // "ID3"
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return 0;
    }
    if (bytes.length < 10) {
        return null;
    }

    // Syncsafe 28-bit size (7 bits per byte), plus the 10-byte header, plus a
    // 10-byte footer when the footer flag (bit 4 of the flags byte) is set.
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    return 10 + size + ((bytes[5] & 0x10) !== 0 ? 10 : 0);
}

/** Reads the FLAC metadata from the start of a stream, as far as it is available. */
export function probeFlac(bytes: Uint8Array): FlacProbe {
    const tagLength = id3TagLength(bytes);
    if (tagLength == null) {
        return { kind: 'more' };
    }

    let pos = tagLength;
    if (bytes.length < pos + 4) {
        return { kind: 'more' };
    }
    // "fLaC"
    if (bytes[pos] !== 0x66 || bytes[pos + 1] !== 0x4c || bytes[pos + 2] !== 0x61 || bytes[pos + 3] !== 0x43) {
        return { kind: 'other' };
    }
    pos += 4;

    let streamInfo: Uint8Array | null = null;
    for (;;) {
        if (bytes.length < pos + 4) {
            return { kind: 'more' };
        }
        const last = (bytes[pos] & 0x80) !== 0;
        const type = bytes[pos] & 0x7f;
        const length = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        if (bytes.length < pos + 4 + length) {
            return { kind: 'more' };
        }
        if (type === 0) {
            if (length !== STREAMINFO_LENGTH) {
                return { kind: 'other' };
            }
            streamInfo = bytes.slice(pos + 4, pos + 4 + length);
        }
        pos += 4 + length;
        if (last) {
            break;
        }
    }
    if (!streamInfo) {
        return { kind: 'other' };
    }

    const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
    // 36-bit sample count: low nibble of byte 13, then bytes 14-17.
    const totalSamples = (streamInfo[13] & 0x0f) * 2 ** 32
        + ((streamInfo[14] << 24) >>> 0) + (streamInfo[15] << 16) + (streamInfo[16] << 8) + streamInfo[17];
    return { kind: 'flac', header: { sampleRate, totalSamples, streamInfo, firstFrame: pos } };
}

function crc8(bytes: Uint8Array, start: number, end: number): number {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

export interface FrameHeader {
    blockSize: number;
    /** Frame number (fixed block size) or first sample number (variable). */
    number: number;
    variable: boolean;
}

/**
 * Parses the frame header at pos. Returns null when there is no valid header
 * (including a CRC-8 mismatch) and 'more' when the bytes end inside it.
 */
export function parseFrameHeader(bytes: Uint8Array, pos: number): FrameHeader | null | 'more' {
    if (bytes.length < pos + 4) {
        return 'more';
    }
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xfe) !== 0xf8) {
        return null;
    }
    const variable = (bytes[pos + 1] & 1) === 1;
    const blockSizeCode = bytes[pos + 2] >> 4;
    const sampleRateCode = bytes[pos + 2] & 0x0f;
    const channelCode = bytes[pos + 3] >> 4;
    const sampleSizeCode = (bytes[pos + 3] >> 1) & 0x07;
    if (blockSizeCode === 0 || sampleRateCode === 0x0f || channelCode > 10 || sampleSizeCode === 3 || (bytes[pos + 3] & 1)) {
        return null;
    }

    let p = pos + 4;
    if (bytes.length <= p) {
        return 'more';
    }
    // UTF-8-style coded number, 1 to 7 bytes.
    const first = bytes[p];
    let length: number;
    let number: number;
    if (first < 0x80) {
        length = 1;
        number = first;
    } else if ((first & 0xe0) === 0xc0) {
        length = 2;
        number = first & 0x1f;
    } else if ((first & 0xf0) === 0xe0) {
        length = 3;
        number = first & 0x0f;
    } else if ((first & 0xf8) === 0xf0) {
        length = 4;
        number = first & 0x07;
    } else if ((first & 0xfc) === 0xf8) {
        length = 5;
        number = first & 0x03;
    } else if ((first & 0xfe) === 0xfc) {
        length = 6;
        number = first & 0x01;
    } else if (first === 0xfe) {
        length = 7;
        number = 0;
    } else {
        return null;
    }
    if (bytes.length < p + length) {
        return 'more';
    }
    for (let i = 1; i < length; i++) {
        if ((bytes[p + i] & 0xc0) !== 0x80) {
            return null;
        }
        number = number * 64 + (bytes[p + i] & 0x3f);
    }
    p += length;

    let blockSize = BLOCK_SIZES[blockSizeCode];
    if (blockSizeCode === 6 || blockSizeCode === 7) {
        const extra = blockSizeCode === 6 ? 1 : 2;
        if (bytes.length < p + extra) {
            return 'more';
        }
        blockSize = (blockSizeCode === 6 ? bytes[p] : (bytes[p] << 8) | bytes[p + 1]) + 1;
        p += extra;
    }
    if (sampleRateCode === 12) {
        p += 1;
    } else if (sampleRateCode === 13 || sampleRateCode === 14) {
        p += 2;
    }
    if (bytes.length <= p) {
        return 'more';
    }
    if (crc8(bytes, pos, p) !== bytes[p]) {
        return null;
    }
    return { blockSize, number, variable };
}

/**
 * Accumulates the audio frames of a FLAC stream (everything after the
 * metadata) and cuts them into chunk files. A frame ends where the next valid
 * header starts: its CRC-8 must match and its frame (or sample) number must
 * continue the sequence, which rejects sync-code look-alikes in frame data.
 */
export class FlacChunker {
    private _buffer = new Uint8Array(1 << 20);
    private _length = 0;
    // Buffer offsets of the frames found so far; the first is always 0.
    private _frames: number[] = [];
    private _frameSamples: number[] = [];
    private _scanPos = 0;
    private _nextSample = 0;
    private _expected: number | null = null;
    private readonly _streamInfo: Uint8Array;

    constructor(header: FlacHeader) {
        this._streamInfo = header.streamInfo.slice();
        // Each chunk is a stream of its own: its total sample count and MD5
        // would not match, so declare both unknown.
        this._streamInfo[13] &= 0xf0;
        this._streamInfo.fill(0, 14, STREAMINFO_LENGTH);
    }

    push(bytes: Uint8Array): void {
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
    take(targetBytes: number, final = false): FlacChunk | null {
        if (!this._frames.length) {
            if (final && this._length) {
                throw new Error('FLAC stream has data but no valid frame');
            }
            return null;
        }

        let end: number;
        let frameCount: number;
        if (final) {
            end = this._length;
            frameCount = this._frames.length;
        } else {
            // Frame i is complete once frame i + 1 has been found.
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
        file.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, STREAMINFO_LENGTH]);
        file.set(this._streamInfo, 8);
        file.set(this._buffer.subarray(0, end), 8 + STREAMINFO_LENGTH);

        this._buffer.copyWithin(0, end, this._length);
        this._length -= end;
        this._scanPos -= end;
        this._frames = this._frames.slice(frameCount).map(offset => offset - end);
        this._frameSamples = this._frameSamples.slice(frameCount);
        return { file: file.buffer, startSample, samples };
    }

    private _frameSampleCount(i: number): number {
        return i + 1 < this._frameSamples.length
            ? this._frameSamples[i + 1] - this._frameSamples[i]
            : this._nextSample - this._frameSamples[i];
    }

    private _scan(): void {
        const bytes = this._buffer.subarray(0, this._length);
        while (this._scanPos + 1 < this._length) {
            if (bytes[this._scanPos] !== 0xff || (bytes[this._scanPos + 1] & 0xfe) !== 0xf8) {
                this._scanPos++;
                continue;
            }
            const header = parseFrameHeader(bytes, this._scanPos);
            if (header === 'more') {
                return;
            }
            const continues = header != null
                && (this._expected == null ? this._scanPos === 0 : header.number === this._expected);
            if (!continues) {
                if (this._expected == null && this._scanPos === 0) {
                    throw new Error('FLAC audio data does not start with a frame');
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
}
