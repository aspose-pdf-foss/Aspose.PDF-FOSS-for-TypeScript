// src/xfachrome.ts
/**
 * An XFA page's chrome as paint operations (164g.4): a placed node's border,
 * fill, draw geometry and text, in the XFA page frame (points, origin
 * top-left, y DOWN). `xfapaint.ts` flips it into PDF space.
 *
 * **Invariant: pure** -- placed nodes in, operations out. No `Document`; never
 * throws. A construct not painted is REPORTED, never silently dropped.
 *
 * **Invariant: paint order is p. 38's** -- per node, fill, then edges and
 * corners, then draw geometry, then text, with nodes in document order (a
 * container before its children), and the widget on top of everything as an
 * annotation.
 *
 * Sources: XFA 3.3 (SHA-256 a3344e7e...ca01e), cited at each rule.
 */
import type { PlacedNode } from './xfaflow.js';
import { fieldRegions, type XfaBox } from './xfageom.js';
import type { LeafText, RunSpec, RunStyle } from './xfarich.js';
import { layoutLeaf, type FaceLookup, type LeafLine } from './xfatext.js';
import type { Rgb, XfaBorder, XfaCorner, XfaGeometry, XfaHand, XfaStroke } from './xfaborder.js';

export type PathCmd =
  | ['M', number, number] | ['L', number, number]
  | ['C', number, number, number, number, number, number] | ['Z'];
