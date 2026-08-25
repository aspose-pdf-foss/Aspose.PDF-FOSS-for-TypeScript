import { visitContent, extractFragments, fragmentsFromGlyphs, apply, type PathEvent, type TextFragment, type GlyphEvent } from './text.js';
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Table } from './tablemodel.js';
import type {
  CellBorders, Rect, TableExtractOptions, TableCell, TableRow,
} from './tablemodel.js';
import { extractTaggedTables } from './tablestruct.js';
import { dominantAngle, rot, ANGLE_EPS, type Seg } from './tableorient.js';
import { collectPageInk, edgeAt, fillUnder, type PageInk } from './tableink.js';
import { buildCells, cellText, centroid, contains, rowBbox } from './tablegrid.js';
import { segmentBlocks } from './tablestream.js';

export { Table } from './tablemodel.js';
export { buildCells } from './tablegrid.js';
export type { Rect, TableExtractOptions, TableCell, TableRow } from './tablemodel.js';

const AXIS_TOL = 0.6;          // segment is axis-aligned if the off-axis delta <= this
// Exported so tableink.ts's callers pass the DETECTOR's own tolerances rather
// than keeping a second copy. Two copies drift, and the drift shows up as a
// border on some edges and not others.
export const MIN_RULE_LEN = 3;        // ignore shorter segments
export const MAX_RULE_THICK = 3;      // filled rect this thin (min side) is a rule; collapse to centerline
export const SNAP = 2;                // cluster cut positions within this distance

interface Rule { pos: number; lo: number; hi: number; }

function inRegion(r: Rect | undefined, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!r) return true;
  return x0 >= r[0] - SNAP && x1 <= r[2] + SNAP && y0 >= r[1] - SNAP && y1 <= r[3] + SNAP;
}

/** A single painted path's segments, reduced to horizontal/vertical rules. */
function rulesFromPath(e: PathEvent, horiz: Rule[], vert: Rule[], region?: Rect): void {
  // A thin filled rectangle → collapse its bbox to a centerline rule.
  if (e.fill && !e.stroke) {
    const xs = e.segments.flatMap((s) => [s[0], s[2]]);
    const ys = e.segments.flatMap((s) => [s[1], s[3]]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) <= MAX_RULE_THICK && Math.max(w, h) >= MIN_RULE_LEN && inRegion(region, x0, y0, x1, y1)) {
      if (w >= h) horiz.push({ pos: (y0 + y1) / 2, lo: x0, hi: x1 });
      else vert.push({ pos: (x0 + x1) / 2, lo: y0, hi: y1 });
    }
    return;
  }
  // Stroked segments → keep axis-aligned ones.
  for (const [x0, y0, x1, y1] of e.segments) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= MIN_RULE_LEN) {
      const y = (y0 + y1) / 2, lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      if (inRegion(region, lo, y, hi, y)) horiz.push({ pos: y, lo, hi });
    } else if (dx <= AXIS_TOL && dy >= MIN_RULE_LEN) {
      const x = (x0 + x1) / 2, lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      if (inRegion(region, x, lo, x, hi)) vert.push({ pos: x, lo, hi });
    }
  }
}

/** Merge rules whose `pos` is within SNAP AND whose lo..hi spans overlap or
 *  nearly touch, unioning their spans. Collinear rules at the same coordinate
 *  but with a disjoint span (e.g. the shared column x of two vertically-stacked
 *  tables) stay separate so page-level tables can later be partitioned. */
function clusterRules(rules: Rule[]): Rule[] {
  const sorted = [...rules].sort((a, b) => (a.pos - b.pos) || (a.lo - b.lo));
  const out: Rule[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.pos - last.pos <= SNAP && r.lo <= last.hi + SNAP) {
      last.pos = (last.pos + r.pos) / 2;
      last.lo = Math.min(last.lo, r.lo);
      last.hi = Math.max(last.hi, r.hi);
    } else out.push({ ...r });
  }
  return out;
}

export function collectRules(doc: Document, page: Page, region?: Rect): { horiz: Rule[]; vert: Rule[] } {
  const horiz: Rule[] = [], vert: Rule[] = [];
  visitContent(doc, page, { path: (e) => rulesFromPath(e, horiz, vert, region) });
  return { horiz: clusterRules(horiz), vert: clusterRules(vert) };
}

const uniqSorted = (xs: number[], asc: boolean): number[] => {
  const s = [...xs].sort((a, b) => (asc ? a - b : b - a));
  const out: number[] = [];
  for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) > SNAP) out.push(v);
  return out;
};

