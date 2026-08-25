import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { type1ToCff } from '../src/type1cff.js';
import { Type1Font } from '../src/type1.js';
import { CffFont } from '../src/cff.js';
import { buildType1, t1num } from './helpers/build-type1.js';
import type { Path } from '../src/pagerender.js';

/** Round a path's coordinates the way the emitter does, so the comparison is
 *  against what integer Type 2 operands can represent rather than against
 *  floating-point noise. */
function rounded(p: Path): Path {
  return p.map((s) => s.op === 'C'
    ? { op: 'C' as const, x1: Math.round(s.x1), y1: Math.round(s.y1),
        x2: Math.round(s.x2), y2: Math.round(s.y2), x: Math.round(s.x), y: Math.round(s.y) }
    : s.op === 'Z' ? s : { op: s.op, x: Math.round(s.x), y: Math.round(s.y) });
}

/** Type 2 closes subpaths implicitly, so a 'Z' has no counterpart to compare. */
const noZ = (p: Path): Path => p.filter((s) => s.op !== 'Z');

const REAL = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));

describe('type1ToCff — against the real fixture', () => {
  it('agrees with the Type 1 interpreter on every glyph outline', () => {
    // The load-bearing assertion. cff.ts and type1charstring.ts are two
    // separately written interpreters, so their agreement is evidence from
    // outside the code under test -- not the self-differential this repo warns
    // about. Same anchoring habit as checking CFF widths against hmtx.
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    const cff = new CffFont(conv.cff);

    expect(conv.order.length).toBe(t1.numGlyphs);
    expect(cff.numGlyphs).toBe(t1.numGlyphs);

    for (let newGid = 0; newGid < conv.order.length; newGid++) {
      const oldGid = conv.order[newGid];
      expect(noZ(cff.glyphPath(newGid))).toEqual(noZ(rounded(t1.glyphPath(oldGid))));
    }
  });

  it('puts .notdef at gid 0 even though the font lists it LAST', () => {
    // NimbusSans-Regular.t1 lists /.notdef last -- off by 854 -- so assuming
    // gid 0 is .notdef is wrong on the one real font available.
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    expect(t1.glyphName(conv.order[0])).toBe('.notdef');
    expect(t1.glyphName(0)).not.toBe('.notdef');   // the premise of the test
  });

  it('carries each glyph advance across unchanged', () => {
    // Both halves, and the second is the one that measures anything.
    // `conv.advances` is a pass-through from the Type 1 font, so it agrees with
    // the source whatever the emitter does; `CffFont.glyphWidth` reads the
    // WIDTH BACK OUT OF THE CHARSTRING, through the independent interpreter,
    // which is the only assertion here that can see an omitted width operand.
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    const cff = new CffFont(conv.cff);
    for (let newGid = 0; newGid < conv.order.length; newGid++) {
      const want = Math.round(t1.glyphWidth(conv.order[newGid]));
      expect(conv.advances[newGid]).toBe(want);
      expect(cff.glyphWidth(newGid)).toBe(want);
    }
  });

  it('maps code points to the renumbered gids, not the original ones', () => {
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    const gid = conv.unicode.get(0x41);           // 'A'
    expect(gid).toBeDefined();
    expect(t1.glyphName(conv.order[gid!])).toBe('A');
  });

  it('reports the header bbox and unitsPerEm', () => {
    const conv = type1ToCff(REAL);
    expect(conv.bbox).toEqual([-210, -299, 1032, 1075]);
    expect(conv.header.unitsPerEm).toBe(1000);
  });
});

describe('type1ToCff — synthetics', () => {
  /** `sbx wx hsbw` then the body. hsbw MOVES THE PEN to (sbx, 0). */
  const hsbw = (sbx: number, wx: number): number[] => [...t1num(sbx), ...t1num(wx), 13];

  /** The new gid holding `name`, resolved through the renumbering. */
  function gidOf(font: Uint8Array, conv: { order: number[] }, name: string): number {
    const t1 = new Type1Font(font);
    return conv.order.findIndex((old) => t1.glyphName(old) === name);
  }

  it('emits a width even for a glyph that draws nothing', () => {
    // With Private [0 0], nominalWidthX and defaultWidthX are both 0, so an
    // OMITTED width means an advance of zero. A blank glyph is where that
    // shows: a space would stop advancing and every line would pile up.
    const font = buildType1({
      charstrings: {
        '.notdef': Uint8Array.from([...hsbw(0, 0), 14]),
        'space': Uint8Array.from([...hsbw(0, 600), 14]),
      },
    });
    const conv = type1ToCff(font);
    const cff = new CffFont(conv.cff);
    const gid = gidOf(font, conv, 'space');
    expect(conv.advances[gid]).toBe(600);
    expect(cff.glyphPath(gid)).toEqual([]);       // draws nothing, still advances
    // Read back through cff.ts: a charstring that is bare `endchar` carries no
    // width operand, so this is 0 -- the defect the trailing emit prevents.
    expect(cff.glyphWidth(gid)).toBe(600);
  });

  it('survives a non-1000 unitsPerEm without rescaling the advance', () => {
    // The advance and the outline are in the same space, so the converter must
    // not normalise either -- otfFromCff is told the unitsPerEm instead. The
    // glyph is deliberately blank: this case is about the ADVANCE, and a body
    // would only add a charstring-grammar detail it does not need. (Type 1
    // opcode 4 is vmoveto, not vlineto -- 7 is vlineto -- and a body with no
    // leading moveto would yield a path starting with a line segment.)
    const font = buildType1({
      charstrings: {
        '.notdef': Uint8Array.from([...hsbw(0, 0), 14]),
        'A': Uint8Array.from([...hsbw(0, 1024), 14]),
      },
      fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0],
    });
    const conv = type1ToCff(font);
    expect(conv.header.unitsPerEm).toBe(2048);
    expect(conv.advances[gidOf(font, conv, 'A')]).toBe(1024);
  });
});
