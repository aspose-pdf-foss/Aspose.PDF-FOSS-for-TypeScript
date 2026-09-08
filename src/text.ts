// Coordinate-based content walking: thread the CTM/text-state machine across a
// page's content streams (and into Form XObjects), emitting positioned glyph
// events with provenance. `extractText` and `mapRegions` are thin consumers.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import { PdfDict, PdfObject, PdfStream, isDict, isName, isArray, isString, isStream } from './types.js';
import { parseContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { TextFont, glyphDisplacement, tjShift } from './font.js';
import {
  Rgb, ColorConverter, deviceGray, cmykToRgb, resolveColorSpace,
} from './colorspace.js';
// textrank.ts imports this module type-only, so this value edge closes no cycle.
import { dominantFragmentSize, roundSize } from './textrank.js';

/** 2x3 affine matrix [a b c d e f] with row-vector convention:
 *  x' = a*x + c*y + e ; y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m followed by n: point p -> (p·m)·n. */
export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
/** Inverse of a 2×3 affine matrix. Throws when the linear part is singular. */
export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error('invert: singular matrix');
  return [
    d / det, -b / det, -c / det, a / det,
    (c * f - d * e) / det, (b * e - a * f) / det,
  ];
}
export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}
/** Vertical scale magnitude of a matrix (effective font-size multiplier). */
export function vscale(m: Matrix): number {
  return Math.hypot(m[2], m[3]) || 1;
}

/** The aligned bounding box of `bbox` transformed by `m` (a form's /Matrix),
 *  returned as `[w, h]`; `undefined` for a degenerate (zero-area) box.
 *
 *  Exported because both placements need it: N-up's contain fit and a
 *  template's. It lives here beside {@link placementMatrix} rather than in
 *  compose.ts, which is page-to-page composition and the wrong direction for
 *  an authoring primitive to import from. */
