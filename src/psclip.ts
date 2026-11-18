import type { PsBudget } from './psbudget.js';
import type { PsGraphics } from './psgraphics.js';
import type { PsInterpreter } from './psvm.js';
import type { PsBox, PsClip, PsPathData } from './psstate.js';
import type { Seg } from './pagerender.js';
import { copyPsPath } from './psstate.js';
import { flattenPsPath, psPathFromSegments, psRectangleSegments, readPsRectangles } from './pspath.js';
import { IDENTITY } from './text.js';

type Point = [number, number];
interface Edge { a: Point; b: Point; cuts: number[] }
interface Region { edges: Edge[]; evenOdd: boolean }
interface Boundary { a: Point; b: Point; from: string; to: string; used: boolean }

function edgesOf(path: PsPathData, budget: PsBudget): Edge[] {
  const edges: Edge[] = [];
  let start: Point | undefined, current: Point | undefined;
  const add = (a: Point, b: Point): void => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    budget.items(edges.length + 1, 'clip edges');
    budget.allocate(128, 'clip edge');
    edges.push({ a, b, cuts: [0, 1] });
  };
  for (const segment of path.segments) {
    budget.work();
    if (segment.op === 'M') {
      if (current && start) add(current, start);
      start = current = [segment.x, segment.y];
    } else if (segment.op === 'L') {
      const next: Point = [segment.x, segment.y];
      if (current) add(current, next);
      current = next;
    } else if (segment.op === 'Z' && current && start) {
      add(current, start);
      current = start;
    }
  }
  if (current && start) add(current, start);
  return edges;
}

function splitPair(a: Edge, b: Edge, budget: PsBudget): void {
  budget.work();
  const ax = a.b[0] - a.a[0], ay = a.b[1] - a.a[1];
  const bx = b.b[0] - b.a[0], by = b.b[1] - b.a[1];
  const cx = b.a[0] - a.a[0], cy = b.a[1] - a.a[1];
  const determinant = ax * by - ay * bx;
  const cut = (edge: Edge, value: number): void => {
    if (!(value > 0 && value < 1)) return;
    budget.items(edge.cuts.length + 1, 'clip intersections');
    budget.allocate(8, 'clip intersection');
    edge.cuts.push(value);
  };
  if (determinant !== 0) {
    const t = (cx * by - cy * bx) / determinant;
    const u = (cx * ay - cy * ax) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { cut(a, t); cut(b, u); }
    return;
  }
  if (cx * ay - cy * ax !== 0) return;
  const project = (edge: Edge, p: Point): number => {
    const dx = edge.b[0] - edge.a[0], dy = edge.b[1] - edge.a[1];
    return Math.abs(dx) >= Math.abs(dy) ? (p[0] - edge.a[0]) / dx : (p[1] - edge.a[1]) / dy;
  };
  cut(a, project(a, b.a)); cut(a, project(a, b.b));
  cut(b, project(b, a.a)); cut(b, project(b, a.b));
}

function inside(regions: readonly Region[], x: number, y: number, budget: PsBudget): boolean {
  for (const region of regions) {
    let winding = 0;
    for (const edge of region.edges) {
      budget.work();
      const [ax, ay] = edge.a, [bx, by] = edge.b;
      const side = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (ay <= y && by > y && side > 0) winding++;
      else if (by <= y && ay > y && side < 0) winding--;
    }
    if (region.evenOdd ? winding % 2 === 0 : winding === 0) return false;
  }
  return true;
}

/** Planar arrangement of the retained boundaries. Output contours are oriented
 * with the intersection on their left, so holes obey nonzero filling. */
