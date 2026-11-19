import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics, type PsGraphicsOptions } from '../src/psgraphics.js';
import { installPsText } from '../src/pstext.js';
import { parseContentStream } from '../src/content.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { psBytes } from './helpers/ps-font-program.js';

function run(source: string) {
  const vm = new PsInterpreter();
  const options = { eps: true, box: [0, 0, 100, 50], defaultMatrix: [1, 0, 0, 1, 10, -20] } as PsGraphicsOptions;
  const graphics = installPsGraphics(vm, options);
  installPsText(vm, graphics);
  vm.run(psBytes(source));
  return { vm, graphics };
}
describe('fixed EPS graphics device', () => {
  it.each(['initmatrix', 'initgraphics'])('retains outer device defaults after a captured gstate escapes and %s runs', reset => {
    const { vm } = run('<< /FormType 1 /BBox [0 0 5 5] /Matrix [1 0 0 1 10 40] '
      + `/PaintProc { pop /saved gstate def } >> execform saved setgstate ${reset} -10 20 transform matrix defaultmatrix aload pop`);
    expect(vm.stack).toMatchObject([0, 0, 1, 0, 0, 1, 10, -20].map(value => ({ value })));
  });
  it('retains capture defaults when an outer gstate is installed inside a form', () => {
    const { vm } = run('/outer gstate def << /FormType 1 /BBox [0 0 5 5] /Matrix [1 0 0 1 10 40] '
      + '/PaintProc { pop outer setgstate initgraphics 0 0 transform matrix defaultmatrix aload pop } >> execform');
    expect(vm.stack).toMatchObject([20, 20, 1, 0, 0, 1, 20, 20].map(value => ({ value })));
  });
  it.each(['', 'showpage', 'showpage showpage', 'systemdict /showpage get exec', 'nulldevice'])('finalizes one blank page after %s', source => {
    const { graphics } = run(source), pages = graphics.finish();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.box).toEqual([0, 0, 100, 50]);
    expect(graphics.finish()).toBe(pages);
  });
  it('keeps marks and current state across all showpage routes', () => {
    const { graphics, vm } = run('-10 20 2 2 rectfill showpage systemdict /showpage get exec -5 25 2 2 rectfill -10 20 moveto currentpoint');
    expect(vm.stack).toMatchObject([{ value: -10 }, { value: 20 }]);
    expect(graphics.finish()).toHaveLength(1);
    expect(parseContentStream(graphics.finish()[0]!.content).filter(o => o.operator === 'f')).toHaveLength(2);
  });
  it.each(['initmatrix', 'initgraphics', 'initclip'])('retains host placement and clip after %s', reset => {
    const { vm } = run(`${reset} -10 20 transform matrix defaultmatrix aload pop clippath pathbbox`);
    expect(vm.stack).toMatchObject([0, 0, 1, 0, 0, 1, 10, -20, -10, 20, 90, 70].map(value => ({ value })));
  });
  it('restores the fixed device after null scopes and honors erasepage', () => {
    const { graphics } = run('-10 20 1 1 rectfill erasepage gsave nulldevice 0 0 2 2 rectfill grestore -8 22 1 1 rectfill');
    expect(parseContentStream(graphics.finish()[0]!.content).filter(o => o.operator === 'f')).toHaveLength(1);
  });
  it.each(['copypage', '<< >> setpagedevice', '<< /PageSize [100 50] >> setpagedevice'])('refuses %s', source => {
    expect(() => run(source)).toThrow(UnsupportedFeatureError);
  });
  it('refuses raw device resizing', () => { expect(() => run('').graphics.setPageSize(100, 50)).toThrow(UnsupportedFeatureError); });
  it.each([
    '<< /FormType 1 /BBox [0 0 10 10] /Matrix [1 0 0 1 0 0] /PaintProc { pop showpage } >> execform',
    '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 5 5] /XStep 5 /YStep 5 /PaintProc { pop showpage } >> matrix makepattern setpattern',
    '/G << /FontType 3 /FontMatrix [.01 0 0 .01 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /BuildGlyph { pop pop 500 0 setcharwidth showpage } >> definefont setfont 0 0 moveto (A) show',
  ])('keeps capture restrictions for %s', source => { expect(() => run(source)).toThrow(UnsupportedFeatureError); });
});
