/** WordprocessingML numbering (`m2fp.3`): definitions, level resolution, and
 *  the counter that turns (numId, ilvl) into the label Word would show.
 *
 *  **Invariant:** ONE counter set per ABSTRACT num, so two `w:num`s over one
 *  abstract num continue each other — `test/fixtures/docx/wml-oracle.json`
 *  records Word's own answer. A num's `startOverride`/`lvl` override restarts
 *  its overridden levels the FIRST time that num is used, then counts on.
 *
 *  **Invariant:** a paragraph that is not a list item resets nothing; only
 *  visiting a level resets the levels deeper than it (unless their
 *  `w:lvlRestart` is 0).
 *
 *  **Invariant:** `%N` in `w:lvlText` is level N-1's CURRENT value formatted
 *  by THAT level's `w:numFmt`, not the visited level's. A format we do not
 *  model falls back to decimal and is reported as `unmodelledFormat`.
 *
 *  **Invariant:** `numStyleLink` indirection is bounded by `maxNestingDepth`
 *  and a cycle yields no list, never a hang. */
import type { NsElement } from './xmlns.js';
import { parseWml, W, wAttr, wChild, wChildren, wNum } from './wmlns.js';
import { readParaLayer, type ParaLayer, type WmlStyles } from './wmlstyles.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError } from './errors.js';

export interface WmlLevel { start: number; numFmt: string; lvlText: string; restart?: number; ppr: ParaLayer }
interface Abstract { levels: Map<number, WmlLevel>; numStyleLink?: string; styleLink?: string }
interface Num { abstractId: number; overrides: Map<number, { start?: number; level?: WmlLevel }> }
export interface WmlNumbering {
  abstracts: ReadonlyMap<number, Abstract>;
  nums: ReadonlyMap<number, Num>;
  /** `w:styleLink` name to the FIRST abstract num carrying it, built once at
   *  parse so following a `numStyleLink` is a lookup rather than a scan (`m2fp.9`). */
  byStyleLink: ReadonlyMap<string, number>;
}
export interface ListLabel { ordinal: number; label: string; bullet: boolean; unmodelledFormat?: string }

export const EMPTY_NUMBERING: WmlNumbering = { abstracts: new Map(), nums: new Map(), byStyleLink: new Map() };
const LEVELS = 9;

function readLevel(l: NsElement): WmlLevel {
  const level: WmlLevel = {
    start: wNum(wChild(l, 'start')) ?? 0,
    numFmt: wAttr(wChild(l, 'numFmt'), 'val') ?? 'decimal',
    lvlText: wAttr(wChild(l, 'lvlText'), 'val') ?? '',
    ppr: readParaLayer(wChild(l, 'pPr')),
  };
  const restart = wNum(wChild(l, 'lvlRestart'));
  if (restart !== undefined) level.restart = restart;
  return level;
}

const levelIndex = (el: NsElement): number | undefined => {
  const i = wNum(el, 'ilvl');
  return i !== undefined && Number.isInteger(i) && i >= 0 && i < LEVELS ? i : undefined;
};

export function parseNumbering(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): WmlNumbering {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'numbering') throw new PdfParseError('numbering.xml: the root is not w:numbering');
  const abstracts = new Map<number, Abstract>();
  const nums = new Map<number, Num>();
  const byStyleLink = new Map<string, number>();
  let n = 0;
  for (const a of wChildren(root, 'abstractNum')) {
    limits.enforce('maxContainerItems', ++n, 'numbering definitions');
    const id = wNum(a, 'abstractNumId');
    if (id === undefined || abstracts.has(id)) continue;
    const levels = new Map<number, WmlLevel>();
    for (const l of wChildren(a, 'lvl')) {
      const i = levelIndex(l);
      if (i !== undefined && !levels.has(i)) levels.set(i, readLevel(l));
    }
    const abs: Abstract = { levels };
    const nsl = wAttr(wChild(a, 'numStyleLink'), 'val'); if (nsl !== undefined) abs.numStyleLink = nsl;
    const sl = wAttr(wChild(a, 'styleLink'), 'val');
    if (sl !== undefined) { abs.styleLink = sl; if (!byStyleLink.has(sl)) byStyleLink.set(sl, id); }
    abstracts.set(id, abs);
  }
  for (const x of wChildren(root, 'num')) {
    limits.enforce('maxContainerItems', ++n, 'numbering definitions');
    const id = wNum(x, 'numId');
    const abstractId = wNum(wChild(x, 'abstractNumId'));
    if (id === undefined || abstractId === undefined || nums.has(id)) continue;
    const overrides = new Map<number, { start?: number; level?: WmlLevel }>();
    for (const o of wChildren(x, 'lvlOverride')) {
      const i = levelIndex(o);
      if (i === undefined) continue;
      const ov: { start?: number; level?: WmlLevel } = {};
      const start = wNum(wChild(o, 'startOverride')); if (start !== undefined) ov.start = start;
      const lv = wChild(o, 'lvl'); if (lv) ov.level = readLevel(lv);
      overrides.set(i, ov);
    }
    nums.set(id, { abstractId, overrides });
  }
  return { abstracts, nums, byStyleLink };
}

