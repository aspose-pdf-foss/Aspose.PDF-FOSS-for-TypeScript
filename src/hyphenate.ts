// Opt-in hyphenation (v9j3.2): Liang's algorithm over the bundled TeX patterns.
// A pure leaf — `hyphdata.js`, `langmatch.js` and `node:zlib` only — so every
// rule is testable from words with no PDF built. Never throws after
// `resolveHyphenation`.
import { inflateRawSync } from 'node:zlib';
import { HYPH_LANGUAGES, type HyphLanguage } from './hyphdata.js';
import { langMatches } from './langmatch.js';

/** Options for opt-in hyphenation. */
export interface HyphenationOptions {
  /** BCP 47 tag ('en', 'de-AT', 'pt-BR'). Required for 'auto'. */
  lang?: string;
  /** 'auto' (patterns + soft hyphens, default) or 'manual' (soft hyphens only). */
  mode?: 'auto' | 'manual';
  /** Fewest letters before a break. Default: the language's own. */
  minLeft?: number;
  /** Fewest letters after a break. Default: the language's own. */
  minRight?: number;
  /** Shortest word ever split, in letters. Default 5. */
  minWord?: number;
}

/** @internal Validated options. */
export interface ResolvedHyphenation {
  tag: string | undefined;
  mode: 'auto' | 'manual';
  minLeft: number;
  minRight: number;
  minWord: number;
}

/** @internal Where a word may break. */
export interface Hyphenator {
  /** Ascending code-unit offsets `p`, 0 < p < word.length: a hyphen may go
   *  between `word[p - 1]` and `word[p]`. */
  points(word: string): readonly number[];
}

const SHY = '­';

/** The language tags the bundled tables answer for. */
export function hyphenationLanguages(): string[] {
  return HYPH_LANGUAGES.map((l) => l.tag);
}

/** The table a tag selects: exact (any case), then a table whose tag is a
 *  range over it ('de' for 'de-AT'), then one it is a range over ('en' finds
 *  en-US, the first listed) — RFC 4647 through `langmatch.ts` — and last the
 *  first table of the same primary language, so an unlisted region of a
 *  bundled language ('en-AU', 'en-CA') hyphenates rather than throwing. */
function findTable(lang: string): HyphLanguage | undefined {
  const lower = lang.toLowerCase();
  const primary = lower.split('-')[0];
  return HYPH_LANGUAGES.find((l) => l.tag.toLowerCase() === lower)
    ?? HYPH_LANGUAGES.find((l) => langMatches(lang, l.tag))
    ?? HYPH_LANGUAGES.find((l) => langMatches(l.tag, lang))
    ?? HYPH_LANGUAGES.find((l) => l.tag.toLowerCase().split('-')[0] === primary);
}

const checkMin = (name: string, v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`hyphenate.${name} must be an integer`);
  if (v < 1) throw new RangeError(`hyphenate.${name} must be at least 1`);
  return v;
};

/** @internal Validate `o` — TypeError for the wrong kind, RangeError outside
 *  the allowed set — and resolve its defaults. `fallbackLang` is a flow's own
 *  `lang`, used when `o` states none. */
export function resolveHyphenation(o: unknown, fallbackLang?: string): ResolvedHyphenation {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError('hyphenate must be an object');
  const h = o as HyphenationOptions;
  if (h.lang !== undefined && typeof h.lang !== 'string') throw new TypeError('hyphenate.lang must be a string');
  const mode = h.mode ?? 'auto';
  if (mode !== 'auto' && mode !== 'manual') throw new RangeError("hyphenate.mode must be 'auto' or 'manual'");
  const minLeft = checkMin('minLeft', h.minLeft), minRight = checkMin('minRight', h.minRight);
  const minWord = checkMin('minWord', h.minWord) ?? 5;
  const lang = h.lang ?? fallbackLang;
  if (mode === 'manual') {
    return { tag: undefined, mode, minLeft: minLeft ?? 1, minRight: minRight ?? 1, minWord };
  }
  if (lang === undefined || lang === '') throw new RangeError("hyphenate.lang is required for mode 'auto'");
  const table = findTable(lang);
  if (!table) {
    throw new RangeError(`hyphenate.lang '${lang}' has no bundled patterns (bundled: ${hyphenationLanguages().join(', ')})`);
  }
  return { tag: table.tag, mode, minLeft: minLeft ?? table.left, minRight: minRight ?? table.right, minWord };
}

/** Lower-case one code unit at a time, keeping any whose lower case changes
 *  length ('İ'), so offsets in the result are offsets in the input. */
const lowerSameLength = (s: string): string => {
  let out = '';
  for (const ch of s) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
};

/** `alpha`: every non-letter character the patterns themselves use — the
 *  apostrophe of a French or Italian elision. */
interface Table { pats: Map<string, Uint8Array>; maxLen: number; exc: Map<string, number[]>; alpha: Set<string> }
const tables = new Map<string, Table>();

