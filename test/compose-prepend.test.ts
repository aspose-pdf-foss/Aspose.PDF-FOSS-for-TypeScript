import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { prependContent } from '../src/pagecontent.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('prependContent (underlay splice)', () => {
  it('inserts body before existing content, wrapping existing in q/Q', () => {
    const doc = Document.Open(buildMultiStreamPage(['ORIGcontent']));
    const page = doc.Pages[0];
    prependContent(doc, page, enc('q UNDERbody Q'));
    const c = dec(page.Contents);
    expect(c).toContain('UNDERbody');
    expect(c.indexOf('UNDERbody')).toBeLessThan(c.indexOf('ORIGcontent')); // underlay first
    expect(c).toContain('q\n'); // existing wrapped
    expect(c).toMatch(/Q\s*$/); // ...and closed at the end
  });

  it('sets a single content stream when the page has none', () => {
    const doc = Document.Open(buildMultiStreamPage(['X']));
    const page = doc.Pages[0];
    page.Dict.delete('Contents');
    prependContent(doc, page, enc('BODY'));
    expect(dec(page.Contents)).toContain('BODY');
  });

  it('survives a Save/Open round-trip', () => {
    const doc = Document.Open(buildMultiStreamPage(['ORIGcontent']));
    prependContent(doc, doc.Pages[0], enc('q UNDERbody Q'));
    const reopened = Document.Open(doc.Save());
    const c = dec(reopened.Pages[0].Contents);
    expect(c.indexOf('UNDERbody')).toBeLessThan(c.indexOf('ORIGcontent'));
  });
});
