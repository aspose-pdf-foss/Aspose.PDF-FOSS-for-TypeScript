/**
 * A side-by-side comparison document (`aq4a.4`), behind
 * `Document.CompareSideBySide`: each page pair set on one sheet, the first
 * document's page on the left and the second's on the right, deletions marked
 * on the left and insertions on the right.
 *
 * Split like `NUp`: `document.ts` allocates the sheets, because the page-tree
 * helpers are private to it, and this module plans them and draws on them. It
 * imports `Document` as a TYPE only.
 *
 * A page is placed as a Form XObject by `compose.ts`'s `importPageAsXObject`,
 * at full size, and a mark moves by exactly the transform the page did —
 * `importMatrix` (CropBox origin and `/Rotate`) then the sheet offset — so a
 * mark lands where `Search` on the result sheet finds the same word.
 *
 * Tagged output (`aq4a.7`) carries both documents' structure. The two pages on
 * a sheet each number their marked content from 0, and a sheet has ONE MCID
 * space under its `/StructParents` — so the right page's MCIDs are renumbered
 * in its placed copy (inline `/MCID`s, named `/Properties` entries and every
 * nested form) past the left page's highest, and `preserveStructure` clones
 * its elements with the same offset. A form-level `/StructParents` would give
 * each placed page its own MCID space instead, which is valid PDF; it is NOT
 * used because nothing in this library resolves one — the validator, an
 * element's text and every export would read that content as untagged.
 */
import type { Document } from './document.js';
import type { Page } from './page.js';
import { compareText, type CompareTextOptions, type TextComparison, type TextSpan } from './compare.js';
import { importMatrix, importPageAsXObject } from './compose.js';
import { apply, mul, type Matrix, type Rect } from './text.js';
import { rectToQuad } from './annotation.js';
import { PageGraphics } from './graphics.js';
import { ensureOwnResources, ensureOwnSubdict, freshKey, appendContent } from './pagecontent.js';
import { enc } from './serialize.js';
import { parseContentStream, serializeContentStream, type ContentOp } from './content.js';
import { decodeStream } from './filters.js';
import { preserveStructure, type PageOrigin } from './structpreserve.js';
import { tagAnnotation } from './structwrite.js';
import type { Annotation } from './annotation.js';
import { isDict, isName, isRef, isStream, type PdfDict, type PdfObject, type PdfStream } from './types.js';

export interface SideBySideOptions {
  /** Options for the text comparison the marks come from. */
  compare?: CompareTextOptions;
  /** Space between the two pages, in points. Default 20. */
  gap?: number;
  /** `'annotations'` (the default) marks each change with a highlight
   *  annotation whose note says what was deleted or inserted; `'content'`
   *  draws translucent boxes into the page instead, which every viewer and
   *  printer shows but which carry no note. */
  marks?: 'annotations' | 'content';
  /** RGB 0..1 for deletions. Default a light red. */
  deleteColor?: [number, number, number];
  /** RGB 0..1 for insertions. Default a light green. */
  insertColor?: [number, number, number];
  /** Write a structure tree: both documents' structure (each clone resolving
   *  to its own half of every sheet), every mark as an `/Annot` element whose
   *  alternate text says what changed, in a `Changes` section after them, and
   *  drawn marks as artifacts. A source that is not tagged contributes no
   *  structure, and its half stays untagged. Default false. */
  tagged?: boolean;
}

export interface SideBySideResult {
  /** A new document, one sheet per page pair. Neither input is changed. */
  document: Document;
  /** The comparison the marks were drawn from. */
  comparison: TextComparison;
}

/** One half of a sheet: a source page, its offset on the sheet, and the whole
 *  source-user-space -> sheet transform (the page's own import /Matrix, then
 *  the offset), which is what its marks move by. */
interface Half { page: Page; dx: number; dy: number; matrix: Matrix }
export interface SheetPlan { width: number; height: number; left?: Half; right?: Half }
export interface SideBySidePlan {
  comparison: TextComparison;
  sheets: SheetPlan[];
  marks: 'annotations' | 'content';
  deleteColor: [number, number, number];
  insertColor: [number, number, number];
  tagged: boolean;
}

const DEFAULT_DELETE: [number, number, number] = [1, 0.55, 0.55];
const DEFAULT_INSERT: [number, number, number] = [0.45, 0.85, 0.45];
const MARK_OPACITY = 0.4;

