import type { DecodedPng } from './decode-png.js';

/** A named point expected to hold a specific colour. */
export interface Probe {
  x: number;
  y: number;
  rgb: [number, number, number];
  note?: string;
}

export interface ImageDiff {
  maxDelta: number;
  failFraction: number;
  width: number;
  height: number;
}

/** Per-channel delta above which a pixel counts toward `failFraction`. Sized to
 *  absorb antialiasing along edges without hiding a wrong composite colour. */
export const DIFF_PIXEL_TOL = 12;

/** Check `probes` against `png`. Returns one message per miss; [] means all hit. */
export function samplesMatch(png: DecodedPng, probes: Probe[], tol = 2): string[] {
  const fails: string[] = [];
  for (const probe of probes) {
    const [r, g, b] = png.at(probe.x, probe.y);
    const [er, eg, eb] = probe.rgb;
    if (Math.abs(r - er) <= tol && Math.abs(g - eg) <= tol && Math.abs(b - eb) <= tol) continue;
    const where = probe.note ? `(${probe.x},${probe.y}) ${probe.note}` : `(${probe.x},${probe.y})`;
    fails.push(`${where}: expected ${er},${eg},${eb} (±${tol}), got ${r},${g},${b}`);
  }
  return fails;
}

/** Whole-image comparison. Catches gross geometry drift that probes would miss. */
export function diffImages(a: DecodedPng, b: DecodedPng): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let maxDelta = 0;
  let failing = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const pa = a.at(x, y);
      const pb = b.at(x, y);
      let worst = 0;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(pa[c] - pb[c]));
      if (worst > maxDelta) maxDelta = worst;
      if (worst > DIFF_PIXEL_TOL) failing++;
    }
  }
  return { maxDelta, failFraction: failing / (a.width * a.height), width: a.width, height: a.height };
}
