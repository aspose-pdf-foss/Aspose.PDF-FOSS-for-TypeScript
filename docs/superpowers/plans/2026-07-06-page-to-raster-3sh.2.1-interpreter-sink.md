# 3sh.2.1 — Interpreter/Sink Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the content-stream interpreter out of `svgrender.ts` into a new `pagerender.ts` that drives a pluggable `RenderSink`, and reimplement the SVG output as an `SvgSink`, so a future `RasterSink` (3sh.2.2+) can reuse the exact same interpreter.

**Architecture:** `pagerender.ts` owns the graphics-state machine (q/Q, CTM, color, line style, text, path construction as structured segments, form-XObject recursion, image/shading dispatch) and emits to a `RenderSink` interface. `svgrender.ts` keeps `renderPageToSvg` but delegates all emission to an `SvgSink implements RenderSink` that serializes structured paths back to SVG. No user-visible behavior change: rendered SVG is visually identical and the existing attribute-regex tests stay green.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import specifiers), vitest, node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { Page } from './page.js'`).
- **`strict` TypeScript** — `npm run typecheck` must pass.
- **Errors** — throw `PdfParseError` / `UnsupportedFeatureError` from `errors.ts` where a helper must signal; but the public render entry points catch and degrade (never throw).
- **Tests** — vitest; fixtures built programmatically in `test/helpers/`. `npm test` must be green before closing the issue.

---

## Context: what exists today

`src/svgrender.ts` is a single ~530-line module. `renderPageToSvg(doc, page, opts)` builds a base matrix via `baseMatrix(page, box)`, then `interpret()` → `walk()` runs the content-stream ops, emitting SVG strings directly into an `SvgWriter`. Path data is built as an SVG `d` string during construction; clipping is expressed as nested `<g clip-path>` groups driven by a `groupDepth`/`groupStack`; text is emitted as `<text>` (via `showText`); images as `<image>` data URIs; shadings as `<defs>` gradients.

The existing tests (`test/svgrender.test.ts`) assert **attributes and structure via regex** — e.g. `fill-rule="evenodd"`, `stroke-dasharray="6 3"`, `<g clip-path="url(#clip\d+)">`, balanced `<g>`/`</g>`, `transform="matrix(1 0 0 1 72 100)"`. **No test asserts an exact `d` string.** This gives latitude: the refactor may change the *form* of `d` (absolute `M/L/C/Z` instead of the current mix of relative `h/v` and smooth `S`) as long as geometry is equivalent and attributes/structure are preserved.

Read these before starting: `src/svgrender.ts` (whole file), `src/font.ts:59-83` (`decodeRun` returns `{ text, width, ncodes, nWordSpaces }`), `test/svgrender.test.ts`, `test/helpers/build-svg-fixtures.ts`.

## File Structure

- **Create `src/pagerender.ts`** — the shared interpreter + `RenderSink` interface + geometry types + `baseMatrix` (moved here as pure geometry) + shared resolution helpers. ~360 lines.
- **Rewrite `src/svgrender.ts`** — keep `renderPageToSvg`, `SvgWriter`, `fmt`, `escapeXml`, `matrixAttr`; add `SvgSink implements RenderSink`; delete the old `walk`/`interpret`/`drawForm`/`showText`/`paintShading`/`drawImage` (their logic moves: geometry+state to `pagerender.ts`, SVG emission into `SvgSink`). Import `interpret`, `baseMatrix`, and the geometry types from `pagerender.ts`.
- **Create `test/pagerender.test.ts`** — a recording-sink test that locks the interpreter→sink contract for later raster phases.
- **`src/page.ts`** — unchanged (`ToSvg` still calls `renderPageToSvg`).

---

## Task 1: Create `pagerender.ts` — interpreter + sink interface

**Files:**
- Create: `src/pagerender.ts`
- Test: `test/pagerender.test.ts`

**Interfaces:**
- Produces (consumed by Task 2 and by raster phases 3sh.2.2+):
  - `type Seg = { op:'M'|'L'; x:number; y:number } | { op:'C'; x1,y1,x2,y2,x,y:number } | { op:'Z' }`
  - `type Path = Seg[]`
  - `interface StrokeStyle { width:number; cap:number; join:number; miter:number; dash:number[] }`
  - `interface TextRunInfo { font:TextFont; decoded:{text:string;width:number;ncodes:number;nWordSpaces:number}; tm:Matrix; ctm:Matrix; rise:number; fontSize:number; fontFamily:string; bold:boolean; italic:boolean; color:Rgb }`
  - `interface RenderSink { save():void; restore():void; addClip(path:Path,ctm:Matrix,evenOdd:boolean):void; fill(path:Path,ctm:Matrix,color:Rgb,evenOdd:boolean):void; stroke(path:Path,ctm:Matrix,color:Rgb,style:StrokeStyle):void; image(stream:PdfStream,ctm:Matrix,fillColor:Rgb):void; glyphRun(info:TextRunInfo):void; shading(dict:PdfDict,ctm:Matrix):void }`
  - `function interpret(doc:Document, page:Page, base:Matrix, sink:RenderSink): void`
  - `function baseMatrix(page:Page, box:'crop'|'media'): { matrix:Matrix; width:number; height:number }`
  - `function arrNums(doc:Document, o:PdfObject|undefined): number[]`

- [ ] **Step 1: Write the failing test**

Create `test/pagerender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { interpret, baseMatrix, RenderSink, Path, Matrix, StrokeStyle, TextRunInfo } from '../src/pagerender.js';
import { buildSvgPdf, VECTOR_CONTENT, HELV_RESOURCES, TEXT_CONTENT } from './helpers/build-svg-fixtures.js';

