/**
 * Colour quantization: 24-bit RGB down to a palette of at most 256 entries.
 *
 * Pure — samples in, palette and indices out — and it knows nothing about GIF
 * or any other format, which is what lets every rule here be tested from a
 * hand-built ramp. `gifencode.ts` is its only caller today.
 *
 * **Invariant:** an image with at most `max` distinct colours is passed through
 * EXACTLY, and says so in `exact`. That is not an optimization detail, it is
 * the reason GIF is usable for rendered pages at all: a document of text and
 * flat fills has a handful of distinct values, so the "lossy" format is
 * lossless for it. Only a photograph or a gradient reaches the median cut.
 *
 * **Invariant:** median cut splits the box with the largest POPULATION-weighted
 * extent, along its own longest axis, at the weighted median. Splitting by box
 * count alone spends entries on outliers a page never shows; splitting at the
 * midpoint rather than the median puts the boundary where no pixels are.
 */

/** The result of quantizing an image. */
export interface Quantized {
  /** RGB triples, 1..256 entries. */
  palette: Uint8Array;
  /** One palette index per pixel, in source order. */
  indices: Uint8Array;
  /** True when the palette holds every distinct colour of the source, so the
   *  mapping is lossless. */
  exact: boolean;
}

const key = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

interface Box {
  /** Distinct colours in this box, as packed keys. */
  colors: number[];
  /** Total pixel count across those colours. */
  count: number;
  rMin: number; rMax: number;
  gMin: number; gMax: number;
  bMin: number; bMax: number;
}

function bound(colors: number[], counts: Map<number, number>): Box {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, count = 0;
  for (const c of colors) {
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    count += counts.get(c)!;
  }
  return { colors, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

/** How much splitting this box could buy: its longest axis, weighted by how
 *  many pixels sit in it. A wide box holding four pixels is not worth an entry. */
const priority = (b: Box): number =>
  Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin) * b.count;

/** Split at the population-weighted median along the longest axis. Returns
 *  `undefined` when the box cannot be split (one colour, or zero extent). */
function split(box: Box, counts: Map<number, number>): [Box, Box] | undefined {
  if (box.colors.length < 2) return undefined;
  const dr = box.rMax - box.rMin, dg = box.gMax - box.gMin, db = box.bMax - box.bMin;
  const shift = dr >= dg && dr >= db ? 16 : dg >= db ? 8 : 0;
  if (Math.max(dr, dg, db) === 0) return undefined;

  const sorted = [...box.colors].sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
  const half = box.count / 2;
  let acc = 0, cut = 0;
  for (; cut < sorted.length - 1; cut++) {
    acc += counts.get(sorted[cut])!;
    if (acc >= half) break;
  }
  // `cut` is the last index of the low half; keep both sides non-empty.
  const lo = sorted.slice(0, cut + 1);
  const hi = sorted.slice(cut + 1);
  if (lo.length === 0 || hi.length === 0) return undefined;
  return [bound(lo, counts), bound(hi, counts)];
}

/** The population-weighted mean colour of a box — the palette entry it becomes. */
function average(box: Box, counts: Map<number, number>): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (const c of box.colors) {
    const w = counts.get(c)!;
    r += ((c >> 16) & 0xff) * w;
    g += ((c >> 8) & 0xff) * w;
    b += (c & 0xff) * w;
    n += w;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Quantize interleaved 8-bit RGB to a palette of at most `max` entries.
 *
 * @param samples `pixels * 3` bytes, RGB order
 * @param pixels  pixel count
 * @param max     palette ceiling, 2..256 (default 256)
 */
export function quantize(samples: Uint8Array, pixels: number, max = 256): Quantized {
  if (!Number.isInteger(pixels) || pixels < 1)
    throw new TypeError('quantize: pixels must be a positive integer');
  if (samples.length !== pixels * 3)
    throw new TypeError(`quantize: expected ${pixels * 3} samples, got ${samples.length}`);
  if (!Number.isInteger(max) || max < 2 || max > 256)
    throw new TypeError('quantize: max must be an integer in 2..256');

  const counts = new Map<number, number>();
  for (let i = 0; i < pixels; i++) {
    const k = key(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const distinct = [...counts.keys()];
  const indices = new Uint8Array(pixels);

  // --- the common case for a rendered page: it already fits ---
  if (distinct.length <= max) {
    const slot = new Map<number, number>();
    const palette = new Uint8Array(distinct.length * 3);
    distinct.forEach((c, i) => {
      slot.set(c, i);
      palette[i * 3] = (c >> 16) & 0xff;
      palette[i * 3 + 1] = (c >> 8) & 0xff;
      palette[i * 3 + 2] = c & 0xff;
    });
    for (let i = 0; i < pixels; i++)
      indices[i] = slot.get(key(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]))!;
    return { palette, indices, exact: true };
  }

  // --- median cut ---
  let boxes: Box[] = [bound(distinct, counts)];
  while (boxes.length < max) {
    // Split the most valuable splittable box; stop when none can be split.
    let best = -1, bestP = -1;
    for (let i = 0; i < boxes.length; i++) {
      const p = priority(boxes[i]);
      if (p > bestP && boxes[i].colors.length > 1) { bestP = p; best = i; }
    }
    if (best < 0) break;
    const parts = split(boxes[best], counts);
    if (parts === undefined) {
      // Unsplittable despite holding several colours (zero extent): retire it
      // so the search cannot spin on it.
      boxes[best] = { ...boxes[best], colors: [boxes[best].colors[0]] };
      continue;
    }
    boxes = [...boxes.slice(0, best), ...parts, ...boxes.slice(best + 1)];
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    const [r, g, b] = average(box, counts);
    palette[i * 3] = r; palette[i * 3 + 1] = g; palette[i * 3 + 2] = b;
  });

  // Map every DISTINCT colour once, then apply. A per-pixel nearest search over
  // 256 entries would be pixels x 256; there are far fewer distinct colours.
  const slot = new Map<number, number>();
  for (const c of distinct) {
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    slot.set(c, bestI);
  }
  for (let i = 0; i < pixels; i++)
    indices[i] = slot.get(key(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]))!;

  return { palette, indices, exact: false };
}