export type ChromeOp =
  | { kind: 'fill'; path: PathCmd[]; color: Rgb }
  | { kind: 'stroke'; path: PathCmd[]; color: Rgb; width: number; dash?: number[];
      cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' }
  | { kind: 'text'; x: number; y: number; text: string; style: RunStyle; color: Rgb;
      underline: boolean; lineThrough: boolean };
export interface ChromeResult { ops: ChromeOp[]; skipped: Array<{ name: string; reason: string }>; warnings: string[] }

/** The cubic approximation of a quarter circle. */
const K = 0.5522847498;
const THREE_D: ReadonlySet<XfaStroke> = new Set(['lowered', 'raised', 'etched', 'embossed']);

type Pt = [number, number];

/** Our dash geometry. XFA 3.3 names the strokes (p. 688) and gives no
 *  lengths, so these are a stated choice, scaled by thickness. */
function dashOf(s: XfaStroke, t: number): { dash?: number[]; cap?: 'butt' | 'round' } {
  const u = Math.max(t, 0.25);
  switch (s) {
    case 'dashed': return { dash: [3 * u, 3 * u], cap: 'butt' };
    case 'dotted': return { dash: [0, 2 * u], cap: 'round' };
    case 'dashDot': return { dash: [3 * u, 2 * u, 0, 2 * u], cap: 'round' };
    case 'dashDotDot': return { dash: [3 * u, 2 * u, 0, 2 * u, 0, 2 * u], cap: 'round' };
    default: return {};
  }
}

/** p. 630 (and pdf.js `createWrapper`): how far OUTWARD an edge's centreline
 *  sits from the vector -- `even` on it, `left` half a thickness outside,
 *  `right` half a thickness inside. p. 38 says a thicker stroke "spreads
 *  toward the inside", which is the `right` hand and not the `even` default;
 *  the element reference and pdf.js agree, and win. */
const handShift = (hand: XfaHand, t: number): number => (hand === 'even' ? 0 : hand === 'left' ? t / 2 : -t / 2);

const grow = (r: XfaBox, d: number): XfaBox => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
const radiusOf = (c: XfaCorner, r: XfaBox): number => Math.max(0, Math.min(c.radius, r.w / 2, r.h / 2));

/** One corner from `from` to `to`, its vertex at `v` (p. 663-664): a round
 *  join is a quarter arc, convex unless `inverted` (then centred ON the
 *  vertex); a square `inverted` corner is a right-angle notch of depth radius;
 *  a plain square corner runs through the vertex. Radius 0 draws nothing. */
function corner(c: XfaCorner, rad: number, from: Pt, v: Pt, to: Pt, out: PathCmd[]): void {
  if (rad <= 0) return;
  if (c.join === 'round') {
    const c1: Pt = c.inverted
      ? [from[0] + K * (to[0] - v[0]), from[1] + K * (to[1] - v[1])]
      : [from[0] + K * (v[0] - from[0]), from[1] + K * (v[1] - from[1])];
    const c2: Pt = c.inverted
      ? [to[0] + K * (from[0] - v[0]), to[1] + K * (from[1] - v[1])]
      : [to[0] + K * (v[0] - to[0]), to[1] + K * (v[1] - to[1])];
    out.push(['C', c1[0], c1[1], c2[0], c2[1], to[0], to[1]]);
    return;
  }
  if (c.inverted) out.push(['L', from[0] + (to[0] - v[0]), from[1] + (to[1] - v[1])]);
  else out.push(['L', v[0], v[1]]);
  out.push(['L', to[0], to[1]]);
}

/** The border rectangle as one closed path, clockwise from the top edge, each
 *  edge trimmed by its corners' radii (p. 664, 687). */
function rectPath(r: XfaBox, cs: XfaCorner[]): PathCmd[] {
  const [r0, r1, r2, r3] = cs.map((c) => radiusOf(c, r));
  const { x, y, w, h } = r;
  const out: PathCmd[] = [['M', x + r0, y], ['L', x + w - r1, y]];
  corner(cs[1], r1, [x + w - r1, y], [x + w, y], [x + w, y + r1], out);
  out.push(['L', x + w, y + h - r2]);
  corner(cs[2], r2, [x + w, y + h - r2], [x + w, y + h], [x + w - r2, y + h], out);
  out.push(['L', x + r3, y + h]);
  corner(cs[3], r3, [x + r3, y + h], [x, y + h], [x, y + h - r3], out);
  if (r0 > 0) {
    out.push(['L', x, y + r0]);
    corner(cs[0], r0, [x, y + r0], [x, y], [x + r0, y], out);
  }
  out.push(['Z']);
  return out;
}

/** The `i`-th edge (top, right, bottom, left) as an open path, trimmed by its
 *  corners' radii and never running backwards. */
function edgeSegment(r: XfaBox, i: number, cs: XfaCorner[]): PathCmd[] {
  const w = Math.max(0, r.w);
  const h = Math.max(0, r.h);
  const rb: XfaBox = { x: r.x, y: r.y, w, h };
  const [r0, r1, r2, r3] = cs.map((c) => radiusOf(c, rb));
  const span = (a: number, b: number): [number, number] => (b < a ? [a, a] : [a, b]);
  if (i === 0) { const [a, b] = span(r.x + r0, r.x + w - r1); return [['M', a, r.y], ['L', b, r.y]]; }
  if (i === 1) { const [a, b] = span(r.y + r1, r.y + h - r2); return [['M', r.x + w, a], ['L', r.x + w, b]]; }
  if (i === 2) { const [a, b] = span(r.x + r3, r.x + w - r2); return [['M', a, r.y + h], ['L', b, r.y + h]]; }
  const [a, b] = span(r.y + r0, r.y + h - r3);
  return [['M', r.x, a], ['L', r.x, b]];
}

/** Every visible edge alike and every corner alike: one closed stroke. */
function uniform(b: XfaBorder): boolean {
  const es = b.edges!;
  const e = es[0];
  const c = b.corners[0];
  return es.every((x) => x.visible && x.stroke === e.stroke && x.thickness === e.thickness
      && x.color.join() === e.color.join())
    && b.corners.every((x) => x.radius === c.radius && x.join === c.join && x.inverted === c.inverted);
}

/** A border's fill and stroke (p. 38, 629-630, 663-665, 687-689, 734). */
export function borderOps(box: XfaBox, b: XfaBorder, out: ChromeOp[], skip: (r: string) => void): void {
  if (!b.visible || !(box.w > 0) || !(box.h > 0)) return;
  const r: XfaBox = {
    x: box.x + b.margin.l, y: box.y + b.margin.t,
    w: box.w - b.margin.l - b.margin.r, h: box.h - b.margin.t - b.margin.b,
  };
  if (!(r.w > 0) || !(r.h > 0)) return;
  if (b.fill?.kind === 'solid') out.push({ kind: 'fill', path: rectPath(r, b.corners), color: b.fill.color });
  else if (b.fill?.kind === 'unsupported') skip(`a ${b.fill.type} fill is not painted`);
  if (b.breakOpen) skip('a break="open" border is drawn closed');
  const edges = b.edges;
  if (!edges) return;
  for (const s of new Set(edges.filter((e) => e.visible && THREE_D.has(e.stroke)).map((e) => e.stroke)))
    skip(`a ${s} border edge is painted solid`);
  if (uniform(b)) {
    const e = edges[0];
    const rr = grow(r, handShift(b.hand, e.thickness));
    if (!(rr.w > 0) || !(rr.h > 0)) return;
    const ds = dashOf(e.stroke, e.thickness);
    const c = b.corners[0];
    out.push({
      kind: 'stroke', path: rectPath(rr, b.corners), color: e.color, width: e.thickness,
      ...(ds.dash ? { dash: ds.dash } : {}), cap: ds.cap ?? 'butt',
      join: c.join === 'round' && c.radius > 0 ? 'round' : 'miter',
    });
    return;
  }
  // p. 687: a border edge has no termination; square caps make two adjacent
  // edges meet without a notch.
  edges.forEach((e, i) => {
    if (!e.visible) return;
    const rr = grow(r, handShift(b.hand, e.thickness));
    const ds = dashOf(e.stroke, e.thickness);
    out.push({
      kind: 'stroke', path: edgeSegment(rr, i, b.corners), color: e.color, width: e.thickness,
      ...(ds.dash ? { dash: ds.dash } : {}), cap: ds.cap ?? 'square', join: 'miter',
    });
  });
}

/** A `<line>`, `<rectangle>` or `<arc>` draw (p. 768, 824). */
function geometryOps(box: XfaBox, g: XfaGeometry, out: ChromeOp[], skip: (r: string) => void): void {
  if (g.kind === 'unsupported') { skip(`an <${g.what}> draw is not painted`); return; }
  if (g.kind === 'rectangle') {
    borderOps(box, {
      visible: true, hand: g.hand, edges: g.edges, corners: g.corners,
      ...(g.fill ? { fill: g.fill } : {}), margin: { l: 0, r: 0, t: 0, b: 0 }, breakOpen: false, notes: [],
    }, out, skip);
    return;
  }
  const e = g.edge;
  if (!e.visible || !(box.w >= 0) || !(box.h >= 0)) return;
  const a: Pt = g.slope === '/' ? [box.x, box.y + box.h] : [box.x, box.y];
  const z: Pt = g.slope === '/' ? [box.x + box.w, box.y] : [box.x + box.w, box.y + box.h];
  const len = Math.hypot(z[0] - a[0], z[1] - a[1]);
  if (!(len > 0)) return;
  // p. 630: `left` puts the line to the left of travel, `right` to the right;
  // in a y-down frame the left normal of (dx, dy) is (dy, -dx).
  const d = g.hand === 'even' ? 0 : g.hand === 'left' ? e.thickness / 2 : -e.thickness / 2;
  const nx = ((z[1] - a[1]) / len) * d;
  const ny = (-(z[0] - a[0]) / len) * d;
  if (THREE_D.has(e.stroke)) skip(`a ${e.stroke} line is painted solid`);
  const ds = dashOf(e.stroke, e.thickness);
  out.push({
    kind: 'stroke', path: [['M', a[0] + nx, a[1] + ny], ['L', z[0] + nx, z[1] + ny]], color: e.color,
    width: e.thickness, ...(ds.dash ? { dash: ds.dash } : {}), cap: ds.cap ?? e.cap, join: 'miter',
  });
}

/** Room a width-growable leaf is laid out with beyond its own width, so a leaf
 *  measured at exactly its natural width does not re-wrap on a ulp; taken back
 *  off before alignment. */
const SLACK = 1e-6;

/** One piece of text to show, in its run's style and paint. */
function textOp(x: number, y: number, text: string, run: RunSpec): ChromeOp {
  return {
    // A spacerun's protected U+00A0 (164g.17) is the space it stands for.
    kind: 'text', x, y, text: text.replace(/ /g, ' '),
    style: { family: run.family, size: run.size, bold: run.bold, italic: run.italic },
    color: run.color ?? [0, 0, 0], underline: !!run.underline, lineThrough: !!run.lineThrough,
  };
}

/** A line's words with their widths, measured in each word's own face. */
function wordsOf(line: LeafLine, t: LeafText, faces: FaceLookup): Array<{ text: string; run: number; w: number }> | undefined {
  const p = t.paras[line.para];
  const out: Array<{ text: string; run: number; w: number }> = [];
  for (const s of line.segments) {
    const run = p.runs[s.run];
    for (const word of s.text.split(' ')) {
      if (word === '') continue;
      const m = faces(run, word);
      if ('reason' in m) return undefined;
      let u = 0;
      for (const ch of word) u += m.advance(ch.codePointAt(0)!) ?? 0;
      out.push({ text: word, run: s.run, w: (u * run.size) / m.unitsPerEm });
    }
  }
  return out;
}

/** A leaf's text laid into `block` by the SAME `layoutRuns` call that
 *  measured it (XFA 3.3 p. 56-61), aligned per p. 800: `vAlign` places the
 *  block, `hAlign` each line; `justify` spreads every line but a
 *  paragraph's last, `justifyAll` every line. */
function textOps(
  block: XfaBox, t: LeafText, faces: FaceLookup, out: ChromeOp[], skip: (r: string) => void,
): void {
  // The refusal FIRST: a refused leaf's runs are empty, so the blank test
  // below would drop it silently (found by the pdf.js oracle).
  if (t.refusal !== undefined) { skip(`${t.refusal}, so its text is not painted`); return; }
  if (t.kind !== 'text' || !t.paras.some((p) => p.runs.some((r) => r.text.trim() !== ''))) return;
  const l = layoutLeaf(t, { width: block.w + SLACK }, faces);
  if ('reason' in l) { skip(`${l.reason}, so its text is not painted`); return; }
  const ins = l.text.insets;
  const slack = (block.h - ins.t - ins.b) - (l.h - ins.t - ins.b);
  const k = t.vAlign === 'middle' ? 0.5 : t.vAlign === 'bottom' ? 1 : 0;
  const top = block.y + ins.t + (slack > 0 ? slack * k : 0);
  const left = block.x + ins.l;
  for (const line of l.lines) {
    const p = l.text.paras[line.para];
    const y = top + line.baseline;
    // From the block, not `line.room`: that one carries SLACK.
    const room = block.w - ins.l - ins.r - p.marginRight - line.left;
    const free = room - line.width;
    if ((p.hAlign === 'justify' && !line.last) || p.hAlign === 'justifyAll') {
      const words = wordsOf(line, l.text, faces);
      if (words && words.length > 1) {
        const gap = (room - words.reduce((a, w) => a + w.w, 0)) / (words.length - 1);
        if (gap > 0) {
          let x = left + line.left;
          for (const w of words) { out.push(textOp(x, y, w.text, p.runs[w.run])); x += w.w + gap; }
          continue;
        }
      }
    }
    const shift = free <= 0 ? 0 : p.hAlign === 'center' ? free / 2 : p.hAlign === 'right' ? free : 0;
    let x = left + line.left + shift;
    for (const sg of line.segments) {
      if (sg.text !== '') out.push(textOp(x, y, sg.text, p.runs[sg.run]));
      x += sg.width;
    }
  }
}

/**
 * Every placed node's chrome, in document order. `faces` measures text; when
 * it is absent no text is painted (border-only callers).
 */
export function chromeOps(nodes: readonly PlacedNode[], faces?: FaceLookup): ChromeResult {
  const ops: ChromeOp[] = [];
  const skipped: ChromeResult['skipped'] = [];
  const warnings: string[] = [];
  for (const p of nodes) {
    const n = p.node;
    const name = n.field ?? n.label;
    const skip = (reason: string): void => { skipped.push({ name, reason }); };
    if ('reason' in p) {
      if (n.chrome !== undefined || n.kind === 'draw') skip(`${p.reason}, so its chrome is not painted`);
      continue;
    }
    if (p.invisible) continue;
    const c = n.chrome;
    if (c?.border) {
      for (const note of c.border.notes) warnings.push(`${name}: ${note}`);
      borderOps(p.box, c.border, ops, skip);
    }
    if (c?.geometry) geometryOps(p.box, c.geometry, ops, skip);
    if (!faces) continue;
    // A draw paints its value; a field paints its CAPTION and never its value,
    // which is the widget's appearance -- a password must not reach the page.
    if (n.kind === 'draw' && n.text) {
      for (const note of n.text.notes ?? []) warnings.push(`${name}: ${note}`);
      textOps(p.box, n.text, faces, ops, skip);
    }
    if (n.kind === 'field' && c?.caption && c.captionPresence !== 'invisible') {
      const reg = fieldRegions(p.box, c.fieldCaption, c.fieldMargin);
      if (!('reason' in reg) && reg.caption) {
        for (const note of c.caption.notes ?? []) warnings.push(`${name}: ${note}`);
        textOps(reg.caption, c.caption, faces, ops, skip);
      }
    }
  }
  return { ops, skipped, warnings };
}