/** True if some horizontal rule at ~y covers [x0,x1]. */
const coveredH = (rules: Rule[], y: number, x0: number, x1: number): boolean =>
  rules.some((r) => Math.abs(r.pos - y) <= SNAP && r.lo <= x0 + SNAP && r.hi >= x1 - SNAP);
const coveredV = (rules: Rule[], x: number, y0: number, y1: number): boolean =>
  rules.some((r) => Math.abs(r.pos - x) <= SNAP && r.lo <= y0 + SNAP && r.hi >= y1 - SNAP);

/** Assemble fragments (already cell-local) into text: cluster into baselines,
 *  left-to-right, join lines with '\n'. */

/** True if `inner` sits within `outer` (SNAP-tolerant on every edge). */
const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner[0] >= outer[0] - SNAP && inner[1] >= outer[1] - SNAP
  && inner[2] <= outer[2] + SNAP && inner[3] <= outer[3] + SNAP;


/** Build one Table from clustered rules + fragments within its region. */
function assembleTable(horiz: Rule[], vert: Rule[], frags: TextFragment[]): Table | undefined {
  const xcuts = uniqSorted(vert.map((r) => r.pos), true);
  const ycuts = uniqSorted(horiz.map((r) => r.pos), false);   // descending
  const C = xcuts.length - 1, R = ycuts.length - 1;
  if (R < 1 || C < 1) return undefined;

  // Interior separator presence.
  const vSep: boolean[][] = [];
  for (let r = 0; r < R; r++) {
    const yTop = ycuts[r], yBot = ycuts[r + 1], row: boolean[] = [];
    for (let k = 0; k < C - 1; k++) row.push(coveredV(vert, xcuts[k + 1], yBot, yTop));
    vSep.push(row);
  }
  const hSep: boolean[][] = [];
  for (let c = 0; c < C; c++) {
    const x0 = xcuts[c], x1 = xcuts[c + 1], colArr: boolean[] = [];
    for (let k = 0; k < R - 1; k++) colArr.push(coveredH(horiz, ycuts[k + 1], x0, x1));
    hSep.push(colArr);
  }

  const raw = buildCells(xcuts, ycuts, vSep, hSep);
  const cells: TableCell[] = raw.map((c) => {
    const mine = frags.filter((f) => { const [cx, cy] = centroid(f.quad); return contains(c.quad, cx, cy); });
    return { ...c, text: cellText(mine) };
  });
  // Group cells into rows by their `row` index.
  const rows: TableRow[] = [];
  for (let r = 0; r < R; r++) {
    const rc = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    if (rc.length) rows.push({ cells: rc, quad: rowBbox(rc) });
  }
  const quad: Rect = [xcuts[0], ycuts[R], xcuts[C], ycuts[0]];
  return new Table(quad, R, C, rows);
}


const SPAN_FRAC = 0.9;   // a rule spanning >= this fraction of the table extent is structural

