import { describe, it, expect } from 'vitest';
import { parseSegments } from '../src/jbig2.js';

// Hand-built embedded segment header (T.88 7.2), short form:
// segNum=0 (u32), flags=0x30 (type=48 page-info, 1-byte page assoc), rtFlags=0x00
// (count=0), pageAssoc=1 (u8), dataLength (u32), then body bytes.
function pageInfoHeader(dataLen: number): Uint8Array {
  const h = [
    0, 0, 0, 0,      // segment number
    0x30,            // flags: type 48
    0x00,            // referred-to count/retain (count=0)
    0x01,            // page association (1 byte)
    (dataLen >>> 24) & 0xff, (dataLen >>> 16) & 0xff, (dataLen >>> 8) & 0xff, dataLen & 0xff,
  ];
  return Uint8Array.from(h);
}

describe('jbig2 segment header parsing', () => {
  it('parses a single page-info header with its body offset/length', () => {
    const header = pageInfoHeader(19);
    const body = new Uint8Array(19);
    const stream = new Uint8Array(header.length + body.length);
    stream.set(header, 0); stream.set(body, header.length);
    const segs = parseSegments(stream);
    expect(segs.length).toBe(1);
    expect(segs[0].number).toBe(0);
    expect(segs[0].type).toBe(48);
    expect(segs[0].referredTo).toEqual([]);
    expect(segs[0].pageAssociation).toBe(1);
    expect(segs[0].dataStart).toBe(header.length);
    expect(segs[0].dataLength).toBe(19);
  });

  it('rejects an unknown (0xffffffff) data length', () => {
    expect(() => parseSegments(pageInfoHeader(0xffffffff))).toThrow(/unknown.*length|0xffffffff/i);
  });
});