export function transformedExtent(bbox: number[], m: Matrix): [number, number] | undefined {
  const corners: [number, number][] = [
    apply(m, bbox[0], bbox[1]), apply(m, bbox[2], bbox[1]),
    apply(m, bbox[2], bbox[3]), apply(m, bbox[0], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  return w === 0 || h === 0 ? undefined : [w, h];
}

/** The `cm` matrix that places a Form XObject with the given /BBox and /Matrix so
 *  its transformed bounding box maps exactly onto `rect` — the algorithm PDF
 *  viewers use (PDF 32000-1 §12.5.5): transform the BBox corners by the Matrix,
 *  take their aligned bounding box, then scale/translate that onto `rect`. The
 *  `Do` applies the XObject /Matrix itself, so only this matrix is emitted.
 *  Returns undefined for a degenerate (zero-area) transformed box. */
export function placementMatrix(bbox: number[], m: Matrix, rect: number[]): Matrix | undefined {
  const corners: [number, number][] = [
    apply(m, bbox[0], bbox[1]),
    apply(m, bbox[2], bbox[1]),
    apply(m, bbox[2], bbox[3]),
    apply(m, bbox[0], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const txMin = Math.min(...xs), txMax = Math.max(...xs);
  const tyMin = Math.min(...ys), tyMax = Math.max(...ys);
  const tw = txMax - txMin, th = tyMax - tyMin;
  if (tw === 0 || th === 0) return undefined;

  const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
  const sx = (rx1 - rx0) / tw;
  const sy = (ry1 - ry0) / th;
  return [sx, 0, 0, sy, rx0 - sx * txMin, ry0 - sy * tyMin];
}

/** Place a form's `bbox` (under its /Matrix `m`) inside `rect`
 *  (`[x0, y0, x1, y1]`) scaled UNIFORMLY and centred, preserving aspect ratio;
 *  `undefined` for a degenerate box. Contrast {@link placementMatrix}, which
 *  fills the rect exactly and may stretch.
 *
 *  One owner, deliberately: N-up imposition and a placed template both need
 *  "scale uniformly and centre", and two copies is how the two come to
 *  disagree about one placement. The body is `placeFitted`'s, verbatim — it
 *  computes the fitted sub-rect and then delegates, so the result is
 *  arithmetically identical to what N-up produced before the extraction. */
export function containMatrix(bbox: number[], m: Matrix, rect: number[]): Matrix | undefined {
  const ext = transformedExtent(bbox, m);
  if (ext === undefined) return undefined;
  const [tw, th] = ext;
  const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
  const cw = rx1 - rx0, ch = ry1 - ry0;
  const s = Math.min(cw / tw, ch / th);
  const fw = tw * s, fh = th * s;
  const x0 = rx0 + (cw - fw) / 2;
  const y0 = ry0 + (ch - fh) / 2;
  return placementMatrix(bbox, m, [x0, y0, x0 + fw, y0 + fh]);
}

/** A positioned text run in device space. */
export interface Run {
  x: number;      // device-space origin X
  endX: number;   // estimated device-space end X (for gap detection)
  y: number;      // device-space baseline Y
  text: string;
  size: number;   // effective font size in device units
  /** Vertical writing (`/WMode 1`): the run reads downward and `endY` is where
   *  it ends. Columns then order right-to-left. */
  vertical?: boolean;
  endY?: number;
}

/** A run carrying an optional provenance ref attached to each of its chars. */
export interface RefRun<T> extends Run { ref?: T; }

/** Build the layout run for one glyph event. The three callers that lay text
 *  out — `extractText`, structure-tree text and positioned search — had this
 *  written out identically, and a vertical run needs two more fields than a
 *  horizontal one, so only one of the three would have grown them. */
export function runFromGlyph<T>(e: GlyphEvent, ref?: T): RefRun<T> {
  const [x0, y0, x1, y1] = e.quad;
  if (e.vertical) {
    // Column axis is the cell's centre X; the run reads from its top down.
    const cx = (x0 + x1) / 2;
    return { x: cx, endX: cx, y: y1, endY: y0, text: e.text, size: e.fontSize, vertical: true, ref };
  }
  return { x: x0, endX: x1, y: y0, text: e.text, size: y1 - y0, ref };
}

/** Lay runs out into lines (by Y) and order/space them (by X), returning the
 *  assembled text plus, for every character, the ref of the run that produced
 *  it (`undefined` for inserted spaces and line breaks). The single source of
 *  truth behind both `assembleLines` and positioned text search. */
export function layoutLines<T>(runs: RefRun<T>[]): { text: string; refs: (T | undefined)[] } {
  const items = runs.filter((r) => r.text.length > 0);
  if (items.length === 0) return { text: '', refs: [] };

  const vertical = items.filter((r) => r.vertical);
  if (vertical.length === 0) return layoutOneDirection(items);
  const horizontal = items.filter((r) => !r.vertical);
  if (horizontal.length === 0) return layoutOneDirection(vertical);

  // A page can mix directions — vertically-set Japanese body text with a
  // horizontal running head or folio. There is no single ordering that is right
  // for both, so each group is laid out under its own rule and the vertical
  // body comes first, which is the content of such a page. Interleaving them by
  // position would put the folio in the middle of a column.
  const a = layoutOneDirection(vertical);
  const b = layoutOneDirection(horizontal);
  return {
    text: `${a.text}\n${b.text}`,
    refs: [...a.refs, undefined, ...b.refs],
  };
}

/**
 * Where a run sits, in coordinates that make one algorithm serve both writing
 * directions: `line` selects the line or column and sorts earliest-first, and
 * `start`/`end` run along the writing direction, also increasing.
 *
 * Horizontal text reads down the page and left to right, so `line` is the
 * negated baseline Y (PDF Y is up, and the topmost line comes first) and the
 * along-axis is X as it stands. Vertical text reads right to left in columns,
 * each column top to bottom, so *both* axes negate. That falls out of the same
 * arithmetic rather than needing a second copy of the layout with the
 * comparisons flipped — which is how the gap rule and the tolerance end up
 * differing between the two directions.
 */
function axisKeys<T>(r: RefRun<T>): { line: number; start: number; end: number } {
  return r.vertical
    ? { line: -r.x, start: -r.y, end: -(r.endY ?? r.y) }
    : { line: -r.y, start: r.x, end: r.endX };
}

/** Lay out runs that all read the same way. */
function layoutOneDirection<T>(items: RefRun<T>[]): { text: string; refs: (T | undefined)[] } {
  const keyed = items.map((r) => ({ r, k: axisKeys(r) }));
  keyed.sort((a, b) => (a.k.line - b.k.line) || (a.k.start - b.k.start));

  const lines: typeof keyed[] = [];
  let current: typeof keyed = [];
  let lineKey = keyed[0].k.line;
  for (const it of keyed) {
    const tol = Math.max(2, 0.5 * it.r.size);
    if (current.length === 0 || Math.abs(it.k.line - lineKey) <= tol) {
      current.push(it);
      // weight lineKey toward the line's first (tallest) run
    } else {
      lines.push(current);
      current = [it];
      lineKey = it.k.line;
    }
  }
  if (current.length) lines.push(current);

  const chars: string[] = [];
  const refs: (T | undefined)[] = [];
  lines.forEach((line, li) => {
    line.sort((a, b) => a.k.start - b.k.start);
    const start = chars.length;
    let prevEnd: number | undefined;
    for (const { r, k } of line) {
      if (prevEnd !== undefined) {
        const gap = k.start - prevEnd;
        const last = chars[chars.length - 1];
        if (gap > 0.25 * r.size && last !== ' ' && !r.text.startsWith(' ')) {
          chars.push(' '); refs.push(undefined);
        }
      }
      for (const ch of r.text) { chars.push(ch); refs.push(r.ref); }
      prevEnd = k.end;
    }
    // Trim trailing whitespace on this line (mirrors /\s+$/).
    while (chars.length > start && /\s/.test(chars[chars.length - 1])) {
      chars.pop(); refs.pop();
    }
    if (li < lines.length - 1) { chars.push('\n'); refs.push(undefined); }
  });
  return { text: chars.join(''), refs };
}

/** Group runs into lines (by Y) and order/space them (by X) into a string. */
export function assembleLines(runs: Run[]): string {
  return layoutLines(runs).text;
}

/** A positioned glyph with provenance back to the operator that drew it. */
export interface GlyphEvent {
  addr: ContentAddr;
  /** The font active when this glyph was shown (for re-encoding on replace). */
  font: TextFont;
  /** Device-space axis box [x0,y0,x1,y1]: x from the pen span, y from baseline..baseline+size. */
  quad: [number, number, number, number];
  /** Effective font size in device units (quad height: fontSize * CTM vscale). */
  fontSize: number;
  /** Baseline angle in radians: atan2 of the text→device matrix x-basis. 0 = horizontal. */
  angle: number;
  text: string;
  /** Index within a TJ array element list; 0 for Tj/'/". */
  elementIndex: number;
  /** This glyph's code offset/length within its show string. */
  byteStart: number;
  byteLen: number;
  /** Glyph-space advance *along the writing direction* (em units), font size
   *  and char/word spacing folded in, CTM/hscale divided out. The TJ numeric
   *  adjustment that reproduces this glyph's advance is `-1000 * advance`;
   *  redaction uses this to drop a glyph while keeping following glyphs in
   *  place. Under `/WMode 1` this is the vertical displacement, and negative —
   *  which is what keeps the same TJ arithmetic working on the other axis. */
  advance: number;
  /** True when the font's CMap is `/WMode 1`: the glyph advances down the page,
   *  and `quad` is the cell it occupies rather than a baseline-anchored box. */
  vertical?: boolean;
  /** The innermost active marked-content MCID when this glyph was drawn,
   *  or undefined outside any MCID-bearing marked-content sequence. */
  mcid?: number;
  /** True when this glyph was drawn inside an /Artifact marked-content scope. */
  artifact?: boolean;
  /** Address of the innermost enclosing /Artifact BMC/BDC. `artifact` says THAT
   *  this is decoration; this says WHICH scope declared it. */
  artifactScope?: ContentAddr;
  /** The fill colour in force when this glyph was shown, RGB 0..255.
   *
   *  Absent when the fill is black, which is the PDF initial value — the fence
   *  `TextFragment.bold`/`.italic` already set. A key present on every glyph
   *  would move every fixture that compares an event.
   *
   *  **Invariant:** this is deliberately NOT carried onto `TextFragment`.
   *  `fragmentsFromGlyphs` merges consecutive glyphs sharing font, size and
   *  baseline *across* show operators, and colour is not part of that identity,
   *  so a fragment spanning a colour change could only report one of them —
   *  painting a whole line the colour of its first word. Adding it to the
   *  identity instead would move every untagged fragment snapshot and disturb
   *  the premise `docmodel.ts`'s link recovery is written against.
   *  `docxgroup.ts` groups glyphs rather than fragments for exactly this. */
  color?: Rgb;
}

/** A placed image with provenance. */
export interface ImageEvent {
  addr: ContentAddr;
  /** Device-space box of the unit square mapped through the CTM. */
  quad: [number, number, number, number];
  /** The CTM active at the image draw (maps the image unit square to device). */
  ctm: Matrix;
  kind: 'xobject' | 'inline';
  /** The image XObject that was drawn. Undefined for an inline image, whose
   *  samples live in the content op itself (`addr`) and in no object. */
  stream?: PdfStream;
  /** The innermost active marked-content MCID, or undefined when untagged. */
  mcid?: number;
  /** True when drawn inside an /Artifact marked-content scope. */
  artifact?: boolean;
  /** Address of the innermost enclosing /Artifact BMC/BDC. */
  artifactScope?: ContentAddr;
}

/** A painted vector path, its subpaths flattened to page-space segments. */
export interface PathEvent {
  addr: ContentAddr;
  segments: [number, number, number, number][];
  stroke: boolean;
  fill: boolean;
  lineWidth: number;
  /** The innermost active marked-content MCID when this path was painted,
   *  or undefined outside any MCID-bearing marked-content sequence. */
  mcid?: number;
  /** True when this path was painted inside an /Artifact marked-content scope. */
  artifact?: boolean;
  /** Address of the innermost enclosing /Artifact BMC/BDC. */
  artifactScope?: ContentAddr;
}

/** An /Artifact marked-content scope opening: `/Artifact BMC` or
 *  `/Artifact <<props>> BDC`.
 *
 *  Fired at the OPENING op, so it precedes every ink event inside it — and an
 *  artifact enclosing nothing is still reported, which is the one shape a
 *  consumer reading only ink events provably cannot see. */
export interface ArtifactEvent {
  /** Where the BMC/BDC op sits. Every ink event inside this scope carries an
   *  equal `artifactScope`. */
  addr: ContentAddr;
  /** The property list: a BDC's inline dict, or the dict its name resolved to
   *  through /Resources /Properties. Undefined for a bare `/Artifact BMC`. */
  properties?: PdfDict;
  /** The enclosing artifact scope, when this one opened inside another —
   *  including one inherited across a Form XObject boundary. */
  parent?: ContentAddr;
}

export interface ContentVisitor {
  glyph?(e: GlyphEvent): void;
  image?(e: ImageEvent): void;
  path?(e: PathEvent): void;
  artifact?(e: ArtifactEvent): void;
}

const MAX_XOBJECT_DEPTH = 8;

interface TextState {
  tm: Matrix; tlm: Matrix;
  font?: TextFont; fontSize: number;
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
}

function newState(): TextState {
  return { tm: IDENTITY, tlm: IDENTITY, fontSize: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0 };
}

interface Ctx {
  doc: Document;
  visitor: ContentVisitor;
  fontCache: Map<PdfDict, TextFont>;
}

/** Walk a page's content (all /Contents streams, then into Form XObjects),
 *  emitting glyph/image events with provenance. */
export function visitContent(doc: Document, page: Page, visitor: ContentVisitor): void {
  const ctx: Ctx = { doc, visitor, fontCache: new Map() };
  const streams = contentStreamBytes(doc, page).map((bytes, i) => ({ bytes, streamIndex: i }));
  walkScope(ctx, streams, page.Resources, [], IDENTITY, 0, new Set());
}

/** Walk one Form XObject's content as though `cm base` + `Do` had drawn it: the
 *  stream's own /Matrix is applied on top of `base`, and its /Resources fall
 *  back to `fallbackResources`. Deliberately the same rule as `walkScope`'s `Do`
 *  case — a second placement rule is how a form comes to be measured in one
 *  place and drawn in another.
 *
 *  This function knows nothing about annotations and must not learn:
 *  `annotappearance.ts` value-imports `placementMatrix` from this module, so
 *  importing `isAnnotVisible`/`resolveAppearance` back would close a cycle.
 *  `annotsearch.ts` owns that half.
 *
 *  **Invariant:** the `GlyphEvent.addr` on this walk is `{ path: [],
 *  streamIndex: 0 }`, which names the page's first content stream and is a lie
 *  — an /AP stream is not addressable by `ContentAddr`, whose `path` is a chain
 *  of XObject resource names descended from the page. No event from here may
 *  reach a consumer that acts on `addr`; `AnnotationMatch` carries none, and a
 *  fabricated path would throw `XObject /X not found` inside
 *  `EditableContent.cowXObject` rather than degrade. */
export function visitFormContent(
  doc: Document, stream: PdfStream, fallbackResources: PdfDict | undefined,
  base: Matrix, visitor: ContentVisitor,
): void {
  const ctx: Ctx = { doc, visitor, fontCache: new Map() };
  const mat = nums(doc.resolve(stream.dict.get('Matrix')) as PdfObject[] | undefined);
  const ctm = mat.length === 6 ? mul(mat as Matrix, base) : base;
  const res = resolveDict(doc, stream.dict.get('Resources')) ?? fallbackResources;
  walkScope(ctx, [{ bytes: inflateStream(stream), streamIndex: 0 }], res, [], ctm, 0, new Set());
}

/** The subset of the graphics state this walker threads: the CTM, the fill
 *  colour, and the converter that resolves that colour's operands. */
interface GState { ctm: Matrix; fill?: Rgb; conv: ColorConverter }

const cl255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Black is the PDF initial fill, so report it as absence — the fence that
 *  keeps `color` off every glyph of every existing fixture. */
const paint = (rgb: Rgb): Rgb | undefined =>
  rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0 ? undefined : rgb;

/** Resolve a `cs` operand to its converter, looking a non-device name up in
 *  /Resources /ColorSpace. Mirrors `paths.ts`'s `lookupCs`: `colorspace.ts` is
 *  the one owner of "what colour is this operand", and a second copy is how the
 *  two walkers come to disagree about one page. */
function lookupFillCs(
  doc: Document, resources: PdfDict | undefined, operand: PdfObject | undefined,
): ColorConverter {
  let csObj = operand;
  if (isName(operand) && !DEVICE_CS.has(operand.name)) {
    const csDict = resolveDict(doc, resources?.get('ColorSpace'));
    const found = csDict?.get(operand.name);
    if (found !== undefined) csObj = found;
  }
  if (csObj === undefined) return deviceGray();
  try {
    return resolveColorSpace(
      csObj as PdfObject,
      (o) => doc.resolve(o),
      (s) => inflateStream(s as Parameters<typeof inflateStream>[0]),
    );
  } catch {
    // A damaged colourspace costs a colour, not the page's text.
    return deviceGray();
  }
}

const DEVICE_CS = new Set([
  'DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK',
]);

/** Walk one graphics-state scope (the page's content array, or a single
 *  XObject), threading text/CTM state across the given streams.
 *
 *  `inheritedMcid`/`inheritedArtifact` carry the marked-content scope open at the
 *  `Do` that invoked this XObject. A marked-content sequence must open and close
 *  within one stream, but the form's content is still drawn inside the caller's
 *  sequence, so it inherits that tagging — without this, everything inside a
 *  correctly tagged form reads as untagged. `inheritedFill` carries the fill
 *  colour for the same reason: a form drawn under a red fill draws red. */
function walkScope(
  ctx: Ctx, streams: { bytes: Uint8Array; streamIndex: number }[],
  resources: PdfDict | undefined, path: string[], baseCtm: Matrix,
  depth: number, seen: Set<PdfDict>,
  inheritedMcid?: number, inheritedArtifact?: ContentAddr,
  inheritedFill?: Rgb,
): void {
  const st = newState();
  const gsStack: GState[] = [];
  let curCtm = baseCtm;
  let fill: Rgb | undefined = inheritedFill;
  let fillConv: ColorConverter = deviceGray();
  const fonts = resolveDict(ctx.doc, resources?.get('Font'));
  const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
  const properties = resolveDict(ctx.doc, resources?.get('Properties'));
  const mcidStack: (number | undefined)[] = [];
  let activeMcid: number | undefined = inheritedMcid;
  const artifactStack: (ContentAddr | undefined)[] = [];
  let artScope: ContentAddr | undefined = inheritedArtifact;

  // Path construction state (page-space points).
  let lineWidth = 1;
  let subpaths: [number, number][][] = [];
  let cur: [number, number][] | undefined;
  let start: [number, number] | undefined;
  const pt = (x: number, y: number): [number, number] => apply(curCtm, x, y);
  const flushPath = (addr: ContentAddr, stroke: boolean, fill: boolean) => {
    const segs: [number, number, number, number][] = [];
    for (const sp of subpaths)
      for (let i = 1; i < sp.length; i++)
        segs.push([sp[i - 1][0], sp[i - 1][1], sp[i][0], sp[i][1]]);
    if (segs.length && ctx.visitor.path)
      ctx.visitor.path({
        addr, segments: segs, stroke, fill,
        lineWidth: stroke ? lineWidth * vscale(curCtm) : 0,
        mcid: activeMcid, artifact: artScope ? true : undefined, artifactScope: artScope,
      });
    subpaths = []; cur = undefined; start = undefined;
  };

  for (const { bytes, streamIndex } of streams) {
    const ops = parseContentStream(bytes);
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      const addr: ContentAddr = { path, streamIndex, opIndex };
      switch (op.operator) {
        case 'q': gsStack.push({ ctm: curCtm, fill, conv: fillConv }); break;
        case 'Q': {
          const g = gsStack.pop();
          if (g) { curCtm = g.ctm; fill = g.fill; fillConv = g.conv; }
          break;
        }
        case 'cm': { const m = nums(op.operands); if (m.length === 6) curCtm = mul(m as Matrix, curCtm); break; }
        case 'w': lineWidth = num(op.operands[0]); break;
        // Fill colour only: a glyph's ink is its fill except under the
        // stroke-only text render modes, where reporting the fill costs a shade
        // rather than the glyph. Tracking the stroke too would double the
        // saved state for that one case.
        case 'g': { const v = cl255(num(op.operands[0])); fill = paint([v, v, v]); break; }
        case 'rg': {
          const n = nums(op.operands);
          fill = paint([cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)]);
          break;
        }
        case 'k': {
          const n = nums(op.operands);
          fill = paint(cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0));
          break;
        }
        case 'cs': {
          fillConv = lookupFillCs(ctx.doc, resources, op.operands[0]);
          fill = paint(fillConv.initial());
          break;
        }
        case 'sc': case 'scn': {
          // A trailing name means a pattern: there is no single colour to
          // report, so fall back to whatever components came with it.
          const comps = nums(op.operands);
          fill = paint(comps.length ? fillConv.toRgb(comps) : [0, 0, 0]);
          break;
        }
        case 'm': {
          const [x, y] = nums(op.operands);
          start = pt(x, y); cur = [start]; subpaths.push(cur); break;
        }
        case 'l': {
          const [x, y] = nums(op.operands);
          if (cur) cur.push(pt(x, y)); break;
        }
        case 'c': case 'v': case 'y': {
          // Approximate a curve by its endpoint (last coordinate pair).
          const n = nums(op.operands);
          if (cur && n.length >= 2) cur.push(pt(n[n.length - 2], n[n.length - 1])); break;
        }
        case 're': {
          const [x, y, w, h] = nums(op.operands);
          const r: [number, number][] = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h), pt(x, y)];
          subpaths.push(r); cur = r; start = r[0]; break;
        }
        case 'h': { if (cur && start) cur.push(start); break; }
        case 'S': case 's': flushPath(addr, true, false); break;
        case 'f': case 'F': case 'f*': flushPath(addr, false, true); break;
        case 'B': case 'B*': case 'b': case 'b*': flushPath(addr, true, true); break;
        case 'n': flushPath(addr, false, false); break;
        case 'BT': st.tm = IDENTITY; st.tlm = IDENTITY; break;
        case 'ET': break;
        case 'Tc': st.charSp = num(op.operands[0]); break;
        case 'Tw': st.wordSp = num(op.operands[0]); break;
        case 'Tz': st.hscale = num(op.operands[0]) / 100 || 1; break;
        case 'TL': st.leading = num(op.operands[0]); break;
        case 'Ts': st.rise = num(op.operands[0]); break;
        case 'Tf': {
          st.fontSize = num(op.operands[1]);
          const fname = op.operands[0];
          if (isName(fname) && fonts) {
            const fd = ctx.doc.resolve(fonts.get(fname.name));
            if (isDict(fd)) {
              let tf = ctx.fontCache.get(fd);
              if (!tf) { tf = new TextFont(fd, (o) => ctx.doc.resolve(o), (s) => inflateStream(s as PdfStreamLike)); ctx.fontCache.set(fd, tf); }
              st.font = tf;
            }
          }
          break;
        }
        case 'Td': { const [tx, ty] = nums(op.operands); lineMove(st, tx, ty); break; }
        case 'TD': { const [tx, ty] = nums(op.operands); st.leading = -ty; lineMove(st, tx, ty); break; }
        case 'Tm': { const m = nums(op.operands); if (m.length === 6) { st.tlm = m as Matrix; st.tm = m as Matrix; } break; }
        case 'T*': lineMove(st, 0, -st.leading); break;
        case 'Tj': emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid, artScope, fill); break;
        case 'TJ': emitGlyphArray(ctx, st, op.operands[0], curCtm, addr, activeMcid, artScope, fill); break;
        case "'": lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid, artScope, fill); break;
        case '"': {
          st.wordSp = num(op.operands[0]); st.charSp = num(op.operands[1]);
          lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[2], curCtm, addr, 0, activeMcid, artScope, fill); break;
        }
        case 'BMC':
          mcidStack.push(activeMcid); artifactStack.push(artScope);
          if (isArtifactTag(op.operands[0]))
            artScope = openArtifact(ctx, addr, undefined, properties, artScope);
          break;
        case 'BDC': {
          mcidStack.push(activeMcid); artifactStack.push(artScope);
          if (isArtifactTag(op.operands[0]))
            artScope = openArtifact(ctx, addr, op.operands[1], properties, artScope);
          const m = mcidFromProps(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) activeMcid = m;
          break;
        }
        case 'EMC':
          if (mcidStack.length) activeMcid = mcidStack.pop();
          if (artifactStack.length) artScope = artifactStack.pop();
          break;
        case 'BI': if (op.inlineImage) emitImage(ctx, curCtm, addr, 'inline', activeMcid, artScope); break;
        case 'Do': {
          const xn = op.operands[0];
          if (!isName(xn) || !xobjects) break;
          const xo = ctx.doc.resolve(xobjects.get(xn.name));
          if (!isStream(xo)) break;
          if (isImageXObject(ctx.doc, xo.dict)) { emitImage(ctx, curCtm, addr, 'xobject', activeMcid, artScope, xo); break; }
          if (isFormXObject(ctx.doc, xo.dict) && depth < MAX_XOBJECT_DEPTH && !seen.has(xo.dict)) {
            seen.add(xo.dict);
            const mat = nums(ctx.doc.resolve(xo.dict.get('Matrix')) as PdfObject[] | undefined);
            const childCtm = mat.length === 6 ? mul(mat as Matrix, curCtm) : curCtm;
            const childRes = resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources;
            walkScope(ctx, [{ bytes: inflateStream(xo), streamIndex: 0 }],
              childRes, [...path, xn.name], childCtm, depth + 1, seen,
              activeMcid, artScope, fill);
            seen.delete(xo.dict);
          }
          break;
        }
      }
    }
  }
}

