import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { applyStreamFilter } from '../src/streamfilter.js';
import { decodeStream, filterList } from '../src/filters.js';
import { PdfObject, PdfStream, PdfDict, isStream, name, isName } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const bytes = (s: string) => new TextEncoder().encode(s);

/** A FlateDecode stream whose decoded payload is `text`. */
function flateStream(text: string, extra: [string, PdfObject][] = []): PdfStream {
  const raw = new Uint8Array(deflateSync(Buffer.from(bytes(text))));
  const dict: PdfDict = new Map<string, PdfObject>([
    ...extra, ['Filter', name('FlateDecode')], ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}
function dctStream(): PdfStream {
  const raw = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // fake JPEG bytes
  return { kind: 'stream', dict: new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Filter', name('DCTDecode')], ['Length', raw.length],
  ]), raw };
}
function metadataStream(): PdfStream {
  const raw = bytes('<x:xmpmeta>meta</x:xmpmeta>');
  return { kind: 'stream', dict: new Map<string, PdfObject>([
    ['Type', name('Metadata')], ['Subtype', name('XML')], ['Length', raw.length],
  ]), raw };
}

describe('applyStreamFilter — replace mode', () => {
  it('throws on an unsupported filter name', () => {
    expect(() => applyStreamFilter([], 'FlateDecode' as any))
      .toThrow(UnsupportedFeatureError);
  });

  it('replaces a Flate stream filter with LZWDecode and round-trips', () => {
    const s = flateStream('replace me with LZW');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'LZWDecode');
    const out = objs[0] as PdfStream;
    expect(isStream(out)).toBe(true);
    const f = out.dict.get('Filter');
    expect(isName(f) && f.name).toBe('LZWDecode');
    expect(out.dict.has('DecodeParms')).toBe(false);
    expect(decodeStream(out)).toEqual(bytes('replace me with LZW'));
    expect(s.raw).not.toBe(out.raw); // original stream object untouched
  });

  it('skips image-codec, metadata, and structural streams', () => {
    const dct = dctStream();
    const meta = metadataStream();
    const xref: PdfStream = { kind: 'stream', dict: new Map<string, PdfObject>([
      ['Type', name('XRef')], ['Length', 1]]), raw: Uint8Array.from([0]) };
    const objs: PdfObject[] = [dct, meta, xref];
    applyStreamFilter(objs, 'RunLengthDecode');
    expect(objs[0]).toBe(dct);   // same object reference => untouched
    expect(objs[1]).toBe(meta);
    expect(objs[2]).toBe(xref);
  });

  it('skips a stream already in the exact target filter', () => {
    const raw = Uint8Array.from([0x81, 0x00, 0x80]); // 2x 0x00 run + EOD (RunLength)
    const s: PdfStream = { kind: 'stream', dict: new Map<string, PdfObject>([
      ['Filter', name('RunLengthDecode')], ['Length', raw.length]]), raw };
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'RunLengthDecode');
    expect(objs[0]).toBe(s);
  });

  it('leaves non-stream objects alone', () => {
    const dict: PdfDict = new Map([['Type', name('Catalog')]]);
    const objs: PdfObject[] = [dict, 42, name('X')];
    applyStreamFilter(objs, 'LZWDecode');
    expect(objs).toEqual([dict, 42, name('X')]);
  });
});

/** A FlateDecode stream carrying a PNG-predictor DecodeParms whose decoded
 *  payload is the 8 bytes 10..80 (row filter tag 0 = None = identity). */
function flatePredictorStream(): { stream: PdfStream; data: Uint8Array } {
  const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const row = Uint8Array.from([0, ...data]); // leading PNG filter-type byte 0
  const raw = new Uint8Array(deflateSync(Buffer.from(row)));
  const parms: PdfDict = new Map<string, PdfObject>([
    ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 8],
  ]);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('FlateDecode')], ['DecodeParms', parms], ['Length', raw.length],
  ]);
  return { stream: { kind: 'stream', dict, raw }, data };
}
function rawStream(text: string): PdfStream { // uncompressed, no /Filter
  const raw = bytes(text);
  return { kind: 'stream', dict: new Map<string, PdfObject>([['Length', raw.length]]), raw };
}

describe('applyStreamFilter — armor mode', () => {
  it('armors a Flate stream: ASCII85 outer, Flate inner, 7-bit-clean, round-trips', () => {
    const s = flateStream('armor keeps compression');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCII85Decode');
    const out = objs[0] as PdfStream;
    const { names } = filterList(out);
    expect(names).toEqual(['ASCII85Decode', 'FlateDecode']);
    expect([...out.raw].every((b) => b < 0x80)).toBe(true); // 7-bit clean
    expect(decodeStream(out)).toEqual(bytes('armor keeps compression'));
  });

  it('armors an uncompressed stream with a single ASCII85 filter', () => {
    const s = rawStream('plain uncompressed body');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCIIHexDecode');
    const out = objs[0] as PdfStream;
    const f = out.dict.get('Filter');
    expect(isName(f) && f.name).toBe('ASCIIHexDecode'); // single name, not an array
    expect(out.dict.has('DecodeParms')).toBe(false);
    expect(decodeStream(out)).toEqual(bytes('plain uncompressed body'));
  });

  it('prepends null to DecodeParms so the inner predictor still applies', () => {
    const { stream, data } = flatePredictorStream();
    const objs: PdfObject[] = [stream];
    applyStreamFilter(objs, 'ASCII85Decode');
    const out = objs[0] as PdfStream;
    const dp = out.dict.get('DecodeParms') as PdfObject[];
    expect(Array.isArray(dp)).toBe(true);
    expect(dp[0]).toBe(null);            // parm-less ASCII85 slot
    expect(dp[1]).toBeInstanceOf(Map);   // preserved predictor parms
    expect(decodeStream(out)).toEqual(data);
  });

  it('skips a stream already armored on top with the target', () => {
    const s = flateStream('x');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCII85Decode');
    const first = objs[0];
    applyStreamFilter(objs, 'ASCII85Decode'); // second pass is a no-op
    expect(objs[0]).toBe(first);
  });
});
