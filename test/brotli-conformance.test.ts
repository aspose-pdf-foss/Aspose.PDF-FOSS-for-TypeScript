import { describe, it, expect } from 'vitest';
import { Document, type PdfALevel, type PdfXLevel } from '../src/index.js';
import { serializeDocument } from '../src/serializer.js';
import { name, ref, type PdfObject, type PdfDict } from '../src/types.js';
import { buildBrotliStream } from './helpers/build-brotli-stream.js';

/** No fonts, colors or images: isolates the stream-filter conformance rule. */
function document(): Document {
  const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);
  const objects = new Map<number, PdfObject>([
    [1, dict([['Type', name('Catalog')], ['Pages', ref(2)]])],
    [2, dict([['Type', name('Pages')], ['Kids', [ref(3)]], ['Count', 1]])],
    [3, dict([['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 100, 100]], ['Contents', ref(4)]])],
    [4, buildBrotliStream(new TextEncoder().encode('q Q'))],
  ]);
  return Document.Open(serializeDocument(objects, dict([['Root', ref(1)]]), { streamFilter: 'BrotliDecode' }));
}

describe('Brotli conformance', () => {
  it.each<PdfALevel>(['1b', '2b', '3b', '4'])('keeps unsupported Brotli unresolved in PDF/A-%s', (level) => {
    const doc = document();
    const report = doc.ConvertToPdfA(level);
    expect(report.passed).toBe(false);
    expect(report.unresolved.some((i) => i.message.includes('BrotliDecode'))).toBe(true);
    expect(doc.ValidatePdfA(level).Errors.some((i) => i.message.includes('BrotliDecode'))).toBe(true);
  });

  it.each<PdfXLevel>(['1a', '3', '4', '4p'])('keeps unsupported Brotli unresolved in PDF/X-%s', (level) => {
    const doc = document();
    const report = doc.ConvertToPdfX(level);
    expect(report.passed).toBe(false);
    expect(report.unresolved.some((i) => i.message.includes('BrotliDecode'))).toBe(true);
    expect(doc.ValidatePdfX(level).Errors.some((i) => i.message.includes('BrotliDecode'))).toBe(true);
  });
});
