import { describe, it, expect } from 'vitest';
import type { TextFragment } from '../src/text.js';
import {
  groupLines, columnCuts, detectWhitespaceTable, segmentBlocks,
  modalCount, referenceCuts, spanSeparators,
} from '../src/tablestream.js';

/** A fragment of `text` at (x, baseline), 10pt unless told otherwise. */
function f(text: string, x: number, baseline: number, size = 10): TextFragment {
  return {
    text, fontSize: size,
    quad: [x, baseline, x + text.length * size * 0.55, baseline + size],
  };
}

/** A fragment with EXPLICIT geometry. The detector reasons about x-extents, not
 *  character counts, so a fixture that needs a particular width says so —
 *  deriving it from `text.length` made the first draft of the header 93.5pt wide
 *  against the real PDF's 73.4pt, which nearly closed the column gap and stopped
 *  the table being detected at all. */
function w(text: string, x0: number, x1: number, baseline: number, size = 10): TextFragment {
  return { text, fontSize: size, quad: [x0, baseline, x1, baseline + size] };
}

/** A two-column body row: left at x=20, right at x=120. */
const row = (baseline: number, a: string, b: string): TextFragment[] =>
  [f(a, 20, baseline), f(b, 120, baseline)];

describe('groupLines', () => {
  it('buckets fragments by baseline, top first', () => {
    const lines = groupLines([...row(230, '10', '20'), ...row(260, 'Q1', 'Q2')]);
    expect(lines).toHaveLength(2);
    expect(lines[0].map((x) => x.text).sort()).toEqual(['Q1', 'Q2']);
  });
});

