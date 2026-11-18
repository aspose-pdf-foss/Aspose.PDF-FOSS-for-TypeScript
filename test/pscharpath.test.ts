import { describe, expect, it } from 'vitest';
import { runPsText } from './helpers/ps-text.js';
import { t1cs, t1num } from './helpers/build-type1.js';
const code = Buffer.from(t1cs(t1num(0), t1num(500), 13, t1num(0), t1num(0), 21, t1num(30), t1num(60), t1num(30), t1num(-60), t1num(30), t1num(0), 8, 14)).toString('hex');
export const curveFont = `/Curve << /FontType 1 /FontMatrix [.01 0 0 .01 0 0] /FontBBox [0 0 100 100] /Encoding StandardEncoding /Private << /lenIV -1 >> /CharStrings << /A <${code}> >> >> definefont setfont `;
describe('PostScript character paths', () => {
  it.each(['charpath', 'eocharpath'])('appends exact cubics and final point without painting: %s', op => {
    const { vm, graphics } = runPsText(curveFont + `10 20 moveto (A) false ${op} currentpoint`);
    const c = graphics.state.path.segments.find(s => s.op === 'C'); expect(c).toEqual({ op: 'C', x1: 10.3, y1: 20.6, x2: 10.6, y2: 20, x: 10.9, y: 20 });
    expect(vm.stack).toMatchObject([{ value: 15 }, { value: 20 }]); expect(graphics.finish()).toHaveLength(0);
  });
  it('keeps the vector portion of mixed procedure glyphs in charpath', () => {
    const { graphics } = runPsText('/G << /FontType 3 /FontMatrix [.01 0 0 .01 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /BuildGlyph { pop pop 500 0 setcharwidth 0 0 100 100 rectfill 1 1 8 [1 0 0 1 0 0] <ff> image } >> definefont setfont 0 0 moveto (A) false charpath');
    expect(graphics.state.path.segments.filter(s => s.op === 'L')).toHaveLength(3); expect(graphics.finish()).toHaveLength(0);
  });
});
