import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { flattenAnnotations } from '../src/flatten.js';
import { isArray, isDict, isStream } from '../src/types.js';
import {
  buildFlattenTarget, buildFlattenStateTarget, buildFlattenPopupTarget,
} from './helpers/build-flatten-target.js';

const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

/** The page's /Resources /XObject sub-dict (resolved), or undefined. */
function xobjects(doc: Document, page = doc.Pages[0]) {
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const xo = doc.resolve(res.get('XObject'));
  return isDict(xo) ? xo : undefined;
}

describe('flattenAnnotations (L1)', () => {
  it('bakes a single-stream appearance as a Form XObject draw at its /Rect', () => {
    const doc = Document.Open(buildFlattenTarget());
    const n = flattenAnnotations(doc, doc.Pages[0]);
    expect(n).toBe(2); // two visible, appearance-bearing annotations

    const c = content(doc);
    // identity-Matrix appearance: BBox 100x40 -> Rect [10 20 110 60] -> sx=sy=1.
    expect(c).toMatch(/1 0 0 1 10 20 cm/);
    expect(c).toMatch(/\/Fm0 Do/);
    expect(c).toMatch(/\/Fm1 Do/);
  });

  it('accounts for the appearance /Matrix when computing placement', () => {
    const doc = Document.Open(buildFlattenTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    const c = content(doc);
    // a6: BBox 50x20 scaled x2 by /Matrix -> apparent 100x40 -> Rect 100x40 -> sx=sy=1.
    expect(c).toMatch(/1 0 0 1 0 100 cm/);
  });

  it('registers each appearance stream in the page /Resources /XObject', () => {
    const doc = Document.Open(buildFlattenTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    const xo = xobjects(doc)!;
    expect(xo).toBeDefined();
    expect(isStream(doc.resolve(xo.get('Fm0')))).toBe(true);
    expect(isStream(doc.resolve(xo.get('Fm1')))).toBe(true);
  });

  it('removes flattened annotations but keeps skipped ones in /Annots', () => {
    const doc = Document.Open(buildFlattenTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(isArray(annots)).toBe(true);
    // only the Hidden (a8) and appearance-less (a9) annotations remain.
    expect((annots as unknown[]).length).toBe(2);
    const subtypes = (annots as unknown[]).map((e) => {
      const d = doc.resolve(e as never);
      return isDict(d) ? (d.get('Rect') as number[])?.[0] : undefined;
    });
    expect(subtypes).toEqual([200, 200]); // a8 and a9 both at x0=200
  });

  it('selects the /AS state of a subdictionary appearance', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    const n = flattenAnnotations(doc, doc.Pages[0]);
    expect(n).toBe(1);
    const c = content(doc);
    expect(c).toMatch(/\/Fm0 Do/);
    // the baked XObject must be the /On (green) appearance, not /Off (white).
    const xo = xobjects(doc)!;
    const baked = doc.resolve(xo.get('Fm0'));
    const body = isStream(baked) ? new TextDecoder('latin1').decode((baked as { raw: Uint8Array }).raw) : '';
    expect(body).toContain('0 1 0 rg'); // green = On state
  });

  it('survives a Save/Open round-trip with the appearance visible and /Annots gone', () => {
    const doc = Document.Open(buildFlattenTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    const reopened = Document.Open(doc.Save());
    const c = content(reopened);
    expect(c).toMatch(/\/Fm0 Do/);
    const xo = xobjects(reopened)!;
    const baked = reopened.resolve(xo.get('Fm0'));
    expect(isStream(baked)).toBe(true);
    // the appearance content (blue box) survived as the referenced XObject.
    const body = new TextDecoder('latin1').decode((baked as { raw: Uint8Array }).raw);
    expect(body).toContain('0 0 1 rg');
  });

  it('never bakes a /Popup appearance, even when it carries an /AP', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    const n = flattenAnnotations(doc, doc.Pages[0]);
    expect(n).toBe(1); // only the parent /Square markup

    const c = content(doc);
    expect(c).toMatch(/\/Fm0 Do/);
    expect(c).not.toMatch(/\/Fm1 Do/); // the popup's appearance was not drawn
    // the baked XObject is the markup's green box, not the popup's yellow one.
    const baked = doc.resolve(xobjects(doc)!.get('Fm0'));
    const body = new TextDecoder('latin1').decode((baked as { raw: Uint8Array }).raw);
    expect(body).toContain('0 1 0 rg');
  });

  it('drops a /Popup from /Annots once its parent markup has been baked', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    // parent baked and removed; the popup it belonged to has nothing left to open.
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    expect(annots.length).toBe(0);
  });

  it('keeps a /Popup whose parent markup was not baked', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    // strip the parent's /AP so it is unflattenable — its popup must survive too.
    const page = doc.Pages[0];
    const annots = doc.resolve(page.Dict.get('Annots')) as unknown[];
    (doc.resolve(annots[0] as never) as Map<string, unknown>).delete('AP');

    expect(flattenAnnotations(doc, page)).toBe(0);
    const after = doc.resolve(page.Dict.get('Annots')) as unknown[];
    expect(after.length).toBe(2); // parent + popup both still there
  });

  it('does not resurrect the baked markup through the popup /Parent on Save', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    flattenAnnotations(doc, doc.Pages[0]);
    const saved = new TextDecoder('latin1').decode(doc.Save());
    // the flattened /Square must not survive as an orphan annotation, and the
    // popup's own appearance must not survive as dead weight.
    expect(saved).not.toContain('/Subtype /Square');
    expect(saved).not.toContain('/Subtype /Popup');
    expect(saved).not.toContain('1 1 0 rg'); // the popup appearance's yellow box
    expect(saved).toContain('0 1 0 rg'); // the markup's green box, now baked
  });

  it('returns 0 and leaves the page untouched when there is nothing to flatten', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    // strip the only annotation's appearance so nothing is flattenable.
    const page = doc.Pages[0];
    const annots = doc.resolve(page.Dict.get('Annots')) as unknown[];
    const annot = doc.resolve(annots[0] as never) as Map<string, unknown>;
    annot.delete('AP');
    const before = page.Dict.get('Contents');
    expect(flattenAnnotations(doc, page)).toBe(0);
    expect(page.Dict.get('Contents')).toBe(before);
  });
});
