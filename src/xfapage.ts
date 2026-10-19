/**
 * XFA pagination (`164g.3`): which child of the root subform lands in which
 * content area of which page, under `orderedOccurrence` and, since `164g.9`,
 * `simplexPaginated` and `duplexPaginated` (XFA Specification 3.3, pinned by
 * 164g.1; p. 269-270, 288-310, 360-367).
 *
 * **Invariant: it decides MEMBERSHIP only.** Every position comes from
 * `xfaflow.ts`: each content area holding children is laid out as a `tb` root,
 * so a page and its layout cannot disagree about where a child sits.
 *
 * **Invariant: a pure leaf over `xfaflow.js` and `xfageom.js` that never
 * throws.** What it cannot paginate is refused BY NAME, and a refused child
 * refuses every child after it -- the root is a `tb` flow, so where a later one
 * lands depends on the one that failed (`xfaflow.ts`'s rule, one level up).
 *
 * **The recorded spec conflict:** Example 9.22 (p. 362) shows a first child's
 * `startNew` break leaving page 1 blank; the start-point rule (p. 296) and both
 * oracles (Adobe's I-130/I-765, pdf.js's OPM 1644) do not. The first child's
 * break chooses where layout STARTS and never opens a page of its own.
 */
import {
  layoutPage, measureExtent, insetsOf, positionedChildBoxes, tableColumnWidths, SPLIT_LATER,
  type LayoutNode, type Placed, type PlacedNode, type XfaBreak, type XfaCopySpec, type XfaMeasure,
} from './xfaflow.js';
import { measureToPt, type XfaMedium } from './xfageom.js';
import {
  positionedCut, positionedFragment, positionedSplittable, type XfaChildBoxes,
} from './xfasplitpos.js';
import { fieldCut, fontSizeOf, pieceOf, ptStr } from './xfafieldsplit.js';
import { adheres, intactSplits, nextAdhering } from './xfakeep.js';

/** A qualified page area's qualifiers (XFA 3.3 p. 302-303); absent reads as `any`. */
export type XfaPagePosition = 'any' | 'first' | 'last' | 'rest' | 'only';
export type XfaOddOrEven = 'any' | 'odd' | 'even';
export type XfaBlankOrNotBlank = 'any' | 'blank' | 'notBlank';

export interface XfaContentArea { name?: string; id?: string; node: LayoutNode }
export interface XfaPageAreaModel {
  name?: string;
  id?: string;
  medium?: XfaMedium;
  /** `<occur max>`; -1 (the default, p. 300) is no limit. */
  max: number;
  /** Read only under a qualified relation (p. 302): the page's position in its set. */
  pagePosition?: XfaPagePosition;
  /** Read only under a qualified relation (p. 303): the surface's parity. */
  oddOrEven?: XfaOddOrEven;
  /** Read only under a qualified relation (p. 303): why the page was included. */
  blankOrNotBlank?: XfaBlankOrNotBlank;
  contentAreas: XfaContentArea[];
  /** The page area's own background -- fields, draws and subforms outside its
   *  content areas -- as a POSITIONED root at the page origin (XFA 3.3 p. 271,
   *  288). One per page area, shared by every page that instantiates it
   *  (d3mq). Absent when the template walk did not reach the page area. */
  master?: LayoutNode;
  /** The page set holding it, an index into `XfaPageSet.sets` (164g.22); 0,
   *  the root set, when absent. */
  set?: number;
}
/** One `<pageSet>` of a nested tree (164g.22): its relation and max, and its
 *  children in document order -- page areas by their index in the flat
 *  `XfaPageSet.pageAreas`, nested sets by theirs in `XfaPageSet.sets`. */
export interface XfaPageSetNode {
  relation: string;
  max: number;
  parent?: number;
  children: Array<{ area: number } | { set: number }>;
}
export interface XfaPageSet {
  /** `relation`, `orderedOccurrence` when absent. */
  relation: string;
  max: number;
  /** EVERY page area, nested sets' included, in document order: a page's
   *  `pageArea` indexes this list whatever set it is in (164g.22). */
  pageAreas: XfaPageAreaModel[];
  /** The set tree, root first (164g.22). Absent: one set holding every area. */
  sets?: XfaPageSetNode[];
  /** Why this page set cannot be paginated, as the template found it. */
  refusal?: string;
  /** Warnings found while reading the page set (an ignored occur). */
  warnings?: string[];
}
/** The root subform (whose children are the page-level content) and its page set. */
export interface XfaBody { root: LayoutNode; pageSet?: XfaPageSet }

export interface PaginatedPage {
  pageArea: number;
  /** The 0-based page-set instance this page belongs to (p. 300). A master
   *  field's instance numbering is only settled within instance 0 (d3mq). */
  pageSet: number;
  /** Per content area of that page area, the children that landed there. */
  contentAreas: Array<{ index: number; children: LayoutNode[] }>;
  /** A page holding no content by design: a parity filler or an appended last page. */
  blank?: true;
}
export interface Pagination {
  pages: PaginatedPage[];
  /** A node that could not be placed -- a root child, or a child inside a split
   *  (164g.8) -- with the reason each field below it gets. */
  refused: Map<LayoutNode, string>;
  warnings: string[];
  /** Every leader and trailer COPY laid down (164g.15), by its root node: the
   *  node `XfaCopySpec.make` returned, placed in some content area. */
  copies: LayoutNode[];
}
/** A child's laid-out height, and whether it draws anything below `limit`. */
export type XfaHeight = (n: LayoutNode, limit: number) => { h: number; past: boolean } | { reason: string };

/** The layout callbacks pagination splits with (164g.11, 164g.12). Each one
 *  missing narrows what splits, never fails: without `boxes` no positioned
 *  subform splits; without `columns` a table fragment keeps its stated
 *  `columnWidths`; without `topOf` a straddling lr-tb item moves. */
export interface XfaPaginateHooks {
  /** A positioned container's children as pagination sees them. */
  boxes?: XfaChildBoxes;
  /** A table's whole-table column widths (rule 4, t30). */
  columns?: (n: LayoutNode) => number[] | { reason: string };
  /** `n`'s top within `root` once `root` is laid out, in points (rule 7). */
  topOf?: (root: LayoutNode, n: LayoutNode) => number | undefined;
  /** A field value's wrapped line count, 0 when empty (164g.13). Without it a
   *  straddling field whose value is not known empty is refused. */
  fieldLines?: (n: LayoutNode) => number | undefined;
}

/** A measurer that measures each node once per box: a split re-measures its
 *  region after every leaf, which must lay containers out again but measure no
 *  text twice (164g.12). */
export function memoMeasure(m: XfaMeasure): XfaMeasure {
  const cache = new Map<LayoutNode, Map<string, ReturnType<XfaMeasure>>>();
  return (n, box) => {
    let c = cache.get(n);
    if (!c) { c = new Map(); cache.set(n, c); }
    const k = JSON.stringify(box);
    let v = c.get(k);
    if (v === undefined) { v = m(n, box); c.set(k, v); }
    return v;
  };
}

/** The hooks over `xfaflow.ts`, for one measurer. `topOf` lays `root` out on a
 *  probe page, since leaves under a flow are only placed when a content-area
 *  bottom bounds them. */
export function layoutHooks(measure?: XfaMeasure, lines?: (n: LayoutNode) => number | undefined): XfaPaginateHooks {
  return {
    // Without a counter, only a field whose template value is empty is known.
    fieldLines: lines ?? ((n) => (n.text && n.text.refusal === undefined
      && n.text.paras.every((q) => q.runs.every((r) => r.text === '')) ? 0 : undefined)),
    boxes: (n) => positionedChildBoxes(n, measure),
    columns: (n) => tableColumnWidths(n, measure),
    topOf: (root, n) => {
      const nodes: PlacedNode[] = [];
      layoutPage({ kind: 'page', label: 'probe', layout: 'tb', geom: { h: '100000pt' }, children: [root] }, measure, [], nodes);
      const r = nodes.find((x) => x.node === root);
      const k = nodes.find((x) => x.node === n);
      return r && 'box' in r && k && 'box' in k ? k.box.y - r.box.y : undefined;
    },
  };
}

/** Tolerance for comparing summed measurements (`xfaflow.ts`'s). */
const EPS = 1e-6;
const DISCARDED = "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)";

export type PaginationMode = 'ordered' | 'simplex' | 'duplex';
/** The layout state a qualified page area is matched against (p. 304). */
export interface PageState { position: 'first' | 'rest'; parity: 'odd' | 'even'; blank: boolean }

/** The one owner of qualified matching (164g.9): the first page area, in
 *  document order, whose qualifiers fit `s` (XFA 3.3 p. 302-304), or undefined.
 *  `last` and `only` never match here; termination alone uses them (p. 308).
 *  `oddOrEven` is matched under simplex too, where every page is odd -- so an
 *  even-only area never matches, as Adobe probe q3 shows (p. 798 says simplex
 *  ignores it; p. 303-304 and Adobe do not). `blankOrNotBlank` is ignored under
 *  simplex (p. 798). */
export function chooseArea(areas: readonly XfaPageAreaModel[], s: PageState, mode: 'simplex' | 'duplex'): number | undefined {
  const i = areas.findIndex((pa) => {
    const pos = pa.pagePosition ?? 'any';
    if (pos !== 'any' && pos !== s.position) return false;
    const oe = pa.oddOrEven ?? 'any';
    if (oe !== 'any' && oe !== s.parity) return false;
    if (mode === 'duplex') {
      const b = pa.blankOrNotBlank ?? 'any';
      if (b !== 'any' && (b === 'blank') !== s.blank) return false;
    }
    return true;
  });
  return i < 0 ? undefined : i;
}