/** Validate, compare and lay out. Allocates nothing. */
export function planSideBySide(a: Document, b: Document, opts: SideBySideOptions = {}): SideBySidePlan {
  const gap = opts.gap ?? 20;
  if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0) throw new RangeError('CompareSideBySide: gap must be a finite number >= 0');
  const marks = opts.marks ?? 'annotations';
  if (marks !== 'annotations' && marks !== 'content') throw new RangeError("CompareSideBySide: marks must be 'annotations' or 'content'");
  const deleteColor = color('deleteColor', opts.deleteColor, DEFAULT_DELETE);
  const insertColor = color('insertColor', opts.insertColor, DEFAULT_INSERT);
  if (opts.tagged !== undefined && typeof opts.tagged !== 'boolean') throw new TypeError('CompareSideBySide: tagged must be a boolean');
  const tagged = opts.tagged === true;
  const comparison = compareText(a, b, opts.compare);
  const n = Math.max(a.Pages.length, b.Pages.length);
  if (n === 0) throw new RangeError('CompareSideBySide: neither document has a page');

  const sheets: SheetPlan[] = [];
  for (let i = 0; i < n; i++) {
    const pa = a.Pages[i], pb = b.Pages[i];
    const sa = pa ? upright(pa) : undefined, sb = pb ? upright(pb) : undefined;
    // A missing half takes the other half's size, so the present page keeps
    // its own side and the sheet keeps its shape.
    const [wl, hl] = sa ?? sb!;
    const [wr, hr] = sb ?? sa!;
    const height = Math.max(hl, hr);
    const width = wl + gap + wr;
    const at = (p: Page, dx: number, h: number): Half => {
      const dy = height - h; // tops aligned
      return { page: p, dx, dy, matrix: mul(importMatrix(p.Rotate, p.CropBox), [1, 0, 0, 1, dx, dy]) };
    };
    sheets.push({
      width, height,
      left: pa ? at(pa, 0, hl) : undefined,
      right: pb ? at(pb, wl + gap, hr) : undefined,
    });
  }
  return { comparison, sheets, marks, deleteColor, insertColor, tagged };
}

/** Draw a plan onto the sheets `out` allocated for it, one per plan entry. */
export function renderSideBySide(out: Document, plan: SideBySidePlan): void {
  // Identities for preserveStructure's grouping: the halves are cloned apart
  // even when both are one document compared with itself.
  const LEFT = {}, RIGHT = {};
  const origins: PageOrigin[] = [];
  plan.sheets.forEach((s, i) => {
    const sheet = out.Pages[i];
    const sheetNum = out.pageRef(i + 1).num;
    let offset = 0;
    for (const [half, group] of [[s.left, LEFT], [s.right, RIGHT]] as const) {
      if (!half) continue;
      const form = place(out, sheet, half);
      if (!plan.tagged) continue;
      if (group === RIGHT && offset > 0) shiftMcids(out, form, offset);
      if (group === LEFT) offset = maxMcid(out, form) + 1;
      const src = half.page.Document;
      origins.push({ srcDoc: src, srcPageNum: src.pageRef(half.page.Number).num, newPageNum: sheetNum, mcidOffset: group === RIGHT ? offset : 0, group });
    }
  });
  const marksMade: { annot: Annotation; note: string }[] = [];
  if (plan.tagged) {
    preserveStructure(out, origins);
    const lang = plan.sheets.find((s) => s.left)?.left?.page.Document.Lang;
    if (lang) out.Lang = lang;
  }
  type Mark = { rect: Rect; spans: Rect[]; text: string };
  const perSheet: { del: Mark[]; ins: Mark[] }[] = plan.sheets.map(() => ({ del: [], ins: [] }));
  const collect = (spans: TextSpan[], side: 'left' | 'right', into: 'del' | 'ins'): void => {
    for (const sp of spans) {
      const half = plan.sheets[sp.page - 1]?.[side];
      if (!half) continue;
      const rects = sp.quads.map((q) => moveRect(q, half.matrix));
      perSheet[sp.page - 1][into].push({ rect: union(rects), spans: rects, text: sp.text });
    }
  };
  for (const c of plan.comparison.changes) {
    if (c.op === 'delete') collect(c.old, 'left', 'del');
    else if (c.op === 'insert') collect(c.new, 'right', 'ins');
  }
  perSheet.forEach((m, i) => {
    const sheet = out.Pages[i];
    if (plan.marks === 'annotations') {
      const note = (kind: string, t: string): string => `${kind}: ${t.replace(/\s+/g, ' ')}`;
      for (const d of m.del) {
        const t = note('Deleted', d.text);
        marksMade.push({ annot: sheet.AddHighlight({ quads: d.spans.flatMap(rectToQuad), color: plan.deleteColor, contents: t }), note: t });
      }
      for (const d of m.ins) {
        const t = note('Inserted', d.text);
        marksMade.push({ annot: sheet.AddHighlight({ quads: d.spans.flatMap(rectToQuad), color: plan.insertColor, contents: t }), note: t });
      }
      return;
    }
    if (m.del.length + m.ins.length === 0) return;
    const g = new PageGraphics(out, sheet);
    if (plan.tagged) g.BeginArtifact(); // a box restates what the text already says
    g.setOpacity(MARK_OPACITY);
    for (const [list, col] of [[m.del, plan.deleteColor], [m.ins, plan.insertColor]] as const) {
      if (list.length === 0) continue;
      g.setFillColor(col);
      for (const d of list) for (const r of d.spans) g.drawRect(r[0], r[1], r[2] - r[0], r[3] - r[1]).fill();
    }
    if (plan.tagged) g.EndMarkedContent();
    g.apply();
  });
  if (plan.tagged && marksMade.length > 0) {
    const root = out.GetStructTree() ?? out.CreateStructTree();
    const sect = root.Append('Sect', { title: 'Changes' });
    for (const { annot, note } of marksMade) tagAnnotation(out, sect.Append('Annot', { alt: note }), annot);
  }
}

