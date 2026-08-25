import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import * as api from '../src/index.js';

describe('Document.GetMetadata', () => {
  it('reads standard and custom fields from /Info', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'Hi', Author: 'Ada', Custom1: 'X' } });
    const meta = Document.Open(pdf).GetMetadata();
    expect(meta.title).toBe('Hi');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Custom1: 'X' });
  });

  it('returns empty metadata when there is no /Info', () => {
    const meta = Document.Open(buildClassicPdf(1)).GetMetadata();
    expect(meta).toEqual({ custom: {} });
  });
});

describe('Document.SetMetadata / ClearMetadata', () => {
  it('merges updates and preserves untouched fields', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.SetMetadata({ title: 'New', custom: { K: 'V' } });
    const meta = doc.GetMetadata();
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ K: 'V' });
  });

  it('deletes a field when set to null', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.SetMetadata({ author: null });
    expect(doc.GetMetadata().author).toBeUndefined();
  });

  it('ClearMetadata empties all metadata', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old' } }));
    doc.ClearMetadata();
    expect(doc.GetMetadata()).toEqual({ custom: {} });
  });

  it('reflects a SetMetadata immediately via GetMetadata (no save/reload)', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'Live' });
    expect(doc.GetMetadata().title).toBe('Live'); // observable without save
  });

  it('creates a live /Info on first write even when the input had none', () => {
    const doc = Document.Open(buildClassicPdf(1)); // no /Info
    doc.SetMetadata({ author: 'Ada' });
    expect(doc.GetMetadata().author).toBe('Ada');
    expect(doc.trailer.get('Info')).toBeDefined(); // trailer now references /Info
  });
});

describe('Document.Save', () => {
  it('round-trips a metadata edit through Save + Open', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.SetMetadata({ title: 'New', custom: { Tag: 'T1' } });
    const meta = Document.Open(doc.Save()).GetMetadata();
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Tag: 'T1' });
  });

  it('round-trips a non-ASCII value', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.SetMetadata({ title: 'Café—Ω' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('Café—Ω');
  });

  it('ClearMetadata + Save yields a document with no metadata', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.ClearMetadata();
    expect(Document.Open(doc.Save()).GetMetadata()).toEqual({ custom: {} });
  });
});

describe('public API exports', () => {
  it('exposes Document from the index', () => {
    expect(typeof (api as any).Document).toBe('function');
  });
});
