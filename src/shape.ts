import { SfntFont } from './sfnt.js';
import { applyGsub, applyGpos, type ShapedGlyph, type OtTable, type Gdef } from './otlayout.js';
import { reorderLine, itemizeScripts, arabicJoiningForms } from './bidi.js';

export interface PositionedGlyph { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number; }
export interface ShapedRun { glyphs: PositionedGlyph[]; rtl: boolean; }
export interface ShapeOpts { dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string; }

// General features applied across a whole segment buffer, in application order.
const GSUB_FEATURES = ['ccmp', 'liga', 'rlig', 'calt'];
const GPOS_FEATURES = ['kern', 'mark', 'mkmk'];
const ARABIC_TAG = 'arab';

/** Shape `text` with `sfnt` into visual-order positioned runs. Pure; never throws
 *  for missing/malformed layout tables (Phase-1 apply* degrade to pass-through). */
export function shapeText(text: string, sfnt: SfntFont, opts: ShapeOpts = {}): ShapedRun[] {
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
      const glyphs = shapeSegment(codes, sub.start, sub.end, sfnt, gsub, gpos, gdef, otTag, opts.language, rtl);
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
  if (gsub && otTag === ARABIC_TAG) applyJoiningForms(codes, start, end, buf, gsub, gdef, otTag, lang);

  // General GSUB (ligatures / contextual), then re-seed advances, then GPOS.
  if (gsub) applyGsub(gsub, buf, gdef, otTag, lang, GSUB_FEATURES);
  for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid);
  if (gpos) applyGpos(gpos, buf, gdef, otTag, lang, GPOS_FEATURES, rtl);

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
): void {
  const forms = arabicJoiningForms(codes, start, end);
  // buf is aligned to the cmappable subset of [start,end); recompute alignment by
  // walking clusters (buf[k].cluster is the code index).
  for (let k = 0; k < buf.length; k++) {
    const form = forms[buf[k].cluster - start];
    if (!form) continue;
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
