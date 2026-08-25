// Page selection for the decoration API: an explicit 1-based list (the existing
// Overlay convention) or a range string like "1-5,8,12-".

/** One term of a range string: `N`, `N-M`, `N-`, or `-M` (whitespace tolerated). */
const TERM = /^(?:(\d+)|(\d+)\s*-\s*(\d+)|(\d+)\s*-|-\s*(\d+))$/;

/** Expand a range string to a 1-based page list (unsorted, may repeat).
 *  Bounds are checked per term so the error names the offending term. */
function parseRangeString(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const t = raw.trim();
    if (t === '') throw new TypeError(`page range "${spec}": empty term`);
    const m = TERM.exec(t);
    if (m === null) throw new TypeError(`page range "${spec}": malformed term "${t}"`);
    let lo: number, hi: number;
    if (m[1] !== undefined) { lo = hi = Number(m[1]); }                    // N
    else if (m[2] !== undefined) { lo = Number(m[2]); hi = Number(m[3]); } // N-M
    else if (m[4] !== undefined) { lo = Number(m[4]); hi = total; }        // N-
    else { lo = 1; hi = Number(m[5]); }                                    // -M
    // Bounds before ordering, so "9-" on a 5-page doc reports the real problem
    // (out of range) rather than looking like a reversed range.
    if (lo < 1 || lo > total || hi > total)
      throw new RangeError(`page range "${spec}": term "${t}" out of range (1..${total})`);
    if (lo > hi) throw new TypeError(`page range "${spec}": reversed range "${t}"`);
    for (let n = lo; n <= hi; n++) out.push(n);
  }
  return out;
}

/** Resolve a page selection to a normalized 1-based list: ascending, deduped.
 *  `undefined` selects every page. A `number[]` is taken as given (the existing
 *  Overlay convention); a string is parsed as the range grammar.
 *  Throws TypeError for malformed input, RangeError for out-of-bounds pages. */
export function resolvePages(
  spec: number[] | string | undefined, total: number,
): number[] {
  if (spec === undefined) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = Array.isArray(spec) ? spec : parseRangeString(spec, total);
  for (const n of pages) {
    if (!Number.isInteger(n)) throw new TypeError(`page ${n} must be an integer`);
    if (n < 1 || n > total) throw new RangeError(`page ${n} out of range (1..${total})`);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}
