// src/xfatext.ts
/**
 * The nominal size of an XFA leaf's text (`164g.7`), XFA 3.3 p. 56-61 and
 * p. 275-279.
 *
 * **Invariant: a pure leaf.** Faces arrive through `FaceLookup`, so every rule
 * is testable from synthetic metrics. It never throws.
 *
 * **Invariant: ONE wrapping engine.** Lines are broken by `layoutRuns`; only the
 * line HEIGHT is computed here (`lineStep`, `lastLine`), as Adobe Reader
 * measures it from the font SIZE and not the face (164g.32, probes t111-t117).
 * 164g.7 read p. 61's "tallest glyph box" as hhea ascender minus descender,
 * which is pdf.js's answer (10pt Arial, 11.17pt) and not Adobe's (10pt). The
 * face still decides where a line BREAKS, and a baseline still sits one hhea
 * ascent below its line's top, which `xfa.layout` cannot observe.
 */
import { layoutRuns, type FontDriver, type TextLayoutRun } from './layout.js';
import type { LeafText, ParaSpec, RunStyle } from './xfarich.js';
import { measureToPt, type XfaCaption, type XfaMargin } from './xfageom.js';

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

/** A laid line before its vertical place is known: its largest run size and
 *  its ascent, which `layoutLeaf` turns into a band and a baseline. */
interface PendingLine { line: Omit<LeafLine, 'baseline'>; size: number; asc: number }
interface ParaSize { w: number; lines: PendingLine[] }

/** One run's piece of a laid-out line. */
export interface LeafSegment { run: number; text: string; width: number }
/** One laid-out line of a leaf's text (164g.4), in the text block's own frame:
 *  top inset excluded, left inset excluded, caption reserve excluded. */
export interface LeafLine {
  /** Baseline, from the top of the leaf's text block. */
  baseline: number;
  /** Left edge of the line before alignment: marginLeft, plus textIndent on a
   *  paragraph's first line. */
  left: number;
  /** Width the line may align within. */
  room: number;
  width: number;
  para: number;
  /** Last line of its paragraph (justify leaves it ragged). */
  last: boolean;
  segments: LeafSegment[];
}
/** The lines `measureLeaf` measures, with the extent it reports and the leaf
 *  they were laid from (masked, for a password). */
export interface LeafLayout { lines: LeafLine[]; w: number; h: number; text: LeafText }

