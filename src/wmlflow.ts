/** A resolved WordprocessingML document (`readDocx`) to flow elements
 *  (`m2fp.5`) — the one implementation behind `flow.AddDocx`, `page.AddDocx` and
 *  `doc.AddDocx`. This module owns the MAPPING and nothing else: no columns,
 *  rects or pagination (`mdflow.ts`'s rule), no Document, no package. Fonts and
 *  image bytes arrive through `WmlFlowEnv`, which `wmlimport.ts` supplies.
 *
 *  **Invariant:** output is SEGMENTS split at page and column breaks, because a
 *  break is not a FlowElement — `Flow.AddColumnBreak` is a sentinel inside the
 *  flow — so each entry point decides what a break means for it.
 *
 *  **Invariant:** nothing here throws on document content; what does not map is
 *  a counted record in `skipped`. */
import type { WmlBlock, WmlParagraph, WmlInline, WmlTable } from './wmlbody.js';
import type { WmlDocument } from './wmlread.js';
import type { FlowElement } from './flowelement.js';
import type { ResolvedFamily } from './mdstyle.js';
import { paragraph, heading, image, list, type FlowParagraphOptions, type FlowListItem } from './flow.js';
import type { AuthoringFont } from './stamp.js';
import { coverageOf } from './textcoverage.js';
import { rethrowLimit } from './errors.js';
import { inlineContent, imageData, unitRgb, type RunCtx } from './wmlruns.js';
import { createTable } from './tableauthor.js';
import { table } from './flowtable.js';
import type { TextRun } from './textdecor.js';
import type { FlowAtomic } from './flow.js';

export interface DocxSkipped { name: string; count: number; kind: 'dropped' | 'degraded' }

export interface WmlFlowEnv {
  /** The four faces for a Word font name (undefined = Word's default), and whether
   *  the NAME resolved to a real face rather than a Standard-14 stand-in. */
  family(name: string | undefined): { family: ResolvedFamily; resolved: boolean };
  /** An image part's bytes and content type, or undefined. */
  image(part: string): { bytes: Uint8Array; contentType?: string } | undefined;
}

/** Constructs that draw NOTHING of what the document said; every other name is
 *  `degraded`, because readDocx keeps an unknown construct's text. */
const DROPPED = new Set([
  'w:headerReference', 'w:footerReference', 'w:footnoteReference', 'w:endnoteReference',
  'w:commentReference', 'w:del', 'w:moveFrom', 'w:fldChar (unterminated)',
  'a:blip (unresolved image)', 'a:blip (unreadable image)', 'w:drawing (not a picture)', 'text',
]);

export function kindOf(name: string): 'dropped' | 'degraded' {
  return DROPPED.has(name) || name.startsWith('image:') ? 'dropped' : 'degraded';
}

