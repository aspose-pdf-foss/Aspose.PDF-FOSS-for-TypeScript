// OpenType Layout (GDEF/GSUB/GPOS) parse + apply. Zero deps — only DataView reads
// over the input font bytes. Degrades to a no-op on malformed data — the public
// entry points never throw, matching the library's "unsupported content degrades"
// convention.

import type { SfntFont } from './sfnt.js';

/** The mutable shaping buffer element. GSUB rewrites gid/cluster; GPOS fills advances/offsets. */
export interface ShapedGlyph {
  gid: number;       // current glyph id
  cluster: number;   // smallest source index this glyph descends from (merges on ligature)
  xAdvance: number;  // font units; seeded from hmtx, adjusted by GPOS
  xOffset: number;   // font units; GPOS placement (0 until positioned)
  yOffset: number;   // font units; GPOS placement (0 until positioned)
  ligId?: number;    // ligature identity (set on the ligature glyph and its component marks); undefined = not ligated
  ligComp?: number;  // component index within the ligature this glyph belongs to (0-based)
  cursiveParent?: number; // buffer index this glyph is cursively attached to; resolved by propagateCursive
}

// LookupFlag bits.
const RIGHT_TO_LEFT = 0x0001, IGNORE_BASE = 0x0002, IGNORE_LIGATURES = 0x0004,
  IGNORE_MARKS = 0x0008, USE_MARK_FILTERING_SET = 0x0010, MARK_ATTACH_TYPE = 0xFF00;

/** Big-endian reader over a slice; every read is at an absolute byte position `p`. */
export class OtReader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(p: number): number { return this.view.getUint16(p); }
  i16(p: number): number { return this.view.getInt16(p); }
  u32(p: number): number { return this.view.getUint32(p); }
  tag(p: number): string { return String.fromCharCode(this.bytes[p], this.bytes[p + 1], this.bytes[p + 2], this.bytes[p + 3]); }
}

export interface Coverage { index(gid: number): number; }

/** Parse a Coverage table at `off` within `bytes`. `index` returns -1 if absent. */
export function parseCoverage(bytes: Uint8Array, off: number): Coverage {
  const r = new OtReader(bytes);
  const format = r.u16(off);
  if (format === 1) {
    const count = r.u16(off + 2);
    const map = new Map<number, number>();
    for (let i = 0; i < count; i++) map.set(r.u16(off + 4 + i * 2), i);
    return { index: (g) => map.get(g) ?? -1 };
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    const ranges: { start: number; end: number; base: number }[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({ start: r.u16(p), end: r.u16(p + 2), base: r.u16(p + 4) });
    }
    return {
      index: (g) => {
        for (const rg of ranges) if (g >= rg.start && g <= rg.end) return rg.base + (g - rg.start);
        return -1;
      },
    };
  }
  return { index: () => -1 };
}

export interface ClassDef { classOf(gid: number): number; }

/** Parse a ClassDef table at `off`. Unlisted gids are class 0. */
export function parseClassDef(bytes: Uint8Array, off: number): ClassDef {
  const r = new OtReader(bytes);
  const format = r.u16(off);
  if (format === 1) {
    const startGid = r.u16(off + 2);
    const count = r.u16(off + 4);
    const classes: number[] = [];
    for (let i = 0; i < count; i++) classes.push(r.u16(off + 6 + i * 2));
    return { classOf: (g) => (g >= startGid && g < startGid + count) ? classes[g - startGid] : 0 };
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    const ranges: { start: number; end: number; cls: number }[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({ start: r.u16(p), end: r.u16(p + 2), cls: r.u16(p + 4) });
    }
    return {
      classOf: (g) => {
        for (const rg of ranges) if (g >= rg.start && g <= rg.end) return rg.cls;
        return 0;
      },
    };
  }
  return { classOf: () => 0 };
}

export interface OtTable { scripts: Map<string, ScriptTable>; features: FeatureRecord[]; lookups: Lookup[]; }
export interface ScriptTable { dfltFeatures?: number[]; langSys: Map<string, number[]>; }
export interface FeatureRecord { tag: string; lookupIndices: number[]; }
export interface Lookup { type: number; flag: number; markFilteringSet?: number; subtables: Uint8Array[]; }

function parseLangSys(r: OtReader, off: number): number[] {
  // lookupOrder(u16, ignored) requiredFeatureIndex(u16) featureIndexCount(u16) featureIndices[]
  const req = r.u16(off + 2);
  const count = r.u16(off + 4);
  const idx: number[] = [];
  if (req !== 0xFFFF) idx.push(req);
  for (let i = 0; i < count; i++) idx.push(r.u16(off + 6 + i * 2));
  return idx;
}

function parseScriptList(r: OtReader, off: number): Map<string, ScriptTable> {
  const out = new Map<string, ScriptTable>();
  const count = r.u16(off);
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 6;
    const t = r.tag(rec);
    const stOff = off + r.u16(rec + 4);           // ScriptTable off is from ScriptList start
    const dfltOff = r.u16(stOff);                 // from ScriptTable start (0 = none)
    const langCount = r.u16(stOff + 2);
    const st: ScriptTable = { langSys: new Map() };
    if (dfltOff) st.dfltFeatures = parseLangSys(r, stOff + dfltOff);
    for (let j = 0; j < langCount; j++) {
      const lrec = stOff + 4 + j * 6;
      st.langSys.set(r.tag(lrec), parseLangSys(r, stOff + r.u16(lrec + 4)));
    }
    out.set(t, st);
  }
  return out;
}

