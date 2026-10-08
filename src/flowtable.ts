/** The table Flow element.
 *
 *  `page.AddTable` is page-positioned: its pagination loop reads the anchor
 *  page's CropBox and appends pages itself. A flow element is handed a rect and
 *  must report an overflow, so the two pagination models cannot be one function
 *  — but the PAINTING can be, and is (`paintRowSlice`).
 *
 *  Nothing here re-derives a table: TableBuilder already owns row measurement,
 *  the `continuationFrom` remainder and repeating headers. */

import { reportTableCoverage, resolveCellStyle, type TableBuilder, type BorderInfo } from './tableauthor.js';
import { lowerNotes, refsIn, citesNote, rebaseForMarks, type NoteRef, type FlowTextRun } from './flownotes.js';
import type { Undrawable } from './textcoverage.js';
import { paintRowSlice } from './tablerender.js';
import type { SpanGrid } from './tablespan.js';
import { TableTagger } from './tabletag.js';
import {
  nonNegative, normalizeClear, normalizeSpacing,
  type FlowClear, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';

/** Options for {@link table} / `Flow.AddTable`. Lengths in points. */
export interface FlowTableOptions {
  /** Total table width. > 0. Default: the full column width. */
  width?: number;
  /** Table-level cell padding override, as `page.AddTable`'s. >= 0. */
  cellPadding?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  clear?: FlowClear;
  /** Called for each cell whose resolved face cannot draw some or all of
   *  its text. Opt-in; a caller who passes nothing gets the previous silence.
   *  Fires once per cell, before the table is placed. */
  onUndrawable?: (u: Undrawable) => void;
}

/** Tolerance so a column exactly N rows tall takes N rows despite float drift,
 *  as layout.ts does for lines. */
const EPS = 1e-9;

/** @internal The element behind {@link table}.
 *
 *  Notes in cells (v9j3.3.3): the references it reports are those of the rows
 *  it keeps — a table splits by row only and a row is atomic, so more budget
 *  keeps a superset and `settleBudget`'s bisection holds; a kept reference's
 *  owner is its cell's /TD or /TH; and a continuation's leading repeated
 *  header rows (`echo`) report none, the first slice having committed them,
 *  while their marks still draw. */
class TableElement implements FlowElement {
  /** The lowered builder, made on FIRST USE — `Render`'s numbering pass — so
   *  rows added to the caller's builder after `AddTable` still render, cited
   *  or not, exactly as a note-free table shares the builder live. Lowering a
   *  lowered builder returns it as it is, so a continuation passes through. */
  private lowered?: TableBuilder;
  private get t(): TableBuilder { return this.lowered ??= lowerTableNotes(this.source); }

  constructor(
    private readonly source: TableBuilder,
    private readonly o: FlowTableOptions,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
    /** Carried across a split so a paginated table stays ONE /Table. */
    private tagger?: TableTagger,
    /** Leading rows that REPEAT the header on a continuation: their references
     *  were committed by the first slice, so they are left out here while
     *  their marks still draw (v9j3.3.3). */
    private readonly echo = 0,
  ) {}

  /** References in rows [echo, to), row-major, in run order. */
  private refsTo(to: number): NoteRef[] {
    const out: NoteRef[] = [];
    for (let i = this.echo; i < to; i++)
      for (const c of this.t.rows[i].cells) if (typeof c.text !== 'string') out.push(...refsIn(c.text));
    return out;
  }

  noteRefs(): NoteRef[] { return this.refsTo(this.t.rows.length); }

  /** How many leading rows fit in `availHeight`, and their height. */
  private fit(
    rowHeights: number[], availHeight: number, safeBreak: boolean[],
  ): { rows: number; height: number } {
    let rows = 0;
    let height = 0;
    for (const h of rowHeights) {
      if (height + h > availHeight + EPS) break;
      height += h;
      rows++;
    }
    // A rowSpan group is atomic: back off to a legal cut. Reaching 0 returns
    // the existing "not one row fits, retry in the next column" result, and the
    // engine's "does not fit in an empty column" error then covers a group
    // taller than a whole column — exactly the atomic-element rule an oversized
    // image already meets.
    while (rows > 0 && !safeBreak[rows]) {
      rows--;
      height -= rowHeights[rows];
    }
    return { rows, height };
  }

  /** Column widths, per-row heights and the grid they were measured against,
   *  for a column of `width` points. */
  private metrics(width: number): { widths: number[]; rowHeights: number[]; grid: SpanGrid } {
    const widths = this.t.resolveColumnWidths(
      this.o.width ?? width, { cellPadding: this.o.cellPadding });
    // An empty table returns before anything reads the grid.
    if (widths.length === 0)
      return { widths, rowHeights: [], grid: { placements: [], columnCount: 0, safeBreak: [true] } };
    const m = this.t.measure(widths, { cellPadding: this.o.cellPadding });
    return { widths, rowHeights: m.rowHeights, grid: m.grid };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean; notes: NoteRef[] } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false, notes: [] };
    const { rowHeights, grid } = this.metrics(ctx.width);
    const { rows, height } = this.fit(rowHeights, ctx.availHeight, grid.safeBreak);
    return { usedHeight: height, fits: rows === this.t.rows.length && rows > 0, notes: this.refsTo(rows) };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const { widths, rowHeights, grid } = this.metrics(ctx.width);
    if (widths.length === 0) return { usedHeight: 0, remainder: null, drew: false };
    const { rows, height } = this.fit(rowHeights, ctx.availHeight, grid.safeBreak);
    // Not one row fits: retry in the next column. The engine throws if that
    // happens at the start of an EMPTY column, exactly as for an oversized image.
    if (rows === 0) return { usedHeight: 0, remainder: this, drew: false };

    // Built on the first PAINTED slice, so a tagged flow whose table never draws
    // bootstraps no structure tree — drawTable's rule, for the same reason.
    if (ctx.structParent !== undefined && this.tagger === undefined)
      this.tagger = new TableTagger(ctx.doc, { structParent: ctx.structParent });

    const columnX: number[] = [ctx.x];
    for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);

    const indices = Array.from({ length: rows }, (_, i) => i);
    paintRowSlice(
      ctx.doc, ctx.page, this.t, indices, rowHeights, grid, columnX, widths,
      ctx.top, ctx.x, this.o.cellPadding,
      this.t.defaults.outerBorder as BorderInfo | undefined,
      ctx.structParent !== undefined, this.tagger);

    // A tagged note is created under the cell holding its reference.
    if (this.tagger !== undefined)
      for (let i = this.echo; i < rows; i++)
        for (const c of this.t.rows[i].cells) {
          const el = this.tagger.elementOf(c);
          if (el !== undefined && typeof c.text !== 'string') for (const r of refsIn(c.text)) r.owner = el;
        }

    if (rows === this.t.rows.length)
      return { usedHeight: height, remainder: null, drew: true };
    // continuationFrom prepends the repeating header rows on its own; the
    // continuation carries spaceBefore 0 (already started), the SAME tagger,
    // which is what keeps a split table one /Table, and the header rows it has
    // ALREADY PAINTED as its echo. `fit` may cut inside a multi-row header, and
    // a header row first painted on the continuation must still report its
    // notes (final review): counting the whole header block lost them.
    const next = this.t.continuationFrom(rows);
    const echo = Math.max(this.echo, Math.min(rows, next.repeatingRowCount));
    return {
      usedHeight: height,
      remainder: new TableElement(next, this.o, 0, this.spaceAfter, undefined, this.tagger, echo),
      drew: true,
    };
  }
}

