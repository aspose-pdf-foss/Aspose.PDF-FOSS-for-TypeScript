import { SfntFont } from './sfnt.js';
import { applyGsub, applyGpos, type ShapedGlyph, type OtTable, type Gdef } from './otlayout.js';
import { reorderLine, itemizeScripts, arabicJoiningForms } from './bidi.js';

export interface PositionedGlyph {
  gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number;
  /** Draw-time character-code alias when one outline represents different text. */
  code?: number;
}
export interface ShapedRun { glyphs: PositionedGlyph[]; rtl: boolean; }
export interface ShapeOpts {
  dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string;
  /** Font feature overrides; absent tags keep the shaping defaults. */
  features?: Readonly<Record<string, boolean>>;
}

// General features applied across a whole segment buffer, in application order.
const GSUB_FEATURES = ['ccmp', 'liga', 'rlig', 'calt'];
const GPOS_FEATURES = ['kern', 'mark', 'mkmk'];
const ARABIC_TAG = 'arab';
const JOINING_FEATURES = new Set(['init', 'medi', 'fina', 'isol']);

/** Validate the JavaScript option boundary before any drawing side effects. @internal */
export function validateFeatures(features: ShapeOpts['features']): void {
  if (features === undefined) return;
  if (features === null || typeof features !== 'object' || Array.isArray(features))
    throw new TypeError('features must be a map of four-character OpenType tags to booleans');
  for (const [tag, on] of Object.entries(features)) {
    if (!/^[\x20-\x7e]{4}$/.test(tag) || typeof on !== 'boolean')
      throw new TypeError('features must map four printable ASCII characters to booleans');
  }
}

function enabledFeatures(defaults: string[], features: ShapeOpts['features'], joining: boolean): string[] {
  const enabled = new Set(defaults);
  if (features) for (const [tag, on] of Object.entries(features)) {
    if (joining && JOINING_FEATURES.has(tag)) continue;
    if (on) enabled.add(tag); else enabled.delete(tag);
  }
  return [...enabled];
}

/** Shape `text` with `sfnt` into visual-order positioned runs. Pure; never throws
 *  for missing/malformed layout tables (Phase-1 apply* degrade to pass-through). */
export function shapeText(text: string, sfnt: SfntFont, opts: ShapeOpts = {}): ShapedRun[] {
  validateFeatures(opts.features);
  const gsubFeatures = enabledFeatures(GSUB_FEATURES, opts.features, true);
  const gposFeatures = enabledFeatures(GPOS_FEATURES, opts.features, false);
  const codes = [...text].map((c) => c.codePointAt(0)!);
  if (codes.length === 0) return [];
  const dir = opts.dir ?? 'auto';
  const layout = sfnt.otLayout();
  const gsub = layout?.gsub, gpos = layout?.gpos, gdef = layout?.gdef;

  // Bidi: visual order + per-logical-position embedding levels.
  const { levels, order } = reorderLine(codes, dir);
  // Itemize the LOGICAL sequence by script; each segment inherits its bidi run's
  // direction (odd level = RTL). Split further where the level changes.
  const segs = itemizeScripts(codes);

  const runs: ShapedRun[] = [];
  for (const seg of segs) {
    for (const sub of splitByLevel(seg, levels)) {
      const otTag = opts.script ?? sub.otTag;
      const rtl = (levels[sub.start] & 1) === 1;
      const glyphs = shapeSegment(codes, sub.start, sub.end, sfnt, gsub, gpos, gdef, otTag, opts.language, rtl,
        gsubFeatures, gposFeatures, opts.features);
      if (glyphs.length) runs.push({ glyphs, rtl });
    }
  }
  // Order runs left-to-right by their leftmost visual position.
  runs.sort((a, b) => visualPos(a, order) - visualPos(b, order));
  return runs;
}

interface Seg { start: number; end: number; otTag: string; }
function splitByLevel(seg: { start: number; end: number; otTag: string }, levels: Int8Array): Seg[] {
  const out: Seg[] = [];
  let s = seg.start;
  for (let i = seg.start + 1; i <= seg.end; i++) {
    if (i === seg.end || levels[i] !== levels[s]) { out.push({ start: s, end: i, otTag: seg.otTag }); s = i; }
  }
  return out;
}

// Leftmost visual index of a run's clusters, for left-to-right run ordering.
function visualPos(run: ShapedRun, order: number[]): number {
  let min = Infinity;
  for (const g of run.glyphs) { const v = order.indexOf(g.cluster); if (v >= 0 && v < min) min = v; }
  return min;
}

function shapeSegment(
  codes: number[], start: number, end: number, sfnt: SfntFont,
  gsub: OtTable | undefined, gpos: OtTable | undefined,
  gdef: Gdef | undefined, otTag: string, lang: string | undefined, rtl: boolean,
  gsubFeatures: string[], gposFeatures: string[], features: ShapeOpts['features'],
): PositionedGlyph[] {
  // cmap → nominal gids (record source cluster = code-point index).
  const buf: ShapedGlyph[] = [];
  for (let i = start; i < end; i++) {
    const gid = sfnt.cmapLookup(codes[i]);
    if (gid === undefined) continue;
    buf.push({ gid, cluster: i, xAdvance: sfnt.advanceWidth(gid), xOffset: 0, yOffset: 0 });
  }
  if (buf.length === 0) return [];

  // Arabic: per-glyph joining-form substitution (single-glyph slices — the forms
  // are non-contextual Single Substitutions keyed by nominal glyph).
  if (gsub && otTag === ARABIC_TAG) applyJoiningForms(codes, start, end, buf, gsub, gdef, otTag, lang, features);

  // General GSUB (ligatures / contextual), then re-seed advances, then GPOS.
  if (gsub) applyGsub(gsub, buf, gdef, otTag, lang, gsubFeatures);
  for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid);
  if (gpos) applyGpos(gpos, buf, gdef, otTag, lang, gposFeatures, rtl);

  // Shape logical, reverse for RTL visual emission.
  const glyphs: PositionedGlyph[] = buf.map((g) => ({ gid: g.gid, cluster: g.cluster, xAdvance: g.xAdvance, xOffset: g.xOffset, yOffset: g.yOffset }));
  if (rtl) glyphs.reverse();
  return glyphs;
}

// Substitute each glyph's Arabic positional form on a single-glyph buffer so the
// form feature applies exactly at that position and nowhere else.
function applyJoiningForms(
  codes: number[], start: number, end: number, buf: ShapedGlyph[],
  gsub: OtTable, gdef: Gdef | undefined,
  otTag: string, lang: string | undefined,
  features: ShapeOpts['features'],
): void {
  const forms = arabicJoiningForms(codes, start, end);
  // buf is aligned to the cmappable subset of [start,end); recompute alignment by
  // walking clusters (buf[k].cluster is the code index).
  for (let k = 0; k < buf.length; k++) {
    const form = forms[buf[k].cluster - start];
    if (!form || features?.[form] === false) continue;
    const one: ShapedGlyph[] = [buf[k]];
    applyGsub(gsub, one, gdef, otTag, lang, [form]);
    buf.splice(k, 1, ...one);
    k += one.length - 1;
  }
}

/** Total advance of all runs, in font design units. */
export function measureShaped(runs: ShapedRun[]): number {
  let w = 0;
  for (const r of runs) for (const g of r.glyphs) w += g.xAdvance;
  return w;
}