/** Union of all rule extents → a page-space bbox. */
function ruleBbox(horiz: Rule[], vert: Rule[]): Rect {
  const xs: number[] = [], ys: number[] = [];
  for (const h of horiz) { xs.push(h.lo, h.hi); ys.push(h.pos); }
  for (const v of vert) { xs.push(v.pos); ys.push(v.lo, v.hi); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

interface NestedRegion { horiz: Rule[]; vert: Rule[]; bbox: Rect; }

/** Build a ruled table for `bbox`, detecting tables nested inside cells
 *  (arbitrary depth) by classifying rules as structural (span >= SPAN_FRAC of
 *  the table extent) or confined, then qualifying each container cell's confined
 *  rules as a nested table. Regression-safe: with no nested table detected this
 *  is identical to assembleTable(horiz, vert, frags). */
function buildRuledRegion(horiz: Rule[], vert: Rule[], frags: TextFragment[], bbox: Rect): Table | undefined {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  const structH = new Set(horiz.filter((r) => r.hi - r.lo >= SPAN_FRAC * w));
  const structV = new Set(vert.filter((r) => r.hi - r.lo >= SPAN_FRAC * h));
  const confH = horiz.filter((r) => !structH.has(r));
  const confV = vert.filter((r) => !structV.has(r));

  const nested: NestedRegion[] = [];
  const consumed = new Set<Rule>();

  // Coarse container grid from structural rules only (used to locate/bound
  // nested tables; never returned). Skip when there is nothing confined.
  const coarse = (confH.length || confV.length)
    ? assembleTable(horiz.filter((r) => structH.has(r)), vert.filter((r) => structV.has(r)), [])
    : undefined;
  if (coarse) {
    for (const row of coarse.rows) for (const cell of row.cells) {
      const [x0, y0, x1, y1] = cell.quad;
      const inH = confH.filter((r) => r.pos >= y0 - SNAP && r.pos <= y1 + SNAP && r.lo >= x0 - SNAP && r.hi <= x1 + SNAP);
      const inV = confV.filter((r) => r.pos >= x0 - SNAP && r.pos <= x1 + SNAP && r.lo >= y0 - SNAP && r.hi <= y1 + SNAP);
      if (!inH.length && !inV.length) continue;
      const fragsC = frags.filter((f) => contains(cell.quad, ...centroid(f.quad)));
      // Tier 1: confined lines alone (inset nested table).
      let cand = assembleTable(inH, inV, fragsC);
      let usedH = inH, usedV = inV;
      // Tier 2: bound by the container-cell edges (nested table sharing borders).
      if (!cand || cand.rowCount < 2 || cand.colCount < 2) {
        usedH = [...inH, { pos: y1, lo: x0, hi: x1 }, { pos: y0, lo: x0, hi: x1 }];
        usedV = [...inV, { pos: x0, lo: y0, hi: y1 }, { pos: x1, lo: y0, hi: y1 }];
        cand = assembleTable(usedH, usedV, fragsC);
      }
      if (!cand || cand.rowCount < 2 || cand.colCount < 2) continue;
      nested.push({ horiz: usedH, vert: usedV, bbox: cand.quad });
      for (const r of inH) consumed.add(r);
      for (const r of inV) consumed.add(r);
    }
  }

  // Returned outer table: all rules minus the confined rules consumed by a
  // nested table; fragments inside a nested bbox are removed from the outer.
  const outerFrags = nested.length
    ? frags.filter((f) => { const c = centroid(f.quad); return !nested.some((n) => contains(n.bbox, ...c)); })
    : frags;
  const outer = assembleTable(horiz.filter((r) => !consumed.has(r)), vert.filter((r) => !consumed.has(r)), outerFrags);
  if (!outer) return undefined;

  // Attach each nested table to the outer cell containing its bbox, recursing
  // for deeper nesting, and strip the nested content from the parent cell text.
  for (const n of nested) {
    const [cx, cy] = centroid(n.bbox);
    let target: TableCell | undefined;
    for (const row of outer.rows) for (const cell of row.cells) if (contains(cell.quad, cx, cy)) target = cell;
    if (!target) continue;
    const sub = buildRuledRegion(n.horiz, n.vert, frags.filter((f) => contains(n.bbox, ...centroid(f.quad))), n.bbox);
    if (!sub) continue;
    (target.tables ??= []).push(sub);
    const tq = target.quad;
    target.text = cellText(frags.filter((f) => {
      const c = centroid(f.quad);
      return contains(tq, ...c) && !nested.some((m) => contains(m.bbox, ...c));
    }));
  }
  return outer;
}

/** True if a horizontal and a vertical rule physically cross (within SNAP). */
function crosses(h: Rule, v: Rule): boolean {
  return v.pos >= h.lo - SNAP && v.pos <= h.hi + SNAP
    && h.pos >= v.lo - SNAP && h.pos <= v.hi + SNAP;
}

/** Partition page rules into connected stroke components: rules are joined when
 *  a horizontal and a vertical rule cross, and connectivity propagates. Each
 *  component is a candidate for its own top-level table, so two or more separate
 *  grids on a page are returned distinctly rather than merged into one grid. */
function partitionRules(horiz: Rule[], vert: Rule[]): { horiz: Rule[]; vert: Rule[] }[] {
  const H = horiz.length, N = H + vert.length;
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < H; i++)
    for (let j = 0; j < vert.length; j++)
      if (crosses(horiz[i], vert[j])) union(i, H + j);
  const groups = new Map<number, { horiz: Rule[]; vert: Rule[] }>();
  const groupOf = (root: number): { horiz: Rule[]; vert: Rule[] } => {
    let g = groups.get(root);
    if (!g) { g = { horiz: [], vert: [] }; groups.set(root, g); }
    return g;
  };
  for (let i = 0; i < H; i++) groupOf(find(i)).horiz.push(horiz[i]);
  for (let j = 0; j < vert.length; j++) groupOf(find(H + j)).vert.push(vert[j]);
  return [...groups.values()];
}

/** Page-space centerline segments of a painted path: stroked segments as-is;
 *  a thin filled rectangle collapsed to its centerline by its page-space AABB.
 *  (A rotated *filled* rule's AABB is not thin, so it is dropped — documented
 *  gap; rotated *stroked* rules are preserved.) */
function pathCenterlines(e: PathEvent): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (e.fill && !e.stroke) {
    const xs = e.segments.flatMap((s) => [s[0], s[2]]);
    const ys = e.segments.flatMap((s) => [s[1], s[3]]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) <= MAX_RULE_THICK && Math.max(w, h) >= MIN_RULE_LEN) {
      if (w >= h) out.push([x0, (y0 + y1) / 2, x1, (y0 + y1) / 2]);
      else out.push([(x0 + x1) / 2, y0, (x0 + x1) / 2, y1]);
    }
    return out;
  }
  for (const s of e.segments) out.push([s[0], s[1], s[2], s[3]]);
  return out;
}

