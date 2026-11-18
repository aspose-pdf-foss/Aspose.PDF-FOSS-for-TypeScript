import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import { installPsFonts, type PsFontOptions, type PsFonts } from './psfont.js';
import { PsGlyphRunner } from './psglyph.js';
import { PsFontPdfBank } from './psfontpdf.js';
import { psCharacters, type PsCharacterCursor } from './pscomposite.js';
import type { PsCharacter, PsVector } from './psfonttypes.js';
import { installPsEexec, psFontSource } from './pseexec.js';
import { canRead, real, integer, PsFault, type PsString, type PsValue } from './psvalue.js';
import { mul, IDENTITY, type Matrix } from './text.js';
import { appendPsSegments, currentPsPoint, transformPsPath, strokePsPathData } from './pspath.js';
import { psNumberSequence } from './psnumbers.js';

interface ShowOptions {
  delta?: (character: PsCharacter, index: number, natural: PsVector) => PsVector;
  beforeNext?: () => boolean;
  roots?: PsValue[];
}

const installed = new WeakSet<PsInterpreter>();
export class PsTextSession {
  readonly fonts: PsFonts;
  readonly glyphs: PsGlyphRunner;
  readonly bank: PsFontPdfBank;
  constructor(readonly vm: PsInterpreter, readonly graphics: PsGraphics, options: PsFontOptions) {
    this.fonts = installPsFonts(vm, graphics, options); installPsEexec(vm, graphics.decode);
    this.glyphs = new PsGlyphRunner(vm, graphics, this.fonts); this.bank = new PsFontPdfBank(vm, graphics);
    vm.registerStandardOperator('show', () => { this.show(vm.typed('string')); vm.replace(1); });
    vm.registerStandardOperator('stringwidth', () => { this.measure(vm.typed('string'), advance => { vm.push(real(advance[0])); vm.push(real(advance[1])); }); vm.replace(1); });
    vm.registerStandardOperator('glyphshow', () => {
      const value = vm.typed('name'), font = this.fonts.current(); if (font.composite) throw new PsFault('invalidfont');
      currentPsPoint(graphics); let code = 0;
      if (font.builder && !font.builder.byName) {
        vm.budget.work(font.encoding.length * 2, 'glyphshow encoding lookup');
        code = font.encoding.indexOf(value.text); if (code < 0) code = font.encoding.indexOf('.notdef');
        if (code < 0) throw new PsFault('invalidfont');
      }
      const character: PsCharacter = { font, root: font.dictionary, name: value.text, code, matrix: font.matrix };
      let used = false; this.iterate({ next: () => used ? undefined : (used = true, character), visitRoots: visit => visit(font.dictionary) }, 'show'); vm.replace(1);
    });
    for (const key of ['charpath', 'eocharpath']) vm.registerStandardOperator(key, () => {
      const flag = vm.typed('boolean'), text = vm.typed('string', 1); currentPsPoint(graphics);
      this.iterate(psCharacters(this.fonts, this.fonts.current().dictionary, text), 'path', undefined, flag.value); vm.replace(2);
    });
    for (const key of ['ashow', 'widthshow', 'awidthshow']) vm.registerStandardOperator(key, () => {
      const text = vm.typed('string'); currentPsPoint(graphics);
      let ax = 0, ay = 0, cx = 0, cy = 0, code = -1, count = 3;
      if (key === 'ashow') { ax = vm.number(2).value; ay = vm.number(1).value; }
      else if (key === 'widthshow') { count = 4; code = vm.typed('integer', 1).value; cx = vm.number(3).value; cy = vm.number(2).value; }
      else { count = 6; ax = vm.number(2).value; ay = vm.number(1).value; code = vm.typed('integer', 3).value; cx = vm.number(5).value; cy = vm.number(4).value; }
      if (key !== 'ashow' && (code < 0)) throw new PsFault('rangecheck');
      const cursor = psCharacters(this.fonts, this.fonts.current().dictionary, text);
      this.iterate(cursor, 'show', undefined, false, { delta: (c, _, natural) => [natural[0] + ax + ((c.matchCode ?? c.code) === code ? cx : 0), natural[1] + ay + ((c.matchCode ?? c.code) === code ? cy : 0)] }); vm.replace(count);
    });
    for (const key of ['xshow', 'yshow', 'xyshow']) vm.registerStandardOperator(key, () => {
      const sequence = vm.peek(); if (sequence.kind !== 'array' && sequence.kind !== 'string') throw new PsFault('typecheck');
      const numbers = psNumberSequence(vm, sequence), text = vm.typed('string', 1); currentPsPoint(graphics);
      this.iterate(psCharacters(this.fonts, this.fonts.current().dictionary, text), 'show', undefined, false, {
        roots: [sequence], delta: (_, i) => key === 'xyshow' ? [numbers.get(i * 2), numbers.get(i * 2 + 1)] : key === 'xshow' ? [numbers.get(i), 0] : [0, numbers.get(i)],
      }); vm.replace(2);
    });
    vm.registerStandardOperator('kshow', () => {
      const text = vm.typed('string'), proc = vm.procedure(1), root = this.fonts.current().dictionary; currentPsPoint(graphics);
      if (!text.body.valid || !canRead(text)) throw new PsFault('invalidaccess');
      let index = 0, boundary = -1;
      const cursor: PsCharacterCursor = { visitRoots: visit => { visit(root); visit(text); visit(proc); }, next: () => {
        if (index === text.length) return undefined;
        const font = this.fonts.current(); if (font.composite) throw new PsFault('invalidfont');
        const slice = vm.memory.interval(text, index, 1); const character = psCharacters(this.fonts, font.dictionary, slice).next(); index++; return character;
      } };
      this.iterate(cursor, 'show', undefined, false, { beforeNext: () => {
        if (index === 0 || index === text.length || boundary === index) return false; boundary = index;
        vm.push(vm.memory.get(text, index - 1)); vm.push(vm.memory.get(text, index));
        vm.invoke(proc, { roots: [proc, text, root], complete: () => {}, unwind: () => {} }); return true;
      } }); vm.replace(2);
    });
    vm.registerStandardOperator('cshow', () => {
      const text = vm.typed('string'), proc = vm.procedure(1), root = this.fonts.current().dictionary;
      const cursor = psCharacters(this.fonts, root, text); vm.budget.allocate(160, 'cshow continuation'); vm.replace(2);
      vm.scheduleWork(() => {
        const character = cursor.next(); if (!character) return false;
        this.glyphs.run(character, 'measure', result => {
          const m = character.matrix, w = result.glyph.advance, scope = this.fonts.withCharacter(character, { roots: [proc, text, root], complete: () => {}, unwind: () => {} });
          let scheduled = false;
          try { vm.push(integer(character.code)); vm.push(real(m[0] * w[0] + m[2] * w[1])); vm.push(real(m[1] * w[0] + m[3] * w[1])); vm.invoke(proc, scope); scheduled = true; }
          finally { if (!scheduled) scope.unwind(); }
        }); return true;
      }, [proc, text, root]);
    });
  }
  fontSource(bytes: Uint8Array) { return psFontSource(bytes, this.vm.budget); }
  show(text: PsString, complete?: () => void): void {
    currentPsPoint(this.graphics); this.iterate(psCharacters(this.fonts, this.fonts.current().dictionary, text), 'show', () => complete?.());
  }
  measure(text: PsString, complete: (advance: PsVector) => void): void {
    this.iterate(psCharacters(this.fonts, this.fonts.current().dictionary, text), 'measure', complete);
  }
  private iterate(cursor: PsCharacterCursor, mode: 'show' | 'measure' | 'path', complete?: (advance: PsVector) => void, stroke = false, options: ShowOptions = {}): void {
    const { vm, graphics } = this;
    vm.budget.allocate(192, 'text continuation'); const roots: PsValue[] = [];
    cursor.visitRoots(v => { vm.budget.allocate(16, 'text root'); roots.push(v); });
    for (const value of options.roots ?? []) { vm.budget.allocate(16, 'text option root'); roots.push(value); }
    const total: PsVector = [0, 0];
    let index = 0;
    vm.scheduleWork(() => {
      if (options.beforeNext?.()) return true;
      const character = cursor.next(); if (!character) { complete?.(total); return false; }
      const userMatrix = character.matrix, ctm = [...graphics.state.ctm] as Matrix;
      if (mode !== 'measure') currentPsPoint(graphics);
      const origin = mode === 'measure' ? [0, 0] : graphics.state.path.current!;
      const by = mul(userMatrix, ctm); by[4] += origin[0]! - ctm[4]; by[5] += origin[1]! - ctm[5];
      const effective = mode === 'show' && graphics.captureMode === 'measure' ? 'measure' : mode === 'show' && graphics.captureMode === 'path' ? 'path' : mode;
      this.glyphs.run(character, effective, result => {
        const glyph = result.glyph, dx = userMatrix[0] * glyph.advance[0] + userMatrix[2] * glyph.advance[1], dy = userMatrix[1] * glyph.advance[0] + userMatrix[3] * glyph.advance[1];
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new PsFault('undefinedresult');
        total[0] += dx; total[1] += dy;
        if (mode === 'measure') return;
        const delta = options.delta?.(character, index++, [dx, dy]) ?? [dx, dy];
        if (mode === 'path') {
          let path = transformPsPath(glyph.path, by, vm.budget);
          if (character.font.paintType === 2 && !stroke) path = strokePsPathData(path, { ...graphics.state, ctm: by, line: { ...graphics.state.line, width: character.font.strokeWidth } }, vm.budget);
          appendPsSegments(graphics, path.segments);
        } else if (!graphics.state.discarding) {
          const pdfGlyph = effective === 'show' ? this.bank.glyph(character.font, glyph, result.paint)
            : { font: new Map(), code: 0, fontMatrix: IDENTITY, path: glyph.path, box: glyph.box };
          if (effective !== 'show') vm.budget.allocate(128, 'nonpublishing text');
          graphics.writer.drawText(pdfGlyph, by, graphics.state);
        }
        const x = origin[0]! + ctm[0] * delta[0]! + ctm[2] * delta[1]!, y = origin[1]! + ctm[1] * delta[0]! + ctm[3] * delta[1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PsFault('undefinedresult');
        appendPsSegments(graphics, [{ op: 'M', x, y }]);
      });
      return true;
    }, roots);
  }
}
export function installPsText(vm: PsInterpreter, graphics: PsGraphics, options: PsFontOptions = {}): PsTextSession {
  vm.assertStandardInstallation(); if (graphics.vm !== vm || installed.has(vm)) throw new PsFault('invalidaccess');
  const text = new PsTextSession(vm, graphics, options); installed.add(vm); return text;
}