/** Structural shape inflateStream expects (a PdfStream). */
type PdfStreamLike = Parameters<typeof inflateStream>[0];

/** The inflated bytes of each /Contents stream, in order. */
export function contentStreamBytes(doc: Document, page: Page): Uint8Array[] {
  const c = doc.resolve(page.Dict.get('Contents'));
  const out: Uint8Array[] = [];
  if (isStream(c)) out.push(inflateStream(c));
  else if (isArray(c)) for (const e of c) { const s = doc.resolve(e); if (isStream(s)) out.push(inflateStream(s)); }
  return out;
}

function lineMove(st: TextState, tx: number, ty: number): void {
  st.tlm = mul(translate(tx, ty), st.tlm);
  st.tm = st.tlm;
}

/** Emit one glyph event per code in a show string, advancing the text matrix. */
function emitGlyphs(ctx: Ctx, st: TextState, strObj: PdfObject, ctm: Matrix, addr: ContentAddr, elementIndex: number, mcid?: number, artScope?: ContentAddr, fill?: Rgb): void {
  if (!isString(strObj) || !st.font) return;
  for (const g of st.font.decodeGlyphs(strObj.bytes)) {
    const startTm = st.tm;
    const [dx, dy] = glyphDisplacement(g, st.fontSize, st.charSp, st.wordSp, st.hscale);
    st.tm = mul(translate(dx, dy), st.tm);
    const startComb = mul(startTm, ctm);
    const [x, y] = apply(startComb, 0, st.rise);
    const [endX, endY] = apply(mul(st.tm, ctm), 0, st.rise);
    const size = st.fontSize * vscale(startComb);
    // Glyph-space advance along the writing direction (hscale divided out).
    const spacing = st.charSp + (g.isWordSpace ? st.wordSp : 0);
    const advance = st.fontSize !== 0
      ? (g.vertical ? g.vertical.w1 : g.width) + spacing / st.fontSize
      : 0;
    const angle = Math.atan2(startComb[1], startComb[0]);
    // Vertically, the pen sits at the glyph's *vertical origin* — top centre of
    // the cell — so the box runs down to the next pen position and half an em
    // either side, rather than up from a baseline. Min/max rather than assuming
    // the sign, since nothing stops a font from declaring a positive w1.
    const quad: [number, number, number, number] = g.vertical
      ? [x - size / 2, Math.min(y, endY), x + size / 2, Math.max(y, endY)]
      : [x, y, endX, y + size];
    ctx.visitor.glyph?.({
      addr, font: st.font, quad, text: g.text,
      fontSize: size, angle, elementIndex, byteStart: g.byteStart, byteLen: g.byteLen, advance, mcid,
      artifact: artScope ? true : undefined,
      artifactScope: artScope,
      vertical: g.vertical ? true : undefined,
      color: fill,
    });
  }
}

