/**
 * Box-filter downsample of an interleaved 8-bit sample plane.
 *
 * Each destination pixel averages every source pixel its footprint covers. That
 * is the right filter for downscaling: nearest-neighbour aliases, and bilinear
 * ignores most source pixels once the scale drops below 1/2. It matches the
 * `box2x2` precedent already in jpegencode.ts, generalized to any ratio.
 *
 * Downsampling only — `dw`/`dh` are expected to be <= `w`/`h`; callers clamp the
 * scale to 1 so this is never asked to invent detail.
 */
export function resampleBox(
  src: Uint8Array, w: number, h: number, channels: number, dw: number, dh: number,
): Uint8Array {
  if (!Number.isInteger(dw) || !Number.isInteger(dh) || dw < 1 || dh < 1)
    throw new TypeError('resampleBox: destination must be at least 1x1');
  if (src.length !== w * h * channels)
    throw new TypeError(`resampleBox: expected ${w * h * channels} samples, got ${src.length}`);
  if (dw === w && dh === h) return src.slice();

  const out = new Uint8Array(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * h) / dh);
    // max(sy0 + 1, ...) keeps every box at least one pixel tall, so the divisor
    // is never zero even when the ratio rounds a box to nothing.
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * w) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / dw));
      const n = (sy1 - sy0) * (sx1 - sx0);
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++)
          for (let sx = sx0; sx < sx1; sx++)
            sum += src[(sy * w + sx) * channels + c];
        out[(y * dw + x) * channels + c] = Math.round(sum / n);
      }
    }
  }
  return out;
}
