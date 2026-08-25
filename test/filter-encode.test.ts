import { describe, it, expect } from 'vitest';
import {
  ascii85Decode, asciiHexDecode, runLengthDecode,
  runLengthEncode, asciiHexEncode, ascii85Encode,
} from '../src/ascii.js';
import { lzwDecode, lzwEncode } from '../src/lzw.js';
import { encodeFilter, encodeStream, decodeStream } from '../src/filters.js';
import { isName, name } from '../src/types.js';

/** Representative edge-case buffers reused across every round-trip test. */
function corpus(): Uint8Array[] {
  const ramp = new Uint8Array(256);
  for (let i = 0; i < 256; i++) ramp[i] = i;
  const zeros = new Uint8Array(64);
  const longRun = new Uint8Array(5000).fill(0x41);
  // Mixed runs and literals: "AAABCDDDD...".
  const mixed = Uint8Array.from([65, 65, 65, 66, 67, 68, 68, 68, 68, 69, 70, 71, 71]);
  // Deterministic pseudo-random binary.
  const rnd = new Uint8Array(1000);
  let s = 0x12345678;
  for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rnd[i] = s & 0xff; }
  return [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248]),
    zeros, ramp, longRun, mixed, rnd,
  ];
}

describe('runLengthEncode', () => {
  it('round-trips every corpus buffer through runLengthDecode', () => {
    for (const x of corpus()) {
      expect(runLengthDecode(runLengthEncode(x))).toEqual(x);
    }
  });

  it('compresses a long identical run and ends with the EOD byte 128', () => {
    const enc = runLengthEncode(new Uint8Array(1000).fill(0x7f));
    expect(enc.length).toBeLessThan(40);        // 1000 bytes -> a handful of run codes
    expect(enc[enc.length - 1]).toBe(128);      // EOD marker
  });
});

describe('asciiHexEncode', () => {
  it('round-trips every corpus buffer through asciiHexDecode', () => {
    for (const x of corpus()) {
      expect(asciiHexDecode(asciiHexEncode(x))).toEqual(x);
    }
  });

  it('emits uppercase hex pairs terminated by >', () => {
    const enc = asciiHexEncode(Uint8Array.from([0x0a, 0xff]));
    expect(new TextDecoder().decode(enc)).toBe('0AFF>');
  });
});

describe('ascii85Encode', () => {
  it('round-trips every corpus buffer through ascii85Decode', () => {
    for (const x of corpus()) {
      expect(ascii85Decode(ascii85Encode(x))).toEqual(x);
    }
  });

  it('uses the z shorthand for an all-zero group and ends with ~>', () => {
    const enc = new TextDecoder().decode(ascii85Encode(new Uint8Array(4)));
    expect(enc).toBe('z~>');
  });

  it('emits n+1 chars for an n-byte partial final group', () => {
    // One trailing byte -> a 2-char group before ~>.
    const enc = new TextDecoder().decode(ascii85Encode(Uint8Array.from([0x00])));
    expect(enc.endsWith('~>')).toBe(true);
    expect(enc.length - 2).toBe(2); // 2 chars for the 1-byte group
  });
});

describe('lzwEncode', () => {
  it('round-trips every corpus buffer through lzwDecode', () => {
    for (const x of corpus()) {
      expect(lzwDecode(lzwEncode(x))).toEqual(x);
    }
  });

  it('round-trips buffers large enough to cross the 9->12-bit width boundaries', () => {
    // ~20 KB of low-entropy data forces the table past 512/1024/2048/4096 codes.
    const big = new Uint8Array(20000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 3)) & 0x0f;
    expect(lzwDecode(lzwEncode(big))).toEqual(big);

    // A run long enough to fill and reset the dictionary at least once.
    const run = new Uint8Array(60000).fill(0x2a);
    expect(lzwDecode(lzwEncode(run))).toEqual(run);
  });

  it('begins with the packed CLEAR code (256 at 9 bits => 0x80 0x..)', () => {
    const enc = lzwEncode(Uint8Array.from([0x00]));
    // CLEAR=256 packed MSB-first at width 9: bits 100000000 -> first byte 0x80.
    expect(enc[0]).toBe(0x80);
  });
});

describe('encodeStream / encodeFilter', () => {
  const sample = Uint8Array.from([1, 2, 2, 2, 3, 0, 0, 0, 0, 255]);

  it('decodeStream(encodeStream(x, filter)) round-trips and sets /Filter', () => {
    for (const filter of ['ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode', 'FlateDecode']) {
      const s = encodeStream(sample, filter);
      const f = s.dict.get('Filter');
      expect(isName(f) && f.name).toBe(filter);
      expect(s.dict.get('Length')).toBe(s.raw.length);
      expect(decodeStream(s)).toEqual(sample);
    }
  });

  it('merges extraDict entries into the stream dict', () => {
    const s = encodeStream(sample, 'ASCII85Decode', new Map([['Type', name('XObject')]]));
    const t = s.dict.get('Type');
    expect(isName(t) && t.name).toBe('XObject');
  });

  it('throws UnsupportedFeatureError for an unknown filter', () => {
    expect(() => encodeFilter('DCTDecode', sample)).toThrow(/unsupported encode filter/);
  });
});