const concealed = (n: LayoutNode): boolean => n.presence === 'hidden' || n.presence === 'inactive';
const after = (cause: string): string => `an earlier item in its flow could not be laid out (${cause})`;

/** A break target to the page area and, for a content-area target, the content
 *  area it names -- or why it names nothing. `#` is an XML id; a bare name is
 *  matched by `name`; anything else is a SOM expression, which is not resolved. */
function resolveTarget(
  ps: XfaPageSet, type: 'pageArea' | 'contentArea', target: string,
): { area: number; ca?: number } | { reason: string } {
  const t = target.trim();
  const byId = t.startsWith('#');
  const v = byId ? t.slice(1) : t;
  if (v === '' || /[\s.[\]$!*]/.test(v))
    return { reason: `break target "${target}" is a SOM expression, which is not resolved` };
  const key = byId ? 'id' : 'name';
  const hits: Array<{ area: number; ca?: number }> = [];
  ps.pageAreas.forEach((pa, a) => {
    if (type === 'pageArea') { if (pa[key] === v) hits.push({ area: a }); return; }
    pa.contentAreas.forEach((c, i) => { if (c[key] === v) hits.push({ area: a, ca: i }); });
  });
  if (hits.length === 0) return { reason: `break target "${target}" names no ${type}` };
  if (hits.length > 1) return { reason: `break target "${target}" names more than one ${type}` };
  return hits[0];
}

/** The layouts that split between their children (164g.8, 164g.12). */
const SPLITS: ReadonlySet<string> = new Set(['tb', 'lr-tb', 'table']);

/** XFA 3.3 p. 291-292, narrowed to what 164g.8 and 164g.12 implement: a `tb`,
 *  `lr-tb` or `table` subform with no stated h whose keep intact is none -- or
 *  pageArea, which Adobe splits alike (164g.14 R8, t66-t68) -- splits
 *  BETWEEN its children -- a tb between its children, an lr-tb between its
 *  items, a table between its rows, each placed whole (Adobe t27-t39). A stated
 *  h keeps it whole (t33, t34). Its parent is always a flow -- the content area,
 *  or a tb being split -- where a subform's intact defaults to none. A
 *  positioned subform splits geometrically instead, when it states keep
 *  intact="none" (xfasplitpos.ts, 164g.11). */
export function splittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && SPLITS.has(n.layout ?? 'position') && n.geom.h === undefined
    && n.refusal === undefined && intactSplits(n);
}

/** One child placed whole in a split chain (164g.12): `path` runs from the root
 *  child to the container holding it, and `brks` are the breaks that take
 *  effect before it -- the breakAfters of whatever precedes it (164g.16), those
 *  of any flattened container it opens, then its own breakBefore. */
interface Leaf { node: LayoutNode; path: LayoutNode[]; brks: XfaBreak[] }

/** A splittable node as its leaves (164g.12). A tb's child that is itself
 *  splittable and shows something is flattened in turn -- an lr-tb or a table as
 *  much as a tb (rule 6, t31, t32). An lr-tb's items and a table's rows are
 *  leaves. A table's whole-table widths go into `widths`, so every fragment
 *  keeps them (rule 4, t30).
 *
 *  164g.16: a breakAfter takes effect before the NEXT leaf, as a breakBefore on
 *  it would (Adobe t92, t93). One with no leaf after it in the chain is
 *  `trailing`, applied once the chain is placed, as a root child's breakAfter
 *  is -- which is what makes t94's next root child open page 2, and t95's
 *  break with nothing after it a page of its own. */
function flatten(
  c: LayoutNode, hooks: XfaPaginateHooks, widths: Map<LayoutNode, number[]>,
  path: LayoutNode[] = [], brks: XfaBreak[] = [],
): { leaves: Leaf[]; trailing: XfaBreak[] } | { reason: string } {
  const m = insetsOf(c);
  if ('reason' in m) return { reason: m.reason };
  if (c.layout === 'table' && hooks.columns) {
    const w = hooks.columns(c);
    if ('reason' in w) return w;
    widths.set(c, w);
  }
  const chain = [...path, c];
  const out: Leaf[] = [];
  let pending = brks;
  for (const k of c.children) {
    // A hidden child takes no part in layout (p. 67): no height, and its break
    // and refusals do not apply -- as at the root.
    if (concealed(k)) { out.push({ node: k, path: chain, brks: [] }); continue; }
    const own = k.breakBefore ? [...pending, k.breakBefore] : pending;
    if (c.layout === 'tb' && splittable(k) && k.children.some((x) => !concealed(x))) {
      const inner = flatten(k, hooks, widths, chain, own);
      if ('reason' in inner) return inner;
      out.push(...inner.leaves);
      pending = inner.trailing;
    } else {
      out.push({ node: k, path: chain, brks: own });
      pending = [];
    }
    if (k.breakAfter) pending = [...pending, k.breakAfter];
  }
  return { leaves: out, trailing: pending };
}

/** Whether a splittable node's chain holds a break below it: such a node is
 *  split even when it fits, since a break takes effect wherever it sits (spec
 *  decision #3) -- a breakAfter too (164g.16, t95: a 100pt subform that fits
 *  is split, its break opening page 2). Mirrors `flatten`: only a tb's children
 *  are descended. */
function innerBreak(c: LayoutNode): boolean {
  return c.children.some((k) => !concealed(k)
    && (k.breakBefore !== undefined || k.breakAfter !== undefined
      || (c.layout === 'tb' && splittable(k) && innerBreak(k))));
}

const hasVisible = (leaves: readonly Leaf[]): boolean => leaves.some((l) => !concealed(l.node));

/** A region's leaves as fragments: shallow copies of their containers, made
 *  only when a leaf lands in them, so none holds only margins. Every fragment
 *  keeps BOTH margins (rule 3; Adobe t35, t36, t39 -- 164g.8 split them between
 *  the first and last fragment), and a table fragment its whole-table widths. */
function fragmentOf(leaves: readonly Leaf[], widths: ReadonlyMap<LayoutNode, number[]>): LayoutNode {
  const fm = new Map<LayoutNode, LayoutNode>();
  let root: LayoutNode | undefined;
  for (const l of leaves) {
    let parent: LayoutNode | undefined;
    for (const c of l.path) {
      let f = fm.get(c);
      if (!f) {
        const w = widths.get(c);
        f = { ...c, children: [], ...(w ? { columnWidths: w.map(ptStr).join(' ') } : {}) };
        fm.set(c, f);
        if (parent) parent.children.push(f);
        else root = f;
      }
      parent = f;
    }
    parent!.children.push(l.node);
  }
  return root!;
}

/** Rule 7 of 164g.12, widened by 164g.13: what a leaf that does not fit does
 *  instead of moving. A field in a `tb` or `lr-tb` splits where `fieldCut` says
 *  (t27, t28, t31, t47, t49) -- in a `tb`, a field the rules refuse MOVES, as
 *  under 164g.8, so no form that converted before loses it. In an `lr-tb` a
 *  draw moves (t37, t38), a refused field is refused, and a splittable subform
 *  item is refused (164g.25). A table row and a `tb` draw always move (t29, t48).
 *  The room for the leaf is the region's room less its top in the candidate
 *  fragment and the bottom margins around it. */
function straddle(
  l: Leaf, cand: LayoutNode, room: number, hooks: XfaPaginateHooks, height: XfaHeight,
): string | undefined | { head: LayoutNode; tail: LayoutNode } {
  const lay = l.path[l.path.length - 1].layout;
  const n = l.node;
  if ((lay !== 'lr-tb' && lay !== 'tb') || !hooks.topOf) return undefined;
  const pos = lay === 'tb' && positionedSplittable(n) && hooks.boxes !== undefined;
  if (lay === 'tb' && n.kind !== 'field' && !pos) return undefined;
  const top = hooks.topOf(cand, n);
  if (top === undefined) return undefined;
  let bottoms = 0;
  for (const c of l.path) {
    const m = insetsOf(c);
    if (!('reason' in m)) bottoms += m.b;
  }
  const piece = room - top - bottoms;
  if (piece <= EPS) return undefined;
  if (pos) {
    // 164g.21 (t105, t107-t110): a keep-none positioned subform in a tb splits
    // by 164g.11's consensus against the room left inside the chain. One the
    // rules refuse, or cut at its top, MOVES whole, as it did before.
    const hh = height(n, Infinity);
    if ('reason' in hh) return undefined;
    const cut = positionedCut(n, piece, hooks.boxes!, hooks.fieldLines);
    if (typeof cut === 'object' || cut <= EPS) return undefined;
    const head = positionedFragment(n, 0, cut, hooks.boxes!);
    const tail = positionedFragment(n, cut, hh.h, hooks.boxes!);
    if ('refusal' in head || 'refusal' in tail) return undefined;
    return { head, tail };
  }
  if (n.kind === 'field') {
    const hh = height(n, Infinity);
    if ('reason' in hh) return undefined;
    const fc = fieldCut(n, piece, hooks.fieldLines?.(n), hh.h);
    if (fc === 'move') return undefined;
    if ('refusal' in fc) return lay === 'tb' ? undefined : fc.refusal;
    return { head: pieceOf(n, 0, fc.cut), tail: pieceOf(n, fc.cut, hh.h - fc.cut) };
  }
  if (splittable(n))
    return `${n.label}: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)`;
  return undefined;
}

/** Whether something of an adhering sibling fits (164g.14). */
type Lead = 'yes' | 'no' | { fallback: string };

