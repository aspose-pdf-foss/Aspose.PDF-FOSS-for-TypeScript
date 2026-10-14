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
  layoutPage, measureExtent, insetsOf, positionedChildBoxes, SPLIT_LATER,
  type LayoutNode, type Placed, type PlacedNode, type XfaBreak, type XfaMeasure,
} from './xfaflow.js';
import { measureToPt, type XfaMedium } from './xfageom.js';
import {
  positionedCut, positionedFragment, positionedSplittable, type XfaChildBoxes,
} from './xfasplitpos.js';

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
}
export interface XfaPageSet {
  /** `relation`, `orderedOccurrence` when absent. */
  relation: string;
  max: number;
  pageAreas: XfaPageAreaModel[];
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
}
/** A child's laid-out height, and whether it draws anything below `limit`. */
export type XfaHeight = (n: LayoutNode, limit: number) => { h: number; past: boolean } | { reason: string };

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

/** XFA 3.3 p. 291-292, narrowed to what 164g.8 implements: a tb subform with no
 *  stated h whose keep intact is none splits BETWEEN its children. Its parent is
 *  always a flow -- the content area, or a tb being split -- where a subform's
 *  intact defaults to none (a positioned parent would default it to
 *  contentArea). A positioned subform splits geometrically instead, when it
 *  states keep intact="none" (xfasplitpos.ts, 164g.11). */
export function splittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && n.layout === 'tb' && n.geom.h === undefined
    && n.refusal === undefined && (n.keep?.intact ?? 'none') === 'none';
}

/** One piece of a split chain: a container's top margin, a child placed whole,
 *  or a bottom margin. `path` is the chain of containers from the root child to
 *  the atom's container, last (for open/close, the container itself). `brk` is
 *  the child's `breakBefore`, on a leaf or on a flattened child's `open`. */
interface Atom { kind: 'open' | 'leaf' | 'close'; node: LayoutNode; h: number; path: LayoutNode[]; brk?: XfaBreak }
/** Atoms that share a region. No split falls inside a margin (p. 291), so an
 *  `open` travels with the atom after it and a `close` with the one before;
 *  every unit but an empty container's holds a leaf. `lead` is the height of
 *  the opens above the leaf. */
interface Unit { atoms: Atom[]; h: number; leaf?: Atom; lead: number }

/** What 164g.8 cannot do inside a split chain, named for its issue. */
function chainRefusal(k: LayoutNode): string | undefined {
  if (k.breakAfter)
    return `${k.label}: a breakAfter inside a split subform is not implemented (164g.16)`;
  if (k.keep?.intact === 'pageArea')
    return `${k.label}: keep intact="pageArea" in a split subform is not implemented (164g.14)`;
  if ((k.keep?.next ?? 'none') !== 'none' || (k.keep?.previous ?? 'none') !== 'none')
    return `${k.label}: keep next/previous (adhesion) in a split subform is not implemented (164g.14)`;
  return undefined;
}

/** A splittable node as atoms, recursing into splittable children. A child's
 *  height is measured in its tb parent, which is what `measureExtent` with
 *  `'tb'` gives (bkdi), so the atoms sum to the node's own extent. */
function flatten(
  c: LayoutNode, height: XfaHeight, path: LayoutNode[] = [], brk?: XfaBreak,
): Atom[] | { reason: string } {
  const m = insetsOf(c);
  if ('reason' in m) return { reason: m.reason };
  const chain = [...path, c];
  const out: Atom[] = [{ kind: 'open', node: c, h: m.t, path: chain, ...(brk ? { brk } : {}) }];
  for (const k of c.children) {
    // A hidden child takes no part in layout (p. 67): no height, and its break
    // and refusals do not apply -- as at the root.
    if (concealed(k)) { out.push({ kind: 'leaf', node: k, h: 0, path: chain }); continue; }
    const why = chainRefusal(k);
    if (why !== undefined) return { reason: why };
    if (splittable(k)) {
      const inner = flatten(k, height, chain, k.breakBefore);
      if ('reason' in inner) return inner;
      out.push(...inner);
      continue;
    }
    const r = height(k, Infinity);
    if ('reason' in r) return r;
    out.push({ kind: 'leaf', node: k, h: r.h, path: chain, ...(k.breakBefore ? { brk: k.breakBefore } : {}) });
  }
  out.push({ kind: 'close', node: c, h: m.b, path: chain });
  return out;
}