/** A sink that records which primitives the interpreter emits. */
class RecordingSink implements RenderSink {
  fills = 0; strokes = 0; clips = 0; glyphRuns: string[] = []; saves = 0; restores = 0;
  save() { this.saves++; }
  restore() { this.restores++; }
  addClip(_p: Path, _m: Matrix, _e: boolean) { this.clips++; }
  fill() { this.fills++; }
  stroke() { this.strokes++; }
  image() {}
  glyphRun(info: TextRunInfo) { this.glyphRuns.push(info.decoded.text); }
  shading() {}
}

describe('pagerender.interpret drives a RenderSink', () => {
  it('emits fill and stroke for a vector page', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: VECTOR_CONTENT }));
    const page = doc.Pages[0];
    const { matrix } = baseMatrix(page, 'crop');
    const sink = new RecordingSink();
    interpret(doc, page, matrix, sink);
    expect(sink.fills).toBeGreaterThan(0);
    expect(sink.strokes).toBeGreaterThan(0);
    expect(sink.saves).toBe(sink.restores); // balanced scope
  });

  it('emits a glyph run carrying decoded text', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT }));
    const page = doc.Pages[0];
    const { matrix } = baseMatrix(page, 'crop');
    const sink = new RecordingSink();
    interpret(doc, page, matrix, sink);
    expect(sink.glyphRuns.join('')).toContain('Hi');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pagerender.test.ts`
Expected: FAIL — `Cannot find module '../src/pagerender.js'`.

- [ ] **Step 3: Create `src/pagerender.ts`**

Write the full module. This is ported verbatim from `svgrender.ts`'s current `walk`/`interpret`/`drawForm`/`showText`/`showArray` with two mechanical changes: (a) path is a structured `Path` (absolute `M/L/C/Z`) instead of an SVG `d` string, and (b) every emission becomes a `sink.*` call. Save/restore bracket each `walk` so clips left open at end-of-stream close exactly as before.

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul, translate, IDENTITY } from './text.js';
import { PdfDict, PdfObject, isName, isArray, isStream, isDict, isString, PdfStream } from './types.js';
import { parseContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, Rgb, ColorConverter } from './colorspace.js';
import { TextFont } from './font.js';

export { Matrix } from './text.js';
export type { Rgb } from './colorspace.js';

// ---------- Geometry (structured path, user space) ----------

export type Seg =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };
/** A whole current-path: subpaths delimited by `M`, closed by `Z`. */
export type Path = Seg[];

export interface StrokeStyle {
  width: number; cap: number; join: number; miter: number; dash: number[];
}

export interface TextRunInfo {
  font: TextFont;
  decoded: { text: string; width: number; ncodes: number; nWordSpaces: number };
  tm: Matrix; ctm: Matrix; rise: number;
  fontSize: number; fontFamily: string; bold: boolean; italic: boolean; color: Rgb;
}

/** Backend that turns interpreted graphics ops into output (SVG or raster). */
export interface RenderSink {
  save(): void;                                                    // q
  restore(): void;                                                 // Q
  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void;        // W/W* consumed at next paint
  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void;
  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void;
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void;
  glyphRun(info: TextRunInfo): void;
  shading(dict: PdfDict, ctm: Matrix): void;
}

// ---------- Base matrix (pure geometry; moved from svgrender) ----------

/** The PDF-user-space → device-pixel base matrix, plus the output size.
 *  Flips Y (PDF up → down), offsets by the box origin, applies /Rotate. */
export function baseMatrix(page: Page, box: 'crop' | 'media'): { matrix: Matrix; width: number; height: number } {
  const b = box === 'media' ? page.MediaBox : page.CropBox;
  const [x0, y0, x1, y1] = b;
  const w0 = Math.abs(x1 - x0); const h0 = Math.abs(y1 - y0);
  const flip: Matrix = [1, 0, 0, -1, -Math.min(x0, x1), Math.max(y0, y1)];
  const rot = ((page.Rotate % 360) + 360) % 360;
  let r: Matrix;
  let width = w0; let height = h0;
  switch (rot) {
    case 90:  r = [0, 1, -1, 0, h0, 0];  width = h0; height = w0; break;
    case 180: r = [-1, 0, 0, -1, w0, h0]; break;
    case 270: r = [0, -1, 1, 0, 0, w0];  width = h0; height = w0; break;
    default:  r = [1, 0, 0, 1, 0, 0];
  }
  return { matrix: mul(flip, r), width, height };
}

// ---------- Graphics state ----------

interface GState {
  ctm: Matrix;
  fill: Rgb; stroke: Rgb;
  fillCs: ColorConverter; strokeCs: ColorConverter;
  lineWidth: number; dash: number[]; cap: number; join: number; miter: number;
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
  fontSize: number; fontFamily: string; fontBold: boolean; fontItalic: boolean;
  fontRef?: PdfDict; font?: TextFont;
  tm: Matrix; tlm: Matrix;
}

function initialState(base: Matrix): GState {
  return {
    ctm: base, fill: [0, 0, 0], stroke: [0, 0, 0],
    fillCs: deviceGray(), strokeCs: deviceGray(),
    lineWidth: 1, dash: [], cap: 0, join: 0, miter: 10,
    charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0,
    fontSize: 0, fontFamily: 'sans-serif', fontBold: false, fontItalic: false,
    tm: IDENTITY, tlm: IDENTITY,
  };
}
function deviceGray(): ColorConverter {
  return { components: 1, toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; }, initial: () => [0, 0, 0] };
}
function clone(s: GState): GState { return { ...s }; }
function strokeStyle(gs: GState): StrokeStyle {
  return { width: gs.lineWidth, cap: gs.cap, join: gs.join, miter: gs.miter, dash: gs.dash };
}

function num(o: PdfObject | undefined): number { return typeof o === 'number' ? o : 0; }
function numbers(a: PdfObject[]): number[] { return a.filter((x): x is number => typeof x === 'number'); }

// ---------- Resolution helpers ----------

interface RenderCtx {
  doc: Document; sink: RenderSink;
  resources: PdfDict | undefined;
  depth: number; seen: Set<PdfDict>;
}

function resDict(ctx: RenderCtx, category: string): PdfDict | undefined {
  const r0 = ctx.doc.resolve(ctx.resources?.get(category));
  return isDict(r0) ? r0 : undefined;
}
function r(ctx: RenderCtx) { return (o: PdfObject | undefined) => ctx.doc.resolve(o); }
function inf(_ctx: RenderCtx) { return (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]); }
function nm(name: string): PdfObject { return { kind: 'name', name }; }

function lookupCs(ctx: RenderCtx, operand: PdfObject | undefined): ColorConverter {
  if (isName(operand)) {
    const direct = ['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK'];
    if (direct.includes(operand.name)) return resolveColorSpace(operand, r(ctx), inf(ctx));
    const csDict = resDict(ctx, 'ColorSpace');
    const entry = csDict?.get(operand.name);
    if (entry !== undefined) return resolveColorSpace(entry, r(ctx), inf(ctx));
  }
  return deviceGray();
}

/** Resolve `o` to a flat array of numbers (dereferencing element refs). */
export function arrNums(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  return isArray(a) ? a.map((x) => doc.resolve(x)).filter((x): x is number => typeof x === 'number') : [];
}

// ---------- Entry point ----------

/** Walk the page content under the base CTM, driving `sink`. Never throws here;
 *  callers (renderPageToSvg / renderPageToPng) wrap with degrade-on-error. */
export function interpret(doc: Document, page: Page, base: Matrix, sink: RenderSink): void {
  const ctx: RenderCtx = { doc, sink, resources: page.Resources, depth: 0, seen: new Set() };
  walk(ctx, page.Contents, initialState(base));
}

const MAX_XOBJECT_DEPTH = 8;

function walk(ctx: RenderCtx, bytes: Uint8Array, initial: GState): void {
  const sink = ctx.sink;
  const ops = parseContentStream(bytes);
  const gsStack: GState[] = [];
  let gs = initial;
  const fontCache = new Map<PdfDict, TextFont>();

  sink.save();                 // walk scope: auto-closes clips left open at stream end
  let localSaves = 0;          // explicit q count within this walk

  let pendingClip: { path: Path; evenOdd: boolean } | undefined;

  let path: Path = [];
  let started = false;
  let cx = 0, cy = 0;          // current point (for v/re; y needs no current point)
  const resetPath = () => { path = []; started = false; };

  const flushClip = () => {
    if (pendingClip) { sink.addClip(pendingClip.path, gs.ctm, pendingClip.evenOdd); pendingClip = undefined; }
  };
  const doFill = (evenOdd: boolean) => { flushClip(); if (path.length) sink.fill(path, gs.ctm, gs.fill, evenOdd); };
  const doStroke = () => { flushClip(); if (path.length) sink.stroke(path, gs.ctm, gs.stroke, strokeStyle(gs)); };

  for (const op of ops) {
    const o = op.operands;
    switch (op.operator) {
      case 'q': gsStack.push(clone(gs)); sink.save(); localSaves++; break;
      case 'Q': gs = gsStack.pop() ?? gs; if (localSaves > 0) { sink.restore(); localSaves--; } break;
      case 'cm': { const m = numbers(o); if (m.length === 6) gs.ctm = mul(m as Matrix, gs.ctm); break; }

      // path construction (user space, absolute segments)
      case 'm': { const [x, y] = numbers(o); path.push({ op: 'M', x, y }); cx = x; cy = y; started = true; break; }
      case 'l': { const [x, y] = numbers(o); if (started) { path.push({ op: 'L', x, y }); cx = x; cy = y; } break; }
      case 'c': { const n = numbers(o); if (n.length === 6) { path.push({ op: 'C', x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[4], y: n[5] }); cx = n[4]; cy = n[5]; } break; }
      case 'v': { const n = numbers(o); if (n.length === 4) { path.push({ op: 'C', x1: cx, y1: cy, x2: n[0], y2: n[1], x: n[2], y: n[3] }); cx = n[2]; cy = n[3]; } break; }
      case 'y': { const n = numbers(o); if (n.length === 4) { path.push({ op: 'C', x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[2], y: n[3] }); cx = n[2]; cy = n[3]; } break; }
      case 're': { const [x, y, ww, hh] = numbers(o); path.push({ op: 'M', x, y }, { op: 'L', x: x + ww, y }, { op: 'L', x: x + ww, y: y + hh }, { op: 'L', x, y: y + hh }, { op: 'Z' }); cx = x; cy = y; started = true; break; }
      case 'h': { if (started) path.push({ op: 'Z' }); break; }

      // painting
      case 'S': case 's': doStroke(); resetPath(); break;
      case 'f': case 'F': doFill(false); resetPath(); break;
      case 'f*': doFill(true); resetPath(); break;
      case 'B': case 'b': doFill(false); doStroke(); resetPath(); break;
      case 'B*': case 'b*': doFill(true); doStroke(); resetPath(); break;
      case 'n': flushClip(); resetPath(); break;

      // clipping (snapshot current path; applied at next paint)
      case 'W': pendingClip = { path: path.slice(), evenOdd: false }; break;
      case 'W*': pendingClip = { path: path.slice(), evenOdd: true }; break;

      // line style
      case 'w': gs.lineWidth = num(o[0]); break;
      case 'J': gs.cap = num(o[0]); break;
      case 'j': gs.join = num(o[0]); break;
      case 'M': gs.miter = num(o[0]); break;
      case 'd': { gs.dash = isArray(o[0]) ? numbers(o[0]) : []; break; }

      // color
      case 'g': gs.fillCs = deviceGray(); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'G': gs.strokeCs = deviceGray(); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'rg': gs.fillCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'RG': gs.strokeCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'k': gs.fillCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'K': gs.strokeCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'cs': gs.fillCs = lookupCs(ctx, o[0]); gs.fill = gs.fillCs.initial(); break;
      case 'CS': gs.strokeCs = lookupCs(ctx, o[0]); gs.stroke = gs.strokeCs.initial(); break;
      case 'sc': gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'SC': gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'scn': { if (isName(o[o.length - 1])) { gs.fill = [128, 128, 128]; break; } gs.fill = gs.fillCs.toRgb(numbers(o)); break; }
      case 'SCN': { if (isName(o[o.length - 1])) { gs.stroke = [128, 128, 128]; break; } gs.stroke = gs.strokeCs.toRgb(numbers(o)); break; }

      // text state
      case 'BT': gs.tm = IDENTITY; gs.tlm = IDENTITY; break;
      case 'ET': break;
      case 'Tc': gs.charSp = num(o[0]); break;
      case 'Tw': gs.wordSp = num(o[0]); break;
      case 'Tz': gs.hscale = (num(o[0]) / 100) || 1; break;
      case 'TL': gs.leading = num(o[0]); break;
      case 'Ts': gs.rise = num(o[0]); break;
      case 'Td': { const [tx, ty] = numbers(o); textMove(gs, tx, ty); break; }
      case 'TD': { const [tx, ty] = numbers(o); gs.leading = -ty; textMove(gs, tx, ty); break; }
      case 'Tm': { const m = numbers(o); if (m.length === 6) { gs.tlm = m as Matrix; gs.tm = m as Matrix; } break; }
      case 'T*': textMove(gs, 0, -gs.leading); break;
      case 'Tf': {
        gs.fontSize = num(o[1]);
        const fn = o[0];
        const fonts = resDict(ctx, 'Font');
        if (isName(fn) && fonts) {
          const fd = ctx.doc.resolve(fonts.get(fn.name));
          if (isDict(fd)) {
            let tf = fontCache.get(fd);
            if (!tf) { tf = new TextFont(fd, r(ctx), inf(ctx)); fontCache.set(fd, tf); }
            gs.fontRef = fd; gs.font = tf;
            applyFontStyle(gs, tf.name);
          }
        }
        break;
      }
      case 'Tj': showText(ctx, gs, o[0]); break;
      case 'TJ': showArray(ctx, gs, o[0]); break;
      case "'": textMove(gs, 0, -gs.leading); showText(ctx, gs, o[0]); break;
      case '"': gs.wordSp = num(o[0]); gs.charSp = num(o[1]); textMove(gs, 0, -gs.leading); showText(ctx, gs, o[2]); break;

      // images
      case 'BI':
        if (op.inlineImage) sink.image({ kind: 'stream', dict: op.inlineImage.dict, raw: op.inlineImage.data } as PdfStream, gs.ctm, gs.fill);
        break;
      case 'Do': {
        const xn = o[0];
        const xobjs = resDict(ctx, 'XObject');
        if (!isName(xn) || !xobjs) break;
        const xo = ctx.doc.resolve(xobjs.get(xn.name));
        if (!isStream(xo)) break;
        const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
        if (isName(sub) && sub.name === 'Image') { sink.image(xo, gs.ctm, gs.fill); break; }
        drawForm(ctx, gs, xo);
        break;
      }

      // shading
      case 'sh': {
        const shDict = resDict(ctx, 'Shading');
        const sn = o[0];
        if (isName(sn) && shDict) {
          const sh = ctx.doc.resolve(shDict.get(sn.name));
          const dict = isStream(sh) ? sh.dict : isDict(sh) ? sh : undefined;
          if (dict) { flushClip(); sink.shading(dict, gs.ctm); }
        }
        break;
      }
    }
  }

  while (localSaves > 0) { sink.restore(); localSaves--; }
  sink.restore();              // close walk scope
}

/** Recurse into a Form XObject: /Matrix∘CTM, clip to /BBox, own /Resources,
 *  depth- and cycle-guarded. Uses sink.save/addClip/restore for the BBox clip. */
function drawForm(ctx: RenderCtx, gs: GState, stream: PdfStream): void {
  if (ctx.depth >= MAX_XOBJECT_DEPTH || ctx.seen.has(stream.dict)) return;
  const bytes = inflateStream(stream as Parameters<typeof inflateStream>[0]);
  const mat = arrNums(ctx.doc, stream.dict.get('Matrix'));
  const childCtm = mat.length === 6 ? mul(mat as Matrix, gs.ctm) : gs.ctm;

  ctx.sink.save();
  const bbox = arrNums(ctx.doc, stream.dict.get('BBox'));
  if (bbox.length === 4) {
    const [x0, y0, x1, y1] = bbox;
    const clip: Path = [
      { op: 'M', x: x0, y: y0 }, { op: 'L', x: x1, y: y0 },
      { op: 'L', x: x1, y: y1 }, { op: 'L', x: x0, y: y1 }, { op: 'Z' },
    ];
    ctx.sink.addClip(clip, childCtm, false);
  }

  const childRes = ((): PdfDict | undefined => {
    const rr = ctx.doc.resolve(stream.dict.get('Resources'));
    return isDict(rr) ? rr : ctx.resources;
  })();

  ctx.seen.add(stream.dict);
  const childCtx: RenderCtx = { ...ctx, resources: childRes, depth: ctx.depth + 1 };
  const childState = clone(gs);
  childState.ctm = childCtm;
  walk(childCtx, bytes, childState);
  ctx.seen.delete(stream.dict);

  ctx.sink.restore();
}

function textMove(gs: GState, tx: number, ty: number): void {
  gs.tlm = mul(translate(tx, ty), gs.tlm);
  gs.tm = gs.tlm;
}

function applyFontStyle(gs: GState, baseFont?: string): void {
  const nfont = (baseFont ?? '').toLowerCase();
  gs.fontBold = /bold|black|heavy|semibold/.test(nfont);
  gs.fontItalic = /italic|oblique/.test(nfont);
  gs.fontFamily = /courier|mono|consol/.test(nfont) ? 'monospace'
    : /times|serif|georgia|roman|minion/.test(nfont) ? 'serif' : 'sans-serif';
}

/** Emit one glyph run and advance the text matrix (advance stays here — it is
 *  graphics state, not backend output). */
function showText(ctx: RenderCtx, gs: GState, strObj: PdfObject | undefined): void {
  if (!isString(strObj) || !gs.font) return;
  const decoded = gs.font.decodeRun(strObj.bytes);
  ctx.sink.glyphRun({
    font: gs.font, decoded,
    tm: gs.tm, ctm: gs.ctm, rise: gs.rise,
    fontSize: gs.fontSize, fontFamily: gs.fontFamily, bold: gs.fontBold, italic: gs.fontItalic, color: gs.fill,
  });
  const adv = (decoded.width * gs.fontSize + decoded.ncodes * gs.charSp + decoded.nWordSpaces * gs.wordSp) * gs.hscale;
  gs.tm = mul(translate(adv, 0), gs.tm);
}

function showArray(ctx: RenderCtx, gs: GState, arrObj: PdfObject | undefined): void {
  if (!isArray(arrObj) || !gs.font) return;
  for (const el of arrObj) {
    if (isString(el)) showText(ctx, gs, el);
    else if (typeof el === 'number') gs.tm = mul(translate((-el / 1000) * gs.fontSize * gs.hscale, 0), gs.tm);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pagerender.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`svgrender.ts` is still the original file at this point and still compiles; `pagerender.ts` is new and self-contained.)

- [ ] **Step 6: Commit**

```bash
git add src/pagerender.ts test/pagerender.test.ts
git commit -m "refactor(3sh.2.1): extract content interpreter + RenderSink into pagerender.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Reimplement `svgrender.ts` as an `SvgSink` over the shared interpreter

