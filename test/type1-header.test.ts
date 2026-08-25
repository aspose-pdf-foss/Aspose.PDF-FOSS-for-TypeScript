import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isType1, readType1Header } from '../src/type1header.js';
import { buildType1 } from './helpers/build-type1.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';

/** One charstring is enough — this module never looks past `eexec`. */
const CS = { '.notdef': Uint8Array.from([139, 139, 13, 14]) };

describe('isType1', () => {
  it('accepts a PFA and a PFB, and rejects an sfnt', () => {
    expect(isType1(buildType1({ charstrings: CS }))).toBe(true);
    expect(isType1(buildType1({ charstrings: CS, pfb: true }))).toBe(true);
    expect(isType1(buildMinimalTtf())).toBe(false);
  });

  it('rejects bytes too short to judge', () => {
    expect(isType1(new Uint8Array(0))).toBe(false);
    expect(isType1(Uint8Array.from([0x25]))).toBe(false);
  });
});

describe('readType1Header', () => {
  it('reads the three value syntaxes off the real fixture', () => {
    // /FontName is a NAME, /FamilyName and /Weight are parenthesised STRINGS,
    // /FontBBox is four numbers in BRACES. Confusing them is silent.
    const bytes = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));
    const h = readType1Header(bytes);
    expect(h.fontName).toBe('NimbusSans-Regular');
    expect(h.familyName).toBe('Nimbus Sans');
    expect(h.weight).toBe('Regular');
    expect(h.italicAngle).toBe(0);
    expect(h.bbox).toEqual([-210, -299, 1032, 1075]);
    expect(h.unitsPerEm).toBe(1000);
  });

  it('reads a PFB without needing the segment headers stripped by the caller', () => {
    const h = readType1Header(buildType1({ charstrings: CS, pfb: true, fontName: 'PfbFont' }));
    expect(h.fontName).toBe('PfbFont');
  });

  it('accepts a bracketed /FontBBox as well as a braced one', () => {
    const braced = readType1Header(buildType1({ charstrings: CS, fontBBox: [1, 2, 3, 4] }));
    expect(braced.bbox).toEqual([1, 2, 3, 4]);
    // Some real fonts write brackets; the builder only writes braces, so this
    // half is exercised by patching the bytes directly.
    const raw = buildType1({ charstrings: CS, fontBBox: [1, 2, 3, 4] });
    const text = Buffer.from(raw).toString('latin1').replace('{1 2 3 4}', '[1 2 3 4]');
    expect(readType1Header(new Uint8Array(Buffer.from(text, 'latin1'))).bbox).toEqual([1, 2, 3, 4]);
  });

  it('leaves absent fields undefined rather than inventing them', () => {
    const h = readType1Header(buildType1({ charstrings: CS }));
    expect(h.familyName).toBeUndefined();
    expect(h.weight).toBeUndefined();
    expect(h.italicAngle).toBe(0);       // 0 is the documented default, not a miss
  });

  it('reads a non-1000 unitsPerEm from /FontMatrix', () => {
    const h = readType1Header(buildType1({
      charstrings: CS, fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0],
    }));
    expect(h.unitsPerEm).toBe(2048);
  });

  it('does not throw on bytes that open like PostScript but are not a font', () => {
    const junk = new Uint8Array(Buffer.from('%!PS-Adobe-3.0\nnothing here\n', 'latin1'));
    expect(() => readType1Header(junk)).not.toThrow();
    expect(readType1Header(junk).fontName).toBeUndefined();
  });
});
