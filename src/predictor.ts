import { PdfParseError } from './errors.js';

export interface PredictorParams { predictor: number; colors: number; bpc: number; columns: number; }

export function applyPredictor(data: Uint8Array, p: PredictorParams): Uint8Array {
  if (p.predictor <= 1) return data;
  if (p.predictor === 2) return tiffPredictor(data, p);
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8));
  const rowLen = Math.ceil((p.colors * p.bpc * p.columns) / 8);
  return pngPredictor(data, bpp, rowLen); // PNG (>=10): per-row filter tag
}

function tiffPredictor(data: Uint8Array, { colors, bpc, columns }: PredictorParams): Uint8Array {
  const rowBits = colors * columns * bpc;
  if (![1, 2, 4, 8, 16].includes(bpc)
    || !Number.isSafeInteger(colors) || colors <= 0
    || !Number.isSafeInteger(columns) || columns <= 0
    || !Number.isSafeInteger(rowBits))
    throw new PdfParseError('invalid TIFF predictor component width or dimensions');
  const rowLen = Math.ceil(rowBits / 8);
  const out = Uint8Array.from(data);
  // Process only complete rows. Padding is not a component, and a truncated
  // suffix remains unchanged, as in the original byte-oriented implementation.
  for (let r = 0; r + rowLen <= out.length; r += rowLen) {
    if (bpc === 8) {
      for (let i = colors; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - colors]) & 0xff;
    } else if (bpc === 16) {
      // PDF components are big-endian words: byte-wise sums lose the carry.
      for (let i = colors * 2; i < rowLen; i += 2) {
        const at = r + i, prev = at - colors * 2;
        const value = (((out[at] << 8) | out[at + 1]) + ((out[prev] << 8) | out[prev + 1])) & 0xffff;
        out[at] = value >>> 8;
        out[at + 1] = value & 0xff;
      }
    } else {
      const mask = (1 << bpc) - 1;
      for (let i = colors; i < colors * columns; i++) {
        const bit = i * bpc, prevBit = (i - colors) * bpc;
        const at = r + Math.floor(bit / 8), prev = r + Math.floor(prevBit / 8);
        const shift = 8 - bpc - bit % 8, prevShift = 8 - bpc - prevBit % 8;
        const value = (((out[at] >>> shift) & mask) + ((out[prev] >>> prevShift) & mask)) & mask;
        out[at] = (out[at] & ~(mask << shift)) | (value << shift);
      }
    }
  }
  return out;
}

function pngPredictor(data: Uint8Array, bpp: number, rowLen: number): Uint8Array {
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;   // left
      const b = prev[i];                        // up
      const c = i >= bpp ? prev[i - bpp] : 0;   // upper-left
      let v = src[i];
      switch (tag) {
        case 0: break;                          // None
        case 1: v += a; break;                  // Sub
        case 2: v += b; break;                  // Up
        case 3: v += (a + b) >> 1; break;       // Average
        case 4: v += paeth(a, b, c); break;     // Paeth
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const pp = a + b - c;
  const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