function parseFeatureList(r: OtReader, off: number): FeatureRecord[] {
  const count = r.u16(off);
  const out: FeatureRecord[] = [];
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 6;
    const t = r.tag(rec);
    const fOff = off + r.u16(rec + 4);            // Feature off from FeatureList start
    const lookupCount = r.u16(fOff + 2);          // skip featureParams(u16)
    const lookupIndices: number[] = [];
    for (let k = 0; k < lookupCount; k++) lookupIndices.push(r.u16(fOff + 4 + k * 2));
    out.push({ tag: t, lookupIndices });
  }
  return out;
}

function parseLookupList(r: OtReader, off: number): Lookup[] {
  const count = r.u16(off);
  const out: Lookup[] = [];
  for (let i = 0; i < count; i++) {
    const lkOff = off + r.u16(off + 2 + i * 2);   // Lookup off from LookupList start
    const type = r.u16(lkOff);
    const flag = r.u16(lkOff + 2);
    const subCount = r.u16(lkOff + 4);
    const subtables: Uint8Array[] = [];
    for (let s = 0; s < subCount; s++) {
      const subOff = lkOff + r.u16(lkOff + 6 + s * 2); // subtable off from Lookup start
      subtables.push(r.bytes.subarray(subOff));        // slice from subtable start to end of table
    }
    const lk: Lookup = { type, flag, subtables };
    if (flag & USE_MARK_FILTERING_SET) lk.markFilteringSet = r.u16(lkOff + 6 + subCount * 2);
    out.push(lk);
  }
  return out;
}

/** Parse one GSUB or GPOS table header + sub-structure. `undefined` on malformed. */
export function parseOtTable(bytes: Uint8Array): OtTable | undefined {
  try {
    const r = new OtReader(bytes);
    const scriptOff = r.u16(4), featureOff = r.u16(6), lookupOff = r.u16(8);
    return {
      scripts: parseScriptList(r, scriptOff),
      features: parseFeatureList(r, featureOff),
      lookups: parseLookupList(r, lookupOff),
    };
  } catch { return undefined; }
}

/** Enabled lookup indices for (script, lang, features), in lookup-list order. */
export function resolveLookups(t: OtTable, script: string | undefined, lang: string | undefined, features: string[]): number[] {
  const want = new Set(features);
  let st = (script && t.scripts.get(script)) || t.scripts.get('DFLT') || t.scripts.get('dflt');
  if (!st) { const first = t.scripts.values().next(); st = first.done ? undefined : first.value; }
  if (!st) return [];
  const featureIdx = (lang && st.langSys.get(lang)) || st.dfltFeatures || [];
  const lookups = new Set<number>();
  for (const fi of featureIdx) {
    const f = t.features[fi];
    if (f && want.has(f.tag)) for (const li of f.lookupIndices) lookups.add(li);
  }
  return [...lookups].sort((a, b) => a - b);
}

export interface Gdef { glyphClass?: ClassDef; markAttachClass?: ClassDef; markGlyphSets?: Coverage[]; }

/** Parse a GDEF table. `undefined` on malformed. */
export function parseGdef(bytes: Uint8Array): Gdef | undefined {
  try {
    const r = new OtReader(bytes);
    const minor = r.u16(2);
    const glyphClassOff = r.u16(4);
    const markAttachOff = r.u16(10);
    const g: Gdef = {};
    if (glyphClassOff) g.glyphClass = parseClassDef(bytes, glyphClassOff);
    if (markAttachOff) g.markAttachClass = parseClassDef(bytes, markAttachOff);
    if (minor >= 2) {
      const setsOff = r.u16(12);
      if (setsOff) {
        const count = r.u16(setsOff + 2);       // MarkGlyphSetsTable: format(u16) count(u16) coverageOffsets[](u32)
        const sets: Coverage[] = [];
        for (let i = 0; i < count; i++) sets.push(parseCoverage(bytes, setsOff + r.u32(setsOff + 4 + i * 4)));
        g.markGlyphSets = sets;
      }
    }
    return g;
  } catch { return undefined; }
}

/** "Should this lookup ignore glyph `gid`?" per LookupFlag + GDEF. */
export class GlyphFilter {
  private markAttach: number;
  constructor(private gdef: Gdef | undefined, private flag: number, private markSet: number | undefined) {
    this.markAttach = (flag & MARK_ATTACH_TYPE) >> 8;
  }
  get rtl(): boolean { return (this.flag & RIGHT_TO_LEFT) !== 0; }
  skip(gid: number): boolean {
    const cls = this.gdef?.glyphClass?.classOf(gid) ?? 0;
    if ((this.flag & IGNORE_BASE) && cls === 1) return true;
    if ((this.flag & IGNORE_LIGATURES) && cls === 2) return true;
    if (cls === 3) { // mark
      if (this.flag & IGNORE_MARKS) return true;
      if ((this.flag & USE_MARK_FILTERING_SET) && this.markSet !== undefined) {
        const cov = this.gdef?.markGlyphSets?.[this.markSet];
        if (cov && cov.index(gid) === -1) return true; // mark not in the filtering set -> skip
      } else if (this.markAttach) {
        const ma = this.gdef?.markAttachClass?.classOf(gid) ?? 0;
        if (ma !== this.markAttach) return true;       // mark not of the required attach class -> skip
      }
    }
    return false;
  }
}

/** Index of the next non-ignored glyph at or after `from`, or buf.length. */
function nextInput(buf: ShapedGlyph[], from: number, filter: GlyphFilter): number {
  let i = from;
  while (i < buf.length && filter.skip(buf[i].gid)) i++;
  return i;
}

