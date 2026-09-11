import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildDescriptorFontPdf, buildSimpleTextPdf } from './helpers/build-text-pdf.js';

/**
 * A non-embedded font we cannot identify draws BOXES, not Latin letters
 * (`lqcs.4`).
 *
 * `normalizeFont` maps every unrecognised `/BaseFont` onto one of the
 * Standard 14, defaulting to Helvetica — so a non-embedded Wingdings drew
 * letters, confidently and wrongly. The mechanism is worth stating because it
 * is not obvious: `resolveSimpleEncoding` defaults a font with NO `/Encoding`
 * to WinAnsi, so Wingdings' code 0x6C yields the text `l`, and the Helvetica
 * substitute HAS an `l`. A box says "this glyph is missing"; a letter says
 * something the document does not.
 *
 * **The trigger is a CONJUNCTION, and clause 3 is the load-bearing one.**
 * `glyphusage.ts` records that the `/Flags` symbolic bit is "widely wrong in
 * the wild", so boxing on the flag alone would turn a mis-flagged TEXT font
 * into a page of boxes — worse than the bug being fixed. Requiring that the
 * font ALSO states no encoding is what makes it safe: a producer that
 * mis-sets the flag on a text font still names WinAnsi or Differences.
 */

/** Ink pixels in a rendered page. */
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

const render = (pdf: Uint8Array) => Document.Open(pdf).Pages[0].ToImage();
const SHOW = 'BT /F1 48 Tf 20 100 Td (lmno) Tj ET';

/** Flags bit 3 (value 4) is Symbolic; bit 6 (value 32) is Nonsymbolic. */
const SYMBOLIC = 4;
const NONSYMBOLIC = 32;

describe('an unidentifiable symbolic font draws boxes', () => {
  it('draws far less ink than the same string in a real face', () => {
    const boxes = inkCount(render(buildDescriptorFontPdf(SHOW, {
      baseFont: 'Wingdings-Regular', flags: SYMBOLIC,
    })));
    const letters = inkCount(render(buildSimpleTextPdf(SHOW)));

    // An assertion that ink merely appears passes on the unfixed build — see
    // lqcs.1 — and so does a loose "they differ". What the BUG produces is a
    // render EXACTLY equal to the Helvetica one, because it IS that render, so
    // inequality is the precise statement of the defect.
    expect(boxes).not.toBe(letters);
    // Direction and magnitude: placeholder boxes are HAIRLINE outlines where
    // real glyphs are filled. Measured, 775 against 1341.
    expect(boxes).toBeGreaterThan(0);
    expect(boxes).toBeLessThan(letters * 0.7);
  });

  // CLAUSE 3, and it is why this feature is a conjunction rather than a flag
  // test. Same symbolic flag, but the font states an encoding, so its codes
  // have a meaning we can read and a Latin substitute is the right answer.
  it('still draws letters for a symbolic-flagged font that states an encoding', () => {
    const stated = inkCount(render(buildDescriptorFontPdf(SHOW, {
      baseFont: 'Wingdings-Regular', flags: SYMBOLIC, encoding: 'WinAnsiEncoding',
    })));
    const letters = inkCount(render(buildSimpleTextPdf(SHOW)));
    expect(stated).toBe(letters);
  });

  it('still draws letters when /Differences names the glyphs', () => {
    const stated = inkCount(render(buildDescriptorFontPdf(SHOW, {
      baseFont: 'Wingdings-Regular', flags: SYMBOLIC, differences: '108 /l /m /n /o',
    })));
    // The array names the same four glyphs WinAnsi would, so this is the
    // Helvetica render exactly — the font stated what its codes mean, and a
    // substitute is the right answer for it.
    expect(stated).toBe(inkCount(render(buildSimpleTextPdf(SHOW))));
  });

  // Both bits set is a producer hedging; 32000-1 makes them exclusive, and
  // pdfaconvert.ts already reads it this way.
  it('does not box when the Nonsymbolic bit is set beside the Symbolic one', () => {
    const both = inkCount(render(buildDescriptorFontPdf(SHOW, {
      baseFont: 'Wingdings-Regular', flags: SYMBOLIC | NONSYMBOLIC,
    })));
    const letters = inkCount(render(buildSimpleTextPdf(SHOW)));
    expect(both).toBe(letters);
  });

  // CLAUSE 2. A name we recognise is not unidentifiable, whatever the flags
  // say -- and Symbol IS symbolic, so this is the acceptance criterion that
  // the Standard-14 symbolic faces are untouched.
  it('leaves Symbol and ZapfDingbats alone', () => {
    for (const face of ['Symbol', 'ZapfDingbats']) {
      const flagged = inkCount(render(buildDescriptorFontPdf(SHOW, {
        baseFont: face, flags: SYMBOLIC,
      })));
      const plain = inkCount(render(buildSimpleTextPdf(SHOW, { baseFont: face, encoding: null })));
      expect(flagged).toBe(plain);
      expect(flagged).toBeGreaterThan(0);
    }
  });

  it('still resolves a non-embedded Arial to Helvetica', () => {
    const arial = inkCount(render(buildDescriptorFontPdf(SHOW, {
      baseFont: 'Arial', flags: SYMBOLIC,
    })));
    const helv = inkCount(render(buildSimpleTextPdf(SHOW)));
    expect(arial).toBe(helv);
  });

  it('does not box a font with no descriptor at all', () => {
    const none = inkCount(render(buildSimpleTextPdf(SHOW, { baseFont: 'Wingdings-Regular', encoding: null })));
    expect(none).toBeGreaterThan(0);
  });
});
