import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { buildImagePdf } from './helpers/build-image-pdf.js';
import { isDict, isRef, isStream, PdfDict, PdfObject } from '../src/types.js';

/** The page's /Resources /XObject entry for `nm`, raw (undereferenced). */
function pageXObjectEntry(doc: Document, nm: string): PdfObject | undefined {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const x = doc.resolve(res.get('XObject'));
  return isDict(x) ? x.get(nm) : undefined;
}

describe('EditableContent.ownXObjectResources', () => {
  // buildImagePdf's /Fm0 is a Form XObject whose own /Resources holds /ImF.
  it('copy-on-writes the form and returns its own resources', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const before = pageXObjectEntry(doc, 'Fm0');
    expect(isRef(before)).toBe(true);

    const ec = new EditableContent(doc, doc.Pages[0]);
    const res = ec.ownXObjectResources(['Fm0']);

    expect(isDict(res)).toBe(true);
    expect(res.has('XObject')).toBe(true);
    // The page now points at a clone, not the original object.
    const after = pageXObjectEntry(doc, 'Fm0');
    expect(isRef(after)).toBe(true);
    expect(after).not.toEqual(before);
  });

  it('does not mutate the original form object', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const original = doc.resolve(pageXObjectEntry(doc, 'Fm0')!);
    expect(isStream(original)).toBe(true);
    const originalRes = isStream(original)
      ? doc.resolve(original.dict.get('Resources')) : null;
    expect(isDict(originalRes)).toBe(true);

    const ec = new EditableContent(doc, doc.Pages[0]);
    ec.ownXObjectResources(['Fm0']).set('Marker', 1);

    expect((originalRes as PdfDict).has('Marker')).toBe(false);
  });

  it('is idempotent — a second call returns the same dict', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.ownXObjectResources(['Fm0'])).toBe(ec.ownXObjectResources(['Fm0']));
  });
});
