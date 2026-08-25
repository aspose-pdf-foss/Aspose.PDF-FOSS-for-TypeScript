// UAX #9 Unicode Bidirectional Algorithm (full, including isolates), plus script
// itemization and Arabic joining-form derivation. Pure functions over plain
// arrays; no font/document state. Malformed input degrades to identity, never throws.
import { BC, bidiClass, bracket, script, scriptTag, joiningType, JT, scriptNames } from './unicode-data.js';
export { mirror } from './unicode-data.js';

const COMMON = scriptNames.indexOf('Common');
const INHERITED = scriptNames.indexOf('Inherited');

const MAX_DEPTH = 125;
const nextOdd = (l: number) => (l + 1) | 1;
const nextEven = (l: number) => (l + 2) & ~1;
const dirOf = (level: number): number => ((level & 1) ? BC.R : BC.L);
// Neutral-or-Isolate-formatting set (N rules).
const isNI = (t: number) =>
  t === BC.B || t === BC.S || t === BC.WS || t === BC.ON ||
  t === BC.FSI || t === BC.LRI || t === BC.RLI || t === BC.PDI;
// Strong direction for N/W boundary tests: EN/AN count as R.
const strongSide = (t: number) => (t === BC.L ? BC.L : (t === BC.R || t === BC.EN || t === BC.AN) ? BC.R : t);
// Canonical bracket folding (BD16): U+3008/9 ≡ U+2329/A.
const canonBracket = (cp: number) => (cp === 0x3008 ? 0x2329 : cp === 0x3009 ? 0x232A : cp);
const isRemovedByX9 = (t: number) =>
  t === BC.RLE || t === BC.LRE || t === BC.RLO || t === BC.LRO || t === BC.PDF || t === BC.BN;

/** UAX #9 P2/P3: paragraph embedding level. 'auto' = first-strong (skipping any
 *  isolate-initiator … matching-PDI span); 'ltr'/'rtl' force it. */
export function paragraphLevel(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): 0 | 1 {
  if (dir === 'ltr') return 0;
  if (dir === 'rtl') return 1;
  let isolate = 0;
  for (const c of codes) {
    const b = bidiClass(c);
    if (b === BC.LRI || b === BC.RLI || b === BC.FSI) { isolate++; continue; }
    if (b === BC.PDI) { if (isolate > 0) isolate--; continue; }
    if (isolate > 0) continue;                       // skip characters within an isolate (P2)
    if (b === BC.L) return 0;
    if (b === BC.R || b === BC.AL) return 1;
  }
  return 0;                                          // P3 default
}

/** UAX #9 X1–X10 + W1–W7 + N0–N2 + I1–I2. `levels[k]` = resolved embedding level;
 *  `removed[k]` = true for X9-removed chars (RLE/LRE/RLO/LRO/PDF/BN). */
