/**
 * Colour-key masking (32000-1 8.9.6.4): which pixels a `/Mask` ARRAY matches.
 *
 * A leaf, imported by both sides of a rule that must not drift.
 * `grayimage.ts` asks in order to convert the key into a stencil, and
 * `raster.ts` asks in order to paint; if the two ever read the ranges
 * differently, a converted document renders differently from the original --
 * which is precisely the class of bug the conversion exists to avoid.
 *
 * Three things make up that rule and each is easy to get subtly wrong: the
 * values are RAW pre-Decode samples, the bounds are INCLUSIVE, and EVERY
 * component must lie in its range for the pixel to be masked.
 */

/**
 * Is pixel `i` masked by `ranges`?
 *
 * `comps` is the SAMPLE stride -- how many bytes one pixel occupies -- not the
 * number of components the pixel's colour has once decoded. For an Indexed
 * image those are 1 and 3 (or 4). Measured, and recorded so nobody "fixes" it
 * in the wrong direction: `resolveColorSpace` already reports ONE component for
 * an Indexed space, so a caller passing `cs.components` happens to be right --
 * but it is right by that coincidence, not by the rule, and a caller holding a
 * base-space component count must not pass it.
 */
export function colorKeyMatches(
  samples: Uint8Array, i: number, comps: number, ranges: number[],
): boolean {
  const o = i * comps;
  for (let k = 0; k < comps; k++) {
    const v = samples[o + k] ?? 0;
    if (v < (ranges[k * 2] ?? 0) || v > (ranges[k * 2 + 1] ?? 0)) return false;
  }
  return true;
}

/**
 * Which pixels a colour key matched, as a packed 1-bit stencil.
 *
 * Recording the RESULT is exact, where re-deriving the range in another colour
 * space cannot be -- (255,0,0) and (0,130,0) both grey to 76, so a grey range
 * covering pure red also covers that green.
 *
 * Rows are padded to a byte boundary, as every packed PDF image is. A set bit
 * means MASKED OUT, matching `/ImageMask`'s polarity under the default
 * `/Decode [0 1]`.
 */
export function colorKeyStencil(
  src: Uint8Array, width: number, height: number, comps: number, ranges: number[],
): Uint8Array {
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (colorKeyMatches(src, y * width + x, comps, ranges)) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/**
 * Per-pixel alpha for a colour key: 0 where masked, 255 elsewhere.
 *
 * The renderer's counterpart to `colorKeyStencil` -- same rule, the other
 * output shape, so neither has to reinterpret the other's bits.
 */
export function colorKeyAlpha(
  samples: Uint8Array, pixels: number, comps: number, ranges: number[],
): Uint8Array {
  const out = new Uint8Array(pixels).fill(255);
  for (let i = 0; i < pixels; i++) {
    if (colorKeyMatches(samples, i, comps, ranges)) out[i] = 0;
  }
  return out;
}
