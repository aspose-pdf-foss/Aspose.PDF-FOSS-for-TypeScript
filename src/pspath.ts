import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import type { PsBox, PsPathData } from './psstate.js';
import type { Seg } from './pagerender.js';
import { PsFault, real, name, boolean, type PsValue, type PsArray } from './psvalue.js';
import type { PsBudget } from './psbudget.js';
import { copyPsPath } from './psstate.js';
import { strokeOutlinePolys } from './strokegeom.js';
import { rethrowLimit } from './errors.js';
import { apply, mul, type Matrix } from './text.js';
import { inversePsMatrix, readPsMatrix } from './psmatrix.js';

function point(matrix: Matrix, x: number, y: number): [number, number] {
  const result = apply(matrix, x, y);
  if (!result.every(Number.isFinite)) throw new PsFault('undefinedresult');
  return result;
}

export function appendPsSegments(graphics: PsGraphics, segments: readonly Seg[]): void {
  const path = graphics.state.path;
  const replaceMove = segments[0]?.op === 'M' && path.segments[path.segments.length - 1]?.op === 'M';
  graphics.budget.items(path.segments.length + segments.length - (replaceMove ? 1 : 0), 'path segments');
  graphics.budget.allocate(segments.length * 64, 'path segments');
  graphics.budget.work(segments.length, 'path segments');
  for (const segment of segments) {
    if (segment.op === 'M' && path.segments[path.segments.length - 1]?.op === 'M') path.segments.pop();
    path.segments.push(segment);
    if (segment.op === 'Z') path.current = path.start && [...path.start];
    else {
      path.current = [segment.x, segment.y];
      if (segment.op === 'M') path.start = [segment.x, segment.y];
    }
  }
}

export function currentPsPoint(graphics: PsGraphics): [number, number] {
  const current = graphics.state.path.current;
  if (!current) throw new PsFault('nocurrentpoint');
  return point(inversePsMatrix(graphics.state.ctm), ...current);
}

export function psPathFromSegments(segments: Seg[]): PsPathData {
  const result: PsPathData = { segments };
  for (const segment of segments) {
    if (segment.op === 'Z') result.current = result.start && [...result.start];
    else {
      result.current = [segment.x, segment.y];
      if (segment.op === 'M') result.start = [segment.x, segment.y];
    }
  }
  return result;
}

/** Flatten in device coordinates, iteratively, spending fuel on every split. */
export function flattenPsPath(path: PsPathData, tolerance: number, budget: PsBudget): PsPathData {
  const result: Seg[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const append = (segment: Seg): void => {
    budget.items(result.length + 1, 'flattened path');
    budget.allocate(64, 'flattened segment');
    result.push(segment);
  };
  for (const segment of path.segments) {
    budget.work();
    if (segment.op !== 'C') {
      append({ ...segment });
      if (segment.op === 'Z') { x = sx; y = sy; }
      else {
        x = segment.x; y = segment.y;
        if (segment.op === 'M') { sx = x; sy = y; }
      }
      continue;
    }
    type Curve = { points: number[]; depth: number };
    budget.allocate(128, 'curve subdivision');
    const pending: Curve[] = [{ points: [x, y, segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y], depth: 0 }];
    while (pending.length) {
      budget.work();
      const curve = pending.pop()!;
      const p = curve.points;
      const dx = p[6]! - p[0]!, dy = p[7]! - p[1]!;
      const chord = Math.hypot(dx, dy);
      // Distance to the finite chord also detects collinear control points
      // beyond an endpoint, where distance to its infinite line is zero.
      const distanceToChord = (cx: number, cy: number): number => {
        if (chord === 0) return Math.hypot(cx - p[0]!, cy - p[1]!);
        const ux = dx / chord, uy = dy / chord;
        const along = Math.max(0, Math.min(chord, (cx - p[0]!) * ux + (cy - p[1]!) * uy));
        return Math.hypot(cx - p[0]! - along * ux, cy - p[1]! - along * uy);
      };
      const distance = Math.max(distanceToChord(p[2]!, p[3]!), distanceToChord(p[4]!, p[5]!));
      if (distance <= tolerance) { append({ op: 'L', x: p[6]!, y: p[7]! }); continue; }
      budget.depth(curve.depth + 1, 'curve subdivision');
      budget.allocate(256, 'curve subdivision');
      const ax = (p[0]! + p[2]!) / 2, ay = (p[1]! + p[3]!) / 2;
      const bx = (p[2]! + p[4]!) / 2, by = (p[3]! + p[5]!) / 2;
      const cx = (p[4]! + p[6]!) / 2, cy = (p[5]! + p[7]!) / 2;
      const dx2 = (ax + bx) / 2, dy2 = (ay + by) / 2;
      const ex = (bx + cx) / 2, ey = (by + cy) / 2;
      const mx = (dx2 + ex) / 2, my = (dy2 + ey) / 2;
      pending.push({ points: [mx, my, ex, ey, cx, cy, p[6]!, p[7]!], depth: curve.depth + 1 });
      pending.push({ points: [p[0]!, p[1]!, ax, ay, dx2, dy2, mx, my], depth: curve.depth + 1 });
    }
    x = segment.x; y = segment.y;
  }
  return psPathFromSegments(result);
}

export function readPsRectangles(vm: PsInterpreter, depth = 0): { count: number; boxes: PsBox[] } {
  const source = vm.peek(depth);
  if (source.kind !== 'array') return { count: 4, boxes: [[
    vm.number(depth + 3).value, vm.number(depth + 2).value, vm.number(depth + 1).value, vm.number(depth).value,
  ]] };
  if (source.length % 4) throw new PsFault('rangecheck');
  vm.budget.allocate(source.length * 8, 'rectangle operands');
  const boxes: PsBox[] = [];
  for (let i = 0; i < source.length; i += 4) {
    const box: PsBox = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const item = vm.memory.get(source, i + j);
      if (item.kind !== 'integer' && item.kind !== 'real') throw new PsFault('typecheck');
      box[j] = item.value;
    }
    boxes.push(box);
  }
  return { count: 1, boxes };
}