**Files:**
- Rewrite: `src/svgrender.ts`
- Test: `test/svgrender.test.ts` (unchanged — must stay green)

**Interfaces:**
- Consumes from Task 1: `interpret`, `baseMatrix`, `arrNums`, `RenderSink`, `Path`, `Seg`, `StrokeStyle`, `TextRunInfo`, `Matrix`.
- Produces: `renderPageToSvg(doc, page, opts?): string`, `SvgOptions` (unchanged public surface). `page.ts` continues to import `{ renderPageToSvg, SvgOptions }`.

- [ ] **Step 1: Confirm the safety-net tests currently pass**

Run: `npx vitest run test/svgrender.test.ts`
Expected: PASS (baseline before the rewrite).

- [ ] **Step 2: Rewrite `src/svgrender.ts`**

Replace the entire file. `renderPageToSvg` now builds an `SvgSink` and calls `interpret`. `SvgSink` reproduces the exact attributes/structure the old code emitted: fill paths carry `fill=… [fill-rule] stroke="none"`; stroke paths carry `fill="none" stroke=… stroke-width=…`; clips open `<g clip-path>` groups tracked by `groupDepth`/`saveStack`; text/image/shading emission is ported unchanged.

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul, translate } from './text.js';
import { PdfDict, PdfObject, isArray, isName, PdfStream } from './types.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, rgbHex, Rgb, ColorConverter } from './colorspace.js';
import { parseFunction } from './pdffunction.js';
import { ImageInfo } from './image.js';
import { encodePng, pngDataUri } from './pngencode.js';
import { interpret, baseMatrix, arrNums, RenderSink, Path, StrokeStyle, TextRunInfo } from './pagerender.js';