export function materializePsClip(clips: readonly PsClip[], box: PsBox,
  flatness: number, budget: PsBudget): PsPathData {
  const base = psPathFromSegments(psRectangleSegments([[box[0], box[1], box[2] - box[0], box[3] - box[1]]], IDENTITY, budget));
  budget.allocate(32 * (clips.length + 1), 'clip regions');
  const regions: Region[] = [{ edges: edgesOf(base, budget), evenOdd: false }];
  for (const clip of clips) {
    const path = flattenPsPath(clip.path, flatness * 72 / 250, budget);
    const edges = edgesOf(path, budget);
    if (edges.length === 0) return { segments: [{ op: 'M', x: 0, y: 0 }, { op: 'Z' }], current: [0, 0], start: [0, 0] };
    regions.push({ edges, evenOdd: clip.evenOdd });
  }
  const all: Edge[] = [];
  for (const region of regions) for (const edge of region.edges) {
    budget.items(all.length + 1, 'clip arrangement edges');
    budget.allocate(16, 'clip arrangement edges');
    all.push(edge);
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) splitPair(all[i]!, all[j]!, budget);
  const epsilon = 1e-8;
  const key = (p: Point): string => `${Math.round(p[0] / epsilon)},${Math.round(p[1] / epsilon)}`;
  const boundary: Boundary[] = [];
  const unique = new Set<string>();
  for (const edge of all) {
    edge.cuts.sort((a, b) => { budget.work(); return a - b; });
    const dx = edge.b[0] - edge.a[0], dy = edge.b[1] - edge.a[1];
    for (let i = 1; i < edge.cuts.length; i++) {
      budget.work();
      const t0 = edge.cuts[i - 1]!, t1 = edge.cuts[i]!;
      if (t1 - t0 < 1e-12) continue;
      let a: Point = [edge.a[0] + dx * t0, edge.a[1] + dy * t0];
      let b: Point = [edge.a[0] + dx * t1, edge.a[1] + dy * t1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(length > epsilon)) continue;
      const midX = a[0] / 2 + b[0] / 2, midY = a[1] / 2 + b[1] / 2;
      const offset = Math.min(1e-6, length * 1e-4);
      const nx = -(b[1] - a[1]) / length * offset, ny = (b[0] - a[0]) / length * offset;
      const left = inside(regions, midX + nx, midY + ny, budget);
      const right = inside(regions, midX - nx, midY - ny, budget);
      if (left === right) continue;
      if (!left) [a, b] = [b, a];
      budget.allocate(128, 'clip boundary');
      const from = key(a), to = key(b), identity = `${from}:${to}`;
      if (unique.has(identity)) continue;
      budget.items(boundary.length + 1, 'clip boundary');
      unique.add(identity);
      boundary.push({ a, b, from, to, used: false });
    }
  }
  const outgoing = new Map<string, Boundary[]>();
  for (const edge of boundary) {
    budget.work();
    budget.allocate(32, 'clip adjacency');
    let list = outgoing.get(edge.from);
    if (!list) { list = []; outgoing.set(edge.from, list); }
    list.push(edge);
  }
  const segments: Seg[] = [];
  const append = (segment: Seg): void => {
    budget.items(segments.length + 1, 'materialized clip');
    budget.allocate(64, 'materialized clip');
    segments.push(segment);
  };
  for (const first of boundary) {
    if (first.used) continue;
    append({ op: 'M', x: first.a[0], y: first.a[1] });
    let edge: Boundary | undefined = first;
    while (edge && !edge.used) {
      budget.work();
      edge.used = true;
      append({ op: 'L', x: edge.b[0], y: edge.b[1] });
      if (edge.to === first.from) break;
      const reverse = Math.atan2(edge.a[1] - edge.b[1], edge.a[0] - edge.b[0]);
      let turn = Infinity;
      let next: Boundary | undefined;
      for (const candidate of outgoing.get(edge.to) ?? []) {
        budget.work();
        if (candidate.used) continue;
        const angle = Math.atan2(candidate.b[1] - candidate.a[1], candidate.b[0] - candidate.a[0]);
        const delta = (reverse - angle + Math.PI * 2) % (Math.PI * 2);
        if (delta < turn) { turn = delta; next = candidate; }
      }
      edge = next;
    }
    append({ op: 'Z' });
  }
  if (!segments.length) {
    append({ op: 'M', x: 0, y: 0 });
    append({ op: 'Z' });
  }
  return psPathFromSegments(segments);
}

export function installPsClip(vm: PsInterpreter, graphics: PsGraphics): void {
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  const add = (path: PsPathData, evenOdd: boolean): void => {
    vm.budget.items(graphics.state.clips.length + 1, 'clip chain');
    vm.budget.allocate(32, 'clip chain');
    const copy = copyPsPath(path, vm.budget);
    graphics.state.clips.push({ path: copy, evenOdd });
  };
  op('clip', () => add(graphics.state.path, false));
  op('eoclip', () => add(graphics.state.path, true));
  op('initclip', () => { graphics.state.clips = []; });
  op('clippath', () => graphics.replacePath(materializePsClip(graphics.state.clips,
    graphics.defaultBox, graphics.state.flatness, vm.budget)));
  op('rectclip', () => {
    const { count, boxes } = readPsRectangles(vm);
    const path = psPathFromSegments(psRectangleSegments(boxes, graphics.state.ctm, vm.budget));
    add(path, false);
    vm.replace(count);
  });
  op('clipsave', () => {
    const saved = graphics.state.clipSaves;
    vm.budget.items(saved.length + 1, 'clipping stack');
    vm.budget.depth(saved.length + 1, 'clipping stack');
    vm.budget.allocate(32 + graphics.state.clips.length * 16, 'clipping stack');
    vm.budget.work(graphics.state.clips.length);
    saved.push(graphics.state.clips.slice());
  });
  op('cliprestore', () => {
    const saved = graphics.state.clipSaves.pop();
    if (saved) graphics.state.clips = saved;
  });
}
