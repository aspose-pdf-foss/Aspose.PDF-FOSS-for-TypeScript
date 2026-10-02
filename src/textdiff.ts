/**
 * A token-level diff: what changed between two sequences, as equal / delete /
 * insert runs (`aq4a.1`). The model under document comparison.
 *
 * A pure leaf importing NOTHING. Tokens are of any type and are compared by a
 * caller-supplied KEY, so a token can carry its page, quad and style while two
 * spellings the caller considers the same (case, Unicode normalization) still
 * match — and each side of an equal run keeps its own payload.
 *
 * The algorithm is Myers' O(ND) diff in linear space (the middle-snake
 * refinement), after trimming the common prefix and suffix. Its answer is
 * MINIMAL — it edits exactly N + M − 2·LCS tokens — which the suite checks
 * against an independent O(NM) table rather than against itself.
 *
 * A cost budget bounds the work: past it a subproblem is reported as a whole
 * delete plus a whole insert. That answer is still CORRECT (both sides
 * reassemble exactly) but not minimal, and `minimal: false` says so, so a
 * caller can tell a real rewrite from a refused one.
 */

export type DiffOp = 'equal' | 'delete' | 'insert';

/** One run of a diff. `old` holds the tokens taken from the first sequence and
 *  `new` those from the second: an equal run has both (paired index by index),
 *  a delete only `old`, an insert only `new`. `oldIndex`/`newIndex` are where
 *  the run starts in each sequence. */
export interface DiffRun<T> {
  op: DiffOp;
  old: T[];
  new: T[];
  oldIndex: number;
  newIndex: number;
}

export interface DiffOptions {
  /** Inside one change region, emit the delete before the insert (the default)
   *  or after it. */
  order?: 'delete-first' | 'insert-first';
  /** How many diagonal steps the search may take before it gives up on a
   *  subproblem. Default {@link DEFAULT_MAX_DIFF_COST}. */
  maxCost?: number;
  /** `'none'` (the default) returns the minimal diff. `'semantic'` then folds
   *  every equality strictly shorter than the edits on BOTH sides of it into one
   *  change, so a word two unrelated sentences happen to share does not split
   *  a rewrite in two. The result still reassembles both sides exactly but is
   *  no longer minimal — by design, for a reader rather than a program. */
  cleanup?: 'none' | 'semantic';
}

export interface DiffResult<T> {
  runs: DiffRun<T>[];
  /** False when the cost budget cut the search short somewhere; the runs are
   *  then still a valid diff, just not the smallest one. */
  minimal: boolean;
}

export interface DiffStats {
  /** Tokens in equal runs (counted once). */
  equal: number;
  deleted: number;
  inserted: number;
  /** Change regions: maximal stretches of delete/insert between equalities. */
  changes: number;
}

/** About a second of search on current hardware; two fully different
 *  50,000-token documents need ~10^10 steps and are refused well before that. */
export const DEFAULT_MAX_DIFF_COST = 50_000_000;

type Seg = { op: DiffOp; a: number; b: number; len: number };
/** An equality, or a change region deleting a[aS, aE) and inserting b[bS, bE). */
type Item =
  | { kind: 'eq'; aS: number; bS: number; len: number }
  | { kind: 'chg'; aS: number; aE: number; bS: number; bE: number };

/** Diff `a` against `b`, comparing tokens by `key`. */
export function diffSequences<T>(
  a: readonly T[], b: readonly T[], key: (t: T) => string = String, opts: DiffOptions = {},
): DiffResult<T> {
  const ids = new Map<string, number>();
  const intern = (t: T): number => {
    const k = key(t);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    return id;
  };
  const ka = Int32Array.from(a, intern);
  const kb = Int32Array.from(b, intern);

  const solver = new Solver(ka, kb, opts.maxCost ?? DEFAULT_MAX_DIFF_COST);
  solver.solve(0, ka.length, 0, kb.length);
  let items = toItems(solver.segs);
  if (opts.cleanup === 'semantic') items = cleanupSemantic(items);
  items = slide(items, ka, kb);
  return { runs: emit(items, a, b, opts.order ?? 'delete-first'), minimal: solver.minimal };
}

/** Token totals and the number of change regions in a diff. */
export function diffStats<T>(runs: readonly DiffRun<T>[]): DiffStats {
  const s: DiffStats = { equal: 0, deleted: 0, inserted: 0, changes: 0 };
  let inChange = false;
  for (const r of runs) {
    if (r.op === 'equal') { s.equal += r.old.length; inChange = false; continue; }
    if (r.op === 'delete') s.deleted += r.old.length; else s.inserted += r.new.length;
    if (!inChange) s.changes++;
    inChange = true;
  }
  return s;
}

/** Split text into whitespace-separated words, punctuation kept with its word.
 *  Every Unicode space separates, U+00A0 included. */
