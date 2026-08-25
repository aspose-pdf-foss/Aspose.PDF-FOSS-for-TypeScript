import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { PdfObject, PdfStream, name, isStream, isName } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { recompressStreams } from '../src/recompress.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

const payload = new TextEncoder().encode('COMPRESS ME '.repeat(500));

describe('recompressStreams', () => {
  it('Flate-encodes an unfiltered stream and preserves its decoded bytes', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const r = doc.allocObject({ kind: 'stream', dict: new Map(), raw: payload });
    doc.catalog().set('T1', r);

    const res = recompressStreams(doc);

    expect(res.streams).toBeGreaterThanOrEqual(1);
    const s = doc.resolve(r);
    if (!isStream(s)) throw new Error('not a stream');
    const f = s.dict.get('Filter');
    expect(isName(f) && f.name).toBe('FlateDecode');
    expect(s.raw.length).toBeLessThan(payload.length);
    expect([...decodeStream(s)]).toEqual([...payload]);
  });

  it('re-deflates an existing weakly-compressed Flate stream to something no larger', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const weak = new Uint8Array(deflateSync(Buffer.from(payload), { level: 1 }));
    const r = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: weak,
    });
    doc.catalog().set('T1', r);

    recompressStreams(doc);

    const s = doc.resolve(r);
    if (!isStream(s)) throw new Error('not a stream');
    expect(s.raw.length).toBeLessThanOrEqual(weak.length);
    expect([...decodeStream(s)]).toEqual([...payload]);
  });

  it('leaves a predictor-bearing stream byte-identical through decode', () => {
    const doc = Document.Open(buildWholeFontPdf());
    // 400 rows x 3 columns, each row prefixed with PNG filter type 0 (None).
    // The payload is deliberately large and repetitive: level 9 must actually
    // beat level 1 here, or recompressOne would decline to touch the stream and
    // this test would pass without ever exercising the predictor path.
    const bytes: number[] = [];
    for (let row = 0; row < 400; row++) bytes.push(0, row % 17, (row * row) % 29, (row % 5) * 50);
    const rows = Uint8Array.from(bytes);
    const weak = new Uint8Array(deflateSync(Buffer.from(rows), { level: 1 }));
    const r = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Filter', name('FlateDecode')],
        ['DecodeParms', new Map<string, PdfObject>([
          ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 3],
        ])],
      ]),
      raw: weak,
    });
    doc.catalog().set('T1', r);
    const before = [...decodeStream(doc.resolve(r) as PdfStream)];

    recompressStreams(doc);

    const after = doc.resolve(r) as PdfStream;
    expect(after.raw.length).toBeLessThan(weak.length); // it really was re-deflated
    expect([...decodeStream(after)]).toEqual(before);   // ...and the predictor still lines up
  });

  it('does not touch image-codec or exempt streams', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const jpegish: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('DCTDecode')]]),
      raw: payload,
    };
    const r = doc.allocObject(jpegish);
    doc.catalog().set('T1', r);
    recompressStreams(doc);
    expect([...(doc.resolve(r) as PdfStream).raw]).toEqual([...payload]);
  });
});
