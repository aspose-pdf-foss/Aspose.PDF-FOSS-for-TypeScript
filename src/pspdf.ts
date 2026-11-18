import type { Document } from './document.js';
import type { Page } from './page.js';
import { PageFormat } from './pageformat.js';
import { PsBudget } from './psbudget.js';
import type { PsBox, PsPathData, PsState } from './psstate.js';
import type { Matrix } from './text.js';
import { IDENTITY, mul } from './text.js';
import { inversePsMatrix } from './psmatrix.js';
import { psPathFromSegments, psRectangleSegments, transformPsPath } from './pspath.js';
import { PsFault } from './psvalue.js';
import { psDevicePaint } from './pscolor.js';
import { PdfParseError } from './errors.js';
import { serializeValue } from './serialize.js';
import { name, isArray, isDict, isName, isRef, isStream, isString,
  type PdfObject, type PdfDict, type PdfStream } from './types.js';
import type { PsPdfGlyph } from './psfontpdf.js';

export interface PsPageOutput { box: PsBox; content: Uint8Array; resources: PdfDict }
export interface PsOutputCounters { bytes: number; tokens: number }
const owners = new WeakMap<PsPageOutput, PsBudget>();

export class PsPdfWriter {
  beforeMark?: () => void;
  observePath?: (path: PsPathData, state: PsState, mode: 'fill' | 'eofill' | 'stroke') => void;
  observeImage?: (matrix: Matrix) => void;
  observeForm?: (form: PdfStream, matrix: Matrix) => void;
  observeText?: (glyph: PsPdfGlyph, matrix: Matrix) => void;
  suppressMarks = false;
  clipToBox = true;
  private readonly parts: string[] = [];
  private length = 0;
  private readonly resources: PdfDict = new Map();
  private readonly resourceNames = new Map<string, Map<PdfObject, string>>();
  private readonly paintStates = new Map<string, PdfDict>();
  private readonly patternCopies = new Map<PdfStream, PdfStream>();
  private readonly inverseBasis: Matrix;
  private cached?: PsPageOutput;
  hasMarks = false;

  constructor(readonly budget: PsBudget, readonly box: PsBox,
    private readonly counters: PsOutputCounters = { bytes: 0, tokens: 0 },
    public uncolored = false, readonly basis: Matrix = IDENTITY) {
    budget.allocate(192, 'PDF output writer');
    this.inverseBasis = inversePsMatrix(basis);
  }

  private localPath(path: PsPathData): PsPathData {
    return this.basis.every((value, i) => value === IDENTITY[i]) ? path : transformPsPath(path, this.inverseBasis, this.budget);
  }