/** R1, R2: would `sibs[iy]` -- a sibling the one before it adheres to -- put
 *  SOMETHING into `room`? Whole, and then something of what IT adheres to (a
 *  chain); else its first piece: a splittable subform's first leaf (t58, t70)
 *  or a field's first piece by `fieldCut` (t65). Measured through the same
 *  `height` and `fragmentOf` as the fit test, so the two cannot disagree. A
 *  shape no probe settles is a fallback (spec section 4). */
function leadFits(
  sibs: readonly LayoutNode[], iy: number, room: number, height: XfaHeight, hooks: XfaPaginateHooks,
): Lead {
  const y = sibs[iy];
  if (y.breakBefore)
    return { fallback: `${y.label}: adhesion into a sibling with a breakBefore is not implemented (164g.14)` };
  const r = height(y, Infinity);
  // Its own refusal is reported where it is placed; it does not hold anything off.
  if ('reason' in r) return 'yes';
  if (r.h <= room + EPS) {
    const iz = nextAdhering(sibs, iy);
    return iz === undefined ? 'yes' : leadFits(sibs, iz, room - r.h, height, hooks);
  }
  if (hooks.boxes && positionedSplittable(y))
    return { fallback: `${y.label}: adhesion into a positioned subform that splits is not implemented (164g.14)` };
  if (y.kind === 'field') {
    const fc = fieldCut(y, room, hooks.fieldLines?.(y), r.h);
    return typeof fc === 'object' && 'cut' in fc ? 'yes' : 'no';
  }
  if (!splittable(y)) return 'no';
  const widths = new Map<LayoutNode, number[]>();
  const flat = flatten(y, hooks, widths);
  if ('reason' in flat) return 'no';
  const leaves = flat.leaves;
  const first = leaves.findIndex((l) => !concealed(l.node));
  if (first < 0) return 'yes';
  const f = fragmentOf(leaves.slice(0, first + 1), widths);
  const q = height(f, Infinity);
  if ('reason' in q) return 'no';
  if (q.h <= room + EPS) return 'yes';
  return typeof straddle(leaves[first], f, room, hooks, height) === 'object' ? 'yes' : 'no';
}

/** R1, R3, R4 for a root child `sibs[i]`, `h` tall, about to be placed whole
 *  with `room` left after it: place it, hold it off whole to the next region,
 *  force the next sibling into this region after it, or ignore the adhesion. */
function keepWith(
  p: Paginator, sibs: readonly LayoutNode[], i: number, room: number, h: number,
  height: XfaHeight, hooks: XfaPaginateHooks,
): 'place' | 'advance' | 'force' | { warning: string } {
  const iy = nextAdhering(sibs, i);
  if (iy === undefined) return 'place';
  // Section 4 (final review): a breakAfter separates the pair anyway; no probe
  // says whether Adobe then still holds the child off.
  if (sibs[i].breakAfter)
    return { warning: `${sibs[i].label}: adhesion from a subform with a breakAfter is not implemented (164g.14)` };
  const lead = leadFits(sibs, iy, room, height, hooks);
  if (lead === 'yes') return 'place';
  if (typeof lead === 'object') return { warning: lead.fallback };
  // R1, R3: hold off when the pair fits the next region -- from an EMPTY one
  // too, as p. 295 advances a child the next region can hold (emptyRegion).
  // Termination: the pair fits where it advances to, so it is placed there.
  const s = p.snapshot();
  const moved = p.advance();
  const cap = moved === undefined ? p.capacity() : 0;
  p.restore(s);
  if (moved === undefined && h <= cap + EPS && leadFits(sibs, iy, cap - h, height, hooks) === 'yes') return 'advance';
  // R4 (t59, t69): nothing waits; the next runs past this region after it.
  if (splittable(sibs[iy]))
    return { warning: `${sibs[iy].label}: adheres to the content before it, which together cannot fit an empty content area, and is splittable; the adhesion is not kept (164g.14)` };
  return 'force';
}

/** The cursor: page-set instance, page-area instances, content area, height
 *  used -- and since 164g.15 the copies laid down, which a probe must undo too. */
interface State {
  inst: number[]; uses: number[]; area: number; ca: number; used: number; pages: number;
  cur: number; visit: number; exits: number;
  spent: Map<XfaCopySpec, number>; numbered: Map<object, Map<string, number>>; made: number;
}

/** A copy by (spec, number): `make` is pure, so a fit may be probed again and
 *  again -- and a termination rerun repeated -- without walking the target or
 *  measuring its text twice (164g.15). */
const COPIES = new WeakMap<XfaCopySpec, Map<number, LayoutNode>>();

/** A termination the first pass could not decide (164g.22): page `k`, the last
 *  of a set visit, would be laid out again on `area` -- a rerun decides. */
interface PendingExit { k: number; area: number; kind: 'last' | 'only' }

class Paginator {
  readonly pages: PaginatedPage[] = [];
  /** Instances of each page set within its parent's current instance (164g.22;
   *  the root's counts the whole document's). */
  private readonly inst: number[];
  private readonly uses: number[];
  /** The page set being filled, and the page its visit began on (164g.22). */
  private cur = 0;
  private visit = 0;
  /** Terminations a rerun must decide, in document order (164g.22). */
  readonly exits: PendingExit[] = [];
  area = -1;
  ca = 0;
  used = 0;
  /** 164g.15: copies laid down per spec ENTRY (R2, t81), copy numbers per
   *  (scope, name) (R8), and every copy laid down. */
  private spent = new Map<XfaCopySpec, number>();
  private numbered = new Map<object, Map<string, number>>();
  readonly made: LayoutNode[] = [];

  constructor(
    private readonly ps: XfaPageSet, private readonly maxOf: readonly number[],
    private readonly heights: readonly number[][],
    /** 'ordered', or 'simplex'/'duplex' for a qualified tree -- whose sets each
     *  carry their own mode (164g.22). */
    readonly mode: PaginationMode = 'ordered',
    private readonly force?: ReadonlyMap<number, number>,
    /** The root subform, the last ancestor a leader or trailer is inherited from. */
    readonly root?: LayoutNode,
    private readonly sets: readonly XfaPageSetNode[] = [
      { relation: ps.relation, max: ps.max, children: ps.pageAreas.map((_, i) => ({ area: i })) },
    ],
    /** Pages whose `last`/`only` redo a rerun refused (164g.22). */
    private readonly noRedo: ReadonlySet<number> = new Set(),
  ) {
    this.uses = ps.pageAreas.map(() => 0);
    this.inst = sets.map(() => 0);
    this.inst[0] = 1;
  }

  private setOf(a: number): number { return this.ps.pageAreas[a].set ?? 0; }
  private modeOf(s: number): PaginationMode {
    const r = this.sets[s].relation;
    return r === 'simplexPaginated' ? 'simplex' : r === 'duplexPaginated' ? 'duplex' : 'ordered';
  }
  /** The sets from the root down to `s`. */
  private pathOf(s: number): number[] {
    const out: number[] = [];
    for (let x: number | undefined = s; x !== undefined; x = this.sets[x].parent) out.unshift(x);
    return out;
  }
  /** The page-set instance a page of area `a` is in: 0 only while every set on
   *  its path is in its first instance, which is what d3mq's master numbering
   *  settles. */
  private instanceOf(a: number): number {
    return this.pathOf(this.setOf(a)).reduce((n, s) => n + this.inst[s] - 1, 0);
  }

  /** Whether `s` has a copy left: its `<occur max>`, counted per entry (R2). */
  left(s: XfaCopySpec): boolean { return s.max === -1 || (this.spent.get(s) ?? 0) < s.max; }

  /** The copy of `s` that would be laid down next, without laying it down. */
  peek(s: XfaCopySpec): LayoutNode {
    const n = this.numbered.get(s.scope)?.get(s.name) ?? 0;
    let m = COPIES.get(s);
    if (!m) { m = new Map(); COPIES.set(s, m); }
    let node = m.get(n);
    if (!node) { node = s.make(n); m.set(n, node); }
    return node;
  }

  /** Lay down `node`, the copy `peek` answered for `s`. */
  commit(s: XfaCopySpec, node: LayoutNode): void {
    this.spent.set(s, (this.spent.get(s) ?? 0) + 1);
    let m = this.numbered.get(s.scope);
    if (!m) { m = new Map(); this.numbered.set(s.scope, m); }
    m.set(s.name, (m.get(s.name) ?? 0) + 1);
    this.made.push(node);
  }

  /** Page `i`'s parity (p. 303): under duplex the physical surface count's,
   *  which starts at zero, so page 1 is odd. Otherwise every page is a front
   *  and so odd -- simplex by p. 303, and the ordered relation by Adobe probe
   *  q11, where a pageOdd break takes the very next page. */
  parityOf(i: number, mode: PaginationMode = this.modeOf(this.cur)): 'odd' | 'even' {
    if (mode !== 'duplex') return 'odd';
    // 164g.22 (n4, n9): the surface count is PHYSICAL across page sets -- a
    // simplex or ordered page takes a sheet of its own, a duplex page one side.
    let c = 0;
    for (let j = 0; j < i && j < this.pages.length; j++) {
      if (this.modeOf(this.setOf(this.pages[j].pageArea)) === 'duplex') c += 1;
      else c += c % 2 === 0 ? 2 : 3;
    }
    return c % 2 === 0 ? 'odd' : 'even';
  }

  /** Consecutive boilerplate pages opened by `qualifiedNext`. */
  private boiler = 0;

