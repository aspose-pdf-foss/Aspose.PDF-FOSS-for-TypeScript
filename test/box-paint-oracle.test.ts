import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePng } from './helpers/decode-png.js';
import { diffImages } from './helpers/compare-image.js';
import { BOX_PAINT_FIXTURES } from './helpers/box-paint-fixtures.js';

// v9j3.4: our rendering of each text-free box against headless Chrome's
// (scripts/gen-box-paint-goldens.ts). Chrome draws 1 CSS px per device pixel;
// a CSS px is 0.75pt here, so the page is sized in points and rendered at
// 96 dpi (scale 96/72) to land on the same pixel grid, with no page margins.
// The bound is on the FRACTION of pixels off by more than DIFF_PIXEL_TOL —
// antialiasing differs along every curve — measured per fixture and recorded
// in test/fixtures/box-paint/PROVENANCE.md.
const DIR = join(__dirname, 'fixtures', 'box-paint');
export const MAX_FAIL_FRACTION = 0.01;

export function renderOurs(html: string, width: number, height: number) {
  const d = Document.New();
  d.AddHtml(html, {
    format: PageFormat.custom(width * 0.75, height * 0.75),
    marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0,
  });
  return decodePng(d.Pages[0].ToImage({ scale: 96 / 72 }));
}

describe('box painting matches Chrome (v9j3.4 oracle)', () => {
  for (const fx of BOX_PAINT_FIXTURES) {
    it(fx.id, () => {
      const ours = renderOurs(fx.html, fx.width, fx.height);
      const chrome = decodePng(readFileSync(join(DIR, `${fx.id}.png`)));
      const diff = diffImages(ours, chrome);
      expect(diff.failFraction, `maxDelta ${diff.maxDelta}`).toBeLessThan(MAX_FAIL_FRACTION);
    });
  }
});

describe('a four-colour rounded border paints the whole ring (v9j3.4 Fixed)', () => {
  it('the ring inside the inner rectangle, outside the inner arc, takes its edge colour', () => {
    // border-colors-rounded: border box 20..240 x 20..160 px, 10px border,
    // 30px radius, so the inner arc has radius 20 centred at (50,50). (35,33)
    // is 22.7px from that centre — in the ring — and above the TL join, so
    // top's colour #c00. The joins used to stop at the inner rectangle corner
    // (30,30), leaving this pixel in no wedge and white.
    const fx = BOX_PAINT_FIXTURES.find((f) => f.id === 'border-colors-rounded')!;
    const p = renderOurs(fx.html, fx.width, fx.height);
    const c = p.data.length / (p.width * p.height), i = (33 * p.width + 35) * c;
    expect([p.data[i], p.data[i + 1], p.data[i + 2]]).toEqual([204, 0, 0]);
  });
});