export function resolveLevels(codes: number[], paraLevel: 0 | 1): { levels: Int8Array; removed: boolean[] } {
  const n = codes.length;
  const orig = codes.map(bidiClass);
  const types = Int8Array.from(orig);                 // working types (mutated by X6/W/N)
  const levels = new Int8Array(n).fill(paraLevel);
  const removed: boolean[] = new Array(n).fill(false);
  const wasNSM: boolean[] = orig.map((t) => t === BC.NSM);
  if (n === 0) return { levels, removed };

  // First-strong over an isolate span (X5c FSI): scan codes[from..matching PDI).
  const isolateInitiatorLevel = (from: number): 0 | 1 => {
    let depth = 0;
    for (let i = from; i < n; i++) {
      const t = orig[i];
      if (t === BC.LRI || t === BC.RLI || t === BC.FSI) depth++;
      else if (t === BC.PDI) { if (depth === 0) break; depth--; }
      else if (depth === 0) { if (t === BC.L) return 0; if (t === BC.R || t === BC.AL) return 1; }
    }
    return 0;
  };

  // ── X1–X8: explicit levels & overrides via the directional status stack ──
  const stack: { level: number; override: number; isolate: boolean }[] = [{ level: paraLevel, override: -1, isolate: false }];
  let overflowIsolate = 0, overflowEmbedding = 0, validIsolate = 0;
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < n; i++) {
    const t = orig[i];
    switch (t) {
      case BC.RLE: case BC.LRE: case BC.RLO: case BC.LRO: {
        levels[i] = top().level;
        const rtl = t === BC.RLE || t === BC.RLO;
        const newLevel = rtl ? nextOdd(top().level) : nextEven(top().level);
        if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          stack.push({ level: newLevel, override: t === BC.RLO ? BC.R : t === BC.LRO ? BC.L : -1, isolate: false });
        } else if (overflowIsolate === 0) overflowEmbedding++;
        removed[i] = true;
        break;
      }
      case BC.RLI: case BC.LRI: case BC.FSI: {
        levels[i] = top().level;
        if (top().override !== -1) types[i] = top().override;
        const rtl = t === BC.FSI ? isolateInitiatorLevel(i + 1) === 1 : t === BC.RLI;
        const newLevel = rtl ? nextOdd(top().level) : nextEven(top().level);
        if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          validIsolate++;
          stack.push({ level: newLevel, override: -1, isolate: true });
        } else overflowIsolate++;
        break;
      }
      case BC.PDI: {
        if (overflowIsolate > 0) overflowIsolate--;
        else if (validIsolate > 0) {
          overflowEmbedding = 0;
          while (!top().isolate) stack.pop();
          stack.pop();
          validIsolate--;
        }
        levels[i] = top().level;
        if (top().override !== -1) types[i] = top().override;
        break;
      }
      case BC.PDF: {
        levels[i] = top().level;
        if (overflowIsolate > 0) { /* nothing */ }
        else if (overflowEmbedding > 0) overflowEmbedding--;
        else if (!top().isolate && stack.length >= 2) stack.pop();
        removed[i] = true;
        break;
      }
      case BC.B: {
        stack.length = 1; stack[0] = { level: paraLevel, override: -1, isolate: false };
        overflowIsolate = overflowEmbedding = validIsolate = 0;
        levels[i] = paraLevel;
        break;
      }
      case BC.BN: { levels[i] = top().level; removed[i] = true; break; }
      default: {
        levels[i] = top().level;
        if (top().override !== -1) types[i] = top().override;
      }
    }
  }

  // ── X9/X10: build isolating run sequences over non-removed positions ──
  const pos: number[] = [];
  for (let i = 0; i < n; i++) if (!removed[i]) pos.push(i);
  if (pos.length === 0) return { levels, removed };
  const posRank = new Map<number, number>();
  pos.forEach((i, k) => posRank.set(i, k));

  const matchPDI = new Int32Array(n).fill(-1);
  const matchInit = new Int32Array(n).fill(-1);
  { const st: number[] = [];
    for (const i of pos) {
      const t = orig[i];
      if (t === BC.LRI || t === BC.RLI || t === BC.FSI) st.push(i);
      else if (t === BC.PDI && st.length) { const o = st.pop()!; matchPDI[o] = i; matchInit[i] = o; }
    } }

  const runs: number[][] = [];
  { let cur: number[] = [];
    for (const i of pos) {
      if (cur.length === 0 || levels[i] === levels[cur[cur.length - 1]]) cur.push(i);
      else { runs.push(cur); cur = [i]; }
    }
    if (cur.length) runs.push(cur); }
  const runByFirst = new Map<number, number>();
  runs.forEach((r, ri) => runByFirst.set(r[0], ri));

  const sequences: number[][] = [];
  const used = new Array(runs.length).fill(false);
  for (let ri = 0; ri < runs.length; ri++) {
    if (used[ri]) continue;
    const first = runs[ri][0];
    if (orig[first] === BC.PDI && matchInit[first] !== -1) continue; // continuation, not a start
    let seq: number[] = [];
    let cri = ri;
    for (;;) {
      used[cri] = true;
      seq = seq.concat(runs[cri]);
      const last = runs[cri][runs[cri].length - 1];
      const lt = orig[last];
      if ((lt === BC.LRI || lt === BC.RLI || lt === BC.FSI) && matchPDI[last] !== -1) {
        const nextRi = runByFirst.get(matchPDI[last]);
        if (nextRi === undefined || used[nextRi]) break;
        cri = nextRi;
      } else break;
    }
    sequences.push(seq);
  }

  // ── Per isolating run sequence: sos/eos then W1–W7, N0–N2, I1–I2 ──
  // sos/eos and the embedding direction depend on the *explicit* (X) levels, so
  // snapshot them — the I-rules below mutate `levels` for each sequence in turn.
  const baseLevels = Int8Array.from(levels);
  for (const seq of sequences) {
    const first = seq[0], last = seq[seq.length - 1];
    const e = dirOf(baseLevels[first]);               // sequence embedding direction (uniform level)
    const kFirst = posRank.get(first)!, kLast = posRank.get(last)!;
    const beforeLevel = kFirst > 0 ? baseLevels[pos[kFirst - 1]] : paraLevel;
    const lt = orig[last];
    const afterLevel = ((lt === BC.LRI || lt === BC.RLI || lt === BC.FSI) && matchPDI[last] === -1)
      ? paraLevel : (kLast < pos.length - 1 ? baseLevels[pos[kLast + 1]] : paraLevel);
    const sos = dirOf(Math.max(baseLevels[first], beforeLevel));
    const eos = dirOf(Math.max(baseLevels[last], afterLevel));

    // W1: NSM -> type of previous (ON after isolate/PDI; sos at start).
    for (let x = 0; x < seq.length; x++) {
      const i = seq[x];
      if (types[i] === BC.NSM) {
        if (x === 0) types[i] = sos;
        else { const pt = types[seq[x - 1]]; types[i] = (pt === BC.LRI || pt === BC.RLI || pt === BC.FSI || pt === BC.PDI) ? BC.ON : pt; }
      }
    }
    // W2: EN -> AN when the last strong type is AL.
    { let strong = sos;
      for (const i of seq) { const t = types[i]; if (t === BC.R || t === BC.L || t === BC.AL) strong = t; else if (t === BC.EN && strong === BC.AL) types[i] = BC.AN; } }
    // W3: AL -> R.
    for (const i of seq) if (types[i] === BC.AL) types[i] = BC.R;
    // W4: single ES between EN/EN -> EN; single CS between EN/EN or AN/AN -> that type.
    for (let x = 1; x < seq.length - 1; x++) {
      const t = types[seq[x]], p = types[seq[x - 1]], nx = types[seq[x + 1]];
      if (t === BC.ES && p === BC.EN && nx === BC.EN) types[seq[x]] = BC.EN;
      else if (t === BC.CS && p === nx && (p === BC.EN || p === BC.AN)) types[seq[x]] = p;
    }
    // W5: a run of ET adjacent to EN -> EN.
    for (let x = 0; x < seq.length; x++) {
      if (types[seq[x]] === BC.ET) {
        let e2 = x; while (e2 < seq.length && types[seq[e2]] === BC.ET) e2++;
        const before = x > 0 ? types[seq[x - 1]] : sos;
        const after = e2 < seq.length ? types[seq[e2]] : eos;
        if (before === BC.EN || after === BC.EN) for (let y = x; y < e2; y++) types[seq[y]] = BC.EN;
        x = e2 - 1;
      }
    }
    // W6: remaining ES/ET/CS -> ON.
    for (const i of seq) { const t = types[i]; if (t === BC.ES || t === BC.ET || t === BC.CS) types[i] = BC.ON; }
    // W7: EN -> L when the last strong type is L.
    { let strong = sos;
      for (const i of seq) { const t = types[i]; if (t === BC.R || t === BC.L) strong = t; else if (t === BC.EN && strong === BC.L) types[i] = BC.L; } }

    // N0: paired brackets (BD16).
    { const bstack: { pair: number; x: number }[] = [];
      const pairs: [number, number][] = [];
      for (let x = 0; x < seq.length; x++) {
        const i = seq[x];
        if (types[i] !== BC.ON) continue;
        const br = bracket(codes[i]);
        if (!br) continue;
        if (br.type === 0) { if (bstack.length === 63) break; bstack.push({ pair: canonBracket(br.pair), x }); }
        else { for (let s = bstack.length - 1; s >= 0; s--) { if (bstack[s].pair === canonBracket(codes[i])) { pairs.push([bstack[s].x, x]); bstack.length = s; break; } } }
      }
      pairs.sort((a, b) => a[0] - b[0]);
      const opp = e === BC.L ? BC.R : BC.L;
      for (const [ox, cx] of pairs) {
        let foundE = false, foundO = false;
        for (let x = ox + 1; x < cx; x++) { const d = strongSide(types[seq[x]]); if (d === e) { foundE = true; break; } if (d === opp) foundO = true; }
        let dir = 0;
        if (foundE) dir = e;
        else if (foundO) { let prev = sos; for (let x = ox - 1; x >= 0; x--) { const d = strongSide(types[seq[x]]); if (d === BC.L || d === BC.R) { prev = d; break; } } dir = prev === opp ? opp : e; }
        else continue;
        types[seq[ox]] = dir; types[seq[cx]] = dir;
        for (let q = ox + 1; q < seq.length && wasNSM[seq[q]]; q++) types[seq[q]] = dir;
        for (let q = cx + 1; q < seq.length && wasNSM[seq[q]]; q++) types[seq[q]] = dir;
      } }

    // N1: NI between matching strong sides -> that side.
    for (let x = 0; x < seq.length; x++) {
      if (isNI(types[seq[x]])) {
        let e2 = x; while (e2 < seq.length && isNI(types[seq[e2]])) e2++;
        const before = x > 0 ? strongSide(types[seq[x - 1]]) : sos;
        const after = e2 < seq.length ? strongSide(types[seq[e2]]) : eos;
        if (before === after && (before === BC.L || before === BC.R)) for (let y = x; y < e2; y++) types[seq[y]] = before;
        x = e2 - 1;
      }
    }
    // N2: remaining NI -> embedding direction.
    for (const i of seq) if (isNI(types[i])) types[i] = e;

    // I1/I2: implicit levels.
    for (const i of seq) {
      const t = types[i], lev = levels[i];
      if ((lev & 1) === 0) { if (t === BC.R) levels[i] = lev + 1; else if (t === BC.AN || t === BC.EN) levels[i] = lev + 2; }
      else if (t === BC.L || t === BC.EN || t === BC.AN) levels[i] = lev + 1;
    }
  }

  // L1: reset segment/paragraph separators, any preceding run of whitespace/
  // isolate-formatting/removed characters, and such a run at end of line, to the
  // paragraph level. Uses original types. (For our per-line pipeline paragraph = line.)
  const l1Reset = (t: number) =>
    t === BC.WS || t === BC.FSI || t === BC.LRI || t === BC.RLI || t === BC.PDI || isRemovedByX9(t);
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const t = orig[i];
    if (t === BC.B || t === BC.S) {
      levels[i] = paraLevel;
      for (let k = i - 1; k >= 0 && l1Reset(orig[k]); k--) levels[k] = paraLevel;
    }
    if (l1Reset(t)) { if (runStart < 0) runStart = i; } else runStart = -1;
  }
  if (runStart >= 0) for (let k = runStart; k < n; k++) levels[k] = paraLevel;

  return { levels, removed };
}

