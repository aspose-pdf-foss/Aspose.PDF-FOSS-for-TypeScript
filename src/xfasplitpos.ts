// src/xfasplitpos.ts
/**
 * Splitting a positioned XFA subform across content areas (`164g.11`): where
 * the cut falls, and the fragments either side of it. The rules are what Adobe
 * Reader 26.1 does, measured by probe (`test/fixtures/xfa-adobe/`, spec
 * `docs/superpowers/specs/2026-10-14-xfa-split-positioned-design.md`, R1-R8).
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES and `xfageom.js`.** Child
 * boxes arrive through a callback, so every rule is testable from hand-built
 * nodes. It never throws: a shape it cannot split is a named refusal.
 *
 * **Invariant: Adobe splits a positioned subform ONLY when it states
 * `keep intact="none"`.** XFA 3.3 p. 292 reads as `none` for any subform under
 * a flowing parent; Adobe treats a positioned one as unsplittable unless told
 * (t3 against t5), and Adobe is the oracle.
 */
import { measureToPt } from './xfageom.js';
import type { ChildBox, LayoutNode } from './xfaflow.js';
import { fieldCut, pieceOf, ptStr } from './xfafieldsplit.js';

/** Tolerance for comparing summed measurements (`xfapage.ts`'s). */
const EPS = 1e-6;

/** A positioned container's children as pagination sees them (164g.11). */
export type XfaChildBoxes = (n: LayoutNode) => ChildBox[] | { reason: string };

/** R1 (t3, t5, t13): a positioned subform splits only when it states
 *  `<keep intact="none"/>`. Its parent's being a flow is the caller's to know. */
export function positionedSplittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && (n.layout ?? 'position') === 'position'
    && n.refusal === undefined && n.keep?.intact === 'none';
}

const inset = (s: string | undefined): number => (s === undefined ? 0 : measureToPt(s) ?? NaN);
/**
 * Where `n` splits when `room` is left (R2-R8): the room, moved up to the top of
 * every straddling child that will not split, until none straddles. A cut of 0
 * means `n` cannot split here (R5).
 */
export function positionedCut(
  n: LayoutNode, room: number, boxes: XfaChildBoxes, lines?: (n: LayoutNode) => number | undefined,
): number | { refusal: string } {
  // R7 (t14): Adobe's margins across a split are unresolved.
  if (inset(n.margin?.topInset) !== 0 || inset(n.margin?.bottomInset) !== 0)
    return { refusal: `${n.label}: a positioned subform with a top or bottom margin is not split across content areas (164g.20)` };
  const kids = boxes(n);
  if ('reason' in kids) return { refusal: kids.reason };
  // R8: fragments rewrite each child's y, which an anchor would reinterpret.
  for (const k of kids) {
    const a = k.node.geom.anchorType;
    if (a !== undefined && a !== 'topLeft')
      return { refusal: `${k.node.label}: a child anchored ${a} is not split with its positioned parent` };
  }
  // R6 needs every child inside [0, h): a child above the top or at or below a
  // STATED height belongs to no fragment, and no probe says where Adobe puts
  // it, so the split is refused by name rather than the child lost. A keep-none
  // child running past that height would be truncated with its children.
  const H = n.geom.h === undefined ? undefined : measureToPt(n.geom.h);
  for (const k of kids) {
    const outside = k.top < -EPS || (H !== undefined && (k.top >= H - EPS
      || (positionedSplittable(k.node) && k.top + k.h > H + EPS)));
    if (outside) return { refusal: `${k.node.label}: a child outside its positioned parent's height is not split with it` };
  }
  let cut = room;
  for (let moved = true; moved;) {
    moved = false;
    for (const k of kids) {
      // Straddling: top above the cut and bottom below it (a top ON the cut is not).
      if (!(k.top < cut - EPS && k.top + k.h > cut + EPS)) continue;
      let next = k.top;
      if (positionedSplittable(k.node)) {
        // R3 (t24): a keep-none positioned child splits at the same cut -- unless
        // it states an <overflow>, whose leader XFA would insert there (164g.15).
        if (k.node.overflow)
          return { refusal: `${k.node.label}: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)` };
        const inner = positionedCut(k.node, cut - k.top, boxes, lines);
        if (typeof inner === 'object') return inner;
        next = k.top + inner;
      } else if (k.node.kind === 'field') {
        // R4 (t6, t9-t11, t20, t21; 164g.13): Adobe splits a straddling field
        // where fieldCut says; one it would move moves the cut to its top (R2).
        const fc = fieldCut(k.node, cut - k.top, lines?.(k.node), k.h);
        if (typeof fc === 'object' && 'refusal' in fc) return { refusal: fc.refusal };
        if (fc !== 'move') next = k.top + fc.cut;
      }
      // R2 (t7, t8, t12, t13, t17-t19, t22): a draw, an unsplittable subform,
      // or a field whose top piece is below its font size moves the cut up.
      if (next < cut - EPS) { cut = next; moved = true; }
    }
  }
  return cut;
}