/** Handle a TJ array: strings emit glyphs, numbers shift the text matrix. */
function emitGlyphArray(ctx: Ctx, st: TextState, arrObj: PdfObject, ctm: Matrix, addr: ContentAddr, mcid?: number, artScope?: ContentAddr, fill?: Rgb): void {
  if (!isArray(arrObj) || !st.font) return;
  arrObj.forEach((el, idx) => {
    if (isString(el)) emitGlyphs(ctx, st, el, ctm, addr, idx, mcid, artScope, fill);
    else if (typeof el === 'number') {
      const [dx, dy] = tjShift(el, st.fontSize, st.hscale, st.font!.wmode === 1);
      st.tm = mul(translate(dx, dy), st.tm);
    }
  });
}

/** Emit an image-placement event for the unit square under the current CTM. */
function emitImage(ctx: Ctx, ctm: Matrix, addr: ContentAddr, kind: 'xobject' | 'inline', mcid?: number, artScope?: ContentAddr, stream?: PdfStream): void {
  if (!ctx.visitor.image) return;
  ctx.visitor.image({
    addr, quad: bboxOfUnitSquare(ctm), ctm, kind, stream, mcid,
    artifact: artScope ? true : undefined, artifactScope: artScope,
  });
}

function bboxOfUnitSquare(ctm: Matrix): [number, number, number, number] {
  const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A page-space rectangle [x0,y0,x1,y1] (corners in any order). */
export type Rect = [number, number, number, number];

/** Glyph and image events intersecting a set of regions. */
export interface RegionHits { glyphs: GlyphEvent[]; images: ImageEvent[]; }

function norm(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}
function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Collect the glyph/image events whose device-space box intersects any `rects`. */
export function mapRegions(doc: Document, page: Page, rects: Rect[]): RegionHits {
  const rs = rects.map(norm);
  const glyphs: GlyphEvent[] = [];
  const images: ImageEvent[] = [];
  visitContent(doc, page, {
    glyph: (e) => { if (rs.some((r) => intersects(e.quad, r))) glyphs.push(e); },
    image: (e) => { if (rs.some((r) => intersects(e.quad, r))) images.push(e); },
  });
  return { glyphs, images };
}

/** A positioned text run sharing one font, size, and baseline — the public unit
 *  of structured extraction (`Page.GetTextFragments`). */
export interface TextFragment {
  /** The fragment's decoded text (includes any literal space glyphs). */
  text: string;
  /** Page-space axis box [x0,y0,x1,y1]: x from the pen span, y baseline..baseline+size. */
  quad: [number, number, number, number];
  /** Effective font size in page units. */
  fontSize: number;
  /** The producing font's /BaseFont name, or undefined if the font has none. */
  fontName?: string;
  /** True when the producing font declares itself bold / italic (see
   *  `fontStyleOf`, the single owner of that question).
   *
   *  Absent rather than false, so a fragment gains no key when the answer is
   *  "no" — a fragment is compared and snapshotted in several tests, and a key
   *  that is always present moves output unrelated to emphasis. */
  bold?: boolean;
  italic?: boolean;
  /** Baseline angle in radians; absent when horizontal. */
  angle?: number;
  /** True when the run is set vertically (`/WMode 1`): it reads top-to-bottom
   *  within `quad`, and its column orders right-to-left against its siblings. */
  vertical?: boolean;
  /** Set when this run reads as a sub- or superscript of its own line.
   *
   *  Absent for ordinary text, which is every fragment in the existing
   *  snapshots — the fence `bold`/`italic` set. *Derived*, never declared: a PDF
   *  states no such thing, so see `markScriptLevel` for exactly what evidence
   *  earns the label. */
  script?: 'sub' | 'super';
}

/** Walk a page's content and group consecutive glyphs that share a font, size,
 *  and baseline (with no large horizontal gap) into positioned fragments, in
 *  content order. The thin positioned counterpart to `extractText`. */
/** Group consecutive glyph events sharing font, size, baseline angle, and
 *  baseline (with no large horizontal gap) into positioned fragments. */
export function fragmentsFromGlyphs(glyphs: GlyphEvent[]): TextFragment[] {
  return buildFragments(glyphs);
}

/** `fragmentsFromGlyphs`, optionally recording which input glyphs each fragment
 *  consumed: `spans[i]` is the [from, to) range of `glyphs` behind `out[i]`.
 *
 *  A fragment always consumes a CONTIGUOUS run of the input — the builder is a
 *  single forward pass that either extends the open fragment or flushes it — so
 *  a pair of indices is the whole of the provenance. Recording it here rather
 *  than re-deriving it outside is what keeps `scriptByGlyph` from owning a
 *  second copy of the merge rule. */
function buildFragments(glyphs: GlyphEvent[], spans?: [number, number][]): TextFragment[] {
  const out: TextFragment[] = [];
  type Cur = TextFragment & {
    font: TextFont; end: number; line: number; angle: number; vert: boolean; from: number;
  };
  let cur: Cur | undefined;
  let at = 0;                       // index of the glyph being consumed
  const flush = () => {
    if (!cur) return;
    if (spans) spans.push([cur.from, at]);
    const { font, end, line, angle, vert, from, ...rest } = cur;
    const frag = Math.abs(angle) > 1e-6 ? { ...rest, angle } : rest;
    // `cur` is accumulated per font, so the style is constant across the
    // fragment being flushed — the run granularity emphasis needs is already
    // here, and no extra split is required.
    const styled = {
      ...frag,
      ...(font.bold ? { bold: true } : {}),
      ...(font.italic ? { italic: true } : {}),
    };
    out.push(vert ? { ...styled, vertical: true } : styled);
    cur = undefined;
  };
  for (let i = 0; i < glyphs.length; i++) {
    const e = glyphs[i];
    at = i;                         // where a flush from the else branch ends
    if (!e.text) continue;
    const [x0, y0, x1, y1] = e.quad;
    const vert = e.vertical === true;
    // A fragment runs along its own writing direction: horizontally it is one
    // baseline with x continuing, vertically one column with y descending.
    // `k.line` and `k.start`/`k.end` are the same reoriented coordinates the
    // line layout uses, so the two agree on what "the next glyph along" means.
    const k = axisKeys(runFromGlyph(e));
    const sameStyle = cur
      && cur.vert === vert
      && cur.font === e.font
      && Math.abs(cur.fontSize - e.fontSize) < 0.01
      && Math.abs(cur.angle - e.angle) < 0.01
      && Math.abs(cur.line - k.line) <= Math.max(2, 0.5 * e.fontSize)
      && Math.abs(k.start - cur.end) <= 0.5 * e.fontSize;
    if (cur && sameStyle) {
      cur.text += e.text;
      // A column grows *downward*, so its box extends at quad[1]; a horizontal
      // line's origin corner is left where the first glyph put it, exactly as
      // before, rather than being re-derived per glyph.
      if (vert) {
        cur.quad[0] = Math.min(cur.quad[0], x0);
        cur.quad[1] = Math.min(cur.quad[1], y0);
      }
      cur.quad[2] = Math.max(cur.quad[2], x1);
      cur.quad[3] = Math.max(cur.quad[3], y1);
      cur.end = k.end;
    } else {
      flush();
      cur = {
        text: e.text, quad: [x0, y0, x1, y1], fontSize: e.fontSize,
        fontName: e.font.name, font: e.font, end: k.end, line: k.line,
        angle: e.angle, vert, from: i,
      };
    }
  }
  at = glyphs.length;
  flush();
  markScriptLevel(out);
  return out;
}

/** A script run is materially smaller than its line's body size. Real
 *  superscripts sit at 0.58-0.75em; 0.85 leaves headroom without catching a
 *  9.5pt run beside a 10pt one. */
const SCRIPT_MAX_SIZE_RATIO = 0.85;
/** ...and its baseline has materially moved, as a fraction of the body size. */
const SCRIPT_MIN_SHIFT_EM = 0.1;

/** Label each fragment that reads as a sub- or superscript of its own line.
 *
 *  A PDF declares no such thing, so this is derived from two pieces of evidence
 *  that must BOTH hold: the fragment is materially smaller than its line's
 *  dominant size, and its baseline is materially shifted from the baseline of
 *  the fragments at that size. The sign of the shift picks super from sub.
 *
 *  **Invariant:** both conditions are required, and they exclude different
 *  things. Without the size test, GPOS positioning is labelled a script — mark
 *  attachment and cursive joining raise a glyph at an unchanged size, and
 *  `otemit.ts` emits exactly that as a `Ts` for shaped Arabic and Devanagari, so
 *  this library would mislabel its own output. Without the shift test, any
 *  smaller inline run qualifies — small caps, a smaller label.
 *
 *  **Invariant:** the reference baseline comes from the dominant-size fragments,
 *  never from the line's bounding box. A subscript drags that box down, so the
 *  box's own edge measures the shift as zero and nothing is ever marked.
 *
 *  **Invariant:** the rule is producer-agnostic — it reads position and size,
 *  not `Ts`. Many producers write a superscript by moving the text matrix with
 *  no text rise at all, and a `Ts`-based rule sees nothing on those pages.
 *
 *  Vertical runs are skipped: `axisKeys` flips both axes for them, so a
 *  cross-axis offset is horizontal there and means something else.
 *
 *  A lone raised run with no larger text on its line is NOT marked — its own
 *  size is the dominant one, so there is no drop to measure. Precision over
 *  recall, the trade `docinfer.ts` makes with single-item lists. */
export function markScriptLevel(frags: TextFragment[]): void {
  // Group into lines by baseline proximity. The tolerance keys off the LARGER
  // of the two sizes: a 6pt script's own half-em would split it off from the
  // 10pt text it belongs to, which is the very association being measured.
  let line: TextFragment[] = [];
  const flushLine = () => { if (line.length > 1) scriptsInLine(line); line = []; };
  for (const frag of frags) {
    if (frag.vertical) { flushLine(); continue; }
    const prev = line[line.length - 1];
    if (prev) {
      const tol = Math.max(2, 0.5 * Math.max(prev.fontSize, frag.fontSize));
      if (Math.abs(frag.quad[1] - prev.quad[1]) > tol) flushLine();
    }
    line.push(frag);
  }
  flushLine();
}

/** Label the scripts within one line of two or more fragments. */
function scriptsInLine(line: TextFragment[]): void {
  const dominant = dominantFragmentSize(line);
  if (dominant <= 0) return;
  const body = line.filter((x) => roundSize(x.fontSize) === dominant);
  if (body.length === 0) return;
  // The body baseline, weighted by characters, so one stray body-size glyph
  // cannot move the reference.
  let weighted = 0, chars = 0;
  for (const x of body) { weighted += x.quad[1] * x.text.length; chars += x.text.length; }
  if (chars === 0) return;
  const baseline = weighted / chars;

  for (const frag of line) {
    if (frag.fontSize > dominant * SCRIPT_MAX_SIZE_RATIO) continue;
    const shift = frag.quad[1] - baseline;
    if (Math.abs(shift) < dominant * SCRIPT_MIN_SHIFT_EM) continue;
    frag.script = shift > 0 ? 'super' : 'sub';
  }
}

/** Label each glyph with the sub/superscript its own LINE makes it, through the
 *  same fragment assembly and `markScriptLevel` every other consumer uses.
 *
 *  **Invariant:** this exists so that "is this a script" keeps ONE owner, the
 *  rule `fontStyleOf` already sets for emphasis. The tagged path
 *  (`struct.ts`'s `styledRuns`) classifies from a single MCID's glyphs, which
 *  have no line context at all — a `/Span` around a footnote marker contains
 *  nothing but the marker, so its own size would be the dominant one and the
 *  detection would correctly refuse to mark anything. Feeding `markScriptLevel`
 *  a whole page and looking the answer up per glyph is what makes the tagged
 *  answer equal the untagged one, rather than a second rule that approximates
 *  it.
 *
 *  Keyed by `GlyphEvent` identity, so a caller that has grouped the same events
 *  some other way (by MCID, say) can still ask about any of them.
 *
 *  Pass every glyph the page draws, not a subset: a line is a visual fact, not
 *  a structural one, and the dominant size it is measured against has to be the
 *  one a reader sees. */
export function scriptByGlyph(glyphs: GlyphEvent[]): Map<GlyphEvent, 'sub' | 'super'> {
  const spans: [number, number][] = [];
  const frags = buildFragments(glyphs, spans);
  const out = new Map<GlyphEvent, 'sub' | 'super'>();
  for (let i = 0; i < frags.length; i++) {
    const script = frags[i].script;
    if (!script) continue;
    const [from, to] = spans[i];
    for (let j = from; j < to; j++) {
      if (glyphs[j].text) out.set(glyphs[j], script);
    }
  }
  return out;
}

/** Walk a page's content and group consecutive glyphs into positioned fragments,
 *  in content order. The thin positioned counterpart to `extractText`. */
export function extractFragments(doc: Document, page: Page): TextFragment[] {
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: (e) => glyphs.push(e) });
  return fragmentsFromGlyphs(glyphs);
}

