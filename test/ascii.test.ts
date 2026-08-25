import { describe, it, expect } from 'vitest';
import { asciiHexDecode, ascii85Decode, runLengthDecode } from '../src/ascii.js';

const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const bytes = (s: string) => new TextEncoder().encode(s);

// Local encoder used only to generate ASCII85 fixtures for round-trip tests.
function ascii85Encode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n * 256 + (chunk[k] ?? 0)) >>> 0;
    const g = [0, 0, 0, 0, 0];
    let t = n;
    for (let k = 4; k >= 0; k--) { g[k] = t % 85; t = Math.floor(t / 85); }
    for (let k = 0; k < chunk.length + 1; k++) out.push(g[k] + 0x21);
  }
  out.push(0x7e, 0x3e); // ~>
  return Uint8Array.from(out);
}

describe('asciiHexDecode', () => {
  it('decodes hex pairs, ignores whitespace, stops at >', () => {
    expect(dec(asciiHexDecode(bytes('48 65 6C 6C 6F>ignored')))).toBe('Hello');
  });
  it('pads an odd trailing nibble with 0', () => {
    expect(Array.from(asciiHexDecode(bytes('4>')))).toEqual([0x40]);
  });
});

describe('ascii85Decode', () => {
  it('decodes z shorthand to four zero bytes', () => {
    expect(Array.from(ascii85Decode(bytes('z~>')))).toEqual([0, 0, 0, 0]);
  });
  it('decodes a partial final group', () => {
    const src = new Uint8Array([1, 2, 3]);
    const enc = ascii85Encode(src);
    expect(Array.from(ascii85Decode(enc))).toEqual([1, 2, 3]);
  });
  it('skips optional <~ prefix', () => {
    const enc = bytes('<~' + new TextDecoder().decode(ascii85Encode(new Uint8Array([9, 8, 7, 6]))));
    expect(Array.from(ascii85Decode(enc))).toEqual([9, 8, 7, 6]);
  });
});

describe('runLengthDecode', () => {
  it('copies literals and expands runs, stops at 128', () => {
    // [2] => copy 3 literals (a,b,c); [254] => repeat next byte (X) 3 times; [128] EOD
    const input = new Uint8Array([2, 97, 98, 99, 257 - 3, 88, 128, 99]);
    expect(dec(runLengthDecode(input))).toBe('abcXXX');
  });
});