/** UAX #9 L2 reordering over already-resolved levels (L1 is applied by
 *  resolveLevels). Returns visual-order indices, excluding X9-removed chars.
 *  `codes`/`paraLevel` are accepted for a stable signature; only levels/removed
 *  are used. */
export function reorder(codes: number[], levels: Int8Array, removed: boolean[], paraLevel: 0 | 1): number[] {
  void codes; void paraLevel;
  // L2: reverse contiguous runs from the highest level down to the lowest odd level.
  const order: number[] = [];
  for (let i = 0; i < levels.length; i++) if (!removed[i]) order.push(i);
  let hi = 0;
  for (const i of order) if (levels[i] > hi) hi = levels[i];
  for (let level = hi; level >= 1; level--) {
    let s = 0;
    while (s < order.length) {
      if (levels[order[s]] < level) { s++; continue; }
      let e = s;
      while (e < order.length && levels[order[e]] >= level) e++;
      for (let a = s, b = e - 1; a < b; a++, b--) { const t = order[a]; order[a] = order[b]; order[b] = t; }
      s = e;
    }
  }
  return order;
}

/** Convenience: paragraphLevel → resolveLevels → reorder for one line. */
export function reorderLine(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): { paraLevel: 0 | 1; levels: Int8Array; removed: boolean[]; order: number[] } {
  const paraLevel = paragraphLevel(codes, dir);
  const { levels, removed } = resolveLevels(codes, paraLevel);
  const order = reorder(codes, levels, removed, paraLevel);
  return { paraLevel, levels, removed, order };
}

