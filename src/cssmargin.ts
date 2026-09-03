/** Margin collapsing, CSS 2.1 §8.3.1.
 *
 *  Invariant: a PURE LEAF over cssbox.js and cssresolve.js — types and
 *  arithmetic. No Document, no PDF object module, no `node:` import. Its own
 *  module rather than a section of cssresolve.ts because this is the geometry
 *  that is silently wrong when reversed, and it should be testable from
 *  numbers rather than from a built file — floatstack.ts's split.
 *
 *  Invariant: the combining rule is NOT `max`. Adjoining margins combine as
 *  the largest POSITIVE plus the most NEGATIVE, so 40px against -10px is 30px.
 *  A document with no negative margins cannot tell the two readings apart,
 *  which is why the fixture for it uses one.
 *
 *  Invariant: floats and cleared boxes do not collapse. Neither does the root.
 *  A non-collapsing box contributes its OWN top margin as its gap and
 *  combines with nothing on either side.
 *
 *  Note, and it is a SIMPLIFICATION recorded rather than discovered: real
 *  clearance depends on where the floats actually are, and a cleared box
 *  whose clearance turns out to be zero WOULD collapse with its predecessor
 *  in a browser. This module positions nothing and has no float positions, so
 *  it takes the conservative reading — a cleared box never collapses — and
 *  the actual clearing is floatstack.ts's, through the `clear` zch2.4 passes
 *  to Flow. The divergence is at most a few points of extra space above an
 *  element the author already asked to be pushed down.
 *
 *  Note for zch2.4, and it is the whole point of returning GAPS: flow.ts adds
 *  `spaceAfter + paragraphSpacing + spaceBefore` between consecutive elements
 *  rather than collapsing. Set `paragraphSpacing: 0`, put the entire gap in
 *  the following element's `spaceBefore`, and zero every `spaceAfter` — and
 *  Flow's additive rule then reproduces the collapsed result exactly, with no
 *  change to Flow. */

import type { ResolvedBox } from './cssresolve.js';
import { resolveBoxes } from './cssresolve.js';

/** Combine two adjoining margins. The largest positive plus the most
 *  negative — `Math.max` is wrong the moment a negative margin appears. */
export function combineMargins(a: number, b: number): number {
  return Math.max(a, b, 0) + Math.min(a, b, 0);
}

/** Does a box's own top edge let a child's margin through? */
function openTop(r: ResolvedBox): boolean {
  return r.insetTop === 0;
}

/** Does its bottom edge? A stated height gives the box a bottom edge of its
 *  own for the margin to stop at. */
function openBottom(r: ResolvedBox): boolean {
  return r.insetBottom === 0 && r.minHeight === 0;
}

/** Does this box participate in collapsing at all? */
function collapses(r: ResolvedBox): boolean {
  return r.box.float === 'none' && r.box.clear === 'none';
}

/** A box's in-flow block children, resolved against its own content width —
 *  which is exactly what a child's containing block is. */
function childrenOf(r: ResolvedBox): ResolvedBox[] {
  if (r.box.kind === 'table') return [];
  const c = r.box.content;
  if (c.kind !== 'blocks') return [];
  return resolveBoxes(c.children, r.contentWidth);
}

/** Is the box wholly empty — no content, no insets, no height — so that rule
 *  4 collapses its own two margins together?
 *
 *  Exported because such a box occupies NO vertical space, so a consumer
 *  comparing positions has to know that its own gap is not where the space
 *  went — see test/cssbox-suite.test.ts. */
export function isEmptyBlock(r: ResolvedBox): boolean {
  return isEmpty(r);
}

function isEmpty(r: ResolvedBox): boolean {
  if (r.insetTop !== 0 || r.insetBottom !== 0 || r.minHeight !== 0) return false;
  if (r.box.kind === 'table') return false;
  const c = r.box.content;
  if (c.kind === 'inline') return c.runs.length === 0 && c.atomics.length === 0;
  return c.children.length === 0;
}

/** The margins that escape a box's top and bottom edges, after rules 2, 3 and
 *  4 have run over its own subtree. */
export function outerMargins(r: ResolvedBox): { top: number; bottom: number } {
  if (!collapses(r)) return { top: r.marginTop, bottom: r.marginBottom };

  // Rule 4: a wholly empty block's own margins collapse together, and the
  // result escapes both edges as one margin.
  if (isEmpty(r)) {
    const m = combineMargins(r.marginTop, r.marginBottom);
    return { top: m, bottom: m };
  }

  const kids = childrenOf(r);
  let top = r.marginTop;
  let bottom = r.marginBottom;

  // Rule 2: the first in-flow child's top margin joins ours, if our top edge
  // is open.
  const first = kids.find(collapses);
  if (first !== undefined && openTop(r)) {
    top = combineMargins(top, outerMargins(first).top);
  }
  // Rule 3: the last in-flow child's bottom margin joins ours, if our bottom
  // edge is open — which a stated height closes.
  const last = [...kids].reverse().find(collapses);
  if (last !== undefined && openBottom(r)) {
    bottom = combineMargins(bottom, outerMargins(last).bottom);
  }
  return { top, bottom };
}

/** The gap BEFORE each box in a sibling list, after collapsing. The first
 *  entry is always 0: a first child's top margin escapes its parent under
 *  rule 2 and is not a gap between siblings, so counting it here would double
 *  the space above it. */
export function collapseMargins(resolved: ResolvedBox[]): number[] {
  const out: number[] = [];
  /** The run of adjoining margins accumulated so far and not yet emitted, or
   *  null when the previous box ended one (or there was no previous box). */
  let pending: number | null = null;

  for (const r of resolved) {
    const { top, bottom } = outerMargins(r);

    if (!collapses(r)) {
      // A box that does not collapse contributes its OWN top margin and
      // combines with nothing: a float is out of flow, so the preceding
      // sibling's bottom margin and the float's top margin are independent.
      out.push(out.length === 0 ? 0 : top);
      pending = null;
      continue;
    }

    const before = out.length === 0
      ? 0
      : pending === null ? top : combineMargins(pending, top);

    // An EMPTY block occupies NO vertical space, so its top and bottom
    // margins are still adjoining each other AND everything on either side:
    // the run continues THROUGH it rather than restarting after it. Emitting
    // `before` here and again after would spend one collapsed margin twice —
    // measured against Chrome, 60px where 30px is right.
    if (isEmpty(r)) {
      out.push(0);
      pending = combineMargins(before, bottom);
      continue;
    }

    out.push(before);
    pending = bottom;
  }
  return out;
}
