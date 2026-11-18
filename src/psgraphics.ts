import type { PsInterpreter, PsInvocation, PsSaveSnapshot } from './psvm.js';
import { copyPsState, visitPsStateRoots, type PsState, type PsPathData, type PsBox } from './psstate.js';
import { IDENTITY, mul, type Matrix } from './text.js';
import { name, real, PsFault } from './psvalue.js';
import { installPsMatrix, readPsMatrix } from './psmatrix.js';
import { installPsPath, readPsRectangles, psPathFromSegments, psRectangleSegments,
  executePsUserPath, readPsUserPathOperand } from './pspath.js';
import { installPsClip } from './psclip.js';
import { PsPdfWriter, type PsPageOutput, type PsOutputCounters } from './pspdf.js';
import { UnsupportedFeatureError } from './errors.js';
import { installPsColor } from './pscolor.js';
import { DecodeBudget } from './decodebudget.js';
import { installPsSource } from './pssource.js';
import { installPsImage } from './psimage.js';
import { installPsPaint } from './pspaint.js';
import { apply } from './text.js';

interface SavedGraphics { state: PsState; barrier: boolean }
export interface PsCapture { complete(): PsPageOutput; abort(): void }

export class PsGraphics {
  readonly budget;
  readonly decode: DecodeBudget;
  get defaultBox(): PsBox { return this.current.deviceBox; }
  private current: PsState;
  private states: SavedGraphics[] = [];
  private readonly counters: PsOutputCounters = { bytes: 0, tokens: 0 };
  private pageWriter: PsPdfWriter;
  private readonly pages: PsPageOutput[] = [];
  private finalized?: readonly PsPageOutput[];
  private trailing?: PsPageOutput;
  private captures = 0;
  get writer(): PsPdfWriter { if (!this.captures) this.syncDevice(); return this.pageWriter; }
  get uncolored(): boolean { return this.pageWriter.uncolored; }
  assertColorAllowed(): void { if (this.uncolored) throw new PsFault('undefined'); }
  private assertPageAllowed(): void {
    if (this.captures) throw new UnsupportedFeatureError('PostScript page changes during capture are unsupported');
  }
  get state(): PsState { return this.current; }

  constructor(readonly vm: PsInterpreter, options: { box?: PsBox; defaultMatrix?: Matrix } = {}) {
    this.budget = vm.budget;
    this.decode = new DecodeBudget(this.budget.limits);
    const box = options.box ?? [0, 0, 595, 842];
    const matrix = options.defaultMatrix ?? IDENTITY;
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
      throw new TypeError('PostScript page box must have positive finite dimensions');
    if (matrix.length !== 6 || !matrix.every(Number.isFinite))
      throw new TypeError('PostScript default matrix must contain six finite numbers');
    this.current = this.defaultState(box, matrix);
    this.pageWriter = new PsPdfWriter(this.budget, this.defaultBox, this.counters);
    vm.addSaveParticipant({ prepareSave: () => this.prepareSave() });
  }

  private defaultState(box: PsBox, matrix: Matrix, discarding = false): PsState {
    this.budget.allocate(512, 'initial graphics state');
    return {
      deviceBox: [...box],
      ctm: [...matrix], defaultMatrix: [...matrix], path: { segments: [] }, clips: [], clipSaves: [],
      line: { width: 1, cap: 0, join: 0, miter: 10, dash: [], dashPhase: 0 },
      flatness: 1, strokeAdjust: false, overprint: false,
      color: { space: 'DeviceGray', descriptor: name('DeviceGray'), components: [0] },
      discarding,
    };
  }

  initialize(): void {
    this.assertColorAllowed();
    this.current = this.defaultState(this.current.deviceBox, this.current.defaultMatrix, this.current.discarding);
  }

  private publish(output: PsPageOutput): void {
    this.budget.items(this.pages.length + 1, 'output pages');
    this.budget.allocate(32, 'output page');
    this.pages.push(output);
    this.finalized = undefined;
  }