function unitsOf(atoms: Atom[]): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < atoms.length) {
    const u: Unit = { atoms: [], h: 0, lead: 0 };
    while (i < atoms.length && atoms[i].kind === 'open') { u.lead += atoms[i].h; u.atoms.push(atoms[i++]); }
    if (i < atoms.length && atoms[i].kind === 'leaf') { u.leaf = atoms[i]; u.atoms.push(atoms[i++]); }
    while (i < atoms.length && atoms[i].kind === 'close') u.atoms.push(atoms[i++]);
    u.h = u.atoms.reduce((t, a) => t + a.h, 0);
    units.push(u);
  }
  return units;
}

/** Whether a splittable node's chain holds a `breakBefore` below it: such a
 *  node is split even when it fits, since a break takes effect wherever it sits
 *  (spec decision #3). */
function innerBreak(c: LayoutNode): boolean {
  return c.children.some((k) => !concealed(k)
    && (k.breakBefore !== undefined || (splittable(k) && innerBreak(k))));
}

/** The cursor: page-set instance, page-area instances, content area, height used. */
interface State { set: number; uses: number[]; area: number; ca: number; used: number; pages: number }

class Paginator {
  readonly pages: PaginatedPage[] = [];
  private set = 0;
  private readonly uses: number[];
  area = -1;
  ca = 0;
  used = 0;

  constructor(
    private readonly ps: XfaPageSet, private readonly maxOf: readonly number[],
    private readonly heights: readonly number[][],
    readonly mode: PaginationMode = 'ordered',
    private readonly force?: ReadonlyMap<number, number>,
  ) { this.uses = ps.pageAreas.map(() => 0); }

  /** Page `i`'s parity (p. 303): under duplex the physical surface count's,
   *  which starts at zero, so page 1 is odd. Otherwise every page is a front
   *  and so odd -- simplex by p. 303, and the ordered relation by Adobe probe
   *  q11, where a pageOdd break takes the very next page. */
  parityOf(i: number): 'odd' | 'even' {
    if (this.mode !== 'duplex') return 'odd';
    return i % 2 === 0 ? 'odd' : 'even';
  }

  /** Consecutive boilerplate pages opened by `qualifiedNext`. */
  private boiler = 0;

  /** The next page under a qualified strategy (p. 302-304): the forced page
   *  area for a termination rerun, else `chooseArea` for this page's state. */
  qualifiedNext(blank = false): string | undefined {
    const i = this.pages.length;
    const s: PageState = { position: i === 0 ? 'first' : 'rest', parity: this.parityOf(i), blank };
    const a = this.force?.get(i) ?? chooseArea(this.ps.pageAreas, s, this.mode as 'simplex' | 'duplex');
    if (a === undefined)
      return `no pageArea matches position=${s.position} parity=${s.parity} blank=${String(s.blank)} (XFA 3.3 p. 304)`;
    if (this.ps.pageAreas[a].contentAreas.length === 0 && !blank) {
      // p. 296: boilerplate is emitted and the advance continues; with no
      // occurrence limits a rest/any boilerplate area would match forever.
      if (++this.boiler > this.ps.pageAreas.length)
        return `pageArea ${this.ps.pageAreas[a].name ?? String(a)} has no contentArea and qualifies for every later page, so it would repeat without end (XFA 3.3 p. 296)`;
    } else this.boiler = 0;
    return this.open(a, blank);
  }

  capacity(): number { return this.heights[this.area][this.ca]; }

  snapshot(): State {
    return { set: this.set, uses: [...this.uses], area: this.area, ca: this.ca, used: this.used, pages: this.pages.length };
  }
  restore(s: State): void {
    this.set = s.set;
    this.uses.splice(0, this.uses.length, ...s.uses);
    this.area = s.area; this.ca = s.ca; this.used = s.used;
    this.pages.length = s.pages;
  }

  private canUse(a: number): boolean { return this.maxOf[a] === -1 || this.uses[a] < this.maxOf[a]; }

  private newSet(): boolean {
    if (this.ps.max !== -1 && this.set + 1 >= this.ps.max) return false;
    this.set += 1;
    this.uses.fill(0);
    return true;
  }

