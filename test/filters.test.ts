import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeStream, applyDecodeFilters } from '../src/filters.js';
import { inflateStream } from '../src/flate.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { name } from '../src/types.js';

const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe('decodeStream', () => {
  it('returns raw when there is no filter', () => {
    const dict: PdfDict = new Map();
    expect(decodeStream({ kind: 'stream', dict, raw: bytes('plain') })).toEqual(bytes('plain'));
  });

  it('decodes a single FlateDecode (via inflateStream delegation)', () => {
    const raw = new Uint8Array(deflateSync(Buffer.from('hello world')));
    const dict: PdfDict = new Map([['Filter', name('FlateDecode')]]);
    expect(new TextDecoder().decode(inflateStream({ kind: 'stream', dict, raw }))).toBe('hello world');
  });

  it('decodes a filter chain [ASCIIHexDecode, FlateDecode] in order', () => {
    const flated = new Uint8Array(deflateSync(Buffer.from('chained!')));
    const hex = Array.from(flated).map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Filter', [name('ASCIIHexDecode'), name('FlateDecode')]],
    ]);
    const out = decodeStream({ kind: 'stream', dict, raw: bytes(hex) });
    expect(new TextDecoder().decode(out)).toBe('chained!');
  });

  it('throws UnsupportedFeatureError when an image codec remains', () => {
    const dict: PdfDict = new Map([['Filter', name('DCTDecode')]]);
    expect(() => decodeStream({ kind: 'stream', dict, raw: bytes('jpegbytes') })).toThrow(/DCTDecode/);
  });
});

describe('applyDecodeFilters', () => {
  it('stops at the terminal image codec and returns leading-decoded bytes', () => {
    const r = applyDecodeFilters(bytes('rawjpeg'), ['DCTDecode'], [undefined]);
    expect(r.terminal?.name).toBe('DCTDecode');
    expect(new TextDecoder().decode(r.bytes)).toBe('rawjpeg');
  });
});