  /** The next page under a qualified strategy (p. 302-304): the forced page
   *  area for a termination rerun, else `chooseArea` for this page's state. */
  qualifiedNext(blank = false): string | undefined {
    const i = this.pages.length;
    const mode = this.modeOf(this.cur) as 'simplex' | 'duplex';
    // 164g.22: position counts the set's VISIT, and only the CURRENT set's own
    // page areas compete -- a nested qualified set is reached by a break alone
    // (p. 310).
    const s: PageState = { position: i === this.visit ? 'first' : 'rest', parity: this.parityOf(i, mode), blank };
    const own = this.ownAreas(this.cur);
    const pick = chooseArea(own.map((x) => this.ps.pageAreas[x]), s, mode);
    const a = this.force?.get(i) ?? (pick === undefined ? undefined : own[pick]);
    if (a === undefined)
      return `no pageArea matches position=${s.position} parity=${s.parity} blank=${String(s.blank)} (XFA 3.3 p. 304)`;
    if (this.ps.pageAreas[a].contentAreas.length === 0 && !blank) {
      // p. 296: boilerplate is emitted and the advance continues; with no
      // occurrence limits a rest/any boilerplate area would match forever.
      if (++this.boiler > own.length)
        return `pageArea ${this.ps.pageAreas[a].name ?? String(a)} has no contentArea and qualifies for every later page, so it would repeat without end (XFA 3.3 p. 296)`;
    } else this.boiler = 0;
    return this.open(a, blank);
  }

  capacity(): number { return this.heights[this.area][this.ca]; }

  snapshot(): State {
    return {
      inst: [...this.inst], uses: [...this.uses], cur: this.cur, visit: this.visit, exits: this.exits.length, area: this.area, ca: this.ca, used: this.used, pages: this.pages.length,
      spent: new Map(this.spent),
      numbered: new Map([...this.numbered].map(([k, v]) => [k, new Map(v)])),
      made: this.made.length,
    };
  }
  restore(s: State): void {
    this.inst.splice(0, this.inst.length, ...s.inst);
    this.uses.splice(0, this.uses.length, ...s.uses);
    this.cur = s.cur; this.visit = s.visit; this.exits.length = s.exits;
    this.area = s.area; this.ca = s.ca; this.used = s.used;
    this.pages.length = s.pages;
    this.spent = new Map(s.spent);
    this.numbered = new Map([...s.numbered].map(([k, v]) => [k, new Map(v)]));
    this.made.length = s.made;
  }

  private canUse(a: number): boolean { return this.maxOf[a] === -1 || this.uses[a] < this.maxOf[a]; }

  /** A set's own page areas, in document order. */
  private ownAreas(s: number): number[] {
    return this.sets[s].children.flatMap((c) => ('area' in c ? [c.area] : []));
  }
  /** Whether page set `s` may take another instance (p. 298-300). */
  private canNew(s: number): boolean { const m = this.sets[s].max; return m === -1 || this.inst[s] < m; }
  /** A new instance of page set `s`: every count below it starts again. */
  private renew(s: number): void { this.inst[s] += 1; this.resetUnder(s); }
  private resetUnder(s: number): void {
    for (const c of this.sets[s].children) {
      if ('area' in c) this.uses[c.area] = 0;
      else { this.inst[c.set] = 0; this.resetUnder(c.set); }
    }
  }
  private enterFresh(s: number): void { this.inst[s] = 1; this.resetUnder(s); }
  private indexIn(s: number, c: { area: number } | { set: number }): number {
    return this.sets[s].children.findIndex((x) => ('area' in c ? 'area' in x && x.area === c.area : 'set' in x && x.set === c.set));
  }
  /** p. 298-299: from child `from` of set `s` on, the first page area that may
   *  take a page -- a nested set ENTERED as a fresh instance and descended
   *  into. Null when nothing there can. */
  private descend(s: number, from: number): string | undefined | null {
    const kids = this.sets[s].children;
    for (let i = from; i < kids.length; i++) {
      const c = kids[i];
      if ('area' in c) { if (this.canUse(c.area)) return this.open(c.area); continue; }
      this.enterFresh(c.set);
      const r = this.descend(c.set, 0);
      if (r !== null) return r;
    }
    return null;
  }
  /** Enter, as fresh instances, the sets strictly below `top` on area `a`'s path. */
  private enterBelow(top: number, a: number): void {
    const path = this.pathOf(this.setOf(a));
    for (const s of path.slice(path.indexOf(top) + 1)) this.enterFresh(s);
  }
  /** The lowest set holding both page areas `a` and `b`. */
  private commonSet(a: number, b: number): number {
    const pa = this.pathOf(this.setOf(a));
    const pb = this.pathOf(this.setOf(b));
    let d = 0;
    while (d + 1 < pa.length && d + 1 < pb.length && pa[d + 1] === pb[d + 1]) d++;
    return pa[d];
  }

  /** A page of page area `a`. One with no content area is pure boilerplate
   *  (p. 296): emitted holding nothing, and the advance continues. */
  private open(a: number, blank = false): string | undefined {
    // A termination rerun lays the page out on its `last`/`only` area however
    // it was opened -- by the natural advance, by the start or by a break:
    // Adobe redoes a break-opened page too (164g.22, n8's page 7).
    if (!blank) a = this.force?.get(this.pages.length) ?? a;
    this.uses[a] += 1;
    this.pages.push({ pageArea: a, pageSet: this.instanceOf(a), contentAreas: [], ...(blank ? { blank: true as const } : {}) });
    this.area = a;
    this.ca = 0;
    this.used = 0;
    // A blank page holds nothing by design; its caller opens the content page.
    return blank || this.ps.pageAreas[a].contentAreas.length > 0 ? undefined : this.nextPage();
  }

  /** The natural next page (p. 298-300): another instance of the current page
   *  area while its max allows, then the next page area in order, then a new
   *  page-set instance from the first. */
  nextPage(): string | undefined {
    if (this.mode !== 'ordered') return this.qualifiedNext();
    if (this.area >= 0 && this.canUse(this.area)) return this.open(this.area);
    // 164g.22 (n1-n3): ascend through the set tree to the first node whose
    // occurrence limit is not exhausted (p. 298-300).
    let s = this.area >= 0 ? this.setOf(this.area) : 0;
    let from = this.area >= 0 ? this.indexIn(s, { area: this.area }) + 1 : 0;
    let renewed = false;
    for (;;) {
      const r = this.descend(s, from);
      if (r !== null) return r;
      // A fresh instance that holds nothing usable is as good as exhausted.
      if (!renewed && this.canNew(s)) { this.renew(s); from = 0; renewed = true; continue; }
      const up = this.sets[s].parent;
      if (up === undefined) return DISCARDED;
      from = this.indexIn(up, { set: s }) + 1;
      s = up;
      renewed = false;
    }
  }

  /** The next content area on this page, else the next page (p. 294). */
  advance(): string | undefined {
    if (this.ca + 1 < this.ps.pageAreas[this.area].contentAreas.length) {
      this.ca += 1;
      this.used = 0;
      return undefined;
    }
    return this.nextPage();
  }

  /** A new page of page area `a` (p. 360-361, 367). Ordered occurrence moves
   *  FORWARD: a page area at or behind the current one is reached through a new
   *  page-set instance once the current instance cannot hold another. */
  private toPageArea(a: number): string | undefined {
    if (this.mode !== 'ordered') {
      const why = this.blankTarget(a);
      if (why !== undefined) return why;
      // 164g.22 (n4, n8, n9; p. 310-311): a break into another page set first
      // terminates the one it leaves.
      const ts = this.setOf(a);
      if (ts !== this.cur) {
        this.exit();
        this.cur = ts;
        this.visit = this.pages.length;
      }
      // p. 305: a target of the other parity is reached through a blank filler
      // -- one of the ENTERED set's areas (n9).
      const oe = this.ps.pageAreas[a].oddOrEven ?? 'any';
      if (this.modeOf(ts) === 'duplex' && oe !== 'any' && oe !== this.parityOf(this.pages.length)) {
        const f = this.qualifiedNext(true);
        if (f !== undefined) return f;
      }
      return this.open(a);
    }
    // 164g.22 (n7): forward, the sets on the target's path are entered fresh;
    // otherwise the lowest common set with an instance left starts another.
    if (this.area < 0) { this.enterBelow(0, a); return this.open(a); }
    const lca = this.commonSet(this.area, a);
    if (a >= this.area) {
      const s = this.snapshot();
      this.enterBelow(lca, a);
      if (this.canUse(a)) return this.open(a);
      this.restore(s);
    }
    for (let x: number | undefined = lca; x !== undefined; x = this.sets[x].parent) {
      if (!this.canNew(x)) continue;
      this.renew(x);
      this.enterBelow(x, a);
      return this.open(a);
    }
    return DISCARDED;
  }

  /** Terminate the current set's visit (p. 306-308, 310): its last page is
   *  laid out again on the set's `only` page area (a one-page visit) or its
   *  `last` one. A page cannot be redone in place, so the exit is recorded for
   *  a rerun to decide; a page a rerun refused to redo gets a blank `last` page
   *  after it (an `only` keeps it), as does one whose preconditions fail. */
  exit(): void {
    if (this.mode === 'ordered') return;
    const k = this.pages.length - 1;
    // A page this run forced IS the termination, already made.
    if (k < this.visit || this.force?.has(k)) return;
    const own = this.ownAreas(this.cur);
    const find = (q: XfaPagePosition): number | undefined => own.find((x) => this.ps.pageAreas[x].pagePosition === q);
    const fin = this.pages[k];
    const holds = !fin.blank && fin.contentAreas.length > 0;
    const only = find('only');
    if (k === this.visit && only !== undefined) {
      if (holds && fin.pageArea !== only && !this.noRedo.has(k)) this.exits.push({ k, area: only, kind: 'only' });
      return;
    }
    const last = find('last');
    if (last === undefined) return;
    const cur = this.ps.pageAreas[fin.pageArea];
    const ok = holds && this.ps.pageAreas[last].contentAreas.length === cur.contentAreas.length
      && cur.pagePosition !== 'first' && cur.pagePosition !== 'last';
    if (ok && !this.noRedo.has(k)) { this.exits.push({ k, area: last, kind: 'last' }); return; }
    this.uses[last] += 1;
    this.pages.push({ pageArea: last, pageSet: this.instanceOf(last), contentAreas: [], blank: true });
  }