  emit(operator: string, operands: readonly PdfObject[] = []): void {
    const pieces: string[] = [];
    let length = 0;
    const append = (text: string, token = false): void => {
      if (token) this.budget.limits.enforce('maxContentTokens', this.counters.tokens + 1, 'PostScript output');
      this.budget.limits.enforce('maxContentBytes', this.counters.bytes + text.length, 'PostScript output');
      this.budget.work(text.length, 'PDF serialization');
      this.budget.allocate(32 + text.length * 2, 'PDF token');
      if (token) this.counters.tokens++;
      this.counters.bytes += text.length;
      length += text.length;
      pieces.push(text);
    };
    type Action = { value: PdfObject; depth: number } | { text: string; end?: object };
    this.budget.items(operands.length, 'PDF operands');
    this.budget.allocate(operands.length * 32, 'PDF operand traversal');
    const pending: Action[] = [];
    const active = new Set<object>();
    for (let i = operands.length - 1; i >= 0; i--) pending.push({ value: operands[i]!, depth: 0 });
    while (pending.length) {
      this.budget.work();
      const action = pending.pop()!;
      if ('text' in action) {
        append(action.text, action.end !== undefined);
        if (action.end) active.delete(action.end);
        continue;
      }
      const value = action.value;
      this.budget.depth(action.depth, 'PDF operand nesting');
      if (isArray(value) || isDict(value)) {
        if (active.has(value)) throw new PdfParseError('Cyclic PostScript PDF operand');
        const count = isArray(value) ? value.length : value.size;
        this.budget.items(count, 'PDF operand container');
        this.budget.allocate(64 + count * 64, 'PDF operand traversal');
        active.add(value);
        append(isArray(value) ? '[ ' : '<< ', true);
        pending.push({ text: isArray(value) ? '] ' : '>> ', end: value });
        if (isArray(value)) {
          for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value[i]!, depth: action.depth + 1 });
        } else {
          const entries = [...value];
          for (let i = entries.length - 1; i >= 0; i--) {
            const [key, item] = entries[i]!;
            pending.push({ value: item, depth: action.depth + 1 });
            pending.push({ value: name(key), depth: action.depth + 1 });
          }
        }
      } else if (isString(value)) {
        this.budget.limits.enforce('maxObjectBytes', value.bytes.length, 'PDF string');
        this.budget.allocate(value.bytes.length * 4 + 4, 'PDF string serialization');
        this.budget.work(value.bytes.length, 'PDF string serialization');
        let text = '<';
        for (const byte of value.bytes) text += byte.toString(16).padStart(2, '0');
        append(text + '> ', true);
      } else {
        if (isStream(value)) throw new TypeError('A PDF stream must be installed as a resource');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new PsFault('undefinedresult');
        if (isName(value)) {
          this.budget.limits.enforce('maxObjectBytes', value.name.length, 'PDF name');
          this.budget.allocate(value.name.length * 10, 'PDF name serialization');
          this.budget.work(value.name.length, 'PDF name serialization');
        }
        append(serializeValue(value) + ' ', true);
      }
    }
    append(operator, true);
    append('\n');
    this.budget.allocate(length * 2 + 16, 'PDF operator buffer');
    const text = pieces.join('');
    this.parts.push(text);
    this.length += length;
    this.cached = undefined;
  }

  transaction(operation: () => void): void {
    this.budget.allocate(64 + this.resourceNames.size * 32, 'PDF resource transaction');
    this.budget.work(this.resourceNames.size);
    const resourceCounts = new Map<string, number>();
    for (const [category, names] of this.resourceNames) resourceCounts.set(category, names.size);
    const count = this.parts.length, length = this.length, cached = this.cached, marks = this.hasMarks;
    let committed = false;
    try { operation(); committed = true; }
    finally {
      if (!committed) {
        this.parts.length = count; this.length = length; this.cached = cached; this.hasMarks = marks;
        for (const [category, names] of this.resourceNames) {
          const keep = resourceCounts.get(category);
          if (keep === undefined) { this.resourceNames.delete(category); this.resources.delete(category); }
          else {
            let i = 0;
            for (const [object, key] of names) if (i++ >= keep) { names.delete(object); (this.resources.get(category) as PdfDict).delete(key); }
          }
        }
      }
    }
  }

  resource(category: string, object: PdfObject): string {
    let names = this.resourceNames.get(category);
    const existing = names?.get(object);
    if (existing !== undefined) return existing;
    this.budget.items((names?.size ?? 0) + 1, 'PDF resources');
    this.budget.allocate(128, 'PDF resource entry');
    this.budget.work();
    if (!names) {
      this.budget.items(this.resources.size + 1, 'PDF resource categories');
      names = new Map();
      this.resourceNames.set(category, names);
      this.resources.set(category, new Map());
    }
    const key = `R${names.size}`;
    names.set(object, key);
    (this.resources.get(category) as PdfDict).set(key, object);
    this.cached = undefined;
    return key;
  }

  writePath(path: PsPathData): void {
    for (const segment of path.segments) {
      this.budget.work();
      if (segment.op === 'Z') this.emit('h');
      else if (segment.op === 'C') this.emit('c', [segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y]);
      else this.emit(segment.op === 'M' ? 'm' : 'l', [segment.x, segment.y]);
    }
  }

  writeClips(state: PsState): void {
    const [x0, y0, x1, y1] = this.box;
    if (this.clipToBox) { this.emit('re', [x0, y0, x1 - x0, y1 - y0]);
      this.emit('W'); this.emit('n'); }
    for (const clip of state.clips) {
      this.writePath(this.localPath(clip.path));
      this.emit(clip.evenOdd ? 'W*' : 'W');
      this.emit('n');
    }
  }

  paintState(state: PsState, stroke: boolean): void {
    if (!this.uncolored) {
      if (state.color.space === 'Pattern') {
        const pattern = state.color.resource;
        if (!pattern) throw new PsFault('undefinedresult');
        let local = this.basis.every((value, i) => value === IDENTITY[i]) ? pattern : this.patternCopies.get(pattern);
        if (!local) {
          this.budget.allocate(256, 'pattern coordinate binding');
          const matrix = pattern.dict.get('Matrix') as Matrix;
          local = { ...pattern, dict: new Map(pattern.dict) };
          local.dict.set('Matrix', mul(matrix, this.inverseBasis));
          this.patternCopies.set(pattern, local);
        }
        const base = pattern.dict.get('PaintType') === 2 && state.color.base ? psDevicePaint(state.color.base) : undefined;
        const space = base ? name(this.resource('ColorSpace', [name('Pattern'), name(base.space)])) : name('Pattern');
        this.emit(stroke ? 'CS' : 'cs', [space]);
        this.emit(stroke ? 'SCN' : 'scn', [...(base?.components ?? []), name(this.resource('Pattern', local))]);
      } else {
        const color = psDevicePaint(state.color);
        const operator = color.space === 'DeviceGray' ? 'g' : color.space === 'DeviceCMYK' ? 'k' : 'rg';
        this.emit(stroke ? operator.toUpperCase() : operator, color.components);
      }
    }
    if (state.overprint || state.strokeAdjust) {
      const key = `${state.overprint}:${state.strokeAdjust}`;
      let dict = this.paintStates.get(key);
      if (!dict) {
        this.budget.allocate(320, 'PDF paint graphics state');
        dict = new Map<string, PdfObject>([['Type', name('ExtGState')], ['OP', state.overprint],
          ['op', state.overprint], ['SA', state.strokeAdjust]]);
        this.paintStates.set(key, dict);
      }
      this.emit('gs', [name(this.resource('ExtGState', dict))]);
    }
    if (stroke) {
      this.emit('w', [state.line.width]); this.emit('J', [state.line.cap]);
      this.emit('j', [state.line.join]); this.emit('M', [state.line.miter]);
      this.emit('d', [state.line.dash, state.line.dashPhase]);
    }
  }

  paintPath(path: PsPathData, state: PsState, mode: 'fill' | 'eofill' | 'stroke'): void {
    if (!path.segments.length) return;
    this.beforeMark?.(); this.observePath?.(path, state, mode); if (this.suppressMarks) return;
    if (state.color.space !== 'Pattern' && psDevicePaint(state.color).none) return;
    const stroke = mode === 'stroke';
    const geometry = stroke ? transformPsPath(path, inversePsMatrix(state.ctm), this.budget) : this.localPath(path);
    this.transaction(() => {
      this.emit('q');
      this.writeClips(state);
      if (stroke) this.emit('cm', mul(state.ctm, this.inverseBasis));
      this.paintState(state, stroke);
      this.writePath(geometry);
      this.emit(stroke ? 'S' : mode === 'eofill' ? 'f*' : 'f');
      this.emit('Q');
      this.hasMarks = true;
    });
  }

  drawImage(image: PdfStream, matrix: Matrix, state: PsState): void {
    this.beforeMark?.(); this.observeImage?.(matrix); if (this.suppressMarks) return;
    if (image.dict.get('ImageMask') === true && state.color.space !== 'Pattern' && psDevicePaint(state.color).none) return;
    this.transaction(() => {
      this.emit('q'); this.writeClips(state);
      if (image.dict.get('ImageMask') === true) this.paintState(state, false);
      this.emit('cm', mul(matrix, this.inverseBasis));
      this.emit('Do', [name(this.resource('XObject', image))]);
      this.emit('Q'); this.hasMarks = true;
    });
  }

  drawForm(form: PdfStream, matrix: Matrix, state: PsState): void {
    this.beforeMark?.(); this.observeForm?.(form, matrix); if (this.suppressMarks) return;
    this.transaction(() => {
      this.emit('q'); this.writeClips(state);
      this.emit('cm', mul(matrix, this.inverseBasis));
      this.emit('Do', [name(this.resource('XObject', form))]);
      this.emit('Q'); this.hasMarks = true;
    });
  }

  drawText(glyph: PsPdfGlyph, glyphToDevice: Matrix, state: PsState): void {
    this.beforeMark?.(); this.observeText?.(glyph, glyphToDevice); if (this.suppressMarks) return;
    if (state.color.space !== 'Pattern' && psDevicePaint(state.color).none) return;
    const matrix = mul(mul(inversePsMatrix(glyph.fontMatrix), glyphToDevice), this.inverseBasis);
    this.transaction(() => {
      this.emit('q'); this.writeClips(state); this.paintState(state, false);
      this.emit('BT'); this.emit('Tf', [name(this.resource('Font', glyph.font)), 1]);
      this.emit('Tm', matrix); this.emit('Tj', [{ kind: 'string', bytes: Uint8Array.of(glyph.code) }]);
      this.emit('ET'); this.emit('Q'); this.hasMarks = true;
    });
  }

  finish(): PsPageOutput {
    if (this.cached) return this.cached;
    this.budget.allocate(this.length * 3 + 128 + this.resources.size * 32, 'PDF output snapshot');
    this.budget.work(this.length, 'PDF output snapshot');
    const resources: PdfDict = new Map();
    for (const [category, value] of this.resources) {
      if (!isDict(value)) throw new TypeError('Invalid PDF resource category');
      this.budget.work(value.size, 'PDF resource snapshot');
      this.budget.allocate(value.size * 64, 'PDF resource snapshot');
      resources.set(category, new Map(value));
    }
    const result: PsPageOutput = { box: [...this.box], content: new TextEncoder().encode(this.parts.join('')), resources };
    owners.set(result, this.budget);
    this.cached = result;
    return result;
  }
}

