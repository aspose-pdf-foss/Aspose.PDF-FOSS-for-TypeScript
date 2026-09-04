import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildEverythingColorPdf } from './helpers/build-grayscale-pdf.js';

/**
 * The global oracle for ConvertToGrayscale.
 *
 * A missed content stream renders in colour and leaves every structural
 * assertion green, so this is the only check in the suite that sees one.
 *
 * WHAT IT COVERS, measured by mutation rather than assumed -- each pass was
 * disabled in turn and this file re-run:
 *
 *   content streams   RED   (2 of 3 cases)
 *   image XObjects    RED   (2 of 3)
 *   shadings          RED   (2 of 3)
 *   annotation colour GREEN -- NOT covered here
 *   inline images     RED   (2 of 3) -- since 6dud; see below
 *
 * The annotation miss is by construction: /C and /IC are only drawn when an
 * annotation has no /AP, and this one has an /AP so its appearance stream wins.
 * That pass is fenced by test/grayscale-convert.test.ts's /C, /IC, /MK and /DA
 * assertions instead.
 *
 * Inline images were the OTHER miss until `6dud`, and for a reason that was not
 * this feature's doing: `pagerender.ts` handed the raw `BI` dict to the sink, so
 * the abbreviated /CS and /BPC that 32000-1 Table 93 mandates reached decoders
 * reading full names, and no inline image rendered at all -- before or after
 * conversion. The fixture deliberately keeps that abbreviated spelling, being
 * what a real producer emits. Now that they render, this file covers the pass:
 * re-measured by disabling `colorops.ts`'s inline branch, which reddens the two
 * cases above. test/grayops.test.ts's five inline cases remain the unit fence.
 *
 * Do not read this file's green as covering ANNOTATION COLOUR.
 */

/** Pixels whose channels disagree, and how many were painted at all. */
function sweep(png: Uint8Array): { colored: Array<[number, number]>; painted: number } {
  const img = decodePng(png);
  const colored: Array<[number, number]> = [];
  let painted = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = img.at(x, y);
      if (a === 0) continue;
      if (r !== 255 || g !== 255 || b !== 255) painted++;
      // JPEG and resampling introduce a little channel drift; 2/255 is well
      // inside that and far outside any real hue.
      if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2) colored.push([x, y]);
    }
  }
  return { colored, painted };
}

describe('ConvertToGrayscale — the rendered page', () => {
  it('paints colour before conversion', () => {
    // The control. Without it, a fixture that draws nothing would pass below.
    const doc = Document.Open(buildEverythingColorPdf());
    const s = sweep(doc.Pages[0].ToImage({ scale: 1 }));
    expect(s.painted).toBeGreaterThan(5000);
    expect(s.colored.length).toBeGreaterThan(3000);
  });

  it('leaves no coloured pixel anywhere after conversion', () => {
    const doc = Document.Open(buildEverythingColorPdf());
    const report = doc.ConvertToGrayscale();
    const s = sweep(doc.Pages[0].ToImage({ scale: 1 }));

    // Name the offenders: a bare count says nothing about which construct leaked.
    expect(s.colored.slice(0, 20)).toEqual([]);
    expect(s.painted).toBeGreaterThan(5000);   // still drawn, just grey
    expect(report.skipped).toEqual([]);
  });

  it('survives a round trip through Save', () => {
    const doc = Document.Open(buildEverythingColorPdf());
    doc.ConvertToGrayscale();
    const reopened = Document.Open(doc.Save());
    expect(sweep(reopened.Pages[0].ToImage({ scale: 1 })).colored.slice(0, 20))
      .toEqual([]);
  });
});
