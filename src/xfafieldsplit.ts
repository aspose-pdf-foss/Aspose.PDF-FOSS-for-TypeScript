// src/xfafieldsplit.ts
/**
 * Splitting an XFA field between its lines across content areas (`164g.13`):
 * where Adobe Reader 26.1 cuts a field that straddles a break, and the piece
 * either side. Measured by probe (`test/fixtures/xfa-adobe/`, t6, t9-t11, t20,
 * t21, t27, t28, t31, t40-t54; spec
 * `docs/superpowers/specs/2026-10-15-xfa-split-field-design.md`).
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES.** It never
 * throws: a field it cannot split is a named refusal, and the caller decides
 * what a refusal means in its parent.
 *
 * **Invariant: lines sit on a `1.2 x font size` grid from the field's top,
 * whatever the face (t45 Courier New and t50 Arial both 12pt at 10pt; t51 24pt
 * at 20pt).** Our own measured line height (hhea, 164g.7) is NOT that grid.
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

const TEXT_UI: ReadonlySet<string> = new Set(['textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit']);

export type FieldCut = { cut: number } | 'move' | { refusal: string };

/** Spec rule 6: what about this field no probe shows Adobe splitting. */
function splitRefusal(n: LayoutNode): string | undefined {
  const t = n.text;
  const fs = fontSizeOf(n);
  let what: string | undefined;
  if (n.ui !== undefined && !TEXT_UI.has(n.ui)) what = `a <${n.ui}> field`;
  else if (n.comb) what = 'a comb field';
  else if (t?.caption) what = 'a captioned field';
  else if ((t?.insets?.t ?? 0) !== 0 || (t?.insets?.b ?? 0) !== 0) what = 'a field with a top or bottom inset';
  else if (t?.vAlign) what = `a field stating vAlign="${t.vAlign}"`;
  else if (t?.paras?.some((p) => p.lineHeight)) what = 'a field with a stated lineHeight';
  else if (n.lineKeep) what = 'a field stating orphans or widows';
  else if (t?.paras?.some((p) => p.base.size !== fs || (p.runs ?? []).some((r) => r.size !== fs)))
    what = 'a field with mixed font sizes';
  return what === undefined ? undefined
    : `${n.label}: ${what} would split across a content-area break, which is not implemented (164g.26)`;
}

/**
 * Where a field of height `h` straddling a break splits, with `room` left above
 * the break from the piece's top, and `lines` the wrapped line count of its
 * value (0 when empty; undefined when it could not be counted).
 *
 * Rule 3: the cut is the room once the top piece reaches the font size (t9).
 * Rule 2: inside the text it snaps down to a whole line, at least one (t45, t52;
 * no orphan or widow control, t52, t53). Rule 4: a bottom piece under one font
 * size moves the cut up by EXACTLY one font size (t21, t40, t41, t44), snapping
 * again inside the text. A piece's grid is the FIELD's, from its `offset`.
 */
export function fieldCut(n: LayoutNode, room: number, lines: number | undefined, h: number): FieldCut {
  const fs = fontSizeOf(n);
  if (room < fs - EPS) return 'move';
  const why = splitRefusal(n);
  if (why !== undefined) return { refusal: why };
  if (lines === undefined)
    return { refusal: `${n.label}: its value's wrapped line count is not known, so where it splits is not known` };
  const pitch = LINE_PITCH * fs;
  const off = n.piece?.offset ?? 0;
  const textEnd = lines * pitch - off;
  const snap = (c: number): number =>
    (c < textEnd - EPS ? Math.floor((off + c) / pitch + EPS) * pitch - off : c);
  let c = snap(room);
  if (h - c < fs - EPS) c = snap(c - fs);
  if (c < fs - EPS || c >= h - EPS) return 'move';
  return { cut: c };
}

/** The part of field `n` from `off` down, `h` tall: a copy stating that `h`,
 *  its `minMax` dropped, carrying the offset from the WHOLE field's top and the
 *  lines it holds on the grid. A piece of a piece composes offsets. */
export function pieceOf(n: LayoutNode, off: number, h: number): LayoutNode {
  const offset = (n.piece?.offset ?? 0) + off;
  const pitch = LINE_PITCH * fontSizeOf(n);
  const lines: [number, number] = [Math.round(offset / pitch), Math.round((offset + h) / pitch)];
  const { minMax: _stated, ...rest } = n;
  void _stated;
  return { ...rest, geom: { ...n.geom, h: ptStr(h) }, piece: { offset, lines } };
}