describe('columnCuts', () => {
  it('cuts at the midpoint of a gap no row covers', () => {
    const lines = [row(260, 'Q1', 'Q2'), row(245, '10', '20')];
    const cuts = columnCuts(lines, 19, 134);
    expect(cuts).toHaveLength(3);            // x0, one interior cut, x1
    expect(cuts[1]).toBeGreaterThan(60);
    expect(cuts[1]).toBeLessThan(90);
  });

  it('is PUSHED OUT OF THE WAY by a row that covers the gap', () => {
    // The measurement this whole feature exists because of: a wide row moves
    // the interior cut right, so the wide text ends up inside column 0 and
    // straddles nothing.
    const lines = [
      [w('Quarterly results', 20, 93.4, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    const cuts = columnCuts(lines, 19, 134);
    expect(cuts[1]).toBeGreaterThan(100);
  });
});

/** Header over two columns — the canonical spanning shape. */
const spanning = (): TextFragment[] => [
  w('Quarterly results', 20, 93.4, 260),
  ...row(245, 'Q1', 'Q2'),
  ...row(230, '10', '20'),
];

describe('detectWhitespaceTable', () => {
  it('detects a 3x2 grid', () => {
    const t = detectWhitespaceTable(spanning());
    expect(t).toBeDefined();
    expect([t!.rowCount, t!.colCount]).toEqual([3, 2]);
  });

  it('leaves a uniform table entirely 1x1', () => {
    // Was the pre-span characterization ("every cell colSpan 1"), which the
    // spanning fixture now correctly violates. Repointed at a UNIFORM table,
    // where it still asserts something real: no spurious spans. Note a uniform
    // fixture can never exercise the span rule — every row is a reference row,
    // so there are no candidates — which is exactly why it is the right shape
    // for this assertion and the wrong shape for the ones below.
    const t = detectWhitespaceTable([...row(260, 'Q1', 'Q2'), ...row(245, '10', '20')])!;
    expect(t).toBeDefined();
    for (const r of t.rows) for (const c of r.cells) expect(c.colSpan).toBe(1);
  });

  it('rejects a candidate whose column is emptier than the prose guard allows', () => {
    // Column 1 has text in 1 of 4 rows; ceil(4 * PROSE_FILL) = 2 required.
    const frags = [
      ...row(260, 'Name', 'Note'),
      f('Bolt', 20, 245), f('Nut', 20, 230), f('Screw', 20, 215),
    ];
    expect(detectWhitespaceTable(frags)).toBeUndefined();
  });
});

describe('segmentBlocks', () => {
  it('returns one table per whitespace-separated region', () => {
    const frags = [
      ...row(260, 'Name', 'Qty'), ...row(245, 'Bolt', '12'),
      ...row(120, 'City', 'Pop'), ...row(105, 'Rome', '99'),
    ];
    expect(segmentBlocks(frags)).toHaveLength(2);
  });

  it('does not halve a single table on its inter-column gap', () => {
    // The load-bearing guard in segmentBlocks: a split is accepted only when it
    // yields >= 2 VALID tables, and single-column halves are not valid.
    expect(segmentBlocks([...row(260, 'Q1', 'Q2'), ...row(245, '10', '20')])).toHaveLength(1);
  });
});

/** The canonical spanning shape as LINES, for the pure cut functions. */
const spanLines = (): TextFragment[][] => [
  [w('Quarterly results', 20, 93.4, 260)],
  row(245, 'Q1', 'Q2'),
  row(230, '10', '20'),
];

describe('modalCount', () => {
  it('takes the most common fragment count', () => {
    expect(modalCount(spanLines())).toBe(2);
  });

  it('resolves a TIE to the higher count', () => {
    // Two rows of 2 and two rows of 1. More fragments reveal more boundaries,
    // so 2 wins. This is the sparse-table shape, and the tie is what keeps its
    // reference cuts identical to today's all-rows cuts.
    const lines = [
      row(260, 'Name', 'Note'), [f('Bolt', 20, 245)],
      [f('Nut', 20, 230)], row(215, 'Screw', 'spare'),
    ];
    expect(modalCount(lines)).toBe(2);
  });

  it('returns 0 for no lines', () => {
    expect(modalCount([])).toBe(0);
  });
});

describe('referenceCuts', () => {
  it('derives cuts from the modal rows alone, undistorted', () => {
    const refs = referenceCuts(spanLines(), 19, 134);
    expect(refs).toBeDefined();
    expect(refs!.modal).toBe(2);
    // The body rows alone leave the gap open, so the cut sits far left of the
    // all-rows cut, which the columnCuts test above pins above 100.
    expect(refs!.cuts[1]).toBeLessThan(90);
  });

  it('declines when the modal count is below 2', () => {
    // One column: there is no interior boundary, so no span can exist.
    expect(referenceCuts([[f('a', 20, 260)], [f('b', 20, 245)]], 19, 40)).toBeUndefined();
  });

  it('declines with fewer than two reference rows', () => {
    // The modal count must be >= 2 or the FIRST guard fires and this proves
    // nothing. Counts [3, 2] tie-break to 3, held by exactly one row.
    const lines = [
      [f('a', 20, 260), f('b', 60, 260), f('c', 100, 260)],
      row(245, 'Q1', 'Q2'),
    ];
    expect(modalCount(lines)).toBe(3);                        // guard 1 passes
    expect(referenceCuts(lines, 19, 134)).toBeUndefined();    // guard 2 fires
  });
});

describe('spanSeparators', () => {
  it('opens the separator under a straddling single-fragment row', () => {
    const lines = spanLines();
    const refs = referenceCuts(lines, 19, 134)!;
    const vSep = spanSeparators(lines, [19, 108, 134], refs);
    expect(vSep).toBeDefined();
    expect(vSep![0][0]).toBe(false);       // row 0 spans the only interior boundary
    expect(vSep![1][0]).toBe(true);        // body rows untouched
    expect(vSep![2][0]).toBe(true);
  });

  it('returns undefined when nothing spans', () => {
    const flat = [row(260, 'Q1', 'Q2'), row(245, '10', '20')];
    const refs = referenceCuts(flat, 19, 134)!;
    expect(spanSeparators(flat, [19, 76.65, 134], refs)).toBeUndefined();
  });

  it('does NOT span a sparse row whose text never reaches the cut', () => {
    // The case cardinality alone gets wrong: 'Bolt' is one fragment on a row of
    // fewer than modal, but it stops well short of the boundary. Spanning it
    // would make toMarkdown print 'Bolt | Bolt', inventing data.
    const sparse = [
      row(260, 'Name', 'Note'), [f('Bolt', 20, 245)],
      [f('Nut', 20, 230)], row(215, 'Screw', 'spare'),
    ];
    const refs = referenceCuts(sparse, 19, 190)!;
    expect(spanSeparators(sparse, [19, 100, 190], refs)).toBeUndefined();
  });

  it('requires the overhang margin: just-over spans, just-under does not', () => {
    // The discriminating pair. An intersection-style rule with no margin would
    // accept both.
    const body = [row(245, 'Q1', 'Q2'), row(230, '10', '20')];
    const refs = referenceCuts(body, 19, 134)!;
    const wide = (x1: number): TextFragment[][] => [[w('h', 20, x1, 260)], ...body];
    expect(spanSeparators(wide(95), [19, 108, 134], refs)).toBeDefined();
    expect(spanSeparators(wide(80), [19, 108, 134], refs)).toBeUndefined();
  });

  it('declines when the two cut systems disagree about the column count', () => {
    // Index, never position: a reference grid with a different number of columns
    // cannot be mapped onto the final one without guessing.
    const lines = spanLines();
    const refs = referenceCuts(lines, 19, 134)!;
    expect(spanSeparators(lines, [19, 60, 100, 134], refs)).toBeUndefined();
  });

  it('ignores a multi-fragment row even when one fragment WOULD straddle', () => {
    // Pins the single-fragment condition. Measured: without a straddling
    // fragment in this row, dropping that condition leaves the suite green — the
    // earlier version of this test passed for the wrong reason TWICE: first with
    // no straddling fragment at all, then with the straddling fragment at index
    // 1 — and `spanSeparators` reads only `ln[0]`. The wide fragment must be
    // FIRST, or the cardinality rule is not the thing being tested.
    const lines = [
      [w('wide', 20, 95, 260), f('b', 100, 260), f('c', 115, 260)],
      row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    const refs = referenceCuts(lines, 19, 134)!;
    expect(spanSeparators(lines, [19, 108, 134], refs)).toBeUndefined();
  });

  it('ignores a single fragment lying entirely RIGHT of the cut', () => {
    // Pins the `x0 < cut` half of the predicate. A fragment past the boundary
    // satisfies the overhang test on its own, so without this half it would open
    // a separator it never crossed. Measured: dropping `x0 < cut` left the suite
    // green until this case existed.
    const lines = [
      [w('right', 100, 130, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    const refs = referenceCuts(lines, 19, 134)!;
    expect(spanSeparators(lines, [19, 108, 134], refs)).toBeUndefined();
  });

  it('ignores a multi-fragment non-reference row', () => {
    // Only a single-fragment row is a candidate, which is what makes 'the
    // spanned columns are empty in this row' true by construction.
    const three = [
      [f('a', 20, 260), f('b', 60, 260), f('c', 100, 260)],
      row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    const refs = referenceCuts(three, 19, 134)!;
    expect(spanSeparators(three, [19, 108, 134], refs)).toBeUndefined();
  });
});

describe('detectWhitespaceTable with spans', () => {
  it('gives the header colSpan 2 and leaves the body 1x1', () => {
    // BOTH halves matter: asserting only the header would also pass if every
    // cell spanned, which is the worst available bug.
    const t = detectWhitespaceTable(spanning())!;
    expect(t.rows[0].cells).toHaveLength(1);
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    expect(t.rows[0].cells[0].text).toBe('Quarterly results');
    for (const r of t.rows.slice(1)) {
      expect(r.cells).toHaveLength(2);
      for (const c of r.cells) expect(c.colSpan).toBe(1);
    }
  });

  it('still reports 2 columns', () => {
    expect(detectWhitespaceTable(spanning())!.colCount).toBe(2);
  });

  it('renders the span in Markdown', () => {
    // toMarkdown expands a colSpan by REPEATING the text, which is exactly why
    // a false span invents data.
    const md = detectWhitespaceTable(spanning())!.toMarkdown();
    expect(md.split(/\r?\n/)[0]).toContain('Quarterly results');
  });
});
