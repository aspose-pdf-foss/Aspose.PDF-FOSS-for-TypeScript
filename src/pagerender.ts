import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul, translate, IDENTITY } from './text.js';
import { PdfDict, PdfObject, isName, isArray, isStream, isDict, isString, isRef, PdfStream } from './types.js';
import { parseContentStream } from './content.js';
import { inlineImageToStream } from './inlinedict.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, deviceGray, Rgb, ColorConverter } from './colorspace.js';
import { TextFont, glyphDisplacement, runDisplacement, tjShift } from './font.js';
import { isAnnotVisible, resolveAppearance } from './annotappearance.js';
import { BlendMode, blendModeFromName } from './blend.js';
import type { LayerConfig } from './ocg.js';

export type { Matrix } from './text.js';
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
  width: number; cap: number; join: number; miter: number; dash: number[]; dashPhase: number;
}

export interface TextRunInfo {
  font: TextFont;
  decoded: { text: string; width: number; ncodes: number; nWordSpaces: number };
  tm: Matrix; ctm: Matrix; rise: number;
  fontSize: number; fontFamily: string; bold: boolean; italic: boolean; color: Rgb;
  /** Per-glyph layout inputs (for backends that place each glyph, e.g. raster). */
  charSp: number; wordSp: number; hscale: number;
  /** Text rendering mode (`Tr`, Table 106) and the stroke paint it may need.
   *  A non-painting mode never reaches a sink — `showText` gates it — so a sink
   *  sees only 0, 1, 2 and their clipping twins 4, 5, 6, and asks `fillsText` /
   *  `strokesText` rather than switching on the number. */
  mode: number; strokeColor: Rgb; strokeStyle: StrokeStyle;
  /** Raw show-string bytes and the resolved font dict, for glyph-outline rendering. */
  bytes: Uint8Array; fontDict?: PdfDict;
}

/** Backend that turns interpreted graphics ops into output (SVG or raster). */
export interface RenderSink {
  save(): void;                                                    // q
  restore(): void;                                                 // Q
  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void;        // W/W* consumed at next paint
  /** Narrow the clip to a stroke's outline (for SCN stroke patterns). */
  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void;
  /** Narrow the clip to the UNION of these runs' glyph outlines — one run for
   *  an `scn` fill pattern on text, every run of a text object for a clipping
   *  text rendering mode (4gtd.2). A union rather than a per-run call because
   *  this INTERSECTS into the active clip: called once per run it would yield
   *  the intersection of the runs, which is empty for any two that do not
   *  overlap. Returns false when this sink cannot build the clip — the caller
   *  then draws the run solid, or leaves the clip alone, rather than dropping
   *  content. */
  clipToGlyphs(infos: readonly TextRunInfo[]): boolean;
  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void;
  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void;
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void;
  glyphRun(info: TextRunInfo): void;
  /** A mesh shading carries its vertex data in the STREAM, so this takes the
   *  stream where there is one. Every other type needs only the dict, and a
   *  sink that draws none of the mesh types may read `.dict` and ignore the
   *  difference.
   *
   *  `pattern` is true for a PatternType 2 fill and false for the `sh`
   *  operator. Only this module knows which, and `/Background` turns on it
   *  (32000-1 8.7.4.3). NOTE that TypeScript enforces neither half of this
   *  signature on an implementor: parameters are BIVARIANT, and an
   *  implementation may declare FEWER of them — so a sink left at the old
   *  two-parameter shape still typechecks and then silently reads `pattern`
   *  as undefined. All three were updated by hand. */
  shading(shading: PdfDict | PdfStream, ctm: Matrix, pattern: boolean): void;
  /** ExtGState constant alpha (ca/CA) and blend mode (BM), scoped by save/restore. */
  setAlpha(fill: number, stroke: number): void;
  setBlend(mode: BlendMode): void;
  /** Redirect output into an offscreen buffer, then dispose of it per `use`.
   *  `region` is the device-space area to allocate; omitted, the sink uses the
   *  active clip bbox. A tiling cell must pass its own device bbox, since it
   *  draws in pattern space and generally sits outside the region it fills.
   *  `opts.backdrop` seeds the buffer from the parent canvas and tracks the
   *  group's own alpha separately — for a non-isolated group, whose inner blends
   *  must see the backdrop (§11.4.6). Sinks that cannot express it may ignore it. */
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean; knockout?: boolean },
  ): void;
  endOffscreen(use: OffscreenUse): void;
  /** Bracket one top-level element of a knockout group: render it against the
   *  group's initial backdrop in a sub-buffer, then knockout-merge it into the
   *  group accumulator. Only called at the top level of a buffered knockout
   *  group; sinks that cannot express knockout may no-op. */
  beginKnockoutElement(): void;
  endKnockoutElement(): void;
  /** Drop the active soft mask (/SMask /None). */
  clearSoftMask(): void;
}

/** What the sink should do with the offscreen buffer being closed. */
export type OffscreenUse =
  | { kind: 'softmask'; luminosity: boolean; backdrop?: Rgb }
  | { kind: 'tile'; bbox: number[]; xstep: number; ystep: number; matrix: Matrix }
  | { kind: 'group'; alpha: number; blend: BlendMode; isolated: boolean; knockout: boolean };

/** Max nesting of offscreen buffers (groups, masks, tiles). Beyond this the
 *  construct degrades to inline drawing rather than allocating further. */
export const MAX_OFFSCREEN_DEPTH = 8;

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
  lineWidth: number; dash: number[]; dashPhase: number; cap: number; join: number; miter: number;
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
  /** Text rendering mode (Tr). Text state IS graphics state (9.3.1), so this
   *  follows q/Q through `clone` and is NOT reset by BT, which initialises the
   *  text and text-line matrices and nothing else (9.4.1). */
  textRender: number;
  fontSize: number; fontFamily: string; fontBold: boolean; fontItalic: boolean;
  fontRef?: PdfDict; font?: TextFont;
  tm: Matrix; tlm: Matrix;
  /** Active fill / stroke pattern (via scn / SCN); undefined = solid color. */
  fillPattern?: ShadingPattern | TilingPattern;
  strokePattern?: ShadingPattern | TilingPattern;
  /** ExtGState constant alpha (ca / CA) and blend mode (BM). */
  fillAlpha: number; strokeAlpha: number; blend: BlendMode;
  /** ExtGState overprint: /OP (stroking), /op (non-stroking) and /OPM. */
  overprintFill: boolean; overprintStroke: boolean; overprintMode: number;
  /** Active ExtGState /SMask: the mask dict plus the CTM in force when `gs` ran. */
  softMask?: SoftMaskRef;
  /** Which mask the sink currently holds, so a mask is realized once per `gs`
   *  rather than once per paint. */
  appliedMask?: SoftMaskRef;
}

