import { describe, it, expect } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import { Document, LoadLimits, ResourceLimitError, type StreamFilterName } from '../src/index.js';
import { serializeDocument } from '../src/serializer.js';
import { decodeStream, filterList } from '../src/filters.js';
import { applyStreamFilter } from '../src/streamfilter.js';
import { name, ref, isDict, isName, isStream, type PdfObject, type PdfDict } from '../src/types.js';
import { buildStreamFilterDoc } from './helpers/build-streamfilter-pdf.js';
import { buildBrotliStream } from './helpers/build-brotli-stream.js';

const target: StreamFilterName = 'BrotliDecode';
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const content = 'BT /F1 12 Tf 10 10 Td (FLATE-CONTENT-STREAM) Tj ET';
function streams(doc: Document) { return [...doc.objectEntries()].map(([, o]) => o).filter(isStream); }
function extension(doc: Document): PdfDict {
  const exts = doc.resolve(doc.catalog().get('Extensions'));
  expect(isDict(exts)).toBe(true);
  const ext = doc.resolve((exts as PdfDict).get('PDFa'));
  expect(isDict(ext)).toBe(true);
  return ext as PdfDict;
}

describe('Brotli save option', () => {
  it('declares the extension on the remapped catalog when the source Root is not object 1', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    objects.set(20, objects.get(1)!);
    objects.delete(1);
    trailer.set('Root', ref(20));
    const doc = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
    expect(doc.catalog().get('Type')).toEqual(name('Catalog'));
    expect(extension(doc).get('ExtensionLevel')).toBe(1);
  });

  for (const compressed of [false, true]) for (const encrypted of [false, true]) {
    it(`re-encodes and declares Brotli (compressed=${compressed}, encrypted=${encrypted})`, () => {
      const { objects, trailer } = buildStreamFilterDoc();
      const before = serializeDocument(objects, trailer);
      const saved = serializeDocument(objects, trailer, {
        streamFilter: target, compressed, encrypt: encrypted ? { userPassword: 'u' } : undefined,
      });
      const doc = Document.Open(saved, encrypted ? { password: 'u' } : undefined);
      expect(text(saved.subarray(0, 8))).toBe('%PDF-2.0');
      expect(doc.catalog().get('Version')).toEqual(name('2.0'));
      const ext = extension(doc);
      expect(ext.get('BaseVersion')).toEqual(name('2.0'));
      expect(ext.get('ExtensionLevel')).toBe(1);
      expect(ext.get('ExtensionRevision')).toEqual({ kind: 'string', bytes: bytes('2026') });
      expect(ext.get('URL')).toEqual({ kind: 'string', bytes: bytes('https://pdfa.org/resource/extension-brotli') });
      const encoded = streams(doc).filter((s) => filterList(s).names.includes('BrotliDecode'));
      expect(encoded).toHaveLength(3);
      expect(new Set(encoded.map((s) => text(new Uint8Array(brotliDecompressSync(s.raw)))))).toEqual(new Set([
        content, 'UNCOMPRESSED-XOBJECT-BODY', text(Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80])),
      ]));
      for (const s of encoded) {
        expect(s.dict.has('DecodeParms')).toBe(false);
        expect(s.dict.has('DP')).toBe(false);
      }
      const untouched = streams(doc).find((s) => filterList(s).names.includes('DCTDecode'))!;
      expect(untouched.raw).toEqual(Uint8Array.from([255, 216, 255, 217]));
      const metadata = streams(doc).find((s) => {
        const type = s.dict.get('Type');
        return isName(type) && type.name === 'Metadata';
      })!;
      expect(filterList(metadata).names).toEqual([]);
      // Saving must never alter the source graph, its filters or its catalog.
      expect(serializeDocument(objects, trailer)).toEqual(before);
    });
  }

  it('works through public Save and SaveAsync, and leaves default output unchanged', async () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const doc = Document.Open(serializeDocument(objects, trailer));
    const original = doc.Save();
    const saved = doc.Save({ streamFilter: target });
    expect(streams(Document.Open(saved)).filter((s) => filterList(s).names.includes(target))).toHaveLength(3);
    const asyncDoc = Document.Open(await doc.SaveAsync({ streamFilter: target }));
    expect(extension(asyncDoc).get('ExtensionLevel')).toBe(1);
    expect(doc.Save()).toEqual(original);
    expect(text(original.subarray(0, 8))).toBe('%PDF-1.7');
  });

  it('preserves an indirect extension dictionary and its unrelated entries', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const other: PdfDict = new Map<string, PdfObject>([['BaseVersion', name('1.7')], ['ExtensionLevel', 3]]);
    objects.set(11, new Map<string, PdfObject>([['ADBE', ref(12)]]));
    objects.set(12, other);
    (objects.get(1) as PdfDict).set('Extensions', ref(11));
    const before = serializeDocument(objects, trailer);
    const doc = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
    const exts = doc.resolve(doc.catalog().get('Extensions')) as PdfDict;
    expect(doc.resolve(exts.get('ADBE'))).toEqual(other);
    expect(extension(doc).get('ExtensionLevel')).toBe(1);
    expect(serializeDocument(objects, trailer)).toEqual(before);
  });

  it('preserves other PDFa extension levels using the PDF 2.0 array form', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const previous: PdfDict = new Map<string, PdfObject>([['BaseVersion', name('2.0')], ['ExtensionLevel', 99]]);
    (objects.get(1) as PdfDict).set('Extensions', new Map<string, PdfObject>([['PDFa', [previous]]]));
    const doc = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
    const exts = doc.resolve(doc.catalog().get('Extensions')) as PdfDict;
    const entries = exts.get('PDFa') as PdfObject[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(previous);
    expect((entries[1] as PdfDict).get('ExtensionLevel')).toBe(1);
  });

  it('updates an indirect Brotli declaration without duplicating or losing custom entries', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    objects.set(11, new Map<string, PdfObject>([
      ['BaseVersion', name('2.0')], ['ExtensionLevel', 1], ['Custom', 42],
    ]));
    (objects.get(1) as PdfDict).set('Extensions', new Map<string, PdfObject>([['PDFa', ref(11)]]));
    const doc = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
    const twice = Document.Open(doc.Save({ streamFilter: target }));
    expect(extension(twice).get('Custom')).toBe(42);
    expect(extension(twice).get('ExtensionLevel')).toBe(1);
  });

  it('applies the policy supplied to Open when a page reads Brotli content', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const saved = serializeDocument(objects, trailer, { streamFilter: target });
    for (const patch of [{ maxDecodedStreamBytes: 10 }, { maxContentBytes: 10 }]) {
      const doc = Document.Open(saved, { limits: LoadLimits.defaults.with(patch) });
      expect(() => doc.Pages[0].Contents).toThrow(ResourceLimitError);
    }
  });

  it('can armor or replace existing Brotli streams while retaining decoded data', () => {
    const data = Uint8Array.from([10, 20, 30, 40]);
    const parms = new Map<string, PdfObject>([['Predictor', 2], ['Columns', 4]]);
    for (const filter of ['ASCII85Decode', 'RunLengthDecode'] as const) {
      const objs: PdfObject[] = [buildBrotliStream(Uint8Array.from([10, 10, 10, 10]), parms)];
      applyStreamFilter(objs, filter);
      expect(isStream(objs[0])).toBe(true);
      if (!isStream(objs[0])) throw new Error('missing stream');
      expect(filterList(objs[0]).names[0]).toBe(filter);
      expect(decodeStream(objs[0])).toEqual(data);
    }
  });
});