  /** A page of page area `a`. One with no content area is pure boilerplate
   *  (p. 296): emitted holding nothing, and the advance continues. */
  private open(a: number, blank = false): string | undefined {
    this.uses[a] += 1;
    this.pages.push({ pageArea: a, pageSet: this.set, contentAreas: [], ...(blank ? { blank: true as const } : {}) });
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
    const n = this.ps.pageAreas.length;
    if (this.area >= 0 && this.canUse(this.area)) return this.open(this.area);
    for (let a = this.area + 1; a < n; a++) if (this.canUse(a)) return this.open(a);
    if (!this.newSet()) return DISCARDED;
    for (let a = 0; a < n; a++) if (this.canUse(a)) return this.open(a);
    return DISCARDED;
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
      // p. 305: a target of the other parity is reached through a blank filler.
      const oe = this.ps.pageAreas[a].oddOrEven ?? 'any';
      if (this.mode === 'duplex' && oe !== 'any' && oe !== this.parityOf(this.pages.length)) {
        const f = this.qualifiedNext(true);
        if (f !== undefined) return f;
      }
      return this.open(a);
    }
    if (a >= this.area && this.canUse(a)) return this.open(a);
    if (!this.newSet()) return DISCARDED;
    return this.open(a);
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
    if (!want) return this.nextPage();
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
    if (this.mode !== 'duplex' && want === 'even')
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

  /** Fragments per region (`page:contentArea`), each keyed by the container it
   *  copies (164g.8). */
  private readonly frags = new Map<string, Map<LayoutNode, LayoutNode>>();

  /** Place a split's unit into the current region, as fragments: shallow copies
   *  of its containers holding only this region's children. A fragment keeps a
   *  margin only where its `open` or `close` atom landed. */
  /** The current region, as fragments are keyed. */
  regionKey(): string { return `${String(this.pages.length - 1)}:${String(this.ca)}`; }

  placeUnit(u: Unit): void {
    const key = this.regionKey();
    let fm = this.frags.get(key);
    if (!fm) { fm = new Map(); this.frags.set(key, fm); }
    for (const a of u.atoms) {
      const f = this.fragment(fm, a.path);
      if (a.kind === 'leaf') f.children.push(a.node);
      else if (a.kind === 'open' && a.node.margin?.topInset !== undefined) f.margin = { ...f.margin, topInset: a.node.margin.topInset };
      else if (a.kind === 'close' && a.node.margin?.bottomInset !== undefined) f.margin = { ...f.margin, bottomInset: a.node.margin.bottomInset };
    }
    this.used += u.h;
  }

  /** The fragment of `path`'s last container in this region, made (with its
   *  ancestors) on first use. */
  private fragment(fm: Map<LayoutNode, LayoutNode>, path: LayoutNode[]): LayoutNode {
    let parent: LayoutNode | undefined;
    for (const c of path) {
      let f = fm.get(c);
      if (!f) {
        const margin = { ...(c.margin ?? {}) };
        delete margin.topInset;
        delete margin.bottomInset;
        f = { ...c, children: [], margin };
        fm.set(c, f);
        if (parent) parent.children.push(f);
        else this.place(f, 0);
      }
      parent = f;
    }
    return parent!;
  }
}

/** p. 295 at an EMPTY region, the one owner for a root child and a split's
 *  unit alike: advance when the next region can hold `h`, place when nothing
 *  drawn lies past, otherwise refuse. */
function emptyRegion(
  p: Paginator, h: number, past: () => boolean, label: string,
): { act: 'advance' } | { act: 'place' } | { reason: string } {
  const s = p.snapshot();
  const moved = p.advance();
  const nextH = moved === undefined ? p.capacity() : 0;
  p.restore(s);
  if (moved === undefined && h <= nextH + EPS) return { act: 'advance' };
  if (!past()) return { act: 'place' };
  return { reason: `${label}: does not fit an empty content area and would need ${SPLIT_LATER}` };
}

/** Split a keep-none positioned root child from the room left (164g.11, spec
 *  R1-R8). EVERY cut is decided before anything is placed, so a refusal places
 *  nothing and the child is refused whole: its fields would otherwise land on
 *  some pages and be refused on others. `'whole'` is R5 at the first region --
 *  the cut reached the top -- and the caller places it whole by today's rules. */
function placePositioned(p: Paginator, c: LayoutNode, h: number, boxes: XfaChildBoxes): 'whole' | string | undefined {
  const s = p.snapshot();
  const plan: Array<{ node: LayoutNode; h: number }> = [];
  let cur = c;
  let left = h;
  for (;;) {
    const room = p.capacity() - p.used;
    if (left <= room + EPS) { plan.push({ node: cur, h: left }); break; }
    const cut = positionedCut(cur, room, boxes);
    if (typeof cut === 'object') { p.restore(s); return cut.refusal; }
    if (cut <= EPS) {
      p.restore(s);
      return plan.length === 0 ? 'whole'
        : `${c.label}: does not fit an empty content area and would need ${SPLIT_LATER}`;
    }
    if (c.overflow) {
      p.restore(s);
      return `${c.label}: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)`;
    }
    const head = positionedFragment(cur, 0, cut, boxes);
    const tail = positionedFragment(cur, cut, left, boxes);
    if ('refusal' in head) { p.restore(s); return head.refusal; }
    if ('refusal' in tail) { p.restore(s); return tail.refusal; }
    plan.push({ node: head, h: cut });
    const moved = p.advance();
    if (moved !== undefined) { p.restore(s); return moved; }
    cur = tail;
    left -= cut;
  }
  p.restore(s);
  plan.forEach((f, i) => {
    if (i > 0) p.advance();
    p.place(f.node, f.h);
  });
  return undefined;
}