/** Apply one GSUB lookup across the buffer (left->right; type 8 handled reversed). */
export function applyGsubLookup(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  if (lk.type === 8) { applyReverseChain(lk, buf, gdef); return; }
  let i = 0;
  while (i < buf.length) {
    if (filter.skip(buf[i].gid)) { i++; continue; }
    const consumed = applyGsubAt(lk, buf, i, filter, gdef, layout);
    i += consumed > 0 ? consumed : 1;
  }
}

/** Try each subtable at position `i`. Returns glyphs consumed (>=1) or 0 if no match. */
function applyGsubAt(lk: Lookup, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  for (const raw of lk.subtables) {
    const { type, sub } = resolveExtension(lk.type, raw);
    const n = gsubSubtable(type, sub, buf, i, filter, gdef, layout);
    if (n > 0) return n;
  }
  return 0;
}

function gsubSubtable(type: number, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  const r = new OtReader(sub);
  switch (type) {
    case 1: return gsubSingle(r, sub, buf, i);
    case 2: return gsubMultiple(r, sub, buf, i);
    case 3: return gsubAlternate(r, sub, buf, i);
    case 4: return gsubLigature(r, sub, buf, i, filter);
    case 5: return gsubContext(r, sub, buf, i, filter, gdef, layout);
    case 6: return gsubChain(r, sub, buf, i, filter, gdef, layout);
    default: return 0;
  }
}

function gsubMultiple(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const seqCount = r.u16(4);
  if (ci >= seqCount) return 0;
  const seqOff = r.u16(6 + ci * 2);
  const glyphCount = r.u16(seqOff);
  const cluster = buf[i].cluster;
  const outs: ShapedGlyph[] = [];
  for (let g = 0; g < glyphCount; g++) outs.push({ gid: r.u16(seqOff + 2 + g * 2), cluster, xAdvance: 0, xOffset: 0, yOffset: 0 });
  buf.splice(i, 1, ...outs);
  return Math.max(1, glyphCount);
}

function gsubAlternate(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const setCount = r.u16(4);
  if (ci >= setCount) return 0;
  const setOff = r.u16(6 + ci * 2);
  if (r.u16(setOff) < 1) return 0;                    // glyphCount
  buf[i].gid = r.u16(setOff + 2);                     // first alternate
  return 1;
}

function gsubSingle(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  if (format === 1) buf[i].gid = (buf[i].gid + r.i16(4)) & 0xffff;
  else if (format === 2) buf[i].gid = r.u16(6 + ci * 2);
  else return 0;
  return 1;
}

// Monotonic ligature-id source. Only needs to be distinct among ligatures that
// coexist in one shaping buffer, so a never-resetting counter is sufficient.
let nextLigId = 1;

function gsubLigature(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const setCount = r.u16(4);
  if (ci >= setCount) return 0;
  const setOff = r.u16(6 + ci * 2);
  const ligCount = r.u16(setOff);
  for (let l = 0; l < ligCount; l++) {
    const ligOff = setOff + r.u16(setOff + 2 + l * 2);
    const ligGlyph = r.u16(ligOff);
    const compCount = r.u16(ligOff + 2);              // includes the first (coverage) component
    const matched: number[] = [i];
    let p = i;
    let ok = true;
    for (let c = 1; c < compCount; c++) {
      p = nextInput(buf, p + 1, filter);
      if (p >= buf.length || buf[p].gid !== r.u16(ligOff + 4 + (c - 1) * 2)) { ok = false; break; }
      matched.push(p);
    }
    if (!ok) continue;
    const minCluster = Math.min(...matched.map((m) => buf[m].cluster));
    // Component tracking (for mark-to-ligature): give this ligature a fresh id and
    // record, for each mark that survives the ligation, which component it belongs
    // to. Marks skipped *between* matched components c and c+1 belong to component
    // c; marks trailing the last matched component belong to the last component.
    const ligId = nextLigId++;
    const lastPos = matched[matched.length - 1];
    let comp = 0;
    for (let pos = i + 1; pos < lastPos; pos++) {
      const mIdx = matched.indexOf(pos);
      if (mIdx >= 0) { comp = mIdx; continue; }              // reached the next component
      buf[pos].ligId = ligId; buf[pos].ligComp = comp;        // interspersed mark
    }
    for (let pos = lastPos + 1; pos < buf.length && filter.skip(buf[pos].gid); pos++) {
      buf[pos].ligId = ligId; buf[pos].ligComp = compCount - 1; // trailing mark -> last component
    }
    buf[i].gid = ligGlyph;
    buf[i].cluster = minCluster;
    buf[i].ligId = ligId; buf[i].ligComp = 0;
    for (let k = matched.length - 1; k >= 1; k--) buf.splice(matched[k], 1);
    return 1;
  }
  return 0;
}

/** Top-level: run every GSUB lookup enabled for (script, lang, features). */
export function applyGsub(t: OtTable, buf: ShapedGlyph[], gdef: Gdef | undefined, script: string | undefined, lang: string | undefined, features: string[]): void {
  for (const li of resolveLookups(t, script, lang, features)) {
    const lk = t.lookups[li];
    if (lk) applyGsubLookup(lk, buf, gdef, t);
  }
}

// Extension (GSUB 7 / GPOS 9) unwrap; replaced/extended in later tasks.
function resolveExtension(type: number, sub: Uint8Array): { type: number; sub: Uint8Array } {
  if (type !== 7 && type !== 9) return { type, sub };
  const r = new OtReader(sub);
  if (r.u16(0) !== 1) return { type, sub };
  return { type: r.u16(2), sub: sub.subarray(r.u32(4)) };
}