/** One content walk collecting page-space centerline segments and text glyphs. */
function collectOriented(doc: Document, page: Page): { segs: Seg[]; glyphs: GlyphEvent[] } {
  const segs: Seg[] = [];
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, {
    path: (e) => { for (const c of pathCenterlines(e)) segs.push({ x0: c[0], y0: c[1], x1: c[2], y1: c[3] }); },
    glyph: (e) => { if (e.text) glyphs.push(e); },
  });
  return { segs, glyphs };
}

/** Classify oriented centerline segments into clustered axis-aligned rules
 *  (identical rule math to `rulesFromPath`'s stroke branch). */
function classifyRules(segs: [number, number, number, number][]): { horiz: Rule[]; vert: Rule[] } {
  const horiz: Rule[] = [], vert: Rule[] = [];
  for (const [x0, y0, x1, y1] of segs) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= MIN_RULE_LEN) {
      horiz.push({ pos: (y0 + y1) / 2, lo: Math.min(x0, x1), hi: Math.max(x0, x1) });
    } else if (dx <= AXIS_TOL && dy >= MIN_RULE_LEN) {
      vert.push({ pos: (x0 + x1) / 2, lo: Math.min(y0, y1), hi: Math.max(y0, y1) });
    }
  }
  return { horiz: clusterRules(horiz), vert: clusterRules(vert) };
}

/** The ruled + whitespace build core, shared by the axis and rotated branches.
 *  Operates in whatever frame `horiz`/`vert`/`frags` are expressed in. */
function buildTables(horiz: Rule[], vert: Rule[], frags: TextFragment[]): Table[] {
  const out: Table[] = [];
  const comps = partitionRules(horiz, vert).map((c) => ({ ...c, bbox: ruleBbox(c.horiz, c.vert) }));
  const rectArea = (b: Rect): number => (b[2] - b[0]) * (b[3] - b[1]);
  for (const top of comps) {
    if (comps.some((o) => o !== top && rectArea(o.bbox) > rectArea(top.bbox) && rectContains(o.bbox, top.bbox))) continue;
    const cHoriz: Rule[] = [], cVert: Rule[] = [];
    for (const c of comps) if (c === top || rectContains(top.bbox, c.bbox)) { cHoriz.push(...c.horiz); cVert.push(...c.vert); }
    if (uniqSorted(cHoriz.map((r) => r.pos), false).length < 2
      || uniqSorted(cVert.map((r) => r.pos), true).length < 2) continue;
    const bbox = ruleBbox(cHoriz, cVert);
    const compFrags = frags.filter((f) => contains(bbox, ...centroid(f.quad)));
    const t = buildRuledRegion(cHoriz, cVert, compFrags, bbox);
    // A 1x1 grid has no interior rule at all — it is a rectangle outline, which
    // is what a card, a callout or a page frame draws. Every other shape has at
    // least one interior separator, and that is the positive evidence of
    // tabular intent this detector runs on. Reporting boxes as tables put
    // empty <table>s in the HTML export and bogus Table > TR > TD subtrees in
    // AutoTag's structure tree, where a screen reader announces page furniture
    // as a one-cell table. The nested path already required 2x2 (buildRuledRegion).
    if (t && t.rows.length && (t.rowCount > 1 || t.colCount > 1)) out.push(t);
  }
  // Whitespace tables from fragments not inside a ruled table.
  const ruledBoxes = out.map((t) => t.quad);
  const wsFrags = frags.filter((f) => !ruledBoxes.some((b) => contains(b, ...centroid(f.quad))));
  out.push(...segmentBlocks(wsFrags));
  // Reading order: top→bottom, then left→right.
  out.sort((a, b) => (b.quad[3] - a.quad[3]) || (a.quad[0] - b.quad[0]));
  return out;
}