export interface SvgOptions {
  /** Which page box defines the viewport. Default 'crop'. */
  box?: 'crop' | 'media';
}

/** Format a number for SVG output: fixed to ≤4 dp, trailing zeros stripped. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;');
}

export function matrixAttr(m: Matrix): string {
  return `matrix(${m.map(fmt).join(' ')})`;
}

/** Accumulates SVG body markup plus a <defs> section with unique ids. */
class SvgWriter {
  private body: string[] = [];
  private defs: string[] = [];
  private idSeq = 0;
  nextId(prefix: string): string { return `${prefix}${this.idSeq++}`; }
  emit(s: string): void { this.body.push(s); }
  addDef(s: string): void { this.defs.push(s); }
  finish(width: number, height: number): string {
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" `
      + `viewBox="0 0 ${fmt(width)} ${fmt(height)}">${defs}${this.body.join('')}</svg>`;
  }
}

function deviceGray(): ColorConverter {
  return { components: 1, toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; }, initial: () => [0, 0, 0] };
}
function num(doc: Document, o: PdfObject | undefined): number { const v = doc.resolve(o); return typeof v === 'number' ? v : 0; }

/** Serialize a structured Path to an SVG `d` string (absolute M/L/C/Z). */
function pathToD(path: Path): string {
  let d = '';
  for (const s of path) {
    if (s.op === 'M') d += `M${fmt(s.x)} ${fmt(s.y)}`;
    else if (s.op === 'L') d += `L${fmt(s.x)} ${fmt(s.y)}`;
    else if (s.op === 'C') d += `C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`;
    else d += 'Z';
  }
  return d;
}