/** Inflate and parse a language once. A pattern `.ach4` becomes key `.ach`
 *  with levels [0,0,0,0,4]: one level per gap, before each letter and after
 *  the last. An exception `as-so-ciate` becomes `associate` -> [2, 4]. */
function load(tag: string): Table {
  const hit = tables.get(tag);
  if (hit) return hit;
  const l = HYPH_LANGUAGES.find((x) => x.tag === tag)!;
  const [p, e = ''] = inflateRawSync(Buffer.from(l.data, 'base64')).toString('utf8').split('\n---\n');
  const pats = new Map<string, Uint8Array>();
  const alpha = new Set<string>();
  let maxLen = 0;
  for (const tok of p.split(' ')) {
    if (!tok) continue;
    let key = '';
    const levels: number[] = [0];
    for (const ch of tok) {
      if (ch >= '0' && ch <= '9') levels[levels.length - 1] = ch.charCodeAt(0) - 48;
      else { key += ch; levels.push(0); if (ch !== '.' && !LETTER.test(ch)) alpha.add(ch); }
    }
    pats.set(key, Uint8Array.from(levels));
    maxLen = Math.max(maxLen, key.length);
  }
  const exc = new Map<string, number[]>();
  for (const tok of e.split(' ')) {
    if (!tok) continue;
    const pts: number[] = [];
    let word = '';
    for (const ch of tok) { if (ch === '-') pts.push(word.length); else word += ch; }
    exc.set(lowerSameLength(word), pts);
  }
  const t = { pats, maxLen, exc, alpha };
  tables.set(tag, t);
  return t;
}

/** Break points inside `core` (all letters, lower-cased), by Liang. */
function liang(t: Table, core: string): number[] {
  const dotted = `.${core}.`;
  const levels = new Uint8Array(dotted.length + 1);
  for (let i = 0; i < dotted.length; i++) {
    for (let j = i + 1; j <= Math.min(dotted.length, i + t.maxLen); j++) {
      const pat = t.pats.get(dotted.slice(i, j));
      if (!pat) continue;
      for (let k = 0; k < pat.length; k++) if (pat[k] > levels[i + k]) levels[i + k] = pat[k];
    }
  }
  // Gap q (between core[q - 1] and core[q]) is dotted gap q + 1.
  const out: number[] = [];
  for (let q = 1; q < core.length; q++) if (levels[q + 1] % 2 === 1) out.push(q);
  return out;
}

const LETTER = /[\p{L}\p{M}]/u;
const MEMO_CAP = 20000;
const cache = new Map<string, Hyphenator>();

/** @internal The hyphenator for `r`, one per distinct resolved options, with a
 *  per-word memo: a word re-tried on every page of a long paragraph is
 *  analysed once. */
export function hyphenator(r: ResolvedHyphenation): Hyphenator {
  const key = `${r.tag}|${r.mode}|${r.minLeft}|${r.minRight}|${r.minWord}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const memo = new Map<string, readonly number[]>();
  const h: Hyphenator = {
    points(word) {
      const m = memo.get(word);
      if (m) return m;
      // Soft hyphens: a break after each, and out of the pattern match.
      const soft: number[] = [];
      const at: number[] = [];      // stripped index -> word index
      let stripped = '';
      for (let i = 0; i < word.length; i++) {
        if (word[i] === SHY) { if (i + 1 < word.length && i > 0) soft.push(i + 1); continue; }
        at.push(i);
        stripped += word[i];
      }
      const pts = new Set(soft);
      if (r.mode === 'auto' && r.tag !== undefined) {
        let a = 0, b = stripped.length;
        while (a < b && !LETTER.test(stripped[a])) a++;
        while (b > a && !LETTER.test(stripped[b - 1])) b--;
        const core = stripped.slice(a, b);
        if (core.length >= r.minWord) {
          // An exception is a statement about one word and wins outright, even
          // for a word the letters-only rule would refuse (an apostrophe).
          const t = load(r.tag);
          const lc = lowerSameLength(core);
          // (v9j3.2 review) A character the language's own patterns use counts
          // as part of the word: fr and it ship patterns for elisions, so
          // l’organisation hyphenates as the pattern authors meant.
          const qs = t.exc.get(lc) ?? ([...core].every((ch) => LETTER.test(ch) || t.alpha.has(ch)) ? liang(t, lc) : []);
          for (const q of qs) {
            // minLeft counts from the start of the segment the break falls in:
            // after an elision's apostrophe the elided word is the word, so
            // `l’u-niversità` is refused as `u-niversità` would be. Matches the
            // independent oracle (hyphen@1.14.1) on every elided golden.
            let seg = 0;
            for (let i = 0; i < q; i++) if (!LETTER.test(core[i])) seg = i + 1;
            if (q - seg >= r.minLeft && core.length - q >= r.minRight) pts.add(at[a + q]);
          }
        }
      }
      const out = [...pts].sort((x, y) => x - y);
      if (memo.size >= MEMO_CAP) memo.clear();
      memo.set(word, out);
      return out;
    },
  };
  cache.set(key, h);
  return h;
}
