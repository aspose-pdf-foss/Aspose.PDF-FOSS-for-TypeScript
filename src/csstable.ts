/** A CSS table box to a TableBuilder.
 *
 *  Invariant: a PURE LEAF. It imports cssbox.js, cssprop.js and textdecor.js
 *  for TYPES, cssvalue.js for `fixedPx`, tableauthor.js for the builder and
 *  bordersides.js for the edge flags, and nothing else — no Document, no PDF
 *  object module, no `node:` import. `createTable` is document-free, which is
 *  what lets every rule here be tested from a hand-built box tree.
 *
 *  Invariant: the px -> pt conversion is INJECTED, never computed here.
 *  CLAUDE.md records that the x 0.75 crosses in cssflow.ts and nowhere else;
 *  a second site is a second thing to get wrong. `scaleRuns` is injected for
 *  the same reason — cssinline.ts emits every TextRun.fontSize in px.
 *
 *  Invariant: NEVER throws. A table it cannot build is `null`, and every
 *  number handed to the authoring layer is guarded first — `addCell` validates
 *  `fontSize` as strictly positive, and a CSS `font-size: 0` is a perfectly
 *  legal declaration whose throw must not escape a mapper whose whole contract
 *  is that damage is a value. */

import type { BoxNode, TableBox, TableCellBox } from './cssbox.js';
import type { ComputedStyle } from './cssprop.js';
import type { TextRun } from './textdecor.js';
import { fixedPx } from './cssvalue.js';
import { createTable } from './tableauthor.js';
import type { BorderInfo, CellOptions, TableBuilder } from './tableauthor.js';
import type { BorderSides } from './bordersides.js';
import type { NotRendered } from './htmlreport.js';

export interface TableMapCtx {
  toPt: (px: number) => number;
  scaleRuns: (runs: TextRun[]) => TextRun[];
  skipped: NotRendered[];
}

const rgb = (c: ComputedStyle['color']): [number, number, number] => [c.rgb[0], c.rgb[1], c.rgb[2]];

/** Every run a box subtree contributes, in order, with a hard break between
 *  sibling blocks.
 *
 *  A cell holding block content FLATTENS: TableBuilder.addCell takes
 *  `string | TextRun[]`, so a cell containing a <p> and a <ul> cannot be
 *  represented. Extending the authoring layer to accept FlowElement[] would
 *  change tableauthor.ts, tablerender.ts and flowtable.ts together and is its
 *  own issue; losing the text instead would break the rule that a construct
 *  which does not render still contributes what it has.
 *
 *  The break matters: `<td><p>alpha</p><p>beta</p></td>` reads `alphabeta`
 *  without it, which is not a degraded rendering but a wrong word. addCell
 *  already splits a cell's text on a newline, so this costs no new vocabulary. */
function flattenRuns(
  content: TableCellBox['content'], out: TextRun[], c: TableMapCtx,
): void {
  if (content.kind === 'inline') { out.push(...content.runs); return; }
  for (const child of content.children) {
    if (out.length > 0) out.push({ ...out[out.length - 1], text: '\n' });
    collectBox(child, out, c);
  }
}

function collectBox(b: BoxNode, out: TextRun[], c: TableMapCtx): void {
  if (b.kind === 'table') {
    // A nested table cannot BE a cell — addCell takes `string | TextRun[]` —
    // so its cells' text flattens into the outer cell rather than being lost.
    // It WAS lost from zch2.6 until zch2.7, which is a regression against
    // this epic's own rule that a construct we cannot render still
    // contributes what it has.
    c.skipped.push({ el: b.el, kind: 'degraded', construct: 'table' });
    for (const row of b.rows) {
      for (const cell of row.cells) {
        if (out.length > 0) out.push({ ...out[out.length - 1], text: '\n' });
        flattenRuns(cell.content, out, c);
      }
    }
    return;
  }
  flattenRuns(b.content, out, c);
}

/** The painted edges of a CSS border box.
 *
 *  A border edge's USED width is 0 when its style is `none` or `hidden`
 *  (CSS 2.1 §8.5.3) — the rule cssresolve.ts records, and it matters here for
 *  the same reason: the initial border-style is `none` while the initial
 *  border-width is `medium`, so every cell that states no border carries a
 *  computed 3px per edge and would otherwise be drawn boxed. */
