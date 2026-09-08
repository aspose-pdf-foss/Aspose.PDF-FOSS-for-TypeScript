import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf, type PdfaOptions } from './helpers/build-pdfa-pdf.js';

/** pjy7. Every case here is a CROSS-PART PAIR: the same fixture asserted as
 *  reported at each part whose veraPDF profile carries the check, and silent at
 *  each part that does not. A single-part assertion cannot tell a rule that
 *  widened correctly from one that widened too far.
 *
 *  Note part 1 passes headerVersion '1.4': the builder defaults to 1.7, which
 *  breaches the part-1 ceiling and adds a spurious Version error. */
const errs = (opts: PdfaOptions, part: 1 | 2 | 3 | 4, level: any) =>
  Document.Open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part))
    .ValidatePdfA(level).Errors.map((e) => e.rule);

const at1 = (o: PdfaOptions) => errs(o, 1, '1b');
const at2 = (o: PdfaOptions) => errs(o, 2, '2b');
const at3 = (o: PdfaOptions) => errs(o, 3, '3b');
const at4 = (o: PdfaOptions) => errs(o, 4, '4');

describe('pjy7 — ExtGState transfer functions', () => {
  it('reports /TR at every part', () => {
    expect(at1({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at2({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at3({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at4({ trExtGState: true })).toContain('ExtGStateKeys');
  });

  it('reports a non-/Default /TR2 at every part', () => {
    expect(at1({ tr2ExtGState: true })).toContain('ExtGStateKeys');
    expect(at2({ tr2ExtGState: true })).toContain('ExtGStateKeys');
    expect(at4({ tr2ExtGState: true })).toContain('ExtGStateKeys');
  });

  it('reports /HTO at part 4 ONLY - it is a PDF 2.0 key', () => {
    expect(at4({ htoExtGState: true })).toContain('ExtGStateKeys');
    expect(at1({ htoExtGState: true })).not.toContain('ExtGStateKeys');
    expect(at2({ htoExtGState: true })).not.toContain('ExtGStateKeys');
    expect(at3({ htoExtGState: true })).not.toContain('ExtGStateKeys');
  });

  it('cites the part-1 clause at part 1 and the part-2 clause at part 2', () => {
    // 19005-1 numbers this 6.2.8 and 19005-2/-3 number it 6.2.5. The clause is
    // what a caller acts on, so a backport that keeps citing -4 is half done.
    const one = Document.Open(buildPdfaPdf({ headerVersion: '1.4', trExtGState: true }, 1))
      .ValidatePdfA('1b').Errors.find((e) => e.rule === 'ExtGStateKeys');
    expect(one?.clause).toBe('ISO 19005-1 §6.2.8');
    const two = Document.Open(buildPdfaPdf({ trExtGState: true }, 2))
      .ValidatePdfA('2b').Errors.find((e) => e.rule === 'ExtGStateKeys');
    expect(two?.clause).toBe('ISO 19005-2 §6.2.5');
  });
});

describe('pjy7 — image and form XObject keys', () => {
  it('reports image /Alternates and /OPI at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ imageAlternates: true })).toContain('ImageKeys');
      expect(at({ imageOpi: true })).toContain('ImageKeys');
    }
  });

  it('reports Form XObject /OPI at every part', () => {
    // Filed at 6.2.4-2 in -1 (object PDXObject, so forms as well as images),
    // 6.2.9-1 in -2/-3 (object PDXForm, bundled with the PostScript test) and
    // 6.2.8.1-1 in -4. Three clause numbers, one test.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ formOpi: true })).toContain('FormXObjectOpi');
    }
  });

  it('reports a junk /BitsPerComponent at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ badBitsPerComponent: true })).toContain('ImageKeys');
    }
  });

  it('reports a 16-bit image at part 1 ONLY - PDF 1.4 had no 16-bit images', () => {
    // The sharpest divergence in this backport: a document that converts clean
    // to 2b can legitimately fail 1b for the same image.
    expect(at1({ bpc16Image: true })).toContain('ImageKeys');
    expect(at2({ bpc16Image: true })).not.toContain('ImageKeys');
    expect(at3({ bpc16Image: true })).not.toContain('ImageKeys');
    expect(at4({ bpc16Image: true })).not.toContain('ImageKeys');
  });
});

describe('pjy7 — appearance dictionary holds only /N', () => {
  it('reports a /D appearance at every part', () => {
    // ISO 19005-1 6.5.3-4 and -2/-3 6.3.3-2 carry the same test as -4's 6.3.3-1.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ apWithDown: true })).toContain('AppearanceKeys');
    }
  });

  it('leaves an /N-only appearance alone at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ hiddenAnnot: true })).not.toContain('AppearanceKeys');
    }
  });
});

