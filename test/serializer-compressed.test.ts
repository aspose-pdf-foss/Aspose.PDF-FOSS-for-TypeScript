import { describe, it, expect } from 'vitest';
import { serializeDocument } from '../src/serializer.js';
import { Document } from '../src/document.js';
import { readXref } from '../src/xref.js';
import { PdfDict, PdfObject, isStream, name, ref } from '../src/types.js';

/** A live doc with many small objects so ObjStm packing wins: 1=Catalog -> 2=Pages
 *  -> 3..(2+pages) Page leaves, each carrying a small indirect Resources dict. */
function manyObjectDoc(pages = 12): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const objects = new Map<number, PdfObject>();
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)],
  ]);
  const pagesNode: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', pages], ['Kids', []],
  ]);
  objects.set(1, catalog);
  objects.set(2, pagesNode);
  const kids: PdfObject[] = [];
  let next = 3;
  for (let i = 0; i < pages; i++) {
    const resNum = next++;
    const pageNum = next++;
    objects.set(resNum, new Map<string, PdfObject>([['ProcSet', [name('PDF'), name('Text')]]]));
    objects.set(pageNum, new Map<string, PdfObject>([
      ['Type', name('Page')], ['Parent', ref(2)],
      ['MediaBox', [0, 0, 595, 842]], ['Resources', ref(resNum)],
    ]));
    kids.push(ref(pageNum));
  }
  pagesNode.set('Kids', kids);
  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}

describe('serializeDocument (compressed)', () => {
  it('round-trips through this library: catalog and pages survive', () => {
    const { objects, trailer } = manyObjectDoc();
    const bytes = serializeDocument(objects, trailer, { compressed: true });
    const re = Document.Open(bytes);
    expect(re.Pages.length).toBe(12);
    expect(re.Pages[0].MediaBox).toEqual([0, 0, 595, 842]);
    expect(re.Pages[11].MediaBox).toEqual([0, 0, 595, 842]);
  });

  it('emits a cross-reference stream (no classic xref table keyword)', () => {
    const { objects, trailer } = manyObjectDoc();
    const bytes = serializeDocument(objects, trailer, { compressed: true });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(/\nxref\n/.test(text)).toBe(false); // no classic table
    expect(text.includes('/Type /XRef')).toBe(true);
    expect(text.includes('/Type /ObjStm')).toBe(true);
  });

  it('xref stream parses with offset and compressed entries', () => {
    const { objects, trailer } = manyObjectDoc();
    const bytes = serializeDocument(objects, trailer, { compressed: true });
    const { entries, trailer: tr } = readXref(bytes);
    expect(tr.get('Root')).toBeDefined();
    const types = new Set([...entries.values()].map((e) => e.type));
    expect(types.has('compressed')).toBe(true); // dicts packed into ObjStm
    expect(types.has('offset')).toBe(true);     // ObjStm + XRef stream are direct
  });

  it('produces smaller output than classic for multi-object docs', () => {
    const { objects, trailer } = manyObjectDoc(20);
    const classic = serializeDocument(objects, trailer);
    const compressed = serializeDocument(objects, trailer, { compressed: true });
    expect(compressed.length).toBeLessThan(classic.length);
  });

  it('keeps stream objects uncompressed (verbatim raw) while packing dicts', () => {
    const { objects, trailer } = manyObjectDoc(2);
    const raw = new TextEncoder().encode('q 1 0 0 1 0 0 cm Q');
    const stream: PdfObject = { kind: 'stream', dict: new Map([['Length', raw.length]]), raw };
    objects.set(99, stream);
    // attach the content stream to a page so it is reachable
    const page = objects.get(4);
    if (page instanceof Map) page.set('Contents', ref(99));
    const bytes = serializeDocument(objects, trailer, { compressed: true });
    const re = Document.Open(bytes);
    const contents = (re as any).objects as Map<number, PdfObject>;
    const streams = [...contents.values()].filter(isStream);
    // the page content stream round-trips with identical bytes
    expect(streams.some((s) => new TextDecoder('latin1').decode(s.raw) === 'q 1 0 0 1 0 0 cm Q')).toBe(true);
  });

  it('classic remains the default (no options => xref table)', () => {
    const { objects, trailer } = manyObjectDoc(3);
    const text = new TextDecoder('latin1').decode(serializeDocument(objects, trailer));
    expect(/\nxref\n/.test(text)).toBe(true);
    expect(text.includes('/Type /XRef')).toBe(false);
  });

  it('Document.Save({compressed:true}) re-opens equivalently', () => {
    const { objects, trailer } = manyObjectDoc(5);
    const original = Document.Open(serializeDocument(objects, trailer));
    const compressed = original.Save({ compressed: true });
    const re = Document.Open(compressed);
    expect(re.Pages.length).toBe(5);
    expect(re.Pages.map((p) => p.MediaBox)).toEqual(original.Pages.map((p) => p.MediaBox));
  });
});