// Reverse chaining single (type 8); implemented in Task 6.
function applyReverseChain(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined): void { applyReverseChainImpl(lk, buf, gdef); }

// ─── Contextual / chaining shared engine (GSUB 5/6, GPOS 7/8) ───
type Pred = (g: number) => boolean;
const trueP: Pred = () => true;
const eqPred = (gid: number): Pred => (g) => g === gid;
const classPred = (cd: ClassDef, cls: number): Pred => (g) => cd.classOf(g) === cls;

interface SeqLookup { seqIndex: number; lookupIndex: number; }
function readSeqLookups(r: OtReader, off: number, count: number): SeqLookup[] {
  const out: SeqLookup[] = [];
  for (let k = 0; k < count; k++) out.push({ seqIndex: r.u16(off + k * 4), lookupIndex: r.u16(off + 2 + k * 4) });
  return out;
}

function readCovPreds(r: OtReader, sub: Uint8Array, off: number, count: number): Pred[] {
  const preds: Pred[] = [];
  for (let k = 0; k < count; k++) { const cov = parseCoverage(sub, r.u16(off + k * 2)); preds.push((g) => cov.index(g) >= 0); }
  return preds;
}

/** Match backtrack/input/lookahead predicates around `i`. `input[0]` tests buf[i].
 *  Returns matched input positions (buf indices) or null. */
function matchChain(buf: ShapedGlyph[], i: number, filter: GlyphFilter, back: Pred[], input: Pred[], ahead: Pred[]): number[] | null {
  const inputPos: number[] = [i];
  if (!input[0](buf[i].gid)) return null;
  let p = i;
  for (let k = 1; k < input.length; k++) {
    p = nextInput(buf, p + 1, filter);
    if (p >= buf.length || !input[k](buf[p].gid)) return null;
    inputPos.push(p);
  }
  let a = inputPos[inputPos.length - 1];
  for (let k = 0; k < ahead.length; k++) {
    a = nextInput(buf, a + 1, filter);
    if (a >= buf.length || !ahead[k](buf[a].gid)) return null;
  }
  let bt = i;
  for (let k = 0; k < back.length; k++) {
    bt--; while (bt >= 0 && filter.skip(buf[bt].gid)) bt--;
    if (bt < 0 || !back[k](buf[bt].gid)) return null;
  }
  return inputPos;
}

function applySeqLookupsGsub(recs: SeqLookup[], inputPos: number[], buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable): void {
  for (const rec of recs) {
    const pos = inputPos[rec.seqIndex];
    const lk = layout.lookups[rec.lookupIndex];
    if (pos === undefined || !lk) continue;
    const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
    applyGsubAt(lk, buf, pos, filter, gdef, layout);
  }
}

// GSUB contextual (type 5): formats 1 and 3 (2 degrades to no-op).
function gsubContext(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  const format = r.u16(0);
  if (format === 3) {
    let p = 2;
    const gc = r.u16(p); p += 2; const input = readCovPreds(r, sub, p, gc); p += gc * 2;
    const rc = r.u16(p); p += 2; const recs = readSeqLookups(r, p, rc);
    const m = matchChain(buf, i, filter, [], input, ahead0);
    if (!m) return 0;
    applySeqLookupsGsub(recs, m, buf, gdef, layout);
    return Math.max(1, m.length);
  }
  if (format === 2) {
    const res = contextFmt2Match(sub, buf, i, filter, false);
    if (!res) return 0;
    applySeqLookupsGsub(res.recs, res.m, buf, gdef, layout);
    return Math.max(1, res.m.length);
  }
  if (format === 1) return contextFmt1(r, sub, buf, i, filter, gdef, layout, false);
  return 0;
}

// GSUB chaining (type 6): formats 1 and 3 (2 degrades to no-op).
function gsubChain(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  const format = r.u16(0);
  if (format === 3) {
    const c = chain3Preds(r, sub);
    const m = matchChain(buf, i, filter, c.back, c.input, c.ahead);
    if (!m) return 0;
    applySeqLookupsGsub(c.recs, m, buf, gdef, layout);
    return Math.max(1, m.length);
  }
  if (format === 2) {
    const res = contextFmt2Match(sub, buf, i, filter, true);
    if (!res) return 0;
    applySeqLookupsGsub(res.recs, res.m, buf, gdef, layout);
    return Math.max(1, res.m.length);
  }
  if (format === 1) return contextFmt1(r, sub, buf, i, filter, gdef, layout, true);
  return 0;
}

const ahead0: Pred[] = [];

interface Chain3 { back: Pred[]; input: Pred[]; ahead: Pred[]; recs: SeqLookup[]; }
function chain3Preds(r: OtReader, sub: Uint8Array): Chain3 {
  let p = 2;
  const bc = r.u16(p); p += 2; const back = readCovPreds(r, sub, p, bc); p += bc * 2;
  const ic = r.u16(p); p += 2; const input = readCovPreds(r, sub, p, ic); p += ic * 2;
  const ac = r.u16(p); p += 2; const ahead = readCovPreds(r, sub, p, ac); p += ac * 2;
  const rc = r.u16(p); p += 2; const recs = readSeqLookups(r, p, rc);
  return { back, input, ahead, recs };
}