function installResources(doc: Document, object: PdfObject, budget: PsBudget,
  streams: Map<object, PdfObject>): PdfObject {
  let result: PdfObject = null;
  type Job = { value: PdfObject; set: (value: PdfObject) => void; depth: number } | { end: object };
  const pending: Job[] = [{ value: object, set: value => { result = value; }, depth: 0 }];
  const copies = new Map<object, PdfObject>();
  const active = new Set<object>();
  while (pending.length) {
    budget.work();
    const job = pending.pop()!;
    if ('end' in job) { active.delete(job.end); continue; }
    const value = job.value;
    budget.depth(job.depth, 'PDF resource installation');
    if (!isArray(value) && !isDict(value) && !isStream(value)) { job.set(value); continue; }
    if (active.has(value)) throw new PdfParseError('Cyclic direct PostScript PDF resource');
    const previous = isStream(value) ? streams.get(value) : copies.get(value);
    if (previous !== undefined) { job.set(previous); continue; }
    const stream = isStream(value);
    const source = stream ? value.dict : value;
    const length = isArray(source) ? source.length : source.size;
    budget.items(length, 'PDF resource container');
    budget.allocate(128 + length * 64, 'PDF resource installation');
    const target: PdfObject = isArray(source) ? [] : new Map();
    if (stream) {
      const reference = doc.allocObject({ kind: 'stream', dict: target as PdfDict, raw: value.raw });
      streams.set(value, reference);
      job.set(reference);
    } else { copies.set(value, target); job.set(target); }
    active.add(value);
    pending.push({ end: value });
    if (isArray(source)) {
      const array = target as PdfObject[];
      for (let i = source.length - 1; i >= 0; i--) {
        const index = i;
        pending.push({ value: source[i]!, depth: job.depth + 1, set: item => { array[index] = item; } });
      }
    } else {
      const dict = target as PdfDict;
      for (const [key, item] of source) pending.push({ value: item, depth: job.depth + 1, set: child => { dict.set(key, child); } });
    }
  }
  return result;
}

