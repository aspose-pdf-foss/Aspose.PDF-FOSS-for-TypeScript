import { PdfParseError } from './errors.js';

const CLEAR = 256;
const EOD = 257;

/** Variable-width (9..12 bit) LZW decode as used by PDF LZWDecode.
 *  `earlyChange` (default 1) bumps the code width one step early. */
export function lzwDecode(input: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = new Array(258);
    for (let i = 0; i < 256; i++) table[i] = [i];
    table[CLEAR] = [];
    table[EOD] = [];
  };
  reset();
  let width = 9;
  let next = 258;
  let prev: number[] | null = null;

  let bitBuf = 0, bitCnt = 0, pos = 0;
  const read = (): number => {
    while (bitCnt < width) {
      if (pos >= input.length) return EOD;
      bitBuf = (bitBuf << 8) | input[pos++];
      bitCnt += 8;
    }
    bitCnt -= width;
    return (bitBuf >> bitCnt) & ((1 << width) - 1);
  };

  for (;;) {
    const code = read();
    if (code === EOD) break;
    if (code === CLEAR) { reset(); width = 9; next = 258; prev = null; continue; }

    let entry: number[];
    if (code < next && table[code]) entry = table[code];
    else if (code === next && prev) entry = [...prev, prev[0]];
    else throw new PdfParseError(`LZWDecode: bad code ${code} (next ${next})`);

    for (const b of entry) out.push(b);

    if (prev) {
      table[next++] = [...prev, entry[0]];
      if (next === (1 << width) - earlyChange && width < 12) width++;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}

/** Variable-width (9..12-bit) LZW encode, the inverse of lzwDecode. Emits a
 *  leading CLEAR (256), grows the string table one entry per emitted data code,
 *  bumps the code width when `next === (1 << width) - earlyChange` (mirroring the
 *  decoder), resets the table with a CLEAR when it fills (`next === 4096`), and
 *  ends with EOD (257). Codes are packed MSB-first. */
export function lzwEncode(input: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0;
  const emit = (code: number, width: number) => {
    bitBuf = (bitBuf << width) | code;
    bitCnt += width;
    while (bitCnt >= 8) { bitCnt -= 8; out.push((bitBuf >>> bitCnt) & 0xff); }
    bitBuf &= (1 << bitCnt) - 1; // drop already-drained high bits
  };

  let dict = new Map<string, number>();
  let width = 9, next = 258;
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    width = 9; next = 258;
  };
  reset();

  emit(CLEAR, width);

  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const combined = cur + String.fromCharCode(input[i]);
    if (dict.has(combined)) {
      cur = combined;
      continue;
    }
    emit(dict.get(cur)!, width);        // cur is a known entry (singleton or longer)
    dict.set(combined, next++);         // add cur+byte
    // The decoder adds one entry later than we do (it skips the add on the first
    // code after CLEAR), so its `next` lags ours by one — bump one step later to
    // keep code widths in lockstep.
    if (next - 1 === (1 << width) - earlyChange && width < 12) width++;
    if (next === 4096) { emit(CLEAR, width); reset(); }
    cur = String.fromCharCode(input[i]);
  }
  if (cur !== '') emit(dict.get(cur)!, width);
  emit(EOD, width);
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff); // flush final partial byte
  return Uint8Array.from(out);
}
