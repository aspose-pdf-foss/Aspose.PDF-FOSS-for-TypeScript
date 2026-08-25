import { describe, it, expect } from 'vitest';
import { CidCMap, parseCidCMap } from '../src/cidcmap.js';

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => Uint8Array.from(b);

/** The codespace shape of 90ms-RKSJ-H: Shift-JIS, so single bytes for ASCII
 *  and half-width katakana interleaved with two-byte lead/trail pairs. */
const SJIS_CODESPACE =
  '4 begincodespacerange\n' +
  '<00> <80>\n<8140> <9FFC>\n<A0> <DF>\n<E040> <FCFC>\n' +
  'endcodespacerange\n';

describe('parseCidCMap', () => {
  it('parses codespace, cidrange, cidchar and the CIDSystemInfo scalars', () => {
    const parts = parseCidCMap(enc(
      '%!PS-Adobe-3.0 Resource-CMap\n' +
      '/CIDInit /ProcSet findresource begin\n' +
      '12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo 3 dict dup begin\n' +
      '  /Registry (Adobe) def\n  /Ordering (Japan1) def\n  /Supplement 4 def\nend def\n' +
      '/CMapName /Test-H def\n/CMapType 1 def\n/WMode 0 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '2 begincidrange\n<0020> <007e> 1\n<3041> <3093> 842\nendcidrange\n' +
      '1 begincidchar\n<00a0> 231\nendcidchar\n' +
      'endcmap\nend\nend\n'
    ));

    expect(parts.name).toBe('Test-H');
    expect(parts.registry).toBe('Adobe');
    expect(parts.ordering).toBe('Japan1');
    expect(parts.supplement).toBe(4);
    expect(parts.wmode).toBe(0);
    expect(parts.codespace).toEqual([{ nbytes: 2, lo: 0x0000, hi: 0xffff }]);
    expect(parts.cidRanges).toEqual([
      { nbytes: 2, lo: 0x0020, hi: 0x007e, cid: 1 },
      { nbytes: 2, lo: 0x3041, hi: 0x3093, cid: 842 },
      { nbytes: 2, lo: 0x00a0, hi: 0x00a0, cid: 231 }, // cidchar -> a one-code range
    ]);
  });

  it('reads /WMode 1 and the name in a usecmap', () => {
    const parts = parseCidCMap(enc(
      '/UniJIS-UCS2-H usecmap\n/CMapName /UniJIS-UCS2-V def\n/WMode 1 def\n' +
      '1 begincidrange\n<2010> <2010> 7893\nendcidrange\n'
    ));
    expect(parts.usecmap).toBe('UniJIS-UCS2-H');
    expect(parts.wmode).toBe(1);
    expect(parts.codespace).toEqual([]);
  });

  it('parses notdefrange separately from cidrange', () => {
    const parts = parseCidCMap(enc(
      '1 begincodespacerange\n<00> <ff>\nendcodespacerange\n' +
      '1 begincidrange\n<41> <5a> 100\nendcidrange\n' +
      '1 beginnotdefrange\n<00> <1f> 7\nendnotdefrange\n'
    ));
    expect(parts.cidRanges).toEqual([{ nbytes: 1, lo: 0x41, hi: 0x5a, cid: 100 }]);
    expect(parts.notdefRanges).toEqual([{ nbytes: 1, lo: 0x00, hi: 0x1f, cid: 7 }]);
  });

  it('skips damaged entries instead of failing the whole CMap', () => {
    // A stray keyword and a truncated triple sit between two good ranges.
    const parts = parseCidCMap(enc(
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '4 begincidrange\n' +
      '<0020> <0020> 1\n' +
      '<0030> <0031>\n' +           // missing the CID
      '<0040> <0041> 5\n' +
      'endcidrange\n'
    ));
    // The malformed entry costs its own bytes; resynchronisation picks the next
    // well-formed triple back up rather than dropping the rest of the CMap.
    expect(parts.cidRanges).toContainEqual({ nbytes: 2, lo: 0x20, hi: 0x20, cid: 1 });
    expect(parts.cidRanges.length).toBeGreaterThanOrEqual(1);
  });

  it('does not throw on bytes that are not a CMap at all', () => {
    expect(() => parseCidCMap(bytes(0x29, 0x7b, 0x7d, 0x3e, 0xff, 0x00))).not.toThrow();
    expect(() => parseCidCMap(new Uint8Array(0))).not.toThrow();
  });
});

