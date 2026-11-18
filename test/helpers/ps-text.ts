import { PsInterpreter } from '../../src/psvm.js';
import { installPsGraphics } from '../../src/psgraphics.js';
import { installPsFonts, type PsFontOptions } from '../../src/psfont.js';
import type { LoadLimits } from '../../src/loadlimits.js';
import { installPsText } from '../../src/pstext.js';
export const psTextBytes = (source: string): Uint8Array => Uint8Array.from(source, c => c.charCodeAt(0));
export function runPsFonts(source = '', options: PsFontOptions & { limits?: LoadLimits } = {}) {
  const vm = new PsInterpreter({ limits: options.limits }), graphics = installPsGraphics(vm);
  const fonts = installPsFonts(vm, graphics, options); if (source) vm.run(psTextBytes(source));
  return { vm, graphics, fonts };
}
export function runPsText(source = '', options: PsFontOptions & { limits?: LoadLimits } = {}) {
  const vm = new PsInterpreter({ limits: options.limits }), graphics = installPsGraphics(vm);
  const text = installPsText(vm, graphics, options); if (source) vm.run(psTextBytes(source)); return { vm, graphics, text };
}
export function pairFontSource(): string {
  return [500, 700].map((width, i) => `/Base${i} << /FontName /Base${i} /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 500 700] /Encoding StandardEncoding /BuildGlyph { pop pop ${width} 0 setcharwidth 100 200 moveto 200 200 lineto 200 300 lineto closepath fill } >> definefont pop`).join(' ') +
    ' /Pair << /FontName /Pair /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 2 /Encoding [0 1] /FDepVector [ /Base0 findfont /Base1 findfont ] >> definefont pop ';
}