// Shared format-1 rule matcher for context (chaining=false) and chaining (true).
function contextFmt1(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable, chaining: boolean): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const setCount = r.u16(4);
  if (ci >= setCount) return 0;
  const setOff = r.u16(6 + ci * 2);
  const ruleCount = r.u16(setOff);
  for (let ru = 0; ru < ruleCount; ru++) {
    const ruleOff = setOff + r.u16(setOff + 2 + ru * 2);
    let p = ruleOff;
    let back: Pred[] = [];
    if (chaining) { const bc = r.u16(p); p += 2; back = []; for (let k = 0; k < bc; k++) { back.push(eqPred(r.u16(p))); p += 2; } }
    const ic = r.u16(p); p += 2;
    let rc = 0;
    if (!chaining) { rc = r.u16(p); p += 2; }                  // SequenceRule: seqLookupCount precedes inputSequence
    const input: Pred[] = [trueP];
    for (let k = 1; k < ic; k++) { input.push(eqPred(r.u16(p))); p += 2; }
    let ahead: Pred[] = [];
    if (chaining) { const ac = r.u16(p); p += 2; ahead = []; for (let k = 0; k < ac; k++) { ahead.push(eqPred(r.u16(p))); p += 2; } }
    if (chaining) { rc = r.u16(p); p += 2; }                   // ChainedSequenceRule: seqLookupCount at end
    const recs = readSeqLookups(r, p, rc);
    const m = matchChain(buf, i, filter, back, input, ahead);
    if (m) { applySeqLookupsGsub(recs, m, buf, gdef, layout); return Math.max(1, m.length); }
  }
  return 0;
}

// Shared format-2 (class-based) rule matcher for contextual (chaining=false) and
// chaining (true). Coverage gates the first glyph; the input ClassDef class of that
// glyph selects the ClassSequenceRuleSet; each rule is a sequence of class predicates.
function contextFmt2Match(sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, chaining: boolean): { m: number[]; recs: SeqLookup[] } | null {
  const r = new OtReader(sub);
  const cov = parseCoverage(sub, r.u16(2));
  if (cov.index(buf[i].gid) < 0) return null;
  let backCD: ClassDef | undefined, aheadCD: ClassDef | undefined, inputCD: ClassDef, setCountOff: number;
  if (chaining) {
    backCD = parseClassDef(sub, r.u16(4));
    inputCD = parseClassDef(sub, r.u16(6));
    aheadCD = parseClassDef(sub, r.u16(8));
    setCountOff = 10;
  } else {
    inputCD = parseClassDef(sub, r.u16(4));
    setCountOff = 6;
  }
  const setCount = r.u16(setCountOff);
  const cls = inputCD.classOf(buf[i].gid);
  if (cls >= setCount) return null;
  const setOff = r.u16(setCountOff + 2 + cls * 2);
  if (!setOff) return null;                                    // null rule set for this class
  const ruleCount = r.u16(setOff);
  for (let ru = 0; ru < ruleCount; ru++) {
    const ruleOff = setOff + r.u16(setOff + 2 + ru * 2);
    let p = ruleOff;
    const back: Pred[] = [];
    if (chaining) { const bc = r.u16(p); p += 2; for (let k = 0; k < bc; k++) { back.push(classPred(backCD!, r.u16(p))); p += 2; } }
    const gc = r.u16(p); p += 2;
    let rc = 0;
    if (!chaining) { rc = r.u16(p); p += 2; }                  // ClassSequenceRule: seqLookupCount precedes inputSequence
    const input: Pred[] = [trueP];
    for (let k = 1; k < gc; k++) { input.push(classPred(inputCD, r.u16(p))); p += 2; }
    const ahead: Pred[] = [];
    if (chaining) { const ac = r.u16(p); p += 2; for (let k = 0; k < ac; k++) { ahead.push(classPred(aheadCD!, r.u16(p))); p += 2; } }
    if (chaining) { rc = r.u16(p); p += 2; }                   // ChainedClassSequenceRule: seqLookupCount at end
    const recs = readSeqLookups(r, p, rc);
    const m = matchChain(buf, i, filter, back, input, ahead);
    if (m) return { m, recs };
  }
  return null;
}

// Reverse chaining single (GSUB type 8), format 1. Applied right-to-left.
function applyReverseChainImpl(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  for (const raw of lk.subtables) {
    const { sub } = resolveExtension(lk.type, raw);
    const r = new OtReader(sub);
    if (r.u16(0) !== 1) continue;
    let p = 2;
    const cov = parseCoverage(sub, r.u16(p)); p += 2;
    const bc = r.u16(p); p += 2; const back = readCovPreds(r, sub, p, bc); p += bc * 2;
    const ac = r.u16(p); p += 2; const ahead = readCovPreds(r, sub, p, ac); p += ac * 2;
    const glyphCount = r.u16(p); p += 2;
    const subGids: number[] = [];
    for (let k = 0; k < glyphCount; k++) subGids.push(r.u16(p + k * 2));
    for (let i = buf.length - 1; i >= 0; i--) {
      if (filter.skip(buf[i].gid)) continue;
      const ci = cov.index(buf[i].gid);
      if (ci < 0) continue;
      if (matchChain(buf, i, filter, back, [trueP], ahead)) buf[i].gid = subGids[ci];
    }
  }
}

// ─── GPOS ───

interface Value { xPlacement: number; yPlacement: number; xAdvance: number; }
/** Decode a ValueRecord at `off` per `format` bitmask (device tables skipped). */
function readValue(r: OtReader, off: number, format: number): Value {
  let p = off;
  const take = (bit: number) => { if (format & bit) { const v = r.i16(p); p += 2; return v; } return 0; };
  const xPlacement = take(0x0001), yPlacement = take(0x0002), xAdvance = take(0x0004);
  take(0x0008);                                                 // yAdvance (consumed, unused horizontally)
  for (const bit of [0x0010, 0x0020, 0x0040, 0x0080]) if (format & bit) p += 2; // device offsets
  return { xPlacement, yPlacement, xAdvance };
}
function valueSize(format: number): number { let n = 0; for (let b = 1; b <= 0x80; b <<= 1) if (format & b) n += 2; return n; }
function applyValue(g: ShapedGlyph, v: Value): void { g.xOffset += v.xPlacement; g.yOffset += v.yPlacement; g.xAdvance += v.xAdvance; }

