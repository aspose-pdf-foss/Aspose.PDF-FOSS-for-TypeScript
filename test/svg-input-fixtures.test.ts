import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document } from '../src/document.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { diffImages, samplesMatch, DIFF_PIXEL_TOL, type Probe } from './helpers/compare-image.js';

// Third-party SVG INPUT, the SVG->PDF direction. Not to be confused with
// test/fixtures/svg/, which holds PDF->SVG OUTPUT goldens. See PROVENANCE.md.
//
// These exist to catch the shared-convention bug the programmatic builders
// cannot: src/svgpath.ts and test/helpers agreeing with each other and both
// disagreeing with the format.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures', 'svg-input');

/** Draw one fixture over a 200x200 page at 1 px per point, then rasterize. */
function renderFixture(name: string): { png: DecodedPng; skipped: string[] } {
  const svg = new Uint8Array(readFileSync(join(dir, name)));
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg, [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Fraction of pixels that are not the white page background. */
function inkFraction(png: DecodedPng): number {
  let ink = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r < 245 || g < 245 || b < 245) ink++;
    }
  return ink / (png.width * png.height);
}

describe('svg-input — the authored showcase', () => {
  it('renders with nothing skipped', () => {
    // The board covers only features this epic shipped, so anything reported
    // is either a regression or a feature that quietly stopped working.
    expect(renderFixture('showcase.svg').skipped).toEqual([]);
  });

  it('actually draws something across the page', () => {
    // Guards the degenerate pass: a fixture that parses to nothing would
    // satisfy every other assertion here.
    expect(inkFraction(renderFixture('showcase.svg').png)).toBeGreaterThan(0.2);
  });
});

describe('svg-input — the SVGO pair', () => {
  // The external ground truth is SVGO's claim that the two files are
  // equivalent; we author one side and SVGO produces the other. Both sides go
  // through OUR rasterizer, so antialiasing is identical and no tolerance is
  // in play -- a mismatch is a real geometric difference and therefore a
  // parser bug. Do not widen this budget.
  const MAX_FAIL_FRACTION = 0.005;

  it('renders the optimized copy with nothing skipped', () => {
    expect(renderFixture('showcase.min.svg').skipped).toEqual([]);
  });

  it('draws the optimized copy exactly as the readable source', () => {
    const a = renderFixture('showcase.svg').png;
    const b = renderFixture('showcase.min.svg').png;
    const d = diffImages(a, b);
    expect(d.failFraction).toBeLessThanOrEqual(MAX_FAIL_FRACTION);
    expect(d.maxDelta).toBeLessThanOrEqual(DIFF_PIXEL_TOL * 8);
  });
});

/** Two-tier comparison against an independent engine, as test/svg-golden.test.ts
 *  does: tight probes on flat interiors where antialiasing cannot explain a
 *  miss, then a loose whole-page diff sized for edges. */
function checkAgainstGolden(name: string, probes: Probe[], budget: number): void {
  const goldenPath = join(dir, `${name}.png`);
  // A golden is committed only where resvg and we agree. An absent one is a
  // recorded divergence, not a silent pass.
  const has = existsSync(goldenPath);
  it(`${name}: has a committed golden`, () => {
    expect(has, `no golden for ${name} — see PROVENANCE.md Divergences`).toBe(true);
  });
  if (!has) return;

  const golden = decodePng(new Uint8Array(readFileSync(goldenPath)));
  const { png, skipped } = renderFixture(`${name}.svg`);

  it(`${name}: renders with nothing skipped`, () => {
    expect(skipped).toEqual([]);
  });

  it(`${name}: matches resvg at the golden's dimensions`, () => {
    expect([png.width, png.height]).toEqual([golden.width, golden.height]);
  });

  it(`${name}: agrees with resvg on flat interiors`, () => {
    expect(samplesMatch(png, probes)).toEqual([]);
    expect(samplesMatch(golden, probes)).toEqual([]);
  });

  it(`${name}: agrees with resvg across the page`, () => {
    const d = diffImages(png, golden);
    expect(d.failFraction).toBeLessThanOrEqual(budget);
  });
}

describe('svg-input — bootstrap-icons against resvg', () => {
  // Read off the golden, not guessed: a probe on an antialiased edge is the
  // flaky test this whole file exists to avoid. The shaft probe is the
  // load-bearing one -- the arrow is a hole only under fill-rule="evenodd",
  // so a dropped rule paints it solid and this probe goes black.
  checkAgainstGolden('icon', [
    { x: 60, y: 72, rgb: [0, 0, 0], note: 'heart interior, left lobe' },
    { x: 120, y: 80, rgb: [0, 0, 0], note: 'heart interior, right of the shaft' },
    { x: 62, y: 120, rgb: [255, 255, 255], note: 'inside the arrow shaft: the evenodd hole' },
    { x: 20, y: 8, rgb: [255, 255, 255], note: 'empty upper-left corner' },
  ], 0.05);
});

describe('svg-input — d3-shape against resvg', () => {
  // The donut hole is the load-bearing probe: it exists only because d3 walks
  // the inner arc back the other way, so a mis-decoded sweep flag fills it.
  checkAgainstGolden('chart', [
    { x: 60, y: 40, rgb: [228, 26, 28], note: 'red wedge interior' },
    { x: 140, y: 40, rgb: [152, 78, 163], note: 'purple wedge interior' },
    { x: 100, y: 80, rgb: [255, 255, 255], note: 'the donut hole' },
    { x: 10, y: 10, rgb: [255, 255, 255], note: 'empty upper-left corner' },
  ], 0.06);
});
