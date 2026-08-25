import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { flattenForm } from '../src/flatten.js';
import { isArray, isDict, isName, isStream } from '../src/types.js';
import { buildFlattenFormTarget } from './helpers/build-flatten-form.js';

const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

function xobjects(doc: Document, page = doc.Pages[0]) {
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const xo = doc.resolve(res.get('XObject'));
  return isDict(xo) ? xo : undefined;
}

const rawOf = (o: unknown) =>
  isStream(o as never) ? new TextDecoder('latin1').decode((o as { raw: Uint8Array }).raw) : '';

describe('flattenForm (L2)', () => {
  it('bakes each widget appearance into page content and drops the AcroForm', () => {
    const doc = Document.Open(buildFlattenFormTarget());
    const n = flattenForm(doc);
    expect(n).toBe(2); // text + checkbox widgets

    const c = content(doc);
    expect(c).toMatch(/\/Fm0 Do/);
    expect(c).toMatch(/\/Fm1 Do/);
    // AcroForm gone from the catalog.
    expect(doc.catalog().has('AcroForm')).toBe(false);
  });

  it('removes widget annotations but leaves non-widget annotations in place', () => {
    const doc = Document.Open(buildFlattenFormTarget());
    flattenForm(doc);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(isArray(annots)).toBe(true);
    const subtypes = (annots as unknown[]).map((e) => {
      const d = doc.resolve(e as never);
      const s = isDict(d) ? d.get('Subtype') : undefined;
      return isName(s) ? s.name : undefined;
    });
    expect(subtypes).toEqual(['Text']); // only the sticky note survives
  });

  it('bakes the field value into the text widget appearance', () => {
    const doc = Document.Open(buildFlattenFormTarget());
    flattenForm(doc);
    const xo = xobjects(doc)!;
    // one of the baked XObjects must render the text value "Bob".
    const bodies = [...xo.values()].map((v) => rawOf(doc.resolve(v)));
    expect(bodies.some((b) => b.includes('Bob'))).toBe(true);
  });

  it('bakes the checked (/AS) state of the checkbox, not the off state', () => {
    const doc = Document.Open(buildFlattenFormTarget());
    flattenForm(doc);
    const xo = xobjects(doc)!;
    const bodies = [...xo.values()].map((v) => rawOf(doc.resolve(v)));
    expect(bodies.some((b) => b.includes('0 1 0 rg'))).toBe(true);  // green = Yes
    expect(bodies.some((b) => b.includes('1 1 1 rg'))).toBe(false); // white = Off not baked
  });

  it('survives Save/Open: appearances drawn, no AcroForm, no widgets', () => {
    const doc = Document.Open(buildFlattenFormTarget());
    flattenForm(doc);
    const reopened = Document.Open(doc.Save());

    expect(content(reopened)).toMatch(/\/Fm0 Do/);
    expect(reopened.catalog().has('AcroForm')).toBe(false);
    expect(reopened.Form.Fields.length).toBe(0); // no interactive fields remain
    const annots = reopened.resolve(reopened.Pages[0].Dict.get('Annots')) as unknown[];
    const hasWidget = annots.some((e) => {
      const d = reopened.resolve(e as never);
      const s = isDict(d) ? d.get('Subtype') : undefined;
      return isName(s) && s.name === 'Widget';
    });
    expect(hasWidget).toBe(false);
  });

  it('is a no-op returning 0 on a document with no form', () => {
    // A minimal page-only PDF: reuse the form fixture but strip the AcroForm.
    const doc = Document.Open(buildFlattenFormTarget());
    doc.catalog().delete('AcroForm');
    // remove widgets so there is genuinely nothing form-related to flatten
    doc.Pages[0].Dict.set('Annots', []);
    expect(flattenForm(doc)).toBe(0);
  });
});