/** Place a splittable root child unit by unit, from the room left in the
 *  current region (XFA 3.3 p. 290). A unit that does not fit a region holding
 *  content moves to the next; one too tall for an EMPTY region takes the p. 295
 *  override as a whole root child does. On a failure the units already placed
 *  stay, and the failing leaf and every later one are refused. Returns the
 *  cause, or `undefined` when everything was placed. */
function placeSplit(
  p: Paginator, c: LayoutNode, height: XfaHeight, refuse: (n: LayoutNode, why: string) => void,
): string | undefined | { unsplittable: string } {
  // A chain 164g.8 cannot split places nothing here: the caller falls back to
  // placing it whole, which is what 164g.3 did (final review).
  const atoms = flatten(c, height);
  if ('reason' in atoms) return { unsplittable: atoms.reason };
  const units = unitsOf(atoms);
  const failFrom = (j: number, why: string): string => {
    units.forEach((u, i) => { if (i >= j && u.leaf) refuse(u.leaf.node, i === j ? why : after(why)); });
    return why;
  };
  // A container with an <overflow> may not continue into a second region: XFA
  // would insert its leader or trailer there (164g.15).
  const first = new Map<LayoutNode, string>();
  const continues = (u: Unit): string | undefined => {
    const key = p.regionKey();
    for (const a of u.atoms) for (const n of a.path) {
      if (!n.overflow) continue;
      const k = first.get(n);
      if (k !== undefined && k !== key)
        return `${n.label}: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)`;
      first.set(n, key);
    }
    return undefined;
  };
  for (const [j, u] of units.entries()) {
    for (const a of u.atoms) {
      if (!a.brk) continue;
      const r = p.apply(a.brk);
      if (r !== undefined) return failFrom(j, r);
    }
    for (;;) {
      const H = p.capacity();
      if (p.used + u.h <= H + EPS) {
        const why = continues(u);
        if (why !== undefined) return failFrom(j, why);
        p.placeUnit(u);
        break;
      }
      if (p.used === 0) {
        const past = (): boolean => {
          if (!u.leaf) return false;
          const r = height(u.leaf.node, H - u.lead);
          return 'reason' in r ? true : r.past;
        };
        const e = emptyRegion(p, u.h, past, (u.leaf?.node ?? c).label);
        if ('reason' in e) return failFrom(j, e.reason);
        if (e.act === 'place') {
          const why = continues(u);
          if (why !== undefined) return failFrom(j, why);
          p.placeUnit(u);
          break;
        }
      }
      const moved = p.advance();
      if (moved !== undefined) return failFrom(j, moved);
    }
  }
  return undefined;
}

/** Paginate `body` (spec section 2); a qualified page set then runs
 *  termination processing (164g.9). */
export function paginate(
  body: XfaBody, height: XfaHeight, boxes?: XfaChildBoxes, force?: ReadonlyMap<number, number>,
): Pagination {
  const first = paginateOnce(body, height, boxes, force);
  const rel = body.pageSet?.relation;
  if (force || (rel !== 'simplexPaginated' && rel !== 'duplexPaginated')) return first;
  return terminate(body, height, boxes, first);
}

/** Termination processing (XFA 3.3 p. 306-308): the final page is laid out
 *  again on the page area qualified `only` (a single page) or `last`, by
 *  RERUNNING pagination with that one page forced -- never by rewinding it, so
 *  164g.8 and 164g.11 splitting need nothing of their own. A rerun is accepted
 *  only if it yields as many pages and refuses nothing the first run placed,
 *  which is what "the content fits" means here. A `last` redo that cannot be
 *  made appends a blank `last` page; an `only` one leaves the page as it was.
 *  No blank back page ends a duplex document, contrary to Example 8.27: Adobe
 *  adds none (probes q4, q9). */