/** An ExtGState /SMask awaiting realization: the mask dict and the CTM that was
 *  current when the `gs` that set it executed (the mask's /G is rendered in that
 *  space, not the space of whatever paints through it later). */
export interface SoftMaskRef { dict: PdfDict; ctm: Matrix; }

/** A resolved PatternType 2 (shading) pattern: its /Shading dict and pattern /Matrix. */
interface ShadingPattern { kind: 'shading'; shading: PdfDict | PdfStream; matrix: Matrix; }

/** A resolved PatternType 1 (tiling) pattern. */
interface TilingPattern {
  kind: 'tiling';
  stream: PdfStream; matrix: Matrix;
  bbox: number[]; xstep: number; ystep: number;
  /** 1 = colored (cell carries its own colors); 2 = uncolored (current fill color). */
  paintType: number;
  resources?: PdfDict;
}

/** Max tile blits for one pattern fill. Past this the fill degrades to the
 *  cell's mean color — bounded, and still better than a flat mid-gray. */
export const MAX_TILE_BLITS = 65_536;

function initialState(base: Matrix): GState {
  return {
    ctm: base, fill: [0, 0, 0], stroke: [0, 0, 0],
    fillCs: deviceGray(), strokeCs: deviceGray(),
    lineWidth: 1, dash: [], dashPhase: 0, cap: 0, join: 0, miter: 10,
    charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0, textRender: 0,
    fontSize: 0, fontFamily: 'sans-serif', fontBold: false, fontItalic: false,
    tm: IDENTITY, tlm: IDENTITY,
    fillAlpha: 1, strokeAlpha: 1, blend: 'Normal',
    overprintFill: false, overprintStroke: false, overprintMode: 0,
  };
}
function clone(s: GState): GState { return { ...s }; }
function strokeStyle(gs: GState): StrokeStyle {
  return { width: gs.lineWidth, cap: gs.cap, join: gs.join, miter: gs.miter, dash: gs.dash, dashPhase: gs.dashPhase };
}

function num(o: PdfObject | undefined): number { return typeof o === 'number' ? o : 0; }
function numbers(a: PdfObject[]): number[] { return a.filter((x): x is number => typeof x === 'number'); }

// ---------- Resolution helpers ----------

interface RenderCtx {
  doc: Document; sink: RenderSink;
  resources: PdfDict | undefined;
  depth: number; seen: Set<PdfDict>;
  /** Optional-content visibility for this render, absent when the document
   *  declares no `/OCProperties` — in which case every section is visible and
   *  no lookup is made at all. */
  oc?: OcVisibility;
}

/** The default configuration plus a per-render memo. The memo is not an
 *  optimization to shrug at: `LayerConfig.isRefVisible` LINEARLY SCANS `/ON`
 *  and `/OFF` per call, so an unmemoized walk is O(sections x layers) on
 *  exactly the CAD-style documents that have many of both. */
interface OcVisibility { config: LayerConfig; cache: Map<string, boolean>; }

/**
 * Is the `/OC` operand of a `BDC` visible under this render's configuration?
 *
 * **The raw operand is passed through UNRESOLVED**, because
 * `ResolveVisibility` decides an OCG's state by REF IDENTITY (`isRefVisible`
 * compares against `/ON` and `/OFF`); hand it a resolved dict and every layer
 * falls through to `BaseState`, so a switched-off layer reads as visible and
 * the whole feature silently does nothing.
 */
