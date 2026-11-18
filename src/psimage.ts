import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import type { DecodeBudget } from './decodebudget.js';
import { PsFault, name, type PsArray, type PsDictionary, type PsValue } from './psvalue.js';
import { copyPsState, visitPsColorRoots, type PsColorState } from './psstate.js';
import { readPsMatrix, inversePsMatrix } from './psmatrix.js';
import { mul, type Matrix } from './text.js';
import { psColorComponents, preparePsColor, psDevicePaint, psPaintRgb } from './pscolor.js';
import { psStringBytes } from './pssource.js';
import { name as pdfName, type PdfStream, type PdfObject } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

interface Request {
  width: number; height: number; bits: number; components: number; matrix: Matrix;
  mask: boolean; separate: boolean; sources: PsValue[]; decode: number[]; color: PsColorState;
}
function numbers(vm: PsInterpreter, value: PsValue, length: number): number[] {
  if (value.kind !== 'array') throw new PsFault('typecheck');
  if (value.length !== length) throw new PsFault('rangecheck');
  vm.budget.allocate(length * 16, 'image numeric operands');
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    const item = vm.memory.get(value, i);
    if (item.kind !== 'integer' && item.kind !== 'real') throw new PsFault('typecheck');
    result.push(item.value);
  }
  return result;
}
function deviceColor(space: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK'): PsColorState {
  return { space, descriptor: name(space), components: [] };
}
function readSample(bytes: Uint8Array, bit: number, bits: number): number {
  let value = 0;
  for (let i = 0; i < bits; i++) value = value * 2 + ((bytes[(bit + i) >>> 3]! >>> (7 - (bit + i) % 8)) & 1);
  return value;
}
function writeSample(bytes: Uint8Array, bit: number, bits: number, value: number): void {
  for (let i = 0; i < bits; i++) if ((value >>> (bits - i - 1)) & 1) bytes[(bit + i) >>> 3]! |= 1 << (7 - (bit + i) % 8);
}

