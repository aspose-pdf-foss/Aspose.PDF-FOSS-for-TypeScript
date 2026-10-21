// src/xfafieldsplit.ts
/**
 * Splitting an XFA field between its lines across content areas (`164g.13`,
 * `164g.26`): where Adobe Reader 26.1 cuts a field that straddles a break, and
 * the piece either side. Measured by probe (`test/fixtures/xfa-adobe/`, t6,
 * t9-t11, t20, t21, t27, t28, t31, t40-t54, t127-t142; spec
 * `docs/superpowers/specs/2026-10-15-xfa-split-field-design.md`).
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES.** It never
 * throws: a field it cannot split is a named refusal, and the caller decides
 * what a refusal means in its parent.
 *
 * **Invariant: the cut snaps to a LINE BOTTOM of the field's own grid
 * (`FieldGrid`), from the field's top, whatever the face.** `xfatext.ts`'s
 * `splitGrid` builds it: the text starts below the top inset and a top caption
 * (t128, t129), shifted down by `vAlign` (t130, t140), and each line is 1.2 x
 * its own largest size (t45, t50, t51, t137), or a stated `lineHeight` L (t131,
 * t138, t139). A bare line count stands for the plain grid of a top-aligned
 * field at its base size.
 */
import type { LayoutNode } from './xfaflow.js';

const EPS = 1e-6;
/** Adobe's line pitch, as a multiple of the font size (t45, t50, t51). */
export const LINE_PITCH = 1.2;

/** A measurement written back into `geom`: snapped to 0 within EPS and never
 *  in exponent notation, which `measureToPt` cannot read -- mm templates leave
 *  residues like -2.8e-14 where a child sits on the cut. */
export const ptStr = (v: number): string => `${String(Math.abs(v) < EPS ? 0 : Number(v.toFixed(6)))}pt`;
/** A field's font size: its base run's (`leafText`), XFA's 10pt default otherwise. */
export const fontSizeOf = (f: LayoutNode): number => f.text?.paras[0]?.base.size ?? 10;

/** Where a field's value lines END, from the WHOLE field's top, in points.
 *  Empty for an empty value. */
export interface FieldGrid { bottoms: readonly number[] }
/** What a split knows of a field's lines: its grid, a bare count (the plain
 *  `1.2 x size` grid from the top), or nothing. */
export type FieldLines = FieldGrid | number | undefined;

/** The plain grid of `count` lines of a top-aligned field at its base size. */
export function gridOf(n: LayoutNode, count: number): FieldGrid {
  const pitch = LINE_PITCH * fontSizeOf(n);
  return { bottoms: Array.from({ length: count }, (_, i) => (i + 1) * pitch) };
}
const asGrid = (n: LayoutNode, lines: FieldGrid | number): FieldGrid =>
  (typeof lines === 'number' ? gridOf(n, lines) : lines);

/** The text-entry uis. Every other ui MOVES whole rather than splitting (t134,
 *  a check button, and t135, a list box, each move with 64pt of room left). */
const TEXT_UI: ReadonlySet<string> = new Set(['textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit']);

export type FieldCut = { cut: number } | 'move' | { refusal: string };

/**
 * Where a field of height `h` straddling a break splits, with `room` left above
 * the break from the piece's top, and `lines` what is known of its value's lines.
 *
 * Rule 3: the cut is the room once the top piece reaches the font size (t9).
 * Rule 2: above the text's end it snaps down to a line bottom, at least one
 * line (t45, t52); none above the room MOVES the field, even where the room
 * lies in a caption or in the space vAlign leaves above the text (t141, t142).
 * Below the text it is free (t54, t136). Rule 4: a bottom piece under one font
 * size moves the cut up by EXACTLY one font size (t21, t40, t41, t44), snapping
 * again. Rule 5 (164g.26): `orphans` and `widows` count lines of the WHOLE
 * value -- Reader holds them across plain-text newlines (t133), which
 * `plainParas` makes records of -- too few kept moves the field (t132), too few
 * left backs the cut off until enough are (t133). A piece's grid is the
 * FIELD's, from its `offset`.
 */
export function fieldCut(n: LayoutNode, room: number, lines: FieldLines, h: number): FieldCut {
  if (n.ui !== undefined && !TEXT_UI.has(n.ui)) return 'move';
  const fs = fontSizeOf(n);
  if (room < fs - EPS) return 'move';
  if (lines === undefined)
    return { refusal: `${n.label}: its value's wrapped line count is not known, so where it splits is not known` };
  const g = asGrid(n, lines);
  const off = n.piece?.offset ?? 0;
  const b = g.bottoms.map((x) => x - off);
  const textEnd = b.length === 0 ? -Infinity : b[b.length - 1];
  /** The last line kept by a cut at `c`, -1 for none. */
  const lastKept = (c: number): number => {
    let k = -1;
    for (let i = 0; i < b.length && b[i] <= c + EPS; i++) k = i;
    return k;
  };
  const at = (k: number): number => (k < 0 ? 0 : b[k]);
  const snap = (c: number): number => (c < textEnd - EPS ? at(lastKept(c)) : c);
  let c = snap(room);
  if (h - c < fs - EPS) c = snap(c - fs);
  if (n.lineKeep && c < textEnd - EPS) c = at(keepLines(lastKept(c), b, n.lineKeep));
  if (c < fs - EPS || c >= h - EPS) return 'move';
  return { cut: c };
}

/** Rule 5: the last line to keep once orphans and widows are honoured, from
 *  `k`, the last line a cut keeps (-1 for none). Lines an earlier piece holds
 *  (`b <= 0`) are already placed, so orphans count only this piece's. */
function keepLines(k: number, b: readonly number[], lk: { orphans: number; widows: number }): number {
  let first = 0;
  while (first < b.length && b[first] <= EPS) first++;
  const left = b.length - 1 - k;
  if (left > 0 && left < lk.widows) k = b.length - 1 - lk.widows;
  const kept = k - first + 1;
  // Orphans hold the value's first lines only: a later piece's are not orphans.
  if (kept > 0 && first === 0 && kept < lk.orphans) k = -1;
  return Math.max(k, first - 1);
}

/** The part of field `n` from `off` down, `h` tall: a copy stating that `h`,
 *  its `minMax` dropped, carrying the offset from the WHOLE field's top and the
 *  value lines [from, to) whose bottoms fall inside it on its grid. A piece of
 *  a piece composes offsets. */
export function pieceOf(n: LayoutNode, off: number, h: number, lines?: FieldLines): LayoutNode {
  const offset = (n.piece?.offset ?? 0) + off;
  const g = lines === undefined ? undefined : asGrid(n, lines);
  const pitch = LINE_PITCH * fontSizeOf(n);
  const upTo = (y: number): number => (g
    ? g.bottoms.filter((x) => x <= y + EPS).length
    : Math.round(y / pitch));
  const range: [number, number] = [upTo(offset), upTo(offset + h)];
  const { minMax: _stated, ...rest } = n;
  void _stated;
  return { ...rest, geom: { ...n.geom, h: ptStr(h) }, piece: { offset, lines: range } };
}