export function applyGposLookup(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable, rtl: boolean): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  let i = 0;
  while (i < buf.length) {
    if (filter.skip(buf[i].gid)) { i++; continue; }
    applyGposAt(lk, buf, i, filter, gdef, layout, rtl);
    i++;
  }
}

function applyGposAt(lk: Lookup, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable, rtl: boolean): void {
  for (const raw of lk.subtables) {
    const { type, sub } = resolveExtension(lk.type, raw);
    if (gposSubtable(type, sub, buf, i, filter, gdef, layout, rtl)) return;
  }
}

function gposSubtable(type: number, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable, rtl: boolean): boolean {
  const r = new OtReader(sub);
  switch (type) {
    case 1: return gposSingle(r, sub, buf, i);
    case 2: return gposPair(r, sub, buf, i, filter);
    case 3: return gposCursive(r, sub, buf, i, filter, rtl);
    case 4: return gposMarkToBase(r, sub, buf, i, gdef);
    case 5: return gposMarkToLigature(r, sub, buf, i, gdef);
    case 6: return gposMarkToMark(r, sub, buf, i, filter);
    case 7: return gposContext(r, sub, buf, i, filter, gdef, layout, rtl);
    case 8: return gposChain(r, sub, buf, i, filter, gdef, layout, rtl);
    default: return false;
  }
}

function gposSingle(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): boolean {
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return false;
  const vf = r.u16(4);
  if (format === 1) { applyValue(buf[i], readValue(r, 6, vf)); return true; }
  if (format === 2) { const sz = valueSize(vf); applyValue(buf[i], readValue(r, 8 + ci * sz, vf)); return true; }
  return false;
}

function gposPair(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter): boolean {
  const j = nextInput(buf, i + 1, filter);
  if (j >= buf.length) return false;
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return false;
  const vf1 = r.u16(4), vf2 = r.u16(6);
  const sz1 = valueSize(vf1), sz2 = valueSize(vf2);
  if (format === 1) {
    const setOff = r.u16(10 + ci * 2);
    const count = r.u16(setOff);
    const stride = 2 + sz1 + sz2;
    for (let k = 0; k < count; k++) {
      const rec = setOff + 2 + k * stride;
      if (r.u16(rec) !== buf[j].gid) continue;
      if (vf1) applyValue(buf[i], readValue(r, rec + 2, vf1));
      if (vf2) applyValue(buf[j], readValue(r, rec + 2 + sz1, vf2));
      return true;
    }
    return false;
  }
  if (format === 2) {
    const cd1 = parseClassDef(sub, r.u16(8));
    const cd2 = parseClassDef(sub, r.u16(10));
    const c1Count = r.u16(12), c2Count = r.u16(14);
    const c1 = cd1.classOf(buf[i].gid), c2 = cd2.classOf(buf[j].gid);
    if (c1 >= c1Count || c2 >= c2Count) return false;
    const rec = 16 + (c1 * c2Count + c2) * (sz1 + sz2);
    if (vf1) applyValue(buf[i], readValue(r, rec, vf1));
    if (vf2) applyValue(buf[j], readValue(r, rec + sz1, vf2));
    return true;
  }
  return false;
}

/** Top-level: run every GPOS lookup enabled for (script, lang, features).
 *  `rtl` is the run/buffer direction (from bidi), which drives cursive main-
 *  direction advance math — distinct from a lookup's RIGHT_TO_LEFT flag. */
export function applyGpos(t: OtTable, buf: ShapedGlyph[], gdef: Gdef | undefined, script: string | undefined, lang: string | undefined, features: string[], rtl = false): void {
  for (const li of resolveLookups(t, script, lang, features)) {
    const lk = t.lookups[li];
    if (lk) applyGposLookup(lk, buf, gdef, t, rtl);
  }
  propagateCursive(buf);                                        // resolve cursive-attachment chains
}

// ─── GPOS mark attachment (types 4, 5 & 6) ───

interface Anchor { x: number; y: number; }
function readAnchor(r: OtReader, off: number): Anchor { return { x: r.i16(off + 2), y: r.i16(off + 4) }; }
interface MarkRec { cls: number; anchor: Anchor | null; }
function readMarkArray(r: OtReader, off: number): MarkRec[] {
  const count = r.u16(off);
  const out: MarkRec[] = [];
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 4;
    const anchorOff = r.u16(rec + 2);
    out.push({ cls: r.u16(rec), anchor: anchorOff ? readAnchor(r, off + anchorOff) : null });
  }
  return out;
}

/** Shared mark attachment (types 4, 5, 6). `findAttach(i)` returns the attachment
 *  glyph index (base/ligature/preceding-mark), or <0. `resolveAnchor(b, cls, mcc)`
 *  yields the attachment anchor for base-glyph index `b` and mark class `cls`. */