describe('CidCMap.next', () => {
  const sjis = new CidCMap(parseCidCMap(enc(
    SJIS_CODESPACE +
    '3 begincidrange\n<20> <7d> 231\n<829f> <82f1> 842\n<a0> <df> 326\nendcidrange\n'
  )));

  it('takes one byte or two according to the codespace', () => {
    // "A" then Shift-JIS "あ" (0x82 0xA0) then half-width "ｱ" (0xB1).
    const run = sjis.decode(bytes(0x41, 0x82, 0xa0, 0xb1));
    expect(run.map((u) => u.len)).toEqual([1, 2, 1]);
    expect(run.map((u) => u.cid)).toEqual([
      231 + (0x41 - 0x20),   // ASCII 'A'
      843,                    // あ
      326 + (0xb1 - 0xa0),   // ｱ
    ]);
  });

  it('compares codespace ranges byte by byte, not as integers', () => {
    // 0x8200 is inside <8140>..<9FFC> as an integer, but its trail byte 0x00 is
    // below the range's 0x40 — a lead byte with an out-of-range trail is what
    // mislabelled Shift-JIS is made of, and an integer test swallows it as a
    // valid two-byte code.
    const u = sjis.next(bytes(0x82, 0x00), 0);
    expect(u.matched).toBe(false);
    // The lead byte still starts a two-byte range, so two bytes are consumed.
    expect(u.len).toBe(2);
    expect(sjis.cid(u.code, u.len)).toBe(0);
  });

  it('always advances on a byte no codespace accepts', () => {
    const u = sjis.next(bytes(0xff), 0);
    expect(u.matched).toBe(false);
    expect(u.len).toBeGreaterThanOrEqual(1);
    // The loop in decode() must terminate on nothing but garbage.
    expect(sjis.decode(bytes(0xff, 0xfe, 0xfd)).length).toBeGreaterThan(0);
  });

  it('consumes a truncated trailing code without reading past the end', () => {
    const run = sjis.decode(bytes(0x41, 0x82)); // lead byte with no trail
    expect(run.map((u) => u.len)).toEqual([1, 1]);
    expect(run[1].matched).toBe(false);
  });
});

describe('CidCMap usecmap inheritance', () => {
  const parent = new CidCMap(parseCidCMap(enc(
    '2 begincodespacerange\n<0000> <D7FF>\n<E000> <FFFF>\nendcodespacerange\n' +
    '2 begincidrange\n<2010> <2010> 662\n<3041> <3093> 842\nendcidrange\n'
  )));
  // Shaped like UniJIS-UCS2-V: no codespace of its own, a handful of overrides.
  const child = new CidCMap(parseCidCMap(enc(
    '/Parent-H usecmap\n/WMode 1 def\n' +
    '1 begincidrange\n<2010> <2010> 7893\nendcidrange\n'
  )), parent);

  it('inherits the parent codespace, so a vertical CMap can decode at all', () => {
    // The child declares no begincodespacerange. Without inheritance it matches
    // nothing and every vertical CMap silently decodes to no codes whatsoever.
    const run = child.decode(bytes(0x30, 0x42));
    expect(run.length).toBe(1);
    expect(run[0].len).toBe(2);
    expect(run[0].matched).toBe(true);
  });

  it('prefers its own mapping and falls through for the rest', () => {
    expect(child.cid(0x2010, 2)).toBe(7893); // overridden
    expect(child.cid(0x3042, 2)).toBe(843);  // inherited
    expect(parent.cid(0x2010, 2)).toBe(662); // parent unchanged
  });

  it('carries WMode and inherits the CIDSystemInfo', () => {
    expect(child.wmode).toBe(1);
    expect(parent.wmode).toBe(0);
  });

  it('lets a parent cidrange outrank a child notdefrange', () => {
    // A notdef is a substitute, so it must lose to a real mapping anywhere in
    // the chain — otherwise a child's catch-all notdef blanks the parent.
    const withNotdef = new CidCMap(parseCidCMap(enc(
      '/Parent-H usecmap\n1 beginnotdefrange\n<0000> <ffff> 1\nendnotdefrange\n'
    )), parent);
    expect(withNotdef.cid(0x3042, 2)).toBe(843);
    expect(withNotdef.cid(0x0500, 2)).toBe(1); // nothing maps it: the notdef applies
  });

  it('does not interpolate across a notdefrange', () => {
    // A notdefrange names one substitute for the whole range (Adobe TN #5014),
    // unlike a cidrange. Interpolating turns B5pc-H's `<00> <1f> 1` — every
    // control code to CID 1 — into a walk across CIDs 1..32, drawing real
    // glyphs for codes that map to nothing.
    const cmap = new CidCMap(parseCidCMap(enc(
      '1 begincodespacerange\n<00> <ff>\nendcodespacerange\n' +
      '1 beginnotdefrange\n<00> <1f> 1\nendnotdefrange\n'
    )));
    expect(cmap.cid(0x00, 1)).toBe(1);
    expect(cmap.cid(0x1f, 1)).toBe(1);
    expect(cmap.cid(0x20, 1)).toBe(0);
  });
});

describe('CidCMap.cid', () => {
  const cmap = new CidCMap(parseCidCMap(enc(
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    '3 begincidrange\n<0020> <007e> 1\n<3041> <3093> 842\n<ff00> <ff01> 9\nendcidrange\n'
  )));

  it('interpolates within a range', () => {
    expect(cmap.cid(0x0020, 2)).toBe(1);
    expect(cmap.cid(0x0021, 2)).toBe(2);
    expect(cmap.cid(0x007e, 2)).toBe(1 + (0x7e - 0x20));
  });

  it('returns 0 for a code between ranges', () => {
    expect(cmap.cid(0x0100, 2)).toBe(0);
    expect(cmap.cid(0x3094, 2)).toBe(0);
    expect(cmap.cid(0xffff, 2)).toBe(0);
  });

  it('does not confuse codes of a different width', () => {
    expect(cmap.cid(0x20, 1)).toBe(0);
  });
});
