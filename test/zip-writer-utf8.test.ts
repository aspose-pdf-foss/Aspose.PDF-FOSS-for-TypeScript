import { describe, it, expect } from 'vitest';
import { writeZip } from '../src/zip.js';

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The flags of the one entry, from its local header and its central record. */
function flagsOf(zip: Uint8Array): { local: number; central: number } {
  const cd = u32(zip, zip.length - 22 + 16);
  return { local: u16(zip, 6), central: u16(zip, cd + 8) };
}

describe('writeZip marks a UTF-8 name with general-purpose bit 11', () => {
  it('sets bit 11 in both headers for a non-ASCII name', () => {
    const zip = writeZip([{ path: 'café.txt', bytes: new Uint8Array([1]) }]);
    expect(flagsOf(zip)).toEqual({ local: 0x0800, central: 0x0800 });
  });

  it('leaves the flags 0 for an ASCII name, so existing output is byte-identical', () => {
    const zip = writeZip([{ path: 'word/document.xml', bytes: new Uint8Array([1]) }]);
    expect(flagsOf(zip)).toEqual({ local: 0, central: 0 });
  });
});