/** Split a code-point run into maximal same-script segments, folding Common/
 *  Inherited into the running script. Each segment carries its OpenType script
 *  tag and direction. `end` is exclusive. */
export function itemizeScripts(codes: number[]): { start: number; end: number; script: number; otTag: string; rtl: boolean }[] {
  const segs: { start: number; end: number; script: number; otTag: string; rtl: boolean }[] = [];
  if (codes.length === 0) return segs;
  let cur = -1, start = 0;
  const push = (s: number, e: number, sc: number) => { const { tag, rtl } = scriptTag(sc); segs.push({ start: s, end: e, script: sc, otTag: tag, rtl }); };
  for (let i = 0; i < codes.length; i++) {
    let s = script(codes[i]);
    if ((s === COMMON || s === INHERITED) && cur >= 0) s = cur;   // fold into running script
    if (cur < 0) { cur = s; start = i; continue; }
    if (s !== cur) { push(start, i, cur); cur = s; start = i; }
  }
  push(start, codes.length, cur < 0 ? script(codes[0]) : cur);
  return segs;
}

/** Arabic cursive joining forms over codes[start..end). Returns the joining
 *  feature to enable per position (null for Transparent marks). Joining_Type:
 *  R joins right (previous), L joins left (next), D both, C join-causing, U none,
 *  T transparent (skipped). */