const concealed = (c: LayoutNode): boolean => c.presence === 'hidden' || c.presence === 'inactive';

/**
 * The part of `n` between `from` and `to` (R6; t5, t15, t24, t26): a shallow
 * copy stating `h = to - from`, holding the children whose top falls in
 * `[from, to)` at their y minus `from`. After `positionedCut` no unsplittable
 * child straddles a cut, so each leaf lands in exactly one fragment and keeps
 * its SOM name; a keep-none positioned child crossing an edge is represented by
 * its own fragment (R3). A fragment may hold nothing (t26). Hidden children take
 * no space (p. 67) and ride in the first fragment so their fields stay known.
 */
export function positionedFragment(
  n: LayoutNode, from: number, to: number, boxes: XfaChildBoxes,
): LayoutNode | { refusal: string } {
  const kids = boxes(n);
  if ('reason' in kids) return { refusal: kids.reason };
  const box = new Map(kids.map((k) => [k.node, k]));
  // `to` is the subform's own end, not a cut, on its last fragment.
  const end = n.geom.h === undefined ? undefined : measureToPt(n.geom.h);
  const atEnd = end === undefined || to >= end - EPS;
  const children: LayoutNode[] = [];
  for (const c of n.children) {
    if (concealed(c)) { if (from <= EPS) children.push(c); continue; }
    const k = box.get(c);
    if (k === undefined) continue;
    const bottom = k.top + k.h;
    const crosses = k.top < from - EPS || bottom > to + EPS;
    if (positionedSplittable(c) && crosses && k.top < to - EPS && bottom > from + EPS) {
      const f = positionedFragment(c, Math.max(0, from - k.top), Math.min(k.h, to - k.top), boxes);
      if ('refusal' in f) return f;
      children.push({ ...f, geom: { ...f.geom, y: ptStr(Math.max(k.top, from) - from) } });
    } else if (c.kind === 'field' && k.top < to - EPS && bottom > from + EPS
      && (k.top < from - EPS || (bottom > to + EPS && !atEnd))) {
      // 164g.13: a field the cut runs through is in both fragments, as pieces.
      // It is clipped at a CUT and never at the subform's own end: one running
      // past its parent's stated height keeps its whole remainder (t51).
      const a = Math.max(k.top, from);
      const b = atEnd ? bottom : Math.min(bottom, to);
      const piece = pieceOf(c, a - k.top, b - a);
      children.push({ ...piece, geom: { ...piece.geom, y: ptStr(a - from) } });
    } else if (k.top >= from - EPS && k.top < to - EPS) {
      children.push({ ...c, geom: { ...c.geom, y: ptStr(k.top - from) } });
    }
  }
  const { minMax: _stated, ...rest } = n;
  void _stated;
  return { ...rest, geom: { ...n.geom, h: ptStr(to - from) }, children };
}
