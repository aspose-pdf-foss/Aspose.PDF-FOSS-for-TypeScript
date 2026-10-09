/**
 * XFA layout: a page's layout tree to a box per field, or a named reason
 * (`164g.1`).
 *
 * **Invariant: a pure leaf over `xfageom.js`.** No `Document`, no PDF object,
 * no `node:` import -- every rule is drivable from a hand-built tree.
 *
 * **Invariant: it never throws.** A node that cannot be laid out is a
 * `{ reason }`, which the caller turns into a geometry-less field.
 *
 * **Invariant: never an approximate position.** Every rule is transcribed from
 * the XFA Specification 3.3, cited by page; a shape the spec does not settle
 * refuses.
 *
 * `position` is one case of the same walk, so a positioned field and a flowed
 * one cannot be placed by two disagreeing rules. IRS f1040's 159 positioned
 * rects (`test/xfa-real.test.ts`) are the fence for that unification.
 */
import {
  XFA_ANCHORS, anchorShift, measureToPt,
  type XfaBox, type XfaMargin, type XfaRawGeom,
} from './xfageom.js';
import type { LeafText } from './xfarich.js';

export type LayoutKind = 'page' | 'subform' | 'exclGroup' | 'area' | 'field' | 'draw';

export interface XfaMinMax { minW?: string; minH?: string; maxW?: string; maxH?: string }

/** One node of a page's layout tree, as the template states it. */
export interface LayoutNode {
  kind: LayoutKind;
  /** The node's indexed name, or `<kind>` when unnamed. Used in reasons. */
  label: string;
  /** Containers only: `position` (default), `tb`, `lr-tb`, `table`, `row`, or
   *  anything else (refused). */
  layout?: string;
  /** Why the TEMPLATE could not build this node faithfully -- today, a repeating
   *  subform the instantiation rule cannot answer (164g.2). The node and every
   *  field under it are refused with exactly this reason. */
  refusal?: string;
  geom: XfaRawGeom;
  minMax?: XfaMinMax;
  colSpan?: string;
  hAlign?: string;
  presence?: string;
  /** A CONTAINER's own `<margin>`, which insets its content. A field's margin
   *  is its edit-region inset and stays on `XfaField`, not here. */
  margin?: XfaMargin;
  columnWidths?: string;
  /** The field's SOM name; absent on draws and unnamed fields. */
  field?: string;
  /** A field's or draw's text, insets and caption, measured when its size is
   *  not stated (164g.7). Absent on containers. */
  text?: LeafText;
  children: LayoutNode[];
}

export type Placed = { box: XfaBox } | { reason: string };

/** Where a measured leaf's text must fit: a fixed (stated or column-imposed)
 *  width, or a width-growable leaf wrapping at `maxW` when one is stated. */
export type XfaMeasureBox = { width: number } | { maxWidth?: number };
/** A leaf's nominal extent from its text (164g.7). `min*`/`max*` are the
 *  engine's to apply, not the measurer's. */
export type XfaMeasure = (n: LayoutNode, box: XfaMeasureBox) => { w: number; h: number } | { reason: string };

/** The layouts this engine places. An allowlist: anything else refuses. */
const LAID_OUT: ReadonlySet<string> = new Set(['position', 'tb', 'lr-tb', 'table', 'row']);

/** Tolerance for comparing summed measurements: mm-to-pt conversions leave
 *  ulps of residue, and `17.78mm + 20.32mm` must fit a `38.1mm` column. */
const EPS = 1e-6;

interface Size { w: number; h: number }
/** `fromChild`: the node itself is sound and a CHILD could not be placed, so
 *  the children before it still have positions. */
interface Fail { reason: string; cause?: string; fromChild?: boolean }
interface Slot { x: number; y: number; size?: Size }
interface Insets { l: number; r: number; t: number; b: number }
type Slots = Map<LayoutNode, Slot | Fail>;

/** One table cell at its natural size (XFA 3.3 p. 329). `w` is undefined for a
 *  leaf that states none, which only a stated column may then size. */