function markAttach(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, findAttach: (i: number) => number, resolveAnchor: (b: number, cls: number, markClassCount: number) => Anchor | null): boolean {
  const markCov = parseCoverage(sub, r.u16(2));
  const mi = markCov.index(buf[i].gid);
  if (mi < 0) return false;
  const markClassCount = r.u16(6);
  const marks = readMarkArray(r, r.u16(8));
  const mark = marks[mi];
  if (!mark || !mark.anchor) return false;
  const b = findAttach(i);
  if (b < 0) return false;
  const baseAnchor = resolveAnchor(b, mark.cls, markClassCount);
  if (!baseAnchor) return false;
  let between = 0;
  for (let k = b; k < i; k++) between += buf[k].xAdvance;
  buf[i].xOffset = (baseAnchor.x - mark.anchor.x) - between;
  buf[i].yOffset = baseAnchor.y - mark.anchor.y;
  buf[i].xAdvance = 0;                                          // marks are zero-advance
  return true;
}

// Anchor from a BaseArray / Mark2Array (types 4 & 6): coverage at off 4, array at off 10.
function baseArrayAnchor(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], b: number, cls: number, markClassCount: number): Anchor | null {
  const baseCov = parseCoverage(sub, r.u16(4));
  const bi = baseCov.index(buf[b].gid);
  if (bi < 0) return null;
  const baseArrayOff = r.u16(10);
  if (bi >= r.u16(baseArrayOff)) return null;                    // baseCount
  const anchorOff = r.u16(baseArrayOff + 2 + (bi * markClassCount + cls) * 2);
  if (!anchorOff) return null;
  return readAnchor(r, baseArrayOff + anchorOff);
}

// Anchor from a LigatureArray (type 5): the mark's component (from ligature tracking)
// selects one ComponentRecord within the covered ligature's LigatureAttach table.
function ligArrayAnchor(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], markIdx: number, b: number, cls: number, markClassCount: number): Anchor | null {
  const ligCov = parseCoverage(sub, r.u16(4));
  const li = ligCov.index(buf[b].gid);
  if (li < 0) return null;
  const ligArrayOff = r.u16(10);
  if (li >= r.u16(ligArrayOff)) return null;                     // ligatureCount
  const ligAttachOff = ligArrayOff + r.u16(ligArrayOff + 2 + li * 2);
  const compCount = r.u16(ligAttachOff);
  if (compCount < 1) return null;
  const mk = buf[markIdx];
  let comp = (mk.ligId !== undefined && mk.ligId === buf[b].ligId && mk.ligComp !== undefined) ? mk.ligComp : 0;
  if (comp >= compCount) comp = compCount - 1;                   // clamp defensively
  if (comp < 0) comp = 0;
  const anchorOff = r.u16(ligAttachOff + 2 + (comp * markClassCount + cls) * 2);
  if (!anchorOff) return null;
  return readAnchor(r, ligAttachOff + anchorOff);
}

// Nearest preceding glyph that isn't a mark (GDEF class 3): the base or ligature.
function precedingBase(buf: ShapedGlyph[], idx: number, gdef: Gdef | undefined): number {
  let b = idx - 1;
  while (b >= 0 && gdef?.glyphClass?.classOf(buf[b].gid) === 3) b--;
  return b;
}

function gposMarkToBase(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, gdef: Gdef | undefined): boolean {
  return markAttach(r, sub, buf, i, (idx) => precedingBase(buf, idx, gdef),
    (b, cls, mcc) => baseArrayAnchor(r, sub, buf, b, cls, mcc));
}

function gposMarkToLigature(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, gdef: Gdef | undefined): boolean {
  return markAttach(r, sub, buf, i, (idx) => precedingBase(buf, idx, gdef),
    (b, cls, mcc) => ligArrayAnchor(r, sub, buf, i, b, cls, mcc));
}

function gposMarkToMark(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter): boolean {
  return markAttach(r, sub, buf, i, (idx) => {
    let b = idx - 1;
    while (b >= 0 && filter.skip(buf[b].gid)) b--; // nearest non-ignored (the preceding mark)
    return b;
  }, (b, cls, mcc) => baseArrayAnchor(r, sub, buf, b, cls, mcc));
}

// ─── GPOS cursive attachment (type 3) ───

// CursivePosFormat1: joins a glyph's entry anchor to the previous glyph's exit
// anchor. Two independent axes, per HarfBuzz:
//   • main direction (advance math so the anchors coincide) follows the run/buffer
//     direction `rtl` — where the pen actually moves;
//   • cross direction (which glyph is the attached child, and the y-offset sign,
//     resolved by propagateCursive so chains cascade) follows the lookup's
//     RIGHT_TO_LEFT flag (`filter.rtl`), which selects the parent link only.
// These coincide for typical Arabic (RTL run + RTL-flagged lookup) but must be
// kept distinct — e.g. an RTL-flagged cursive lookup applied to an LTR run.
function gposCursive(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, rtl: boolean): boolean {
  if (r.u16(0) !== 1) return false;                            // only format 1 is defined
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return false;
  const count = r.u16(4);
  if (ci >= count) return false;
  const entryOff = r.u16(6 + ci * 4);                          // this glyph's entryAnchorOffset
  if (!entryOff) return false;
  let j = i - 1;                                               // previous non-ignored glyph
  while (j >= 0 && filter.skip(buf[j].gid)) j--;
  if (j < 0) return false;
  const pj = cov.index(buf[j].gid);
  if (pj < 0 || pj >= count) return false;
  const exitOff = r.u16(6 + pj * 4 + 2);                       // previous glyph's exitAnchorOffset
  if (!exitOff) return false;
  const entry = readAnchor(r, entryOff);
  const exit = readAnchor(r, exitOff);
  // Main-direction advance adjustment (run direction).
  if (rtl) {
    const d = exit.x + buf[j].xOffset;
    buf[j].xAdvance -= d; buf[j].xOffset -= d;
    buf[i].xAdvance = entry.x + buf[i].xOffset;
  } else {
    buf[j].xAdvance = exit.x + buf[j].xOffset;
    const d = entry.x + buf[i].xOffset;
    buf[i].xAdvance -= d; buf[i].xOffset -= d;
  }
  // Cross-direction parent link (lookup RIGHT_TO_LEFT flag).
  if (filter.rtl) {
    buf[j].yOffset = entry.y - exit.y;                         // child = prev, parent = cur
    buf[j].cursiveParent = i;
  } else {
    buf[i].yOffset = exit.y - entry.y;                         // child = cur, parent = prev
    buf[i].cursiveParent = j;
  }
  return true;
}