export function tokenizeWords(text: string): string[] {
  return text.split(/\s+/u).filter((s) => s !== '');
}

class Solver {
  readonly segs: Seg[] = [];
  minimal = true;
  private cost = 0;

  constructor(private readonly ka: Int32Array, private readonly kb: Int32Array, private readonly maxCost: number) {}

  private push(op: DiffOp, a: number, b: number, len: number): void {
    if (len === 0) return;
    const last = this.segs[this.segs.length - 1];
    if (last && last.op === op) { last.len += len; return; }
    this.segs.push({ op, a, b, len });
  }

  /** Append the diff of ka[aLo, aHi) against kb[bLo, bHi). */
  solve(aLo: number, aHi: number, bLo: number, bHi: number): void {
    const { ka, kb } = this;
    let p = 0;
    while (aLo + p < aHi && bLo + p < bHi && ka[aLo + p] === kb[bLo + p]) p++;
    let s = 0;
    while (aHi - s > aLo + p && bHi - s > bLo + p && ka[aHi - 1 - s] === kb[bHi - 1 - s]) s++;
    this.push('equal', aLo, bLo, p);
    const a0 = aLo + p, a1 = aHi - s, b0 = bLo + p, b1 = bHi - s;
    if (a0 === a1) this.push('insert', a0, b0, b1 - b0);
    else if (b0 === b1) this.push('delete', a0, b0, a1 - a0);
    else {
      const mid = this.bisect(a0, a1, b0, b1);
      if (mid === undefined) {
        this.push('delete', a0, b0, a1 - a0);
        this.push('insert', a1, b0, b1 - b0);
      } else {
        this.solve(a0, mid[0], b0, mid[1]);
        this.solve(mid[0], a1, mid[1], b1);
      }
    }
    this.push('equal', a1, b1, s);
  }

  /** Myers' middle snake over ka[a0, a1) and kb[b0, b1): a split point on an
   *  optimal path, or undefined when the two share nothing or the budget ran
   *  out (the latter also clears `minimal`). */
  private bisect(a0: number, a1: number, b0: number, b1: number): [number, number] | undefined {
    const { ka, kb } = this;
    const n = a1 - a0, m = b1 - b0;
    const maxD = Math.ceil((n + m) / 2);
    const off = maxD, len = 2 * maxD + 2;
    const v1 = new Int32Array(len).fill(-1), v2 = new Int32Array(len).fill(-1);
    v1[off + 1] = 0; v2[off + 1] = 0;
    const delta = n - m;
    const front = delta % 2 !== 0;
    let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
    for (let d = 0; d < maxD; d++) {
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        if (++this.cost > this.maxCost) { this.minimal = false; return undefined; }
        const i1 = off + k1;
        let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1;
        let y1 = x1 - k1;
        while (x1 < n && y1 < m && ka[a0 + x1] === kb[b0 + y1]) { x1++; y1++; }
        v1[i1] = x1;
        if (x1 > n) k1end += 2;
        else if (y1 > m) k1start += 2;
        else if (front) {
          const i2 = off + delta - k1;
          if (i2 >= 0 && i2 < len && v2[i2] !== -1 && x1 >= n - v2[i2]) return [a0 + x1, b0 + y1];
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        if (++this.cost > this.maxCost) { this.minimal = false; return undefined; }
        const i2 = off + k2;
        let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1;
        let y2 = x2 - k2;
        while (x2 < n && y2 < m && ka[a1 - 1 - x2] === kb[b1 - 1 - y2]) { x2++; y2++; }
        v2[i2] = x2;
        if (x2 > n) k2end += 2;
        else if (y2 > m) k2start += 2;
        else if (!front) {
          const i1 = off + delta - k2;
          if (i1 >= 0 && i1 < len && v1[i1] !== -1) {
            const x1 = v1[i1], y1 = off + x1 - i1;
            if (x1 >= n - x2) return [a0 + x1, b0 + y1];
          }
        }
      }
    }
    return undefined;
  }
}

/** Collapse raw segments into alternating equalities and change regions.
 *  Between two equalities the deleted indices of `a` are one contiguous range
 *  and so are the inserted indices of `b`, however Myers interleaved them —
 *  which is what makes one region per stretch possible. */
function toItems(segs: Seg[]): Item[] {
  const items: Item[] = [];
  let aPos = 0, bPos = 0;
  for (const s of segs) {
    if (s.op === 'equal') {
      items.push({ kind: 'eq', aS: aPos, bS: bPos, len: s.len });
      aPos += s.len; bPos += s.len;
      continue;
    }
    let last = items[items.length - 1];
    if (!last || last.kind !== 'chg') {
      last = { kind: 'chg', aS: aPos, aE: aPos, bS: bPos, bE: bPos };
      items.push(last);
    }
    if (s.op === 'delete') { aPos += s.len; last.aE = aPos; } else { bPos += s.len; last.bE = bPos; }
  }
  return items;
}

