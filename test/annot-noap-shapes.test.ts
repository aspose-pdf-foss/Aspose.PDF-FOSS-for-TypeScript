// A shape annotation with NO /AP is drawn at render time, from the same
// builder the import path uses (kapw). A producer may legally leave appearance
// generation to the viewer; before this, eleven subtypes regenerateAppearance
// already knew how to draw were absent from the fallback.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotTarget, buildBlankPage } from './helpers/build-annot-target.js';
import { resolveAppearance } from '../src/annotappearance.js';
import { regenerateAppearance } from '../src/annotdraw.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';
import { buildSigner } from './helpers/build-signer.js';

/** A bare annotation dict of `subtype`, and a document to own any objects. */
function attach(subtype: string, entries: [string, PdfObject][]): { doc: Document; dict: PdfDict } {
  const doc = Document.Open(buildAnnotTarget());
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name(subtype)], ...entries,
  ]);
  return { doc, dict };
}

/** The body the no-/AP fallback draws for `dict`. */
function fallbackBody(doc: Document, dict: PdfDict): string | undefined {
  const ap = resolveAppearance(doc, dict);
  return ap === undefined ? undefined : new TextDecoder('latin1').decode(ap.stream.raw);
}

/** The body regenerateAppearance installs for the same dict. */
function regeneratedBody(doc: Document, dict: PdfDict): string | undefined {
  const copy: PdfDict = new Map(dict);
  if (!regenerateAppearance(doc, copy)) return undefined;
  const apd = doc.resolve(copy.get('AP')) as PdfDict;
  const n = doc.resolve(apd.get('N'));
  return isStream(n) ? new TextDecoder('latin1').decode(n.raw) : undefined;
}

/** One dict per subtype the fallback must now cover. */
const SHAPES: Array<[string, [string, PdfObject][]]> = [
  ['Square', [['Rect', [0, 0, 120, 80]], ['C', [1, 0, 0]], ['IC', [0, 0, 1]]]],
  ['Circle', [['Rect', [0, 0, 80, 40]], ['C', [0, 0, 0]]]],
  ['Line', [['Rect', [0, 0, 100, 50]], ['L', [5, 5, 95, 45]], ['C', [0, 0, 0]]]],
  ['Polygon', [['Rect', [0, 0, 140, 100]], ['Vertices', [20, 20, 120, 20, 70, 80]], ['C', [0, 0, 1]]]],
  ['PolyLine', [['Rect', [0, 0, 140, 100]], ['Vertices', [20, 20, 120, 20, 70, 80]], ['C', [0, 0, 1]]]],
  ['Ink', [['Rect', [0, 0, 100, 60]], ['InkList', [[5, 5, 50, 40, 95, 10]]], ['C', [0, 0, 0]]]],
  ['Caret', [['Rect', [0, 0, 40, 40]], ['C', [0, 0, 0]]]],
  ['Highlight', [['Rect', [0, 0, 100, 20]], ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]], ['C', [1, 1, 0]]]],
  ['Underline', [['Rect', [0, 0, 100, 20]], ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]], ['C', [0, 0, 1]]]],
  ['StrikeOut', [['Rect', [0, 0, 100, 20]], ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]], ['C', [1, 0, 0]]]],
  ['Squiggly', [['Rect', [0, 0, 100, 20]], ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]], ['C', [0, 1, 0]]]],
];