  private syncDevice(): void {
    if (this.current.discarding || this.current.deviceBox.every((value, index) => value === this.pageWriter.box[index])) return;
    const next = new PsPdfWriter(this.budget, this.current.deviceBox, this.counters);
    if (this.pageWriter.hasMarks) this.publish(this.pageWriter.finish());
    this.pageWriter = next;
    this.finalized = undefined;
  }

  paint(mode: 'fill' | 'eofill' | 'stroke'): void {
    this.budget.allocate(128, 'painted path reset');
    if (!this.current.discarding) this.writer.paintPath(this.current.path, this.current, mode);
    this.current.path = { segments: [] };
    this.finalized = undefined;
  }

  showPage(copy = false): void {
    this.assertPageAllowed();
    if (this.current.discarding) return;
    this.syncDevice();
    const output = this.pageWriter.finish();
    if (copy) { this.publish(output); return; }
    const state = this.defaultState(this.current.deviceBox, this.current.defaultMatrix);
    const writer = new PsPdfWriter(this.budget, state.deviceBox, this.counters);
    this.publish(output);
    this.current = state;
    this.pageWriter = writer;
  }

  erasePage(): void {
    this.assertPageAllowed();
    if (this.current.discarding) return;
    this.pageWriter = new PsPdfWriter(this.budget, this.current.deviceBox, this.counters);
    this.finalized = undefined;
  }

  setPageSize(width: number, height: number): void {
    this.assertPageAllowed();
    if (width <= 0 || height <= 0) throw new PsFault('rangecheck');
    const box = this.current.deviceBox;
    if (!this.current.discarding && width === box[2] - box[0] && height === box[3] - box[1]) return;
    this.syncDevice();
    const state = this.defaultState([0, 0, width, height], this.current.defaultMatrix);
    const writer = new PsPdfWriter(this.budget, state.deviceBox, this.counters);
    if (this.pageWriter.hasMarks) this.publish(this.pageWriter.finish());
    this.current = state;
    this.pageWriter = writer;
    this.finalized = undefined;
  }

  nullDevice(): void {
    this.assertPageAllowed();
    const state = this.defaultState([0, 0, 0, 0], IDENTITY, true);
    state.clips = [{ path: { segments: [{ op: 'M', x: 0, y: 0 }, { op: 'Z' }], current: [0, 0], start: [0, 0] }, evenOdd: false }];
    this.current = state;
  }

  finish(): readonly PsPageOutput[] {
    this.syncDevice();
    this.budget.items(this.pages.length + (this.pageWriter.hasMarks ? 1 : 0), 'output pages');
    const trailing = this.pageWriter.hasMarks ? this.pageWriter.finish() : undefined;
    if (this.finalized && this.trailing === trailing) return this.finalized;
    this.budget.allocate((this.pages.length + (trailing ? 1 : 0)) * 16, 'completed pages');
    this.budget.work(this.pages.length, 'completed pages');
    this.finalized = trailing ? [...this.pages, trailing] : this.pages.slice();
    this.trailing = trailing;
    return this.finalized;
  }

  private checkGrowth(): void {
    this.budget.depth(this.states.length + 1, 'graphics stack');
    this.budget.items(this.states.length + 1, 'graphics stack');
    this.budget.allocate(32, 'graphics stack entry');
  }

  saveState(): void {
    this.checkGrowth();
    const state = copyPsState(this.current, this.budget);
    this.states.push({ state, barrier: false });
  }

  restoreState(): void {
    const saved = this.states[this.states.length - 1];
    if (!saved) return;
    const state = copyPsState(saved.state, this.budget);
    if (!saved.barrier) this.states.pop();
    this.current = state;
  }

  restoreAll(): void {
    let index = this.states.length - 1;
    while (index >= 0 && !this.states[index]!.barrier) {
      this.budget.work();
      index--;
    }
    const saved = this.states[Math.max(0, index)];
    if (!saved) return;
    const state = copyPsState(saved.state, this.budget);
    this.states.length = index < 0 ? 0 : index + 1;
    this.current = state;
  }

