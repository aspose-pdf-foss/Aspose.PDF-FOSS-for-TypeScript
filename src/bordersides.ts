// The shared "a rectangle with a subset of its edges drawn" vocabulary. Its own
// module because two unrelated producers need it — table cells and the table's
// outer frame (tablerender.ts), and a floating box's chrome (floatbox.ts) — and
// a float box importing the table-authoring module to get a border type would be
// a dependency nobody reading either file would expect. Pure: no PDF objects, no
// Document.

/** Which edges of a border box are painted: every edge, no edge, or exactly the
 *  ones flagged true (an omitted flag is false, so `{ bottom: true }` is a
 *  bottom rule only). */
export type BorderSides =
  | 'all' | 'none'
  | { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean };

/** The four edge flags, resolved from a {@link BorderSides}. */
export interface BorderEdges {
  top: boolean; right: boolean; bottom: boolean; left: boolean;
}

const EDGE_NAMES = ['top', 'right', 'bottom', 'left'] as const;

/** Resolve a {@link BorderSides} to its four flags. Absent (or `'all'`) means
 *  every edge; an object names exactly the edges to paint. */
export function resolveBorderSides(s: BorderSides | undefined): BorderEdges {
  if (s === undefined || s === 'all') return { top: true, right: true, bottom: true, left: true };
  if (s === 'none') return { top: false, right: false, bottom: false, left: false };
  return {
    top: s.top === true, right: s.right === true,
    bottom: s.bottom === true, left: s.left === true,
  };
}

/** How many edges a {@link BorderSides} paints: 0 (nothing to draw), 4 (the whole
 *  box, which a renderer may emit as a single `re`), or a partial count. */
export function countBorderEdges(s: BorderSides | undefined): number {
  const e = resolveBorderSides(s);
  return EDGE_NAMES.reduce((n, k) => n + (e[k] ? 1 : 0), 0);
}

/** Validate a {@link BorderSides}. Unknown object keys are rejected rather than
 *  ignored: a misspelt side resolves to "no edges" and would silently paint
 *  nothing at all. */
export function checkBorderSides(s: BorderSides | undefined): void {
  const bad = () => new TypeError(
    "border.sides must be 'all', 'none', or an object of top/right/bottom/left booleans");
  if (s === undefined || s === 'all' || s === 'none') return;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw bad();
  for (const [k, v] of Object.entries(s)) {
    if (!(EDGE_NAMES as readonly string[]).includes(k)) throw bad();
    if (v !== undefined && typeof v !== 'boolean') throw bad();
  }
}
