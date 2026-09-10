import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';
import { buildBmp } from './helpers/build-bmp.js';
import { PageFormat } from '../src/pageformat.js';

/**
 * `/OC` on an OBJECT rather than on a marked-content section (q1g2.2).
 *
 * A layer marks content a page's own stream shows; an `/OC` on an XObject or an
 * annotation dictionary is the other half of the vocabulary — and it is the half
 * this library itself WRITES, from four places: `Annotation.Layer`,
 * `AddBarcode({ layer })`, `AddImage({ layer })` and `ImageInfo.Replace`'s `/OC`
 * carry-over. So before this, `page.AddImage({ layer })` followed by hiding that
 * layer produced a document whose own renderer painted the image anyway.
 */

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

/** Where each object's ink lands on the 200x200 page (device y grows down). */
const IN_FORM: [number, number] = [30, 170];    // /Fm0 at cm 10 10, 40x40 green
const IN_IMAGE: [number, number] = [60, 80];    // /Im0 stretched, magenta
const IN_ANNOT: [number, number] = [140, 170];  // /Rect [120 10 160 50], cyan

const DRAW_FORM = 'q 1 0 0 1 10 10 cm /Fm0 Do Q\n';
const DRAW_IMAGE = 'q 100 0 0 40 10 100 cm /Im0 Do Q\n';

const pixels = (bytes: Uint8Array) => {
  const png = decodePng(Document.Open(bytes).Pages[0].ToImage());
  return (p: [number, number]) => png.at(p[0], p[1]);
};

describe('/OC on an XObject', () => {
  it('paints no FORM whose /OC names a hidden layer, and paints it when shown', () => {
    expect(pixels(buildOcgRenderPdf(DRAW_FORM, { formOc: '7 0 R' }))(IN_FORM))
      .toEqual(WHITE);
    expect(pixels(buildOcgRenderPdf(DRAW_FORM, { formOc: '7 0 R', off: [] }))(IN_FORM))
      .toEqual([0, 255, 0, 255]);
  });

  it('paints no IMAGE whose /OC names a hidden layer, and paints it when shown', () => {
    // Both subtypes go through one `Do` case, so this and the form case together
    // are what say the check is on the XObject rather than on a subtype.
    expect(pixels(buildOcgRenderPdf(DRAW_IMAGE, { imageOc: '7 0 R' }))(IN_IMAGE))
      .toEqual(WHITE);
    expect(pixels(buildOcgRenderPdf(DRAW_IMAGE, { imageOc: '7 0 R', off: [] }))(IN_IMAGE))
      .toEqual([255, 0, 255, 255]);
  });

  it('honours membership through an /OCMD', () => {
    // Object 12 is `<< /Type /OCMD /OCGs [7 0 R] >>` — membership through an
    // OCMD counts as membership, which ResolveVisibility already implements.
    expect(pixels(buildOcgRenderPdf(DRAW_FORM, { formOc: '12 0 R' }))(IN_FORM))
      .toEqual(WHITE);
    expect(pixels(buildOcgRenderPdf(DRAW_FORM, { formOc: '12 0 R', off: [] }))(IN_FORM))
      .toEqual([0, 255, 0, 255]);
  });

  it('paints an XObject whose /OC names a VISIBLE layer', () => {
    expect(pixels(buildOcgRenderPdf(DRAW_FORM, { formOc: '6 0 R' }))(IN_FORM))
      .toEqual([0, 255, 0, 255]);
  });
});

describe('a layer this library itself authored', () => {
  it('hides an image added with AddImage({ layer })', () => {
    // The case a synthetic fixture would miss, and the one that says the bug
    // was ours rather than a foreign producer's: `AddImage({ layer })` WRITES
    // the /OC, so before this the renderer ignored a layer the library had just
    // created. Round-tripped through Save so the check runs against the real
    // object graph rather than a live in-memory one.
    const build = (visible: boolean) => {
      const doc = Document.New();
      doc.AddPage(PageFormat.custom(200, 200));
      const layer = doc.OptionalContent.AddLayer('Logo');
      const bmp = buildBmp({
        width: 2, height: 2, bpp: 24,
        rows: [[0, 0, 0xff, 0, 0, 0xff, 0, 0], [0, 0, 0xff, 0, 0, 0xff, 0, 0]],
      });
      // rect is [x, y, WIDTH, HEIGHT], so this lands at device y 130..190.
      doc.Pages[0].AddImage(bmp, [10, 10, 60, 60], { layer });
      layer.Visible = visible;
      return doc.Save();
    };
    expect(pixels(build(true))([40, 160])).toEqual([255, 0, 0, 255]);   // control
    expect(pixels(build(false))([40, 160])).toEqual(WHITE);
  });
});

