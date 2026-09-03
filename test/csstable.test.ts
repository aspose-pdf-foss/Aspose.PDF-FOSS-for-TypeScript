import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { buildTable } from '../src/csstable.js';
import type { BoxNode, TableBox } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import type { TextRun } from '../src/textdecor.js';
import type { NotRendered } from '../src/htmlreport.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

const PT_PER_PX = 0.75;
const ctx = () => ({
  toPt: (px: number) => px * PT_PER_PX,
  scaleRuns: (runs: TextRun[]) => runs.map(
    (r) => (r.fontSize === undefined ? r : { ...r, fontSize: r.fontSize * PT_PER_PX })),
  skipped: [] as NotRendered[],
});

function tableOf(src: string): TableBox {
  const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
  const seek = (bs: BoxNode[]): TableBox | undefined => {
    for (const b of bs) {
      if (b.kind === 'table') return b;
      if (b.content.kind === 'blocks') {
        const hit = seek(b.content.children);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const t = seek(boxes);
  if (t === undefined) throw new Error('no table box');
  return t;
}

/** The built table's grid, via the builder's own public shape. */
const build = (src: string, c = ctx()) => ({ t: buildTable(tableOf(src), c), c });

describe('buildTable', () => {
  it('builds a row per row and a cell per cell', () => {
    const { t } = build('<table><tr><td>a</td><td>b</td></tr>'
      + '<tr><td>c</td><td>d</td></tr></table>');
    expect(t).not.toBeNull();
    expect(t!.rows.length).toBe(2);
    expect(t!.rows[0].cells.length).toBe(2);
  });

  it('returns null for a table with no rows', () => {
    // TableBuilder has no meaning with an empty grid and flowtable.ts would
    // index grid[0].
    expect(build('<table></table>').t).toBeNull();
  });

  it('carries colSpan through to the cell', () => {
    const { t } = build('<table><tr><td colspan=2>a</td></tr>'
      + '<tr><td>b</td><td>c</td></tr></table>');
    expect(t!.rows[0].cells[0].colSpan).toBe(2);
    expect(t!.rows[1].cells[0].colSpan).toBe(1);
  });

  it('repeats the LEADING header rows rather than setting header per cell', () => {
    // CellOptions.header already defaults to "cells in the repeating-header
    // rows are column headers", so stating both would be two statements that
    // can drift — mdflow.ts records the same rule. Hence the header is
    // UNDEFINED on a leading header cell: the default already says it.
    const { t } = build('<table><thead><tr><th>h</th></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t!.repeatingRowCount).toBe(1);
    expect(t!.rows[0].cells[0].header).toBeUndefined();
  });

  it('repeats a thead whose cells are td, not th', () => {
    // A <thead> is the header section whatever its cells are called, and
    // repeating it atop each page is what the element is for.
    const { t } = build('<table><thead><tr><td>h</td></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t!.repeatingRowCount).toBe(1);
  });

  it('does NOT repeat rows when the header is not leading', () => {
    // A tfoot's th cannot be reached by the repeating-header default, so it
    // gets an EXPLICIT header instead and nothing repeats.
    const { t } = build('<table><tbody><tr><td>b</td></tr></tbody>'
      + '<tfoot><tr><th>f</th></tr></tfoot></table>');
    expect(t!.repeatingRowCount).toBe(0);
    expect(t!.rows[1].cells[0].header).toBe('column');
  });

  it('flattens a cell holding BLOCK content and reports it', () => {
    const { t, c } = build('<table><tr><td><p>a</p><p>b</p></td></tr></table>');
    expect(t).not.toBeNull();
    expect(c.skipped.map((s) => s.construct)).toContain('table-cell-blocks');
  });

  it('keeps the flattened text rather than dropping the subtree', () => {
    // Visible content beats a silently dropped subtree, the rule svgdraw.ts
    // sets and this whole stack follows.
    const { t } = build('<table><tr><td><p>alpha</p><p>beta</p></td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    const joined = typeof runs === 'string' ? runs : runs.map((r) => r.text).join('');
    expect(joined).toContain('alpha');
    expect(joined).toContain('beta');
    // …on separate LINES. Without the break the cell reads `alphabeta`, which
    // is not a degraded rendering but a different word — and addCell already
    // splits a cell's text on a newline, so this costs no new vocabulary.
    expect(joined).toBe('alpha\nbeta');
  });

  it('does not report a cell whose content is plain inline', () => {
    const { c } = build('<table><tr><td>a</td></tr></table>');
    expect(c.skipped).toEqual([]);
  });

  it('paints the edges a cell border states and no others', () => {
    // A border edge's USED width is 0 when its style is none or hidden
    // (CSS 2.1 §8.5.3) — and the INITIAL border-style is none while the
    // initial width is medium (3px), so a cell that states no border must
    // carry no border at all rather than 3px on every edge.
    const { t } = build('<table><tr>'
      + '<td>plain</td>'
      + '<td style="border-bottom:2px solid red">under</td>'
      + '</tr></table>');
    expect(t!.rows[0].cells[0].options.border).toBeUndefined();
    const b = t!.rows[0].cells[1].options.border;
    expect(b).toBeDefined();
    expect(b!.width).toBeCloseTo(1.5);            // 2px -> 1.5pt
    expect(b!.color).toEqual([1, 0, 0]);
    expect(b!.sides).toEqual({ top: false, right: false, bottom: true, left: false });
  });

  it('scales every run font size to POINTS through the injected scaler', () => {
    // csstable.ts computes no points of its own: the x 0.75 crosses in
    // cssflow.ts and nowhere else, which is why toPt and scaleRuns are
    // injected rather than imported.
    const { t } = build('<table><tr><td>a</td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    if (typeof runs === 'string') throw new Error('expected runs');
    expect(runs[0].fontSize).toBeCloseTo(12);     // 16px initial -> 12pt
  });

  it('never throws on a zero font size', () => {
    // addCell validates fontSize as > 0, and a mapper whose whole contract is
    // that damage is a value must not let that escape.
    expect(() => build('<table style="font-size:0"><tr><td>a</td></tr></table>'))
      .not.toThrow();
  });
});

describe('a nested table (zch2.7)', () => {
  it('flattens the inner cells rather than losing them', () => {
    // A REGRESSION against this epic's own rule, shipped in zch2.6:
    // collectBox returned early for a table box, so `INNER` reached no
    // output at all. A cell takes `string | TextRun[]`, so the inner table
    // cannot BE a table here — its cells' text flattens into the outer cell.
    const { t } = build('<table><tr><td>outer'
      + '<table><tr><td>INNER</td></tr></table>'
      + '</td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    const joined = typeof runs === 'string' ? runs : runs.map((r) => r.text).join('');
    expect(joined).toContain('outer');
    expect(joined).toContain('INNER');
  });

  it('reports the nested table as degraded', () => {
    const { c } = build('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>');
    expect(c.skipped.map((s) => s.construct)).toContain('table');
    expect(c.skipped.find((s) => s.construct === 'table')?.kind).toBe('degraded');
  });

  it('keeps every cell of a multi-cell inner table', () => {
    const { t } = build('<table><tr><td>'
      + '<table><tr><td>ONE</td><td>TWO</td></tr></table>'
      + '</td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    const joined = typeof runs === 'string' ? runs : runs.map((r) => r.text).join('');
    expect(joined).toContain('ONE');
    expect(joined).toContain('TWO');
  });
});