/** RenderSink that emits a standalone SVG document. */
class SvgSink implements RenderSink {
  private w = new SvgWriter();
  private groupDepth = 0;
  private saveStack: number[] = [];
  constructor(private doc: Document) {}

  finish(width: number, height: number): string { return this.w.finish(width, height); }

  save(): void { this.saveStack.push(this.groupDepth); }
  restore(): void {
    const target = this.saveStack.pop() ?? 0;
    while (this.groupDepth > target) { this.w.emit('</g>'); this.groupDepth--; }
  }

  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void {
    const d = pathToD(path);
    if (!d) return;
    const id = this.w.nextId('clip');
    const rule = evenOdd ? ' clip-rule="evenodd"' : '';
    this.w.addDef(`<clipPath id="${id}"><path d="${d}" transform="${matrixAttr(ctm)}"${rule}/></clipPath>`);
    this.w.emit(`<g clip-path="url(#${id})">`);
    this.groupDepth++;
  }

  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void {
    const d = pathToD(path);
    if (!d) return;
    const attrs = [`d="${d}"`, `transform="${matrixAttr(ctm)}"`, `fill="${rgbHex(color)}"`];
    if (evenOdd) attrs.push('fill-rule="evenodd"');
    attrs.push('stroke="none"');
    this.w.emit(`<path ${attrs.join(' ')}/>`);
  }

  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void {
    const d = pathToD(path);
    if (!d) return;
    const attrs = [`d="${d}"`, `transform="${matrixAttr(ctm)}"`, 'fill="none"',
      `stroke="${rgbHex(color)}"`, `stroke-width="${fmt(style.width)}"`];
    if (style.dash.length) attrs.push(`stroke-dasharray="${style.dash.map(fmt).join(' ')}"`);
    if (style.cap) attrs.push(`stroke-linecap="${style.cap === 1 ? 'round' : 'square'}"`);
    if (style.join) attrs.push(`stroke-linejoin="${style.join === 1 ? 'round' : 'bevel'}"`);
    this.w.emit(`<path ${attrs.join(' ')}/>`);
  }

  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void {
    const href = this.imageHref(stream, fillColor);
    const transform = matrixAttr(mul([1, 0, 0, -1, 0, 1], ctm)); // unit-square with local Y-flip
    if (href) {
      this.w.emit(`<image x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="${transform}" href="${href}"/>`);
    } else {
      this.w.emit(`<rect x="0" y="0" width="1" height="1" transform="${transform}" fill="#cccccc"/>`);
    }
  }