/** A run of fragments sharing one baseline, ordered left-to-right. */
/** A half-open range of a line's `text` sharing one emphasis. */
export interface StyleSpan {
  start: number; end: number; bold?: boolean; italic?: boolean;
  /** Sub/superscript over this range, absent for ordinary text. See
   *  `markScriptLevel` for what earns the label. */
  script?: 'sub' | 'super';
}

export interface TextLine {
  text: string;
  /** Page-space bounding box [x0,y0,x1,y1] of the line's fragments. */
  quad: [number, number, number, number];
  fragments: TextFragment[];
  /** Where the emphasis changes along `text`, or absent when nothing on the
   *  line is bold or italic — which is every line in the existing snapshots.
   *
   *  **Invariant:** these offsets are recorded WHERE `text` IS BUILT, never
   *  re-derived from `fragments` afterwards. The assembly inserts a synthesized
   *  space wherever two fragments sit apart, so a later walk of `fragments`
   *  cannot reconstruct the offsets — the same reason `splitLineLinks` only ever
   *  slices `text` rather than rebuilding it. A synthesized space belongs to no
   *  span, which is right: it is a separator, not a glyph anyone emphasized. */
  styles?: StyleSpan[];
}

/** A paragraph-like cluster of consecutive lines, ordered top-to-bottom. */
export interface TextBlock {
  /** The block's lines joined with '\n'. */
  text: string;
  /** Page-space bounding box [x0,y0,x1,y1] of the block's lines. */
  quad: [number, number, number, number];
  lines: TextLine[];
}

