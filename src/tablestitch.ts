import { Table } from './tablemodel.js';
import type { TableRow } from './tablemodel.js';

export interface TableStitchOptions {
  /** Merge continuations across page boundaries. Default true. */
  stitch?: boolean;
}

const STITCH_TOL = 3;   // column-boundary alignment tolerance, in points

/** Sorted, tolerance-deduplicated vertical cell boundaries of a table. */
function columnBoundaries(t: Table): number[] {
  const xs: number[] = [];
  for (const row of t.rows) for (const c of row.cells) xs.push(c.quad[0], c.quad[2]);
  xs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of xs) if (!out.length || Math.abs(x - out[out.length - 1]) > STITCH_TOL) out.push(x);
  return out;
}

/** Two consecutive-page tables continue each other when they have the same
 *  column count and pairwise-aligned column boundaries. */
function signatureMatch(a: Table, b: Table): boolean {
  if (a.colCount !== b.colCount) return false;
  const ba = columnBoundaries(a), bb = columnBoundaries(b);
  if (ba.length !== bb.length) return false;
  return ba.every((x, i) => Math.abs(x - bb[i]) <= STITCH_TOL);
}

interface Chain { members: { page: number; table: Table }[]; anchor: number; }

/** Per-column trimmed text of a row, ordered by column. */
function headerKey(row: TableRow): string[] {
  return row.cells.slice().sort((a, b) => a.col - b.col).map((c) => c.text.trim());
}

/** True if follower's row 0 duplicates the leader's header row (all columns). */
function repeatsHeader(leaderRow0: TableRow | undefined, followerRow0: TableRow | undefined): boolean {
  if (!leaderRow0 || !followerRow0) return false;
  const a = headerKey(leaderRow0), b = headerKey(followerRow0);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Concatenate a chain's rows into one Table: rows renumbered contiguously,
 *  cell quads left page-local, quad/summary from the leader, pageSpans per page.
 *  A follower whose row 0 repeats the leader's header row has that row dropped. */
function emitChain(chain: Chain): Table {
  const lead = chain.members[0].table;
  const headerRow0 = lead.rows[0];
  const rows: TableRow[] = [];
  let idx = 0;
  chain.members.forEach((m, mi) => {
    const src = (mi > 0 && repeatsHeader(headerRow0, m.table.rows[0]))
      ? m.table.rows.slice(1)
      : m.table.rows;
    for (const row of src) {
      const ri = idx++;
      rows.push({ ...row, cells: row.cells.map((c) => ({ ...c, row: ri })) });
    }
  });
  const pageSpans = chain.members.map((m) => ({ page: m.page, quad: m.table.quad }));
  return new Table(lead.quad, rows.length, lead.colCount, rows, lead.summary, pageSpans);
}

export function stitchTables(perPage: Table[][], options: TableStitchOptions = {}): Table[] {
  if (options.stitch === false) return perPage.flat();

  const chains: Chain[] = [];
  for (let page = 0; page < perPage.length; page++) {
    const available = chains.filter((c) => c.anchor === page - 1);
    const used = new Set<Chain>();
    for (const table of perPage[page]) {
      const match = available.find((c) => !used.has(c) && signatureMatch(c.members[c.members.length - 1].table, table));
      if (match) { match.members.push({ page, table }); match.anchor = page; used.add(match); }
      else chains.push({ members: [{ page, table }], anchor: page });
    }
  }

  return chains.map((c) => (c.members.length === 1 ? c.members[0].table : emitChain(c)));
}