function ocVisible(ctx: RenderCtx, raw: PdfObject | undefined): boolean {
  const oc = ctx.oc;
  if (!oc) return true;
  const key = isRef(raw) ? `${raw.num} ${raw.gen}` : undefined;
  if (key !== undefined) {
    const hit = oc.cache.get(key);
    if (hit !== undefined) return hit;
  }
  const v = oc.config.ResolveVisibility(raw);
  if (key !== undefined) oc.cache.set(key, v);
  return v;
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

/** Resolve a named pattern to either a shading (type 2) or tiling (type 1)
 *  pattern. Unresolvable names return undefined (caller keeps the gray fallback). */
function resolvePattern(ctx: RenderCtx, name: string): ShadingPattern | TilingPattern | undefined {
  const patDict = resDict(ctx, 'Pattern');
  if (!patDict) return undefined;
  const p = ctx.doc.resolve(patDict.get(name));
  const pd = isStream(p) ? p.dict : isDict(p) ? p : undefined;
  if (!pd) return undefined;
  const mat = arrNums(ctx.doc, pd.get('Matrix'));
  const matrix = mat.length === 6 ? (mat as Matrix) : IDENTITY;
  const type = num(ctx.doc.resolve(pd.get('PatternType')));

  if (type === 2) {
    const sh = ctx.doc.resolve(pd.get('Shading'));
    const shading = isStream(sh) ? sh : isDict(sh) ? sh : undefined;
    return shading ? { kind: 'shading', shading, matrix } : undefined;
  }
  if (type === 1 && isStream(p)) {
    const bbox = arrNums(ctx.doc, pd.get('BBox'));
    if (bbox.length !== 4) return undefined;
    // Degenerate or missing steps fall back to the BBox extent (§8.7.3.1).
    const rawX = num(ctx.doc.resolve(pd.get('XStep')));
    const rawY = num(ctx.doc.resolve(pd.get('YStep')));
    const xstep = Number.isFinite(rawX) && Math.abs(rawX) > 1e-6 ? Math.abs(rawX) : Math.abs(bbox[2] - bbox[0]);
    const ystep = Number.isFinite(rawY) && Math.abs(rawY) > 1e-6 ? Math.abs(rawY) : Math.abs(bbox[3] - bbox[1]);
    if (!(xstep > 0) || !(ystep > 0)) return undefined;
    const res = ctx.doc.resolve(pd.get('Resources'));
    return {
      kind: 'tiling', stream: p, matrix, bbox, xstep, ystep,
      paintType: num(ctx.doc.resolve(pd.get('PaintType'))) === 2 ? 2 : 1,
      resources: isDict(res) ? res : undefined,
    };
  }
  return undefined;
}

/** Paint a tiling pattern over the active clip: interpret the cell exactly once
 *  into an offscreen, then let the sink replicate it on the XStep/YStep lattice.
 *  One interpretation regardless of tile count — a 2pt cell over a letter page is
 *  ~300k tiles, which as interpreter replays would be unaffordable. */
function paintTiling(ctx: RenderCtx, gs: GState, pat: TilingPattern, baseCtm: Matrix): void {
  if (ctx.depth >= MAX_OFFSCREEN_DEPTH || ctx.seen.has(pat.stream.dict)) return;
  const patCtm = mul(pat.matrix, baseCtm);
  let bytes: Uint8Array;
  try { bytes = inflateStream(pat.stream as Parameters<typeof inflateStream>[0]); } catch { return; }

  // The cell draws in pattern space, which generally lies outside the region it
  // fills, so the buffer is placed over the cell's own device bbox.
  const cellCtm = mul(translate(pat.bbox[0], pat.bbox[1]), patCtm);
  const cw = Math.abs(pat.bbox[2] - pat.bbox[0]), ch = Math.abs(pat.bbox[3] - pat.bbox[1]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [ux, uy] of [[0, 0], [cw, 0], [0, ch], [cw, ch]]) {
    const dx = cellCtm[0] * ux + cellCtm[2] * uy + cellCtm[4];
    const dy = cellCtm[1] * ux + cellCtm[3] * uy + cellCtm[5];
    if (dx < x0) x0 = dx; if (dx > x1) x1 = dx;
    if (dy < y0) y0 = dy; if (dy > y1) y1 = dy;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
  const region = {
    x0: Math.floor(x0) - 1, y0: Math.floor(y0) - 1,
    x1: Math.ceil(x1) + 1, y1: Math.ceil(y1) + 1,
  };

  ctx.sink.beginOffscreen(region);
  try {
    const st = initialState(cellCtm);
    // PaintType 2 (uncolored): the cell's color operators are ignored and
    // everything paints in the current fill color (§8.7.3.1).
    if (pat.paintType === 2) { st.fill = gs.fill; st.stroke = gs.fill; }
    ctx.seen.add(pat.stream.dict);
    walk({ ...ctx, resources: pat.resources ?? ctx.resources, depth: ctx.depth + 1 }, bytes, st);
    ctx.seen.delete(pat.stream.dict);
  } catch {
    // Degrade: whatever the cell drew before failing still tiles.
  }
  ctx.sink.endOffscreen({
    kind: 'tile', bbox: pat.bbox, xstep: pat.xstep, ystep: pat.ystep, matrix: patCtm,
  });
}

/** Apply a named /ExtGState resource to `gs` (PDF 32000-1 §8.4.5, table 58).
 *  Presence is tested with `has`, never with a resolved value: doc.resolve of an
 *  absent key returns null, which is indistinguishable from a present null — and
 *  /SMask absent (inherit) must not be confused with /SMask /None (clear). */
function applyExtGState(ctx: RenderCtx, gs: GState, name: string): void {
  const egs = resDict(ctx, 'ExtGState');
  if (!egs) return;
  const d = ctx.doc.resolve(egs.get(name));
  if (!isDict(d)) return;
  const R = (k: string) => ctx.doc.resolve(d.get(k));

  if (d.has('ca')) { const v = R('ca'); if (typeof v === 'number') gs.fillAlpha = clamp01(v); }
  if (d.has('CA')) { const v = R('CA'); if (typeof v === 'number') gs.strokeAlpha = clamp01(v); }
  if (d.has('LW')) { const v = R('LW'); if (typeof v === 'number') gs.lineWidth = v; }
  if (d.has('BM')) {
    // /BM is a name, or an array of names with the first recognized one winning
    // (Illustrator emits the array form).
    const v = R('BM');
    if (isName(v)) gs.blend = blendModeFromName(v.name);
    else if (isArray(v)) {
      const first = v.map((x) => ctx.doc.resolve(x)).find((x) => isName(x));
      gs.blend = isName(first) ? blendModeFromName(first.name) : 'Normal';
    }
  }
  if (d.has('SMask')) {
    const v = R('SMask');
    // /None (or anything not a dict) clears; a dict sets, captured at this CTM.
    gs.softMask = isDict(v) ? { dict: v, ctm: gs.ctm } : undefined;
  }
  // /OP is the STROKING flag and, for backward compatibility, sets the
  // non-stroking one too; /op then overrides that half. So /OP is read FIRST
  // and /op second — reversed, a dict carrying both would lose /op, which is
  // the half a fill reads (32000-1 Table 58).
  if (d.has('OP')) {
    const v = R('OP');
    if (typeof v === 'boolean') { gs.overprintStroke = v; gs.overprintFill = v; }
  }
  if (d.has('op')) { const v = R('op'); if (typeof v === 'boolean') gs.overprintFill = v; }
  if (d.has('OPM')) { const v = R('OPM'); if (typeof v === 'number') gs.overprintMode = v === 1 ? 1 : 0; }
}

/**
 * Whether OVERPRINT applies to the paint about to happen — and so whether the
 * preview substitutes Darken for the blend.
 *
 * **This is a PREVIEW, not a separation model.** A plate-accurate answer needs
 * per-colorant buffers; the canvas is RGB, so an overprinting paint composites
 * with per-channel minimum instead. A colorant the paint does not lay down has
 * no ink, so its RGB channel is 1 and the minimum preserves the backdrop by
 * itself — which is what lets DeviceCMYK, Separation and DeviceN share one rule
 * rather than each keeping a plate map. It is exact wherever the paint darkens
 * a plate and wrong only where a paint would LIGHTEN one already inked, which
 * RGB provably cannot represent.
 *
 * **Invariant:** an explicit `/BM` WINS. The approximation *is* a blend mode,
 * so the two collide, and a document that asked for Multiply gets Multiply
 * rather than having it silently replaced.
 */
function overprints(gs: GState, which: 'fill' | 'stroke'): boolean {
  if (gs.blend !== 'Normal') return false;
  if (!(which === 'fill' ? gs.overprintFill : gs.overprintStroke)) return false;
  const cs = which === 'fill' ? gs.fillCs : gs.strokeCs;
  // A Separation or DeviceN paint names a SUBSET of the device's colorants, so
  // the rest are preserved whatever the mode says. DeviceCMYK and DeviceGray
  // name every colorant and under mode 0 write all of them — INCLUDING the
  // zeros — which is exactly normal painting; only mode 1 leaves a
  // zero-valued component's plate alone, and that is what makes /OPM
  // observable rather than decorative.
  if (cs.family === 'separation') return true;
  return cs.family === 'device-sub' && gs.overprintMode === 1;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Push the gstate's alpha and blend mode to the sink. Called after `gs` and
 *  before each paint, since fill and stroke draw different alphas from ca/CA.
 *  Also realizes a newly-set /SMask, once per `gs` rather than once per paint.
 *
 *  `which` says which paint is about to happen, because OVERPRINT is decided
 *  per paint rather than per state: `/OP` and `/op` are separate flags over
 *  separate colour spaces, so one `setBlend` cannot answer for both. `doFill`
 *  and `doStroke` each already call this, which is what gets `B` — fill then
 *  stroke — the right answer for each half with no second mechanism. */
function syncPaintState(ctx: RenderCtx, gs: GState, which: 'fill' | 'stroke' = 'fill'): void {
  ctx.sink.setAlpha(gs.fillAlpha, gs.strokeAlpha);
  ctx.sink.setBlend(overprints(gs, which) ? 'Darken' : gs.blend);
  if (gs.softMask !== gs.appliedMask) {
    if (gs.softMask) realizeSoftMask(ctx, gs.softMask);
    else ctx.sink.clearSoftMask();
    gs.appliedMask = gs.softMask;
  }
}

/** Render an ExtGState /SMask's /G group into an offscreen buffer and hand it to
 *  the sink as a coverage mask (PDF 32000-1 §11.6.5). The group is drawn in the
 *  CTM that was current when the `gs` executed, which is why SoftMaskRef carries
 *  it. A malformed mask degrades to no mask — never to a throw. */
function realizeSoftMask(ctx: RenderCtx, ref: SoftMaskRef): void {
  if (ctx.depth >= MAX_OFFSCREEN_DEPTH) return;
  const g = ctx.doc.resolve(ref.dict.get('G'));
  if (!isStream(g)) { ctx.sink.clearSoftMask(); return; }

  const s = ctx.doc.resolve(ref.dict.get('S'));
  const luminosity = isName(s) && s.name === 'Luminosity';

  // /BC is in the group's own colorspace, and only matters as a luminosity
  // backdrop (§11.6.5.2).
  let backdrop: Rgb | undefined;
  if (luminosity && ref.dict.has('BC')) {
    const grp = ctx.doc.resolve(g.dict.get('Group'));
    const csObj = isDict(grp) ? grp.get('CS') : undefined;
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r(ctx), inf(ctx)) : deviceGray();
    backdrop = cs.toRgb(arrNums(ctx.doc, ref.dict.get('BC')));
  }

  ctx.sink.beginOffscreen();
  try {
    drawForm({ ...ctx, depth: ctx.depth + 1 }, initialState(ref.ctm), g);
  } catch {
    // Degrade: whatever the mask group drew before failing still masks.
  }
  ctx.sink.endOffscreen({ kind: 'softmask', luminosity, backdrop });
}

/** Resolve `o` to a flat array of numbers (dereferencing element refs). */
export function arrNums(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  return isArray(a) ? a.map((x) => doc.resolve(x)).filter((x): x is number => typeof x === 'number') : [];
}

// ---------- Entry point ----------

export interface InterpretOptions {
  /** Composite annotation /AP appearances after the page content. Default true. */
  annotations?: boolean;
  /** Widget dicts whose appearance must NOT be composited.
   *
   *  For `htmlfixed.ts`'s `forms: true`: a widget that became a real HTML
   *  control must contribute no ink, or its painted value sits behind the
   *  control showing the same text. Per WIDGET rather than per page, because a
   *  field that failed to convert keeps its appearance. */
  hideWidgets?: ReadonlySet<PdfDict>;
}

/** Walk the page content under the base CTM, driving `sink`, then composite the
 *  annotation appearances over it. Never throws here; callers
 *  (renderPageToSvg / renderPageToPng) wrap with degrade-on-error. */
export function interpret(
  doc: Document, page: Page, base: Matrix, sink: RenderSink, opts: InterpretOptions = {},
): void {
  // Read-only: `OptionalContent.Default` CREATES /OCProperties and marks the
  // document modified, which would turn a ToImage() before a Sign() into a full
  // rewrite. See defaultConfigIfPresent's own note.
  const config = doc.OptionalContent.defaultConfigIfPresent();
  const ctx: RenderCtx = {
    doc, sink, resources: page.Resources, depth: 0, seen: new Set(),
    oc: config ? { config, cache: new Map() } : undefined,
  };
  walk(ctx, page.Contents, initialState(base));
  if (opts.annotations !== false) drawAnnots(ctx, page, base, opts.hideWidgets);
}

/** Composite each visible annotation's /AP /N appearance over the page content
 *  (PDF 32000-1 §12.5.5). Each annotation is independent: it starts from a fresh
 *  graphics state — annotations do not inherit the page's, and one must not leak
 *  color/clip/text state into the next — and gets its own try/catch, so one
 *  malformed appearance cannot drop the annotations that follow it. */
function drawAnnots(
  ctx: RenderCtx, page: Page, base: Matrix, hide?: ReadonlySet<PdfDict>,
): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const e of annots) {
    const annot = ctx.doc.resolve(e);
    if (!isDict(annot) || !isAnnotVisible(ctx.doc, annot)) continue;
    if (hide?.has(annot)) continue;
    const ap = resolveAppearance(ctx.doc, annot);
    if (ap === undefined) continue;
    try {
      // drawForm re-applies the stream's /Matrix on top, giving the spec's
      // Matrix × place × base — placementMatrix already mapped the
      // /Matrix-transformed BBox onto /Rect, so this is not a double-apply.
      drawForm(ctx, initialState(mul(ap.place, base)), ap.stream);
    } catch {
      // Degrade: a malformed appearance costs only itself.
    }
  }
}