  private prepareSave(): PsSaveSnapshot {
    this.checkGrowth();
    const state = copyPsState(this.current, this.budget);
    this.budget.allocate(this.states.length * 16, 'saved graphics stack');
    this.budget.work(this.states.length, 'saved graphics stack');
    const prefix = this.states.slice();
    const boundary = { state, barrier: true };
    return {
      saved: () => { this.states.push(boundary); },
      visitRoots: visit => {
        visitPsStateRoots(state, visit);
        for (const entry of prefix) {
          this.budget.work();
          visitPsStateRoots(entry.state, visit);
        }
      },
      restore: () => { this.current = state; this.states = prefix; },
    };
  }

  replacePath(path: PsPathData): void { this.current.path = path; }
  replaceState(state: PsState): void { this.assertColorAllowed(); this.current = state; }

  /** matrix maps capture coordinates to the shared device coordinate system. */
  beginCapture(box: PsBox, matrix: Matrix, uncolored: boolean): PsCapture {
    this.budget.depth(this.captures + 1, 'paint capture');
    const state = copyPsState(this.current, this.budget);
    const writer = new PsPdfWriter(this.budget, box, this.counters, uncolored || this.uncolored, matrix);
    state.ctm = [...matrix]; state.defaultMatrix = [...matrix]; state.path = { segments: [] };
    const points = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
      .map(([x, y]) => apply(matrix, x!, y!));
    if (!points.flat().every(Number.isFinite)) throw new PsFault('undefinedresult');
    state.clips = [{ path: psPathFromSegments([
      { op: 'M', x: points[0]![0], y: points[0]![1] },
      ...points.slice(1).map(([x, y]) => ({ op: 'L' as const, x, y })), { op: 'Z' },
    ]), evenOdd: false }];
    state.clipSaves = [];
    const initial = copyPsState(state, this.budget);
    this.budget.allocate(32, 'capture graphics stack');
    const parent = this.pageWriter, parentState = this.current, parentStates = this.states;
    this.pageWriter = writer; this.current = state;
    this.states = [{ state: initial, barrier: true }]; this.captures++;
    let active = true;
    const abort = (): void => {
      if (active) {
        this.pageWriter = parent; this.current = parentState; this.states = parentStates;
        this.captures--; active = false;
      }
    };
    return { abort, complete: () => { const output = writer.finish(); abort(); return output; } };
  }

  withPaintScope(complete: () => void, unwind: () => void): PsInvocation {
    const saved = copyPsState(this.current, this.budget);
    const stack = this.states;
    const roots: import('./psvalue.js').PsValue[] = [];
    const retain = (value: import('./psvalue.js').PsValue): void => {
      this.budget.items(roots.length + 1, 'paint scope roots');
      this.budget.allocate(16, 'paint scope root');
      this.budget.work();
      roots.push(value);
    };
    visitPsStateRoots(saved, retain);
    for (const entry of stack) {
      this.budget.work();
      visitPsStateRoots(entry.state, retain);
    }
    this.budget.allocate(32, 'paint scope graphics stack');
    this.states = [{ state: saved, barrier: true }];
    const restore = (): void => { this.current = saved; this.states = stack; };
    return {
      roots,
      complete: () => { complete(); restore(); },
      unwind: () => { restore(); unwind(); },
    };
  }
}

