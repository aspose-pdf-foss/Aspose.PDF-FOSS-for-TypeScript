import { describe, it, expect } from 'vitest';
import { CffFont } from '../src/cff.js';
import { buildMinimalCff, buildCidCff, buildNameKeyedCff, buildWidthCff } from './helpers/build-cff.js';

describe('CffFont — Type2 charstring interpreter', () => {
  const cff = new CffFont(buildMinimalCff());

  it('parses the CharStrings INDEX glyph count and unitsPerEm', () => {
    expect(cff.numGlyphs).toBe(2);
    expect(cff.unitsPerEm).toBe(1000);
    expect(cff.isCID).toBe(false);
  });

  it('interprets the box charstring to the expected cubic path', () => {
    const path = cff.glyphPath(1);
    expect(path).toEqual([
      { op: 'M', x: 100, y: 0 },
      { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 },
      { op: 'L', x: 100, y: 700 },
      { op: 'Z' },
    ]);
  });

  it('returns an empty path for the .notdef glyph', () => {
    expect(cff.glyphPath(0)).toEqual([]);
  });
});

describe('CffFont — CID-keyed (ROS + FDArray + FDSelect + charset)', () => {
  const cff = new CffFont(buildCidCff());

  it('recognizes the CID font and maps CID→GID through the charset', () => {
    expect(cff.isCID).toBe(true);
    expect(cff.numGlyphs).toBe(2);
    expect(cff.cidToGid(1)).toBe(1);
    expect(cff.cidToGid(0)).toBe(0);
  });

  it('interprets the charstring selected via FDSelect/FDArray', () => {
    expect(cff.glyphPath(cff.cidToGid(1))).toEqual([
      { op: 'M', x: 100, y: 0 },
      { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 },
      { op: 'L', x: 100, y: 700 },
      { op: 'Z' },
    ]);
  });
});

describe('CffFont — name-keyed reads', () => {
  it('maps gid to glyph name through the charset', () => {
    const names = new CffFont(buildNameKeyedCff()).charsetNames();
    expect(names[0]).toBe('.notdef');
    expect(names[1]).toBe('A');          // standard SID 34
    expect(names[2]).toBe('g07');        // custom SID 391, via the String INDEX
    expect(names[3]).toBe('g08');
  });

  it('reads the built-in Encoding as code -> gid', () => {
    const e = new CffFont(buildNameKeyedCff()).builtinEncoding()!;
    expect(e.get(0x41)).toBe(1);         // 'A' -> gid 1
    expect(e.get(0x42)).toBe(2);         // 'B' -> gid 2
    expect(e.get(0x43)).toBeUndefined(); // 'C' is unencoded
  });

  it('returns undefined for a predefined Encoding rather than inventing a table', () => {
    // buildMinimalCff has no Encoding operator -> predefined Standard.
    expect(new CffFont(buildMinimalCff()).builtinEncoding()).toBeUndefined();
  });

  it('returns no charset names for a CID-keyed font, whose charset holds CIDs', () => {
    expect(new CffFont(buildCidCff()).charsetNames()).toEqual([]);
  });
});

describe('CffFont — charstring widths', () => {
  const cff = new CffFont(buildWidthCff());

  it('uses defaultWidthX when the charstring omits the width operand', () => {
    expect(cff.glyphWidth(0)).toBe(250);
  });

  it('uses nominalWidthX + the operand when the charstring supplies one', () => {
    // The trap: the operand is a DELTA from nominalWidthX, not the width. An
    // implementation that returns the operand gives 100 here, which looks like
    // a plausible narrow glyph.
    expect(cff.glyphWidth(1)).toBe(500);
  });

  it('answers undefined for a gid the font does not have', () => {
    expect(cff.glyphWidth(2)).toBeUndefined();
    expect(cff.glyphWidth(-1)).toBeUndefined();
  });

  it('leaves glyphPath unchanged', () => {
    expect(cff.glyphPath(1)).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'Z' }]);
  });
});
