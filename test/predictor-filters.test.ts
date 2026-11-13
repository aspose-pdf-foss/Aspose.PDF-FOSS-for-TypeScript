import { describe, it, expect } from 'vitest';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { decodeStream } from '../src/filters.js';
import { decodeImageStream } from '../src/imagedecode.js';
import { lzwEncode } from '../src/lzw.js';
import { asciiHexEncode } from '../src/ascii.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { name, type PdfDict, type PdfObject, type PdfStream } from '../src/types.js';
import { TIFF_PREDICTOR_VECTORS } from './helpers/predictor-vectors.js';

const vectors = TIFF_PREDICTOR_VECTORS.filter((v) => [1, 4, 16].includes(v.bpc));
const parms = (bpc: number, colors: number, columns: number): PdfDict => new Map<string, PdfObject>([
  ['Predictor', 2], ['BitsPerComponent', bpc], ['Colors', colors], ['Columns', columns],
]);

describe.each(['FlateDecode', 'LZWDecode', 'BrotliDecode'])('%s with TIFF Predictor 2', (filter) => {
  it.each(vectors)('$label', ({ encoded, decoded, bpc, colors, columns }) => {
    const data = Uint8Array.from(encoded);
    const raw = new Uint8Array(filter === 'FlateDecode' ? deflateSync(data)
      : filter === 'BrotliDecode' ? brotliCompressSync(data) : lzwEncode(data));
    const s: PdfStream = { kind: 'stream', raw, dict: new Map<string, PdfObject>([
      ['Filter', name(filter)], ['DecodeParms', parms(bpc, colors, columns)],
    ]) };
    expect(decodeStream(s)).toEqual(Uint8Array.from(decoded));
  });
});

describe('image predictor parameter resolution', () => {
  it.each(['direct', 'dictionary ref', 'array refs', 'scalar refs'] as const)('handles %s without mutating source parameters', (shape) => {
    const doc = Document.New();
    const dp = parms(1, 1, 9);
    if (shape === 'scalar refs') for (const [k, v] of dp) dp.set(k, doc.allocObject(v));
    let value: PdfObject = shape === 'direct' || shape === 'scalar refs' ? dp : doc.allocObject(dp);
    let filter: PdfObject = name('FlateDecode');
    let raw: Uint8Array = new Uint8Array(deflateSync(Uint8Array.from([0x80, 0x55, 0x40, 0x2a])));
    if (shape === 'array refs') {
      filter = doc.allocObject([doc.allocObject(name('ASCIIHexDecode')), doc.allocObject(name('FlateDecode'))]);
      value = doc.allocObject([null, value]);
      raw = asciiHexEncode(raw);
    }
    const before = new Map(dp);
    const s: PdfStream = { kind: 'stream', raw, dict: new Map<string, PdfObject>([
      ['Width', 9], ['Height', 2], ['BitsPerComponent', 1], ['ColorSpace', name('DeviceGray')],
      ['Filter', filter], [shape === 'direct' ? 'DP' : 'DecodeParms', value],
    ]) };
    doc.allocObject(s);
    expect(decodeImageStream(doc, s)).toEqual(Uint8Array.from([0xff, 0xd5, 0x7f, 0xaa]));
    expect(dp).toEqual(before);
    expect(s.dict.get(shape === 'direct' ? 'DP' : 'DecodeParms')).toBe(value);
  });

  it('keeps decoded-byte limits inside the filter path', () => {
    const doc = Document.Open(Document.New().Save(), { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 3 }) });
    const s: PdfStream = { kind: 'stream', raw: new Uint8Array(deflateSync(Uint8Array.from([0x80, 0x55, 0x40, 0x2a]))),
      dict: new Map<string, PdfObject>([['Width', 9], ['Height', 2], ['Filter', name('FlateDecode')], ['DecodeParms', parms(1, 1, 9)]]) };
    doc.allocObject(s);
    expect(() => decodeImageStream(doc, s)).toThrow(ResourceLimitError);
  });
});