  glyphRun(info: TextRunInfo): void {
    const text = info.decoded.text;
    if (text.length === 0) return;
    const L = mul(mul(translate(0, info.rise), info.tm), info.ctm);
    const tf: Matrix = [L[0], L[1], -L[2], -L[3], L[4], L[5]];
    const attrs = [`transform="${matrixAttr(tf)}"`, `font-size="${fmt(info.fontSize)}"`, `font-family="${info.fontFamily}"`];
    if (info.bold) attrs.push('font-weight="bold"');
    if (info.italic) attrs.push('font-style="italic"');
    attrs.push(`fill="${rgbHex(info.color)}"`);
    this.w.emit(`<text ${attrs.join(' ')}>${escapeXml(text)}</text>`);
  }

  shading(dict: PdfDict, ctm: Matrix): void {
    const doc = this.doc;
    const r = (o: PdfObject | undefined) => doc.resolve(o);
    const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
    const type = num(doc, dict.get('ShadingType'));
    const csObj = dict.get('ColorSpace');
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : deviceGray();
    const coords = arrNums(doc, dict.get('Coords'));
    const fnObj = dict.get('Function');
    const fn = fnObj !== undefined ? parseFunction(fnObj, r, infl) : (x: number[]) => x;
    const stops = this.sampleStops(fn, cs, 8);

    if (type === 2 && coords.length >= 4) {
      const id = this.w.nextId('grad');
      this.w.addDef(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" `
        + `x1="${fmt(coords[0])}" y1="${fmt(coords[1])}" x2="${fmt(coords[2])}" y2="${fmt(coords[3])}">`
        + stops + `</linearGradient>`);
      this.fillViewportRect(ctm, `url(#${id})`);
    } else if (type === 3 && coords.length >= 6) {
      const id = this.w.nextId('grad');
      this.w.addDef(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" `
        + `fx="${fmt(coords[0])}" fy="${fmt(coords[1])}" cx="${fmt(coords[3])}" cy="${fmt(coords[4])}" r="${fmt(coords[5])}">`
        + stops + `</radialGradient>`);
      this.fillViewportRect(ctm, `url(#${id})`);
    } else {
      this.fillViewportRect(ctm, '#808080');
    }
  }

