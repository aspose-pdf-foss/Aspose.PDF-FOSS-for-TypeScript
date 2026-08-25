import { describe, it, expect } from 'vitest';
import { runType1Charstring, Type1Env } from '../src/type1charstring.js';

/** Encode an operand the way a Type 1 charstring spells it. Note 255: a Type 1
 *  32-bit *integer*, where the same byte in a Type 2 charstring introduces a
 *  16.16 fixed-point number. */
function num(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const v = n - 108; return [(v >> 8) + 247, v & 0xff]; }
  if (n <= -108 && n >= -1131) { const v = -n - 108; return [(v >> 8) + 251, v & 0xff]; }
  return [255, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const cs = (...parts: (number[] | number)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : p)));

const noEnv: Type1Env = { subrs: [] };

describe('Type 1 charstring interpreter', () => {
  it('hsbw sets the width and moves the pen to the left sidebearing', () => {
    // 50 400 hsbw : sbx=50, width=400, current point (50,0).
    // 100 200 rmoveto then draws from (150,200), not (100,200).
    const g = runType1Charstring(cs(num(50), num(400), 13, num(100), num(200), 21, 14), noEnv);
    expect(g.width).toBe(400);
    expect(g.sbx).toBe(50);
    expect(g.path).toEqual([{ op: 'M', x: 150, y: 200 }, { op: 'Z' }]);
  });

  it('draws lines and closes a subpath', () => {
    const g = runType1Charstring(cs(
      num(0), num(500), 13,        // hsbw
      num(100), num(100), 21,      // rmoveto -> (100,100)
      num(300), 6,                 // hlineto -> (400,100)
      num(200), 7,                 // vlineto -> (400,300)
      num(-300), num(0), 5,        // rlineto -> (100,300)
      9,                           // closepath
      14,                          // endchar
    ), noEnv);
    expect(g.path).toEqual([
      { op: 'M', x: 100, y: 100 },
      { op: 'L', x: 400, y: 100 },
      { op: 'L', x: 400, y: 300 },
      { op: 'L', x: 100, y: 300 },
      { op: 'Z' },
    ]);
  });

  it('hlineto and vlineto take exactly one argument, unlike Type 2', () => {
    // A Type 2 interpreter alternates over the whole stack and would emit two
    // segments here. Type 1 uses the first operand and discards the rest.
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(100), num(200), 6, 14), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }, { op: 'Z' }]);
  });

  it('rrcurveto, hvcurveto and vhcurveto emit cubics', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(10), num(20), num(30), num(40), num(50), num(60), 8,   // rrcurveto
      num(10), num(20), num(30), num(40), 31,                    // hvcurveto
      num(10), num(20), num(30), num(40), 30,                    // vhcurveto
      14,
    ), noEnv);
    expect(g.path).toEqual([
      { op: 'M', x: 0, y: 0 },
      // rrcurveto dx1 dy1 dx2 dy2 dx3 dy3
      { op: 'C', x1: 10, y1: 20, x2: 40, y2: 60, x: 90, y: 120 },
      // hvcurveto dx1 dx2 dy2 dy3 — starts horizontal, ends vertical
      { op: 'C', x1: 100, y1: 120, x2: 120, y2: 150, x: 120, y: 190 },
      // vhcurveto dy1 dx2 dy2 dx3 — starts vertical, ends horizontal
      { op: 'C', x1: 120, y1: 200, x2: 140, y2: 230, x: 180, y: 230 },
      { op: 'Z' },
    ]);
  });

  it('callsubr does not bias its index', () => {
    // Type 2 would add 107 here. Index 5 and index 112 hold different drawings,
    // so a biased lookup produces the wrong one rather than nothing.
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 120; i++) subrs[i] = cs(11);
    subrs[5] = cs(num(300), 6, 11);              // hlineto 300, return
    subrs[112] = cs(num(300), 7, 11);            // vlineto 300, return
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(5), 10, 14), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }, { op: 'Z' }]);
  });

  it('div computes before the operator consumes it', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(600), num(2), 12, 12, 6,             // 600 2 div hlineto -> 300
      14,
    ), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }, { op: 'Z' }]);
  });

  it('reads a 255 operand as a 32-bit integer, not 16.16 fixed', () => {
    // 16.16 would make this 0.015..., and the line would be invisible.
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(1000), 6, 14), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 1000, y: 0 }, { op: 'Z' }]);
  });

  it('assembles a flex from the OtherSubrs 0/1/2 protocol', () => {
    // 1 callothersubr opens; seven rmoveto's accumulate (the first is the
    // reference point, discarded); 0 callothersubr closes into two curves.
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(0), num(1), 12, 16,                  // 0 args, othersubr 1: begin flex
      num(50), num(0), 21,                     // reference point
      num(50), num(0), 21,
      num(0), num(20), 21,
      num(20), num(0), 21,
      num(20), num(0), 21,
      num(0), num(-20), 21,
      num(20), num(0), 21,
      num(50), num(0), num(3), num(0), 12, 16, // 3 args, othersubr 0: end flex
      12, 17, 12, 17,                          // pop pop
      12, 33,                                  // setcurrentpoint
      14,
    ), noEnv);
    // Asserted on coordinates, not on a curve count: the seven collected points
    // are a reference point followed by two curves' worth of controls, and
    // taking the reference point as a control still yields two curves in
    // roughly the right place. Only the exact points distinguish them.
    expect(g.path).toEqual([
      { op: 'M', x: 0, y: 0 },
      { op: 'C', x1: 100, y1: 0, x2: 100, y2: 20, x: 120, y: 20 },
      { op: 'C', x1: 140, y1: 20, x2: 140, y2: 0, x: 160, y: 0 },
      { op: 'Z' },
    ]);
  });

  it('hint replacement leaves its subr number for the following pop', () => {
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) subrs[i] = cs(11);
    subrs[7] = cs(num(300), 6, 11);
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(7), num(1), num(3), 12, 16,          // subr# 1 3 callothersubr
      12, 17,                                  // pop -> 7
      10,                                      // callsubr 7
      14,
    ), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }, { op: 'Z' }]);
  });

  it('leaves an unknown othersubr’s arguments for pop', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(300), num(1), num(14), 12, 16,       // 1 arg, othersubr 14 (unknown)
      12, 17,                                  // pop -> 300
      6,                                       // hlineto 300
      14,
    ), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }, { op: 'Z' }]);
  });

  it('composes an accented glyph with seac', () => {
    const base = cs(num(0), num(500), 13, num(0), num(0), 21, num(100), 6, 14);
    const accent = cs(num(0), num(300), 13, num(0), num(0), 21, num(50), 7, 14);
    const env: Type1Env = {
      subrs: [],
      seacGlyph: (c) => (c === 65 ? base : c === 194 ? accent : undefined),   // /A, /acute
    };
    // sbx=25, then asb=10 adx=30 ady=400 bchar=65 achar=194.
    // The accent's x offset is sbx - asb + adx = 25 - 10 + 30 = 45, NOT adx.
    // Dropping that correction shifts every accent by the two glyphs'
    // sidebearing difference, which reads as bad kerning rather than a bug.
    const g = runType1Charstring(
      cs(num(25), num(500), 13, num(10), num(30), num(400), num(65), num(194), 12, 6), env);
    expect(g.path).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }, { op: 'Z' },
      { op: 'M', x: 45, y: 400 }, { op: 'L', x: 45, y: 450 }, { op: 'Z' },
    ]);
    expect(g.width).toBe(500);   // the composite's own width, not the accent's
  });

  it('bounds recursion instead of hanging on a self-calling subr', () => {
    const subrs = [cs(num(0), 10, 11)];        // subr 0 calls subr 0
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(0), 10, 14), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'Z' }]);
  });

  it('degrades to what it drew when the bytes run out mid-operator', () => {
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(100), 6, 247), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }, { op: 'Z' }]);
  });
});
