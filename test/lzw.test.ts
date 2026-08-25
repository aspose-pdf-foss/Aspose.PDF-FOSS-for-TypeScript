import { describe, it, expect } from 'vitest';
import { lzwDecode } from '../src/lzw.js';

// Minimal 9..12-bit LZW encoder (EarlyChange=1) for round-trip tests.
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0, width = 9, next = 258;
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  const emit = (code: number) => {
    bitBuf = (bitBuf << width) | code; bitCnt += width;
    while (bitCnt >= 8) { bitCnt -= 8; out.push((bitBuf >> bitCnt) & 0xff); }
  };
  emit(256); // clear
  let w = '';
  for (const b of data) {
    const c = String.fromCharCode(b);
    const wc = w + c;
    if (dict.has(wc)) { w = wc; }
    else {
      emit(dict.get(w)!);
      dict.set(wc, next++);
      w = c;
      if (next === (1 << width) - 1 && width < 12) width++;
    }
  }
  if (w !== '') emit(dict.get(w)!);
  emit(257); // EOD
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return Uint8Array.from(out);
}

describe('lzwDecode', () => {
  it('decodes the PDF-spec example stream', () => {
    // ISO 32000-1 7.4.4.2: "-----A---B" encodes to these 9 bytes.
    const enc = new Uint8Array([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    const out = lzwDecode(enc);
    expect(new TextDecoder().decode(out)).toBe('-----A---B');
  });

  it('round-trips arbitrary bytes through the local encoder', () => {
    const src = new Uint8Array([0, 1, 1, 2, 3, 3, 3, 255, 255, 0, 42, 42, 42, 42, 7, 7, 8]);
    expect(Array.from(lzwDecode(lzwEncode(src)))).toEqual(Array.from(src));
  });

  it('handles table reset on a CLEAR code (long repetitive input)', () => {
    const src = new Uint8Array(2000).fill(0x41);
    expect(Array.from(lzwDecode(lzwEncode(src)))).toEqual(Array.from(src));
  });
});