/** `t` itself when no cell cites a note — the byte-identity argument, by
 *  construction — else a private copy whose cited run lists are lowered at
 *  the cell's cascaded size and whose atomics are rebased past the marks
 *  (v9j3.3.3). The caller's builder is never mutated, so the same builder
 *  passed to page.AddTable still meets resolveRuns' guard. */
function lowerTableNotes(t: TableBuilder): TableBuilder {
  if (!t.rows.some((r) => r.cells.some((c) => citesNote(c.text)))) return t;
  return t.mapCells((c, row) => {
    if (!citesNote(c.text)) return undefined;
    const runs = c.text as FlowTextRun[];
    const size = resolveCellStyle(c, row.style, t.defaults).fontSize;
    return { text: lowerNotes(runs, size) as FlowTextRun[], atomics: rebaseForMarks(runs, c.atomics) };
  });
}

/** Build a table element. The builder behind `Flow.AddTable`; use it to compose
 *  the `blocks` of a list item or the contents of a block quote.
 *
 *  The table splits by ROW across columns and pages, repeating whatever
 *  `setRepeatingRowsCount` names. A row taller than an empty column reaches the
 *  engine's "does not fit in an empty column" error, as any atomic element
 *  does. */
export function table(t: TableBuilder, o: FlowTableOptions = {}): FlowElement[] {
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  if (o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0))
    throw new TypeError('width must be a positive finite number');
  if (o.cellPadding !== undefined) nonNegative(o.cellPadding, 0, 'cellPadding');
  // Once, at BUILD time — never from measure(), which the engine runs
  // speculatively many times per table.
  if (o.onUndrawable !== undefined) reportTableCoverage(t, o.onUndrawable);
  // Lowered once here only to VALIDATE the cited runs at build time, as
  // paragraph() does; the element lowers again, lazily, on first use.
  lowerTableNotes(t);
  return [new TableElement(t, o, spaceBefore, spaceAfter, normalizeClear(o.clear))];
}