function bbox(quads: [number, number, number, number][]): [number, number, number, number] {
  return [
    Math.min(...quads.map((q) => q[0])), Math.min(...quads.map((q) => q[1])),
    Math.max(...quads.map((q) => q[2])), Math.max(...quads.map((q) => q[3])),
  ];
}

/** Assemble positioned fragments into lines (by baseline) and paragraph-like
 *  blocks (by vertical gap and left-edge alignment), ordered top-to-bottom. */
export function extractStructured(doc: Document, page: Page): TextBlock[] {
  const frags = extractFragments(doc, page);
  if (frags.length === 0) return [];

  // Group fragments into lines by baseline (PDF Y up: larger Y first).
  const sorted = [...frags].sort((a, b) => (b.quad[1] - a.quad[1]) || (a.quad[0] - b.quad[0]));
  const lines: TextLine[] = [];
  let bucket: TextFragment[] = [];
  let lineY = sorted[0].quad[1];
  let lineSize = sorted[0].fontSize;
  const closeLine = () => {
    if (bucket.length === 0) return;
    bucket.sort((a, b) => a.quad[0] - b.quad[0]);
    let text = '';
    let prevEndX: number | undefined;
    const styles: StyleSpan[] = [];
    for (const f of bucket) {
      if (prevEndX !== undefined && f.quad[0] - prevEndX > 0.25 * f.fontSize
          && !text.endsWith(' ') && !f.text.startsWith(' ')) text += ' ';
      const start = text.length;
      text += f.text;
      prevEndX = f.quad[2];
      // Extend the open span when the emphasis has not changed, so a line set
      // in one face yields one span rather than one per fragment.
      const prev = styles[styles.length - 1];
      if (prev && prev.end === start && !!prev.bold === !!f.bold && !!prev.italic === !!f.italic
          && prev.script === f.script) {
        prev.end = text.length;
      } else {
        styles.push({
          start, end: text.length,
          ...(f.bold ? { bold: true } : {}), ...(f.italic ? { italic: true } : {}),
          ...(f.script ? { script: f.script } : {}),
        });
      }
    }
    const line: TextLine = { text, quad: bbox(bucket.map((f) => f.quad)), fragments: bucket };
    // Absent when nothing is emphasized, which is every line in the existing
    // snapshots — so a page that was never bold gains no key at all.
    if (styles.some((s) => s.bold || s.italic || s.script)) line.styles = styles;
    lines.push(line);
    bucket = [];
  };
  for (const f of sorted) {
    const tol = Math.max(2, 0.5 * f.fontSize);
    if (bucket.length > 0 && Math.abs(f.quad[1] - lineY) > tol) closeLine();
    if (bucket.length === 0) { lineY = f.quad[1]; lineSize = f.fontSize; }
    bucket.push(f);
    lineSize = Math.max(lineSize, f.fontSize);
  }
  closeLine();

  // Group lines into blocks by vertical gap and left-edge alignment.
  const blocks: TextBlock[] = [];
  let group: TextLine[] = [];
  const closeBlock = () => {
    if (group.length === 0) return;
    blocks.push({
      text: group.map((l) => l.text).join('\n'),
      quad: bbox(group.map((l) => l.quad)), lines: group,
    });
    group = [];
  };
  for (const line of lines) {
    if (group.length > 0) {
      const prev = group[group.length - 1];
      const size = Math.max(prev.quad[3] - prev.quad[1], line.quad[3] - line.quad[1]) || 1;
      const gap = prev.quad[1] - line.quad[1];           // baseline drop (positive going down)
      const indent = Math.abs(line.quad[0] - prev.quad[0]);
      if (gap > 1.6 * size || indent > 2 * size) closeBlock();
    }
    group.push(line);
  }
  closeBlock();
  return blocks;
}