export function arabicJoiningForms(codes: number[], start: number, end: number): ('isol' | 'init' | 'medi' | 'fina' | null)[] {
  const n = end - start;
  const jt = (i: number) => joiningType(codes[start + i]);
  const out: ('isol' | 'init' | 'medi' | 'fina' | null)[] = new Array(n).fill(null);
  const prevJoin = new Array(n).fill(false);   // connects to the previous non-transparent letter
  const nextJoin = new Array(n).fill(false);   // connects to the next non-transparent letter
  // previous non-transparent index for each position
  const prevIdx = new Array(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) { prevIdx[i] = last; if (jt(i) !== JT.T) last = i; }
  for (let i = 0; i < n; i++) {
    if (jt(i) === JT.T) continue;
    const p = prevIdx[i];
    const joinsRight = jt(i) === JT.D || jt(i) === JT.R || jt(i) === JT.C; // can attach to previous
    if (p >= 0 && joinsRight) {
      const pj = jt(p);
      if (pj === JT.D || pj === JT.L || pj === JT.C) { prevJoin[i] = true; nextJoin[p] = true; }
    }
  }
  for (let i = 0; i < n; i++) {
    if (jt(i) === JT.T) continue;
    out[i] = prevJoin[i] && nextJoin[i] ? 'medi' : prevJoin[i] ? 'fina' : nextJoin[i] ? 'init' : 'isol';
  }
  return out;
}
