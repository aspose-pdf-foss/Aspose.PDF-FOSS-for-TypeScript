# Opt-in Hyphenation (v9j3.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `AddTextBlock`, Flow paragraphs/lists, table cells and Markdown break a word across lines with a drawn hyphen, from Liang patterns for nine languages, opt-in and byte-identical when off.

**Architecture:** A generator writes `src/hyphdata.ts` (nine deflated pattern tables pinned to tex-hyphen). A pure leaf `src/hyphenate.ts` validates options and turns a word into break offsets. `layout.ts`'s one wrapping engine takes an optional `Hyphenator`; when absent no new code runs. The option is threaded through `stamp.ts`, `flow.ts`, `tableauthor.ts`/`tablerender.ts` and `mdflow.ts`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest, `node:zlib`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-hyphenation-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins. `hyphen@1.14.1` is used ONLY by a generator script, fetched with `npm pack` into a temp dir — never added to `package.json`.
- Pattern source pinned to tex-hyphen commit `5684c0f51c0b81133db2efbe60a408b4155a3ff5`.
- Bundled tags, in this order: `en-US`, `en-GB`, `de`, `fr`, `es`, `it`, `nl`, `pt`, `pl`. Files: `hyph-en-us`, `hyph-en-gb`, `hyph-de-1996`, `hyph-fr`, `hyph-es`, `hyph-it`, `hyph-nl`, `hyph-pt`, `hyph-pl`. Russian is NOT bundled (LPPL only).
- `minWord` default 5; `minLeft`/`minRight` default to the language's `hyphenmins`.
- With hyphenation absent, output is byte-identical: `test/rich-runs-identity.test.ts`, `test/html-identity.test.ts`, `test/markdown-flow.test.ts`, `test/docx-flow-identity.test.ts` must pass UNEDITED.
- `TypeError` for the wrong kind of value, `RangeError` for a value outside the allowed set. All validation before any page is touched; layout never throws for hyphenation.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- The hyphen is U+002D. Soft hyphen is U+00AD.
- Every new export gets a README API Reference row (`test/readme-api.test.ts`); CHANGELOG entry under `## [Unreleased]` → `### Added`.
- Run `npm run typecheck` and `npm test` before closing.

## Deviations from the spec, stated

- Table cells take `hyphenate` through their own table → row → cell cascade
  (`CellTextOptions`), not "the way they take the paragraph's options" — cells do
  not take paragraph options at all. A flow-wide default does NOT reach a table;
  a table states it in `createTable({ hyphenate })`. Markdown does pass it to its
  tables.
- The extra outside anchor the spec left open is `hyphen@1.14.1` (Task 3).

## Review Focus

1. **A word wider than the whole box in a hyphenating block** — it should hyphenate at pattern points with drawn hyphens before falling back to the plain UAX #14 split. Covered in Task 4.
2. **A paragraph that hyphenates across a page break** — the remainder starts mid-word and the next page must continue the word without re-drawing the head. Covered in Task 4 (remainder test) and Task 6 (Flow two-page test).
3. **Text containing soft hyphens with hyphenation OFF** — must be byte-identical to today (0xAD drawn). Covered in Task 5.
4. **A language tag with a region or different case (`EN-us`, `de-AT`, `pt-BR`)** — must resolve to the bundled table; an unknown one (`ru`) must throw `RangeError` at option time, not draw silently. Covered in Task 2.
5. **Punctuation and capitals around a word (`“Hyphenation,”`)** — punctuation never hyphenates and capitals match lower-case patterns. Covered in Task 2.

---

### Task 1: Pattern data generator and `src/hyphdata.ts`

**Files:**
- Create: `scripts/gen-hyphenation.mjs`
- Create (generated): `src/hyphdata.ts`
- Create: `test/fixtures/hyphenation/PROVENANCE.md`
- Modify: `package.json` (add `"gen:hyph": "node scripts/gen-hyphenation.mjs"` after `gen:zip`)
- Test: `test/hyphdata.test.ts`

**Interfaces:**
- Produces: `src/hyphdata.ts` exporting
  ```ts
  export interface HyphLanguage { tag: string; left: number; right: number; licence: string; data: string }
  export const HYPH_LANGUAGES: readonly HyphLanguage[];
  ```
  `data` is base64 of `deflateRawSync(patterns + '\n---\n' + exceptions)` where both halves are whitespace-separated tokens exactly as in `hyph-<f>.pat.txt` / `.hyp.txt`.

- [ ] **Step 1: Write the generator**

```js
// scripts/gen-hyphenation.mjs — regenerate src/hyphdata.ts (v9j3.2).
// Not run by `npm test`. Re-run only when PIN moves.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const PIN = '5684c0f51c0b81133db2efbe60a408b4155a3ff5';
const BASE = `https://raw.githubusercontent.com/hyphenation/tex-hyphen/${PIN}/hyph-utf8/tex/generic/hyph-utf8/patterns`;
const LANGS = [
  ['en-US', 'en-us'], ['en-GB', 'en-gb'], ['de', 'de-1996'], ['fr', 'fr'], ['es', 'es'],
  ['it', 'it'], ['nl', 'nl'], ['pt', 'pt'], ['pl', 'pl'],
];