function layoutPara(
  p: ParaSpec, width: number, grow: boolean, faces: FaceLookup, para: number,
): ParaSize | { reason: string } {
  const avail = width - p.marginLeft - p.marginRight;
  if (avail <= EPS) return { reason: 'its paragraph margins leave no room for its text' };
  if (p.runs.length === 0) {
    const m = faces(p.base, '');
    if ('reason' in m) return m;
    return {
      w: p.marginLeft + p.marginRight,
      lines: [{ size: p.base.size, asc: extent(m, p.base.size).asc,
        line: { left: p.marginLeft + p.textIndent, room: avail - p.textIndent, width: 0, para, last: true, segments: [] } }],
    };
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
  const res = layoutRuns(runs, avail, WIDE, 1, p.base.size, p.textIndent, undefined, undefined, true);
  let w = 0;
  const lines: PendingLine[] = [];
  res.lines.forEach((line, i) => {
    let asc = 0;
    let size = 0;
    for (const seg of line.segments) {
      asc = Math.max(asc, extent(metrics[seg.run], p.runs[seg.run].size).asc);
      size = Math.max(size, p.runs[seg.run].size);
    }
    if (line.segments.length === 0) {
      asc = extent(metrics[0], p.base.size).asc;
      size = p.base.size;
    }
    lines.push({
      size, asc,
      line: {
        left: p.marginLeft + (i === 0 ? p.textIndent : 0),
        room: avail - (i === 0 ? p.textIndent : 0),
        width: line.width,
        para,
        last: i === res.lines.length - 1,
        segments: line.segments.map((sg) => ({ run: sg.run, text: sg.text, width: sg.width })),
      },
    });
    w = Math.max(w, line.width + (i === 0 ? p.textIndent : 0));
  });
  return { w: w + p.marginLeft + p.marginRight, lines };
}

/**
 * How far a line advances the leaf's text, as Adobe Reader lays it out
 * (164g.32, probes t111-t117): measured off the line's largest font size `s`,
 * WHATEVER THE FACE -- Courier New, Arial, Times New Roman and Myriad Pro all
 * give 10pt for one line of 10pt text, where their hhea metrics give 11.2-11.3.
 *
 * Every line but the leaf's last steps 1.2s, or the paragraph's `lineHeight` L
 * when it states one. The LAST line contributes s alone -- 1.2s(n-1) + s, so
 * 10, 22, 34 for one to three lines -- except that a stated L below 1.2s is the
 * line's whole height (n x L: L5 gives 5, 10, 15), and a stated L at or above
 * 1.2s makes a multi-line leaf end on 1.2s ((n-1)L + 1.2s: L20 gives 10, 32,
 * 52). The two-branch shape is the measurement's, not a derivation; mixed sizes
 * with a stated L are unprobed and use the line's largest size.
 */
function lineStep(s: number, L: number): number { return L > 0 ? L : 1.2 * s; }
function lastLine(s: number, L: number, n: number): number {
  if (L > 0 && L < 1.2 * s) return L;
  return L > 0 && n >= 2 ? 1.2 * s : s;
}

/**
 * How much a caption that states NO reserve takes from its field (164g.36):
 * its text, measured. XFA sizes such a caption from its content -- pdf.js lays
 * it out and takes its height -- and Adobe Reader agrees: probe t114 gives one
 * 8pt line 8pt in four faces, t121 three lines of a wrapping caption 27.2pt, its
 * own margins added and its own font size used, and DoD DD 3019's seven LFT
 * fields lose exactly 8pt to theirs. A caption with no text takes NOTHING
 * (DD 3183, Adobe 0).
 *
 * Only a caption above or below is measured. One beside the field would size
 * its WIDTH from its text, which no probe has settled, so it refuses. So does a
 * caption whose face does not resolve: a word too wide for its box WRAPS (t121:
 * a 16-W word takes four lines), so a line count is never known without widths.
 */
export function captionHeight(
  leaf: LeafText | undefined, placement: string, width: number | undefined, faces: FaceLookup,
): number | { reason: string } {
  if (!leaf || leaf.paras.every((p) => p.runs.every((r) => r.text === ''))) return 0;
  if (placement !== 'top' && placement !== 'bottom')
    return { reason: `its ${placement} caption states no reserve, and a caption beside its field is not measured` };
  const m = measureLeaf(leaf, width === undefined ? {} : { width }, faces);
  return 'reason' in m ? { reason: `its caption states no reserve and ${m.reason}` } : m.h;
}

/** A field's `<caption>` as the widget and the chrome place it (164g.36): a
 *  stated reserve as written, a reserve-less one with its measured height in
 *  its place, at the field's width less its own insets. ONE owner, so the
 *  widget and the painted caption cannot disagree about where the caption is. */
export function resolveCaption(
  cap: XfaCaption | undefined, leaf: LeafText | undefined, width: number,
  margin: XfaMargin | undefined, faces: FaceLookup,
): XfaCaption | undefined | { reason: string } {
  if (!cap || cap.reserve !== undefined || cap.presence === 'hidden') return cap;
  const l = measureToPt(margin?.leftInset ?? '0') ?? 0;
  const r = measureToPt(margin?.rightInset ?? '0') ?? 0;
  const h = captionHeight(leaf, cap.placement ?? 'left', width - l - r, faces);
  if (typeof h !== 'number') return h;
  return h === 0 ? cap : { ...cap, reserve: `${String(h)}pt` };
}

/** The leaf's laid-out lines at `box` (164g.4) -- the SAME `layoutRuns` call
 *  that measures it, so a painted leaf and its layout box cannot disagree. */
export function layoutLeaf(
  t0: LeafText, box: MeasureBox, faces: FaceLookup,
): LeafLayout | { reason: string } {
  if (t0.refusal !== undefined) return { reason: t0.refusal };
  if (t0.kind === 'geometry') return { lines: [], w: 0, h: 0, text: t0 };
  const t = t0.password ? mask(t0, faces) : t0;
  const cap = t.caption;
  const { l, r, t: top, b } = t.insets;
  const fixed = 'width' in box ? box.width : undefined;
  const limit = fixed ?? ('maxWidth' in box && box.maxWidth !== undefined ? box.maxWidth : undefined);
  // 164g.36: a reserve-less caption takes its measured text (captionHeight).
  let reserve = cap?.reserve;
  if (cap && reserve === undefined) {
    if (cap.text && limit === undefined && (cap.placement === 'top' || cap.placement === 'bottom'))
      return { reason: 'its caption states no reserve, and its width depends on the caption, which is not measured' };
    const h = captionHeight(cap.text, cap.placement, limit === undefined ? undefined : limit - l - r, faces);
    if (typeof h !== 'number') return h;
    reserve = h;
  }
  const capW = cap && (cap.placement === 'left' || cap.placement === 'right') ? reserve! : 0;
  const capH = cap && (cap.placement === 'top' || cap.placement === 'bottom') ? reserve! : 0;
  const wrapAt = limit === undefined ? WIDE : limit - l - r - capW;
  if (wrapAt <= EPS) return { reason: 'its insets and caption leave no room for its text' };
  let w = 0;
  const pending: Array<PendingLine & { p: ParaSpec }> = [];
  for (let i = 0; i < t.paras.length; i++) {
    const p = t.paras[i];
    const s = layoutPara(p, wrapAt, fixed === undefined, faces, i);
    if ('reason' in s) return s;
    for (const x of s.lines) pending.push({ ...x, p });
    w = Math.max(w, s.w);
  }
  // 164g.32: a paragraph's spaceAbove comes before its first line and its
  // spaceBelow after its last, SUMMED, never collapsed (t116: 5 + 7 = 12, one
  // line or two); the last-line rule is the LEAF's, across paragraphs (t115
  // mixC: 12 + 20).
  let h = 0;
  const lines: LeafLine[] = [];
  pending.forEach((x, k) => {
    if (k === 0 || pending[k - 1].p !== x.p) h += x.p.spaceAbove;
    lines.push({ ...x.line, baseline: h + x.asc });
    h += k === pending.length - 1 ? lastLine(x.size, x.p.lineHeight, pending.length) : lineStep(x.size, x.p.lineHeight);
    if (k === pending.length - 1 || pending[k + 1].p !== x.p) h += x.p.spaceBelow;
  });
  return { lines, w: fixed ?? w + l + r + capW, h: h + top + b + capH, text: t };
}

/** The leaf's nominal extent at `box`, insets and caption included. */
export function measureLeaf(
  t0: LeafText, box: MeasureBox, faces: FaceLookup,
): { w: number; h: number } | { reason: string } {
  const l = layoutLeaf(t0, box, faces);
  return 'reason' in l ? l : { w: l.w, h: l.h };
}
