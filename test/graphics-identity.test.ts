import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { PageGraphics } from '../src/graphics.js';

/** A REGRESSION FENCE for lucg.2's resource-target refactor, not a feature
 *  test. `pagecontent.ts`'s four register* helpers move behind variants that
 *  take a resources dict instead of a Page, and `PageGraphics` splits into a
 *  base plus a page-bound subclass. Both are claimed byte-identical for
 *  existing callers, and before this file NOTHING in the suite checked that:
 *  test/graphics.test.ts and test/gradient.test.ts assert behaviour, and every
 *  other createHash fence covers tables, DOCX, rich runs, HTML or signing.
 *
 *  It exercises all four registration paths deliberately:
 *    setOpacity           -> registerExtGState         (/ExtGState)
 *    a varying-alpha ramp -> registerShadingPattern    (/Pattern)
 *                          + registerSoftMaskExtGState (/ExtGState with /SMask)
 *    BeginLayer           -> registerOcProperty        (/Properties)
 *
 *  The hash was recorded BEFORE the refactor. If it changes, the refactor moved
 *  a resource key or an allocation order: find out why rather than re-recording.
 */
const build = (): Document => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const layer = doc.OptionalContent.AddLayer('Fence');
  const g = new PageGraphics(doc, page);

  // /ExtGState via setOpacity.
  g.save().setOpacity(0.4).setFillColor([1, 0, 0]).drawRect(20, 700, 60, 40).fill().restore();

  // /Pattern + a soft-mask /ExtGState: stop alphas DIFFER, so the ramp cannot
  // fold into a single ca/CA and takes the luminosity-mask path.
  g.save().setFillGradient({
    kind: 'linear', x1: 20, y1: 600, x2: 200, y2: 600,
    stops: [
      { offset: 0, color: [0, 0, 1], opacity: 1 },
      { offset: 1, color: [0, 1, 0], opacity: 0.2 },
    ],
  }).drawRect(20, 580, 180, 40).fill().restore();

  // A uniform-alpha ramp: the OTHER gradient path, folding into one ca.
  g.save().setStrokeGradient({
    kind: 'radial', cx: 300, cy: 500, r: 50,
    stops: [
      { offset: 0, color: [1, 1, 0], opacity: 0.5 },
      { offset: 1, color: [1, 0, 1], opacity: 0.5 },
    ],
  }).setLineWidth(3).circle(300, 500, 40).stroke().restore();

  // /Properties via BeginLayer.
  g.BeginLayer(layer).setFillColor([0, 0, 0]).drawRect(20, 400, 30, 30).fill().EndLayer();

  g.apply();
  return doc;
};

const sha = (doc: Document): string =>
  createHash('sha256').update(doc.Save()).digest('hex').slice(0, 16);

describe('PageGraphics resource registration', () => {
  it('emits unchanged bytes across the resource-target refactor', () => {
    expect(sha(build())).toBe('46d1d2154c21a534');
  });
});
