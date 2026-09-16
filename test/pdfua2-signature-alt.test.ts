import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotPdf, type AnnotPdfSpec } from './helpers/build-annot-pdf.js';
import { name } from '../src/types.js';

const ids = (spec: AnnotPdfSpec, part: 1 | 2): string[] =>
  Document.Open(buildAnnotPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. */
function expectPair(spec: AnnotPdfSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

/** A signature widget: a Widget whose /FT is /Sig. That is exactly
 *  `GFPDWidgetAnnot.isSignature` — `ASAtom.SIG.equals(getFT())`. */
const sig = (over: Record<string, unknown> = {}) => ({
  subtype: 'Widget',
  extra: { FT: name('Sig') },
  under: ['Form'],
  ...over,
} as never);

describe('PDF/UA-2 8.10.3.5-1: a signature graphic needs alternative text', () => {
  it('reports a signature whose appearance paints a graphic with no /Alt', () => {
    expectPair({ annots: [sig({ ap: 'graphic' })] }, 'SignatureGraphicAlt');
  });

  it('is silent once the enclosing element carries /Alt', () => {
    expect(ids({ annots: [sig({ ap: 'graphic', alt: 'Signed by A. Person' })] }, 2))
      .not.toContain('SignatureGraphicAlt');
  });

  it('accepts an /Alt INHERITED from an ancestor, not just the direct parent', () => {
    // veraPDF reads `groupedContent.getInheritedAlt()`. Note this is the
    // OPPOSITE of 8.4.3-1, which reads the glyph's own element DIRECTLY -- two
    // rules of the same standard, two different lookups, and each is pinned.
    expect(ids({
      annots: [sig({ ap: 'graphic', under: ['Sect', 'Form'], outerAlt: 'Signature' })],
    }, 2)).not.toContain('SignatureGraphicAlt');
  });

  it('is silent when the appearance paints only TEXT', () => {
    // The clause is about a GRAPHIC portion of the appearance. A typed name is
    // not one, and reporting it would fire on every ordinary signature field.
    expect(ids({ annots: [sig({ ap: 'text' })] }, 2))
      .not.toContain('SignatureGraphicAlt');
  });

  it('is silent when the appearance paints nothing', () => {
    expect(ids({ annots: [sig({ ap: 'empty' })] }, 2))
      .not.toContain('SignatureGraphicAlt');
  });

  it('is silent for a widget with no appearance at all', () => {
    expect(ids({ annots: [sig()] }, 2)).not.toContain('SignatureGraphicAlt');
  });

  it('is silent for a NON-signature widget painting the same graphic', () => {
    // isSignature is /FT /Sig and nothing else. Without that test every button
    // with an icon would report.
    expect(ids({
      annots: [{ subtype: 'Widget', extra: { FT: name('Btn') }, under: ['Form'], ap: 'graphic' }],
    }, 2)).not.toContain('SignatureGraphicAlt');
  });

  it('is silent for a signature that is an ARTIFACT', () => {
    // Every artifact rule of 8.9/8.10 carries the same escape, and a graphic
    // declared decorative needs no alternative text.
    expect(ids({
      annots: [sig({ ap: 'graphic', under: ['Artifact'] })],
    }, 2)).not.toContain('SignatureGraphicAlt');
  });

  it('is silent for a signature OUTSIDE the structure tree', () => {
    // `structParentType == null` passes, which is the anchor's rule for every
    // annotation rule in these clauses -- UntaggedContent covers that case.
    expect(ids({ annots: [sig({ under: undefined, ap: 'graphic' })] }, 2))
      .not.toContain('SignatureGraphicAlt');
  });

  it('reports ONCE per signature, not once per painting operator', () => {
    const hits = Document.Open(buildAnnotPdf({ annots: [sig({ ap: 'graphic' })] }))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'SignatureGraphicAlt');
    expect(hits).toHaveLength(1);
  });
});