// Resolve cursive chains: each attached child adds its parent's (already resolved)
// cross-direction offset, so a run of joined glyphs cascades from its root outward.
function propagateCursive(buf: ShapedGlyph[]): void {
  const resolve = (n: number): void => {
    const g = buf[n];
    if (g.cursiveParent === undefined) return;
    const p = g.cursiveParent;
    g.cursiveParent = undefined;                              // mark resolved (also breaks cycles)
    if (p >= 0 && p < buf.length) { resolve(p); g.yOffset += buf[p].yOffset; }
  };
  for (let n = 0; n < buf.length; n++) resolve(n);
}

// ─── GPOS contextual / chaining (types 7 & 8), format 3 ───

function applySeqLookupsGpos(recs: SeqLookup[], inputPos: number[], buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable, rtl: boolean): void {
  for (const rec of recs) {
    const pos = inputPos[rec.seqIndex];
    const lk = layout.lookups[rec.lookupIndex];
    if (pos === undefined || !lk) continue;
    const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
    applyGposAt(lk, buf, pos, filter, gdef, layout, rtl);
  }
}

function gposContext(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable, rtl: boolean): boolean {
  if (r.u16(0) === 2) {
    const res = contextFmt2Match(sub, buf, i, filter, false);
    if (!res) return false;
    applySeqLookupsGpos(res.recs, res.m, buf, gdef, layout, rtl);
    return true;
  }
  if (r.u16(0) !== 3) return false;                            // fmt 1 degrades
  let p = 2;
  const gc = r.u16(p); p += 2; const input = readCovPreds(r, sub, p, gc); p += gc * 2;
  const rc = r.u16(p); p += 2; const recs = readSeqLookups(r, p, rc);
  const m = matchChain(buf, i, filter, [], input, []);
  if (!m) return false;
  applySeqLookupsGpos(recs, m, buf, gdef, layout, rtl);
  return true;
}

function gposChain(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable, rtl: boolean): boolean {
  if (r.u16(0) === 2) {
    const res = contextFmt2Match(sub, buf, i, filter, true);
    if (!res) return false;
    applySeqLookupsGpos(res.recs, res.m, buf, gdef, layout, rtl);
    return true;
  }
  if (r.u16(0) !== 3) return false;                            // fmt 1 degrades
  const c = chain3Preds(r, sub);
  const m = matchChain(buf, i, filter, c.back, c.input, c.ahead);
  if (!m) return false;
  applySeqLookupsGpos(c.recs, m, buf, gdef, layout, rtl);
  return true;
}

// ─── Top-level: parse a font's layout tables + shape a gid run ───

export interface OtLayout { gsub?: OtTable; gpos?: OtTable; gdef?: Gdef; }

/** Parse GSUB/GPOS/GDEF from a font. `undefined` when none present. Each table
 *  degrades independently (a malformed one becomes `undefined`). */
export function parseOtLayout(sfnt: SfntFont): OtLayout | undefined {
  const gsubBytes = sfnt.table('GSUB', false);
  const gposBytes = sfnt.table('GPOS', false);
  const gdefBytes = sfnt.table('GDEF', false);
  if (!gsubBytes && !gposBytes && !gdefBytes) return undefined;
  const layout: OtLayout = {};
  if (gsubBytes) layout.gsub = parseOtTable(gsubBytes);
  if (gposBytes) layout.gpos = parseOtTable(gposBytes);
  if (gdefBytes) layout.gdef = parseGdef(gdefBytes);
  return layout;
}

export interface ShapeOptions { script?: string; lang?: string; features?: string[]; rtl?: boolean; }
const DEFAULT_FEATURES = ['ccmp', 'liga', 'rlig', 'calt', 'kern', 'mark', 'mkmk'];

/** Shape a gid run: GSUB then GPOS, advances seeded from hmtx. Pure; returns a
 *  new buffer. When the font has no layout tables, returns nominal glyphs
 *  (hmtx advances, zero offsets) — the pass-through guarantee. */
export function applyFeatures(sfnt: SfntFont, gids: { gid: number; cluster: number }[], opts: ShapeOptions): ShapedGlyph[] {
  const buf: ShapedGlyph[] = gids.map((g) => ({ gid: g.gid, cluster: g.cluster, xAdvance: sfnt.advanceWidth(g.gid), xOffset: 0, yOffset: 0 }));
  const layout = sfnt.otLayout();
  if (!layout) return buf;
  const features = opts.features ?? DEFAULT_FEATURES;
  try {
    if (layout.gsub) applyGsub(layout.gsub, buf, layout.gdef, opts.script, opts.lang, features);
    // Re-seed advances from final gids (GSUB may have rewritten/inserted glyphs), then GPOS adds deltas.
    for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid);
    if (layout.gpos) applyGpos(layout.gpos, buf, layout.gdef, opts.script, opts.lang, features, opts.rtl ?? false);
  } catch { /* degrade: return the buffer as-is without throwing */ }
  return buf;
}
