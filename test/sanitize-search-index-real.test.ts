import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { decodeStream } from '../src/filters.js';
import { isDict, isStream, type PdfDict, type PdfStream } from '../src/types.js';

// Original Acrobat Pro bytes from pdfbox.cfc's MIT-licensed test corpus.
// Source commit, hashes, observed dictionary and upstream tests are recorded
// in fixtures/acrobat-index/PROVENANCE.md. No fixture builder runs here.
const fixture = () => new Uint8Array(readFileSync(
  new URL('./fixtures/acrobat-index/testing.pdf', import.meta.url)));
const streamKeys = ['PDXFile', 'IndexFile', 'Index1File'] as const;

function searchIndex(doc: Document): PdfDict {
  const piece = doc.resolve(doc.catalog().get('PieceInfo'));
  const index = isDict(piece) ? doc.resolve(piece.get('SearchIndex')) : undefined;
  if (!isDict(index)) throw new Error('fixture has no Acrobat search index');
  return index;
}

function indexStreams(doc: Document): PdfStream[] {
  const index = searchIndex(doc);
  return streamKeys.map((key) => {
    const stream = doc.resolve(index.get(key));
    if (!isStream(stream)) throw new Error(`fixture has no ${key} stream`);
    return stream;
  });
}

describe('Sanitize: real Acrobat Pro embedded index (g9vh)', () => {
  it('reports and removes the original index and its payloads from saved bytes', () => {
    const original = fixture(), doc = Document.Open(original);
    const index = searchIndex(doc), streams = indexStreams(doc);
    // Acrobat puts the fields directly in SearchIndex. The synthetic fixture
    // from 74mf.5 had inferred a nested Private dictionary from binary strings.
    expect([...index.keys()].sort()).toEqual(['Index1File', 'IndexFile', 'ModID', 'PDXFile']);
    expect(new TextDecoder('latin1').decode(decodeStream(streams[0]))).toMatch(/^%PDX-3\.2/);
    expect(streams.map((s) => decodeStream(s).length)).toEqual([399, 4848, 23654]);
    for (const s of streams) expect(Buffer.from(original).includes(Buffer.from(s.raw))).toBe(true);
    const text = doc.Pages.map((p) => p.GetText());
    expect(doc.Pages).toHaveLength(3);
    expect(text[0]).toContain("I'm for Testing");

    const report = doc.Sanitize();
    expect(report.privateData).toMatchObject({ pieceInfo: 1, searchIndex: true });
    expect(doc.catalog().has('PieceInfo')).toBe(false);
    const saved = doc.Save();
    streams.forEach((s, i) => expect(Buffer.from(saved).includes(Buffer.from(s.raw)), streamKeys[i]).toBe(false));
    const reopened = Document.Open(saved);
    expect(reopened.catalog().has('PieceInfo')).toBe(false);
    expect(reopened.Pages).toHaveLength(text.length);
    // Default sanitization also flattens form appearances, which adds the
    // button's label to extracted page text. The source text must survive.
    text.forEach((source, i) => expect(reopened.Pages[i].GetText()).toContain(source));
    expect(reopened.Validate().Passed).toBe(true);
    expect(reopened.Sanitize().privateData?.searchIndex).toBe(false);
  });

  it('retains all original index streams when privateData is disabled', () => {
    const doc = Document.Open(fixture());
    const payloads = indexStreams(doc).map((s) => decodeStream(s));
    const modId = searchIndex(doc).get('ModID');
    expect(doc.Sanitize({ privateData: false }).privateData).toBeUndefined();
    expect(searchIndex(doc).get('ModID')).toEqual(modId);
    const reopened = Document.Open(doc.Save());
    expect(indexStreams(reopened).map((s) => decodeStream(s))).toEqual(payloads);
    expect(searchIndex(reopened).get('ModID')).toEqual(modId);
  });
});
