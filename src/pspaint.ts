import type { PsInterpreter } from './psvm.js';
import type { PsGraphics, PsCapture } from './psgraphics.js';
import { PsFault, name, type PsDictionary, type PsDictionaryBody, type PsArray, type PsValue } from './psvalue.js';
import type { PsBox, PsColorState } from './psstate.js';
import { readPsMatrix, inversePsMatrix } from './psmatrix.js';
import { mul, type Matrix } from './text.js';
import { preparePsColor, psColorComponents } from './pscolor.js';
import { name as pdfName, type PdfStream, type PdfObject } from './types.js';
import type { PsPageOutput } from './pspdf.js';
import { UnsupportedFeatureError } from './errors.js';

interface Pattern {
  box: PsBox; matrix: Matrix; procedure: PsArray; paint: number; tiling: number;
  xStep: number; yStep: number; building: boolean; stream?: PdfStream;
}
function get(vm: PsInterpreter, dict: PsDictionary, key: string): PsValue { return vm.memory.get(dict, name(key)); }
function int(vm: PsInterpreter, dict: PsDictionary, key: string): number {
  const value = get(vm, dict, key); if (value.kind !== 'integer') throw new PsFault('typecheck'); return value.value;
}
function number(vm: PsInterpreter, dict: PsDictionary, key: string): number {
  const value = get(vm, dict, key);
  if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck'); return value.value;
}
function box(vm: PsInterpreter, dict: PsDictionary): PsBox {
  const source = get(vm, dict, 'BBox');
  if (source.kind !== 'array') throw new PsFault('typecheck');
  if (source.length !== 4) throw new PsFault('rangecheck');
  vm.budget.allocate(64, 'capture box');
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const value = vm.memory.get(source, i);
    if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck');
    values.push(value.value);
  }
  if (values[2]! < values[0]! || values[3]! < values[1]!) throw new PsFault('rangecheck');
  return values as PsBox;
}
function procedure(vm: PsInterpreter, dict: PsDictionary): PsArray {
  const value = get(vm, dict, 'PaintProc');
  if (value.kind !== 'array' || !value.executable) throw new PsFault('typecheck');
  vm.memory.checkExecutable(value); return value;
}

