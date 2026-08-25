import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { writeZip } from '../src/zip.js';
import { crc32 } from '../src/crc32.js';
import { unzip, entry } from './helpers/unzip.js';

const bytes = (s: string) => new TextEncoder().encode(s);
/** Long enough that deflate actually shrinks it. */
const LONG = 'the quick brown fox '.repeat(50);

describe('writeZip', () => {
  it('round-trips a stored entry', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes('hello'), method: 'store' }]);
    const [e] = unzip(zip);
    expect(e.path).toBe('a.txt');
    expect(e.method).toBe('store');
    expect(new TextDecoder().decode(e.bytes)).toBe('hello');
  });

  it('round-trips a deflated entry, and actually deflates it', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes(LONG) }]);   // deflate is the default
    const [e] = unzip(zip);
    expect(e.method).toBe('deflate');
    expect(new TextDecoder().decode(e.bytes)).toBe(LONG);
    expect(zip.length).toBeLessThan(LONG.length);
  });

  // The archive's own CRC field, against a checksum computed independently of
  // the writer. A reader and writer sharing one bug agree with each other.
  it('records the true CRC-32 of the uncompressed bytes', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes('hello') }]);
    expect(unzip(zip)[0].crc).toBe(crc32(bytes('hello')));
    expect(unzip(zip)[0].crc).toBe(0x3610a686);      // and the published value
  });

  // node:zlib inflating what we deflated is code we did not write.
  it('writes RAW deflate, with no zlib header', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes(LONG) }]);
    const e = unzip(zip)[0];       // unzip uses inflateRawSync
    expect(new TextDecoder().decode(e.bytes)).toBe(LONG);
    // A zlib-wrapped stream would begin 0x78; raw deflate does not.
    expect(() => inflateRawSync(Buffer.from([0x78, 0x9c]))).toThrow();
  });

  it('keeps several entries, in the order given', () => {
    const zip = writeZip([
      { path: 'one.txt', bytes: bytes('1') },
      { path: 'dir/two.txt', bytes: bytes('2') },
      { path: 'three.txt', bytes: bytes('3') },
    ]);
    expect(unzip(zip).map((e) => e.path)).toEqual(['one.txt', 'dir/two.txt', 'three.txt']);
    expect(new TextDecoder().decode(entry(unzip(zip), 'dir/two.txt')!.bytes)).toBe('2');
  });

  it('writes an empty entry without complaint', () => {
    const zip = writeZip([{ path: 'empty.txt', bytes: new Uint8Array(0) }]);
    const [e] = unzip(zip);
    expect(e.bytes.length).toBe(0);
    expect(e.crc).toBe(0);
  });

  // Two runs over one input must give identical bytes, or nothing downstream
  // can be snapshot-tested and a caller cannot tell a real change from the
  // time of day.
  it('is byte-reproducible', () => {
    const make = () => writeZip([{ path: 'a.txt', bytes: bytes('hello') }]);
    expect(Buffer.from(make())).toEqual(Buffer.from(make()));
  });

  // The case above is necessary and NOT sufficient: two writes a millisecond
  // apart agree even if the timestamp comes from the clock, so it only catches
  // a clock-derived field when the run straddles a second boundary. Asserting
  // the stored value pins it whatever the clock says. Local file header layout:
  // signature(4) version(2) flags(2) method(2) time(2) date(2).
  it('stores the fixed 1980-01-01 timestamp, not the clock', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes('hello') }]);
    expect([zip[10], zip[11]]).toEqual([0x00, 0x00]);   // time 00:00:00
    expect([zip[12], zip[13]]).toEqual([0x21, 0x00]);   // date 1980-01-01
  });

  it('rejects a duplicate path', () => {
    expect(() => writeZip([
      { path: 'a.txt', bytes: bytes('1') },
      { path: 'a.txt', bytes: bytes('2') },
    ])).toThrow(/duplicate/i);
  });

  it('rejects a leading slash and a backslash separator', () => {
    expect(() => writeZip([{ path: '/a.txt', bytes: bytes('1') }])).toThrow();
    expect(() => writeZip([{ path: 'dir\\a.txt', bytes: bytes('1') }])).toThrow();
  });

  // ZIP's 32-bit fields wrap silently past these bounds, producing an archive
  // that looks well-formed and is not. Neither is reachable from a converted
  // PDF, so refusing costs nothing.
  it('rejects more entries than the format can count', () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({
      path: `f${i}.txt`, bytes: new Uint8Array(0),
    }));
    expect(() => writeZip(many)).toThrow(/65535|too many/i);
  });
});
