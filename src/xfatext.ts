// src/xfatext.ts
/**
 * The nominal size of an XFA leaf's text (`164g.7`), XFA 3.3 p. 56-61 and
 * p. 275-279.
 *
 * **Invariant: a pure leaf.** Faces arrive through `FaceLookup`, so every rule
 * is testable from synthetic metrics. It never throws.
 *
 * **Invariant: ONE wrapping engine.** Lines are broken by `layoutRuns`; only the
 * line HEIGHT is computed here, because XFA's is the tallest glyph box on the
 * line (p. 61) where `layoutRuns` uses a leading. Read as hhea ascender minus
 * descender -- pdf.js measures 10pt Arial as exactly that, 11.17pt.
 */
import { layoutRuns, type FontDriver, type TextLayoutRun } from './layout.js';
import type { LeafText, ParaSpec, RunStyle } from './xfarich.js';

export interface FaceMetrics {
  unitsPerEm: number;
  /** hhea ascender, font units, positive. */
  ascent: number;
  /** minus hhea descender, font units, positive. */
  descent: number;
  /** Advance in font units, or undefined when the face has no glyph. */
  advance(cp: number): number | undefined;
}
export type FaceLookup = (style: RunStyle, text: string) => FaceMetrics | { reason: string };
export type MeasureBox = { width: number } | { maxWidth?: number };

const EMPTY = new Uint8Array(0);
const WIDE = 1e9;
const EPS = 1e-9;

function driverFor(m: FaceMetrics): FontDriver {
  const units = (t: string): number => {
    let s = 0;
    for (const ch of t) s += m.advance(ch.codePointAt(0)!) ?? 0;
    return s;
  };
  return {
    measure: (t, fs) => (units(t) * fs) / m.unitsPerEm,
    encode: () => EMPTY,
    probe: (t) => [...t].filter((ch) => m.advance(ch.codePointAt(0)!) !== undefined).length,
  };
}

const extent = (m: FaceMetrics, size: number) => ({
  asc: (m.ascent * size) / m.unitsPerEm, desc: (m.descent * size) / m.unitsPerEm,
});

/** A password's mask: U+2022 where the face draws it, else `*`. */
function mask(t: LeafText, faces: FaceLookup): LeafText {
  const paras = t.paras.map((p) => ({
    ...p,
    runs: p.runs.map((r) => {
      const bullet = !('reason' in faces(r, '\u2022'));
      return { ...r, text: r.text.replace(/[^\n]/gu, bullet ? '\u2022' : '*') };
    }),
  }));
  return { ...t, paras };
}

interface ParaSize { w: number; h: number }

function measurePara(p: ParaSpec, width: number, grow: boolean, faces: FaceLookup): ParaSize | { reason: string } {
  const avail = width - p.marginLeft - p.marginRight;
  if (avail <= EPS) return { reason: 'its paragraph margins leave no room for its text' };
  const baseLine = (s: RunStyle): number | { reason: string } => {
    const m = faces(s, '');
    if ('reason' in m) return m;
    const e = extent(m, s.size);
    return Math.max(e.asc + e.desc, p.lineHeight);
  };
  if (p.runs.length === 0) {
    const h = baseLine(p.base);
    return typeof h === 'number' ? { w: p.marginLeft + p.marginRight, h } : h;
  }
  if (grow) {
    for (const line of p.runs.map((r) => r.text).join('').split('\n'))
      if (/^ | $/.test(line)) return { reason: 'its width depends on leading or trailing whitespace, which is not measured' };
  }
  const metrics: FaceMetrics[] = [];
  const runs: TextLayoutRun[] = [];
  for (const r of p.runs) {
    const m = faces(r, r.text);
    if ('reason' in m) return m;
    metrics.push(m);
    runs.push({ text: r.text, driver: driverFor(m), fontSize: r.size });
  }
  const res = layoutRuns(runs, avail, WIDE, 1, p.base.size, p.textIndent);
  let h = 0;
  let w = 0;
  res.lines.forEach((line, i) => {
    let asc = 0;
    let desc = 0;
    for (const seg of line.segments) {
      const e = extent(metrics[seg.run], p.runs[seg.run].size);
      asc = Math.max(asc, e.asc);
      desc = Math.max(desc, e.desc);
    }
    if (line.segments.length === 0) {
      const e = extent(metrics[0], p.base.size);
      asc = e.asc; desc = e.desc;
    }
    h += Math.max(asc + desc, p.lineHeight);
    w = Math.max(w, line.width + (i === 0 ? p.textIndent : 0));
  });
  return { w: w + p.marginLeft + p.marginRight, h };
}

/** The leaf's nominal extent at `box`, insets and caption included. */
export function measureLeaf(
  t0: LeafText, box: MeasureBox, faces: FaceLookup,
): { w: number; h: number } | { reason: string } {
  if (t0.refusal !== undefined) return { reason: t0.refusal };
  if (t0.kind === 'geometry') return { w: 0, h: 0 };
  const t = t0.password ? mask(t0, faces) : t0;
  const cap = t.caption;
  if (cap && cap.reserve === undefined)
    return { reason: 'its caption states no reserve, so the room left for its text is not known' };
  const capW = cap && (cap.placement === 'left' || cap.placement === 'right') ? cap.reserve! : 0;
  const capH = cap && (cap.placement === 'top' || cap.placement === 'bottom') ? cap.reserve! : 0;
  const { l, r, t: top, b } = t.insets;
  const fixed = 'width' in box ? box.width : undefined;
  const limit = fixed ?? ('maxWidth' in box && box.maxWidth !== undefined ? box.maxWidth : undefined);
  const wrapAt = limit === undefined ? WIDE : limit - l - r - capW;
  if (wrapAt <= EPS) return { reason: 'its insets and caption leave no room for its text' };
  let h = 0;
  let w = 0;
  let prev: ParaSpec | undefined;
  for (const p of t.paras) {
    const s = measurePara(p, wrapAt, fixed === undefined, faces);
    if ('reason' in s) return s;
    if (prev) h += Math.max(prev.spaceBelow, p.spaceAbove);
    h += s.h;
    w = Math.max(w, s.w);
    prev = p;
  }
  return { w: fixed ?? w + l + r + capW, h: h + top + b + capH };
}