/** Walk a page's content, collect positioned runs, assemble into text. */
export function extractText(doc: Document, page: Page): string {
  const runs: Run[] = [];
  visitContent(doc, page, {
    glyph: (e) => {
      if (!e.text) return;
      runs.push(runFromGlyph(e));
    },
  });
  return assembleLines(runs);
}

function isFormXObject(doc: Document, d: PdfDict): boolean {
  const s = doc.resolve(d.get('Subtype'));
  return isName(s) && s.name === 'Form';
}
function isImageXObject(doc: Document, d: PdfDict): boolean {
  const s = doc.resolve(d.get('Subtype'));
  return isName(s) && s.name === 'Image';
}
function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** The /MCID of a BDC properties operand: an inline dict, or a name resolved
 *  through the page's /Properties resource. Undefined when there is no MCID. */
function mcidFromProps(doc: Document, properties: PdfDict | undefined, operand: PdfObject | undefined): number | undefined {
  let d: PdfObject | undefined = operand;
  if (isName(operand)) d = properties?.get(operand.name);
  const dict = doc.resolve(d);
  if (!isDict(dict)) return undefined;
  const m = doc.resolve(dict.get('MCID'));
  return typeof m === 'number' ? m : undefined;
}
/** Open an /Artifact scope: report it, and hand back its address as the scope
 *  every op until the matching EMC belongs to.
 *
 *  The property list is resolved by the same rule `mcidFromProps` applies — an
 *  inline dict, or a name through /Resources /Properties — so the BDC operand
 *  has one grammar here rather than two. */
function openArtifact(
  ctx: Ctx, addr: ContentAddr, operand: PdfObject | undefined,
  properties: PdfDict | undefined, parent: ContentAddr | undefined,
): ContentAddr {
  if (ctx.visitor.artifact) {
    let d: PdfObject | undefined = operand;
    if (isName(operand)) d = properties?.get(operand.name);
    const dict = ctx.doc.resolve(d);
    ctx.visitor.artifact({ addr, properties: isDict(dict) ? dict : undefined, parent });
  }
  return addr;
}

/** True when a BMC/BDC tag operand is the /Artifact tag. */
function isArtifactTag(operand: PdfObject | undefined): boolean {
  return isName(operand) && operand.name === 'Artifact';
}
function num(o: PdfObject | undefined): number { return typeof o === 'number' ? o : 0; }
function nums(arr: PdfObject[] | undefined): number[] {
  return isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : [];
}