const MAX_XOBJECT_DEPTH = 8;

function walk(ctx: RenderCtx, bytes: Uint8Array, initial: GState, knockout = false): void {
  const sink = ctx.sink;
  const ops = parseContentStream(bytes);
  const gsStack: GState[] = [];
  let gs = initial;
  const baseCtm = initial.ctm;   // default coord space of this stream (for pattern matrices)
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
  const doFill = (evenOdd: boolean) => {
    flushClip();
    if (!path.length) return;
    syncPaintState(ctx, gs);
    if (gs.fillPattern) {
      // Fill through a pattern: clip to the path, then paint in pattern space
      // (pattern /Matrix ∘ this stream's default CTM).
      sink.save();
      sink.addClip(path, gs.ctm, evenOdd);
      if (gs.fillPattern.kind === 'shading') {
        sink.shading(gs.fillPattern.shading, mul(gs.fillPattern.matrix, baseCtm), true);
      } else {
        paintTiling(ctx, gs, gs.fillPattern, baseCtm);
      }
      sink.restore();
    } else {
      sink.fill(path, gs.ctm, gs.fill, evenOdd);
    }
  };
  const doStroke = () => {
    flushClip();
    if (!path.length) return;
    syncPaintState(ctx, gs, 'stroke');
    if (gs.strokePattern) {
      // Clip to the stroke's outline, then paint the pattern through it — the
      // rasterizer already outlines strokes in user space, so this reuses that.
      sink.save();
      sink.clipToStroke(path, gs.ctm, strokeStyle(gs));
      if (gs.strokePattern.kind === 'shading') {
        sink.shading(gs.strokePattern.shading, mul(gs.strokePattern.matrix, baseCtm), true);
      } else {
        paintTiling(ctx, gs, gs.strokePattern, baseCtm);
      }
      sink.restore();
    } else {
      sink.stroke(path, gs.ctm, gs.stroke, strokeStyle(gs));
    }
  };

  // Optional content: one entry per open BMC/BDC recording whether IT hid, so
  // nesting pops exactly. `hiddenDepth > 0` means the marks below are
  // suppressed; an unbalanced EMC is tolerated, as text.ts already tolerates it.
  let hiddenDepth = 0;
  const mcStack: boolean[] = [];

  // Text clipping (4gtd.2): the glyphs of EVERY show operator in the text
  // object accumulate, and their UNION becomes a clip at ET. Accumulating is
  // the whole point — `clipToGlyphs` INTERSECTS, so committing per run would
  // give the intersection of the runs, empty for any two that do not overlap,
  // and silently erase everything after ET.
  let pendingTextClip: TextRunInfo[] = [];
  const collectClip = (info: TextRunInfo) => { pendingTextClip.push(info); };

  // Bracket one top-level element of a knockout group so it composites against
  // the group's initial backdrop (§11.4.8). No-op outside a knockout group.
  //
  // **This is also the ONE gate for hidden optional content**, which is why it
  // is the only place that needs one: every painting operator goes through it —
  // the five path painters, the four text showers, the inline image, `Do` and
  // `sh`. A `Do` of a FORM is gated here too, which skips the form outright
  // rather than walking it with a flag; the two are equivalent because
  // `drawFormBody` brackets the child in `sink.save()`/`restore()` over a CLONED
  // state, so nothing inside a form can escape it — and skipping is cheaper.
  //
  // **The clip is flushed even when hidden.** `W f` sets a pending clip that its
  // PAINT operator flushes, so returning before `flushClip` would drop the clip
  // of every hidden `W f` — and "a clip set inside a hidden section still
  // applies to what follows" is precisely what this feature must not break.
  const element = (paint: () => void) => {
    if (hiddenDepth > 0) { flushClip(); return; }
    if (!knockout) { paint(); return; }
    sink.beginKnockoutElement();
    try { paint(); } finally { sink.endKnockoutElement(); }
  };

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
      case 'S': case 's': element(() => doStroke()); resetPath(); break;
      case 'f': case 'F': element(() => doFill(false)); resetPath(); break;
      case 'f*': element(() => doFill(true)); resetPath(); break;
      case 'B': case 'b': element(() => { doFill(false); doStroke(); }); resetPath(); break;
      case 'B*': case 'b*': element(() => { doFill(true); doStroke(); }); resetPath(); break;
      case 'n': flushClip(); resetPath(); break;

      // clipping (snapshot current path; applied at next paint)
      case 'W': pendingClip = { path: path.slice(), evenOdd: false }; break;
      case 'W*': pendingClip = { path: path.slice(), evenOdd: true }; break;

      // line style
      case 'w': gs.lineWidth = num(o[0]); break;
      case 'J': gs.cap = num(o[0]); break;
      case 'j': gs.join = num(o[0]); break;
      case 'M': gs.miter = num(o[0]); break;
      case 'd': { gs.dash = isArray(o[0]) ? numbers(o[0]) : []; gs.dashPhase = num(o[1]); break; }
      case 'gs': {
        const gn = o[0];
        if (isName(gn)) { applyExtGState(ctx, gs, gn.name); syncPaintState(ctx, gs); }
        break;
      }

      // color
      case 'g': gs.fillCs = deviceGray(); gs.fill = gs.fillCs.toRgb(numbers(o)); gs.fillPattern = undefined; break;
      case 'G': gs.strokeCs = deviceGray(); gs.stroke = gs.strokeCs.toRgb(numbers(o)); gs.strokePattern = undefined; break;
      case 'rg': gs.fillCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); gs.fillPattern = undefined; break;
      case 'RG': gs.strokeCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); gs.strokePattern = undefined; break;
      case 'k': gs.fillCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); gs.fillPattern = undefined; break;
      case 'K': gs.strokeCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); gs.strokePattern = undefined; break;
      case 'cs': gs.fillCs = lookupCs(ctx, o[0]); gs.fill = gs.fillCs.initial(); gs.fillPattern = undefined; break;
      case 'CS': gs.strokeCs = lookupCs(ctx, o[0]); gs.stroke = gs.strokeCs.initial(); gs.strokePattern = undefined; break;
      case 'sc': gs.fill = gs.fillCs.toRgb(numbers(o)); gs.fillPattern = undefined; break;
      case 'SC': gs.stroke = gs.strokeCs.toRgb(numbers(o)); gs.strokePattern = undefined; break;
      case 'scn': {
        gs.fillPattern = undefined;
        const last = o[o.length - 1];
        if (isName(last)) { gs.fillPattern = resolvePattern(ctx, last.name); gs.fill = [128, 128, 128]; }
        else gs.fill = gs.fillCs.toRgb(numbers(o));
        break;
      }
      case 'SCN': {
        const last = o[o.length - 1];
        gs.strokePattern = undefined;
        if (isName(last)) { gs.strokePattern = resolvePattern(ctx, last.name); gs.stroke = [128, 128, 128]; }
        else gs.stroke = gs.strokeCs.toRgb(numbers(o));
        break;
      }

      // text state
      case 'BT': gs.tm = IDENTITY; gs.tlm = IDENTITY; break;
      case 'ET':
        if (pendingTextClip.length) {
          // Fail OPEN: a sink that cannot outline these glyphs leaves the clip
          // UNCHANGED rather than clipping to nothing. More shows than the
          // document asked for, where the alternative makes the content that
          // follows vanish — visible ink beats vanished content, the rule
          // paintGlyphRun already follows for the same call.
          sink.clipToGlyphs(pendingTextClip);
          pendingTextClip = [];
        }
        break;
      case 'Tc': gs.charSp = num(o[0]); break;
      case 'Tw': gs.wordSp = num(o[0]); break;
      case 'Tz': gs.hscale = (num(o[0]) / 100) || 1; break;
      case 'TL': gs.leading = num(o[0]); break;
      case 'Ts': gs.rise = num(o[0]); break;
      case 'Tr': gs.textRender = num(o[0]) | 0; break;
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
      case 'Tj': element(() => showText(ctx, gs, o[0], baseCtm, collectClip)); break;
      case 'TJ': element(() => showArray(ctx, gs, o[0], baseCtm, collectClip)); break;
      case "'": textMove(gs, 0, -gs.leading); element(() => showText(ctx, gs, o[0], baseCtm, collectClip)); break;
      case '"': gs.wordSp = num(o[0]); gs.charSp = num(o[1]); textMove(gs, 0, -gs.leading); element(() => showText(ctx, gs, o[2], baseCtm, collectClip)); break;

      // images
      case 'BI':
        if (op.inlineImage) {
          const img = op.inlineImage;
          element(() => {
            syncPaintState(ctx, gs);
            // Normalized, NOT wrapped raw: an inline image's keys are the
            // abbreviations 32000-1 Table 93 mandates (/W, /H, /CS, /BPC) and
            // every decoder downstream reads full names. Handing the raw dict
            // over made each such image decode to nothing and draw nothing, in
            // both backends and with no error raised (`6dud`) -- while the
            // full-name spelling, which Table 93 equally permits, worked.
            sink.image(inlineImageToStream(img), gs.ctm, gs.fill);
          });
        }
        break;
      case 'Do': {
        const xn = o[0];
        const xobjs = resDict(ctx, 'XObject');
        if (!isName(xn) || !xobjs) break;
        const xo = ctx.doc.resolve(xobjs.get(xn.name));
        if (!isStream(xo)) break;
        // An /OC on the XObject DICTIONARY is the other half of the optional-
        // content vocabulary, and the half this library itself writes — through
        // AddImage({ layer }), AddBarcode({ layer }) and ImageInfo.Replace — so
        // without this we produced documents our own renderer ignored. One site
        // covers images and forms alike, because both subtypes arrive here.
        if (!ocVisible(ctx, xo.dict.get('OC'))) break;
        const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
        element(() => {
          if (isName(sub) && sub.name === 'Image') { syncPaintState(ctx, gs); sink.image(xo, gs.ctm, gs.fill); }
          else drawForm(ctx, gs, xo);
        });
        break;
      }

      // marked content (32000-1 14.6). Only /OC sections matter here; every
      // other tag still pushes, so an EMC pops the section it belongs to.
      case 'BMC': mcStack.push(false); break;
      case 'BDC': {
        const tag = o[0];
        // An /OC operand that is an INLINE DICTIONARY rather than a name in
        // /Properties is left VISIBLE rather than guessed at: hiding content on
        // a shape we did not resolve is the one error that loses ink.
        //
        // **Note, measured, and it covers NOTHING — the `prop !== undefined`
        // test is redundant and PROVABLY cannot be otherwise.** `doc.resolve`
        // answers `null` for an absent operand and `ResolveVisibility` returns
        // true for anything that is not a dict, so an unresolved name already
        // reads as visible by that route; dropping the test reddens not one
        // case. It stays as the honest spelling of "we hide only what we
        // resolved". Same class as `pagemode.ts`'s `isName` note — do not cite
        // the inline-dict fixture as covering it.
        const prop = isName(o[1]) ? resDict(ctx, 'Properties')?.get(o[1].name) : undefined;
        const hides = isName(tag) && tag.name === 'OC' && prop !== undefined
          && !ocVisible(ctx, prop);
        mcStack.push(hides);
        if (hides) hiddenDepth++;
        break;
      }
      case 'EMC':
        if (mcStack.length && mcStack.pop()) hiddenDepth--;
        break;

      // shading
      case 'sh': {
        const shDict = resDict(ctx, 'Shading');
        const sn = o[0];
        if (isName(sn) && shDict) {
          const sh = ctx.doc.resolve(shDict.get(sn.name));
          // The STREAM is passed on where there is one: a mesh shading keeps
          // its vertex data there, and taking `.dict` here would lose it.
          const shv = isStream(sh) ? sh : isDict(sh) ? sh : undefined;
          if (shv) { flushClip(); element(() => sink.shading(shv, gs.ctm, false)); }
        }
        break;
      }
    }
  }

  while (localSaves > 0) { sink.restore(); localSaves--; }
  sink.restore();              // close walk scope
}

