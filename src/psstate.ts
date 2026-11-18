import type { Matrix } from './text.js';
import type { Path, StrokeStyle } from './pagerender.js';
import type { PsValue, PsArray, PsString, PsDictionary } from './psvalue.js';
import type { PsBudget } from './psbudget.js';
import type { PdfStream } from './types.js';

export type PsBox = [number, number, number, number];
export interface PsPathData {
  segments: Path;
  current?: [number, number];
  start?: [number, number];
  bbox?: PsBox;
}
export interface PsClip { path: PsPathData; evenOdd: boolean }
export type PsDeviceSpace = 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
export interface PsDevicePaint { space: PsDeviceSpace; components: number[]; none?: boolean }
interface PsColorBase {
  descriptor: PsValue;
  components: number[];
  prepared?: PsDevicePaint;
}
export type PsColorState =
  | (PsColorBase & { space: PsDeviceSpace })
  | (PsColorBase & { space: 'Indexed'; base: PsColorState; high: number; lookup: PsString | PsArray })
  | (PsColorBase & { space: 'Separation' | 'DeviceN'; alternate: PsColorState; names: string[]; transform: PsArray; native?: number[] })
  | (PsColorBase & { space: 'Pattern'; base?: PsColorState; pattern?: PsDictionary; resource?: PdfStream });
export interface PsState {
  font?: PsDictionary;
  deviceBox: PsBox;
  ctm: Matrix;
  defaultMatrix: Matrix;
  path: PsPathData;
  clips: PsClip[];
  clipSaves: PsClip[][];
  line: StrokeStyle;
  sourceDash?: PsArray;
  flatness: number;
  strokeAdjust: boolean;
  overprint: boolean;
  color: PsColorState;
  discarding: boolean;
}

export function copyPsPath(path: PsPathData, budget: PsBudget): PsPathData {
  budget.items(path.segments.length);
  budget.allocate(128 + path.segments.length * 64, 'path snapshot');
  budget.work(path.segments.length, 'path snapshot');
  return {
    segments: path.segments.map(segment => ({ ...segment })),
    current: path.current && [...path.current],
    start: path.start && [...path.start],
    bbox: path.bbox && [...path.bbox],
  };
}

export function copyPsState(state: PsState, budget: PsBudget): PsState {
  budget.allocate(512 + state.line.dash.length * 16 + state.clips.length * 32 + state.clipSaves.length * 16
    + state.color.components.length * 16, 'graphics state snapshot');
  budget.work(state.line.dash.length + state.clips.length, 'graphics state snapshot');
  return {
    ...state,
    deviceBox: [...state.deviceBox],
    ctm: [...state.ctm],
    defaultMatrix: [...state.defaultMatrix],
    path: copyPsPath(state.path, budget),
    clips: state.clips.map(clip => ({ ...clip, path: copyPsPath(clip.path, budget) })),
    clipSaves: state.clipSaves.map(clips => {
      budget.allocate(32 + clips.length * 16, 'clip save snapshot');
      budget.work(clips.length);
      return clips.map(clip => ({ ...clip, path: copyPsPath(clip.path, budget) }));
    }),
    line: { ...state.line, dash: state.line.dash.slice() },
    color: copyPsColor(state.color, budget),
  };
}

export function copyPsColor(color: PsColorState, budget: PsBudget): PsColorState {
  const clone = (source: PsColorState): PsColorState => {
    budget.allocate(128 + source.components.length * 16 + (source.prepared?.components.length ?? 0) * 16, 'color snapshot');
    budget.work(source.components.length, 'color snapshot');
    return { ...source, components: source.components.slice(),
      prepared: source.prepared && { ...source.prepared, components: source.prepared.components.slice() } };
  };
  const result = clone(color);
  let source = color, target = result;
  for (;;) {
    const child = source.space === 'Indexed' || source.space === 'Pattern' ? source.base
      : source.space === 'Separation' || source.space === 'DeviceN' ? source.alternate : undefined;
    if (!child) return result;
    const copy = clone(child);
    if (target.space === 'Indexed' || target.space === 'Pattern') target.base = copy;
    else if (target.space === 'Separation' || target.space === 'DeviceN') target.alternate = copy;
    source = child;
    target = copy;
  }
}

export function visitPsColorRoots(color: PsColorState, visit: (value: PsValue) => void): void {
  let current: PsColorState | undefined = color;
  while (current) {
    visit(current.descriptor);
    if (current.space === 'Indexed') { visit(current.lookup); current = current.base; }
    else if (current.space === 'Separation' || current.space === 'DeviceN') {
      visit(current.transform); current = current.alternate;
    } else if (current.space === 'Pattern') {
      if (current.pattern) visit(current.pattern);
      current = current.base;
    } else current = undefined;
  }
}

export function visitPsStateRoots(state: PsState, visit: (value: PsValue) => void): void {
  if (state.font) visit(state.font);
  visitPsColorRoots(state.color, visit);
  if (state.sourceDash) visit(state.sourceDash);
}
