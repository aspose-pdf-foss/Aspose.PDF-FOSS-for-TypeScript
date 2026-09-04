import { describe, it, expect } from 'vitest';
import { colorOps, grayscaleOps } from '../src/colorops.js';
import type { ContentOp } from '../src/content.js';
import { name } from '../src/types.js';
import { Document } from '../src/document.js';
import {
  buildInlineImagePdf, buildInlineInFormPdf, buildConvertibleInlinePdf,
} from './helpers/build-inline-image-pdf.js';
import {
  buildBadAnnotColorPdf, buildUnresolvableSpacePdf,
} from './helpers/build-grayscale-pdf.js';

/**
 * What a colour conversion could not convert, and said so (85l8.4).
 *
 * The report shape landed with 85l8.1/85l8.2; what this file covers is the
 * holes in it. An inline image lives in the content stream and in no object,
 * so `convertImageSpace` never sees one and every decline was silent -- a `BI`
 * drawing full-colour samples survived a conversion that reported
 * `skipped: []`, which is exactly the reading the caller must not be given.
 *
 * The load-bearing half is the SILENT cases: a decline that had nothing to do
 * must report nothing, or every gray inline image in every gray conversion
 * produces a record and an empty `skipped` stops meaning anything.
 */
describe('colorOps — an inline image it cannot convert says so', () => {
  const bi = (dict: [string, unknown][], data: Uint8Array): ContentOp => ({
    operator: 'BI', operands: [],
    inlineImage: { dict: new Map(dict) as never, data },
  });

  const rgb = (extra: [string, unknown][] = []): ContentOp =>
    bi([['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8], ...extra],
      new Uint8Array(12));

  it('reports a filtered inline image, whose bytes it decodes nothing of', () => {
    const r = grayscaleOps([rgb([['F', name('Fl')]])], () => undefined);
    expect(r.changed).toBe(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image is filtered']);
  });

  it('reports the abbreviated and the spelled-out filter key alike', () => {
    const r = grayscaleOps([rgb([['Filter', name('FlateDecode')]])], () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image is filtered']);
  });

  it('reports a /Decode array, which restates the samples it would rewrite', () => {
    const r = grayscaleOps([rgb([['D', [1, 0, 1, 0, 1, 0]]])], () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image has a /Decode array']);
  });

  it('reports a bit depth it cannot address', () => {
    const r = grayscaleOps(
      [bi([['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 4]], new Uint8Array(6))],
      () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image BitsPerComponent 4 is not 8']);
  });

  it('names the colourspace it did not recognise', () => {
    const r = grayscaleOps(
      [bi([['W', 2], ['H', 2], ['CS', name('CS0')], ['BPC', 8]], new Uint8Array(12))],
      () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image colourspace CS0 is not a device space']);
  });

  it('reports an absent colourspace differently from an unrecognised one', () => {
    const r = grayscaleOps(
      [bi([['W', 2], ['H', 2], ['BPC', 8]], new Uint8Array(12))], () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image has no /CS']);
  });

  it('reports missing geometry', () => {
    const r = grayscaleOps(
      [bi([['H', 2], ['CS', name('RGB')], ['BPC', 8]], new Uint8Array(12))],
      () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image has missing or invalid /W or /H']);
  });

  it('reports a truncated payload with both lengths', () => {
    const r = grayscaleOps(
      [bi([['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8]], new Uint8Array(5))],
      () => undefined);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inline image has 5 sample bytes, expected 12']);
  });

  it('reports each declining image, in the order they are drawn', () => {
    const r = grayscaleOps(
      [rgb([['F', name('Fl')]]), rgb(), rgb([['D', [1, 0, 1, 0, 1, 0]]])],
      () => undefined);
    expect(r.changed).toBe(1);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'inline image is filtered', 'inline image has a /Decode array',
    ]);
  });
});

/**
 * The half that keeps `skipped: []` meaningful. Both of these decline, and
 * neither could have converted anything: an image mask carries no colour, and
 * an image already in the target space has nothing to change. Reporting either
 * would put a record on the commonest inline image in the commonest
 * conversion.
 */
describe('colorOps — a decline with nothing to do reports nothing', () => {
  const bi = (dict: [string, unknown][], data: Uint8Array): ContentOp => ({
    operator: 'BI', operands: [],
    inlineImage: { dict: new Map(dict) as never, data },
  });

  it('says nothing about an inline image mask', () => {
    const r = grayscaleOps(
      [bi([['W', 8], ['H', 1], ['IM', true]], new Uint8Array([0xff]))], () => undefined);
    expect(r.changed).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  it('says nothing about an image already in the target space', () => {
    const r = colorOps(
      [bi([['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8]], new Uint8Array(12))],
      () => undefined, 'rgb');
    expect(r.changed).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  /**
   * The target check must OUTRANK every reason, and this is the case that
   * forces it: `/CS` is in the dict rather than the payload, so an image
   * already in the target space needs nothing decoded and cannot fail to
   * convert however it is coded. `build-inline-image-pdf.ts` writes every
   * inline image as `/F /AHx`, so with the filter test first a gray
   * conversion of that document reports a skip for an image that had nothing
   * to convert.
   */
  it('says nothing about a filtered image already in the target space', () => {
    const r = grayscaleOps(
      [bi([['W', 1], ['H', 1], ['CS', name('G')], ['BPC', 8], ['F', name('AHx')]],
        new Uint8Array([0x80]))], () => undefined);
    expect(r.changed).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  it('says nothing about a stream that drew no inline image at all', () => {
    const r = grayscaleOps(
      [{ operator: 'rg', operands: [1, 0, 0] }], () => undefined);
    expect(r.skipped).toEqual([]);
  });
});

/**
 * The report the caller reads (85l8.4).
 *
 * `build-inline-image-pdf.ts` is the fixture rather than a new one because it
 * already exhibits the defect: both its inline images are `/F /AHx`, so before
 * this issue a conversion of it left a 2x2 RGB image drawing full colour and
 * reported `skipped: []`.
 */
describe('ConvertColors reports an inline image it could not convert', () => {
  const skips = (bytes: Uint8Array, to: 'gray' | 'rgb' | 'cmyk') =>
    Document.Open(bytes).ConvertColors({ to }).skipped;

  it('names the construct, the reason and the stream that drew it', () => {
    const doc = Document.Open(buildInlineImagePdf());
    const report = doc.ConvertColors({ to: 'cmyk' });
    expect(report.skipped).toEqual([
      { objNum: 5, what: 'inline-image', opIndex: 2, reason: 'inline image is filtered' },
      { objNum: 5, what: 'inline-image', opIndex: 6, reason: 'inline image is filtered' },
    ]);
  });

  /**
   * The discriminating case, and what the target-outranks-every-reason rule
   * buys end to end: the same document reports TWO skips converting to cmyk
   * and ONE converting to gray, because its 1x1 image is already gray. A
   * fixture asserting only the cmyk count cannot tell that rule from its
   * absence.
   */
  it('says nothing about the image that was already in the target space', () => {
    expect(skips(buildInlineImagePdf(), 'gray')).toEqual([
      { objNum: 5, what: 'inline-image', opIndex: 2, reason: 'inline image is filtered' },
    ]);
  });

  it('attributes an inline image inside a form to the FORM stream', () => {
    // Object 4 is the form; object 5 is the page content that draws it. An
    // inline image has no object of its own, so the containing stream is the
    // only address there is -- and naming the page would send a caller to a
    // stream holding no `BI` at all.
    expect(skips(buildInlineInFormPdf(), 'gray')).toEqual([
      { objNum: 4, what: 'inline-image', opIndex: 2, reason: 'inline image is filtered' },
    ]);
  });

  it('reports nothing for a document whose inline images all converted', () => {
    expect(skips(buildConvertibleInlinePdf(), 'gray')).toEqual([]);
  });
});

/**
 * An annotation colour array that states no readable colour (85l8.4).
 *
 * 32000-1 12.5.2 gives an annotation's colour its space by the array's LENGTH
 * -- 1 gray, 3 RGB, 4 CMYK -- so any other width states nothing. Two numbers
 * were read as RGB with blue 0 and an array holding no numbers was left alone
 * with nothing said; both are a colour the document keeps and the report
 * denied. This is also what makes `what: 'annotation'` reachable: the kind was
 * declared from the start and emitted by nothing.
 */
describe('ConvertColors reports an annotation colour it could not read', () => {
  it('reports the width it found and does not guess a space for it', () => {
    const doc = Document.Open(buildBadAnnotColorPdf());
    const report = doc.ConvertColors({ to: 'gray' });
    expect(report.skipped).toEqual([
      { objNum: 5, what: 'annotation', reason: '/C states 2 components, expected 1, 3 or 4' },
      { objNum: 6, what: 'annotation', reason: '/C states 0 components, expected 1, 3 or 4' },
      { objNum: 6, what: 'annotation', reason: '/IC states 5 components, expected 1, 3 or 4' },
    ]);
  });

  it('leaves an unreadable array exactly as the document wrote it', () => {
    const doc = Document.Open(buildBadAnnotColorPdf());
    doc.ConvertColors({ to: 'gray' });
    const annot = doc.Pages[0].Annotations[0];
    expect(annot.Dict.get('C')).toEqual([0.25, 0.5]);
  });

  // An empty array is legal and means *no colour*. A report there would fire
  // on every annotation that asked for no border, which is most of them.
  it('says nothing about an empty colour array', () => {
    const doc = Document.Open(buildBadAnnotColorPdf());
    const report = doc.ConvertColors({ to: 'gray' });
    expect(report.skipped.filter((s) => s.objNum === 7)).toEqual([]);
  });
});

/**
 * WHICH inline image declined, not just which stream (85l8.6).
 *
 * `objNum` names the stream and a stream may draw several, so on its own it
 * cannot say which `BI` was left in colour. `objNum` + `opIndex` is exact.
 *
 * Deliberately NOT a `ContentAddr`, though `inlineimage.ts` has one and
 * `InlineImageInfo.Addr` is public. Two reasons, both structural.
 * `ContentAddr.path` is an XOBJECT chain — `cowXObject` resolves every segment
 * through `/Resources /XObject` — but `collectScopes` also walks tiling
 * patterns, Type 3 `/CharProcs` and ExtGState `/SMask /G` groups, any of which
 * may hold a `BI` and none of which such a path can name. And a `ContentAddr`
 * is PAGE-relative while the scope walk dedupes by object number, so a form
 * reached from two pages has no single page to name. An object number and an
 * op index have neither problem and are uniform across all five scope kinds.
 */
describe('a reported inline image says which op it was', () => {
  it('gives the op index within its own stream', () => {
    const doc = Document.Open(buildInlineImagePdf());
    const report = doc.ConvertColors({ to: 'cmyk' });
    // q cm BI Q | q cm BI Q | q cm Do Q
    expect(report.skipped.map((s) => s.opIndex)).toEqual([2, 6]);
  });

  /**
   * Two rules are already pinned by the cases in the block above, which assert
   * the whole record and so gained `opIndex` when it did:
   *
   *   - it indexes the OP, not the declining images. Converting the same
   *     document to gray leaves one record and it still carries 2, where a
   *     counter over declining or over inline images would report 0.
   *   - it counts from the start of the stream `objNum` names, never the
   *     document: the form case reports 2 for an image inside a form whose
   *     page content has four ops of its own, so a walk-wide counter would
   *     have said 6.
   *
   * They are not repeated here.
   */

  // The other four kinds address an object, not an op inside one, so an index
  // there would be a number with nothing to index.
  it('says nothing about an op for a skip that is not an inline image', () => {
    const doc = Document.Open(buildUnresolvableSpacePdf());
    const report = doc.ConvertColors({ to: 'rgb' });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.what).toBe('content');
    expect(report.skipped[0]?.opIndex).toBeUndefined();
  });
});