describe('/OC on an annotation', () => {
  it('composites no annotation whose /OC names a hidden layer', () => {
    expect(pixels(buildOcgRenderPdf('', { annotOc: '7 0 R' }))(IN_ANNOT)).toEqual(WHITE);
  });

  it('composites it when the layer is shown', () => {
    expect(pixels(buildOcgRenderPdf('', { annotOc: '7 0 R', off: [] }))(IN_ANNOT))
      .toEqual([0, 255, 255, 255]);
  });

  it('is not baked into page content by FlattenAnnotations', () => {
    // The reason the check lives in `isAnnotVisible` rather than in the render
    // pass: that function's contract is that render and flatten AGREE about
    // what is painted. Flattening a hidden-layer annotation would make hidden
    // ink permanent — visible in a document where the layer is still off.
    const doc = Document.Open(buildOcgRenderPdf('', { annotOc: '7 0 R' }));
    doc.Pages[0].FlattenAnnotations();
    expect(pixels(doc.Save())(IN_ANNOT)).toEqual(WHITE);
  });

  it('flattens the same annotation when its layer is shown', () => {
    const doc = Document.Open(buildOcgRenderPdf('', { annotOc: '7 0 R', off: [] }));
    doc.Pages[0].FlattenAnnotations();
    expect(pixels(doc.Save())(IN_ANNOT)).toEqual([0, 255, 255, 255]);
  });

  it('drops its DRAWN text from SearchAnnotations but keeps the CARRIED text', () => {
    // The deliberate asymmetry, asserted so it reads as a decision.
    // SearchAnnotations reports what a render draws — so a hidden layer removes
    // it. SearchAnnotationText reports what the FILE CARRIES, and reads every
    // annotation including Hidden and NoView ones, which its own invariant
    // demands and redaction depends on.
    const page = Document.Open(buildOcgRenderPdf('', { annotOc: '7 0 R' })).Pages[0];
    expect(page.SearchAnnotations('secretword')).toHaveLength(0);
    expect(page.SearchAnnotationText('carried text')).toHaveLength(1);

    const shown = Document.Open(buildOcgRenderPdf('', { annotOc: '7 0 R', off: [] })).Pages[0];
    expect(shown.SearchAnnotations('secretword')).toHaveLength(1);
  });

  it('does not create /OCProperties while deciding an annotation is visible', () => {
    // `isAnnotVisible` is a PREDICATE and must not write. Reaching the config
    // through `OptionalContent.Default` would call ensureOcProps, creating
    // /OCProperties and marking the document modified — turning a render, a
    // flatten or a SEARCH into a write, and a sign-on-save into a full rewrite.
    //
    // **q1g2.1's equivalent case cannot reach this branch**: its fixture has no
    // annotations at all, so `annot.get('OC')` is never consulted. This one has
    // an annotation WITH an /OC and a catalog WITHOUT /OCProperties, which is
    // the only shape that exercises the read-only accessor here.
    const doc = Document.Open(buildOcgRenderPdf('', {
      annotOc: '7 0 R', noOcProperties: true,
    }));
    doc.Pages[0].ToImage();
    doc.Pages[0].SearchAnnotations('secretword');
    expect(doc.catalog().has('OCProperties')).toBe(false);
  });

  it('is honoured in ToSvg as well as ToImage', () => {
    // The acceptance criterion names both backends. They share `interpret`, so
    // this asserts the check sits there rather than in one sink.
    const hidden = Document.Open(buildOcgRenderPdf(DRAW_FORM, { formOc: '7 0 R' }))
      .Pages[0].ToSvg();
    const shown = Document.Open(buildOcgRenderPdf(DRAW_FORM, { formOc: '7 0 R', off: [] }))
      .Pages[0].ToSvg();
    expect(hidden).not.toContain('0,255,0');
    expect(hidden).not.toContain('#00ff00');
    expect(shown).toContain('#00ff00');
  });
});
