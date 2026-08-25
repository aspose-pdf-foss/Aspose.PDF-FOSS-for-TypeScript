import { describe, it, expect } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import {
  cidUnicodeOrderings, decodeCidUnicode, encodeCidUnicode, getCidToUnicode,
  type CidUnicodeMap,
} from '../src/cidunicode.js';
import { CID_UNICODE_DATA } from '../src/cidunidata.js';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const blob = (ordering: string) =>
  new Uint8Array(brotliDecompressSync(Buffer.from(CID_UNICODE_DATA[ordering], 'base64')));

describe('the bundled CID -> Unicode tables', () => {
  it('ships one per PDF-relevant Adobe collection', () => {
    expect(cidUnicodeOrderings().sort()).toEqual(['CNS1', 'GB1', 'Japan1', 'KR', 'Korea1']);
  });

  it('maps the CIDs the /Encoding CMaps produce for each collection', () => {
    // The other half of the round trip: z6wd.1's tests assert that U+3042 is
    // Adobe-Japan1 CID 843 and U+4E00 is Adobe-GB1 CID 4162; these read the
    // same CIDs back to the same characters, through Adobe's own table rather
    // than by inverting the CMap.
    expect(getCidToUnicode('Japan1')!.lookup(843)).toBe('あ');
    expect(getCidToUnicode('GB1')!.lookup(4162)).toBe('一');
    expect(getCidToUnicode('CNS1')!.lookup(595)).toBe('一');
    expect(getCidToUnicode('Korea1')!.lookup(1086)).toBe('가');
  });

  it('preserves the many-to-one choices that inverting a CMap gets backwards', () => {
    // Adobe-Japan1 CID 93 is U+00A6 and CID 99 is U+007C. Both characters map
    // into both CIDs going the other way, so inverting UniJIS-UCS2-H returns
    // the two swapped — which is the whole reason these tables are bundled.
    const jp = getCidToUnicode('Japan1')!;
    expect(jp.lookup(93)).toBe('¦');
    expect(jp.lookup(99)).toBe('|');
  });

  it('answers for CIDs no UCS-2 code reaches', () => {
    // 13,569 Adobe-Japan1 CIDs are unreachable from UniJIS-UCS2-H, so an
    // inversion-based table would have nothing for them at all.
    const jp = getCidToUnicode('Japan1')!;
    let answered = 0;
    for (let cid = 20000; cid < 23000; cid++) if (jp.lookup(cid) !== undefined) answered++;
    expect(answered).toBeGreaterThan(1000);
  });

  it('never answers with a replacement character', () => {
    // Adobe spells "no Unicode for this CID" as U+FFFD; carrying that through
    // salts extracted text with characters that read as a decoding bug.
    for (const ordering of cidUnicodeOrderings()) {
      const m = decodeCidUnicode(blob(ordering));
      expect([...m.singleUnits].includes(0xfffd), ordering).toBe(false);
      expect(m.multi.some((s) => s.includes('�')), ordering).toBe(false);
    }
  });

  it('has no mapping for CID 0, which is .notdef in every collection', () => {
    for (const ordering of cidUnicodeOrderings()) {
      expect(getCidToUnicode(ordering)!.lookup(0), ordering).toBeUndefined();
    }
  });

  it('answers nothing for an ordering with no bundled table', () => {
    for (const o of ['Identity', 'Japan2', 'NoSuchOrdering', 'constructor', '__proto__']) {
      expect(getCidToUnicode(o), o).toBeUndefined();
    }
  });

  it('returns the same instance on a second load', () => {
    expect(getCidToUnicode('Japan1')).toBe(getCidToUnicode('Japan1'));
  });

  it('looks up a multi-unit destination, not just single-unit ones', () => {
    // 5,689 of the 113,292 entries are surrogate pairs or genuine
    // multi-character expansions, and they live in a separate column — so a
    // lookup that only consults the single-unit column answers for 95% of CIDs
    // and silently drops every non-BMP character.
    let checked = 0;
    for (const ordering of cidUnicodeOrderings()) {
      const m = decodeCidUnicode(blob(ordering));
      const table = getCidToUnicode(ordering)!;
      for (let i = 0; i < Math.min(5, m.multiCids.length); i++) {
        expect(table.lookup(m.multiCids[i]), `${ordering} cid ${m.multiCids[i]}`).toBe(m.multi[i]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps surrogate pairs and multi-character expansions intact', () => {
    // The multi-unit side list: destinations that are not one UTF-16 unit.
    let pairs = 0;
    for (const ordering of cidUnicodeOrderings()) {
      const m = decodeCidUnicode(blob(ordering));
      for (const s of m.multi) {
        expect(s.length, ordering).toBeGreaterThan(1);
        if (s.codePointAt(0)! > 0xffff) pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

describe('the CID -> Unicode codec', () => {
  it('round-trips a table with both entry kinds', () => {
    const m: CidUnicodeMap = {
      singleCids: Uint32Array.from([1, 2, 100, 65535]),
      singleUnits: Uint32Array.from([0x3042, 0x3043, 0x4e00, 0x7c]),
      multiCids: Uint32Array.from([7, 9]),
      multi: ['𠮟', 'ffi'],
    };
    const back = decodeCidUnicode(encodeCidUnicode(m));
    expect([...back.singleCids]).toEqual([...m.singleCids]);
    expect([...back.singleUnits]).toEqual([...m.singleUnits]);
    expect([...back.multiCids]).toEqual([...m.multiCids]);
    expect(back.multi).toEqual(m.multi);
  });

  it('round-trips destinations that step backwards', () => {
    // The unit column is delta-encoded, so a table whose characters are not
    // monotonic in CID order exercises the zigzag.
    const m: CidUnicodeMap = {
      singleCids: Uint32Array.from([1, 2, 3]),
      singleUnits: Uint32Array.from([0xffff, 0x20, 0x9000]),
      multiCids: new Uint32Array(0),
      multi: [],
    };
    expect([...decodeCidUnicode(encodeCidUnicode(m)).singleUnits]).toEqual([0xffff, 0x20, 0x9000]);
  });

  it('re-encodes every bundled table to the exact bytes it was built from', () => {
    for (const ordering of cidUnicodeOrderings()) {
      const bytes = blob(ordering);
      expect(encodeCidUnicode(decodeCidUnicode(bytes)), ordering).toEqual(bytes);
    }
  });

  it('returns what a truncated blob held, rather than throwing', () => {
    const full = encodeCidUnicode({
      singleCids: Uint32Array.from([1, 2]),
      singleUnits: Uint32Array.from([0x41, 0x42]),
      multiCids: Uint32Array.from([3]),
      multi: ['ab'],
    });
    for (let cut = 0; cut < full.length; cut++) {
      expect(() => decodeCidUnicode(full.subarray(0, cut))).not.toThrow();
    }
  });
});

const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));
const bytes = (...b: number[]) => Uint8Array.from(b);
const id = (o: PdfObject | undefined) => o as PdfObject;
const noInflate = () => new Uint8Array(0);
const str = (s: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(s) });

/** A Type0 font with no /ToUnicode, declaring a collection. */
function cjkFont(encoding: string, sysInfo?: Record<string, PdfObject>): TextFont {
  return new TextFont(dict({
    Subtype: name('Type0'),
    BaseFont: name('KozMinPr6N-Regular'),
    Encoding: name(encoding),
    DescendantFonts: [dict({
      Subtype: name('CIDFontType0'),
      DW: 1000,
      ...(sysInfo ? { CIDSystemInfo: dict(sysInfo) } : {}),
    })],
  }), id, noInflate as never);
}

describe('a CJK font with no /ToUnicode', () => {
  it('extracts via /CIDSystemInfo for each collection', () => {
    const japan1 = { Registry: str('Adobe'), Ordering: str('Japan1'), Supplement: 6 };
    expect(cjkFont('UniJIS-UCS2-H', japan1).decode(bytes(0x30, 0x42))).toBe('あ');
    expect(cjkFont('90ms-RKSJ-H', japan1).decode(bytes(0x82, 0xa0))).toBe('あ');

    const gb1 = { Registry: str('Adobe'), Ordering: str('GB1'), Supplement: 5 };
    expect(cjkFont('UniGB-UCS2-H', gb1).decode(bytes(0x4e, 0x00))).toBe('一');

    const cns1 = { Registry: str('Adobe'), Ordering: str('CNS1'), Supplement: 7 };
    expect(cjkFont('UniCNS-UCS2-H', cns1).decode(bytes(0x4e, 0x00))).toBe('一');

    const korea1 = { Registry: str('Adobe'), Ordering: str('Korea1'), Supplement: 2 };
    expect(cjkFont('UniKS-UCS2-H', korea1).decode(bytes(0xac, 0x00))).toBe('가');
  });

  it('decodes a mixed-width Shift-JIS run end to end', () => {
    const f = cjkFont('90ms-RKSJ-H', { Registry: str('Adobe'), Ordering: str('Japan1') });
    // 'A' (1 byte) + あ (2 bytes) — codes to CIDs to characters.
    expect(f.decode(bytes(0x41, 0x82, 0xa0))).toBe('Aあ');
  });

  it('falls back to the /Encoding CMap\'s collection when /CIDSystemInfo is absent', () => {
    // The CMap states which collection its CIDs belong to, so a font that omits
    // /CIDSystemInfo is not hopeless.
    expect(cjkFont('UniJIS-UCS2-H').decode(bytes(0x30, 0x42))).toBe('あ');
  });

  it('prefers /CIDSystemInfo over the /Encoding CMap when they differ', () => {
    // The common real shape: /Identity-H with a genuine collection. The CMap
    // says its CIDs are "Identity" — glyph indices, no characters — while the
    // descendant font declares Adobe-Japan1, and the descendant is the
    // authority on what its own CIDs mean. Reading the CMap instead extracts
    // nothing at all from a large share of real CJK files.
    const f = cjkFont('Identity-H', {
      Registry: str('Adobe'), Ordering: str('Japan1'), Supplement: 6,
    });
    expect(f.decode(bytes(0x03, 0x4b))).toBe(getCidToUnicode('Japan1')!.lookup(843));
    expect(f.decode(bytes(0x03, 0x4b))).toBe('あ');   // CID 843 = 0x034b
  });

  it('extracts nothing, rather than replacement characters, for an unknown registry', () => {
    // A private collection may call its ordering Japan1 while numbering CIDs
    // however it likes; running those through Adobe's table would emit
    // confident Japanese for a font that contains none.
    const f = cjkFont('Identity-H', {
      Registry: str('Fontworks'), Ordering: str('Japan1'), Supplement: 0,
    });
    const out = f.decode(bytes(0x03, 0x4b));
    expect(out).toBe('');
    expect(out).not.toContain('�');
  });

  it('extracts nothing for an unrecognised ordering', () => {
    const f = cjkFont('Identity-H', {
      Registry: str('Adobe'), Ordering: str('NoSuchCollection'), Supplement: 0,
    });
    expect(f.decode(bytes(0x03, 0x4b))).toBe('');
  });

  it('extracts nothing for Identity, whose CIDs are glyph indices', () => {
    // Identity ordering says the CIDs are the font program's own glyph ids, and
    // a glyph id has no character meaning at all.
    const f = cjkFont('Identity-H', {
      Registry: str('Adobe'), Ordering: str('Identity'), Supplement: 0,
    });
    expect(f.decode(bytes(0x03, 0x4b))).toBe('');
  });

  it('lets /ToUnicode win where it has an answer', () => {
    const tu = {
      kind: 'stream' as const,
      dict: dict({}),
      raw: new TextEncoder().encode(
        '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
        '1 beginbfchar <3042> <0058> endbfchar\n'),
    };
    const f = new TextFont(dict({
      Subtype: name('Type0'),
      Encoding: name('UniJIS-UCS2-H'),
      ToUnicode: tu,
      DescendantFonts: [dict({
        Subtype: name('CIDFontType0'), DW: 1000,
        CIDSystemInfo: dict({ Registry: str('Adobe'), Ordering: str('Japan1') }),
      })],
    }), id, ((s: { raw: Uint8Array }) => s.raw) as never);
    // /ToUnicode is authoritative where it speaks...
    expect(f.decode(bytes(0x30, 0x42))).toBe('X');
    // ...and the collection table fills the gaps it leaves, which a partial
    // /ToUnicode has plenty of.
    expect(f.decode(bytes(0x30, 0x44))).toBe('い');
  });
});