function borderOf(s: ComputedStyle, toPt: (px: number) => number): BorderInfo | undefined {
  const edges = [
    { on: s.borderTopStyle, w: s.borderTopWidth, c: s.borderTopColor },
    { on: s.borderRightStyle, w: s.borderRightWidth, c: s.borderRightColor },
    { on: s.borderBottomStyle, w: s.borderBottomWidth, c: s.borderBottomColor },
    { on: s.borderLeftStyle, w: s.borderLeftWidth, c: s.borderLeftColor },
  ].map((e) => ({ ...e, painted: e.on !== 'none' && e.on !== 'hidden' && e.w > 0 }));

  const first = edges.find((e) => e.painted);
  if (first === undefined) return undefined;

  // BorderInfo carries ONE width and ONE colour plus per-edge flags, so four
  // edges that differ collapse to the first painted one. A limitation of the
  // authoring type rather than a dropped construct, so it is documented
  // rather than reported per cell.
  const sides: BorderSides = edges.every((e) => e.painted)
    ? 'all'
    : {
      top: edges[0].painted, right: edges[1].painted,
      bottom: edges[2].painted, left: edges[3].painted,
    };
  const width = toPt(first.w);
  return width > 0 ? { width, color: rgb(first.c), sides } : undefined;
}

const ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  left: 'left', right: 'right', center: 'center', start: 'left', end: 'right',
  justify: 'left',
};

/** A size the authoring layer will accept, or undefined for its own default.
 *  `checkPos` rejects 0 and CSS admits `font-size: 0`. */
function positive(n: number): number | undefined {
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Baseline-to-baseline distance in POINTS, or undefined for the builder's own
 *  1.2x default. A NUMBER line-height multiplies the element's own font size;
 *  a px one is already absolute. cssflow.ts's `leadingOf` reads the same two
 *  shapes — it cannot be shared, because that module imports this one. */
function leadingOf(s: ComputedStyle, toPt: (px: number) => number): number | undefined {
  if (s.lineHeight === 'normal') return undefined;
  const px = 'number' in s.lineHeight ? s.lineHeight.number * s.fontSize : s.lineHeight.px;
  return positive(toPt(px));
}

/** Build a TableBuilder, or null when there is nothing to build. */
export function buildTable(box: TableBox, c: TableMapCtx): TableBuilder | null {
  if (box.rows.length === 0) return null;

  const s = box.style;
  // Only `outerBorder`. TableDefaults' `border` is the per-CELL default, so
  // seeding it from the table's own border would draw a grid where CSS draws
  // one frame — `table { border: 1px }` says nothing about `td`.
  const t = createTable({
    fontSize: positive(c.toPt(s.fontSize)),
    leading: leadingOf(s, c.toPt),
    color: rgb(s.color),
    outerBorder: borderOf(s, c.toPt),
  });

  // The LEADING run of header rows is what setRepeatingRowsCount can express;
  // a header row anywhere else gets an explicit header instead, because the
  // repeating-header default cannot reach it.
  let leadingHeaders = 0;
  while (leadingHeaders < box.rows.length
    && box.rows[leadingHeaders].cells.length > 0
    && box.rows[leadingHeaders].cells.every((x) => x.header)) leadingHeaders += 1;

  let reportedBlocks = false;
  box.rows.forEach((row, ri) => {
    const bg = row.style.backgroundColor;
    const r = t.addRow(undefined, bg.a > 0 ? { background: rgb(bg) } : {});
    for (const cell of row.cells) {
      const runs: TextRun[] = [];
      flattenRuns(cell.content, runs, c);
      if (cell.content.kind === 'blocks' && !reportedBlocks) {
        c.skipped.push({
          el: cell.el, kind: 'degraded', construct: 'table-cell-blocks',
        });
        reportedBlocks = true;
      }
      const cs = cell.style;
      const opts: CellOptions = {
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        align: ALIGN[cs.textAlign] ?? 'left',
        color: rgb(cs.color),
        // A percentage padding resolves against a containing block a table
        // cell does not have here, so it reads as 0 — the same refusal
        // cssresolve.ts already makes for a percentage height.
        padding: Math.max(0, c.toPt(fixedPx(cs.paddingTop) ?? 0)),
      };
      const fontSize = positive(c.toPt(cs.fontSize));
      if (fontSize !== undefined) opts.fontSize = fontSize;
      const cellBorder = borderOf(cs, c.toPt);
      if (cellBorder !== undefined) opts.border = cellBorder;
      if (cs.backgroundColor.a > 0) opts.background = rgb(cs.backgroundColor);
      // Only outside the repeating block, where the default cannot reach.
      if (cell.header && ri >= leadingHeaders) opts.header = 'column';
      r.addCell(c.scaleRuns(runs), opts);
    }
  });

  if (leadingHeaders > 0) t.setRepeatingRowsCount(leadingHeaders);
  // CSS column widths are a follow-up: mixing stated and auto columns is what
  // resolveColumnWidths's ColumnWidth specs are for, and guessing silently
  // mis-sizes every column rather than failing.
  t.autoFitColumns();
  return t;
}