/** Does this form's content use a non-Normal blend mode? An isolated group that
 *  blends internally needs an offscreen buffer even at alpha 1, because the
 *  blend must see the group's transparent backdrop rather than the page.
 *
 *  Scans the resource tree rather than parsing content: cheap, and done once per
 *  form. It over-triggers when an ExtGState declares a blend that is never used,
 *  which costs only a buffer — whereas under-triggering silently blends against
 *  the wrong backdrop. */
function groupContentBlends(
  doc: Document, stream: PdfStream, seen = new Set<PdfObject>(), depth = 0,
): boolean {
  if (depth > MAX_OFFSCREEN_DEPTH || seen.has(stream)) return false;   // resource cycles
  seen.add(stream);
  const res = doc.resolve(stream.dict.get('Resources'));
  if (!isDict(res)) return false;

  const egs = doc.resolve(res.get('ExtGState'));
  if (isDict(egs)) {
    for (const v of egs.values()) {
      const g = doc.resolve(v);
      if (!isDict(g)) continue;
      const bm = doc.resolve(g.get('BM'));
      // Same shape as applyExtGState: a name, or an array whose first name wins.
      const name = isName(bm) ? bm
        : isArray(bm) ? bm.map((x) => doc.resolve(x)).find((x) => isName(x))
        : undefined;
      if (isName(name) && blendModeFromName(name.name) !== 'Normal') return true;
    }
  }

  const xo = doc.resolve(res.get('XObject'));
  if (isDict(xo)) {
    for (const v of xo.values()) {
      const s = doc.resolve(v);
      if (!isStream(s)) continue;
      const st = doc.resolve(s.dict.get('Subtype'));
      if (isName(st) && st.name === 'Form'
        && groupContentBlends(doc, s, seen, depth + 1)) return true;
    }
  }
  return false;
}