describe('pjy7 — Widget actions, where parts 1-3 are STRICTER than part 4', () => {
  it('reports a Widget /A at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ widgetWithAction: true })).toContain('WidgetAction');
    }
  });

  it('reports a Widget /AA at parts 1-3 and NOT at part 4', () => {
    // ISO 19005-1 6.6.2-1 and -2/-3 6.4.1-1 ban a Widget's /AA outright;
    // 19005-4 6.6.3-1 EXEMPTS it, "whose triggers are the form's". Widening
    // part 4 to match would report a document ISO 19005-4 permits.
    expect(at1({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at2({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at3({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at4({ widgetWithAA: true })).not.toContain('WidgetAction');
  });

  it('leaves a NON-widget annotation with /AA alone at every part', () => {
    // additionalActionsRule owns that case; this rule is Widget-only, and a
    // rule that fires on both would double-report the same dictionary.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ additionalAction: true })).not.toContain('WidgetAction');
    }
  });
});

describe('pjy7 — the checks that start at part 2', () => {
  it('reports a prohibited halftone type at parts 2-4 and not at part 1', () => {
    expect(at1({ badHalftone: true })).not.toContain('Halftone');
    expect(at2({ badHalftone: true })).toContain('Halftone');
    expect(at3({ badHalftone: true })).toContain('Halftone');
    expect(at4({ badHalftone: true })).toContain('Halftone');
  });

  it('reports /HalftoneName at parts 2-4 and not at part 1', () => {
    expect(at1({ halftoneName: true })).not.toContain('Halftone');
    expect(at2({ halftoneName: true })).toContain('Halftone');
    expect(at4({ halftoneName: true })).toContain('Halftone');
  });

  it('reports catalog /NeedsRendering at parts 2-4 and not at part 1', () => {
    expect(at1({ needsRendering: true })).not.toContain('NeedsRendering');
    expect(at2({ needsRendering: true })).toContain('NeedsRendering');
    expect(at3({ needsRendering: true })).toContain('NeedsRendering');
    expect(at4({ needsRendering: true })).toContain('NeedsRendering');
  });

  it('reports a missing transparency blending space at parts 2-4 and not at part 1', () => {
    // Part 1 bans transparency groups outright (Transparency), so the /CS rule
    // has nothing to attach to - which is why the part-1 half asserts the
    // ABSENCE of TransparencyBlendingSpace and not the absence of all errors.
    const o = { groupNoCs: true, omitOutputIntent: true, deviceColorContent: false };
    expect(at1(o)).not.toContain('TransparencyBlendingSpace');
    expect(at2(o)).toContain('TransparencyBlendingSpace');
    expect(at4(o)).toContain('TransparencyBlendingSpace');
  });

  it('reports /DestOutputProfileRef on a PDF/A intent at parts 2-4, not part 1', () => {
    expect(at1({ destOutputProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at2({ destOutputProfileRef: true })).toContain('OutputIntentKeys');
    expect(at4({ destOutputProfileRef: true })).toContain('OutputIntentKeys');
  });

  it('EXEMPTS /DestOutputProfileRef on a GTS_PDFX intent at parts 2-3 only', () => {
    // 19005-2/-3 6.2.3-3 is `S != 'GTS_PDFX' || containsDestOutputProfileRef ==
    // false`; 19005-4's is unconditional. Flattening either way is a plausible
    // wrong answer, so both directions are asserted.
    expect(at2({ pdfxIntentProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at3({ pdfxIntentProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at4({ pdfxIntentProfileRef: true })).toContain('OutputIntentKeys');
  });

  it('keeps the surplus-PDF/A-intent count rule at part 4 alone', () => {
    // Parts 2/3 require `sameOutputProfileIndirect` instead, which
    // outputIntentRule already reports as 'multiple' - so backporting the count
    // rule would report a shape those standards permit.
    expect(at4({ twoPdfaOutputIntents: true })).toContain('OutputIntentKeys');
    expect(at2({ twoPdfaOutputIntents: true })).not.toContain('OutputIntentKeys');
  });
});

describe('pjy7 — a pre-existing part-1 false positive this work surfaced', () => {
  it('does not report transparency for an ExtGState with NO /SMask', () => {
    // ctx.R(dict.get('SMask')) returns NULL for an absent key, and
    // `null !== undefined` is true - the exact trap CLAUDE.md records for this
    // file. Every part-1 ExtGState therefore reported a soft mask it does not
    // have. It never fired because no part-1 fixture had an ExtGState at all
    // until pjy7's cross-part pairs gave one to part 1.
    expect(at1({ trExtGState: true })).not.toContain('Transparency');
    expect(at1({ tr2ExtGState: true })).not.toContain('Transparency');
  });

  it('still reports the ExtGState transparency part 1 really does prohibit', () => {
    expect(at1({ lowAlpha: true })).toContain('Transparency');        // /ca 0.5
    expect(at1({ nonStandardBlend: true })).toContain('Transparency'); // /BM /FunkyBlend
  });
});
