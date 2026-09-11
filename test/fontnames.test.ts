import { describe, it, expect } from 'vitest';
import { readFontNames, parseTableDirectory, namesFromTables } from '../src/fontnames.js';
import { buildNamedFont, buildNameRecords } from './helpers/build-sfnt.js';

describe('readFontNames', () => {
  it('reads family, subfamily and PostScript name', () => {
    const n = readFontNames(buildNamedFont({ family: 'Liberation Sans' }));
    expect(n).toBeDefined();
    expect(n!.family).toBe('Liberation Sans');
    expect(n!.subfamily).toBe('Regular');
    expect(n!.postScriptName).toBe('LiberationSans');
  });

  it('reads the typographic family (ID 16) when the font states one', () => {
    // ID 16 exists because ID 1 is capped at four styles per family: a font
    // with nine weights states 'Foo' in 16 and 'Foo Semibold' in 1, so a
    // reader using only ID 1 splits one family into several.
    const n = readFontNames(buildNamedFont({
      family: 'Foo Semibold', typographicFamily: 'Foo',
    }));
    expect(n!.family).toBe('Foo Semibold');
    expect(n!.typographicFamily).toBe('Foo');
  });

  it('reads style from head.macStyle and weight from OS/2', () => {
    const n = readFontNames(buildNamedFont({
      family: 'Foo', bold: true, italic: true, weight: 700,
    }));
    expect(n!.bold).toBe(true);
    expect(n!.italic).toBe(true);
    expect(n!.weight).toBe(700);
  });

  it('decodes a platform-1 ASCII record as well as platform-3 UTF-16BE', () => {
    const name = buildNameRecords([
      { plat: 1, nameID: 1, text: 'MacFamily' },
      { plat: 1, nameID: 2, text: 'Bold' },
    ]);
    const n = namesFromTables({ name });
    expect(n!.family).toBe('MacFamily');
    expect(n!.subfamily).toBe('Bold');
  });

  it('prefers a platform-3 record over a platform-1 one for the same ID', () => {
    // Both spellings are legal and a font may carry both. Windows records are
    // the ones real tooling reads, so a reader that took whichever came first
    // would disagree with every other consumer on some fonts and not others.
    const name = buildNameRecords([
      { plat: 1, nameID: 1, text: 'MacName' },
      { plat: 3, nameID: 1, text: 'WinName' },
    ]);
    expect(namesFromTables({ name })!.family).toBe('WinName');
  });

  it('keeps the PostScript name when the font states no family (ID 1)', () => {
    // sfnt.ts asks for ID 6 alone, and that name becomes the embedded font's
    // /BaseFont. Declining a font with no ID 1 dropped it -- caught by
    // test/sfnt.test.ts, whose fixture name table carries only ID 6.
    const name = buildNameRecords([{ plat: 1, nameID: 6, text: 'TestFont' }]);
    const n = namesFromTables({ name });
    expect(n).toBeDefined();
    expect(n!.postScriptName).toBe('TestFont');
    expect(n!.family).toBe('');
  });

  it('declines a ttcf collection, a WOFF wrapper and garbage', () => {
    const ttcf = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0]);
    const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0]);
    expect(readFontNames(ttcf)).toBeUndefined();
    expect(readFontNames(woff)).toBeUndefined();
    expect(readFontNames(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe('parseTableDirectory', () => {
  it('locates every table by tag, offset and length', () => {
    const font = buildNamedFont({ family: 'Foo' });
    const dir = parseTableDirectory(font)!;
    expect(dir.get('name')).toBeDefined();
    const { offset, length } = dir.get('name')!;
    // The slice the directory names must itself parse as a name table.
    expect(namesFromTables({ name: font.subarray(offset, offset + length) })!.family).toBe('Foo');
  });

  it('declines a header too short to hold its own directory', () => {
    expect(parseTableDirectory(new Uint8Array(8))).toBeUndefined();
  });
});

describe('FontNames OS/2 coverage fields', () => {
  const nameTable = () => buildNameRecords([
    { plat: 3, nameID: 1, text: 'Probe Sans' },
    { plat: 3, nameID: 2, text: 'Regular' },
  ]);

  it('reads sFamilyClass and ulUnicodeRange1..4 from OS/2', () => {
    const os2 = new Uint8Array(78);
    const v = new DataView(os2.buffer);
    v.setUint16(4, 400);          // usWeightClass, the field already read
    v.setInt16(30, 0x0805);       // sFamilyClass: class 8 (sans serif), subclass 5
    v.setUint32(42, 0x00000001);  // ulUnicodeRange1: bit 0, Basic Latin
    v.setUint32(46, 0x08000000);  // ulUnicodeRange2: bit 59 (32+27), CJK Unified Ideographs
    v.setUint32(50, 0x00020000);  // ulUnicodeRange3
    v.setUint32(54, 0x00000004);  // ulUnicodeRange4

    const n = namesFromTables({ name: nameTable(), os2 })!;
    expect(n.familyClass).toBe(8);
    expect(n.unicodeRange).toEqual([0x00000001, 0x08000000, 0x00020000, 0x00000004]);
  });

  // The guard, and it needs its OWN case: a 96-byte buildOS2() covers both
  // fields, so every other fixture in the suite passes with the guards deleted.
  it('leaves both undefined when OS/2 is too short to state them', () => {
    const os2 = new Uint8Array(31);            // usWeightClass yes, sFamilyClass no
    new DataView(os2.buffer).setUint16(4, 700);

    const n = namesFromTables({ name: nameTable(), os2 })!;
    expect(n.weight).toBe(700);                // the existing field still reads
    expect(n.familyClass).toBeUndefined();
    expect(n.unicodeRange).toBeUndefined();
  });

  it('leaves both undefined when OS/2 is absent entirely', () => {
    const n = namesFromTables({ name: nameTable() })!;
    expect(n.familyClass).toBeUndefined();
    expect(n.unicodeRange).toBeUndefined();
  });
});