  private sampleStops(fn: (x: number[]) => number[], cs: ColorConverter, n: number): string {
    let s = '';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      s += `<stop offset="${fmt(t)}" stop-color="${rgbHex(cs.toRgb(fn([t])))}"/>`;
    }
    return s;
  }

  private fillViewportRect(ctm: Matrix, paint: string): void {
    this.w.emit(`<rect x="-100000" y="-100000" width="200000" height="200000" transform="${matrixAttr(ctm)}" fill="${paint}"/>`);
  }

  // ----- image decoding (ported unchanged from the old module) -----

  private imageHref(stream: PdfStream, fill: Rgb): string | undefined {
    const doc = this.doc;
    const info = new ImageInfo(doc, '', stream);
    const filter = info.Filter;
    if (filter === 'DCTDecode' || filter === 'DCT') {
      return `data:image/jpeg;base64,${Buffer.from(info.RawData).toString('base64')}`;
    }
    try {
      const width = info.Width, height = info.Height;
      if (!width || !height) return undefined;
      const samples = info.Decode();
      const dict = stream.dict;
      if (doc.resolve(dict.get('ImageMask')) === true) return this.maskHref(samples, width, height, fill);
      const png = this.samplesToPng(dict, samples, width, height);
      return png ? pngDataUri(png) : undefined;
    } catch {
      return undefined;
    }
  }

  private samplesToPng(dict: PdfDict, samples: Uint8Array, width: number, height: number): Uint8Array | undefined {
    const doc = this.doc;
    const r = (o: PdfObject | undefined) => doc.resolve(o);
    const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
    const bpc = num(doc, dict.get('BitsPerComponent')) || 8;
    if (bpc !== 8) return undefined;
    const csObj = dict.get('ColorSpace');
    const isIndexedCs = this.isIndexedColorSpace(csObj);
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : deviceGray();
    const nc = cs.components;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      let out: Rgb;
      if (isIndexedCs) out = cs.toRgb([samples[i] ?? 0]);
      else {
        const comps: number[] = [];
        for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / 255);
        out = cs.toRgb(comps);
      }
      rgb[i * 3] = out[0]; rgb[i * 3 + 1] = out[1]; rgb[i * 3 + 2] = out[2];
    }
    return encodePng(width, height, rgb, 'rgb');
  }

  private isIndexedColorSpace(csObj: PdfObject | undefined): boolean {
    const r0 = this.doc.resolve(csObj);
    if (isArray(r0) && r0.length) {
      const h = this.doc.resolve(r0[0]);
      return isName(h) && (h.name === 'Indexed' || h.name === 'I');
    }
    return false;
  }

  private maskHref(bits: Uint8Array, width: number, height: number, fill: Rgb): string {
    const rowBytes = Math.ceil(width / 8);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const i = (y * width + x) * 4;
        const paint = bit === 0;
        rgba[i] = fill[0]; rgba[i + 1] = fill[1]; rgba[i + 2] = fill[2];
        rgba[i + 3] = paint ? 255 : 0;
      }
    }
    return pngDataUri(encodePng(width, height, rgba, 'rgba'));
  }
}

