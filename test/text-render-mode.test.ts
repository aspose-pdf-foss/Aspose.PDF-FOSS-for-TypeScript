import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { type3Pdf } from './helpers/build-type3.js';

/**
 * Text rendering mode (`Tr`, ISO 32000-1 Table 106), issue 4gtd.1.
 *
 * The interpreter had no `Tr` case at all, so text was always filled. Mode 3 is
 * what every OCR tool writes over a scanned page, so `ToImage`, `ToSvg` and both
 * fixed-layout backdrops painted a black transcription on top of the scan.
 *
 * **Extraction must NOT change.** Invisible text is exactly what an OCR layer is
 * for, and `GetText` is how a caller reads it — so every case here that asserts
 * no ink asserts the string is still extracted beside it.
 */

/** A show at 48pt near the bottom-left of the 300x300 page the builder makes. */
const show = (pre: string) => `BT /F1 48 Tf 20 100 Td ${pre}(H) Tj ET`;

/** Count pixels that are not the white page background. */
function inkCount(bytes: Uint8Array): number {
  const png = decodePng(bytes);
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r !== 255 || g !== 255 || b !== 255) n++;
    }
  }
  return n;
}

const inkOf = (stream: string) =>
  inkCount(Document.Open(buildSimpleTextPdf(stream)).Pages[0].ToImage());

describe('Tr text rendering mode - mode 3 (invisible)', () => {
  it('paints no ink under "3 Tr" while the control mode 0 does', () => {
    expect(inkOf(show(''))).toBeGreaterThan(0);          // control: mode 0 fills
    expect(inkOf(show('3 Tr '))).toBe(0);
  });

  it('still extracts the text of an invisible run', () => {
    const doc = Document.Open(buildSimpleTextPdf(show('3 Tr ')));
    expect(doc.Pages[0].GetText()).toContain('H');
  });

  it('emits no <text> element in ToSvg under "3 Tr"', () => {
    const svg = Document.Open(buildSimpleTextPdf(show('3 Tr '))).Pages[0].ToSvg();
    expect(svg).not.toContain('<text');
  });

  it('drops the run from fixed-mode ToHtml, the third backend', () => {
    // htmlfixed.ts is a sink like the other two, so it inherits the gate rather
    // than implementing the rule — asserted because the OCR defect this issue
    // fixes reached ToHtml and the DOCX textbox backdrop through this path too.
    const lit = Document.Open(buildSimpleTextPdf(show(''))).Pages[0].ToHtml({ mode: 'fixed' });
    expect(lit).toContain('>H<');
    const dark = Document.Open(buildSimpleTextPdf(show('3 Tr '))).Pages[0].ToHtml({ mode: 'fixed' });
    expect(dark).not.toContain('>H<');
  });
});

/**
 * Mode 1 strokes the glyph outlines instead of filling them.
 *
 * **The probe point is the trap, and the first version of this got it wrong.**
 * A big `O` is the fixture, but NOT its centre: an `O` is a ring, so its counter
 * is page white under a fill and under a stroke alike and discriminates nothing.
 * What separates them is the middle of the RING BODY — solid under a fill, and
 * between the two thin outlines under a stroke. Measured on the rendered page
 * rather than guessed: at 120pt the ring occupies x 65..77 on row 159, so x 71
 * sits 6px clear of either edge.
 */
const bigO = (pre: string) => `BT /F1 120 Tf 60 100 Td ${pre}(O) Tj ET`;

/** Middle of the O's left ring body (see above). */
const O_RING: [number, number] = [71, 159];

const pixelAt = (stream: string, p: [number, number]) =>
  decodePng(Document.Open(buildSimpleTextPdf(stream)).Pages[0].ToImage()).at(p[0], p[1]);