export class SkipLog {
  private readonly counts = new Map<string, DocxSkipped>();
  add(name: string, kind: 'dropped' | 'degraded' = kindOf(name), n = 1): void {
    const key = `${kind}\u0000${name}`;
    const hit = this.counts.get(key);
    if (hit) hit.count += n; else this.counts.set(key, { name, count: n, kind });
  }
  /** Sorted by name, then kind; a fresh array of fresh records. */
  list(): DocxSkipped[] {
    return [...this.counts.values()].map((s) => ({ ...s }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
}

export function mergeSkipped(...lists: DocxSkipped[][]): DocxSkipped[] {
  const log = new SkipLog();
  for (const l of lists) for (const s of l) log.add(s.name, s.kind, s.count);
  return log.list();
}

interface Ctx extends RunCtx {
  width: number;
  segments: FlowElement[][];
  /** Space an empty paragraph left, added to the next element's spaceBefore. */
  gap: number;
  /** The space-after standing above the next element (0 at a segment start). */
  prevAfter: number;
}

const cur = (c: Ctx): FlowElement[] => c.segments[c.segments.length - 1];

/** A paragraph's inlines split at page/column breaks: a new segment starts after each. */
function splitAtBreaks(inlines: WmlInline[]): WmlInline[][] {
  const parts: WmlInline[][] = [[]];
  for (const i of inlines) {
    if (i.kind === 'break' && i.type !== 'line') parts.push([]);
    else parts[parts.length - 1].push(i);
  }
  return parts;
}

const DEFAULT_SIZE = 10;   // Word's size with nothing stated (m2fp.3)
const DEFAULT_FONT: AuthoringFont = 'Times-Roman';   // Word's face with nothing stated

type Content = ReturnType<typeof inlineContent>;
/** Which part of a paragraph split at page/column breaks this is: space-before
 *  belongs to the first part and space-after to the last. */
interface Part { first: boolean; last: boolean }

/** The line height Word's rule gives at this size: auto is a multiple of single
 *  spacing, exact is as stated, at-least never goes below single. */
function leadingOf(p: WmlParagraph, size: number): number {
  const single = size * 1.2;
  const line = p.props.line;
  const stated = line === undefined ? single
    : 'exactPt' in line ? line.exactPt
      : 'atLeastPt' in line ? Math.max(single, line.atLeastPt)
        : single * line.auto;
  // A stated height of zero (or junk) is a file's statement, not a caller's
  // mistake: the builders refuse it with TypeError, so it is never handed on.
  return Number.isFinite(stated) && stated > 0 ? stated : single;
}

/** A stated spacing, never negative or junk: the builders refuse one with
 *  TypeError, and a file's value must not become a caller's error. */
const space = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/** Word COLLAPSES adjacent spacing to max(after, before) where the engine ADDS
 *  spaceAfter + spaceBefore (test/spacing-oracle.test.ts), so what is emitted
 *  above an element is only what its space-before adds to the space-after
 *  already standing above it. */
function spaceAbove(before: number, c: Ctx): number {
  return Math.max(0, before - c.prevAfter);
}

/** A paragraph's flow options from Word's resolved properties. Shared with
 *  list items, which is why it takes the whole inline content. */
function paraOptions(p: WmlParagraph, content: Content, c: Ctx, part: Part): FlowParagraphOptions {
  const pp = p.props;
  const size = content.maxSize > 0 ? content.maxSize : DEFAULT_SIZE;
  const o: FlowParagraphOptions = {
    font: content.runs.find((x) => x.font)?.font,
    fontSize: size,
    leading: leadingOf(p, size),
    spaceBefore: c.gap + spaceAbove(part.first ? space(pp.spaceBeforePt) : 0, c),
    spaceAfter: part.last ? space(pp.spaceAfterPt) : 0,
    onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded'),
  };
  if (content.atomics.length > 0) o.atomics = content.atomics;
  if (pp.align) o.align = pp.align;
  const ind = pp.indent;
  if (ind) {
    let left = ind.leftPt ?? 0;
    let right = ind.rightPt ?? 0;
    if (left < 0 || right < 0) { c.log.add('w:ind (negative)', 'degraded'); left = Math.max(0, left); right = Math.max(0, right); }
    let firstLine = ind.hangingPt !== undefined ? -ind.hangingPt : ind.firstLinePt ?? 0;
    if (firstLine < -left) { c.log.add('w:ind (hanging past margin)', 'degraded'); firstLine = -left; }
    if (!part.first) firstLine = 0;
    if (left !== 0 || right !== 0 || firstLine !== 0) o.indent = { left, right, firstLine };
  }
  return o;
}

/** A paragraph that is ONE image and nothing else is a block figure at its
 *  extent, aligned as the paragraph is. False when the image cannot be drawn,
 *  so the paragraph still takes its (now empty) line. */
const meaningfulOf = (inlines: WmlInline[]): WmlInline[] =>
  inlines.filter((x) => !(x.kind === 'text' && x.text.trim() === ''));

/** Exactly one meaningful inline, and it is an image. */
const isLoneImage = (inlines: WmlInline[]): boolean => {
  const m = meaningfulOf(inlines);
  return m.length === 1 && m[0].kind === 'image';
};

function loneImage(p: WmlParagraph, inlines: WmlInline[], c: Ctx, part: Part): boolean {
  if (!isLoneImage(inlines)) return false;
  const img = meaningfulOf(inlines)[0] as Extract<WmlInline, { kind: 'image' }>;
  const data = imageData(img, c);
  if (!data) return false;
  const pp = p.props;
  const after = part.last ? space(pp.spaceAfterPt) : 0;
  try {
    const els = image(data, {
      width: img.widthPt > 0 ? img.widthPt : undefined, height: img.heightPt > 0 ? img.heightPt : undefined,
      alt: img.alt, align: pp.align === 'center' || pp.align === 'right' ? pp.align : 'left',
      spaceBefore: c.gap + spaceAbove(part.first ? space(pp.spaceBeforePt) : 0, c), spaceAfter: after,
    });
    cur(c).push(...els);
    c.gap = 0;
    c.prevAfter = after;
    return true;
  } catch (caught) { rethrowLimit(caught); c.log.add('image:undecodable', 'dropped'); return false; }
}

function paragraphElements(p: WmlParagraph, inlines: WmlInline[], c: Ctx, part: Part): void {
  if (loneImage(p, inlines, c, part)) return;
  // A lone image that could not be drawn was reported above: not again here.
  // Only ONE image is lone — two or more side by side are atomics on a line,
  // and filtering them out would lose every one with nothing said.
  const lone = isLoneImage(inlines);
  const content = inlineContent(lone ? inlines.filter((x) => x.kind !== 'image') : inlines, c);
  const o = paraOptions(p, content, c, part);
  // A numbered paragraph that is not a list item here — a numbered heading,
  // or one split by a page break — draws its label in front of its text.
  if (p.list && part.first) {
    const label = labelOf(p, o.font ?? DEFAULT_FONT, c);
    if (label !== '') {
      const lead = content.runs[0];
      content.runs.unshift({ text: `${label} `, font: lead?.font ?? o.font, fontSize: lead?.fontSize ?? o.fontSize });
      for (const a of content.atomics) a.beforeRun += 1;
    }
  }
  if (content.runs.every((x) => x.text.trim() === '') && content.atomics.length === 0) {
    // paragraph('') measures 0 and would vanish, where Word gives it a line:
    // the line and its own spacing ride on the next element's spaceBefore.
    c.gap = (o.spaceBefore ?? 0) + (o.leading ?? 0) + (o.spaceAfter ?? 0);
    c.prevAfter = o.spaceAfter ?? 0;
    return;
  }
  c.gap = 0;
  c.prevAfter = o.spaceAfter ?? 0;
  if (p.heading !== undefined) {
    if (p.heading > 6) c.log.add(`w:outlineLvl=${p.heading - 1}`, 'degraded');
    // The face and size are stated, so heading()'s own defaults never apply
    // on top of Word's (cssflow.ts's rule).
    cur(c).push(...heading(Math.min(p.heading, 6), content.runs,
      { ...o, font: o.font ?? DEFAULT_FONT, align: o.align === 'justify' ? 'left' : o.align }));
    return;
  }
  cur(c).push(...paragraph(content.runs, o));
}

const BULLET = '\u2022';

/** Word's own label for a numbered paragraph. A bullet is usually a private-use
 *  code point in Symbol or Wingdings, which the item's face cannot draw: it
 *  becomes U+2022 and is reported, rather than drawing nothing. */
function labelOf(p: WmlParagraph, font: AuthoringFont, c: Ctx): string {
  const l = p.list;
  if (l === undefined) return '';
  if (l.bullet && l.label !== '' && coverageOf(l.label, font, false) !== undefined) {
    c.log.add('w:lvlText (bullet glyph)', 'degraded');
    return BULLET;
  }
  return l.label;
}

function listItem(p: WmlParagraph, c: Ctx): FlowListItem {
  const content = inlineContent(p.inlines, c);
  const o = paraOptions(p, content, c, { first: true, last: true });
  c.gap = 0;
  c.prevAfter = o.spaceAfter ?? 0;
  const font = o.font ?? DEFAULT_FONT;
  const item: FlowListItem = {
    text: content.runs, label: labelOf(p, font, c), font, fontSize: o.fontSize, leading: o.leading,
    spaceBefore: o.spaceBefore, spaceAfter: o.spaceAfter,
  };
  if (content.atomics.length > 0) item.atomics = content.atomics;
  if (o.align) item.align = o.align;
  // Word's left indent is where the BODY starts; the label hangs before it.
  if (o.indent?.left) item.indent = o.indent.left;
  return item;
}

/** A run of consecutive list paragraphs as ONE list, nested by ilvl. The labels
 *  are Word's (readDocx counted them), never list()'s own counter — which is
 *  what lets a list interrupted by a paragraph resume at `3.`. A level deeper
 *  than its predecessor's child level nests under the last item there is: the
 *  engine cannot express a skipped level. */
function listElements(paras: WmlParagraph[], c: Ctx): void {
  const roots: FlowListItem[] = [];
  const stack: { ilvl: number; item: FlowListItem }[] = [];
  for (const p of paras) {
    const item = listItem(p, c);
    const ilvl = p.list?.ilvl ?? 0;
    while (stack.length > 0 && stack[stack.length - 1].ilvl >= ilvl) stack.pop();
    if (stack.length === 0) roots.push(item);
    else (stack[stack.length - 1].item.items ??= []).push(item);
    stack.push({ ilvl, item });
  }
  cur(c).push(...list(roots, {
    onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded'),
  }));
}

const GRID_BORDER = { width: 0.5, color: [0, 0, 0] as [number, number, number] };
const undrawable = (c: Ctx) => (u: { all: boolean }): void => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded');

/** A cell's content as runs: its paragraphs joined by line breaks, a nested
 *  table flattened cell by cell and reported (csstable.ts's rule — a cell
 *  takes runs, so block structure inside one cannot be represented, and losing
 *  the text instead would break the rule that what does not render still
 *  contributes what it has). */
function cellContent(blocks: WmlBlock[], c: Ctx): { runs: TextRun[]; atomics: FlowAtomic[]; align?: 'left' | 'center' | 'right' } {
  const runs: TextRun[] = [];
  const atomics: FlowAtomic[] = [];
  let align: 'left' | 'center' | 'right' | undefined;
  const addPara = (p: WmlParagraph): void => {
    const inl = p.inlines.filter((i) => !(i.kind === 'break' && i.type !== 'line'));
    if (inl.length !== p.inlines.length) c.log.add('w:br (page)', 'degraded', p.inlines.length - inl.length);
    const got = inlineContent(inl, c);
    const lead = got.runs[0];
    if (runs.length > 0) runs.push({ text: '\n', font: lead?.font, fontSize: lead?.fontSize });
    const label = labelOf(p, lead?.font ?? DEFAULT_FONT, c);
    if (label !== '') runs.push({ text: `${label} `, font: lead?.font, fontSize: lead?.fontSize });
    for (const a of got.atomics) atomics.push({ ...a, beforeRun: a.beforeRun + runs.length });
    runs.push(...got.runs);
    if (align === undefined && p.props.align && p.props.align !== 'justify') align = p.props.align;
  };
  const walk = (bs: WmlBlock[]): void => {
    for (const b of bs) {
      if (b.kind === 'paragraph') addPara(b);
      else { c.log.add('w:tbl (nested)', 'degraded'); for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks); }
    }
  };
  walk(blocks);
  return align === undefined ? { runs, atomics } : { runs, atomics, align };
}

/** A Word table as ONE flow table. Rows below a vertical merge OMIT the covered
 *  cell, as the authoring layer wants; the span is counted down the GRID
 *  column, never the cell index, since gridBefore and spans shift a row's cells. */
function tableElements(t: WmlTable, c: Ctx): void {
  for (const u of t.unmodelled) c.log.add(u, 'degraded');
  const tb = createTable({ border: GRID_BORDER, outerBorder: GRID_BORDER, font: DEFAULT_FONT, fontSize: DEFAULT_SIZE });

  // The grid column every cell starts at.
  const cols = t.rows.map((row) => {
    let col = row.gridBefore ?? 0;
    return row.cells.map((cell) => { const at = col; col += cell.span; return at; });
  });
  const width = (ri: number): number => {
    const row = t.rows[ri];
    return (row.gridBefore ?? 0) + row.cells.reduce((a, x) => a + x.span, 0) + (row.gridAfter ?? 0);
  };
  const columns = t.rows.reduce((a, _row, ri) => Math.max(a, width(ri)), 0);
  const total = t.gridPt.reduce((a, b) => a + b, 0);
  // The grid is trusted only when it describes the rows: a spec count that
  // disagrees with the column count is refused at PLACEMENT, past any report.
  // A grid wider than the column scales to it rather than overflowing the page.
  if (t.gridPt.length === columns && t.gridPt.every((g) => g > 0))
    tb.setColumnWidths(t.gridPt.map((g) => (total <= c.width ? { fixed: g } : { fraction: g / total })));
  else tb.autoFitColumns();

  const cellAt = (ri: number, col: number) => {
    const k = cols[ri]?.indexOf(col) ?? -1;
    return k < 0 ? undefined : t.rows[ri].cells[k];
  };
  // A continuation joins the merge only when it spans the SAME grid columns
  // (m2fp.10). One that spans differently cannot be one cell with the restart:
  // the covered slot would leave its extra columns unfilled, which shifts every
  // later cell of the row and THREW at placement once the row outgrew the grid.
  // It becomes its own cell, and the merge is reported as degraded.
  const continues = (ri: number, col: number, span: number): boolean => {
    const next = cellAt(ri, col);
    if (next?.vMerge !== 'continue') return false;
    if (next.span === span) return true;
    c.log.add('w:vMerge (span mismatch)', 'degraded');
    return false;
  };
  const covered = new Set<string>();
  let headers = 0;
  t.rows.forEach((row, ri) => {
    if (row.header && headers === ri) headers++;
    const rb = tb.addRow();
    if (row.gridBefore) rb.addCell('', { colSpan: row.gridBefore });
    row.cells.forEach((cell, k) => {
      const col = cols[ri][k];
      if (covered.has(`${ri}:${col}`)) return;
      let rowSpan = 1;
      // A continuation with nothing above it starts its own cell.
      if (cell.vMerge !== undefined) {
        while (continues(ri + rowSpan, col, cell.span)) { covered.add(`${ri + rowSpan}:${col}`); rowSpan++; }
      }
      const content = cellContent(cell.blocks, c);
      const bare = content.runs.length === 0 && content.atomics.length === 0;
      rb.addCell(bare ? '' : content.runs, {
        colSpan: cell.span, rowSpan,
        ...(content.align ? { align: content.align } : {}),
        ...(cell.shading ? { background: unitRgb(cell.shading) } : {}),
        ...(content.atomics.length > 0 ? { atomics: content.atomics } : {}),
      });
    });
    if (row.gridAfter) rb.addCell('', { colSpan: row.gridAfter });
  });
  if (t.rows.length === 0) return;
  if (headers > 0) tb.setRepeatingRowsCount(headers);
  cur(c).push(...table(tb, {
    ...(t.gridPt.length === columns && total > 0 && total <= c.width ? { width: total } : {}),
    spaceBefore: c.gap, onUndrawable: undrawable(c),
  }));
  c.gap = 0;
  // A table does NOT collapse spacing: Word applies the space-after above it
  // and the space-before below it each in full (m2fp.10, measured through Word
  // COM — test/table-spacing-oracle.test.ts). So nothing is carried past it.
  c.prevAfter = 0;
}

/** A list ITEM: numbered, not a heading (a numbered heading stays a heading),
 *  and holding no page or column break, which the paragraph path splits at. */
const isListItem = (b: WmlBlock): boolean => b.kind === 'paragraph' && b.list !== undefined
  && b.heading === undefined && !b.inlines.some((i) => i.kind === 'break' && i.type !== 'line');

function blockElements(blocks: WmlBlock[], c: Ctx): void {
  for (let n = 0; n < blocks.length; n++) {
    const b = blocks[n];
    if (isListItem(b)) {
      const run: WmlParagraph[] = [];
      while (n < blocks.length && isListItem(blocks[n])) run.push(blocks[n++] as WmlParagraph);
      n--;
      listElements(run, c);
      continue;
    }
    if (b.kind === 'table') { tableElements(b, c); continue; }
    if (b.kind === 'paragraph') {
      const parts = splitAtBreaks(b.inlines);
      parts.forEach((inl, k) => {
        if (k > 0) { c.segments.push([]); c.gap = 0; c.prevAfter = 0; }
        paragraphElements(b, inl, c, { first: k === 0, last: k === parts.length - 1 });
      });
    }
  }
}

export function wmlElements(doc: WmlDocument, width: number, env: WmlFlowEnv): { segments: FlowElement[][]; skipped: DocxSkipped[] } {
  const log = new SkipLog();
  for (const u of doc.unsupported) log.add(u.name, kindOf(u.name), u.count);
  const c: Ctx = { env, log, width, segments: [[]], gap: 0, prevAfter: 0 };
  blockElements(doc.blocks, c);
  return { segments: c.segments, skipped: log.list() };
}