export function installPsPaint(vm: PsInterpreter, graphics: PsGraphics): void {
  const patterns = new WeakMap<PsDictionaryBody, Pattern>();
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  const capture = (dict: PsDictionary, proc: PsArray, bbox: PsBox, matrix: Matrix, uncolored: boolean,
    complete: (output: PsPageOutput) => void, abandon: () => void = () => {}): void => {
    let target: PsCapture | undefined;
    const scope = graphics.withPaintScope(() => {}, () => { target?.abort(); abandon(); });
    let scheduled = false;
    try {
      target = graphics.beginCapture(bbox, matrix, uncolored);
      vm.push(dict);
      vm.invoke(proc, { roots: [...scope.roots, dict, proc], unwind: scope.unwind, complete: () => {
        const output = target!.complete();
        scope.complete();
        complete(output);
      } });
      scheduled = true;
    } finally { if (!scheduled) scope.unwind(); }
  };
  op('execform', () => {
    const dict = vm.typed('dictionary');
    if (int(vm, dict, 'FormType') !== 1) throw new UnsupportedFeatureError('PostScript form type is unsupported');
    const bbox = box(vm, dict), matrix = mul(readPsMatrix(vm, get(vm, dict, 'Matrix')), graphics.state.ctm);
    const proc = procedure(vm, dict);
    vm.replace(1);
    capture(dict, proc, bbox, matrix, false, output => {
      vm.budget.allocate(512, 'PDF form resource');
      const stream: PdfStream = { kind: 'stream', raw: output.content, dict: new Map<string, PdfObject>([
        ['Type', pdfName('XObject')], ['Subtype', pdfName('Form')], ['FormType', 1],
        ['BBox', bbox], ['Resources', output.resources],
      ]) };
      if (!graphics.state.discarding) graphics.writer.drawForm(stream, matrix, graphics.state);
    });
  });
  op('makepattern', () => {
    const matrix = mul(readPsMatrix(vm, vm.peek()), graphics.state.ctm);
    inversePsMatrix(matrix);
    const source = vm.typed('dictionary', 1);
    if (int(vm, source, 'PatternType') !== 1) throw new UnsupportedFeatureError('PostScript shading pattern is unsupported');
    const paint = int(vm, source, 'PaintType'), tiling = int(vm, source, 'TilingType');
    if (![1, 2].includes(paint) || ![1, 2, 3].includes(tiling)) throw new PsFault('rangecheck');
    const xStep = number(vm, source, 'XStep'), yStep = number(vm, source, 'YStep');
    if (!xStep || !yStep) throw new PsFault('rangecheck');
    const bbox = box(vm, source), proc = procedure(vm, source);
    const bound = vm.memory.dictionary(source.body.entries.length);
    for (const [key, value] of source.body.entries) { vm.budget.work(); vm.memory.put(bound, key, value); }
    vm.memory.restrictAccess(bound, 'readonly');
    vm.budget.allocate(256, 'bound pattern metadata');
    patterns.set(bound.body, { box: bbox, matrix, procedure: proc, paint, tiling, xStep, yStep, building: false });
    vm.replace(2, bound);
  });
  const select = (shorthand: boolean): void => {
    graphics.assertColorAllowed();
    const bound = vm.typed('dictionary');
    if (!bound.body.valid) throw new PsFault('invalidrestore');
    const pattern = patterns.get(bound.body);
    if (!pattern) throw new PsFault('typecheck');
    const current = graphics.state.color;
    const base = current.space === 'Pattern' ? current.base : shorthand ? current : undefined;
    if (pattern.paint === 2 && !base) throw new PsFault('rangecheck');
    const count = pattern.paint === 2 ? psColorComponents(base!) : 0;
    vm.budget.allocate(128 + count * 16, 'pattern color operands');
    const components: number[] = [];
    for (let i = count; i > 0; i--) components.push(vm.number(i).value);
    vm.replace(count + 1);
    const install = (selectedBase?: PsColorState): void => {
      const descriptor = current.space === 'Pattern' ? current.descriptor
        : vm.memory.arrayFrom(base ? [name('Pattern'), base.descriptor] : [name('Pattern')]);
      const commit = (): void => {
        graphics.state.color = { space: 'Pattern', descriptor, components: selectedBase?.components ?? [],
          base: selectedBase ?? base, pattern: bound, resource: pattern.stream };
      };
      if (pattern.stream) { commit(); return; }
      if (pattern.building) throw new PsFault('limitcheck');
      pattern.building = true;
      capture(bound, pattern.procedure, pattern.box, pattern.matrix, pattern.paint === 2, output => {
        vm.budget.allocate(640, 'PDF tiling pattern resource');
        pattern.stream = { kind: 'stream', raw: output.content, dict: new Map<string, PdfObject>([
          ['Type', pdfName('Pattern')], ['PatternType', 1], ['PaintType', pattern.paint], ['TilingType', pattern.tiling],
          ['BBox', pattern.box], ['XStep', pattern.xStep], ['YStep', pattern.yStep], ['Matrix', pattern.matrix],
          ['Resources', output.resources],
        ]) };
        pattern.building = false;
        commit();
      }, () => { pattern.building = false; });
    };
    if (pattern.paint === 2) preparePsColor(vm, base!, components, install);
    else install();
  };
  const ordinarySetColor = vm.lookup('setcolor')!;
  op('setpattern', () => select(true));
  op('setcolor', () => {
    if (graphics.state.color.space === 'Pattern') select(false);
    else { if (ordinarySetColor.kind !== 'operator') throw new PsFault('typecheck'); ordinarySetColor.execute(); }
  });
}