  /** p. 310: no break may name a page area qualified `blank`. */
  private blankTarget(a: number): string | undefined {
    const pa = this.ps.pageAreas[a];
    if (this.mode === 'ordered' || pa.blankOrNotBlank !== 'blank') return undefined;
    return `break target "${pa.name ?? pa.id ?? String(a)}" is a pageArea qualified blankOrNotBlank="blank", which no break may name (XFA 3.3 p. 310)`;
  }

  /** Where layout starts (p. 296): the break's target, else the first page area. */
  start(b: XfaBreak | undefined): string | undefined {
    if (b?.refusal !== undefined) return b.refusal;
    if (b?.leader || b?.trailer)
      return 'a break leader or trailer on the break that chooses where layout starts is not implemented (164g.31)';
    // A parity break chooses where layout starts by the mid-document rule:
    // page 1 is odd, so pageEven needs a filler, or can never be met (final review).
    if (b && (b.targetType === 'pageEven' || b.targetType === 'pageOdd'))
      return this.toParity(b.targetType === 'pageEven' ? 'even' : 'odd', b.startNew);
    const want = b?.target !== undefined && (b.targetType === 'pageArea' || b.targetType === 'contentArea')
      ? resolveTarget(this.ps, b.targetType, b.target) : undefined;
    if (want && 'reason' in want) return want.reason;
    if (want) {
      const why = this.blankTarget(want.area);
      if (why !== undefined) return why;
    }
    if (!want) {
      // Rule 3 (p. 296): the first qualified page area of the first page set
      // -- the root's own, else (164g.22) the first nested set holding some.
      if (this.mode !== 'ordered') {
        while (this.ownAreas(this.cur).length === 0) {
          const nx = this.sets[this.cur].children.find((c) => 'set' in c);
          if (!nx || !('set' in nx)) break;
          this.cur = nx.set;
          this.enterFresh(nx.set);
        }
      }
      return this.nextPage();
    }
    this.cur = this.setOf(want.area);
    this.enterBelow(0, want.area);
    const r = this.open(want.area);
    if (r !== undefined) return r;
    if (want.ca !== undefined) this.ca = want.ca;
    return undefined;
  }

  /** `pageEven`/`pageOdd` (p. 296, 305): the next page of that parity, a page
   *  of the other parity in between being a blank filler. Outside duplex every
   *  page is odd, so pageOdd needs no filler and pageEven can never be met --
   *  Adobe lays out nothing at all for one (probes q12, q15), and we refuse. */
  toParity(want: 'odd' | 'even', startNew: boolean): string | undefined {
    const cur = this.pages.length - 1;
    if (this.modeOf(this.cur) !== 'duplex' && want === 'even')
      return 'a pageEven break can never be met: outside duplexPaginated every page is a front (odd) surface (Adobe probes q12, q15)';
    if (!startNew && cur >= 0 && this.parityOf(cur) === want) return undefined;
    if (this.parityOf(cur + 1) !== want) {
      const f = this.qualifiedNext(true);
      if (f !== undefined) return f;
    }
    return this.nextPage();
  }

  apply(b: XfaBreak): string | undefined {
    if (b.refusal !== undefined) return b.refusal;
    if (b.targetType === 'pageEven' || b.targetType === 'pageOdd')
      return this.toParity(b.targetType === 'pageEven' ? 'even' : 'odd', b.startNew);
    if (b.targetType !== 'pageArea' && b.targetType !== 'contentArea')
      return `a break with targetType="${b.targetType}" is not implemented`;
    const tgt = b.target !== undefined ? resolveTarget(this.ps, b.targetType, b.target) : undefined;
    if (tgt && 'reason' in tgt) return tgt.reason;
    if (b.targetType === 'pageArea') {
      // p. 270: with no target, the current page is treated as full.
      if (!tgt) return this.nextPage();
      if (!b.startNew && tgt.area === this.area) return undefined;
      return this.toPageArea(tgt.area);
    }
    if (!tgt) return this.advance();
    const c = tgt.ca ?? 0;
    if (!b.startNew && tgt.area === this.area && c === this.ca) return undefined;
    if (tgt.area === this.area && c > this.ca) { this.ca = c; this.used = 0; return undefined; }
    const r = this.toPageArea(tgt.area);
    if (r !== undefined) return r;
    this.ca = c;
    return undefined;
  }

  place(c: LayoutNode, h: number): void {
    const page = this.pages[this.pages.length - 1];
    let e = page.contentAreas.find((x) => x.index === this.ca);
    if (!e) { e = { index: this.ca, children: [] }; page.contentAreas.push(e); }
    e.children.push(c);
    this.used += h;
  }

  /** The current region, as an <overflow>'s continuation is checked against. */
  regionKey(): string { return `${String(this.pages.length - 1)}:${String(this.ca)}`; }
}

/**
 * The leader or trailer a container continuing at the end of `path` lays down
 * (164g.15, R2, R3): its own `<overflow>` list, else the nearest asserting
 * ancestor's -- the root subform last -- its first entry with a copy left;
 * past a spent list, the next asserting ancestor's (p. 325). An EMPTY list
 * blocks inheritance (t80). A refused entry answers its refusal.
 */
function effectiveCopy(
  p: Paginator, kind: 'leader' | 'trailer', path: readonly LayoutNode[],
): { use: XfaCopySpec } | { refusal: string } | undefined {
  const chain = p.root ? [p.root, ...path] : path;
  for (let i = chain.length - 1; i >= 0; i--) {
    const list = chain[i].overflow?.[kind];
    if (list === undefined) continue;
    if (list.length === 0) return undefined;
    for (const s of list) {
      if (s.refusal !== undefined) return { refusal: s.refusal };
      if (p.left(s)) return { use: s };
    }
  }
  return undefined;
}

/** A container in `path` whose `<overflow target>` would choose where it
 *  continues, which is not implemented (164g.30). */
function targetRefusal(path: readonly LayoutNode[]): string | undefined {
  const n = path.find((x) => x.overflow?.target !== undefined);
  return n && `${n.label}: its <overflow target> would choose where it continues, which is not implemented (164g.30)`;
}

/**
 * Apply root child `label`'s break `b`, laying down its leader and trailer
 * (164g.15 R7). Adobe SWAPS XFA 3.3 Example 8.36's roles (t85, t86): the
 * TRAILER goes into the region the break leaves, the LEADER into the one it
 * enters, both in the content area's flow. What no probe settles refuses by
 * name: a break that does not move, a trailer that does not fit.
 */
function applyBreak(p: Paginator, b: XfaBreak, label: string, height: XfaHeight): string | undefined {
  if (!b.leader && !b.trailer) return p.apply(b);
  if (b.refusal !== undefined) return b.refusal;
  for (const s of [b.trailer, b.leader]) if (s?.refusal !== undefined) return s.refusal;
  // A dry run: `restore` cannot take back a placed node, so nothing is placed
  // until the break is known to move.
  const s0 = p.snapshot();
  const from = p.regionKey();
  const moved = p.apply(b);
  const to = p.regionKey();
  p.restore(s0);
  if (moved !== undefined) return moved;
  if (to === from)
    return `${label}: a break leader or trailer on a break that does not move is not implemented (164g.31)`;
  const lay = (spec: XfaCopySpec, fit: boolean): string | undefined => {
    if (!p.left(spec)) return undefined;
    const node = p.peek(spec);
    const q = height(node, Infinity);
    if ('reason' in q) return q.reason;
    if (fit && p.used + q.h > p.capacity() + EPS)
      return `${label}: its break trailer does not fit the region the break leaves, which is not implemented (164g.31)`;
    p.commit(spec, node);
    p.place(node, q.h);
    return undefined;
  };
  // `lay` refuses an unfitting trailer before it places anything.
  const why = b.trailer ? lay(b.trailer, true) : undefined;
  if (why !== undefined) return why;
  const r = p.apply(b);
  if (r !== undefined) return r;
  return b.leader ? lay(b.leader, false) : undefined;
}

/** The capacity of the region an advance would open, or undefined when no
 *  advance is possible. Changes nothing. */
function nextCapacity(p: Paginator): number | undefined {
  const s = p.snapshot();
  const moved = p.advance();
  const h = moved === undefined ? p.capacity() : undefined;
  p.restore(s);
  return h;
}

/** p. 295 at an EMPTY region, the one owner for a root child and a split's
 *  unit alike: advance when the next region can hold `h`, place when nothing
 *  drawn lies past, otherwise refuse. */
function emptyRegion(
  p: Paginator, h: number, past: () => boolean, label: string,
): { act: 'advance' } | { act: 'place' } | { reason: string } {
  const nextH = nextCapacity(p);
  if (nextH !== undefined && h <= nextH + EPS) return { act: 'advance' };
  if (!past()) return { act: 'place' };
  return { reason: `${label}: does not fit an empty content area and would need ${SPLIT_LATER}` };
}

/** Split a keep-none positioned root child from the room left (164g.11, spec
 *  R1-R8). EVERY cut is decided before anything is placed, so a refusal places
 *  nothing and the child is refused whole: its fields would otherwise land on
 *  some pages and be refused on others. `'whole'` is R5 at the first region --
 *  the cut reached the top -- and the caller places it whole by today's rules. */
