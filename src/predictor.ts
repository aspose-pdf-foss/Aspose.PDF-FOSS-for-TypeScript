export interface PredictorParams { predictor: number; colors: number; bpc: number; columns: number; }

export function applyPredictor(data: Uint8Array, p: PredictorParams): Uint8Array {
  if (p.predictor <= 1) return data;
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8));
  const rowLen = Math.ceil((p.colors * p.bpc * p.columns) / 8);
  if (p.predictor === 2) return tiffPredictor(data, bpp, rowLen); // TIFF
  return pngPredictor(data, bpp, rowLen); // PNG (>=10): per-row filter tag
}

function tiffPredictor(data: Uint8Array, bpp: number, rowLen: number): Uint8Array {
  const out = Uint8Array.from(data);
  for (let r = 0; r + rowLen <= out.length; r += rowLen)
    for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
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
