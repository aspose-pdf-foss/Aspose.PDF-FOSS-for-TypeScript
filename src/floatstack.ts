/** Geometry for the floating boxes active in one flow column: the horizontal
 *  bands they exclude, where those bands end, and where a new box may go.
 *  Pure arithmetic — no PDF, document, or drawing knowledge. @internal */

/** Tolerance shared with flow.ts. */
const EPS = 1e-9;

/** A float occupying a horizontal band on one side of the column, down to
 *  `bottom` (PDF user space, y up). */
export interface ActiveFloat {
  side: 'left' | 'right';
  /** Horizontal space to avoid, measured from the column edge: width + spacing. */
  band: number;
  /** The y the box reaches down to. */
  bottom: number;
}

/** True while `f` still excludes space at pen y `top`. */
function inForce(f: ActiveFloat, top: number): boolean {
  return top > f.bottom + EPS;
}

/** Horizontal insets in force at pen y `top`: the widest band per side over the
 *  floats still in force, 0 for a side with none. */
export function insetsAt(
  floats: readonly ActiveFloat[], top: number,
): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const f of floats) {
    if (!inForce(f, top)) continue;
    if (f.side === 'left') left = Math.max(left, f.band);
    else right = Math.max(right, f.band);
  }
  return { left, right };
}

/** The highest (largest y) bottom among the floats in force at `top` — the y at
 *  which the channel next widens. `undefined` when none is in force. */
export function nextBoundary(
  floats: readonly ActiveFloat[], top: number,
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (!inForce(f, top)) continue;
    if (best === undefined || f.bottom > best) best = f.bottom;
  }
  return best;
}

/** Drop the floats the pen at `top` has passed. */
export function pruneFloats(
  floats: readonly ActiveFloat[], top: number,
): ActiveFloat[] {
  return floats.filter((f) => inForce(f, top));
}

/** The lowest (smallest y) bottom among the floats in force at `top` on `side`. */
function lowestBottom(
  floats: readonly ActiveFloat[], top: number, side: 'left' | 'right',
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (f.side !== side || !inForce(f, top)) continue;
    if (best === undefined || f.bottom < best) best = f.bottom;
  }
  return best;
}

/** Which side's floats an element must clear. */
export type ClearSide = 'left' | 'right' | 'both';

/** The y to drop the pen to so `side` is cleared: the lowest (smallest y)
 *  bottom among the floats on the requested side(s). `undefined` when the
 *  requested side carries no float.
 *
 *  Takes no `top`: callers prune first, so every float in the list is in force. */
export function clearTo(
  floats: readonly ActiveFloat[], side: ClearSide,
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (side !== 'both' && f.side !== side) continue;
    if (best === undefined || f.bottom < best) best = f.bottom;
  }
  return best;
}

/** Resolve the top edge of a new float of `width` on `side`, starting from
 *  `naturalTop` (the pen minus the box's leading gap). Floats never share a
 *  side, so a same-side float in force pushes the box below it; an opposing
 *  float pushes it down only when the box no longer fits the channel it leaves.
 *  Returns `naturalTop` itself (identity) when nothing pushes the box — callers
 *  rely on that to decide whether the pen moves. */
export function resolveFloatTop(
  floats: readonly ActiveFloat[], side: 'left' | 'right', width: number,
  spacing: number, naturalTop: number, columnWidth: number,
): number {
  const opposite = side === 'left' ? 'right' : 'left';
  let top = naturalTop;
  // Each pass drops `top` below at least one float bottom, retiring it, so the
  // loop cannot run more times than there are floats.
  for (let pass = 0; pass <= floats.length; pass++) {
    const same = lowestBottom(floats, top, side);
    if (same !== undefined) { top = same - spacing; continue; }
    if (insetsAt(floats, top)[opposite] + width > columnWidth + EPS) {
      const low = lowestBottom(floats, top, opposite);
      // No opposing float left to clear: the box exceeds the bare column, which
      // is the caller's fit check to report.
      if (low === undefined) break;
      top = low - spacing;
      continue;
    }
    break;
  }
  return top;
}