function terminate(body: XfaBody, height: XfaHeight, boxes: XfaChildBoxes | undefined, first: Pagination): Pagination {
  const areas = body.pageSet!.pageAreas;
  const n = first.pages.length;
  if (n === 0) return first;
  const k = n - 1;
  const fin = first.pages[k];
  const holds = !fin.blank && fin.contentAreas.length > 0;
  const redo = (a: number): Pagination | undefined => {
    const r = paginateOnce(body, height, boxes, new Map([[k, a]]));
    // The force reaches only a page `qualifiedNext` chooses: one opened by a
    // break or by the start is the break's to name, so a rerun that did not
    // put `a` there redid nothing (final review).
    const same = r.pages.length === n && r.pages[k].pageArea === a
      && r.refused.size === first.refused.size && [...first.refused.keys()].every((x) => r.refused.has(x));
    return same ? r : undefined;
  };
  const find = (q: XfaPagePosition): number => areas.findIndex((pa) => pa.pagePosition === q);
  const only = find('only');
  const last = find('last');
  if (n === 1 && only >= 0) return holds ? redo(only) ?? first : first;
  if (last < 0) return first;
  const cur = areas[fin.pageArea];
  const ok = holds && areas[last].contentAreas.length === cur.contentAreas.length
    && cur.pagePosition !== 'first' && cur.pagePosition !== 'last';
  return (ok ? redo(last) : undefined)
    ?? { ...first, pages: [...first.pages, { pageArea: last, pageSet: 0, contentAreas: [], blank: true }] };
}

function paginateOnce(
  body: XfaBody, height: XfaHeight, boxes?: XfaChildBoxes, force?: ReadonlyMap<number, number>,
): Pagination {
  const refused = new Map<LayoutNode, string>();
  const warnings: string[] = [];
  const kids = body.root.children;
  const refuseAll = (why: string): Pagination => {
    for (const c of kids) refused.set(c, why);
    return { pages: [], refused, warnings };
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

  const p = new Paginator(ps, maxOf, heights, mode, force);
  // p. 296: the root's break, else its first subform child's, chooses the start.
  // Rule 2 applies only "Else": when the ROOT's break chose the start, the
  // first child's break is an ordinary break on entry and still runs.
  const first = kids.find((c) => c.kind === 'subform' && !concealed(c));
  const started = p.start(body.root.breakBefore ?? first?.breakBefore);
  if (started !== undefined) return refuseAll(started);
  const consumed = body.root.breakBefore === undefined ? first : undefined;

  let cause: string | undefined;
  for (const c of kids) {
    if (cause !== undefined) { refused.set(c, after(cause)); continue; }
    if (concealed(c)) { p.place(c, 0); continue; }
    const fail = (why: string): void => { refused.set(c, why); cause = why; };
    if (c.breakBefore && c !== consumed) {
      const r = p.apply(c.breakBefore);
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
      if (!breaks && p.used + r.h <= H + EPS) { p.place(c, r.h); placed = true; break; }
      if (split) {
        // p. 290: the top goes into the current region (164g.8).
        const why = placeSplit(p, c, height, (n, w) => refused.set(n, w));
        if (typeof why === 'object') { unsplit = why.unsplittable; continue; }
        if (why !== undefined) cause = why; else placed = true;
        break;
      }
      if (boxes && positionedSplittable(c)) {
        // 164g.11: a keep-none positioned root child splits where Adobe does.
        const why = placePositioned(p, c, r.h, boxes);
        if (why === undefined) { placed = true; break; }
        if (why !== 'whole') { fail(why); break; }
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
      const r = p.apply(c.breakAfter);
      if (r !== undefined) cause = r;
    }
  }
  return { pages: p.pages, refused, warnings };
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
}

/** Paginate, then lay every content area out through `xfaflow.ts`. The ONE
 *  owner of "where is this field, on which page", shared by the converter and
 *  the oracles. */
export function layoutPages(body: XfaBody, measure?: XfaMeasure, warnings: string[] = []): XfaLayoutResult {
  // Heights are measured again when the page is laid out, which records any
  // swap warning; the measuring pass's own copy is discarded.
  // A root child is laid out in its content area's tb flow (xfatemplate builds
  // every body content area with layout tb), so it is measured as one: a
  // container's min* does not apply there (bkdi), and pagination and layout
  // must agree on its height.
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, measure, [], 'tb'),
    (n) => positionedChildBoxes(n, measure));
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
      for (const [k, v] of layoutPage({ ...node, children: ca.children }, measure, warnings, nodes)) {
        placed.set(k, placed.has(k)
          ? { reason: `two fields share the SOM name ${k}, so neither can be placed by it` } : v);
      }
    }
    return { pageArea: p.pageArea, pageSet: p.pageSet, placed, nodes };
  });
  return { pages, refused };
}