/** Recurse into a Form XObject: /Matrix∘CTM, clip to /BBox, own /Resources,
 *  depth- and cycle-guarded. Uses sink.save/addClip/restore for the BBox clip. */
function drawForm(ctx: RenderCtx, gs: GState, stream: PdfStream): void {
  if (ctx.depth >= MAX_XOBJECT_DEPTH || ctx.seen.has(stream.dict)) return;

  // A transparency group needs its own buffer when compositing it as a unit
  // differs from drawing it inline — i.e. when group alpha, a blend mode, or a
  // soft mask applies. At alpha 1 / Normal / no mask the two are identical,
  // which describes most /Group forms, so the expensive path stays rare.
  //
  // /I is NOT a precondition for buffering. It defaults to false, so gating on
  // `/I true` left the ordinary /Group form drawing inline at ca < 1, where its
  // overlaps composite twice. /I instead selects *how* the buffer composites
  // down: an isolated group's inner blends see its own transparent backdrop, a
  // non-isolated group's see the page.
  //
  // An inner blend forces a buffer only when isolated — that is the whole point
  // of isolation. Non-isolated inner blends against the page are exactly what
  // inline drawing already produces.
  const grp = ctx.doc.resolve(stream.dict.get('Group'));
  const isTransparencyGroup = isDict(grp)
    && (() => { const s = ctx.doc.resolve(grp.get('S')); return isName(s) && s.name === 'Transparency'; })();
  const isolated = isTransparencyGroup && ctx.doc.resolve(grp.get('I')) === true;
  // A knockout group composites each element against the group's initial
  // backdrop rather than the accumulated result (§11.4.6.2), so it always needs
  // a buffer and — non-isolated — always needs the backdrop seeded, even at
  // alpha 1 / Normal with no inner blend.
  const knockout = isTransparencyGroup && ctx.doc.resolve(grp.get('K')) === true;
  // Memoized: the scan walks the resource tree, and the predicate below
  // short-circuits past it in the common case.
  let blendsMemo: boolean | undefined;
  const innerBlends = (): boolean =>
    (blendsMemo ??= groupContentBlends(ctx.doc, stream));
  const unitComposite = gs.fillAlpha < 1 || gs.blend !== 'Normal'
    || gs.softMask !== undefined;
  const needsBuffer = isTransparencyGroup
    && (unitComposite || (isolated && innerBlends()) || knockout)
    && ctx.depth < MAX_OFFSCREEN_DEPTH;
  // Seeding only changes the answer when the contents blend or knock out: with
  // Normal, non-knockout inner compositing, seeding and then removing the
  // backdrop recovers exactly the isolated result, so the plain path is both
  // cheaper and equivalent.
  const needsBackdrop = needsBuffer && !isolated && (innerBlends() || knockout);

  if (needsBuffer) {
    ctx.sink.beginOffscreen(undefined,
      (needsBackdrop || knockout) ? { backdrop: needsBackdrop, knockout } : undefined);
    const inner = clone(gs);
    // Contents draw at full strength into the buffer; alpha and blend apply
    // once, when the buffer composites down.
    inner.fillAlpha = 1; inner.strokeAlpha = 1; inner.blend = 'Normal';
    inner.softMask = undefined; inner.appliedMask = undefined;
    try {
      drawFormBody(ctx, inner, stream, knockout);
    } finally {
      ctx.sink.endOffscreen({ kind: 'group', alpha: gs.fillAlpha, blend: gs.blend, isolated, knockout });
    }
    return;
  }
  drawFormBody(ctx, gs, stream, false);
}