describe('shapes with no /AP draw at render time (kapw)', () => {
  it.each(SHAPES)('draws a /%s with no /AP', (subtype, entries) => {
    const { doc, dict } = attach(subtype, entries);
    const body = fallbackBody(doc, dict);
    expect(body).toBeDefined();
    // ONE builder: the fallback draws exactly what the import path installs.
    // Asserting only that something was drawn would pass for a second,
    // divergent body — the failure this whole arrangement exists to prevent.
    expect(body).toBe(regeneratedBody(doc, dict));
    // …and it is not empty, which the equality alone would tolerate.
    expect(body!.length).toBeGreaterThan(20);
  });

  it('draws a cloud border with no /AP, which regeneration alone could not', () => {
    // The half of v0tz.4 the regeneration path could not reach: /BE reached
    // ImportFdf/ImportXfdf but never a render of a document that simply
    // arrived without appearances.
    const be: PdfDict = new Map<string, PdfObject>([['S', name('C')], ['I', 2]]);
    const { doc, dict } = attach('Square', [
      ['Rect', [0, 0, 120, 80]], ['C', [1, 0, 0]], ['BE', be],
    ]);
    const body = fallbackBody(doc, dict);
    expect(body).toContain(' c\n');
    expect(body).not.toContain(' re');
  });

  it('carries an inline font only for the one body that draws text', () => {
    // A /Caret /Sy /P names AP_FONT_KEY for its ¶; every other body is pure
    // geometry and must register no font at all.
    const caret = attach('Caret', [['Rect', [0, 0, 40, 40]], ['Sy', name('P')]]);
    const ap = resolveAppearance(caret.doc, caret.dict)!;
    expect(isDict(ap.stream.dict.get('Resources'))).toBe(true);

    const square = attach('Square', [['Rect', [0, 0, 120, 80]]]);
    const sq = resolveAppearance(square.doc, square.dict)!;
    expect(sq.stream.dict.has('Resources')).toBe(false);
  });

  it('carries /CA opacity as an INLINE ExtGState', () => {
    const { doc, dict } = attach('Square', [['Rect', [0, 0, 120, 80]], ['CA', 0.4]]);
    const ap = resolveAppearance(doc, dict)!;
    const body = new TextDecoder('latin1').decode(ap.stream.raw);
    expect(body).toContain('/GS0 gs');
    expect(body).toBe(regeneratedBody(doc, dict));
    // Inline, not allocated: installShapeAP would doc.allocObject this.
    const res = doc.resolve(ap.stream.dict.get('Resources')) as PdfDict;
    const gs = doc.resolve(res.get('ExtGState')) as PdfDict;
    expect(isDict(gs.get('GS0'))).toBe(true);
  });

  it('matches regeneration on /Matrix and /BBox under a rotation', () => {
    // widgetGeom reads /MK /R, so the layout box is the /Rect TRANSPOSED and
    // /Matrix turns it back. The body-equality cases above compare only the
    // body and so provably cannot see this.
    const mk: PdfDict = new Map<string, PdfObject>([['R', 90]]);
    const { doc, dict } = attach('Square', [['Rect', [0, 0, 120, 80]], ['MK', mk]]);
    const ap = resolveAppearance(doc, dict)!;

    const copy: PdfDict = new Map(dict);
    expect(regenerateAppearance(doc, copy)).toBe(true);
    const apd = doc.resolve(copy.get('AP')) as PdfDict;
    const n = doc.resolve(apd.get('N')) as { dict: PdfDict };
    expect(ap.stream.dict.get('Matrix')).toEqual(n.dict.get('Matrix'));
    expect(ap.stream.dict.get('BBox')).toEqual(n.dict.get('BBox'));
  });

  /** A one-page document whose ONLY annotation is a /Square with no /AP.
   *  Deliberately a blank page rather than buildAnnotTarget, which carries a
   *  red /Text sticky note that v0tz.1 also draws — so a bake count taken
   *  there would not isolate the shape. */
  function squareDoc(): Document {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddSquare({ rect: [40, 40, 200, 120], color: [0, 0, 0] });
    doc.Pages[0].Annotations.at(-1)!.Dict.delete('AP');
    return doc;
  }

  it('is baked by FlattenAnnotations', () => {
    // The third consumer of resolveAppearance, and the one v0tz.1 got for
    // free: flatten promotes an inline /N to an object, so the shape becomes
    // permanent exactly when the caller asks for that.
    const doc = squareDoc();
    expect(doc.Pages[0].FlattenAnnotations()).toBe(1);
    expect(doc.Pages[0].Annotations.length).toBe(0);
    const content = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(content).toMatch(/\/Fm\d+ Do/);
  });

  it('writes nothing into the document when it draws', () => {
    const doc = squareDoc();
    const before = doc.Save();
    const after = Document.Open(before);
    after.Pages[0].ToImage();
    expect(after.Pages[0].Annotations.at(-1)!.Dict.has('AP')).toBe(false);
    expect(after.Save()).toEqual(before);
  });

  it('leaves a later Sign() an incremental append', async () => {
    // The consequence a save alone CANNOT see (pagemode.ts's trap): a full
    // rewrite of an untouched model reproduces the same bytes, so only signing
    // shows it. choosePath() takes the append only for an UNMODIFIED base, so
    // a fallback that allocated would silently rewrite bytes an earlier
    // signature covered.
    const base = squareDoc().Save();
    const doc = Document.Open(base);
    doc.Pages[0].ToImage();
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(doc.Save().subarray(0, base.length)).toEqual(base);
  });

  it('still declines an /AP that is present but unusable', () => {
    // The producer stated an appearance; a viewer draws nothing for it either.
    // Tested on the RAW dict, since doc.resolve(undefined) is null.
    const { doc, dict } = attach('Square', [['Rect', [0, 0, 120, 80]]]);
    dict.set('AP', new Map<string, PdfObject>([['N', new Map<string, PdfObject>()]]));
    expect(resolveAppearance(doc, dict)).toBeUndefined();
  });
});
