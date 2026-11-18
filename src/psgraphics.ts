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
import { inversePsMatrix } from './psmatrix.js';
import { transformPsPath, strokePsPathData } from './pspath.js';

interface SavedGraphics { state: PsState; barrier: boolean }
export interface PsCaptureOptions { mode?: 'paint' | 'measure' | 'path'; requireMetrics?: boolean; clip?: 'bbox' | 'inherit' }
export interface PsCapture {
  readonly roots: import('./psvalue.js').PsValue[];
  complete(): PsPageOutput; abort(): void;
  declareGlyphMetrics(advance: [number, number], box?: PsBox, uncolored?: boolean): void;
  collectedPath(): PsPathData;
}
const capturePaths = new WeakMap<Uint8Array, PsPathData>();

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
  private activeMode?: 'paint' | 'measure' | 'path';
  get captureMode(): 'paint' | 'measure' | 'path' | undefined { return this.activeMode; }
  get writer(): PsPdfWriter { if (!this.captures) this.syncDevice(); return this.pageWriter; }
  get uncolored(): boolean { return this.pageWriter.uncolored; }
  outputWriter(box: PsBox, uncolored = false): PsPdfWriter { return new PsPdfWriter(this.budget, box, this.counters, uncolored); }
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
      font: this.current?.font,
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
  beginCapture(box: PsBox, matrix: Matrix, uncolored: boolean, options: PsCaptureOptions = {}): PsCapture {
    this.budget.depth(this.captures + 1, 'paint capture');
    const state = copyPsState(this.current, this.budget);
    const inverse = inversePsMatrix(matrix), parentMode = this.activeMode, mode = options.mode ?? parentMode;
    let writerBox = box;
    if (options.clip === 'inherit') {
      const b = state.deviceBox, points = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => apply(inverse, x!, y!));
      writerBox = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
    }
    const writer = new PsPdfWriter(this.budget, writerBox, this.counters, uncolored || this.uncolored, matrix);
    // The caller clips text to its device box; baking that box into a glyph
    // makes the completed glyph depend on its placement.
    if (options.clip === 'inherit') writer.clipToBox = false;
    state.ctm = [...matrix]; state.defaultMatrix = [...matrix]; state.path = { segments: [] };
    const points = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
      .map(([x, y]) => apply(matrix, x!, y!));
    if (!points.flat().every(Number.isFinite)) throw new PsFault('undefinedresult');
    if (options.clip !== 'inherit') state.clips = [{ path: psPathFromSegments([
      { op: 'M', x: points[0]![0], y: points[0]![1] },
      ...points.slice(1).map(([x, y]) => ({ op: 'L' as const, x, y })), { op: 'Z' },
    ]), evenOdd: false }];
    state.clipSaves = [];
    const initial = copyPsState(state, this.budget);
    this.budget.allocate(32, 'capture graphics stack');
    const parent = this.pageWriter, parentState = this.current, parentStates = this.states;
    const roots: import('./psvalue.js').PsValue[] = [];
    const retain = (value: import('./psvalue.js').PsValue): void => { this.budget.allocate(16, 'capture root'); roots.push(value); };
    visitPsStateRoots(parentState, retain);
    for (const entry of parentStates) { this.budget.work(); visitPsStateRoots(entry.state, retain); }
    const collected: PsPathData = { segments: [] };
    let marked = false, declared = false;
    const include = (x: number, y: number): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PsFault('undefinedresult');
      if (!collected.bbox) collected.bbox = [x, y, x, y];
      else { const b = collected.bbox; b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    };
    const append = (path: PsPathData): void => {
      const local = transformPsPath(path, inverse, this.budget);
      this.budget.items(collected.segments.length + local.segments.length, 'captured glyph path'); this.budget.allocate(local.segments.length * 16, 'captured path entries');
      for (const s of local.segments) { this.budget.work(); collected.segments.push(s); if (s.op !== 'Z') { include(s.x, s.y); if (s.op === 'C') { include(s.x1, s.y1); include(s.x2, s.y2); } } }
    };
    const includeBox = (b: PsBox, by: Matrix): void => {
      for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) { const p = apply(mul(by, inverse), x!, y!); include(p[0], p[1]); }
    };
    if (mode) {
      writer.suppressMarks = mode !== 'paint';
      writer.beforeMark = () => { if (options.requireMetrics && !declared) throw new PsFault('undefined'); marked = true; };
      writer.observePath = (path, state, paint) => append(paint === 'stroke' ? strokePsPathData(path, state, this.budget) : path);
      writer.observeImage = by => includeBox([0, 0, 1, 1], by);
      writer.observeForm = (form, by) => {
        const path = capturePaths.get(form.raw);
        if (path) append(transformPsPath(path, by, this.budget));
        const b = form.dict.get('BBox'); if (Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number')) includeBox(b as PsBox, by);
      };
      writer.observeText = (glyph, by) => { if (glyph.path) append(transformPsPath(glyph.path, by, this.budget)); if (glyph.box) includeBox(glyph.box, by); };
    }
    this.pageWriter = writer; this.current = state;
    this.activeMode = mode;
    this.states = [{ state: initial, barrier: true }]; this.captures++;
    let active = true;
    const abort = (): void => {
      if (active) {
        this.pageWriter = parent; this.current = parentState; this.states = parentStates;
        this.activeMode = parentMode;
        this.captures--; active = false;
      }
    };
    return { abort, roots,
      declareGlyphMetrics: (_advance, bounds, noColor) => {
        if (!active || declared || marked) throw new PsFault('undefined');
        if (bounds && (bounds[2] < bounds[0] || bounds[3] < bounds[1])) throw new PsFault('rangecheck');
        if (bounds) {
          const path = psPathFromSegments(psRectangleSegments([bounds], matrix, this.budget));
          this.budget.allocate(64, 'glyph cache clips');
          this.current.clips.push({ path, evenOdd: false }); initial.clips.push({ path, evenOdd: false });
        }
        writer.uncolored ||= !!noColor; declared = true;
      },
      collectedPath: () => collected,
      complete: () => {
        if (options.requireMetrics && !declared) throw new PsFault('undefined');
        const output = writer.finish(); if (mode) capturePaths.set(output.content, collected); abort(); return output;
      },
    };
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
