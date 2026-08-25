// Synthetic rasters + a PSNR measure for the JPEG encoder tests. Zero deps.

/** Horizontal+vertical gray ramp. */
export function grayGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    px[y * w + x] = Math.round(((x / Math.max(1, w - 1)) * 0.5 + (y / Math.max(1, h - 1)) * 0.5) * 255);
  return px;
}

export function flatGray(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h).fill(v);
}

/** Smooth RGB ramp: R along x, G along y, B constant mid. */
export function rgbGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    px[i] = Math.round((x / Math.max(1, w - 1)) * 255);
    px[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
    px[i + 2] = 128;
  }
  return px;
}

export function cmykGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    px[i] = Math.round((x / Math.max(1, w - 1)) * 255);
    px[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
    px[i + 2] = 64;
    px[i + 3] = 32;
  }
  return px;
}

/** Peak signal-to-noise ratio in dB over two equal-length 8-bit buffers. */
export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`psnr: length mismatch ${a.length} vs ${b.length}`);
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