interface Cell {
  node: LayoutNode;
  /** Positive, or -1 until resolved against the column count. */
  span: number;
  w: number | undefined;
  h: number;
  /** A growable lr-tb cell: it lays out on one line at its natural width. */
  oneLine: boolean;
  /** After a `colSpan="-1"` cell: not displayed. */
  dropped: boolean;
  /** A leaf whose height comes from its text at its final width (164g.7). */
  measure?: true;
}
interface Row { node: LayoutNode; cells: Cell[] }

/** XFA 3.3 p. 327: a measurement or `-1` per column. */
function columnsOf(n: LayoutNode): Array<number | 'auto'> | Fail {
  const toks = (n.columnWidths ?? '').split(/\s+/).filter((t) => t !== '');
  const out: Array<number | 'auto'> = [];
  for (const t of toks) {
    if (t === '-1') { out.push('auto'); continue; }
    const v = measureToPt(t);
    if (v === undefined || v < 0)
      return { reason: `${n.label}: columnWidths entry "${t}" could not be read as a measurement` };
    out.push(v);
  }
  return out;
}

/** XFA 3.3 p. 330: a positive count or -1; default 1; never 0. */
function spanOf(c: LayoutNode): number | Fail {
  if (c.colSpan === undefined) return 1;
  if (c.colSpan === '-1') return -1;
  if (/^\d+$/.test(c.colSpan) && Number(c.colSpan) > 0) return Number(c.colSpan);
  return { reason: `${c.label}: colSpan="${c.colSpan}" is not a positive count or -1` };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && 'reason' in v;
const isLeaf = (n: LayoutNode): boolean => n.kind === 'field' || n.kind === 'draw';

/** XFA 3.3 p. 67-68: `hidden` and `inactive` are absent from layout;
 *  `invisible` takes up space. Inheritance is structural: a concealed
 *  container is never descended. */
function concealed(n: LayoutNode): string | undefined {
  return n.presence === 'hidden' || n.presence === 'inactive'
    ? `presence="${n.presence}" takes no space in the layout` : undefined;
}

/** The reason a flow's later siblings carry: their positions depend on the one
 *  that failed, so they name it rather than guessing past it. */
function after(f: Fail): Fail {
  const cause = f.cause ?? f.reason;
  return { reason: `an earlier item in its flow could not be laid out (${cause})`, cause };
}

/** A stated measurement: a number, `undefined` when the attribute is absent,
 *  or a failure when it is present and unreadable. */
function stated(n: LayoutNode, k: 'x' | 'y' | 'w' | 'h'): number | undefined | Fail {
  const s = n.geom[k];
  if (s === undefined) return undefined;
  const v = measureToPt(s);
  return v === undefined
    ? { reason: `${n.label}: ${k}="${s}" could not be read as a measurement` } : v;
}

function insetsOf(n: LayoutNode): Insets | Fail {
  const m = n.margin ?? {};
  const out: number[] = [];
  for (const k of ['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const) {
    const s = m[k];
    if (s === undefined) { out.push(0); continue; }
    const v = measureToPt(s);
    if (v === undefined)
      return { reason: `${n.label}: margin ${k}="${s}" could not be read as a measurement` };
    out.push(v);
  }
  return { l: out[0], r: out[1], t: out[2], b: out[3] };
}

/** Why this node cannot be laid out at all, whatever its parent. */
function refusalOf(n: LayoutNode): string | undefined {
  if (n.refusal !== undefined) return n.refusal;
  if (n.geom.rotate !== undefined && measureToPt(n.geom.rotate) !== 0)
    return `${n.label}: rotate="${n.geom.rotate}" is not supported`;
  if (isLeaf(n)) return undefined;
  const lay = n.layout ?? 'position';
  if (!LAID_OUT.has(lay)) return `${n.label}: layout="${lay}" is not laid out`;
  return undefined;
}

/** XFA 3.3 p. 282: `row` outside a table is an inappropriate layout strategy. */
const ROW_OUTSIDE = (c: LayoutNode) => `${c.label}: layout="row" outside a table is not laid out`;

/** Why a child cannot take part in a flow. XFA 3.3 p. 282 gives `left` as the
 *  default `hAlign` for left-to-right layouts and shows the others only as
 *  examples, so any other value refuses. */
function flowRefusal(c: LayoutNode): string | undefined {
  if (c.layout === 'row') return ROW_OUTSIDE(c);
  if (c.hAlign !== undefined && c.hAlign !== 'left')
    return `${c.label}: hAlign="${c.hAlign}" in a flowing layout is not laid out`;
  return undefined;
}

class Engine {
  /** Field names seen twice on this page. */
  private readonly dups = new Set<string>();

  /** The contentArea's bottom edge in the page frame, when it states a height. */
  constructor(
    private readonly bottom: number | undefined,
    private readonly measurer: XfaMeasure | undefined,
    private readonly warnings: string[],
  ) {}

  private readonly sizes = new Map<LayoutNode, Size | Fail>();
  /** Swap warnings already recorded, so a memoized axis warns once. */
  private readonly warned = new Set<string>();
  private get hasMeasurer(): boolean { return this.measurer !== undefined; }
  private readonly slots = new Map<LayoutNode, Slots>();
  /** A table's content size, set by `table()` when every row placed. */
  private readonly tables = new Map<LayoutNode, Size>();

  /** A node's nominal extent. */
  extent(n: LayoutNode): Size | Fail {
    let s = this.sizes.get(n);
    if (s === undefined) { s = this.measure(n); this.sizes.set(n, s); }
    return s;
  }

  private measure(n: LayoutNode): Size | Fail {
    const no = refusalOf(n);
    if (no !== undefined) return { reason: no };
    const w = stated(n, 'w');
    const h = stated(n, 'h');
    if (typeof w === 'object') return w;
    if (typeof h === 'object') return h;
    if (isLeaf(n)) {
      if (w !== undefined && h !== undefined) return { w, h };
      return this.measureLeaf(n, w, h);
    }
    // XFA 3.3 p. 276: with both stated, min*/max* are ignored.
    if (w !== undefined && h !== undefined) return { w, h };
    // p. 275: a growable container works inside-out -- a content region from
    // its contents, then its margins applied.
    const m = insetsOf(n);
    if (isFail(m)) return m;
    const c = this.contentExtent(n, m);
    if (isFail(c)) return c;
    const width = this.grow(n, 'minW', 'maxW', w, c.w + m.l + m.r);
    if (isFail(width)) return width;
    const height = this.grow(n, 'minH', 'maxH', h, c.h + m.t + m.b);
    if (isFail(height)) return height;
    return { w: width, h: height };
  }

  /** A leaf with an unstated axis (XFA 3.3 p. 276): its text measured at its
   *  fixed width, or wrapping at `maxW`, then `min*`/`max*` applied on the
   *  grown axis -- in every parent layout. `imposed` is a table column's width,
   *  which replaces a stated `w` (p. 329). */
  measureLeaf(n: LayoutNode, w: number | undefined, h: number | undefined, imposed?: number): Size | Fail {
    if (!this.measurer)
      return {
        reason: `${n.label}: states no ${w === undefined ? 'w' : 'h'}, so its size comes `
          + 'from its content, which needs text measurement (164g.7)',
      };
    const width = imposed ?? w;
    let box: XfaMeasureBox = {};
    if (width !== undefined) box = { width };
    else {
      const max = this.limits(n, 'minW', 'maxW');
      if (isFail(max)) return max;
      if (max.max !== undefined) box = { maxWidth: max.max };
    }
    const r = this.measurer(n, box);
    if ('reason' in r) return { reason: r.reason };
    const W = width ?? this.grow(n, 'minW', 'maxW', undefined, r.w);
    if (isFail(W)) return W;
    const H = this.grow(n, 'minH', 'maxH', h, r.h);
    if (isFail(H)) return H;
    return { w: W, h: H };
  }

  /** One axis's `min*`/`max*` in points. `max*="0"` means absent (p. 277); a
   *  minimum above the maximum is non-conforming and swapped, with a warning
   *  (p. 277). */
  private limits(n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH'): { min?: number; max?: number } | Fail {
    const mm = n.minMax ?? {};
    const read = (k: string, v: string | undefined): number | undefined | Fail => {
      if (v === undefined) return undefined;
      const p = measureToPt(v);
      return p === undefined ? { reason: `${n.label}: ${k}="${v}" could not be read as a measurement` } : p;
    };
    const min = read(minKey, mm[minKey]);
    if (isFail(min)) return min;
    let max = read(maxKey, mm[maxKey]);
    if (isFail(max)) return max;
    if (max === 0) max = undefined;
    if (min !== undefined && max !== undefined && min > max + EPS) {
      const axis = minKey.slice(3);
      const msg = `${n.label}: min${axis} exceeds max${axis}, so the two are swapped (XFA 3.3 p. 277)`;
      if (!this.warned.has(msg)) { this.warned.add(msg); this.warnings.push(msg); }
      return { min: max, max: min };
    }
    return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }

  /** One axis of a growable extent. Content past a stated maximum would be
   *  clipped, which is not modelled. */
  private grow(
    n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH',
    fixed: number | undefined, content: number,
  ): number | Fail {
    if (fixed !== undefined) return fixed;
    const lim = this.limits(n, minKey, maxKey);
    if (isFail(lim)) return lim;
    const v = Math.max(content, lim.min ?? 0);
    if (lim.max !== undefined && v > lim.max + EPS)
      return { reason: `${n.label}: its content exceeds ${maxKey}, and clipping is not laid out` };
    return v;
  }

  /** The content region a growable container's children span, from its
   *  content origin. */
  private contentExtent(n: LayoutNode, m: Insets): Size | Fail {
    const slots = this.arrange(n);
    const t = this.tables.get(n);
    if (t !== undefined) return t;
    let w = 0;
    let h = 0;
    for (const c of n.children) {
      if (concealed(c) !== undefined) continue;
      const s = slots.get(c);
      if (s === undefined) continue;
      if (isFail(s)) return { ...s, fromChild: true };
      const size = s.size ?? this.extent(c);
      if (isFail(size)) return { ...size, fromChild: true };
      const x = s.x - m.l;
      const y = s.y - m.t;
      if (x < -EPS || y < -EPS)
        return {
          reason: `${c.label}: sits at a negative coordinate, so the extent of ${n.label} is not defined`,
          fromChild: true,
        };
      w = Math.max(w, x + size.w);
      h = Math.max(h, y + size.h);
    }
    return { w, h };
  }

  /** Each present child's top-left relative to `n`'s own top-left (margins
   *  included), or why it has none. */
  arrange(n: LayoutNode): Slots {
    const known = this.slots.get(n);
    if (known !== undefined) return known;
    const out: Slots = new Map();
    this.slots.set(n, out);
    const kids = n.children.filter((c) => concealed(c) === undefined);
    const failAll = (reason: string): Slots => {
      for (const c of kids) out.set(c, { reason });
      return out;
    };
    const no = refusalOf(n);
    if (no !== undefined) return failAll(no);
    const m = insetsOf(n);
    if (isFail(m)) return failAll(m.reason);
    switch (n.layout ?? 'position') {
      case 'tb': this.flowTb(n, kids, m, out); break;
      case 'lr-tb': this.flowLrTb(n, kids, m, out); break;
      case 'table': this.table(n, kids, m, out); break;
      // A row reached here was not arranged by a table: `table()` fills a
      // row's slots before anything asks for them.
      case 'row': return failAll(ROW_OUTSIDE(n));
      default: for (const c of kids) out.set(c, this.positionOne(n, c, m));
    }
    return out;
  }

  /** XFA 3.3 p. 608 (`x`/`y`) and Appendix A p. 1510: a child's anchor point
   *  is relative to the parent's content region, and the top-left corner is
   *  found from the anchor by moving back over the child's own extent. */
  private positionOne(n: LayoutNode, c: LayoutNode, m: Insets): Slot | Fail {
    if (c.layout === 'row') return { reason: ROW_OUTSIDE(c) };
    const x = stated(c, 'x');
    const y = stated(c, 'y');
    if (typeof x === 'object') return x;
    if (typeof y === 'object') return y;
    const anchor = c.geom.anchorType;
    if (anchor !== undefined && !(XFA_ANCHORS as readonly string[]).includes(anchor))
      return { reason: `${c.label}: anchorType="${anchor}" is not one of the nine` };
    let dx = 0;
    let dy = 0;
    if (anchor !== undefined && anchor !== 'topLeft') {
      const s = this.extent(c);
      if (isFail(s)) return s;
      const sh = anchorShift(anchor, s.w, s.h);
      if (sh === undefined) return { reason: `${c.label}: anchorType="${anchor}" is not one of the nine` };
      dx = sh.dx;
      dy = sh.dy;
    }
    const slot: Slot = { x: m.l + (x ?? 0) + dx, y: m.t + (y ?? 0) + dy };
    if (n.kind === 'page' && (c.layout ?? 'position') !== 'position') return this.bounded(n, c, slot);
    return slot;
  }

  /** A flowed page subform must fit its contentArea; past it is page breaking
   *  (164g.3). Without a stated height nothing bounds the flow. */
  private bounded(page: LayoutNode, c: LayoutNode, slot: Slot): Slot | Fail {
    const h = stated(page, 'h');
    if (typeof h !== 'number')
      return {
        reason: `${c.label}: uses layout="${c.layout ?? ''}" and its pageArea declares no `
          + 'contentArea height, so the flow cannot be bounded',
      };
    // A container whose content broke part-way still places what came before
    // the break; what failed emits nothing, so the bottom of what placed
    // bounds every box this subform produces.
    const s = this.extent(c);
    if (isFail(s) && !s.fromChild) return s;
    const bottom = isFail(s) ? this.placedBottom(c) : s.h;
    if (slot.y + bottom > h + EPS)
      return { reason: `${c.label}: overflows its contentArea, which needs page breaking (164g.3)` };
    return slot;
  }

  /** The lowest edge of anything under `n` that placed, relative to its top. */
  private placedBottom(n: LayoutNode): number {
    if (isLeaf(n)) return 0;
    let bottom = 0;
    for (const [c, sl] of this.arrange(n)) {
      if (isFail(sl)) continue;
      const size = sl.size ?? this.extent(c);
      const h = !isFail(size) ? size.h : isLeaf(c) ? 0 : this.placedBottom(c);
      bottom = Math.max(bottom, sl.y + h);
    }
    return bottom;
  }

  /** The height a fixed-height flowed container offers its children. */
  private available(n: LayoutNode, m: Insets): number | undefined {
    const h = stated(n, 'h');
    return typeof h === 'number' ? h - m.t - m.b : undefined;
  }

  private flowSize(c: LayoutNode): Size | Fail {
    const no = flowRefusal(c);
    return no !== undefined ? { reason: no } : this.extent(c);
  }

  private splitFail(n: LayoutNode, c: LayoutNode): Fail {
    return { reason: `${c.label}: does not fit the remaining height of ${n.label}, which needs splitting (164g.3)` };
  }

  /** XFA 3.3 p. 280: each child "immediately below the nominal extent of the
   *  previous contained object and aligned with the left edge". */
  private flowTb(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const avail = this.available(n, m);
    let y = 0;
    let broken: Fail | undefined;
    for (const c of kids) {
      if (broken) { out.set(c, after(broken)); continue; }
      const size = this.flowSize(c);
      if (isFail(size)) { out.set(c, size); broken = size; continue; }
      if (avail !== undefined && y + size.h > avail + EPS) {
        const f = this.splitFail(n, c);
        out.set(c, f);
        broken = f;
        continue;
      }
      out.set(c, { x: m.l, y: m.t + y });
      y += size.h;
    }
  }

  /** XFA 3.3 p. 281: each child "immediately to the right of the nominal extent
   *  of the previous object, or if this fails immediately below it aligned with
   *  the left edge". A child on the same line keeps the line's top. With no
   *  stated `w` the container is growable in width and never wraps. */
  private flowLrTb(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const sw = stated(n, 'w');
    const width = typeof sw === 'number' ? sw - m.l - m.r : Infinity;
    const avail = this.available(n, m);
    let x = 0;
    let y = 0;
    let lineH = 0;
    let line: number[] = [];
    let broken: Fail | undefined;
    for (const c of kids) {
      if (broken) { out.set(c, after(broken)); continue; }
      const size = this.flowSize(c);
      if (isFail(size)) { out.set(c, size); broken = size; continue; }
      if (x > 0 && x + size.w > width + EPS) {
        // "immediately below it" does not say below WHAT once the line's
        // heights differ, so that wrap refuses rather than picks.
        if (line.some((v) => Math.abs(v - line[0]) > EPS)) {
          const f: Fail = {
            reason: `${c.label}: wraps after a line of mixed heights, where the specification `
              + 'does not say how far below it goes',
          };
          out.set(c, f);
          broken = f;
          continue;
        }
        y += lineH;
        x = 0;
        lineH = 0;
        line = [];
      }
      if (avail !== undefined && y + size.h > avail + EPS) {
        const f = this.splitFail(n, c);
        out.set(c, f);
        broken = f;
        continue;
      }
      out.set(c, { x: m.l + x, y: m.t + y });
      x += size.w;
      lineH = Math.max(lineH, size.h);
      line.push(size.h);
    }
  }

  /** A row's cells at their natural sizes, or why the row cannot be laid out. */
  private rowCells(r: LayoutNode): Row | Fail {
    if (r.layout !== 'row')
      return { reason: `${r.label}: a table child that is not a row is not laid out` };
    const no = refusalOf(r) ?? flowRefusal({ ...r, layout: undefined });
    if (no !== undefined) return { reason: no };
    const ri = insetsOf(r);
    if (isFail(ri)) return ri;
    if (r.geom.w !== undefined || r.geom.h !== undefined
      || ri.l !== 0 || ri.r !== 0 || ri.t !== 0 || ri.b !== 0)
      return { reason: `${r.label}: a row that states its own size or margin is not laid out` };
    const cells: Cell[] = [];
    let dropping = false;
    for (const c of r.children) {
      if (concealed(c) !== undefined) continue;
      if (dropping) {
        cells.push({ node: c, span: 0, w: undefined, h: 0, oneLine: false, dropped: true });
        continue;
      }
      const span = spanOf(c);
      if (typeof span === 'object') return span;
      const cr = flowRefusal(c);
      if (cr !== undefined) return { reason: cr };
      let w: number | undefined;
      let h: number;
      let oneLine = false;
      if (isLeaf(c)) {
        const lr = refusalOf(c);
        if (lr !== undefined) return { reason: lr };
        const sw = stated(c, 'w');
        const sh = stated(c, 'h');
        if (typeof sw === 'object') return sw;
        if (typeof sh === 'object') return sh;
        if (sh === undefined && !this.hasMeasurer)
          return {
            reason: `${c.label}: states no h, so its size comes from its content, which needs `
              + 'text measurement (164g.7)',
          };
        // A width-growable leaf's natural width may size an auto column; if it
        // cannot be measured, only a stated column can size it.
        if (sw === undefined && this.hasMeasurer) {
          const e = this.extent(c);
          w = isFail(e) ? undefined : e.w;
        } else w = sw;
        h = sh ?? 0;
        if (sh === undefined) cells.push({ node: c, span, w, h, oneLine: false, dropped: false, measure: true });
        else cells.push({ node: c, span, w, h, oneLine: false, dropped: false });
        if (span === -1) dropping = true;
        continue;
      } else {
        const e = this.extent(c);
        if (isFail(e)) return e;
        w = e.w;
        h = e.h;
        oneLine = c.layout === 'lr-tb' && c.geom.w === undefined;
      }
      cells.push({ node: c, span, w, h, oneLine, dropped: false });
      if (span === -1) dropping = true;
    }
    return { node: r, cells };
  }

  /** XFA 3.3 p. 327-331: cells at natural size, rows expanded to their tallest
   *  cell, rows stacked top to bottom, cells expanded to their columns. */
  private table(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const cols = columnsOf(n);
    if (isFail(cols)) { for (const c of kids) out.set(c, cols); return; }

    const rows: Row[] = [];
    let broken: Fail | undefined;
    for (const r of kids) {
      if (broken) { out.set(r, after(broken)); continue; }
      const row = this.rowCells(r);
      if (isFail(row)) { out.set(r, row); broken = row; continue; }
      rows.push(row);
    }

    // The column count is the longest row or the declared list; a -1 span then
    // takes whatever columns remain after it.
    let ncols = cols.length;
    for (const row of rows) {
      let k = 0;
      for (const c of row.cells) if (!c.dropped) k += c.span === -1 ? 1 : c.span;
      ncols = Math.max(ncols, k);
    }
    for (const row of rows) {
      let k = 0;
      for (const c of row.cells) {
        if (c.dropped) continue;
        if (c.span === -1) c.span = Math.max(1, ncols - k);
        k += c.span;
      }
    }

    // A -1 column is its widest cell -- from cells spanning exactly that one
    // column, each of which must state a width. Columns are sized from EVERY
    // row, so a row that failed leaves an auto column unknowable.
    const widths: number[] = [];
    for (let j = 0; j < ncols; j++) {
      const tok = cols[j] ?? 'auto';
      if (tok !== 'auto') { widths.push(tok); continue; }
      let widest: number | undefined;
      let unsized = false;
      for (const row of rows) {
        let k = 0;
        for (const c of row.cells) {
          if (c.dropped) continue;
          if (k === j && c.span === 1) {
            if (c.w === undefined) unsized = true;
            else widest = Math.max(widest ?? 0, c.w);
          }
          k += c.span;
        }
      }
      if (broken || unsized || widest === undefined) {
        const f: Fail = {
          reason: broken
            ? `${n.label}: column ${String(j + 1)} is sized by its widest cell, and a row could `
              + `not be laid out (${broken.cause ?? broken.reason})`
            : `${n.label}: column ${String(j + 1)} has width -1 and no single-column cell with a `
              + 'stated width to size it',
        };
        for (const row of rows) out.set(row.node, f);
        return;
      }
      widths.push(widest);
    }

    const tableW = sum(widths);
    const avail = this.available(n, m);
    let y = 0;
    let stop: Fail | undefined;
    for (const row of rows) {
      if (stop) { out.set(row.node, after(stop)); continue; }
      // Final widths first (p. 329), then every cell's height at its width.
      let bad: Fail | undefined;
      const sized: Array<{ c: Cell; x: number; w: number; h: number }> = [];
      let k = 0;
      for (const c of row.cells) {
        if (c.dropped) continue;
        const x = sum(widths.slice(0, k));
        const w = sum(widths.slice(k, k + c.span));
        k += c.span;
        let h = c.h;
        // A leaf with no stated h -- including one whose stated w the column
        // replaces -- is measured at its final width. A leaf with both stated
        // simply takes the column's width (p. 329).
        if (c.measure) {
          const s = this.measureLeaf(c.node, undefined, undefined, w);
          if (isFail(s)) { bad ??= s; continue; }
          h = s.h;
        } else if (!isLeaf(c.node) && c.w !== undefined && c.w > w + EPS) {
          // p. 329: the column is the cell's box and the content may draw past
          // it. Only a width-growable lr-tb's LAYOUT depends on the width it is
          // given -- it would wrap to the column -- so only it refuses; a
          // positioned, tb or table container keeps its children's own sizes.
          if (c.oneLine)
            bad ??= { reason: `${c.node.label}: lays out on one line wider than its column, and wrapping it `
              + 'to the column is not laid out' };
        }
        sized.push({ c, x, w, h });
      }
      if (bad) { out.set(row.node, bad); stop = bad; continue; }
      const rowH = sized.reduce((a, s) => Math.max(a, s.h), 0);
      const cellSlots: Slots = new Map();
      for (const c of row.cells)
        if (c.dropped)
          cellSlots.set(c.node, { reason: `${c.node.label}: follows a colSpan="-1" cell, so it is not displayed` });
      for (const s of sized) cellSlots.set(s.c.node, { x: s.x, y: 0, size: { w: s.w, h: rowH } });
      if (avail !== undefined && y + rowH > avail + EPS) {
        const f = this.splitFail(n, row.node);
        out.set(row.node, f);
        stop = f;
        continue;
      }
      this.slots.set(row.node, cellSlots);
      out.set(row.node, { x: m.l, y: m.t + y, size: { w: tableW, h: rowH } });
      y += rowH;
    }
    if (!broken && !stop) this.tables.set(n, { w: tableW, h: y });
  }

  /** Walk top-down, recording every field's box or reason. `forced` is a table
   *  cell's expanded size, which replaces a leaf's own. `flow` names the
   *  nearest flowed ancestor's layout: a box under one is checked against the
   *  contentArea's bottom wherever the flow sits, since past it is page
   *  breaking (164g.3). */
  emit(
    n: LayoutNode, x: number, y: number, forced: Size | undefined,
    flow: string | undefined, out: Map<string, Placed>,
  ): void {
    const hid = concealed(n);
    if (hid !== undefined) { this.assignAll(n, hid, out); return; }
    if (isLeaf(n)) {
      if (n.field === undefined) return;
      const size = forced ?? this.extent(n);
      if (isFail(size)) { this.put(out, n.field, { reason: size.reason }); return; }
      if (flow !== undefined) {
        if (this.bottom === undefined) {
          this.put(out, n.field, {
            reason: `${n.label}: sits under layout="${flow}" and its pageArea declares no `
              + 'contentArea height, so the flow cannot be bounded',
          });
          return;
        }
        if (y + size.h > this.bottom + EPS) {
          this.put(out, n.field, {
            reason: `${n.label}: overflows its contentArea, which needs page breaking (164g.3)`,
          });
          return;
        }
      }
      this.put(out, n.field, { box: { x, y, w: size.w, h: size.h } });
      return;
    }
    // A container whose OWN extent failed -- content past maxH, an unreadable
    // min/max -- would place children it clips, so its subtree refuses. A
    // failure that came from a child leaves the earlier children placed.
    if (n.kind !== 'page') {
      const e = this.extent(n);
      if (isFail(e) && !e.fromChild) { this.assignAll(n, e.reason, out); return; }
    }
    const lay = n.layout ?? 'position';
    const inner = flow ?? (n.kind !== 'page' && lay !== 'position' ? lay : undefined);
    const slots = this.arrange(n);
    for (const c of n.children) {
      const hidden = concealed(c);
      if (hidden !== undefined) { this.assignAll(c, hidden, out); continue; }
      const s = slots.get(c);
      if (s === undefined) continue;
      if (isFail(s)) this.assignAll(c, s.reason, out);
      else this.emit(c, x + s.x, y + s.y, s.size, inner, out);
    }
  }

  /** Record one field's result. Two fields sharing a SOM name cannot both be
   *  addressed by it, so both refuse rather than one silently winning. */
  private put(out: Map<string, Placed>, name: string, v: Placed): void {
    if (this.dups.has(name)) return;
    if (out.has(name)) {
      this.dups.add(name);
      out.set(name, { reason: `two fields share the SOM name ${name}, so neither can be placed by it` });
      return;
    }
    out.set(name, v);
  }

  /** Give every field under `n` the same reason. */
  assignAll(n: LayoutNode, reason: string, out: Map<string, Placed>): void {
    if (n.field !== undefined) this.put(out, n.field, { reason });
    for (const c of n.children) this.assignAll(c, reason, out);
  }
}

/**
 * Lay out one page. `root` is the page's `contentArea`, positioned at its own
 * stated `x`/`y`. The result maps every field SOM name under it to a box in
 * the page's XFA frame, or the reason it has none.
 */
export function layoutPage(root: LayoutNode, measure?: XfaMeasure, warnings: string[] = []): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const x = stated(root, 'x');
  const y = stated(root, 'y');
  const h = stated(root, 'h');
  const bottom = typeof h === 'number' && typeof y !== 'object' ? (y ?? 0) + h : undefined;
  const engine = new Engine(bottom, measure, warnings);
  if (typeof x === 'object') { engine.assignAll(root, x.reason, out); return out; }
  if (typeof y === 'object') { engine.assignAll(root, y.reason, out); return out; }
  engine.emit(root, x ?? 0, y ?? 0, undefined, undefined, out);
  return out;
}