function placePositioned(
  p: Paginator, c: LayoutNode, h: number, boxes: XfaChildBoxes, height: XfaHeight,
  lines?: (n: LayoutNode) => number | undefined,
): 'whole' | string | undefined {
  const s = p.snapshot();
  /** 164g.15 R6 (t83): a continuation's leader goes into the CONTENT AREA's
   *  flow, directly above the fragment. */
  type Lead = { spec: XfaCopySpec; node: LayoutNode; h: number };
  const plan: Array<{ node: LayoutNode; h: number; lead?: Lead }> = [];
  let lead: Lead | undefined;
  let cur = c;
  let left = h;
  for (;;) {
    const room = p.capacity() - p.used;
    if (left <= room + EPS) { plan.push({ node: cur, h: left, ...(lead ? { lead } : {}) }); break; }
    const cut = positionedCut(cur, room, boxes, lines);
    if (typeof cut === 'object') { p.restore(s); return cut.refusal; }
    if (cut <= EPS) {
      p.restore(s);
      return plan.length === 0 ? 'whole'
        : `${c.label}: does not fit an empty content area and would need ${SPLIT_LATER}`;
    }
    // 164g.15: it continues. A target is 164g.30's; a trailer is unprobed here.
    const why = targetRefusal([c]);
    if (why !== undefined) { p.restore(s); return why; }
    const tr = effectiveCopy(p, 'trailer', [c]);
    if (tr) {
      p.restore(s);
      return 'refusal' in tr ? tr.refusal
        : `${c.label}: an overflow trailer on a split positioned subform is not implemented (164g.31)`;
    }
    const head = positionedFragment(cur, 0, cut, boxes);
    const tail = positionedFragment(cur, cut, left, boxes);
    if ('refusal' in head) { p.restore(s); return head.refusal; }
    if ('refusal' in tail) { p.restore(s); return tail.refusal; }
    plan.push({ node: head, h: cut, ...(lead ? { lead } : {}) });
    const moved = p.advance();
    if (moved !== undefined) { p.restore(s); return moved; }
    // The leader is committed while planning, so the next continuation counts
    // it; `restore` takes it back before the plan is placed again.
    const ld = effectiveCopy(p, 'leader', [c]);
    if (ld && 'refusal' in ld) { p.restore(s); return ld.refusal; }
    lead = undefined;
    if (ld) {
      const node = p.peek(ld.use);
      const q = height(node, Infinity);
      if ('reason' in q) { p.restore(s); return q.reason; }
      p.commit(ld.use, node);
      p.used += q.h;
      lead = { spec: ld.use, node, h: q.h };
    }
    cur = tail;
    left -= cut;
  }
  p.restore(s);
  plan.forEach((f, i) => {
    if (i > 0) p.advance();
    if (f.lead) { p.commit(f.lead.spec, f.lead.node); p.place(f.lead.node, f.lead.h); }
    p.place(f.node, f.h);
  });
  return undefined;
}

/** The two siblings two consecutive leaves part at, and their parent: R5's
 *  adhesion is decided there, so a container's own keep next makes its LAST
 *  leaf adhere to its next sibling's FIRST (t58, t70). */
function partAt(a: Leaf, b: Leaf): { x: LayoutNode; y: LayoutNode; parent: LayoutNode } | undefined {
  const ca = [...a.path, a.node];
  const cb = [...b.path, b.node];
  let d = 0;
  while (d < ca.length && d < cb.length && ca[d] === cb[d]) d++;
  if (d === 0 || d >= ca.length || d >= cb.length) return undefined;
  return { x: ca[d], y: cb[d], parent: ca[d - 1] };
}

/** Place a splittable root child leaf by leaf, from the room left in the
 *  current region (XFA 3.3 p. 290; 164g.8, 164g.12). A region's leaves form one
 *  fragment tree, and a leaf FITS when the region's fragment with it added,
 *  MEASURED, fits the room left -- so pagination and layout cannot disagree
 *  about a cut, and margins, an lr-tb's re-pack and a table's column widths are
 *  all counted by the engine that lays them out. The first leaf that does not
 *  fit ends the region's fragment; it and every later leaf continue in the next
 *  region, and none returns to an earlier one (rule 1, t37). A leaf too tall for
 *  an EMPTY region takes the p. 295 override as a whole root child does. On a
 *  failure what was placed stays, and the failing leaf and every later one are
 *  refused. Returns the cause, or `undefined` when everything was placed.
 *  Since 164g.14 a leaf that fits but whose adhering next leaf -- or, for the
 *  last leaf, the root child after `c` (`tail`) -- puts nothing into the room
 *  left is held off WHOLE to the next region (R3, R5), when the pair fits that
 *  region; a pair that cannot is not forced here (decision 2). */