/** The abstract num a num resolves to, following `numStyleLink`. */
function abstractFor(n: WmlNumbering, styles: WmlStyles, numId: number): { id: number; abs: Abstract } | undefined {
  const num = n.nums.get(numId);
  if (!num) return undefined;
  let id = num.abstractId;
  const seen = new Set<number>();
  for (let hop = 0; hop <= styles.maxDepth; hop++) {
    const abs = n.abstracts.get(id);
    if (!abs) return undefined;
    if (abs.numStyleLink === undefined) return { id, abs };
    if (seen.has(id)) return undefined;
    seen.add(id);
    const link = abs.numStyleLink;
    const linked = n.byStyleLink.get(link);
    const la = linked === undefined ? undefined : n.abstracts.get(linked);
    if (la) return { id: linked!, abs: la };
    const via = styles.byId.get(link)?.ppr.numId;
    const next = via === undefined ? undefined : n.nums.get(via);
    if (!next) return undefined;
    id = next.abstractId;
  }
  return undefined;
}

export function levelOf(n: WmlNumbering, styles: WmlStyles, numId: number, ilvl: number): WmlLevel | undefined {
  const a = abstractFor(n, styles, numId);
  if (!a) return undefined;
  const ov = n.nums.get(numId)?.overrides.get(ilvl);
  const base = ov?.level ?? a.abs.levels.get(ilvl);
  if (!base) return undefined;
  return ov?.start !== undefined ? { ...base, start: ov.start } : base;
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** A counter value in a `w:numFmt`; undefined for a format not modelled. */
export function formatNumber(n: number, fmt: string): string | undefined {
  switch (fmt) {
    case 'decimal': return String(n);
    case 'decimalZero': return n >= 0 && n < 10 ? `0${n}` : String(n);
    case 'lowerRoman': return n > 0 ? roman(n) : String(n);
    case 'upperRoman': return n > 0 ? roman(n).toUpperCase() : String(n);
    case 'lowerLetter': case 'upperLetter': {
      if (n <= 0) return String(n);
      const s = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
      return fmt === 'upperLetter' ? s.toUpperCase() : s;
    }
    case 'none': return '';
    default: return undefined;
  }
}

export class ListCounter {
  private readonly values = new Map<number, (number | undefined)[]>();
  private readonly used = new Set<number>();

  constructor(private readonly n: WmlNumbering, private readonly styles: WmlStyles) {}

  next(numId: number, ilvl: number): ListLabel | undefined {
    const a = abstractFor(this.n, this.styles, numId);
    const lvl = levelOf(this.n, this.styles, numId, ilvl);
    if (!a || !lvl) return undefined;
    let vals = this.values.get(a.id);
    if (!vals) { vals = new Array<number | undefined>(LEVELS).fill(undefined); this.values.set(a.id, vals); }
    if (!this.used.has(numId)) {
      this.used.add(numId);
      for (const i of this.n.nums.get(numId)!.overrides.keys()) vals[i] = undefined;
    }
    const cur = vals[ilvl];
    const value = cur === undefined ? lvl.start : cur + 1;
    vals[ilvl] = value;
    for (let d = ilvl + 1; d < LEVELS; d++) {
      // w:lvlRestart k (1-based) restarts level d only after a level at index
      // < k is visited; 0 never restarts it. Absent means "after any shallower".
      const k = levelOf(this.n, this.styles, numId, d)?.restart;
      if (k !== undefined && (k === 0 || ilvl >= k)) continue;
      vals[d] = undefined;
    }
    if (lvl.numFmt === 'bullet') return { ordinal: value, label: lvl.lvlText, bullet: true };
    let unmodelledFormat: string | undefined;
    const label = lvl.lvlText.replace(/%([1-9])/g, (_m, k: string) => {
      const i = Number(k) - 1;
      const l = levelOf(this.n, this.styles, numId, i);
      const v = vals![i] ?? l?.start ?? 1;
      const fmt = l?.numFmt ?? 'decimal';
      const s = formatNumber(v, fmt);
      if (s !== undefined) return s;
      unmodelledFormat ??= `w:numFmt=${fmt}`;
      return String(v);
    });
    return unmodelledFormat === undefined
      ? { ordinal: value, label, bullet: false }
      : { ordinal: value, label, bullet: false, unmodelledFormat };
  }
}
