import { describe, it, expect } from 'vitest';
import { serializeDocument } from '../src/serializer.js';
import { Document } from '../src/document.js';
import { decodeStream, filterList } from '../src/filters.js';
import { PdfObject, PdfStream, isStream, isName } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildStreamFilterDoc } from './helpers/build-streamfilter-pdf.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** All streams in a reopened document's object map. */
function streamsOf(doc: Document): PdfStream[] {
  const objs = (doc as any).objects as Map<number, PdfObject>;
  return [...objs.values()].filter(isStream) as PdfStream[];
}
/** typeName helper mirroring the source. */
function typeName(s: PdfStream): string | undefined {
  const t = s.dict.get('Type');
  return isName(t) ? t.name : undefined;
}

const TARGETS = ['ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode'] as const;
const ARMOR = new Set(['ASCII85Decode', 'ASCIIHexDecode']);

describe('Save({ streamFilter })', () => {
  // Expected decoded payloads of the three ELIGIBLE streams (content, Fx1, Fx2).
  const expected = new Set([
    hex(new TextEncoder().encode('BT /F1 12 Tf 10 10 Td (FLATE-CONTENT-STREAM) Tj ET')),
    hex(new TextEncoder().encode('UNCOMPRESSED-XOBJECT-BODY')),
    hex(Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80])),
  ]);

  for (const target of TARGETS) {
    it(`re-encodes eligible streams to ${target} and re-opens byte-identical`, () => {
      const { objects, trailer } = buildStreamFilterDoc();
      const re = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
      const streams = streamsOf(re);

      // Eligible streams: DCT + Metadata are excluded; the other three re-encoded.
      const eligible = streams.filter((s) => {
        const { names } = filterList(s);
        return typeName(s) !== 'Metadata' && !names.includes('DCTDecode');
      });
      const actual = new Set(eligible.map((s) => hex(decodeStream(s))));
      expect(actual).toEqual(expected);

      for (const s of eligible) {
        const { names } = filterList(s);
        if (ARMOR.has(target)) {
          expect(names[0]).toBe(target);                 // armored on top
          expect([...s.raw].every((b) => b < 0x80)).toBe(true); // 7-bit clean
        } else {
          expect(names).toEqual([target]);               // replaced
        }
      }

      // DCT image untouched.
      const dct = streams.find((s) => filterList(s).names.includes('DCTDecode'))!;
      expect(hex(dct.raw)).toBe(hex(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
      // Metadata untouched (no filter, original bytes).
      const meta = streams.find((s) => typeName(s) === 'Metadata')!;
      expect(filterList(meta).names).toEqual([]);
      expect(decodeStream(meta)).toEqual(
        new TextEncoder().encode('<?xpacket?><x:xmpmeta>title</x:xmpmeta>'));
    });
  }

  it('sequences filter-then-encrypt: ASCII85 + encrypt re-opens byte-identical', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const bytes = serializeDocument(objects, trailer, {
      streamFilter: 'ASCII85Decode', encrypt: { userPassword: 'u' },
    });
    const re = Document.Open(bytes, { password: 'u' });
    const eligible = streamsOf(re).filter((s) => {
      const { names } = filterList(s);
      return typeName(s) !== 'Metadata' && !names.includes('DCTDecode');
    });
    expect(new Set(eligible.map((s) => hex(decodeStream(s))))).toEqual(expected);
  });

  it('throws when combined with linearized output', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    expect(() => serializeDocument(objects, trailer, {
      streamFilter: 'ASCII85Decode', linearized: true,
    })).toThrow(UnsupportedFeatureError);
  });
});

describe('public surface', () => {
  it('accepts a StreamFilterName-typed option through the barrel export', () => {
    // The `StreamFilterName` type is re-exported from the package barrel; this
    // reference proves it compiles. serializeDocument stays a direct import.
    const target: import('../src/index.js').StreamFilterName = 'ASCII85Decode';
    const { objects, trailer } = buildStreamFilterDoc();
    expect(serializeDocument(objects, trailer, { streamFilter: target }).length)
      .toBeGreaterThan(0);
  });
});