/** The form's own drawing: /Matrix∘CTM, clip to /BBox, own /Resources. */
function drawFormBody(ctx: RenderCtx, gs: GState, stream: PdfStream, knockout = false): void {
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
  walk(childCtx, bytes, childState, knockout);
  ctx.seen.delete(stream.dict);

  ctx.sink.restore();
}

/* ---------- Text rendering mode (32000-1 Table 106) ----------
 *
 *   0 fill   1 stroke   2 fill+stroke   3 invisible
 *   4 fill+clip   5 stroke+clip   6 fill+stroke+clip   7 clip
 *
 * Read off the table: 4-7 repeat 0-3 and ADD the clip, so the low two bits are
 * the PAINT half and `& 3` is the table rather than a trick. The clip half is
 * deliberately not implemented here — it is its own issue (4gtd.2) — so 7
 * paints nothing and 4-6 paint exactly as 0-2 do.
 */
export const fillsText = (mode: number): boolean => (mode & 3) === 0 || (mode & 3) === 2;
export const strokesText = (mode: number): boolean => (mode & 3) === 1 || (mode & 3) === 2;
const paintsText = (mode: number): boolean => fillsText(mode) || strokesText(mode);
/** Modes 4-7 ADD their glyphs to the clipping path (4gtd.2). Bit 2 IS the
 *  clip half of Table 106, the way the low two bits are the paint half. */