const installed = new WeakSet<PsInterpreter>();
export function installPsGraphics(vm: PsInterpreter,
  options: { box?: PsBox; defaultMatrix?: Matrix } = {}): PsGraphics {
  if (installed.has(vm)) throw new PsFault('invalidaccess');
  installed.add(vm);
  const graphics = new PsGraphics(vm, options);
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  op('gsave', () => graphics.saveState());
  op('grestore', () => graphics.restoreState());
  op('grestoreall', () => graphics.restoreAll());
  op('initgraphics', () => graphics.initialize());
  op('gstate', () => vm.push(vm.memory.gstate(graphics.state)));
  op('currentgstate', () => {
    const value = vm.typed('gstate');
    vm.memory.writeGState(value, graphics.state);
    vm.replace(1, value);
  });
  op('setgstate', () => {
    const state = copyPsState(vm.memory.readGState(vm.typed('gstate')), vm.budget);
    vm.replace(1);
    graphics.replaceState(state);
  });
  installPsMatrix(vm, graphics);
  installPsPath(vm, graphics);
  installPsClip(vm, graphics);
  installPsSource(vm, graphics.decode);
  installPsImage(vm, graphics, graphics.decode);
  installPsColor(vm, graphics);
  installPsPaint(vm, graphics);
  for (const text of ['fill', 'eofill', 'stroke'] as const) op(text, () => graphics.paint(text));
  for (const text of ['rectfill', 'rectstroke'] as const) op(text, () => {
    let extra = 0;
    let pen: Matrix | undefined;
    const top = vm.peek();
    if (text === 'rectstroke' && top.kind === 'array' && top.length === 6 && vm.stack.length >= 2
      && (vm.peek(1).kind === 'array' || vm.stack.length >= 5)) {
      pen = readPsMatrix(vm, top);
      extra = 1;
    }
    const { count, boxes } = readPsRectangles(vm, extra);
    const path = psPathFromSegments(psRectangleSegments(boxes, graphics.state.ctm, vm.budget));
    const saved = graphics.state.path, matrix = graphics.state.ctm;
    try {
      graphics.replacePath(path);
      if (pen) graphics.state.ctm = mul(pen, matrix);
      graphics.paint(text === 'rectfill' ? 'fill' : 'stroke');
    } finally { graphics.state.ctm = matrix; graphics.replacePath(saved); }
    vm.replace(count + extra);
  });
  for (const text of ['ufill', 'ueofill', 'ustroke'] as const) op(text, () => {
    const operand = text === 'ustroke' ? readPsUserPathOperand(vm) : { value: vm.peek(), count: 1, matrix: undefined };
    executePsUserPath(vm, graphics, operand.value, { preserve: true, complete: () => {
      const matrix = graphics.state.ctm;
      try {
        if (operand.matrix) graphics.state.ctm = mul(operand.matrix, matrix);
        graphics.paint(text === 'ufill' ? 'fill' : text === 'ueofill' ? 'eofill' : 'stroke');
      } finally { graphics.state.ctm = matrix; }
    } });
    vm.replace(operand.count);
  });
  op('showpage', () => graphics.showPage());
  op('copypage', () => graphics.showPage(true));
  op('erasepage', () => graphics.erasePage());
  op('nulldevice', () => graphics.nullDevice());
  op('currentpagedevice', () => {
    const box = graphics.defaultBox;
    const dict = vm.memory.dictionary(1);
    const size = vm.memory.arrayFrom([real(box[2] - box[0]), real(box[3] - box[1])]);
    vm.memory.put(dict, name('PageSize'), vm.memory.restrictAccess(size, 'readonly'));
    vm.push(vm.memory.restrictAccess(dict, 'readonly'));
  });
  op('setpagedevice', () => {
    const dictionary = vm.typed('dictionary');
    let size: [number, number] | undefined;
    for (const [key, value] of vm.memory.entries(dictionary)) {
      if (key.kind !== 'name' || key.text !== 'PageSize')
        throw new UnsupportedFeatureError('PostScript page-device parameter is unsupported');
      if (value.kind !== 'array') throw new PsFault('typecheck');
      if (value.length !== 2) throw new PsFault('rangecheck');
      const width = vm.memory.get(value, 0), height = vm.memory.get(value, 1);
      if ((width.kind !== 'integer' && width.kind !== 'real') || (height.kind !== 'integer' && height.kind !== 'real'))
        throw new PsFault('typecheck');
      if (width.value <= 0 || height.value <= 0) throw new PsFault('rangecheck');
      size = [width.value, height.value];
    }
    if (size) graphics.setPageSize(...size);
    vm.replace(1);
  });
  return graphics;
}
