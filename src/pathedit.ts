import type { Document } from './document.js';
import type { Page } from './page.js';
import type { PagePathAddr } from './paths.js';
import { EditableContent } from './editcontent.js';
import type { ContentOp, ContentOpSource } from './content.js';
import { apply, type Matrix } from './text.js';
import { UnsupportedFeatureError } from './errors.js';

export interface PathRecolorOptions {
  /** DeviceRGB fill components from 0 to 1. */
  fill?: readonly [number, number, number];
  /** DeviceRGB stroke components from 0 to 1. */
  stroke?: readonly [number, number, number];
}

export type PathEdit = { kind: 'remove' }
  | { kind: 'recolor'; options: PathRecolorOptions }
  | { kind: 'transform'; matrix: Readonly<Matrix> };

const geometryOperands = new Map([['m', 2], ['l', 2], ['c', 6], ['v', 4], ['y', 4], ['h', 0], ['re', 4]]);
const fillOps = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const strokeOps = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const isClip = (op: ContentOp) => op.operator === 'W' || op.operator === 'W*';
const op = (operator: string, operands: number[] = []): ContentOp => ({ operator, operands });

/** Read and copy caller-controlled values before checking the live handle. @internal */
export function preparePathEdit(edit: PathEdit): PathEdit {
  if (edit.kind === 'remove') return edit;
  if (edit.kind === 'transform') return { kind: 'transform', matrix: finiteArray(edit.matrix, 6, 'path transform') as Matrix };
  if (!edit.options) throw new TypeError('path recolor requires fill or stroke');
  const { fill, stroke } = edit.options;
  if (fill === undefined && stroke === undefined) throw new TypeError('path recolor requires fill or stroke');
  return { kind: 'recolor', options: { fill: rgb(fill), stroke: rgb(stroke) } };
}

/** Edit a verified path without consulting the caller's geometry snapshot. @internal */
export function editPagePath(doc: Document, page: Page, address: PagePathAddr, edit: PathEdit): void {
  const ec = new EditableContent(doc, page);
  const { start, end, invocations } = address;
  if (invocations.length) {
    ec.editFormOccurrence(invocations, (source) => {
      const replacement = rewritePath(source.ops.slice(start.opIndex, end.opIndex + 1), edit);
      return source.replace(start.opIndex, end.opIndex + 1, replacement);
    });
    return;
  }

  const streams: { source: ContentOpSource; first: number; end: number }[] = [];
  for (let i = start.streamIndex; i <= end.streamIndex; i++) {
    const source = ec.topSource(i);
    streams.push({
      source,
      first: i === start.streamIndex ? start.opIndex : 0,
      end: i === end.streamIndex ? end.opIndex + 1 : source.ops.length,
    });
  }
  const replacement = rewritePath(streams.flatMap(({ source, first, end }) => source.ops.slice(first, end)), edit);
  // /Contents streams form one operator sequence. Place the replacement at
  // the first slot and remove the rest of the original span from later slots.
  const bytes = new Map<number, Uint8Array>();
  for (let i = 0; i < streams.length; i++) {
    const { source, first, end } = streams[i];
    if (first < end) bytes.set(start.streamIndex + i, source.replace(first, end, i === 0 ? replacement : []));
  }
  ec.writeTopStreams(bytes);
}