export const clipsText = (mode: number): boolean => (mode & 4) !== 0;

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
function showText(
  ctx: RenderCtx, gs: GState, strObj: PdfObject | undefined, baseCtm: Matrix,
  collectClip?: (info: TextRunInfo) => void,
): void {
  if (!isString(strObj) || !gs.font) return;
  // A stroke-ONLY run (Tr 1 and its clipping twin) reads /OP over the stroke
  // colour space; everything else reads /op over the fill one, which is also
  // what a mode that does both paints first.
  syncPaintState(ctx, gs,
    strokesText(gs.textRender) && !fillsText(gs.textRender) ? 'stroke' : 'fill');
  const decoded = gs.font.decodeRun(strObj.bytes);
  // A non-painting mode (3 and 7) is gated HERE rather than in each sink, so
  // all three sinks get it from one decision and none can disagree — and so a
  // run whose fill paint is a pattern paints nothing at all, where a gate
  // inside paintGlyphRun would still clip to the glyphs and paint through them.
  // The pen still advances: an invisible run occupies its width (9.4.4).
  const info: TextRunInfo = {
    font: gs.font, decoded,
    tm: gs.tm, ctm: gs.ctm, rise: gs.rise,
    fontSize: gs.fontSize, fontFamily: gs.fontFamily, bold: gs.fontBold, italic: gs.fontItalic, color: gs.fill,
    charSp: gs.charSp, wordSp: gs.wordSp, hscale: gs.hscale,
    mode: gs.textRender, strokeColor: gs.stroke, strokeStyle: strokeStyle(gs),
    bytes: strObj.bytes, fontDict: gs.fontRef,
  };
  // A clipping mode (4-7) ADDS this run's glyphs to the text object's clip,
  // which the walk commits at ET. A Type 3 glyph is a content stream with no
  // outline to contribute, so it is left out and the clip fails open — the
  // rule below for a sink that cannot build one.
  if (clipsText(gs.textRender) && !gs.font.type3) collectClip?.(info);

  if (!paintsText(gs.textRender)) { /* advance only */ }
  // A Type 3 glyph is a content stream, not an outline, so it never reaches a
  // sink's glyphRun — it is interpreted here and both backends see only the
  // primitives it draws.
  else if (gs.font.type3) drawType3Run(ctx, gs, gs.font, strObj.bytes);
  else paintGlyphRun(ctx, gs, info, baseCtm);
  const [dx, dy] = runDisplacement(
    decoded, gs.fontSize, gs.charSp, gs.wordSp, gs.hscale, gs.font.wmode === 1);
  gs.tm = mul(translate(dx, dy), gs.tm);
}

/**
 * Draw one show-string of a Type 3 font by executing each code's glyph
 * procedure (32000-1 9.6.5).
 *
 * The procedure runs in glyph space, which `/FontMatrix` maps to text space —
 * so it sits one step further in than a Form XObject: FontMatrix, then the text
 * parameters (size, `Tz`, `Ts`), then the pen offset, then Tm and the CTM.
 *
 * **Invariant:** the pen advances per glyph exactly as `runDisplacement`
 * advances the whole run afterwards. Both go through `glyphDisplacement`, which
 * is what keeps the ink and the text matrix from disagreeing about a `Tc`.
 *
 * A procedure is ordinary content: it may show text in another font — including
 * this one — or draw a form. `ctx.seen` and the depth bound are what stop a
 * font whose glyph shows itself, since a charproc has no /BBox to shrink into
 * and would otherwise recurse at full size forever.
 */
function drawType3Run(ctx: RenderCtx, gs: GState, font: TextFont, bytes: Uint8Array): void {
  const t3 = font.type3;
  if (!t3 || ctx.depth >= MAX_XOBJECT_DEPTH) return;
  const base = mul(gs.tm, gs.ctm);
  const param: Matrix = [gs.fontSize * gs.hscale, 0, 0, gs.fontSize, 0, gs.rise];
  let pen = 0;
  for (const g of font.decodeGlyphs(bytes)) {
    const proc = t3.procs.get(g.code);
    if (proc && !ctx.seen.has(proc.dict)) {
      drawGlyphProc(ctx, gs, proc, mul(t3.fontMatrix, mul(param, mul(translate(pen, 0), base))), t3.resources);
    }
    // Type 3 is a simple font and so always horizontal; only x advances.
    pen += glyphDisplacement(g, gs.fontSize, gs.charSp, gs.wordSp, gs.hscale)[0];
  }
}

/** Interpret one glyph procedure at `ctm`. Unlike a Form XObject it has no
 *  /Matrix and no /BBox: the font matrix is already folded into `ctm`, and a
 *  glyph is not clipped to anything. Resources absent from the font fall back to
 *  the showing stream's, which is what the procedure was written against. */
function drawGlyphProc(
  ctx: RenderCtx, gs: GState, proc: PdfStream, ctm: Matrix, resources: PdfDict | undefined,
): void {
  let bytes: Uint8Array;
  try { bytes = inflateStream(proc as Parameters<typeof inflateStream>[0]); } catch { return; }
  const state = clone(gs);
  state.ctm = ctm;
  ctx.seen.add(proc.dict);
  try {
    walk({ ...ctx, resources: resources ?? ctx.resources, depth: ctx.depth + 1 }, bytes, state);
  } catch {
    // Degrade: whatever the glyph drew before failing stays, and the rest of
    // the run still draws.
  } finally {
    ctx.seen.delete(proc.dict);
  }
}

/** Draw one glyph run: solid through the sink's glyphRun, or — when a pattern is
 *  the fill paint — by clipping to the glyph outlines and painting the pattern
 *  through them, exactly as doFill does for a path.
 *
 *  Only the FILL paint can be a pattern here. A stroking text rendering mode (1
 *  or 2) under an `SCN` pattern strokes solid in the stroke colour instead — no
 *  caller has asked for the twin, and it would need a second clip path over the
 *  stroke outline rather than the glyph outline. A NON-painting mode (3 and 7)
 *  never reaches this function at all: `showText` gates it, so a mode-3 run with
 *  a pattern fill paints nothing rather than clipping and painting through.
 *
 *  **Invariant:** a sink that cannot build the glyph clip falls back to the solid
 *  run. `info.color` is then the [128,128,128] placeholder `scn` stores, which is
 *  visibly wrong — but visible ink beats text that vanishes, the same rule
 *  svgdraw.ts follows for an element it cannot render fully. */
function paintGlyphRun(ctx: RenderCtx, gs: GState, info: TextRunInfo, baseCtm: Matrix): void {
  const pat = gs.fillPattern;
  if (!pat) { ctx.sink.glyphRun(info); return; }
  ctx.sink.save();
  if (!ctx.sink.clipToGlyphs([info])) ctx.sink.glyphRun(info);
  else if (pat.kind === 'shading') ctx.sink.shading(pat.shading, mul(pat.matrix, baseCtm), true);
  else paintTiling(ctx, gs, pat, baseCtm);
  ctx.sink.restore();
}

function showArray(
  ctx: RenderCtx, gs: GState, arrObj: PdfObject | undefined, baseCtm: Matrix,
  collectClip?: (info: TextRunInfo) => void,
): void {
  if (!isArray(arrObj) || !gs.font) return;
  for (const el of arrObj) {
    if (isString(el)) showText(ctx, gs, el, baseCtm, collectClip);
    else if (typeof el === 'number') {
      const [dx, dy] = tjShift(el, gs.fontSize, gs.hscale, gs.font.wmode === 1);
      gs.tm = mul(translate(dx, dy), gs.tm);
    }
  }
}