/** Fold each equality STRICTLY SHORTER than the edits on both sides of it into
 *  one change region (diff-match-patch's semantic cleanup, on tokens). The
 *  test per side is the LARGER of its deletion and insertion: an equality that
 *  is short beside a long rewrite is a coincidence, not a landmark.
 *
 *  Strictly, unlike diff-match-patch's `<=` on characters: on WORDS a
 *  one-word equality beside a one-word edit is a landmark — `The` between a
 *  rewritten paragraph and `colour` -> `color` — and `<=` merged those two
 *  independent edits into one. The real-world fixture is what showed it. A fold grows
 *  the region, which may now outweigh the equality before it, so the walk
 *  steps back and looks again. Runs BEFORE `slide`, which only moves
 *  one-sided regions and would otherwise chase equalities this removes. */
function cleanupSemantic(items: Item[]): Item[] {
  let i = 1;
  while (i < items.length - 1) {
    const eq = items[i], before = items[i - 1], after = items[i + 1];
    if (eq.kind === 'eq' && before.kind === 'chg' && after.kind === 'chg'
      && eq.len < Math.max(before.aE - before.aS, before.bE - before.bS)
      && eq.len < Math.max(after.aE - after.aS, after.bE - after.bS)) {
      before.aE = after.aE; before.bE = after.bE;
      items.splice(i, 2);
      i = Math.max(1, i - 2);
      continue;
    }
    i++;
  }
  return items;
}

/** Move every one-sided change region (pure insert or pure delete) as far left
 *  as its tokens allow, merging the equalities it separated. The same edit has
 *  many spellings — `a` + ins `x a` + `c` is ins `a x` + `a c` — and a reader
 *  comparing two diffs should not see them differ by where Myers happened to
 *  land. Sliding never changes how many tokens are edited. */
function slide(items: Item[], ka: Int32Array, kb: Int32Array): Item[] {
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const prev = items[i - 1];
    if (it.kind !== 'chg' || !prev || prev.kind !== 'eq' || (it.aE > it.aS && it.bE > it.bS)) { i++; continue; }
    const ins = it.bE > it.bS;
    let moved = 0;
    while (prev.len > moved) {
      const same = ins
        ? kb[it.bE - 1 - moved] === kb[it.bS - 1 - moved]
        : ka[it.aE - 1 - moved] === ka[it.aS - 1 - moved];
      if (!same) break;
      moved++;
    }
    if (moved === 0) { i++; continue; }
    it.aS -= moved; it.aE -= moved; it.bS -= moved; it.bE -= moved;
    prev.len -= moved;
    const next = items[i + 1];
    if (next && next.kind === 'eq') { next.aS -= moved; next.bS -= moved; next.len += moved; }
    else items.splice(i + 1, 0, { kind: 'eq', aS: it.aE, bS: it.bE, len: moved });
    if (prev.len === 0) {
      items.splice(i - 1, 1);
      i--;
      const before = items[i - 1];
      if (before && before.kind === 'chg') {
        // two regions now touch: one region, and look at it again
        before.aE = it.aE; before.bE = it.bE;
        items.splice(i, 1);
        i--;
      }
    }
  }
  return items;
}

function emit<T>(items: Item[], a: readonly T[], b: readonly T[], order: 'delete-first' | 'insert-first'): DiffRun<T>[] {
  const runs: DiffRun<T>[] = [];
  let aPos = 0, bPos = 0;
  const del = (it: Extract<Item, { kind: 'chg' }>): void => {
    if (it.aE === it.aS) return;
    runs.push({ op: 'delete', old: a.slice(it.aS, it.aE), new: [], oldIndex: aPos, newIndex: bPos });
    aPos = it.aE;
  };
  const ins = (it: Extract<Item, { kind: 'chg' }>): void => {
    if (it.bE === it.bS) return;
    runs.push({ op: 'insert', old: [], new: b.slice(it.bS, it.bE), oldIndex: aPos, newIndex: bPos });
    bPos = it.bE;
  };
  for (const it of items) {
    if (it.kind === 'eq') {
      if (it.len === 0) continue;
      const last = runs[runs.length - 1];
      if (last && last.op === 'equal') {
        // a loop, never push(...slice): a spread passes every token as a call
        // argument and overflows the stack on a long run
        for (let k = 0; k < it.len; k++) { last.old.push(a[it.aS + k]); last.new.push(b[it.bS + k]); }
      } else {
        runs.push({ op: 'equal', old: a.slice(it.aS, it.aS + it.len), new: b.slice(it.bS, it.bS + it.len), oldIndex: aPos, newIndex: bPos });
      }
      aPos = it.aS + it.len; bPos = it.bS + it.len;
    } else if (order === 'delete-first') { del(it); ins(it); }
    else { ins(it); del(it); }
  }
  return runs;
}