function rewritePath(ops: readonly ContentOp[], edit: PathEdit): ContentOp[] {
  const paint = ops.at(-1);
  const start = ops[0]?.operator;
  const malformed = () => new UnsupportedFeatureError('cannot edit a malformed path object');
  if (!paint || (start !== 'm' && start !== 're') || paint.operands.length !== 0) throw malformed();
  const fill = fillOps.has(paint.operator);
  const stroke = strokeOps.has(paint.operator);
  if (!fill && !stroke && paint.operator !== 'n') throw malformed();

  const body = ops.slice(0, -1);
  const clip = body.length > 0 && isClip(body[body.length - 1]);
  const geometry = clip ? body.slice(0, -1) : body;
  if (clip && body[body.length - 1].operands.length !== 0) throw malformed();
  for (const { operator, operands } of geometry) {
    if (geometryOperands.get(operator) !== operands.length || !operands.every(Number.isFinite)) throw malformed();
  }

  switch (edit.kind) {
    case 'remove':
      return clip && (fill || stroke) ? [...body, op('n')] : [];
    case 'recolor': {
      const colors = recolorOps(edit.options, fill, stroke);
      const painted = [op('q'), ...colors, ...body, paint, op('Q')];
      // Keep W on the painted draw, then replay W/n after restoring the
      // colors so subsequent artwork still sees the updated clip.
      return clip ? [...painted, ...body, op('n')] : painted;
    }
    case 'transform': {
      const transformed = transformPath(geometry, edit.matrix as Matrix);
      return clip ? [...transformed, body[body.length - 1], paint] : [...transformed, paint];
    }
  }
}

function finiteArray(value: readonly number[], count: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== count) throw new TypeError(`${label} must contain ${count} finite numbers`);
  const copy = Array.from({ length: count }, (_, i) => value[i]);
  if (!copy.every(Number.isFinite)) throw new TypeError(`${label} must contain ${count} finite numbers`);
  return copy;
}

function rgb(value: readonly number[] | undefined): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  const color = finiteArray(value, 3, 'path color') as [number, number, number];
  if (color.some((component) => component < 0 || component > 1)) throw new RangeError('path colors must be in [0, 1]');
  return color;
}

function recolorOps(options: PathRecolorOptions, paintFill: boolean, paintStroke: boolean): ContentOp[] {
  const { fill, stroke } = options;
  if (fill !== undefined && !paintFill) throw new RangeError('path does not paint a fill');
  if (stroke !== undefined && !paintStroke) throw new RangeError('path does not paint a stroke');
  const colors: ContentOp[] = [];
  if (fill) colors.push(op('rg', [...fill]));
  if (stroke) colors.push(op('RG', [...stroke]));
  return colors;
}

function transformPath(geometry: readonly ContentOp[], matrix: Matrix): ContentOp[] {
  const result: ContentOp[] = [];
  let rectangleStart: number[] | undefined;
  for (const item of geometry) {
    if (item.operator !== 'h') {
      // A segment after a closed rectangle starts from its starting corner.
      // Make that point explicit when expanding re, including for shorthand v.
      if (rectangleStart && item.operator !== 'm' && item.operator !== 're') result.push(op('m', rectangleStart));
      rectangleStart = undefined;
    }
    const replacement = transformGeometry(item, matrix);
    if (item.operator === 're' && replacement.length > 1) rectangleStart = replacement[0].operands as number[];
    result.push(...replacement);
  }
  return result;
}

function transformGeometry(item: ContentOp, matrix: Matrix): ContentOp[] {
  const point = (x: number, y: number) => {
    const result = apply(matrix, x, y);
    if (!result.every(Number.isFinite)) throw new RangeError('path transform produces a non-finite coordinate');
    return result;
  };
  const numbers = item.operands as number[];
  if (item.operator === 're') {
    const [x, y, w, h] = numbers;
    if (matrix[1] === 0 && matrix[2] === 0) {
      const rect = [...point(x, y), matrix[0] * w, matrix[3] * h];
      if (![...rect, rect[0] + rect[2], rect[1] + rect[3]].every(Number.isFinite))
        throw new RangeError('path transform produces a non-finite rectangle');
      return [op('re', rect)];
    }
    return [op('m', point(x, y)), op('l', point(x + w, y)), op('l', point(x + w, y + h)), op('l', point(x, y + h)), op('h')];
  }
  const operands: number[] = [];
  for (let i = 0; i < numbers.length; i += 2) operands.push(...point(numbers[i], numbers[i + 1]));
  return [op(item.operator, operands)];
}