/** Every content stream a placed page draws with: the form itself and each
 *  nested form, once. Marked content inside a nested form belongs to the page
 *  that draws it, so its MCIDs share the page's space. */
function* formStreams(doc: Document, num: number, seen = new Set<number>()): Generator<{ num: number; st: PdfStream }> {
  if (seen.has(num)) return;
  seen.add(num);
  const st = doc.getObject(num);
  if (!isStream(st)) return;
  yield { num, st };
  const res = doc.resolve(st.dict.get('Resources'));
  const xobjs = isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
  if (!isDict(xobjs)) return;
  for (const v of xobjs.values()) {
    // A stream is always indirect, so a nested form is always a ref.
    const x = isRef(v) ? doc.getObject(v.num) : undefined;
    const sub = isStream(x) ? x.dict.get('Subtype') : undefined;
    if (isRef(v) && isName(sub) && sub.name === 'Form') yield* formStreams(doc, v.num, seen);
  }
}

/** The property list a BDC's operand names: inline, or through /Properties. */
function propsOf(doc: Document, stream: PdfStream, op: ContentOp): PdfDict | undefined {
  const operand: PdfObject | undefined = op.operands[1];
  if (isDict(operand)) return operand;
  if (!isName(operand)) return undefined;
  const res = doc.resolve(stream.dict.get('Resources'));
  const props = isDict(res) ? doc.resolve(res.get('Properties')) : undefined;
  const d = isDict(props) ? doc.resolve(props.get(operand.name)) : undefined;
  return isDict(d) ? d : undefined;
}

/** The highest MCID a placed page marks, or -1. */
function maxMcid(doc: Document, form: number): number {
  let max = -1;
  for (const { st } of formStreams(doc, form)) {
    for (const op of parseContentStream(decodeStream(st))) {
      if (op.operator !== 'BDC') continue;
      const m = doc.resolve(propsOf(doc, st, op)?.get('MCID'));
      if (typeof m === 'number' && m > max) max = m;
    }
  }
  return max;
}

/** Add `offset` to every MCID a placed page marks. Its streams and resources
 *  are this sheet's own copies (`importPageAsXObject` deep-copies them), so
 *  nothing outside the placed page moves. A named property list is shifted
 *  ONCE however many BDCs name it. */
function shiftMcids(doc: Document, form: number, offset: number): void {
  const shifted = new Set<PdfDict>();
  for (const { num, st } of formStreams(doc, form)) {
    const ops = parseContentStream(decodeStream(st));
    let rewrite = false;
    for (const op of ops) {
      if (op.operator !== 'BDC') continue;
      const props = propsOf(doc, st, op);
      if (!props || shifted.has(props)) continue;
      const m = doc.resolve(props.get('MCID'));
      if (typeof m !== 'number') continue;
      props.set('MCID', m + offset);
      shifted.add(props);
      if (isDict(op.operands[1])) rewrite = true; // inline: lives in the stream bytes
    }
    if (!rewrite) continue;
    // Stream bytes are read-only, so the rewritten stream replaces the object
    // under its own number; the decoded bytes carry no filter any more.
    const dict: PdfDict = new Map(st.dict);
    for (const k of ['Filter', 'DecodeParms', 'DL', 'Length']) dict.delete(k);
    doc.replaceObject(num, { kind: 'stream', dict, raw: serializeContentStream(ops) });
  }
}

/** Place a page on the sheet; returns the placed form's object number. */
function place(out: Document, sheet: Page, half: Half): number {
  const ref = importPageAsXObject(out, half.page);
  const res = ensureOwnResources(out, sheet);
  const xobjs = ensureOwnSubdict(out, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, ref);
  // The form's own /Matrix is importMatrix already, so the placement is the
  // sheet offset alone: the two together are `half.matrix`.
  appendContent(out, sheet, enc(`q\n1 0 0 1 ${num(half.dx)} ${num(half.dy)} cm\n/${key} Do\nQ`));
  return ref.num;
}

function moveRect(q: Rect, m: Matrix): Rect {
  const pts = [apply(m, q[0], q[1]), apply(m, q[2], q[1]), apply(m, q[0], q[3]), apply(m, q[2], q[3])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function union(rs: Rect[]): Rect {
  return [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
}

/** A page's size as it is SHOWN: the CropBox, turned by `/Rotate`. */
function upright(p: Page): [number, number] {
  const [x0, y0, x1, y1] = p.CropBox;
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  return p.Rotate === 90 || p.Rotate === 270 ? [h, w] : [w, h];
}

function color(name: string, v: unknown, dflt: [number, number, number]): [number, number, number] {
  if (v === undefined) return dflt;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)) {
    throw new TypeError(`CompareSideBySide: ${name} must be [r, g, b] with each 0..1`);
  }
  return v as [number, number, number];
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4);
}
