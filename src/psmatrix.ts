import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import { apply, invert, mul, IDENTITY, type Matrix } from './text.js';
import { PsFault, canWrite, real, type PsArray, type PsValue } from './psvalue.js';

export function readPsMatrix(vm: PsInterpreter, value: PsValue): Matrix {
  if (value.kind !== 'array') throw new PsFault('typecheck');
  if (value.length !== 6) throw new PsFault('rangecheck');
  vm.budget.allocate(48, 'matrix operand');
  const result = [] as number[];
  for (let i = 0; i < 6; i++) {
    const item = vm.memory.get(value, i);
    if (item.kind !== 'integer' && item.kind !== 'real') throw new PsFault('typecheck');
    result.push(item.value);
  }
  return result as Matrix;
}

function checked(matrix: Matrix): Matrix {
  if (!matrix.every(Number.isFinite)) throw new PsFault('undefinedresult');
  return matrix;
}

export function inversePsMatrix(matrix: Matrix): Matrix {
  if (matrix[0] * matrix[3] - matrix[1] * matrix[2] === 0) throw new PsFault('undefinedresult');
  // Avoid determinant cancellation for the common scale/translate basis.
  if (matrix[1] === 0 && matrix[2] === 0) return checked([1 / matrix[0], 0, 0, 1 / matrix[3], -matrix[4] / matrix[0], -matrix[5] / matrix[3]]);
  return checked(invert(matrix));
}

export function writePsMatrix(vm: PsInterpreter, dest: PsArray, matrix: Matrix): PsArray {
  if (!dest.body.valid) throw new PsFault('invalidrestore');
  if (!canWrite(dest)) throw new PsFault('invalidaccess');
  if (dest.length !== 6) throw new PsFault('rangecheck');
  checked(matrix);
  vm.budget.work(6, 'matrix result');
  for (let i = 0; i < 6; i++) vm.memory.put(dest, i, real(matrix[i]!));
  return dest;
}

export function installPsMatrix(vm: PsInterpreter, graphics: PsGraphics): void {
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  op('matrix', () => vm.push(vm.memory.arrayFrom(IDENTITY.map(real))));
  op('initmatrix', () => { graphics.state.ctm = [...graphics.state.defaultMatrix]; });
  for (const text of ['identmatrix', 'defaultmatrix', 'currentmatrix']) op(text, () => {
    const matrix = text === 'identmatrix' ? IDENTITY
      : text === 'defaultmatrix' ? graphics.state.defaultMatrix : graphics.state.ctm;
    vm.replace(1, writePsMatrix(vm, vm.typed('array'), matrix));
  });
  op('setmatrix', () => {
    const matrix = readPsMatrix(vm, vm.peek());
    vm.replace(1);
    graphics.state.ctm = matrix;
  });
  op('concat', () => {
    const matrix = checked(mul(readPsMatrix(vm, vm.peek()), graphics.state.ctm));
    vm.replace(1);
    graphics.state.ctm = matrix;
  });
  op('concatmatrix', () => {
    const dest = vm.typed('array');
    const matrix = checked(mul(readPsMatrix(vm, vm.peek(2)), readPsMatrix(vm, vm.peek(1))));
    vm.replace(3, writePsMatrix(vm, dest, matrix));
  });
  op('invertmatrix', () => {
    const matrix = inversePsMatrix(readPsMatrix(vm, vm.peek(1)));
    vm.replace(2, writePsMatrix(vm, vm.typed('array'), matrix));
  });
  for (const text of ['translate', 'scale', 'rotate']) op(text, () => {
    const dest = vm.peek().kind === 'array' ? vm.typed('array') : undefined;
    const offset = dest ? 1 : 0;
    let matrix: Matrix;
    let count: number;
    if (text === 'rotate') {
      const angle = vm.number(offset).value * Math.PI / 180;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      matrix = [cosine, sine, -sine, cosine, 0, 0];
      count = 1;
    } else {
      const y = vm.number(offset).value, x = vm.number(offset + 1).value;
      matrix = text === 'scale' ? [x, 0, 0, y, 0, 0] : [1, 0, 0, 1, x, y];
      count = 2;
    }
    if (dest) vm.replace(count + 1, writePsMatrix(vm, dest, matrix));
    else {
      matrix = checked(mul(matrix, graphics.state.ctm));
      vm.replace(count);
      graphics.state.ctm = matrix;
    }
  });
  for (const text of ['transform', 'itransform', 'dtransform', 'idtransform']) op(text, () => {
    const explicit = vm.peek().kind === 'array';
    let matrix = explicit ? readPsMatrix(vm, vm.peek()) : graphics.state.ctm;
    const offset = explicit ? 1 : 0;
    const y = vm.number(offset).value, x = vm.number(offset + 1).value;
    if (text[0] === 'i') matrix = inversePsMatrix(matrix);
    const distance = text.includes('dtransform');
    const [dx, dy] = distance ? [matrix[0] * x + matrix[2] * y, matrix[1] * x + matrix[3] * y] : apply(matrix, x, y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new PsFault('undefinedresult');
    vm.replace(2 + offset, real(dx), real(dy));
  });
}
