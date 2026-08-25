import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfObject, name, isStream } from '../src/types.js';
import { dedupStreams } from '../src/dedup.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

function countStreams(doc: Document): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) if (isStream(o)) n++;
  return n;
}

const streamOf = (payload: string, extra: [string, PdfObject][] = []): PdfObject => ({
  kind: 'stream',
  dict: new Map<string, PdfObject>(extra),
  raw: new TextEncoder().encode(payload),
});

describe('dedupStreams', () => {
  it('merges two byte-identical streams and repoints referrers', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const a = doc.allocObject(streamOf('IDENTICAL PAYLOAD'));
    const b = doc.allocObject(streamOf('IDENTICAL PAYLOAD'));
    doc.catalog().set('T1', a);
    doc.catalog().set('T2', b);
    const before = countStreams(doc);

    const res = dedupStreams(doc);

    expect(res.merged).toBe(1);
    expect(countStreams(doc)).toBe(before - 1);
    expect(doc.catalog().get('T1')).toEqual(doc.catalog().get('T2'));
    expect(Document.Open(doc.Save()).Pages.length).toBe(1); // still re-openable
  });

  it('treats dicts with different key order as identical', () => {
    const doc = Document.Open(buildWholeFontPdf());
    doc.catalog().set('T1', doc.allocObject(streamOf('X', [['A', 1], ['B', 2]])));
    doc.catalog().set('T2', doc.allocObject(streamOf('X', [['B', 2], ['A', 1]])));
    expect(dedupStreams(doc).merged).toBe(1);
  });

  it('does not merge streams with different payloads', () => {
    const doc = Document.Open(buildWholeFontPdf());
    doc.catalog().set('T1', doc.allocObject(streamOf('ONE')));
    doc.catalog().set('T2', doc.allocObject(streamOf('TWO')));
    expect(dedupStreams(doc).merged).toBe(0);
  });

  it('never merges identity-sensitive types', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const mk = (): PdfObject => doc.allocObject(streamOf('SAME', [['Type', name('Metadata')]]));
    doc.catalog().set('T1', mk());
    doc.catalog().set('T2', mk());
    expect(dedupStreams(doc).merged).toBe(0);
  });
});