export function appendPsPages(doc: Document, pages: readonly PsPageOutput[]): Page[] {
  for (const page of pages) {
    const b = page.box;
    if (b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]
      || !Number.isFinite(b[2] - b[0]) || !Number.isFinite(b[3] - b[1]))
      throw new TypeError('PostScript page dimensions must be positive and finite');
  }
  const result: Page[] = [];
  const prepared: { output: PsPageOutput; resources: PdfObject; content: PdfObject }[] = [];
  const streams = new Map<object, PdfObject>();
  const contents = new Map<Uint8Array, PdfObject>();
  for (const output of pages) {
    const budget = owners.get(output) ?? new PsBudget(doc.loadLimits);
    budget.allocate(512, 'PDF page installation');
    const resources = installResources(doc, output.resources, budget, streams);
    let content = contents.get(output.content);
    if (!content) {
      budget.allocate(64, 'PDF content installation');
      content = doc.allocObject({ kind: 'stream', dict: new Map(), raw: output.content });
      contents.set(output.content, content);
    }
    budget.allocate(64, 'prepared PDF page');
    prepared.push({ output, resources, content });
  }
  for (const { output, resources, content } of prepared) {
    const [x0, y0, x1, y1] = output.box;
    const page = doc.AddPage(PageFormat.custom(x1 - x0, y1 - y0)).page;
    page.Dict.set('MediaBox', [...output.box]);
    page.Dict.set('Resources', resources);
    page.Dict.set('Contents', content);
    result.push(page);
  }
  return result;
}