export function psRectangleSegments(boxes: readonly PsBox[], matrix: Matrix, budget: PsBudget): Seg[] {
  budget.items(boxes.length * 5, 'rectangle path');
  budget.allocate(boxes.length * 5 * 64, 'rectangle path');
  const result: Seg[] = [];
  for (const [x, y, w, h] of boxes) {
    budget.work(5);
    const a = point(matrix, x, y), b = point(matrix, x + w, y);
    const c = point(matrix, x + w, y + h), d = point(matrix, x, y + h);
    result.push({ op: 'M', x: a[0], y: a[1] }, { op: 'L', x: b[0], y: b[1] },
      { op: 'L', x: c[0], y: c[1] }, { op: 'L', x: d[0], y: d[1] }, { op: 'Z' });
  }
  return result;
}

function boxPoints(box: PsBox, matrix: Matrix): PsBox {
  const points = [point(matrix, box[0], box[1]), point(matrix, box[0], box[3]),
    point(matrix, box[2], box[1]), point(matrix, box[2], box[3])];
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

export function psPathBounds(path: PsPathData, graphics: PsGraphics): PsBox {
  if (!path.current) throw new PsFault('nocurrentpoint');
  if (path.bbox) return boxPoints(path.bbox, inversePsMatrix(graphics.state.ctm));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (let i = 0; i < path.segments.length; i++) {
    graphics.budget.work();
    const segment = path.segments[i]!;
    if (segment.op === 'Z') continue;
    if (segment.op === 'M' && i === path.segments.length - 1 && i > 0) continue;
    include(segment.x, segment.y);
    if (segment.op === 'C') { include(segment.x1, segment.y1); include(segment.x2, segment.y2); }
  }
  return boxPoints([minX, minY, maxX, maxY], inversePsMatrix(graphics.state.ctm));
}

function arcSegments(graphics: PsGraphics, x: number, y: number, radius: number,
  angle1: number, angle2: number, ccw: boolean): Seg[] {
  if (radius < 0) throw new PsFault('rangecheck');
  let sweep = angle2 - angle1;
  if (ccw) sweep = sweep >= 360 ? 360 : ((sweep % 360) + 360) % 360;
  else sweep = sweep <= -360 ? -360 : -(((-sweep % 360) + 360) % 360);
  if (!Number.isFinite(sweep)) {
    const difference = angle2 % 360 - angle1 % 360;
    sweep = ccw ? ((difference % 360) + 360) % 360
      : -(((-difference % 360) + 360) % 360);
  }
  const count = Math.ceil(Math.abs(sweep) / 90);
  graphics.budget.allocate(64 * (count + 1), 'arc construction');
  graphics.budget.work(count + 1, 'arc construction');
  const matrix = graphics.state.ctm;
  let angle = (angle1 % 360) * Math.PI / 180;
  const start = point(matrix, x + radius * Math.cos(angle), y + radius * Math.sin(angle));
  const result: Seg[] = [];
  const current = graphics.state.path.current;
  if (!current) result.push({ op: 'M', x: start[0], y: start[1] });
  else if (current[0] !== start[0] || current[1] !== start[1]) result.push({ op: 'L', x: start[0], y: start[1] });
  const step = count ? sweep * Math.PI / 180 / count : 0;
  for (let i = 0; i < count; i++) {
    const next = angle + step;
    const k = 4 / 3 * Math.tan(step / 4);
    const [x1, y1] = point(matrix, x + radius * (Math.cos(angle) - k * Math.sin(angle)),
      y + radius * (Math.sin(angle) + k * Math.cos(angle)));
    const [x2, y2] = point(matrix, x + radius * (Math.cos(next) + k * Math.sin(next)),
      y + radius * (Math.sin(next) - k * Math.cos(next)));
    const [endX, endY] = point(matrix, x + radius * Math.cos(next), y + radius * Math.sin(next));
    result.push({ op: 'C', x1, y1, x2, y2, x: endX, y: endY });
    angle = next;
  }
  return result;
}

function tangentArc(vm: PsInterpreter, graphics: PsGraphics, leavePoints: boolean): void {
  const radius = vm.number().value;
  const y2 = vm.number(1).value, x2 = vm.number(2).value;
  const y1 = vm.number(3).value, x1 = vm.number(4).value;
  if (radius < 0) throw new PsFault('rangecheck');
  const [x0, y0] = currentPsPoint(graphics);
  const len1 = Math.hypot(x0 - x1, y0 - y1), len2 = Math.hypot(x2 - x1, y2 - y1);
  if (len1 === 0 || len2 === 0) throw new PsFault('undefinedresult');
  const ux = (x0 - x1) / len1, uy = (y0 - y1) / len1;
  const vx = (x2 - x1) / len2, vy = (y2 - y1) / len2;
  const cross = ux * vy - uy * vx;
  let tx1 = x1, ty1 = y1, tx2 = x1, ty2 = y1;
  let segments: Seg[];
  if (radius === 0 || Math.abs(cross) < 1e-14) {
    const [x, y] = point(graphics.state.ctm, x1, y1);
    segments = [{ op: 'L', x, y }];
  } else {
    const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    const distance = radius / Math.tan(theta / 2);
    tx1 = x1 + ux * distance; ty1 = y1 + uy * distance;
    tx2 = x1 + vx * distance; ty2 = y1 + vy * distance;
    const scale = radius / Math.abs(cross);
    const cx = x1 + (ux + vx) * scale, cy = y1 + (uy + vy) * scale;
    segments = arcSegments(graphics, cx, cy, radius,
      Math.atan2(ty1 - cy, tx1 - cx) * 180 / Math.PI,
      Math.atan2(ty2 - cy, tx2 - cx) * 180 / Math.PI, cross < 0);
  }
  if (![tx1, ty1, tx2, ty2].every(Number.isFinite)) throw new PsFault('undefinedresult');
  appendPsSegments(graphics, segments);
  if (leavePoints) vm.replace(5, real(tx1), real(ty1), real(tx2), real(ty2));
  else vm.replace(5);
}

export function transformPsPath(path: PsPathData, matrix: Matrix, budget: PsBudget): PsPathData {
  budget.allocate(path.segments.length * 64, 'transformed path');
  budget.work(path.segments.length, 'transformed path');
  const segments = path.segments.map((segment): Seg => {
    if (segment.op === 'Z') return { op: 'Z' };
    const [x, y] = point(matrix, segment.x, segment.y);
    if (segment.op !== 'C') return { op: segment.op, x, y };
    const [x1, y1] = point(matrix, segment.x1, segment.y1);
    const [x2, y2] = point(matrix, segment.x2, segment.y2);
    return { op: 'C', x1, y1, x2, y2, x, y };
  });
  return psPathFromSegments(segments);
}

export function strokePsPath(graphics: PsGraphics): PsPathData {
  const budget = graphics.budget;
  const tolerance = graphics.state.flatness * 72 / 250;
  const flat = flattenPsPath(graphics.state.path, tolerance, budget);
  const user = transformPsPath(flat, inversePsMatrix(graphics.state.ctm), budget);
  let polygons: number[][];
  try {
    polygons = strokeOutlinePolys(user.segments, graphics.state.ctm, graphics.state.line,
      { budget, pixelSize: 72 / 250, tolerance });
  } catch (caught) {
    rethrowLimit(caught);
    if (caught instanceof RangeError) throw new PsFault('undefinedresult');
    throw caught;
  }
  const segments: Seg[] = [];
  for (const polygon of polygons) {
    budget.items(segments.length + polygon.length / 2 + 1, 'stroke path');
    budget.allocate((polygon.length / 2 + 1) * 64, 'stroke path');
    budget.work(polygon.length / 2, 'stroke path');
    for (let i = 0; i < polygon.length; i += 2) {
      const x = polygon[i]!, y = polygon[i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PsFault('undefinedresult');
      segments.push({ op: i ? 'L' : 'M', x, y });
    }
    segments.push({ op: 'Z' });
  }
  return psPathFromSegments(segments);
}

function reversePsPath(path: PsPathData, budget: PsBudget): PsPathData {
  budget.allocate(path.segments.length * 160, 'reversed path');
  const result: Seg[] = [];
  let entries: { segment: Exclude<Seg, { op: 'Z' }>; from: [number, number] }[] = [];
  let start: [number, number] | undefined, current: [number, number] = [0, 0];
  let closed = false;
  const flush = (): void => {
    if (!start) return;
    result.push({ op: 'M', x: current[0], y: current[1] });
    for (let i = entries.length - 1; i >= 0; i--) {
      budget.work();
      const { segment, from } = entries[i]!;
      if (segment.op === 'C') result.push({ op: 'C', x1: segment.x2, y1: segment.y2,
        x2: segment.x1, y2: segment.y1, x: from[0], y: from[1] });
      else result.push({ op: 'L', x: from[0], y: from[1] });
    }
    if (closed) result.push({ op: 'Z' });
  };
  for (const segment of path.segments) {
    budget.work();
    if (segment.op === 'M') {
      flush(); entries = []; closed = false;
      start = current = [segment.x, segment.y];
    } else if (segment.op === 'Z') {
      closed = true;
      flush();
      if (start) current = start;
      start = undefined;
      entries = [];
      closed = false;
    }
    else {
      if (!start) start = current;
      entries.push({ segment, from: current });
      current = [segment.x, segment.y];
    }
  }
  flush();
  return psPathFromSegments(result);
}

const USER_PATH_OPS = [
  ['setbbox', 4], ['moveto', 2], ['rmoveto', 2], ['lineto', 2], ['rlineto', 2],
  ['curveto', 6], ['rcurveto', 6], ['arc', 5], ['arcn', 5], ['arct', 5],
  ['closepath', 0], ['ucache', 0],
] as const;

function compileUserPath(vm: PsInterpreter, source: PsValue,
  operators: ReadonlyMap<string, PsValue>): PsArray {
  if (source.kind !== 'array') throw new PsFault('typecheck');
  const values: PsValue[] = [];
  const append = (value: PsValue): void => {
    vm.budget.items(values.length + 1, 'user path program');
    vm.budget.allocate(16, 'user path program');
    values.push(value);
  };
  const last = source.length ? vm.memory.get(source, source.length - 1) : undefined;
  if (last?.kind === 'string') {
    const operands: PsValue[] = [];
    const collect = (value: PsValue): void => {
      if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck');
      vm.budget.items(operands.length + 1, 'encoded path operands');
      vm.budget.allocate(16, 'encoded path operands');
      operands.push(value);
    };
    for (let i = 0; i < source.length - 1; i++) {
      const value = vm.memory.get(source, i);
      if (value.kind === 'array') for (let j = 0; j < value.length; j++) collect(vm.memory.get(value, j));
      else collect(value);
    }
    let at = 0;
    for (let i = 0; i < last.length; i++) {
      let code = vm.memory.get(last, i);
      if (code.kind !== 'integer') throw new PsFault('typecheck');
      let repeat = 1;
      if (code.value >= 32) {
        repeat = code.value - 32;
        if (!repeat || ++i >= last.length) throw new PsFault('rangecheck');
        code = vm.memory.get(last, i);
      }
      if (code.kind !== 'integer' || code.value >= USER_PATH_OPS.length) throw new PsFault('typecheck');
      const [text, count] = USER_PATH_OPS[code.value]!;
      for (let n = 0; n < repeat; n++) {
        vm.budget.work();
        for (let j = 0; j < count; j++) {
          if (at >= operands.length) throw new PsFault('rangecheck');
          append(operands[at++]!);
        }
        append(name(text, true));
      }
    }
    if (at !== operands.length) throw new PsFault('rangecheck');
  } else {
    for (let i = 0; i < source.length; i++) append(vm.memory.get(source, i));
  }
  let argumentsWaiting = 0, commands = 0;
  for (let i = 0; i < values.length; i++) {
    vm.budget.work();
    const value = values[i]!;
    if (value.kind === 'integer' || value.kind === 'real') { argumentsWaiting++; continue; }
    if (value.kind !== 'name' && value.kind !== 'operator') throw new PsFault('typecheck');
    const text = value.kind === 'name' ? value.text : value.name;
    const definition = USER_PATH_OPS.find(([key]) => key === text);
    if (!definition || !operators.has(text)) throw new PsFault('typecheck');
    if (argumentsWaiting !== definition[1]) throw new PsFault('rangecheck');
    if (text === 'ucache') {
      if (commands) throw new PsFault('typecheck');
    } else {
      if (commands === 0 && text !== 'setbbox') throw new PsFault('typecheck');
      commands++;
    }
    argumentsWaiting = 0;
    values[i] = operators.get(text)!;
  }
  if (argumentsWaiting || commands === 0) throw new PsFault('rangecheck');
  return vm.memory.arrayFrom(values, true);
}

const userPathOperators = new WeakMap<PsGraphics, ReadonlyMap<string, PsValue>>();

export function readPsUserPathOperand(vm: PsInterpreter): { value: PsValue; count: number; matrix?: Matrix } {
  const top = vm.peek();
  if (top.kind === 'array' && top.length === 6) {
    let matrix = true;
    for (let i = 0; i < 6; i++) {
      const value = vm.memory.get(top, i);
      if (value.kind !== 'integer' && value.kind !== 'real') { matrix = false; break; }
    }
    if (matrix) return { value: vm.peek(1), count: 2, matrix: readPsMatrix(vm, top) };
  }
  return { value: top, count: 1 };
}

export function executePsUserPath(vm: PsInterpreter, graphics: PsGraphics, source: PsValue,
  options: { append?: boolean; preserve?: boolean; complete?: () => void } = {}): void {
  const program = compileUserPath(vm, source, userPathOperators.get(graphics)!);
  const original = graphics.state.path;
  const next = options.append ? copyPsPath(original, vm.budget) : { segments: [] };
  graphics.replacePath(next);
  vm.invoke(program, {
    roots: [program],
    complete: () => {
      options.complete?.();
      if (options.preserve) graphics.replacePath(original);
    },
    unwind: () => graphics.replacePath(original),
  });
}

export function installPsPath(vm: PsInterpreter, graphics: PsGraphics): void {
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  op('newpath', () => {
    vm.budget.allocate(128, 'new path');
    graphics.replacePath({ segments: [] });
  });
  op('currentpoint', () => {
    const [x, y] = currentPsPoint(graphics);
    vm.push(real(x)); vm.push(real(y));
  });
  for (const text of ['moveto', 'lineto', 'rmoveto', 'rlineto']) op(text, () => {
    const y = vm.number().value, x = vm.number(1).value;
    const relative = text[0] === 'r';
    const move = text.includes('moveto');
    const current = graphics.state.path.current;
    if ((!move || relative) && !current) throw new PsFault('nocurrentpoint');
    const matrix = graphics.state.ctm;
    const [px, py] = relative
      ? [current![0] + matrix[0] * x + matrix[2] * y, current![1] + matrix[1] * x + matrix[3] * y]
      : point(matrix, x, y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new PsFault('undefinedresult');
    appendPsSegments(graphics, [{ op: move ? 'M' : 'L', x: px, y: py }]);
    vm.replace(2);
  });
  for (const text of ['curveto', 'rcurveto']) op(text, () => {
    const points = [5, 3, 1].map(depth => point(graphics.state.ctm, vm.number(depth).value, vm.number(depth - 1).value));
    const current = graphics.state.path.current;
    if (!current) throw new PsFault('nocurrentpoint');
    if (text === 'rcurveto') for (const p of points) {
      p[0] += current[0] - graphics.state.ctm[4];
      p[1] += current[1] - graphics.state.ctm[5];
      if (!p.every(Number.isFinite)) throw new PsFault('undefinedresult');
    }
    appendPsSegments(graphics, [{ op: 'C', x1: points[0]![0], y1: points[0]![1],
      x2: points[1]![0], y2: points[1]![1], x: points[2]![0], y: points[2]![1] }]);
    vm.replace(6);
  });
  op('closepath', () => {
    if (graphics.state.path.current) appendPsSegments(graphics, [{ op: 'Z' }]);
  });
  for (const text of ['arc', 'arcn']) op(text, () => {
    const angle2 = vm.number().value, angle1 = vm.number(1).value;
    const radius = vm.number(2).value, y = vm.number(3).value, x = vm.number(4).value;
    const segments = arcSegments(graphics, x, y, radius, angle1, angle2, text === 'arc');
    appendPsSegments(graphics, segments);
    vm.replace(5);
  });
  op('arct', () => tangentArc(vm, graphics, false));
  op('arcto', () => tangentArc(vm, graphics, true));
  op('pathbbox', () => {
    const box = psPathBounds(graphics.state.path, graphics);
    for (const value of box) vm.push(real(value));
  });
  op('setbbox', () => {
    const box: PsBox = [vm.number(3).value, vm.number(2).value, vm.number(1).value, vm.number().value];
    if (box[2] < box[0] || box[3] < box[1]) throw new PsFault('rangecheck');
    const deviceBox = boxPoints(box, graphics.state.ctm);
    vm.replace(4);
    graphics.state.path.bbox = deviceBox;
  });
  op('flattenpath', () => graphics.replacePath(flattenPsPath(graphics.state.path,
    graphics.state.flatness * 72 / 250, vm.budget)));
  op('reversepath', () => graphics.replacePath(reversePsPath(graphics.state.path, vm.budget)));
  op('strokepath', () => graphics.replacePath(strokePsPath(graphics)));
  op('pathforall', () => {
    const procedures = [vm.procedure(3), vm.procedure(2), vm.procedure(1), vm.procedure()];
    const path = transformPsPath(graphics.state.path, inversePsMatrix(graphics.state.ctm), vm.budget);
    let index = 0;
    vm.replace(4);
    vm.scheduleLoop(() => {
      if (index === path.segments.length) return false;
      const segment = path.segments[index++]!;
      if (segment.op === 'C') {
        vm.push(real(segment.x1)); vm.push(real(segment.y1));
        vm.push(real(segment.x2)); vm.push(real(segment.y2));
      }
      if (segment.op !== 'Z') { vm.push(real(segment.x)); vm.push(real(segment.y)); }
      const slot = segment.op === 'M' ? 0 : segment.op === 'L' ? 1 : segment.op === 'C' ? 2 : 3;
      vm.execute(procedures[slot]!);
      return true;
    }, procedures);
  });
  op('ucache', () => {});
  const operators = new Map<string, PsValue>();
  for (const [text] of USER_PATH_OPS) operators.set(text, vm.memory.lookup(vm.systemdict, name(text))!);
  userPathOperators.set(graphics, operators);
  op('uappend', () => {
    executePsUserPath(vm, graphics, vm.peek(), { append: true });
    vm.replace(1);
  });
  op('ustrokepath', () => {
    const operand = readPsUserPathOperand(vm);
    executePsUserPath(vm, graphics, operand.value, { complete: () => {
      const matrix = graphics.state.ctm;
      try {
        if (operand.matrix) graphics.state.ctm = mul(operand.matrix, matrix);
        graphics.replacePath(strokePsPath(graphics));
      } finally { graphics.state.ctm = matrix; }
    } });
    vm.replace(operand.count);
  });
  op('upath', () => {
    const cache = vm.typed('boolean').value;
    const path = transformPsPath(graphics.state.path, inversePsMatrix(graphics.state.ctm), vm.budget);
    const box = graphics.state.path.current ? psPathBounds(graphics.state.path, graphics) : [0, 0, 0, 0];
    const values: PsValue[] = [];
    const append = (value: PsValue): void => {
      vm.budget.items(values.length + 1, 'captured user path');
      vm.budget.allocate(16, 'captured user path');
      values.push(value);
    };
    if (cache) append(name('ucache', true));
    for (const value of box) append(real(value));
    append(name('setbbox', true));
    for (const segment of path.segments) {
      vm.budget.work();
      if (segment.op === 'C') {
        append(real(segment.x1)); append(real(segment.y1)); append(real(segment.x2)); append(real(segment.y2));
      }
      if (segment.op !== 'Z') { append(real(segment.x)); append(real(segment.y)); }
      append(name(segment.op === 'M' ? 'moveto' : segment.op === 'L' ? 'lineto' : segment.op === 'C' ? 'curveto' : 'closepath', true));
    }
    vm.replace(1, vm.memory.arrayFrom(values, true));
  });
}