export function installPsImage(vm: PsInterpreter, graphics: PsGraphics, decodeBudget: DecodeBudget): void {
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  for (const text of ['image', 'imagemask', 'colorimage']) op(text, () => {
    if (text !== 'imagemask') graphics.assertColorAllowed();
    const state = copyPsState(graphics.state, vm.budget);
    let width: number, height: number, bits: number, matrix: Matrix, sources: PsValue[], separate = false;
    let color = text === 'image' ? deviceColor('DeviceGray') : state.color;
    const mask = text === 'imagemask';
    let components = 1, decoding: number[], count: number;
    const top = vm.peek();
    if (top.kind === 'dictionary' && text !== 'colorimage') {
      const get = (key: string): PsValue => vm.memory.get(top, name(key));
      const int = (key: string): number => { const value = get(key); if (value.kind !== 'integer') throw new PsFault('typecheck'); return value.value; };
      if (int('ImageType') !== 1) throw new UnsupportedFeatureError('PostScript image type is unsupported');
      width = int('Width'); height = int('Height'); bits = mask ? 1 : int('BitsPerComponent');
      matrix = readPsMatrix(vm, get('ImageMatrix')); color = state.color;
      if (color.space === 'Pattern' && !mask) throw new PsFault('typecheck');
      components = mask ? 1 : psColorComponents(color);
      decoding = numbers(vm, get('Decode'), components * 2);
      const multi = vm.memory.lookup(top, name('MultipleDataSources'));
      if (multi && multi.kind !== 'boolean') throw new PsFault('typecheck');
      separate = multi?.kind === 'boolean' && multi.value;
      const source = get('DataSource');
      if (separate) {
        if (source.kind !== 'array' || source.length !== components) throw new PsFault('typecheck');
        sources = [];
        for (let i = 0; i < components; i++) sources.push(vm.memory.get(source, i));
      } else sources = [source];
      count = 1;
    } else {
      let offset = 0;
      if (text === 'colorimage') {
        components = vm.typed('integer').value; separate = vm.typed('boolean', 1).value;
        if (![1, 3, 4].includes(components)) throw new PsFault('rangecheck');
        color = deviceColor(components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : 'DeviceCMYK');
        offset = 2;
      }
      const planes = separate ? components : 1;
      sources = [];
      for (let i = planes - 1; i >= 0; i--) sources.push(vm.peek(offset + i));
      matrix = readPsMatrix(vm, vm.peek(offset + planes));
      if (mask) {
        const polarity = vm.typed('boolean', offset + planes + 1).value;
        decoding = polarity ? [1, 0] : [0, 1]; bits = 1;
      } else {
        bits = vm.typed('integer', offset + planes + 1).value;
        decoding = Array.from({ length: components * 2 }, (_, i) => i % 2);
      }
      height = vm.typed('integer', offset + planes + 2).value;
      width = vm.typed('integer', offset + planes + 3).value;
      count = offset + planes + 4;
    }
    if (width < 0 || height < 0 || ![1, 2, 4, 8, 12].includes(bits)) throw new PsFault('rangecheck');
    if (mask && !((decoding[0] === 0 && decoding[1] === 1) || (decoding[0] === 1 && decoding[1] === 0))) throw new PsFault('rangecheck');
    const pixels = width * height;
    vm.budget.limits.enforce('maxImagePixels', pixels, 'PostScript image');
    if (!Number.isSafeInteger(pixels)) throw new PsFault('rangecheck');
    inversePsMatrix(matrix);
    for (const source of sources) {
      if (source.kind === 'string') psStringBytes(vm, source);
      else if (source.kind === 'file') vm.memory.readFile(source);
      else if (source.kind === 'array' && source.executable) vm.memory.checkExecutable(source);
      else throw new PsFault('typecheck');
    }
    const request: Request = { width, height, bits, components, matrix, mask, separate, sources, decode: decoding, color };
    const roots = vm.slice(vm.stack.length - count);
    visitPsColorRoots(color, value => { vm.budget.allocate(16, 'image color root'); roots.push(value); });
    vm.replace(count);
    if (!width || !height) return;
    const planeCount = sources.length;
    const rowBytes = Math.ceil(width * (separate ? 1 : components) * bits / 8);
    const total = rowBytes * height * planeCount;
    if (!Number.isSafeInteger(total)) throw new PsFault('rangecheck');
    decodeBudget.check(total, total, undefined, 'PostScript image samples');
    vm.budget.allocate(total + planeCount * 128, 'image sample planes');
    vm.budget.work(total, 'image buffer initialization');
    decodeBudget.chargeBytes(total);
    const planes = sources.map(source => ({ source, bytes: new Uint8Array(rowBytes * height), written: 0,
      chunk: undefined as Uint8Array | undefined, at: 0 }));
    let row = 0, plane = 0, ended = false, finished = false;
    const publish = (rows: number): void => {
      if (!rows) return;
      const native = mask || ['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(color.space);
      if (!native && color.space !== 'Pattern' && psDevicePaint(color).none) return;
      const outputBits = bits === 12 ? 16 : bits;
      const outComponents = mask ? 1 : native ? components : 3;
      const outBits = native ? outputBits : 8;
      const outRow = Math.ceil(width * outComponents * outBits / 8);
      vm.budget.allocate(outRow * rows, 'PDF image samples');
      vm.budget.work(outRow * rows, 'PDF image sample initialization');
      const output = new Uint8Array(outRow * rows);
      const emit = (): void => {
        const dict = new Map<string, PdfObject>([['Type', pdfName('XObject')], ['Subtype', pdfName('Image')],
          ['Width', width], ['Height', rows], ['BitsPerComponent', outBits]]);
        if (mask) dict.set('ImageMask', true);
        else dict.set('ColorSpace', pdfName(native ? color.space : 'DeviceRGB'));
        dict.set('Decode', native ? decoding : [0, 1, 0, 1, 0, 1]);
        const stream: PdfStream = { kind: 'stream', dict, raw: output };
        const placement = mul(mul([width, 0, 0, -rows, 0, rows], inversePsMatrix(request.matrix)), state.ctm);
        if (!placement.every(Number.isFinite)) throw new PsFault('undefinedresult');
        if (!state.discarding) graphics.writer.drawImage(stream, placement, state);
      };
      let pixel = 0;
      vm.scheduleWork(() => {
        if (pixel === width * rows) { emit(); return false; }
        vm.budget.work(components * bits + outComponents * outBits, 'image samples');
        const x = pixel % width, y = Math.floor(pixel / width), values: number[] = [];
        vm.budget.allocate(components * 16, 'image component scratch');
        for (let c = 0; c < components; c++) {
          const input = planes[separate ? c : 0]!.bytes;
          const bit = y * rowBytes * 8 + (separate ? x : x * components + c) * bits;
          const sample = readSample(input, bit, bits);
          values.push(decoding[c * 2]! + sample / (2 ** bits - 1) * (decoding[c * 2 + 1]! - decoding[c * 2]!));
          if (native) {
            const encoded = Math.round(sample / (2 ** bits - 1) * (2 ** outBits - 1));
            writeSample(output, y * outRow * 8 + (x * outComponents + c) * outBits, outBits, encoded);
          }
        }
        const at = pixel++ * 3;
        if (!native) preparePsColor(vm, color, values, selected => {
          const paint = psDevicePaint(selected);
          if (paint.none) return;
          const rgb = psPaintRgb(paint);
          for (let c = 0; c < 3; c++) output[at + c] = Math.round(rgb[c]! * 255);
        });
        return true;
      }, roots);
    };
    vm.scheduleWork(() => {
      if (finished) return false;
      if (ended || row === height) { finished = true; publish(row); return true; }
      const target = planes[plane]!, end = (row + 1) * rowBytes;
      if (target.written === end) { if (++plane === planeCount) { plane = 0; row++; } return true; }
      if (target.chunk && target.at < target.chunk.length) {
        const length = Math.min(end - target.written, target.chunk.length - target.at);
        vm.budget.work(length, 'image source copy');
        target.bytes.set(target.chunk.subarray(target.at, target.at + length), target.written);
        target.written += length; target.at += length; return true;
      }
      if (target.source.kind === 'file') {
        const reader = vm.memory.readFile(target.source);
        while (target.written < end) {
          const byte = reader.readByte();
          if (byte === undefined) { ended = true; break; }
          target.bytes[target.written++] = byte;
        }
      } else if (target.source.kind === 'string') {
        const bytes = psStringBytes(vm, target.source);
        if (!bytes.length) ended = true;
        else { target.chunk = bytes; target.at = 0; }
      } else {
        const before = vm.stack.length;
        vm.invoke(target.source as PsArray, { roots, unwind: () => {}, complete: () => {
          if (vm.stack.length !== before + 1) throw new PsFault('rangecheck');
          const value = vm.typed('string'), bytes = psStringBytes(vm, value);
          vm.budget.allocate(bytes.length, 'image producer chunk');
          vm.budget.work(bytes.length, 'image producer chunk');
          target.chunk = new Uint8Array(bytes); target.at = 0;
          if (!bytes.length) ended = true;
          vm.replace(1);
        } });
      }
      return true;
    }, roots);
  });
}