/** Attach recovered borders and shading to every cell of `tables`, recursing
 *  into nested tables.
 *
 *  **Invariant:** this runs AFTER detection and changes nothing the detector
 *  decided. That is what makes the feature incapable of regressing table
 *  detection — the most heavily tested geometry in this file.
 *
 *  **Invariant:** `c.borders` is assigned even when the object is EMPTY.
 *  Present-and-empty means "recovered, and this cell has no drawn edge";
 *  absent means "not recovered". Assigning only when an edge was found
 *  collapses the two, and every consumer then falls back to a frame for a cell
 *  that provably has none. */
function decorateInk(tables: Table[], ink: PageInk): void {
  for (const t of tables) {
    for (const row of t.rows) {
      for (const c of row.cells) {
        const [x0, y0, x1, y1] = c.quad;      // y0 is the BOTTOM (see buildCells)
        const b: CellBorders = {};
        const top = edgeAt(ink, 'h', y1, x0, x1, SNAP);
        const bottom = edgeAt(ink, 'h', y0, x0, x1, SNAP);
        const left = edgeAt(ink, 'v', x0, y0, y1, SNAP);
        const right = edgeAt(ink, 'v', x1, y0, y1, SNAP);
        if (top) b.top = { width: top.width, color: top.color };
        if (bottom) b.bottom = { width: bottom.width, color: bottom.color };
        if (left) b.left = { width: left.width, color: left.color };
        if (right) b.right = { width: right.width, color: right.color };
        c.borders = b;
        const fill = fillUnder(ink, c.quad, SNAP);
        if (fill) c.shading = fill.color;
        if (c.tables?.length) decorateInk(c.tables, ink);
      }
    }
  }
}

export function extractTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  if (options.structure !== 'off') {
    const tagged = extractTaggedTables(doc, page, options);
    if (tagged.length) return tagged;
  }
  const { segs, glyphs } = collectOriented(doc, page);
  const theta = dominantAngle(segs, glyphs.map((g) => g.angle));

  // Axis-aligned: run the existing code path unchanged (byte-identical output).
  if (Math.abs(theta) < ANGLE_EPS) {
    const { horiz, vert } = collectRules(doc, page, options.region);
    const frags = extractFragments(doc, page).filter((f) =>
      !options.region || contains(options.region, ...centroid(f.quad)));
    const tables = buildTables(horiz, vert, frags);
    // Axis-aligned only. A rotated table's cell quads are in its own upright
    // frame while ink is in page space; mapping between them is a second
    // geometry with its own failure modes, and `borders` being absent is
    // already how the model says "not recovered".
    //
    // **Invariant:** collectPageInk is called ONCE here, not inside
    // decorateInk. Moving it into the cell loop walks the page's content per
    // cell — the shape that turned an N-figure page into N content walks in
    // no93.1, and a table has cells x 4 edges to resolve.
    decorateInk(tables, collectPageInk(page.GetPaths(), MIN_RULE_LEN, MAX_RULE_THICK));
    return tables;
  }

  // Rotated: filter by the page-space region, rotate into the upright frame,
  // classify rules, rebuild fragments, run the pipeline, tag with theta.
  const inReg = (x: number, y: number): boolean =>
    !options.region || contains(options.region, x, y);
  const R = rot(-theta);
  const rSeg = segs
    .filter((s) => inReg((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2))
    .map((s) => {
      const [x0, y0] = apply(R, s.x0, s.y0);
      const [x1, y1] = apply(R, s.x1, s.y1);
      return [x0, y0, x1, y1] as [number, number, number, number];
    });
  const { horiz, vert } = classifyRules(rSeg);
  const rGlyphs = glyphs
    .filter((g) => inReg((g.quad[0] + g.quad[2]) / 2, (g.quad[1] + g.quad[3]) / 2))
    .map((g) => {
      const [ox, oy] = apply(R, g.quad[0], g.quad[1]);
      const w = g.advance * g.fontSize;   // upright baseline width (approx)
      return { ...g, quad: [ox, oy, ox + w, oy + g.fontSize] as Rect, angle: 0 };
    });
  const frags = fragmentsFromGlyphs(rGlyphs);
  const tables = buildTables(horiz, vert, frags);
  for (const t of tables) t.angle = theta;
  return tables;
}

/** Build cells (with spans) from a maximal grid and interior-separator presence.
 *  xcuts ascending; ycuts descending (row 0 is the top band). */
