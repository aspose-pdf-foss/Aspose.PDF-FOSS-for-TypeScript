import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { resolveBoxes } from '../src/cssresolve.js';
import { collapseMargins, isEmptyBlock } from '../src/cssmargin.js';
import { loadBoxGoldens, pathOf } from './helpers/box-goldens.js';
import type { BoxNode } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;
const G = loadBoxGoldens();
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

interface OurRow {
  width: number;
  /** The sum of collapsed gaps from the start of this box's sibling list.
   *
   *  CUMULATIVE rather than per-sibling, because an empty block occupies no
   *  vertical space and our model does not place it WITHIN the collapsed
   *  margin it sits in — Chrome splits a 30px run as 20 before the empty box
   *  and 10 after, and we put all 30 after. The running total is the same
   *  either way, and it is the number that decides where visible content
   *  lands. */
  cum: number;
  /** True for a box that occupies no vertical space, whose own cumulative
   *  offset is therefore not comparable — see above. */
  empty: boolean;
}

/** Walk our box tree, resolving each level against its parent's content
 *  width, and report `path -> row`. */
function ourRows(html: string): Map<string, OurRow> {
  const out = new Map<string, OurRow>();
  const { boxes } = buildBoxes(parseHtml(html), resolver);

  const walk = (children: BoxNode[], containingWidth: number): void => {
    const resolved = resolveBoxes(children, containingWidth);
    const gaps = collapseMargins(resolved);
    let cum = 0;
    resolved.forEach((r, i) => {
      cum += gaps[i] as number;
      if (r.box.el !== null) {
        out.set(pathOf(r.box.el).join('.'), {
          width: r.contentWidth, cum, empty: isEmptyBlock(r),
        });
      }
      if (r.box.kind !== 'table' && r.box.content.kind === 'blocks') {
        walk(r.box.content.children, r.contentWidth);
      }
    });
  };

  // The document element's containing block is the initial one, which every
  // fixture pins at 800px.
  walk(boxes, 800);
  return out;
}

/** Chrome's cumulative gap for each element, from the start of its sibling
 *  list — the same running total `ourRows` reports. */
function chromeCum(rows: { path: number[]; gap: number | null }[]): Map<string, number> {
  const out = new Map<string, number>();
  const running = new Map<string, number>();
  for (const r of rows) {
    const parent = r.path.slice(0, -1).join('.');
    const sum = (r.gap === null ? 0 : r.gap) + (running.get(parent) ?? 0);
    running.set(parent, sum);
    out.set(r.path.join('.'), sum);
  }
  return out;
}

describe('the Blink box corpus', () => {
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThanOrEqual(10);
  });

  it('agrees with Blink on every used content width', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      for (const row of c.rows) {
        const key = row.path.join('.');
        const mine = ours.get(key);
        if (mine === undefined) continue;      // an element we generate no box for
        if (!near(mine.width, row.width)) {
          failures.push(`${c.id} [${key}] width: ${mine.width} != ${row.width}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('agrees with Blink on every collapsed sibling offset', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      const theirs = chromeCum(c.rows);
      for (const row of c.rows) {
        if (row.gap === null) continue;        // first child: no gap to compare
        const key = row.path.join('.');
        const mine = ours.get(key);
        if (mine === undefined) continue;
        // An empty block occupies no vertical space, and our model does not
        // place it within the collapsed margin it sits in. Its own offset is
        // therefore not comparable; every box AFTER it is, which is what
        // makes the rule-4 case still measured rather than waved through.
        if (mine.empty) continue;
        // A box whose Chrome-predecessor generates NO box here has no
        // comparable offset either: <head> is display:none in both, so
        // Chrome measures <body> from it while <body> is our first child.
        // Skipping is right; the elements inside body are all still compared.
        const prevPath = [...row.path.slice(0, -1), (row.path.at(-1) as number) - 1];
        if (!ours.has(prevPath.join('.'))) continue;
        const want = theirs.get(key) as number;
        if (!near(mine.cum, want)) {
          failures.push(`${c.id} [${key}] offset: ${mine.cum} != ${want}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the harness itself', () => {
  // A comparison that silently skips everything would leave the corpus green
  // whatever the code does, so the number of rows actually compared is
  // asserted rather than assumed.
  it('compares a substantial number of rows, rather than skipping them', () => {
    let compared = 0;
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      for (const row of c.rows) if (ours.has(row.path.join('.'))) compared++;
    }
    expect(compared).toBeGreaterThan(30);
  });

  it('fails when a golden value is wrong', () => {
    const c = G.cases[0]!;
    const ours = ourRows(c.html);
    const row = c.rows.find((r) => ours.has(r.path.join('.')))!;
    const mine = ours.get(row.path.join('.'))!;
    // Far from the real value: `near` allows 0.5px, so a small tamper would
    // pass and prove nothing.
    expect(near(mine.width, row.width + 100)).toBe(false);
  });
});
