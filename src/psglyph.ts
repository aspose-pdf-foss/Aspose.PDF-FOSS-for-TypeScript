import type { PsInterpreter, PsInvocation } from './psvm.js';
import type { PsGraphics, PsCapture } from './psgraphics.js';
import type { PsFonts } from './psfont.js';
import type { PsCharacter, PsProgramGlyph, PsVector } from './psfonttypes.js';
import type { PsGlyphPaint } from './psfontpdf.js';
import type { PsBox } from './psstate.js';
import { name, integer, PsFault } from './psvalue.js';
import { glyphToUnicode } from './encoding.js';
import { mul } from './text.js';

export interface PsGlyphResult { glyph: PsProgramGlyph; paint?: PsGlyphPaint }
interface Context { capture: PsCapture; advance?: PsVector; box?: PsBox; uncolored: boolean; parent?: Context }
export class PsGlyphRunner {
  private context?: Context;
  private depth = 0;
  constructor(private readonly vm: PsInterpreter, private readonly graphics: PsGraphics, private readonly fonts: PsFonts) {
    for (const key of ['setcharwidth', 'setcachedevice', 'setcachedevice2']) vm.registerStandardOperator(key, () => {
      const context = this.context; if (!context) throw new PsFault('undefined');
      const count = key === 'setcharwidth' ? 2 : key === 'setcachedevice' ? 6 : 10;
      vm.budget.allocate(count * 16, 'glyph metrics operands'); const values: number[] = [];
      for (let i = count - 1; i >= 0; i--) values.push(vm.number(i).value);
      const advance: PsVector = [values[0]!, values[1]!], box = count > 2 ? values.slice(2, 6) as PsBox : undefined;
      context.capture.declareGlyphMetrics(advance, box, count > 2); vm.replace(count);
      context.advance = advance; context.box = box; context.uncolored = count > 2;
    });
  }
  run(character: PsCharacter, mode: 'show' | 'measure' | 'path', complete: (result: PsGlyphResult) => void): void {
    const { vm, graphics, fonts } = this, font = character.font;
    if (font.program) { complete({ glyph: font.program.glyph(character.name) }); return; }
    if (!font.builder) throw new PsFault('invalidfont');
    vm.budget.depth(this.depth + 1, 'glyph recursion'); vm.budget.allocate(256, 'glyph invocation'); vm.budget.work();
    const parent = this.context, oldDepth = this.depth, origin = graphics.state.path.current;
    const matrix = mul(character.matrix, graphics.state.ctm);
    if (origin) { matrix[4] += origin[0] - graphics.state.ctm[4]; matrix[5] += origin[1] - graphics.state.ctm[5]; }
    const fontScope = fonts.withCharacter(character, { roots: [], complete: () => {}, unwind: () => {} });
    let capture: PsCapture;
    let captured = false;
    try { capture = graphics.beginCapture(font.box, matrix, false, { mode: mode === 'show' ? 'paint' : mode, clip: 'inherit', requireMetrics: true }); captured = true; } finally { if (!captured) fontScope.unwind(); }
    const context: Context = { capture, uncolored: false, parent }; this.context = context; this.depth++;
    let active = true;
    const cleanup = (): void => { if (active) { capture.abort(); fontScope.unwind(); this.context = parent; this.depth = oldDepth; active = false; } };
    let scheduled = false;
    let scope: PsInvocation | undefined;
    try {
      scope = {
        roots: [font.dictionary, font.builder.procedure, character.root, ...capture.roots, ...fontScope.roots], unwind: cleanup,
        complete: () => {
          let result: PsGlyphResult;
          try {
            const path = capture.collectedPath(), output = capture.complete();
            const glyph: PsProgramGlyph = { name: character.name, advance: context.advance!, sidebearing: [0, 0], path,
              box: path.bbox ?? context.box ?? [0, 0, 0, 0], unicode: glyphToUnicode(character.name) };
            result = { glyph, ...(mode === 'show' ? { paint: { content: output.content, resources: output.resources, colored: !context.uncolored } } : {}) };
          } finally { cleanup(); }
          complete(result);
        },
      };
      vm.push(fonts.current().dictionary); vm.push(font.builder.byName ? name(character.name) : integer(character.code));
      vm.invoke(font.builder.procedure, scope); scheduled = true;
    } finally { if (!scheduled) { scope?.unwind(); cleanup(); } }
  }
}