describe('Tr text rendering mode - mode 1 (stroke)', () => {
  it('leaves the middle of the ring unpainted where mode 0 fills it', () => {
    expect(pixelAt(bigO(''), O_RING)).toEqual([0, 0, 0, 255]);          // control: filled
    expect(pixelAt(bigO('1 Tr '), O_RING)).toEqual([255, 255, 255, 255]);
  });

  it('still paints the outline, and less of it than a fill', () => {
    const stroked = inkOf(bigO('1 Tr '));
    expect(stroked).toBeGreaterThan(0);
    expect(stroked).toBeLessThan(inkOf(bigO('')));
  });

  it('emits fill="none" plus a stroke on the ToSvg <text>', () => {
    // SVG expresses the mode natively, so this is the whole of the SVG half —
    // and it needs its own case: the mode-3 assertion above is satisfied by the
    // interpreter's gate and reaches none of svgrender.ts's attribute code.
    const svg = Document.Open(buildSimpleTextPdf(
      'BT /F1 120 Tf 60 100 Td 0 0 1 RG 8 w 1 Tr (O) Tj ET',
    )).Pages[0].ToSvg();
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="#0000ff"');
    expect(svg).toContain('stroke-width="8"');
  });

  it('scales the stroke width by the CTM', () => {
    // The line width is user-space, so a `cm` scale thickens a stroked glyph
    // exactly as it thickens a stroked path. **Measured load-bearing the hard
    // way:** every other fixture here renders at scale 1, where `ctmScale` is 1
    // and dropping it changes nothing — this is the only case that can see it.
    // 2x CTM with `4 w` puts the device half-width at 4, so each of the ring's
    // two outlines is ~8px; without the scale they are ~4px.
    const png = decodePng(Document.Open(buildSimpleTextPdf(
      '2 0 0 2 0 0 cm BT /F1 60 Tf 30 50 Td 4 w 1 Tr (O) Tj ET',
    )).Pages[0].ToImage());
    let width = 0, run = 0;
    for (let x = 0; x < png.width; x++) {          // row 159 crosses the ring
      const [r, g, b] = png.at(x, 159);
      if (r !== 255 || g !== 255 || b !== 255) { run++; width = Math.max(width, run); }
      else run = 0;
    }
    expect(width).toBeGreaterThanOrEqual(7);
  });

  it('strokes in the stroke colour, not the fill colour', () => {
    // Red fill, blue stroke: a build that strokes with the fill paint is red.
    const png = decodePng(Document.Open(buildSimpleTextPdf(
      'BT /F1 120 Tf 60 100 Td 1 0 0 rg 0 0 1 RG 8 w 1 Tr (O) Tj ET',
    )).Pages[0].ToImage());
    const seen = new Set<string>();
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const [r, g, b] = png.at(x, y);
        if (r !== 255 || g !== 255 || b !== 255) seen.add(`${r},${g},${b}`);
      }
    }
    expect(seen.has('0,0,255')).toBe(true);
    expect(seen.has('255,0,0')).toBe(false);
  });
});

/**
 * A Type 3 glyph is a content stream, so it never reaches a sink's `glyphRun` —
 * it is interpreted and the sinks see only the primitives it draws. That is
 * exactly why the non-painting gate sits in `showText` above BOTH branches: a
 * gate inside `paintGlyphRun` would let every Type 3 run paint under mode 3.
 */
describe('Tr text rendering mode - Type 3 fonts', () => {
  it('draws nothing for a Type 3 run under "3 Tr"', () => {
    const lit = inkCount(Document.Open(type3Pdf()).Pages[0].ToImage());
    expect(lit).toBeGreaterThan(0);                                // control
    const dark = inkCount(Document.Open(type3Pdf({
      content: 'BT /T3 50 Tf 1 0 0 rg 20 20 Td 3 Tr (aa) Tj ET',
    })).Pages[0].ToImage());
    expect(dark).toBe(0);
  });
});

/**
 * Text state IS graphics state (9.3.1). Both halves render a perfectly plausible
 * page when wrong — the text is simply visible where it should not be — so each
 * is asserted directly rather than left to the mode-3 case above.
 */
describe('Tr is graphics state', () => {
  it('is restored by Q, so text after the block is visible again', () => {
    expect(inkOf(`q BT /F1 48 Tf 20 100 Td 3 Tr (H) Tj ET Q ${show('')}`))
      .toBeGreaterThan(0);
  });

  it('set inside a q block still suppresses the run in that block', () => {
    expect(inkOf('q BT /F1 48 Tf 20 100 Td 3 Tr (H) Tj ET Q')).toBe(0);
  });

  it('survives BT, which initialises the text matrices and nothing else', () => {
    // `3 Tr` OUTSIDE the text object, then a text object that never sets a mode:
    // BT must not reset it. Two text objects, so a reset at the second BT shows.
    expect(inkOf('3 Tr BT /F1 48 Tf 20 100 Td (H) Tj ET BT /F1 48 Tf 20 200 Td (H) Tj ET'))
      .toBe(0);
  });
});