async function get(url, optional = false) {
  const r = await fetch(url);
  if (r.status === 404 && optional) return '';
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return await r.text();
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The header block from `% copyright:` up to `% hyphenmins:`, verbatim. */
function licenceBlock(tex) {
  const lines = tex.split('\n');
  const a = lines.findIndex((l) => /^%\s*copyright:/.test(l));
  const b = lines.findIndex((l) => /^%\s*hyphenmins:/.test(l));
  if (a < 0) throw new Error('no copyright line');
  return lines.slice(a, b > a ? b : a + 40).join('\n');
}
/** hyphenmins left/right — the `typesetting:` block when present, else the first. */
function mins(tex) {
  const i = tex.search(/^%\s*hyphenmins:/m);
  if (i < 0) throw new Error('no hyphenmins');
  let s = tex.slice(i, i + 600);
  const t = s.search(/typesetting:/);
  if (t >= 0) s = s.slice(t);
  const left = Number(/left:\s*(\d+)/.exec(s)?.[1]);
  const right = Number(/right:\s*(\d+)/.exec(s)?.[1]);
  if (!(left > 0 && right > 0)) throw new Error('bad hyphenmins');
  return { left, right };
}

const out = [];
const prov = [];
for (const [tag, file] of LANGS) {
  const pat = await get(`${BASE}/txt/hyph-${file}.pat.txt`);
  const hyp = await get(`${BASE}/txt/hyph-${file}.hyp.txt`, true);
  const tex = await get(`${BASE}/tex/hyph-${file}.tex`);
  const { left, right } = mins(tex);
  const payload = pat.trim().split(/\s+/).join(' ') + '\n---\n' + hyp.trim().split(/\s+/).filter(Boolean).join(' ');
  const data = deflateRawSync(Buffer.from(payload, 'utf8'), { level: 9 }).toString('base64');
  out.push({ tag, left, right, licence: licenceBlock(tex), data });
  prov.push(`| ${tag} | hyph-${file} | ${sha(pat)} | ${hyp ? sha(hyp) : '—'} | ${sha(tex)} | ${left}/${right} |`);
  console.log(tag, pat.length, 'bytes of patterns ->', data.length, 'base64');
}

const ts = `// GENERATED by scripts/gen-hyphenation.mjs from hyphenation/tex-hyphen@${PIN}.
// Do not edit. Each entry carries its own copyright and licence, verbatim from
// the source file's header, as its licence requires.

export interface HyphLanguage {
  /** BCP 47 tag this table answers for. */
  tag: string;
  /** \`hyphenmins\`: letters kept before / after a break. */
  left: number;
  right: number;
  /** Copyright and licence block from the source file, verbatim. */
  licence: string;
  /** base64 of deflateRaw('<patterns>\\n---\\n<exceptions>'). */
  data: string;
}

export const HYPH_LANGUAGES: readonly HyphLanguage[] = ${JSON.stringify(out, null, 2)};
`;
writeFileSync('src/hyphdata.ts', ts);
console.log('\nPROVENANCE rows:\n| Tag | File | .pat.txt SHA-256 | .hyp.txt SHA-256 | .tex SHA-256 | min L/R |\n|---|---|---|---|---|---|\n' + prov.join('\n'));
```

- [ ] **Step 2: Run it and add the script entry**

Add `"gen:hyph": "node scripts/gen-hyphenation.mjs",` to `package.json` `scripts`, after `"gen:zip"`.
Run: `npm run gen:hyph`
Expected: nine `<tag> <n> bytes of patterns -> <m> base64` lines, `src/hyphdata.ts` written, and a PROVENANCE table printed.

- [ ] **Step 3: Write `test/fixtures/hyphenation/PROVENANCE.md`**

Use the printed table. Content:

```markdown
# Hyphenation patterns — provenance

`src/hyphdata.ts` is generated by `scripts/gen-hyphenation.mjs` (`npm run gen:hyph`)
from **hyphenation/tex-hyphen** at commit `5684c0f51c0b81133db2efbe60a408b4155a3ff5`
(2026-02-24), files under `hyph-utf8/tex/generic/hyph-utf8/patterns/{txt,tex}/`.

<paste the printed table here>

Licences (from each file's own header, carried verbatim in `hyphdata.ts`):
en-US all-permissive (G. D. C. Kuiken); en-GB, de, fr, es, nl MIT; it and pl
dual-licensed, taken under MIT; pt BSD-3-Clause.

**Not bundled:** Russian (`hyph-ru`) is LPPL only; converting it into a generated
table is a modification LPPL conditions, so it is left out.

`test/fixtures/hyphenation/goldens.json` (Task 3) is produced by a DIFFERENT Liang
implementation, `hyphen@1.14.1` (npm, MIT, ytiurin/hyphen) over ITS OWN bundled copy
of the CTAN patterns, so agreement is evidence from outside our engine — but not
from outside the pattern data, which both ultimately share.
```

- [ ] **Step 4: Write the failing test**

```ts
// test/hyphdata.test.ts
import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { HYPH_LANGUAGES } from '../src/hyphdata.js';

describe('hyphdata (v9j3.2)', () => {
  it('bundles exactly the nine starter languages, in order', () => {
    expect(HYPH_LANGUAGES.map((l) => l.tag)).toEqual(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl']);
  });

  it('carries each source licence and positive hyphenmins', () => {
    for (const l of HYPH_LANGUAGES) {
      expect(l.licence).toMatch(/copyright/i);
      expect(l.left).toBeGreaterThan(0);
      expect(l.right).toBeGreaterThan(0);
    }
    expect(HYPH_LANGUAGES.find((l) => l.tag === 'en-US')!.right).toBe(3);
  });

  it('decodes to Liang patterns and an exception list', () => {
    for (const l of HYPH_LANGUAGES) {
      const [pats, exc] = inflateRawSync(Buffer.from(l.data, 'base64')).toString('utf8').split('\n---\n');
      expect(pats.split(' ').length).toBeGreaterThan(100);
      expect(pats).toMatch(/\d/);
      expect(exc).toBeDefined();
    }
    const en = inflateRawSync(Buffer.from(HYPH_LANGUAGES[0].data, 'base64')).toString('utf8');
    expect(en.split('\n---\n')[1]).toMatch(/-/);   // en-US ships exceptions
  });
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run test/hyphdata.test.ts`
Expected: PASS (the data was generated in Step 2).

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-hyphenation.mjs src/hyphdata.ts test/fixtures/hyphenation/PROVENANCE.md test/hyphdata.test.ts package.json
git commit -m "feat(v9j3.2): bundled hyphenation patterns for nine languages"
```

---

### Task 2: The Liang engine — `src/hyphenate.ts`

**Files:**
- Create: `src/hyphenate.ts`
- Test: `test/hyphenate.test.ts`

**Interfaces:**
- Consumes: `HYPH_LANGUAGES` (Task 1); `langMatches(tag, range)` from `src/langmatch.ts` (true when `range` matches `tag`).
- Produces:
  ```ts
  export interface HyphenationOptions { lang?: string; mode?: 'auto' | 'manual'; minLeft?: number; minRight?: number; minWord?: number }
  export interface ResolvedHyphenation { tag: string | undefined; mode: 'auto' | 'manual'; minLeft: number; minRight: number; minWord: number }
  export interface Hyphenator { points(word: string): readonly number[] }
  export function resolveHyphenation(o: unknown, fallbackLang?: string): ResolvedHyphenation; // throws TypeError/RangeError
  export function hyphenator(r: ResolvedHyphenation): Hyphenator;   // cached per resolved options
  export function hyphenationLanguages(): string[];
  ```
  `points(word)` returns ascending code-unit offsets `p` with `0 < p < word.length`: a hyphen may be drawn between `word[p - 1]` and `word[p]`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/hyphenate.test.ts
import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { HYPH_LANGUAGES } from '../src/hyphdata.js';
import { resolveHyphenation, hyphenator, hyphenationLanguages } from '../src/hyphenate.js';

const hy = (o: object) => hyphenator(resolveHyphenation(o));
/** The word with a '-' at each point. */
const show = (o: object, w: string) => {
  const pts = hy(o).points(w);
  let s = '', at = 0;
  for (const p of pts) { s += w.slice(at, p) + '-'; at = p; }
  return s + w.slice(at);
};

describe('resolveHyphenation (v9j3.2)', () => {
  it('lists the nine bundled languages', () => {
    expect(hyphenationLanguages()).toEqual(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl']);
  });

  it('matches a tag by RFC 4647, any case', () => {
    expect(resolveHyphenation({ lang: 'EN-us' }).tag).toBe('en-US');
    expect(resolveHyphenation({ lang: 'en' }).tag).toBe('en-US');
    expect(resolveHyphenation({ lang: 'de-AT' }).tag).toBe('de');
    expect(resolveHyphenation({ lang: 'pt-BR' }).tag).toBe('pt');
  });

  it('defaults the minimums to the language and minWord to 5', () => {
    expect(resolveHyphenation({ lang: 'en' })).toEqual({ tag: 'en-US', mode: 'auto', minLeft: 2, minRight: 3, minWord: 5 });
  });

  it('takes the fallback lang when none is stated', () => {
    expect(resolveHyphenation({}, 'fr').tag).toBe('fr');
    expect(resolveHyphenation({ lang: 'de' }, 'fr').tag).toBe('de');
  });

  it('refuses the wrong kind of value with TypeError', () => {
    expect(() => resolveHyphenation(null)).toThrow(TypeError);
    expect(() => resolveHyphenation({ lang: 5 })).toThrow(TypeError);
    expect(() => resolveHyphenation({ lang: 'en', minLeft: 1.5 })).toThrow(TypeError);
  });

  it('refuses a value outside the set with RangeError', () => {
    expect(() => resolveHyphenation({ lang: 'ru' })).toThrow(RangeError);
    expect(() => resolveHyphenation({})).toThrow(RangeError);              // auto needs a lang
    expect(() => resolveHyphenation({ lang: 'en', mode: 'full' })).toThrow(RangeError);
    expect(() => resolveHyphenation({ lang: 'en', minWord: 0 })).toThrow(RangeError);
  });

  it('lets manual mode take any lang or none', () => {
    expect(resolveHyphenation({ mode: 'manual' })).toMatchObject({ mode: 'manual', tag: undefined });
    expect(resolveHyphenation({ mode: 'manual', lang: 'ru' }).mode).toBe('manual');
  });
});

describe('hyphenator (v9j3.2)', () => {
  it("reproduces the hyphen package README's published examples", () => {
    // https://github.com/ytiurin/hyphen README — an independent implementation.
    expect(show({ lang: 'en-US' }, 'certain')).toBe('cer-tain');
    expect(show({ lang: 'en-US' }, 'beautiful')).toBe('beau-ti-ful');
    expect(['gewisser', 'König', 'hatte', 'wunderschönen', 'Garten'].map((w) => show({ lang: 'de' }, w)))
      .toEqual(['ge-wis-ser', 'Kö-nig', 'hat-te', 'wun-der-schö-nen', 'Gar-ten']);
  });

  it('returns every bundled exception exactly as listed', () => {
    for (const l of HYPH_LANGUAGES) {
      const exc = inflateRawSync(Buffer.from(l.data, 'base64')).toString('utf8').split('\n---\n')[1];
      for (const e of exc.split(' ').filter(Boolean)) {
        const word = e.replace(/-/g, '');
        const lim = { lang: l.tag, minLeft: 1, minRight: 1, minWord: 1 };
        expect(show(lim, word)).toBe(e);
      }
    }
  });

  it('hyphenates only the letters, matching capitals in lower case', () => {
    expect(show({ lang: 'en' }, '“Beautiful,”')).toBe('“Beau-ti-ful,”');
  });

  it('respects minLeft, minRight and minWord', () => {
    expect(show({ lang: 'en', minLeft: 5 }, 'beautiful')).toBe('beauti-ful');
    expect(show({ lang: 'en', minRight: 4 }, 'beautiful')).toBe('beau-tiful');
    expect(show({ lang: 'en', minWord: 10 }, 'beautiful')).toBe('beautiful');
  });

  it('leaves a word with an inner non-letter to its soft hyphens', () => {
    expect(hy({ lang: 'en' }).points('e-mail1234')).toEqual([]);
  });

  it('honours soft hyphens in both modes, and patterns only in auto', () => {
    const w = 'hy­phenation';
    expect(hy({ mode: 'manual' }).points(w)).toEqual([3]);
    const auto = hy({ lang: 'en' }).points(w);
    expect(auto).toContain(3);
    expect(auto.length).toBeGreaterThan(1);
  });

  it('caches the hyphenator for identical options', () => {
    expect(hy({ lang: 'en' })).toBe(hy({ lang: 'en-US' }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hyphenate.test.ts`
Expected: FAIL — `Cannot find module '../src/hyphenate.js'`.

- [ ] **Step 3: Implement**

```ts
// src/hyphenate.ts
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
 *  en-US, the first listed). RFC 4647 through `langmatch.ts`. */
function findTable(lang: string): HyphLanguage | undefined {
  const lower = lang.toLowerCase();
  return HYPH_LANGUAGES.find((l) => l.tag.toLowerCase() === lower)
    ?? HYPH_LANGUAGES.find((l) => langMatches(lang, l.tag))
    ?? HYPH_LANGUAGES.find((l) => langMatches(l.tag, lang));
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

interface Table { pats: Map<string, Uint8Array>; maxLen: number; exc: Map<string, number[]> }
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
  let maxLen = 0;
  for (const tok of p.split(' ')) {
    if (!tok) continue;
    let key = '';
    const levels: number[] = [0];
    for (const ch of tok) {
      if (ch >= '0' && ch <= '9') levels[levels.length - 1] = ch.charCodeAt(0) - 48;
      else { key += ch; levels.push(0); }
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
  const t = { pats, maxLen, exc };
  tables.set(tag, t);
  return t;
}

/** Lower-case one code unit at a time, keeping any whose lower case changes
 *  length ('İ'), so offsets in the result are offsets in the input. */
const lowerSameLength = (s: string): string => {
  let out = '';
  for (const ch of s) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
};

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

const LETTERS = /^[\p{L}\p{M}]+$/u;
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
          const qs = t.exc.get(lc) ?? (LETTERS.test(core) ? liang(t, lc) : []);
          for (const q of qs) {
            if (q >= r.minLeft && core.length - q >= r.minRight) pts.add(at[a + q]);
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/hyphenate.test.ts`
Expected: PASS. If an exception word fails, print it and the pattern output: a mismatch means the exception parse or the offset mapping is wrong — fix the code, never the expectation (the exception list is the oracle).

- [ ] **Step 5: Commit**

```bash
git add src/hyphenate.ts test/hyphenate.test.ts
git commit -m "feat(v9j3.2): Liang hyphenation engine"
```

---

### Task 3: Goldens from an independent implementation

**Files:**
- Create: `scripts/gen-hyphenation-goldens.mjs`
- Create (generated): `test/fixtures/hyphenation/goldens.json`
- Modify: `test/fixtures/hyphenation/PROVENANCE.md` (add the goldens section)
- Test: `test/hyphenate-goldens.test.ts`

**Interfaces:**
- Consumes: `resolveHyphenation`, `hyphenator` (Task 2).
- Produces: `goldens.json` = `{ "<tag>": { "<word>": "<word hyphenated with '-' by hyphen@1.14.1>" } }`.

- [ ] **Step 1: Write the generator**

```js
// scripts/gen-hyphenation-goldens.mjs — goldens from hyphen@1.14.1, an
// independent Liang implementation (npm, MIT). NOT a dependency: fetched with
// `npm pack` into a temp dir. Not run by `npm test`.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'hyphen-'));
execSync('npm pack hyphen@1.14.1 --silent', { cwd: dir });
execSync('tar xzf hyphen-1.14.1.tgz', { cwd: dir });
const require = createRequire(join(dir, 'package', 'x.js'));
const createHyphenator = require('./hyphen.js');

const FILES = { 'en-US': 'en-us', 'en-GB': 'en-gb', de: 'de-1996', fr: 'fr', es: 'es', it: 'it', nl: 'nl', pt: 'pt', pl: 'pl' };
// Long words, so each has several points. The list is not an authority — the
// oracle decides the expected hyphenation.
const WORDS = {
  'en-US': ['hyphenation', 'beautiful', 'certain', 'algorithm', 'documentation', 'information', 'representation', 'possibility', 'communication', 'international', 'mathematics', 'environment', 'responsibility', 'understanding', 'development', 'organization', 'everything', 'performance', 'independent', 'relationship'],
  'en-GB': ['hyphenation', 'beautiful', 'colour', 'organisation', 'programme', 'favourite', 'centimetre', 'behaviour', 'neighbourhood', 'recognise', 'catalogue', 'labourer', 'documentation', 'responsibility', 'international'],
  de: ['gewisser', 'König', 'hatte', 'wunderschönen', 'Garten', 'Silbentrennung', 'Donaudampfschifffahrt', 'Rechtsschutzversicherung', 'Bundesverfassungsgericht', 'Zusammenarbeit', 'Verantwortung', 'Entwicklung', 'Wissenschaft', 'Gesellschaft', 'Unabhängigkeit'],
  fr: ['hyphénation', 'développement', 'gouvernement', 'international', 'responsabilité', 'compréhension', 'extraordinaire', 'indépendance', 'communication', 'mathématiques', 'environnement', 'connaissance', 'représentation', 'possibilité', 'organisation'],
  es: ['separación', 'desarrollo', 'gobierno', 'internacional', 'responsabilidad', 'comprensión', 'extraordinario', 'independencia', 'comunicación', 'matemáticas', 'conocimiento', 'representación', 'posibilidad', 'organización', 'universidad'],
  it: ['sillabazione', 'sviluppo', 'governo', 'internazionale', 'responsabilità', 'comprensione', 'straordinario', 'indipendenza', 'comunicazione', 'matematica', 'conoscenza', 'rappresentazione', 'possibilità', 'organizzazione', 'università'],
  nl: ['woordafbreking', 'ontwikkeling', 'regering', 'internationaal', 'verantwoordelijkheid', 'begrijpen', 'buitengewoon', 'onafhankelijkheid', 'communicatie', 'wiskunde', 'kennis', 'vertegenwoordiging', 'mogelijkheid', 'organisatie', 'universiteit'],
  pt: ['hifenização', 'desenvolvimento', 'governo', 'internacional', 'responsabilidade', 'compreensão', 'extraordinário', 'independência', 'comunicação', 'matemática', 'conhecimento', 'representação', 'possibilidade', 'organização', 'universidade'],
  pl: ['przenoszenie', 'rozwój', 'rząd', 'międzynarodowy', 'odpowiedzialność', 'zrozumienie', 'nadzwyczajny', 'niepodległość', 'komunikacja', 'matematyka', 'wiedza', 'przedstawienie', 'możliwość', 'organizacja', 'uniwersytet'],
};

const out = {};
for (const [tag, file] of Object.entries(FILES)) {
  const h = createHyphenator(require(`./patterns/${file}.js`), { hyphenChar: '-', minWordLength: 1 });
  out[tag] = Object.fromEntries(WORDS[tag].map((w) => [w, h(w)]));
}
writeFileSync('test/fixtures/hyphenation/goldens.json', JSON.stringify(out, null, 2) + '\n');
console.log('wrote goldens for', Object.keys(out).join(', '));
```

- [ ] **Step 2: Run it**

Run: `node scripts/gen-hyphenation-goldens.mjs`
Expected: `wrote goldens for en-US, en-GB, de, fr, es, it, nl, pt, pl`. Spot-check `goldens.json`: `"beautiful": "beau-ti-ful"` under en-US.

- [ ] **Step 3: Write the comparison test**

The oracle applies its OWN edge minimums, which may differ from ours, so both sides are filtered by one rule before comparing: a point counts only when it leaves at least the language's `minLeft` letters before and `minRight` after.

```ts
// test/hyphenate-goldens.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveHyphenation, hyphenator } from '../src/hyphenate.js';

const goldens = JSON.parse(readFileSync(new URL('./fixtures/hyphenation/goldens.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, string>>;
/** Points of a '-'-marked word. */
const pointsOf = (marked: string): number[] => {
  const pts: number[] = [];
  let n = 0;
  for (const ch of marked) { if (ch === '-') pts.push(n); else n += ch.length; }
  return pts;
};

describe('hyphenation agrees with hyphen@1.14.1, an independent implementation (v9j3.2)', () => {
  for (const [tag, words] of Object.entries(goldens)) {
    it(tag, () => {
      const r = resolveHyphenation({ lang: tag });
      const h = hyphenator({ ...r, minWord: 1, minLeft: 1, minRight: 1 });
      for (const [word, marked] of Object.entries(words)) {
        const keep = (p: number) => p >= r.minLeft && word.length - p >= r.minRight;
        expect({ word, points: h.points(word).filter(keep) }).toEqual({ word, points: pointsOf(marked).filter(keep) });
      }
    });
  }
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run test/hyphenate-goldens.test.ts`
Expected: PASS. If a word disagrees: the two pattern copies may differ in version. Diff that word's points, confirm against the pinned `.pat.txt` by hand (find the patterns that fire), and if OUR output follows the pinned patterns, move the word into an `EXCLUDED` map in the test with the reason written beside it, and record it in PROVENANCE. Never edit `goldens.json` by hand.

- [ ] **Step 5: Append to PROVENANCE.md**

```markdown
## Goldens

`goldens.json` is written by `scripts/gen-hyphenation-goldens.mjs` (not run by
`npm test`) from **hyphen@1.14.1**, fetched with `npm pack`, over its own bundled
pattern copy. `test/hyphenate-goldens.test.ts` compares point sets after filtering
both by the language's `hyphenmins`, since the two implementations apply their own
edge minimums. Ceiling: one other implementation, and pattern data that traces
back to the same CTAN sources — this catches an engine bug, not a pattern bug.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-hyphenation-goldens.mjs test/fixtures/hyphenation/goldens.json test/fixtures/hyphenation/PROVENANCE.md test/hyphenate-goldens.test.ts
git commit -m "test(v9j3.2): hyphenation goldens from an independent implementation"
```

---

### Task 4: The wrapping engine — `layout.ts`

**Files:**
- Modify: `src/layout.ts` — `Unit` (line ~175), `overwideUnits` (~487), the greedy pack loop (~531-539), `spanWidth` (~342), `piecesOf` (~556), `layoutRuns` signature (~286), `layoutText` (~659)
- Test: `test/layout-hyphenation.test.ts`

**Interfaces:**
- Consumes: `Hyphenator` (Task 2) as a TYPE.
- Produces:
  ```ts
  export function layoutRuns(runs, boxWidth, boxHeight, leading, blockFontSize, firstLineIndent = 0, hyphenation?: Hyphenator): RunLayoutResult;
  export function layoutText(text, driver, fontSize, boxWidth, boxHeight, leading, hyphenation?: Hyphenator): LayoutResult;
  ```

- [ ] **Step 1: Write the failing tests**

Courier is 600 units for every glyph, the hyphen included: at 10pt every character, `-` and space is 6pt, so widths are arithmetic.

```ts
// test/layout-hyphenation.test.ts
import { describe, it, expect } from 'vitest';
import { layoutRuns, layoutText, winAnsiDriver, type FontDriver } from '../src/layout.js';
import { resolveHyphenation, hyphenator } from '../src/hyphenate.js';

const CR = winAnsiDriver('Courier');           // 6pt per character at 10pt
const SHY = '­';
const manual = hyphenator(resolveHyphenation({ mode: 'manual' }));
const text = (t: string, w: number, h = 1000, hy = manual) =>
  layoutText(t, CR, 10, w, h, 12, hy).lines.map((l) => l.text);

describe('layoutRuns with hyphenation (v9j3.2)', () => {
  it('splits the word that does not fit at its rightmost fitting point and draws a hyphen', () => {
    // 'aaa ' is 24pt; in 60pt the head may be 36pt: 'hy-' (18) fits, 'hyphen-' (42) does not.
    expect(text(`aaa hy${SHY}phen${SHY}ation`, 60)).toEqual(['aaa hy-', 'phenation']);
    // In 66pt the head may be 42pt: 'hyphen-' fits and is the rightmost.
    expect(text(`aaa hy${SHY}phen${SHY}ation`, 66)).toEqual(['aaa hyphen-', 'ation']);
  });

  it('counts the hyphen in the line width', () => {
    const l = layoutText(`aaa hy${SHY}phen${SHY}ation`, CR, 10, 66, 1000, 12, manual).lines[0];
    expect(l.width).toBeCloseTo(66, 6);
  });

  it('draws a soft hyphen as nothing mid-line', () => {
    const l = layoutText(`hy${SHY}phen`, CR, 10, 200, 1000, 12, manual).lines[0];
    expect(l.text).toBe('hyphen');
    expect(l.width).toBeCloseTo(36, 6);
  });

  it('moves the whole word when no point fits', () => {
    expect(text(`aaaaaaa hy${SHY}phen`, 60)).toEqual(['aaaaaaa', 'hyphen']);
  });

  it('hyphenates an over-wide word before the plain split', () => {
    // 132pt in a 60pt box; manual points after 'hy', 'hyphen' and 'hyphenation'.
    // 'hyphen-' (42) and 'ation-' (36) fit; the last 'hyphenation' (66) has no
    // point and no UAX #14 opportunity (AL x AL), so it overflows whole, as today.
    const w = `hy${SHY}phen${SHY}ation${SHY}hyphenation`;
    expect(text(w, 60)).toEqual(['hyphen-', 'ation-', 'hyphenation']);
  });

  it('skips a point whose font cannot draw a hyphen', () => {
    const noHyphen: FontDriver = {
      measure: (t, fs) => t.length * 0.6 * fs,
      encode: (t) => new TextEncoder().encode(t),
      probe: (t) => (t.includes('-') ? 0 : t.length),
    };
    const lines = layoutText(`aaa hy${SHY}phen`, noHyphen, 10, 60, 1000, 12, manual).lines.map((l) => l.text);
    expect(lines).toEqual(['aaa', 'hyphen']);
  });

  it('keeps the soft hyphens in the remainder', () => {
    const r = layoutRuns([{ text: `aaa hy${SHY}phen${SHY}ation more`, driver: CR, fontSize: 10 }], 60, 12, 12, 10, 0, manual);
    expect(r.lines.map((l) => l.text)).toEqual(['aaa hy-']);
    expect(r.remainder.map((s) => s.text).join('')).toBe(`phen${SHY}ation more`);
  });

  it('re-joins to the input once line-end hyphens and soft hyphens are removed', () => {
    const auto = hyphenator(resolveHyphenation({ lang: 'en' }));
    const src = 'The quick brown fox jumps over the lazy dog and hyphenation documentation';
    const lines = layoutText(src, CR, 10, 70, 1000, 12, auto).lines;
    const joined = lines.map((l, i) => (i < lines.length - 1 && l.text.endsWith('-') ? l.text.slice(0, -1) : `${l.text} `)).join('');
    expect(joined.trim()).toBe(src);
    expect(lines.some((l) => l.text.endsWith('-'))).toBe(true);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(70 + 1e-6);
  });

  it('is unchanged without a hyphenator', () => {
    const src = `aaa hy${SHY}phen${SHY}ation`;
    const a = layoutRuns([{ text: src, driver: CR, fontSize: 10 }], 60, 1000, 12, 10);
    const b = layoutRuns([{ text: src, driver: CR, fontSize: 10 }], 60, 1000, 12, 10, 0, undefined);
    expect(b).toEqual(a);
    expect(a.lines.map((l) => l.text).join('|')).toContain(SHY);   // today's behaviour: drawn
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/layout-hyphenation.test.ts`
Expected: FAIL — the 7th argument is ignored, so no `-` appears and soft hyphens stay in `text`.

- [ ] **Step 3: Implement**

3a. Import and the `Unit` flag:

```ts
import type { Hyphenator } from './hyphenate.js';
```
```ts
interface Unit {
  start: number; end: number; spaceBefore: boolean;
  /** Ends at a hyphenation point: a '-' is drawn after it (v9j3.2). */
  hyphen?: boolean;
}
```

3b. Signatures:

```ts
export function layoutRuns(
  runs: readonly LayoutRun[], boxWidth: number, boxHeight: number,
  leading: number, blockFontSize: number, firstLineIndent = 0,
  hyphenation?: Hyphenator,
): RunLayoutResult {
```
```ts
export function layoutText(
  text: string, driver: FontDriver, fontSize: number,
  boxWidth: number, boxHeight: number, leading: number,
  hyphenation?: Hyphenator,
): LayoutResult {
  const { lines, remainder } = layoutRuns(
    [{ text, driver, fontSize }], boxWidth, boxHeight, leading, fontSize, 0, hyphenation);
  return { lines, remainder: remainder.map((s) => s.text).join('') };
}
```

3c. Right after `owner` is defined, add the soft-hyphen filter and hyphen helpers:

```ts
  // **Invariant (v9j3.2):** with hyphenation ON a soft hyphen has no width and
  // draws nothing; it stays in `text`, so the remainder carries it on. OFF,
  // `visible` is the identity and nothing below runs.
  const SHY = '­';
  const visible = (s: string): string =>
    hyphenation !== undefined && s.includes(SHY) ? s.split(SHY).join('') : s;
```

In `spanWidth`, change the measure line to:

```ts
        : run.driver.measure(visible(text.slice(i, j)), run.fontSize);
```

After `spaceWidth`, add:

```ts
  /** The run a hyphen after character `at - 1` is drawn in — that character's
   *  — or -1 when it is an atomic or its font cannot draw '-'. */
  const hyphenRun = (at: number): number => {
    const r = owner(at - 1);
    const run = scaled[r];
    return isAtomicRun(run) || run.driver.probe('-') === 0 ? -1 : r;
  };
  const hyphenWidth = (r: number): number => {
    const run = scaled[r] as TextLayoutRun;
    return run.driver.measure('-', run.fontSize);
  };
  /** A unit's width, its drawn hyphen included. */
  const unitWidth = (u: Unit): number =>
    spanWidth(u.start, u.end) + (u.hyphen ? hyphenWidth(hyphenRun(u.end)) : 0);
  /** The end of the longest head of `u` ending at a hyphenation point that
   *  fits `room` with its hyphen — the RIGHTMOST such point — or undefined. */
  const hyphenHead = (u: Unit, room: number): number | undefined => {
    const pts = hyphenation!.points(text.slice(u.start, u.end));
    for (let k = pts.length - 1; k >= 0; k--) {
      const at = u.start + pts[k];
      const r = hyphenRun(at);
      if (r >= 0 && spanWidth(u.start, at) + hyphenWidth(r) <= room) return at;
    }
    return undefined;
  };
```

3d. Replace `overwideUnits` with:

```ts
  function* overwideUnits(i: number, j: number, spaceBefore: boolean): Generator<Unit> {
    let at = i;
    let firstPiece = true;
    // (v9j3.2) Hyphenation points first, each piece drawing a hyphen; what no
    // point can split falls through to the plain UAX #14 split below.
    if (hyphenation !== undefined) {
      const pts = hyphenation.points(text.slice(i, j));
      while (spanWidth(at, j) > boxWidth) {
        let cut: number | undefined;
        for (let k = pts.length - 1; k >= 0 && i + pts[k] > at; k--) {
          const p = i + pts[k];
          const r = hyphenRun(p);
          if (r >= 0 && spanWidth(at, p) + hyphenWidth(r) <= boxWidth) { cut = p; break; }
        }
        if (cut === undefined) break;
        yield { start: at, end: cut, spaceBefore: firstPiece ? spaceBefore : false, hyphen: true };
        at = cut;
        firstPiece = false;
      }
      if (spanWidth(at, j) <= boxWidth) {
        yield { start: at, end: j, spaceBefore: firstPiece ? spaceBefore : false };
        return;
      }
    }
    const base = at;
    const word = text.slice(base, j);
    for (const pc of breakOverwideWord(word,
      (a, b) => spanWidth(base + a, base + b), boxWidth)) {
      yield { start: at, end: at + pc.length, spaceBefore: firstPiece ? spaceBefore : false };
      at += pc.length;
      firstPiece = false;
    }
  }
```

3e. Replace the pack loop body (`for (const u of units) { ... }`) with:

```ts
      for (const u0 of units) {
        // A head that ends at a hyphenation point leaves a TAIL, which goes
        // through the same test on the next line (v9j3.2).
        let pending: Unit | undefined = u0;
        while (pending !== undefined) {
          const u: Unit = pending;
          pending = undefined;
          if (cur.length === 0) { cur = [u]; curWidth = unitWidth(u); continue; }
          const sep = u.spaceBefore ? spaceWidth(cur[cur.length - 1].end - 1) : 0;
          const next = curWidth + sep + unitWidth(u);
          if (next <= limit()) { cur.push(u); curWidth = next; continue; }
          const at = hyphenation !== undefined && !u.hyphen ? hyphenHead(u, limit() - curWidth - sep) : undefined;
          if (at !== undefined) {
            cur.push({ start: u.start, end: at, spaceBefore: u.spaceBefore, hyphen: true });
            if (!keep(cur, false, cur[0].start)) break para;
            cur = [];
            curWidth = 0;
            pending = { start: at, end: u.end, spaceBefore: false };
            continue;
          }
          if (!keep(cur, false, cur[0].start)) break para;
          cur = [u];
          curWidth = unitWidth(u);
        }
      }
```

(`unitWidth` equals `spanWidth` for every unit when hyphenation is off — no unit carries `hyphen` — so the off path computes exactly what it did.)

3f. In `piecesOf`, change the inner `push(r, text.slice(i, j));` to:

```ts
        const t = visible(text.slice(i, j));
        if (t !== '') push(r, t);
```

and after the `while (i < u.end)` loop, still inside the unit loop, add:

```ts
      if (u.hyphen) {
        const r = hyphenRun(u.end);
        if (r >= 0) push(r, '-');
      }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/layout-hyphenation.test.ts test/layout.test.ts test/rich-runs-identity.test.ts`
Expected: PASS, the last two unedited.

- [ ] **Step 5: Commit**

```bash
git add src/layout.ts test/layout-hyphenation.test.ts
git commit -m "feat(v9j3.2): the wrapping engine hyphenates when asked"
```

---

### Task 5: `AddTextBlock` — `stamp.ts`

**Files:**
- Modify: `src/stamp.ts` — `TextBlockOptions` (~400), `NormalizedBlockOptions` (~430), `normalizeBlockOptions` (~474), every `layoutRuns(`/`layoutText(` call (~1072, 1141, 1152, 1182, 1195, 1220)
- Test: `test/textblock-hyphenation.test.ts`

**Interfaces:**
- Consumes: `HyphenationOptions`, `resolveHyphenation`, `hyphenator` (Task 2); `layoutRuns`/`layoutText` 7th parameter (Task 4).
- Produces: `TextBlockOptions.hyphenate?: HyphenationOptions`; `NormalizedBlockOptions.hyphen?: Hyphenator`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/textblock-hyphenation.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream } from '../src/content.js';
import { measureTextBlock } from '../src/stamp.js';

const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns';
const lines = (doc: Document) => Document.Open(doc.Save()).Pages[0].GetText().split('\n');

describe('AddTextBlock({ hyphenate }) (v9j3.2)', () => {
  it('draws hyphens at line ends and keeps every line in the box', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { fontSize: 12, hyphenate: { lang: 'en' } });
    const ls = lines(d);
    expect(ls.some((l) => l.endsWith('-'))).toBe(true);
    for (const f of Document.Open(d.Save()).Pages[0].GetTextFragments()) expect(f.quad[2]).toBeLessThanOrEqual(72 + 90 + 0.01);
  });

  it('measures exactly as it paints', () => {
    const o = { fontSize: 12, hyphenate: { lang: 'en' } } as const;
    const m = measureTextBlock(T, 90, 1000, o);
    const off = measureTextBlock(T, 90, 1000, { fontSize: 12 });
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, [72, 300, 90, 500], o);
    expect(m.usedHeight).not.toBe(off.usedHeight);
    // Every line is one leading tall here, so the drawn line count is the measure.
    expect(lines(d).length).toBe(Math.round(m.usedHeight / (12 * 1.2)));
  });

  it('is byte-identical without the option, soft hyphens included', () => {
    const src = 'hy­phen­ation and more words here';
    const a = Document.New(PageFormat.A4), b = Document.New(PageFormat.A4);
    a.Pages[0].AddTextBlock(src, [72, 500, 60, 300], { fontSize: 12 });
    b.Pages[0].AddTextBlock(src, [72, 500, 60, 300], { fontSize: 12, hyphenate: undefined });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
    const tj = parseContentStream(a.Pages[0].Contents).filter((op) => op.operator === 'Tj')
      .map((op) => Buffer.from((op.operands[0] as { bytes: Uint8Array }).bytes).toString('latin1')).join('');
    expect(tj).toContain('\xAD');   // OFF keeps today's visible soft hyphen
  });

  it('hides soft hyphens in manual mode', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('hy­phen', [72, 500, 300, 100], { fontSize: 12, hyphenate: { mode: 'manual' } });
    expect(Document.Open(d.Save()).Pages[0].GetText()).toBe('hyphen');
  });

  it('refuses bad options before drawing anything', () => {
    const d = Document.New(PageFormat.A4);
    const before = d.Pages[0].Contents;
    expect(() => d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
    expect(() => d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { hyphenate: 'en' as never })).toThrow(TypeError);
    expect(d.Pages[0].Contents).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/textblock-hyphenation.test.ts`
Expected: FAIL — `hyphenate` is not a known option (typecheck) / no hyphens drawn.

- [ ] **Step 3: Implement**

Add the import:

```ts
import { resolveHyphenation, hyphenator, type HyphenationOptions, type Hyphenator } from './hyphenate.js';
```

In `TextBlockOptions`, after `firstLineIndent`:

```ts
  /** Break words across lines with a drawn hyphen (v9j3.2). Default: off —
   *  output is then byte-identical to before the option existed. */
  hyphenate?: HyphenationOptions;
```

In `NormalizedBlockOptions` add `hyphen?: Hyphenator;`, and in `normalizeBlockOptions`'s returned object add:

```ts
    // Validated here, before anything is drawn; `undefined` keeps every
    // layout call on its pre-hyphenation path.
    hyphen: o.hyphenate === undefined ? undefined : hyphenator(resolveHyphenation(o.hyphenate)),
```

Pass `o.hyphen` (or `ro.hyphen` where the call uses `ro`) to every call in `stamp.ts`:

```ts
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), w, h, ro.leading, ro.fontSize, options.firstLineIndent ?? 0, ro.hyphen);
```
```ts
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), width, availHeight, o.leading, o.fontSize, options.firstLineIndent ?? 0, o.hyphen);
```
and append `, o.hyphen` as the 7th argument to each `layoutText(...)` call at ~1141, ~1152, ~1195 and ~1220.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/textblock-hyphenation.test.ts test/rich-runs-identity.test.ts test/layout.test.ts`
Expected: PASS. Run `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/stamp.ts test/textblock-hyphenation.test.ts
git commit -m "feat(v9j3.2): AddTextBlock takes hyphenate"
```

---

### Task 6: Flow paragraphs, lists and the flow-wide default — `flow.ts`

**Files:**
- Modify: `src/flow.ts` — `FlowOptions` (~57), `FlowParagraphOptions` (~201), `paragraphOptions` (~260), `paragraph()` (~366), `FlowListOptions` (~416), `NormalizedListOptions` (~458), `normalizeListOptions` (~568), `bodyOptions` (~655), `Flow` constructor and `AddParagraph`/`AddList`/`AddMarkdown` (~1284-1400)
- Test: `test/flow-hyphenation.test.ts`

**Interfaces:**
- Consumes: `HyphenationOptions`, `resolveHyphenation` (Task 2); `TextBlockOptions.hyphenate` (Task 5).
- Produces: `FlowParagraphOptions.hyphenate?: HyphenationOptions | false`, `FlowListOptions.hyphenate?: HyphenationOptions | false`, `FlowOptions.hyphenate?: HyphenationOptions`. `MarkdownFlowOptions.hyphenate` is added in Task 7; `Flow.AddMarkdown` forwards the flow default to it there.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-hyphenation.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns of text';
const narrow = { format: PageFormat.custom(200, 400), marginLeft: 40, marginRight: 40, marginTop: 20, marginBottom: 20 };
const text = (doc: Document) => Document.Open(doc.Save()).Pages.map((p) => p.GetText()).join('\n');
const hasHyphenEnd = (s: string) => s.split('\n').some((l) => /[a-z]-$/.test(l));

describe('Flow hyphenation (v9j3.2)', () => {
  it('hyphenates a paragraph that asks', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow(narrow).AddParagraph(T, { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('applies the flow default, and false turns it off for one element', () => {
    const a = Document.New(PageFormat.A4);
    a.NewFlow({ ...narrow, hyphenate: { lang: 'en' } }).AddParagraph(T, { fontSize: 12 }).Render();
    expect(hasHyphenEnd(text(a))).toBe(true);
    const b = Document.New(PageFormat.A4);
    b.NewFlow({ ...narrow, hyphenate: { lang: 'en' } }).AddParagraph(T, { fontSize: 12, hyphenate: false }).Render();
    expect(hasHyphenEnd(text(b))).toBe(false);
  });

  it("takes the flow's lang when the option states none", () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow({ ...narrow, tagged: true, lang: 'en-US', hyphenate: {} }).AddParagraph(T, { fontSize: 12 }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('hyphenates list item bodies', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow(narrow).AddList([T, T], { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('continues a hyphenated word on the next page', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow({ ...narrow, format: PageFormat.custom(200, 80) })
      .AddParagraph(`${T} ${T} ${T}`, { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    const all = text(d).replace(/-\n/g, '').replace(/\n/g, ' ');
    expect(all).toBe(`${T} ${T} ${T}`);
  });

  it('refuses a bad option when the element is added, before Render', () => {
    const d = Document.New(PageFormat.A4);
    const f = d.NewFlow(narrow);
    expect(() => f.AddParagraph(T, { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
    expect(() => d.NewFlow({ ...narrow, hyphenate: { mode: 'x' as never, lang: 'en' } })).toThrow(RangeError);
  });

  it('leaves a flow without the option byte-identical', () => {
    const a = Document.New(PageFormat.A4), b = Document.New(PageFormat.A4);
    a.NewFlow(narrow).AddParagraph(T, { fontSize: 12 }).Render();
    b.NewFlow({ ...narrow, hyphenate: undefined }).AddParagraph(T, { fontSize: 12, hyphenate: undefined }).Render();
    expect(b.Pages.map((p) => p.Contents)).toEqual(a.Pages.map((p) => p.Contents));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/flow-hyphenation.test.ts`
Expected: FAIL (unknown option / no hyphens).

- [ ] **Step 3: Implement**

Import:

```ts
import { resolveHyphenation, type HyphenationOptions } from './hyphenate.js';
```

`FlowOptions`, after `keepHeadingsWithNext`:

```ts
  /** Hyphenate every paragraph, list and Markdown block of this flow (v9j3.2).
   *  An element's own `hyphenate` wins; `false` turns it off for that element.
   *  `lang`, when unstated, is this flow's own `lang`. Default: off. */
  hyphenate?: HyphenationOptions;
```

`FlowParagraphOptions`, after `onUndrawable`:

```ts
  /** Break words across lines with a drawn hyphen (v9j3.2). `false` overrides a
   *  flow-wide default. Default: off. */
  hyphenate?: HyphenationOptions | false;
```

`FlowListOptions`, at the end: the same field and doc comment.

`paragraphOptions(o)` gains, inside the returned object:

```ts
    ...(o.hyphenate ? { hyphenate: o.hyphenate } : {}),
```

`paragraph()` validates at build time — first line of the function body:

```ts
  if (o.hyphenate !== undefined && o.hyphenate !== false) resolveHyphenation(o.hyphenate);
```

`NormalizedListOptions` gains `hyphenate?: HyphenationOptions;`. In `normalizeListOptions`, before the `return`:

```ts
  if (o.hyphenate !== undefined && o.hyphenate !== false) resolveHyphenation(o.hyphenate);
```
and in the returned object: `hyphenate: o.hyphenate || undefined,`.

`bodyOptions(o)` gains `...(o.hyphenate ? { hyphenate: o.hyphenate } : {}),`.

In the `Flow` class: a field `private readonly hyphenate?: HyphenationOptions;`, set at the end of the constructor:

```ts
    if (options?.hyphenate !== undefined) {
      resolveHyphenation(options.hyphenate, options.lang);
      this.hyphenate = options.hyphenate.lang === undefined && options.lang !== undefined
        ? { ...options.hyphenate, lang: options.lang } : options.hyphenate;
    }
```

and a helper the entry points use:

```ts
  /** An element's options with the flow's hyphenation default applied: its own
   *  value wins, `false` included; a value without `lang` takes the flow's. */
  private withHyphenation<T extends { hyphenate?: HyphenationOptions | false }>(o: T): T {
    if (o.hyphenate === false) return o;
    if (o.hyphenate === undefined) return this.hyphenate ? { ...o, hyphenate: this.hyphenate } : o;
    return o.hyphenate.lang === undefined && this.lang !== undefined
      ? { ...o, hyphenate: { ...o.hyphenate, lang: this.lang } } : o;
  }
```

`AddParagraph` → `paragraph(text, this.withHyphenation(options))`; `AddList` → `list(items, this.withHyphenation(options))`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/flow-hyphenation.test.ts test/markdown-flow.test.ts test/rich-runs-identity.test.ts`
Expected: PASS (the last two unedited). `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-hyphenation.test.ts
git commit -m "feat(v9j3.2): Flow paragraphs and lists hyphenate, with a flow-wide default"
```

---

### Task 7: Table cells and Markdown

**Files:**
- Modify: `src/tableauthor.ts` — `CellTextOptions` (~80), `ResolvedStyle` (~193), `resolveCellStyle` (~290), `validateStyleOpts` (~374), the measure call (~775-779)
- Modify: `src/tablerender.ts` — the `opts` object (~233)
- Modify: `src/mdflow.ts` — `MarkdownFlowOptions` (~34), `markdownElements` (~419), the two `paragraph(` calls in the paragraph mapper (~187, ~199), `listElements` (~291), `mdTable` (~323)
- Modify: `src/flow.ts` — `AddMarkdown` (~1396) forwards the flow default
- Test: `test/table-markdown-hyphenation.test.ts`

**Interfaces:**
- Consumes: `HyphenationOptions`, `resolveHyphenation`, `hyphenator` (Task 2); `layoutRuns`/`layoutText` 7th parameter (Task 4); `TextBlockOptions.hyphenate` (Task 5).
- Produces: `CellTextOptions.hyphenate?: HyphenationOptions` (cascades table → row → cell); `MarkdownFlowOptions.hyphenate?: HyphenationOptions`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/table-markdown-hyphenation.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';

const W = 'extraordinary responsibility documentation';
const text = (doc: Document) => Document.Open(doc.Save()).Pages.map((p) => p.GetText()).join('\n');
const hyphenEnds = (s: string) => s.split('\n').filter((l) => /[a-z]-$/.test(l)).length;

describe('table cells hyphenate (v9j3.2)', () => {
  it('cascades from table defaults and sizes the row for the hyphenated text', () => {
    const t = createTable({ fontSize: 12, hyphenate: { lang: 'en' } });
    t.setColumnWidths([{ fixed: 70 }]);
    t.addRow([W]);
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTable(t, 72, 700, { width: 70 });
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
    for (const f of Document.Open(d.Save()).Pages[0].GetTextFragments()) expect(f.quad[2]).toBeLessThanOrEqual(72 + 70 + 0.01);
  });

  it('lets a cell turn it on for itself only', () => {
    const t = createTable({ fontSize: 12 });
    t.setColumnWidths([{ fixed: 70 }, { fixed: 70 }]);
    const r = t.addRow();
    r.addCell(W, { hyphenate: { lang: 'en' } });
    r.addCell(W);
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTable(t, 72, 700, { width: 140 });
    const right = Document.Open(d.Save()).Pages[0].GetTextFragments().filter((f) => f.quad[0] > 72 + 70);
    expect(right.some((f) => /-$/.test(f.text))).toBe(false);
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
  });

  it('refuses a bad option when the table is built', () => {
    expect(() => createTable({ hyphenate: { lang: 'ru' } })).toThrow(RangeError);
  });
});

describe('Markdown hyphenates (v9j3.2)', () => {
  it('paragraphs, lists and tables', () => {
    const md = `${W} ${W}\n\n- ${W}\n\n| a |\n|---|\n| ${W} |\n`;
    const d = Document.New(PageFormat.custom(200, 800));
    d.AddMarkdown(md, { hyphenate: { lang: 'en' }, gfm: true });
    expect(hyphenEnds(text(d))).toBeGreaterThanOrEqual(2);
  });

  it('takes the flow default through Flow.AddMarkdown', () => {
    const d = Document.New(PageFormat.A4);
    const f = d.NewFlow({ format: PageFormat.custom(200, 800), marginLeft: 40, marginRight: 40, hyphenate: { lang: 'en' } });
    f.AddMarkdown(`${W} ${W}`);
    f.Render();
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
  });

  it('refuses a bad option before building', () => {
    expect(() => Document.New(PageFormat.A4).AddMarkdown('x', { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/table-markdown-hyphenation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement — tables**

`tableauthor.ts` import:

```ts
import { resolveHyphenation, hyphenator, type HyphenationOptions } from './hyphenate.js';
```

`CellTextOptions`, after `padding`:

```ts
  /** Break the cell's words across lines with a drawn hyphen (v9j3.2).
   *  Cascades table → row → cell. Default: off. */
  hyphenate?: HyphenationOptions;
```

`ResolvedStyle` gains `hyphenate?: HyphenationOptions;`; `resolveCellStyle` returns `hyphenate: o.hyphenate ?? row.hyphenate ?? table.hyphenate,`; `validateStyleOpts` gains `if (o.hyphenate !== undefined) resolveHyphenation(o.hyphenate);`.

In the measure loop, before `const res = ...`:

```ts
        const hy = st.hyphenate ? hyphenator(resolveHyphenation(st.hyphenate)) : undefined;
```
and pass `hy` as the 7th argument of both calls:

```ts
          ? layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading, hy)
          : layoutRuns(
            weaveByBeforeRun(pieces, cell.atomics,
              (a) => ({ atomic: { width: a.width, height: a.height, align: a.align } })),
            innerWidth, Infinity, st.leading, st.fontSize, 0, hy);
```

`tablerender.ts`, in `opts`: add `hyphenate: p.style.hyphenate,`.

- [ ] **Step 4: Implement — Markdown**

`mdflow.ts` import `import { resolveHyphenation, type HyphenationOptions } from './hyphenate.js';`.

`MarkdownFlowOptions`, after `onSkipped`:

```ts
  /** Hyphenate paragraphs, list items and table cells (v9j3.2). Headings and
   *  code blocks never hyphenate. Default: off. */
  hyphenate?: HyphenationOptions;
```

In `markdownElements`, after `checkOnSkipped(options);`:

```ts
  if (options.hyphenate !== undefined) resolveHyphenation(options.hyphenate);
```

Add `hyphenate: c.opts.hyphenate,` to the option object of both `paragraph(` calls in the paragraph mapper, to the `list(items, { ... })` call in `listElements`, and to `createTable({ ... })` in `mdTable`.

`flow.ts` `AddMarkdown`: where it calls `markdownElements(src, options)` (or forwards `options`), pass `options.hyphenate === undefined && this.hyphenate ? { ...options, hyphenate: this.hyphenate } : options` instead.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/table-markdown-hyphenation.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/docx-flow-identity.test.ts`
Expected: PASS (the last three unedited). `npm run typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add src/tableauthor.ts src/tablerender.ts src/mdflow.ts src/flow.ts test/table-markdown-hyphenation.test.ts
git commit -m "feat(v9j3.2): table cells and Markdown hyphenate"
```

---

### Task 8: Exports, docs and the mutation pass

**Files:**
- Modify: `src/index.ts` (after line ~117)
- Modify: `README.md` (Key Capabilities text-authoring bullet, an Additional Examples snippet, API Reference rows, Scope and Limitations)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `CLAUDE.md` (Source list entries for `hyphenate.ts` and `hyphdata.ts`; a `layout.ts` invariant; `npm run gen:hyph` in the generator list)

- [ ] **Step 1: Export**

```ts
export type { HyphenationOptions } from './hyphenate.js';
export { hyphenationLanguages } from './hyphenate.js';
```

- [ ] **Step 2: README**

- Key Capabilities, beside the `AddTextBlock` / Flow text bullets: "**Hyphenation** — opt-in `hyphenate: { lang }` on `AddTextBlock`, Flow paragraphs and lists (or flow-wide), table cells and Markdown: words break at Liang-pattern points (en-US, en-GB, de, fr, es, it, nl, pt, pl, from TeX's hyph-utf8) with a drawn hyphen; `mode: 'manual'` uses only the text's soft hyphens (U+00AD), which are invisible except at a break. Off by default, and then output is unchanged."
- Additional Examples: a "Hyphenate Narrow Columns" subsection:
  ```ts
  doc.NewFlow({ columns: 3, hyphenate: { lang: 'en' } })
    .AddParagraph(longText)
    .Render();
  page.AddTextBlock('hy­phen­ated by hand', rect, { hyphenate: { mode: 'manual' } });
  ```
- API Reference: rows for `HyphenationOptions` (types table) and `hyphenationLanguages()`. Then run `npx vitest run test/readme-api.test.ts` and copy the counts it reports into the README intro sentence.
- Scope and Limitations: "**Hyphenation** — nine bundled languages (no Russian: its patterns are LPPL-only); a drawn hyphen is page content, so extracted text reads `hy-\nphen`, and it is not marked as an artifact or given `/ActualText`; HTML `hyphens` and `ReplaceText({ adjust: 'reflow' })` do not hyphenate; a table column's auto-fit width still assumes whole words; soft hyphens in text that does NOT ask for hyphenation still draw as WinAnsi's visible hyphen."

- [ ] **Step 3: CHANGELOG** (`### Added`):

```markdown
- **Opt-in hyphenation.** `hyphenate: { lang }` on `AddTextBlock`, Flow paragraphs and lists (or once on the flow), table cells and `AddMarkdown` breaks a word that does not fit at a Liang pattern point and draws a hyphen, choosing the rightmost point that fits; a word wider than the whole column hyphenates before falling back to the plain split. Patterns for en-US, en-GB, de, fr, es, it, nl, pt and pl come from TeX's hyph-utf8 at a pinned commit, ship compressed, and are decoded only when a document first asks for that language; each carries its own licence. `mode: 'manual'` uses only the soft hyphens (U+00AD) already in the text, which are then invisible except at a break. The engine agrees with `hyphen`, an independent JavaScript implementation, on a word list per language. Off by default, and then every byte of output is what it was. (v9j3.2)
```

- [ ] **Step 4: CLAUDE.md**

Add to the Source list (after `linebox.ts`):

```markdown
- **hyphenate.ts**, **hyphdata.ts** — opt-in hyphenation (`v9j3.2`). `hyphdata.ts`
  is generated by `scripts/gen-hyphenation.mjs` (`npm run gen:hyph`) from tex-hyphen
  at `5684c0f`: nine deflated Liang tables, each with its licence verbatim.
  `hyphenate.ts` is a pure leaf (`hyphdata.js`, `langmatch.js`, `node:zlib`):
  `resolveHyphenation` validates (TypeError / RangeError) and `hyphenator` returns
  break offsets, cached per resolved options with a per-word memo.
  **Invariant:** `layoutRuns` takes the hyphenator as an optional trailing argument,
  and when it is absent no new code runs — `visible` is the identity and no unit
  carries `hyphen` — which is what keeps every identity fence green.
  **Invariant:** a soft hyphen is invisible and zero-width ONLY when hyphenation is
  on; off, WinAnsi still draws 0xAD as a hyphen, as it always has.
  **Invariant:** the head chosen is the RIGHTMOST point that fits with its hyphen,
  and the tail goes through the same test on the next line.
  **Note on the oracle:** `hyphen@1.14.1` (goldens via
  `scripts/gen-hyphenation-goldens.mjs`) is a different implementation over a copy of
  the same CTAN patterns — it catches engine bugs, not pattern bugs.
```

Add `npm run gen:hyph      # hyphdata.ts — Liang patterns (tex-hyphen)` to the generator block in Build & Test (and change "Six generators" to "Seven").

- [ ] **Step 5: Mutation pass**

For each rule, change the code, run the named test file, confirm RED, restore. Use a node script that refuses a no-op edit and reports a file that fails to load as LOAD-ERROR (see memory `verify-mutation-applied`):

| Mutation | Expected red |
|---|---|
| `hyphenHead` returns the LEFTMOST fitting point | `layout-hyphenation` rightmost case |
| drop `hyphenWidth` from the fit test | `layout-hyphenation` width case |
| `visible` returns `s` unchanged | `layout-hyphenation` soft-hyphen cases |
| `piecesOf` omits the `'-'` | `layout-hyphenation` split case |
| over-wide: skip the hyphenation loop | `layout-hyphenation` over-wide case |
| `hyphenRun` ignores `probe('-')` | `layout-hyphenation` no-hyphen font case |
| `findTable` drops the second lookup | `hyphenate` `de-AT` case |
| `points` skips the exception lookup | `hyphenate` exceptions case |
| no `lowerSameLength` (raw case) | `hyphenate` capitals case |
| `minWord` not applied | `hyphenate` minimums case |
| `paragraphOptions` drops `hyphenate` | `flow-hyphenation` paragraph case |
| `withHyphenation` ignores `false` | `flow-hyphenation` default/false case |
| `resolveCellStyle` drops the cascade | `table-markdown-hyphenation` cascade case |
| measure in `tableauthor` without `hy` | `table-markdown-hyphenation` box case |

Any mutation that stays green: add the missing case, or record in CLAUDE.md why the rule is held elsewhere.

- [ ] **Step 6: Full gates and commit**

Run: `npm run typecheck` then `npm test`. Expected: both green, identity fences unedited.

```bash
git add src/index.ts README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(v9j3.2): hyphenation in README, CHANGELOG and CLAUDE.md"
```
