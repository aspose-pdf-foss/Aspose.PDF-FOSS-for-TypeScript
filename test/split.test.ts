import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';

describe('Document.Split', () => {
  const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

  it('splits a 3-page classic pdf into 3 single-page Documents', () => {
    const docs = Document.Open(buildClassicPdf(3)).Split();
    expect(docs.length).toBe(3);
    for (const d of docs) expect(d.Pages.length).toBe(1);
  });

  it('each split Document round-trips through Save() to a 1-page pdf', () => {
    const docs = Document.Open(buildClassicPdf(3)).Split();
    for (const d of docs) expect(Document.Open(d.Save()).Pages.length).toBe(1);
  });

  it('preserves page content bytes', () => {
    const docs = Document.Open(buildClassicPdf(2)).Split();
    expect(dec(docs[1].Save()).includes('Page 2')).toBe(true);
  });

  it('splits an xref-stream pdf', () => {
    const docs = Document.Open(buildXrefStreamPdf()).Split();
    expect(docs.length).toBe(1);
    expect(Document.Open(docs[0].Save()).Pages.length).toBe(1);
  });

  it('returns an empty array for a zero-page document', () => {
    expect(Document.Open(buildClassicPdf(0)).Split().length).toBe(0);
  });
});