/** Render one page to a standalone SVG string. Never throws. */
export function renderPageToSvg(doc: Document, page: Page, opts: SvgOptions = {}): string {
  const box = opts.box ?? 'crop';
  const { matrix, width, height } = baseMatrix(page, box);
  const sink = new SvgSink(doc);
  try {
    interpret(doc, page, matrix, sink);
  } catch {
    // Degrade: whatever was emitted before the failure still renders.
  }
  return sink.finish(width, height);
}
```

- [ ] **Step 3: Run the SVG tests to verify they still pass**

Run: `npx vitest run test/svgrender.test.ts`
Expected: PASS — all geometry/paths/text/images/clipping/shadings/form-xobject cases green. (If a case fails, compare the emitted attribute against the assertion; the most likely culprit is an attribute-order or `stroke="none"` difference in `fill`/`stroke`.)

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green (including `test/pagerender.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts
git commit -m "refactor(3sh.2.1): reimplement svgrender as an SvgSink over pagerender

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Close out the sub-issue

- [ ] **Step 1: Final verification**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Update beads**

```bash
bd close aspose-pdf-foss-for-ts-3sh.2.1
```

- [ ] **Step 3: Confirm the working tree is clean and committed**

Run: `git status`
Expected: nothing to commit (spec/plan already committed; two refactor commits landed).

---

## Self-Review

**Spec coverage (3sh.2.1 row):** The sub-issue is "extract `pagerender.ts` + `SvgSink`; SVG tests stay green (no behavior change)." Task 1 creates `pagerender.ts` with the interpreter + `RenderSink`; Task 2 delivers `SvgSink` and keeps `test/svgrender.test.ts` green. Covered.

**Interface consistency:** `RenderSink` method signatures (`save`/`restore`/`addClip`/`fill`/`stroke`/`image`/`glyphRun`/`shading`) and the `Path`/`Seg`/`StrokeStyle`/`TextRunInfo` types are defined once in Task 1 and consumed unchanged in Task 2. `TextRunInfo.decoded` matches `TextFont.decodeRun`'s return `{ text, width, ncodes, nWordSpaces }` (verified in `src/font.ts:59-78`). `baseMatrix` and `arrNums` are defined in Task 1 and imported in Task 2.

**Behavior-equivalence risks (call out for the reviewer):**
- Combined fill+stroke ops (`B`/`b`/`B*`/`b*`) now emit **two** `<path>` elements (fill then stroke) instead of one element carrying both — visually identical (same geometry, fill painted before stroke), and no test asserts the single-element form.
- `d` strings change form (absolute `M/L/C/Z`; `re`→four `L`s; `v`→absolute `C` with the current point as first control) — geometrically equivalent; no test asserts `d`.
- The per-`walk` wrapping `sink.save()`/`sink.restore()` reproduces the old "close all groups at end of stream" behavior; nested `q`/`Q` and form `/BBox` clips map onto `save`/`addClip`/`restore` and stay balanced (verified against the clipping and form-xobject tests' balanced-`<g>` assertions).

**Placeholder scan:** none — all steps contain complete code and exact commands.