function placeSplit(
  p: Paginator, c: LayoutNode, height: XfaHeight, hooks: XfaPaginateHooks,
  refuse: (n: LayoutNode, why: string) => void,
  tail?: (room: number) => boolean, warn: (w: string) => void = () => undefined,
): string | undefined | { unsplittable: string } {
  // A chain that cannot be split places nothing here: the caller falls back to
  // placing it whole, which is what 164g.3 did (164g.8 final review).
  const widths = new Map<LayoutNode, number[]>();
  const flat = flatten(c, hooks, widths);
  if ('reason' in flat) return { unsplittable: flat.reason };
  const leaves = flat.leaves;
  // 164g.14 R5: which visible leaf adheres to which; the unprobed shapes make
  // the chain unsplittable before anything is placed (spec section 4).
  const vis = leaves.flatMap((l, i) => (concealed(l.node) ? [] : [i]));
  const lastVis = vis[vis.length - 1];
  const link = new Map<number, number>();
  for (let a = 0; a + 1 < vis.length; a++) {
    const j = vis[a];
    const k = vis[a + 1];
    const part = partAt(leaves[j], leaves[k]);
    if (!part || !adheres(part.x, part.y)) continue;
    if (part.parent.layout === 'lr-tb')
      return { unsplittable: `${part.x.label}: adhesion between the items of an lr-tb line is not implemented (164g.14)` };
    if (leaves[k].brks.length > 0)
      return { unsplittable: `${part.y.label}: adhesion into a sibling with a breakBefore is not implemented (164g.14)` };
    link.set(j, k);
  }
  /** Whether leaf `k` (adhered to) puts something into a region whose room is
   *  `capRoom`, after `cand` -- and onward along the chain. */
  const chainLead = (cand: Leaf[], k: number, capRoom: number): boolean => {
    const withK = [...cand, leaves[k]];
    const f = fragmentOf(withK, widths);
    const q = height(f, Infinity);
    if ('reason' in q) return true;
    if (q.h <= capRoom + EPS) {
      const n = link.get(k);
      if (n !== undefined) return chainLead(withK, n, capRoom);
      return k === lastVis && tail ? tail(capRoom - q.h) : true;
    }
    return typeof straddle(leaves[k], f, capRoom, hooks, height) === 'object';
  };
  /** Whether leaf `j` (as `cur`) and what it adheres to fit the next region, empty. */
  const fitsNextEmpty = (j: number, cur: Leaf): boolean => {
    const s = p.snapshot();
    const moved = p.advance();
    const capN = moved === undefined ? p.capacity() : 0;
    p.restore(s);
    if (moved !== undefined) return false;
    const q = height(fragmentOf([cur], widths), Infinity);
    if ('reason' in q || q.h > capN + EPS) return false;
    const k = link.get(j);
    if (k !== undefined) return chainLead([cur], k, capN);
    return j === lastVis && tail ? tail(capN - q.h) : true;
  };
  let region: Leaf[] = [];
  let regionH = 0;
  // A hidden leaf whose container is not yet in the region waits for the next
  // visible leaf and joins a region with it, measured together, so no container
  // -- the split one or a nested one -- becomes a fragment holding only margins
  // (final review).
  let pending: Leaf[] = [];
  const flush = (): void => {
    if (!hasVisible(region)) return;
    p.place(fragmentOf(region, widths), regionH);
    region = [];
    regionH = 0;
  };
  const failFrom = (j: number, why: string): string => {
    flush();
    // A hidden leaf still waiting is reported for what it is, not left on no page.
    for (const h of pending) refuse(h.node, `presence="${h.node.presence ?? ''}" takes no space in the layout`);
    pending = [];
    leaves.forEach((l, i) => { if (i >= j) refuse(l.node, i === j ? why : after(why)); });
    return why;
  };
  // 164g.15: a leader or trailer copy as a leaf of `path`'s innermost container.
  type Copy = { spec: XfaCopySpec; leaf: Leaf };
  const copyLeaf = (kind: 'leader' | 'trailer', path: LayoutNode[]): Copy | { refusal: string } | undefined => {
    const e = effectiveCopy(p, kind, path);
    if (!e || 'refusal' in e) return e;
    return { spec: e.use, leaf: { node: p.peek(e.use), path, brks: [] } };
  };
  /** The leader the next region opens with: its container continues (R4). */
  let armed: Copy | undefined;
  /** The containers that continue from leaf `a` to leaf `b`: the deepest
   *  common to both paths is the innermost one (R4, R5). */
  const common = (a: Leaf, b: Leaf): LayoutNode[] => {
    let d = 0;
    while (d < a.path.length && d < b.path.length && a.path[d] === b.path[d]) d++;
    return b.path.slice(0, d);
  };
  /** R4, R5: close this region with the trailer of the innermost container
   *  that continues into the next one -- the deepest common to the region's
   *  last leaf and `next` -- arm that container's leader, and advance. */
  const continueTo = (next: Leaf): string | undefined => {
    if (hasVisible(region)) {
      const path = common(region[region.length - 1], next);
      const why = targetRefusal(path);
      if (why !== undefined) return why;
      const tr = copyLeaf('trailer', path);
      if (tr && 'refusal' in tr) return tr.refusal;
      if (tr) {
        const withT = [...region, tr.leaf];
        const q = height(fragmentOf(withT, widths), Infinity);
        if (!('reason' in q) && p.used + q.h <= p.capacity() + EPS) {
          region = withT;
          regionH = q.h;
          p.commit(tr.spec, tr.leaf.node);
        } else warn(`${tr.spec.label}: an overflow trailer that does not fit the region it closes is not laid down (164g.15)`);
      }
      const ld = copyLeaf('leader', path);
      if (ld && 'refusal' in ld) return ld.refusal;
      armed = ld;
    }
    flush();
    return p.advance();
  };
  for (const [j, l] of leaves.entries()) {
    if (concealed(l.node)) {
      // A hidden leaf joins a container already in this region (no height, no
      // margin added); otherwise it waits for the next visible leaf.
      const home = l.path[l.path.length - 1];
      if (pending.length === 0 && region.some((x) => !concealed(x.node) && x.path.includes(home))) region.push(l);
      else pending.push(l);
      continue;
    }
    if (l.brks.length > 0) {
      // 164g.15: a break that continues a container laying down leaders or
      // trailers -- one common to the leaves either side of it -- or that has
      // its own, is unprobed.
      if (l.brks.some((b) => b.leader || b.trailer))
        return failFrom(j, `${l.node.label}: a break leader or trailer inside a split subform is not implemented (164g.31)`);
      const across = hasVisible(region) ? common(region[region.length - 1], l) : armed?.leaf.path;
      if (across && (effectiveCopy(p, 'leader', across) || effectiveCopy(p, 'trailer', across)))
        return failFrom(j, `${l.node.label}: a break inside a split subform with an overflow leader or trailer is not implemented (164g.31)`);
      flush();
      for (const b of l.brks) {
        const r = p.apply(b);
        if (r !== undefined) return failFrom(j, r);
      }
    }
    let cur = l;
    for (;;) {
      const cap = p.capacity();
      // R4: a continuation opens with its container's leader.
      const base = [...region, ...(armed && !hasVisible(region) ? [armed.leaf] : []), ...pending];
      const cand = [...base, cur];
      const f = fragmentOf(cand, widths);
      const r0 = height(f, Infinity);
      if ('reason' in r0) return failFrom(j, r0.reason);
      // R5 (t89, Example 8.40): the trailer that would close this region is
      // reserved in EVERY fit, the chain's last leaf included.
      const tr = copyLeaf('trailer', cur.path);
      if (tr && 'refusal' in tr) return failFrom(j, tr.refusal);
      let r = r0;
      let trailH = 0;
      if (tr) {
        const q = height(fragmentOf([...cand, tr.leaf], widths), Infinity);
        if ('reason' in q) return failFrom(j, q.reason);
        r = q;
        trailH = q.h - r0.h;
      }
      const fresh = !hasVisible(region);
      let take = p.used + r.h <= cap + EPS;
      // An EMPTY region the reservation alone keeps the leaf out of takes it
      // without the reservation: refusing would lose content no probe shows
      // Adobe losing (decision, 164g.15).
      if (!take && tr && fresh && p.used === 0 && r0.h <= cap + EPS) take = true;
      let split: { head: LayoutNode; tail: LayoutNode } | undefined;
      if (!take) {
        const s = straddle(cur, f, cap - p.used - trailH, hooks, height);
        if (typeof s === 'object') split = s;
        else if (s !== undefined && !(fresh && p.used === 0)) return failFrom(j, s);
        if (!split && fresh && p.used === 0) {
          const past = (): boolean => { const q = height(f, cap); return 'reason' in q ? true : q.past; };
          const e = emptyRegion(p, r.h, past, cur.node.label);
          if ('reason' in e) return failFrom(j, e.reason);
          take = e.act === 'place';
        }
      }
      if (split) {
        // 164g.13: the head piece closes this region, the tail is the leaf retried.
        const headCand = [...base, { ...cur, node: split.head }];
        const q = height(fragmentOf(headCand, widths), Infinity);
        if (!('reason' in q) && p.used + q.h + trailH <= cap + EPS) {
          if (armed && !hasVisible(region)) { p.commit(armed.spec, armed.leaf.node); armed = undefined; }
          region = headCand;
          regionH = q.h;
          pending = [];
          cur = { node: split.tail, path: cur.path, brks: [] };
        }
      } else if (take) {
        // 164g.14 R3, R5: the leaf it adheres to must put something here too.
        const k = link.get(j);
        const lead = k !== undefined ? chainLead(cand, k, cap - p.used)
          : j === lastVis && tail ? tail(cap - p.used - r0.h) : true;
        if (!lead && (hasVisible(region) || p.used > EPS)) {
          if (fitsNextEmpty(j, cur)) {
            const moved = continueTo(cur);
            if (moved !== undefined) return failFrom(j, moved);
            continue;
          }
          warn(`${cur.node.label}: adheres to the content after it, which together cannot fit an empty content area; the adhesion is not kept inside a split subform (164g.14)`);
        }
        if (armed && !hasVisible(region)) { p.commit(armed.spec, armed.leaf.node); armed = undefined; }
        region = cand;
        regionH = r0.h;
        pending = [];
        break;
      }
      const moved = continueTo(cur);
      if (moved !== undefined) return failFrom(j, moved);
    }
  }
  // Trailing hidden leaves close the last region, measured with it.
  if (pending.length > 0) {
    const last = [...region, ...pending];
    const q = height(fragmentOf(last, widths), Infinity);
    region = last;
    if (!('reason' in q)) regionH = q.h;
    pending = [];
  }
  flush();
  // 164g.16: a breakAfter with no leaf after it in the chain takes effect once
  // the chain is placed (t94, t95), before the root child's own breakAfter.
  for (const b of flat.trailing) {
    if (b.leader || b.trailer)
      return `${c.label}: a break leader or trailer inside a split subform is not implemented (164g.31)`;
    const r = p.apply(b);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Paginate `body` (spec section 2); a qualified page set then runs
 *  termination processing (164g.9). */
export function paginate(
  body: XfaBody, height: XfaHeight, hooks: XfaPaginateHooks = {}, force?: ReadonlyMap<number, number>,
): Pagination {
  // A caller's own force asks for one run with no termination (164g.9).
  if (force) return strip(paginateOnce(body, height, hooks, { force, terminate: false }));
  return strip(terminate(body, height, hooks));
}

/** Termination processing (XFA 3.3 p. 306-308): every set visit's last page --
 *  the document's, and since 164g.22 one a break leaves for another page set
 *  (p. 310-311) -- is laid out again on its set's `only` page area (a one-page
 *  visit) or `last` one, by RERUNNING pagination with that page forced -- never
 *  by rewinding it, so 164g.8 and 164g.11 splitting need nothing of their own.
 *  Exits are decided one at a time, in document order. A rerun is accepted
 *  only if it yields as many pages and refuses nothing the run before it
 *  placed, which is what "the content fits" means here. A `last` redo that
 *  cannot be made appends a blank `last` page; an `only` one leaves the page
 *  as it was. No blank back page ends a duplex document, contrary to Example
 *  8.27: Adobe adds none (probes q4, q9). */
function terminate(body: XfaBody, height: XfaHeight, hooks: XfaPaginateHooks): Run {
  let force = new Map<number, number>();
  let noRedo = new Set<number>();
  let run = paginateOnce(body, height, hooks, { force, noRedo, terminate: true });
  while (run.exits.length > 0) {
    const e = run.exits[0];
    const tried = new Map(force).set(e.k, e.area);
    const r = paginateOnce(body, height, hooks, { force: tried, noRedo, terminate: true });
    // The force reaches only a page `qualifiedNext` chooses: one opened by a
    // break or by the start is the break's to name, so a rerun that did not
    // put the area there redid nothing (final review).
    // A rerun runs its own later exits, so the forced page must be the page
    // itself and not a blank `last` one appended after a shorter layout.
    const same = r.pages.length === run.pages.length && r.pages[e.k]?.pageArea === e.area && r.pages[e.k].blank !== true
      && r.refused.size === run.refused.size && [...run.refused.keys()].every((x) => r.refused.has(x));
    if (same) { force = tried; run = r; continue; }
    noRedo = new Set(noRedo).add(e.k);
    run = paginateOnce(body, height, hooks, { force, noRedo, terminate: true });
  }
  return run;
}

/** One pagination run, and the exits it left for a rerun to decide. */
type Run = Pagination & { exits: PendingExit[] };
const strip = ({ exits: _e, ...rest }: Run): Pagination => { void _e; return rest; };

function paginateOnce(
  body: XfaBody, height: XfaHeight, hooks: XfaPaginateHooks,
  o: { force?: ReadonlyMap<number, number>; noRedo?: ReadonlySet<number>; terminate: boolean },
): Run {
  const force = o.force;
  const refused = new Map<LayoutNode, string>();
  const warnings: string[] = [];
  const kids = body.root.children;
  const refuseAll = (why: string): Run => {
    for (const c of kids) refused.set(c, why);
    return { pages: [], refused, warnings, copies: [], exits: [] };
  };
  const ps = body.pageSet;
  if (!ps) return refuseAll('the root subform declares no <pageSet>, so no page can be laid out');
  if (ps.refusal !== undefined) return refuseAll(ps.refusal);
  warnings.push(...(ps.warnings ?? []));
  const lay = body.root.layout ?? 'position';
  if (lay !== 'tb') return refuseAll(`the root subform's layout "${lay}" is not paginated (only tb)`);
  if (!ps.pageAreas.some((p) => p.contentAreas.length > 0))
    return refuseAll('no pageArea declares a contentArea, so no content can be laid out (XFA 3.3 p. 296)');
  const heights: number[][] = [];
  for (const pa of ps.pageAreas) {
    const row: number[] = [];
    for (const ca of pa.contentAreas) {
      const h = ca.node.geom.h === undefined ? undefined : measureToPt(ca.node.geom.h);
      if (h === undefined)
        return refuseAll(`contentArea ${ca.name ?? ca.id ?? '(unnamed)'} states no readable h, so it cannot be filled`);
      row.push(h);
    }
    heights.push(row);
  }
  // p. 298: a pure-boilerplate page area with no max would emit pages forever;
  // read its max as 1, with a warning.
  const mode: PaginationMode = ps.relation === 'simplexPaginated' ? 'simplex'
    : ps.relation === 'duplexPaginated' ? 'duplex' : 'ordered';
  const maxOf = mode !== 'ordered' ? ps.pageAreas.map(() => -1) : ps.pageAreas.map((pa, i) => {
    if (pa.contentAreas.length > 0 || pa.max !== -1) return pa.max;
    warnings.push(`pageArea ${pa.name ?? String(i)} has no contentArea and no occur max, so its max is read as 1 (XFA 3.3 p. 298)`);
    return 1;
  });

  const p = new Paginator(ps, maxOf, heights, mode, force, body.root, ps.sets, o.noRedo);
  // p. 296: the root's break, else its first subform child's, chooses the start.
  // Rule 2 applies only "Else": when the ROOT's break chose the start, the
  // first child's break is an ordinary break on entry and still runs.
  const first = kids.find((c) => c.kind === 'subform' && !concealed(c));
  const started = p.start(body.root.breakBefore ?? first?.breakBefore);
  if (started !== undefined) return refuseAll(started);
  const consumed = body.root.breakBefore === undefined ? first : undefined;

  let cause: string | undefined;
  /** The run-away member of an R4 pair goes next, in this region (164g.14). */
  let runAway = false;
  const warn = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
  for (const [i, c] of kids.entries()) {
    if (cause !== undefined) { refused.set(c, after(cause)); continue; }
    if (concealed(c)) { p.place(c, 0); continue; }
    const fail = (why: string): void => { refused.set(c, why); cause = why; };
    // Section 4 (final review): a later chain member no probe settles is not
    // forced -- it is laid out as before, so no form that converted loses it.
    if (runAway && (splittable(c) || (hooks.boxes && positionedSplittable(c)) || c.breakBefore)) {
      runAway = false;
      warn(`${c.label}: adheres to a run-away chain, and is splittable or breaks; the adhesion is not kept (164g.14)`);
    }
    if (runAway) {
      // R4 (t59, t69): placed after the one it adheres to, running past this
      // region -- only when nothing it draws lies past (p. 295's posture).
      runAway = false;
      const r = height(c, p.capacity() - p.used);
      if ('reason' in r) { fail(r.reason); continue; }
      if (r.past) {
        fail(`${c.label}: adheres to the content before it, which together cannot fit an empty content area, and draws past the content area (164g.14 R4)`);
        continue;
      }
      p.place(c, r.h);
      // A chain runs past whole.
      if (nextAdhering(kids, i) !== undefined) runAway = true;
      if (c.breakAfter) {
        const ra = applyBreak(p, c.breakAfter, c.label, height);
        if (ra !== undefined) cause = ra;
      }
      continue;
    }
    if (c.breakBefore && c !== consumed) {
      const r = applyBreak(p, c.breakBefore, c.label, height);
      if (r !== undefined) { fail(r); continue; }
    }
    let placed = false;
    // Why a splittable child's chain could not be split, once tried: it is then
    // placed whole, and named if it does not fit an empty region either.
    let unsplit: string | undefined;
    for (;;) {
      const H = p.capacity();
      const r = height(c, H);
      if ('reason' in r) { fail(r.reason); break; }
      const split = splittable(c) && unsplit === undefined;
      // A splittable child whose chain holds a break is split even when it fits.
      const breaks = split && innerBreak(c);
      // 164g.15 R5 (t89): with a trailer to lay down, a splittable child fits
      // whole only with the trailer's room left; otherwise it splits.
      let need = r.h;
      if (split) {
        const t = effectiveCopy(p, 'trailer', [c]);
        if (t && 'refusal' in t) { fail(t.refusal); break; }
        if (t) {
          const q = height({ ...c, children: [...c.children, p.peek(t.use)] }, H);
          if ('reason' in q) { fail(q.reason); break; }
          need = q.h;
        }
      }
      if (!breaks && p.used + need <= H + EPS) {
        const k = keepWith(p, kids, i, H - p.used - r.h, r.h, height, hooks);
        if (k === 'advance') {
          const moved = p.advance();
          if (moved !== undefined) { fail(moved); break; }
          continue;
        }
        if (k === 'force') runAway = true;
        else if (typeof k === 'object') warn(k.warning);
        p.place(c, r.h); placed = true; break;
      }
      if (split) {
        // p. 290: the top goes into the current region (164g.8).
        // 164g.14: the split child's last piece adheres to the next root child.
        const iy = nextAdhering(kids, i);
        const tail = iy === undefined ? undefined : (room: number): boolean => {
          const l = leadFits(kids, iy, room, height, hooks);
          if (typeof l === 'object') { warn(l.fallback); return true; }
          return l === 'yes';
        };
        const why = placeSplit(p, c, height, hooks, (n, w) => refused.set(n, w), tail, warn);
        if (typeof why === 'object') { unsplit = why.unsplittable; continue; }
        if (why !== undefined) cause = why; else placed = true;
        break;
      }
      if (hooks.boxes && positionedSplittable(c)) {
        // 164g.11: a keep-none positioned root child splits where Adobe does.
        const why = placePositioned(p, c, r.h, hooks.boxes, height, hooks.fieldLines);
        if (why === undefined) {
          // Decision 3: adhesion out of a split positioned subform is unprobed.
          if (nextAdhering(kids, i) !== undefined)
            warn(`${c.label}: adhesion out of a positioned subform that splits is not implemented (164g.14)`);
          placed = true; break;
        }
        if (why !== 'whole') { fail(why); break; }
      }
      if (c.kind === 'subform' && (c.layout ?? 'position') === 'position' && c.refusal === undefined
        && !positionedSplittable(c)) {
        // 164g.19 (t4): a positioned subform that does not split and that the
        // next, empty, region cannot hold either is placed whole HERE, running
        // past the content area -- ink included, and whatever the region holds.
        const nextH = nextCapacity(p);
        if (nextH !== undefined && r.h > nextH + EPS) { p.place(c, r.h); placed = true; break; }
      }
      if (p.used === 0) {
        // p. 295: the region is EMPTY. Override its boundary only when the next
        // region cannot hold the child either, and only when nothing it draws
        // lies past -- anything else needs splitting.
        const e = emptyRegion(p, r.h, () => r.past, c.label);
        if ('reason' in e) { fail(unsplit ?? e.reason); break; }
        if (e.act === 'place') { p.place(c, r.h); placed = true; break; }
      }
      const moved = p.advance();
      if (moved !== undefined) { fail(moved); break; }
    }
    if (placed && c.breakAfter) {
      const r = applyBreak(p, c.breakAfter, c.label, height);
      if (r !== undefined) cause = r;
    }
  }
  // The document's end terminates the set it ends in (p. 306-308).
  if (o.terminate && p.pages.length > 0) p.exit();
  return { pages: p.pages, refused, warnings, copies: [...p.made], exits: p.exits };
}

export interface LaidOutPage {
  pageArea: number; pageSet: number; placed: Map<string, Placed>;
  /** Every node placed on the page, in document order (164g.4). */
  nodes: PlacedNode[];
}
export interface XfaLayoutResult {
  pages: LaidOutPage[];
  /** Field SOM name to the reason pagination refused the root child above it. */
  refused: Map<string, string>;
  /** The leader and trailer copies laid down (164g.15), by root node. */
  copies: LayoutNode[];
}

/** Paginate, then lay every content area out through `xfaflow.ts`. The ONE
 *  owner of "where is this field, on which page", shared by the converter and
 *  the oracles. */
export function layoutPages(
  body: XfaBody, measure?: XfaMeasure, warnings: string[] = [], lines?: (n: LayoutNode) => number | undefined,
): XfaLayoutResult {
  // Heights are measured again when the page is laid out, which records any
  // swap warning; the measuring pass's own copy is discarded.
  // A root child is laid out in its content area's tb flow (xfatemplate builds
  // every body content area with layout tb), so it is measured as one: a
  // container's min* does not apply there (bkdi), and pagination and layout
  // must agree on its height.
  const m = measure && memoMeasure(measure);
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, m, [], 'tb'), layoutHooks(m, lines));
  warnings.push(...pg.warnings);
  const refused = new Map<string, string>();
  const mark = (n: LayoutNode, why: string): void => {
    if (n.field !== undefined) refused.set(n.field, why);
    for (const c of n.children) mark(c, why);
  };
  for (const [n, why] of pg.refused) mark(n, why);
  const pages = pg.pages.map((p) => {
    const placed = new Map<string, Placed>();
    const nodes: PlacedNode[] = [];
    for (const ca of p.contentAreas) {
      const node = body.pageSet!.pageAreas[p.pageArea].contentAreas[ca.index].node;
      for (const [k, v] of layoutPage({ ...node, children: ca.children }, m, warnings, nodes)) {
        placed.set(k, placed.has(k)
          ? { reason: `two fields share the SOM name ${k}, so neither can be placed by it` } : v);
      }
    }
    return { pageArea: p.pageArea, pageSet: p.pageSet, placed, nodes };
  });
  return { pages, refused, copies: pg.copies };
}
