# Bidi + Unicode Data (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pure, dependency-free Unicode foundation — a UCD data generator, the generated `src/unicode-data.ts`, and a fully UAX #9-conformant `src/bidi.ts` — verified against the official `BidiCharacterTest.txt`.

**Architecture:** A dev-only `scripts/gen-ucd.mjs` downloads pinned-version UCD files and emits range-compressed lookup tables into the committed `src/unicode-data.ts`. `src/bidi.ts` implements UAX #9 (paragraph level, explicit/weak/neutral/implicit resolution with isolates, L1/L2 reordering) plus script itemization and Arabic joining-form derivation, all as pure functions over plain arrays. Conformance is proven by running every row of the committed `BidiCharacterTest.txt`.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, `node:https`/`node:fs`/`node:zlib` built-ins only. No new runtime or dev dependencies.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps.
- **ESM + NodeNext** — relative imports carry the `.js` extension (e.g. `import { BC } from './unicode-data.js'`).
- **Strict TypeScript** — `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) must be green.
- **TDD** — failing test first, minimal implementation, green, commit. Mirror existing test style under `test/`.
- **Pure functions** — `bidi.ts` takes plain arrays in / plain arrays out; no font/document/global state.
- **Degrade, never throw** — malformed/empty input returns identity (levels = paragraph level, order = 0..n-1).
- **Unicode version pinned to `16.0.0`** — a single constant `UNICODE_VERSION` at the top of `gen-ucd.mjs`.
- **Generated file is committed** — `src/unicode-data.ts` and `test/fixtures/unicode/BidiCharacterTest.txt` are committed; the raw `unicode/` download dir is gitignored.

## File Structure

- `scripts/gen-ucd.mjs` — dev-only generator (download → parse → emit). Not shipped.
- `src/unicode-data.ts` — **generated**, committed, ships in package. Range tables + binary-search accessors + enum constants.
- `src/bidi.ts` — UAX #9 engine + itemization + Arabic joining. Pure.
- `test/fixtures/unicode/BidiCharacterTest.txt` — committed conformance fixture.
- `test/unicode-data.test.ts` — sanity checks on generated accessors.
- `test/bidi.test.ts` — unit tests for `paragraphLevel`, `reorder`, `itemizeScripts`, `arabicJoiningForms`, `mirror`.
- `test/bidi-conformance.test.ts` — runs every row of `BidiCharacterTest.txt`.
- `.gitignore`, `package.json` — updated.

Reference spec: `docs/superpowers/specs/2026-07-09-bidi-unicode-phase2-design.md`.
Authority for all rule numbers below: **UAX #9** (https://www.unicode.org/reports/tr9/).

---

### Task 1: UCD generator + generated data module

**Files:**
- Create: `scripts/gen-ucd.mjs`
- Modify: `package.json` (scripts), `.gitignore`
- Create (generated, commit output): `src/unicode-data.ts`
- Create (generated, commit): `test/fixtures/unicode/BidiCharacterTest.txt`
- Test: `test/unicode-data.test.ts`

**Interfaces:**
- Produces (consumed by every later task) in `src/unicode-data.ts`:
  - `export const BC: { L:0; R:1; AL:2; EN:3; ES:4; ET:5; AN:6; CS:7; NSM:8; BN:9; B:10; S:11; WS:12; ON:13; LRE:14; LRO:15; RLE:16; RLO:17; PDF:18; LRI:19; RLI:20; FSI:21; PDI:22 }` — Bidi_Class ids.
  - `export const JT: { U:0; R:1; L:2; D:3; C:4; T:5 }` — Joining_Type ids.
  - `export function bidiClass(cp: number): number`
  - `export function combiningClass(cp: number): number`
  - `export function script(cp: number): number`
  - `export function joiningType(cp: number): number`
  - `export function joiningGroup(cp: number): number`
  - `export function bracket(cp: number): { type: 0 | 1; pair: number } | undefined` — 0 = open, 1 = close.
  - `export function mirror(cp: number): number` — mirrored cp, or `cp` if none.
  - `export function scriptTag(scriptId: number): { tag: string; rtl: boolean }`

- [ ] **Step 1: Add npm script and gitignore entry**

In `package.json` `"scripts"`, add after `"gen:fonts"`:
```json
"gen:ucd": "node scripts/gen-ucd.mjs",
```
Append to `.gitignore`:
```
# UCD raw downloads (regenerate src/unicode-data.ts via npm run gen:ucd)
/unicode/
```

- [ ] **Step 2: Write the generator**

Create `scripts/gen-ucd.mjs`. It must: download each file (skip if already cached in `unicode/`), parse to coalesced ranges, and emit `src/unicode-data.ts`. Use `node:https` with a redirect-following fetch helper.

```js
// @ts-nocheck
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_VERSION = '16.0.0';
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'unicode');
mkdirSync(rawDir, { recursive: true });

const FILES = {
  bidiClass: 'extracted/DerivedBidiClass.txt',
  unicodeData: 'UnicodeData.txt',
  scripts: 'Scripts.txt',
  joiningType: 'extracted/DerivedJoiningType.txt',
  arabicShaping: 'ArabicShaping.txt',
  brackets: 'BidiBrackets.txt',
  mirroring: 'BidiMirroring.txt',
  bidiTest: 'BidiCharacterTest.txt',
};

function download(rel, dest) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}/${rel}`;
    const go = (u) => get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) { reject(new Error(`${u} -> ${res.statusCode}`)); return; }
      const out = createWriteStream(dest); res.pipe(out); out.on('finish', () => out.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

async function fetchAll() {
  const paths = {};
  for (const [key, rel] of Object.entries(FILES)) {
    const dest = join(rawDir, rel.split('/').pop());
    if (!existsSync(dest)) { process.stdout.write(`downloading ${rel}\n`); await download(rel, dest); }
    paths[key] = dest;
  }
  return paths;
}

// ---- parsing helpers ----
const HEX = (s) => parseInt(s, 16);
// Parse a "start[..end] ; value  # comment" property file into [start,end,rawValue].
function parseRanges(text, valueAt = 1) {
  const rows = [];
  for (const line of text.split('\n')) {
    const noComment = line.split('#')[0].trim();
    if (!noComment) continue;
    const parts = noComment.split(';').map((s) => s.trim());
    const range = parts[0].split('..');
    const start = HEX(range[0]); const end = HEX(range[1] ?? range[0]);
    rows.push([start, end, parts[valueAt]]);
  }
  return rows;
}
// Collect "# @missing: start..end; Value" default declarations.
function parseMissing(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^#\s*@missing:\s*([0-9A-Fa-f]+)\.\.([0-9A-Fa-f]+)\s*;\s*(\S+)/);
    if (m) rows.push([HEX(m[1]), HEX(m[2]), m[3]]);
  }
  return rows;
}
// Build a total-coverage, coalesced [start,end,id,...] flat array from explicit
// rows overlaid on @missing defaults, mapping raw values to ids via `idOf`.
function buildTable(explicit, missing, idOf, fallbackId) {
  const MAX = 0x110000;
  const arr = new Int32Array(MAX).fill(fallbackId);   // per-cp id, seeded with fallback
  for (const [s, e, v] of missing) { const id = idOf(v); for (let cp = s; cp <= e; cp++) arr[cp] = id; }
  for (const [s, e, v] of explicit) { const id = idOf(v); for (let cp = s; cp <= e; cp++) arr[cp] = id; }
  const out = [];
  let s = 0;
  for (let cp = 1; cp <= MAX; cp++) {
    if (cp === MAX || arr[cp] !== arr[s]) { out.push(s, cp - 1, arr[s]); s = cp; }
  }
  return out;                                          // flat [start,end,id, ...]
}

// ...enum id maps for each property (see Step 3 for BC/JT ordering)...

async function main() {
  const paths = await fetchAll();
  const read = (k) => readFileSync(paths[k], 'utf8');
  // Build each flat table with buildTable(...) — see Step 3 for the id maps.
  // Emit src/unicode-data.ts: the flat arrays as `const _bc = [...]` etc.,
  // a shared binary-search `function lookup(tbl, cp)`, and the exported
  // accessors + BC/JT enum objects + scriptTag map.
  // Also copy BidiCharacterTest.txt into the committed fixture path:
  const fixture = join(root, 'test/fixtures/unicode/BidiCharacterTest.txt');
  mkdirSync(dirname(fixture), { recursive: true });
  writeFileSync(fixture, read('bidiTest'));
  // writeFileSync(join(root, 'src/unicode-data.ts'), emitted);
  process.stdout.write('wrote src/unicode-data.ts and test fixture\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Implement the emit body**

Fill in `main()` and the emit. Concrete requirements:
- **Bidi_Class**: id map ordered exactly as `BC` above (`L=0 … PDI=22`). `buildTable(parseRanges(read('bidiClass')), parseMissing(read('bidiClass')), bcId, BC.L)`.
- **CCC**: from `UnicodeData.txt` — each line is `cp;name;gc;ccc;…`. Build explicit `[cp,cp,Number(ccc)]` rows (handle `First>`/`<…, Last>` range pairs), no missing defaults (fallback 0), `idOf = Number`.
- **Script**: `buildTable(parseRanges(read('scripts')), parseMissing(read('scripts')), scriptId, UNKNOWN)`. `scriptId` interns names into an array; emit a parallel `scriptNames` and a `scriptTag` map keyed by id — mark `Arabic/Hebrew/Syriac/Thaana/Nko/Samaritan/Mandaic/Adlam` (and other RTL scripts) `rtl:true` with their OpenType tags (`arab`,`hebr`,`syrc`,`thaa`,`nkoo`,`samr`,`mand`,`adlm`); everything else `ltr`. Latin→`latn`, etc. (a small explicit map for the common tags; default tag = lowercased 4-char ISO 15924 fallback `DFLT`).
- **Joining_Type**: `buildTable(parseRanges(read('joiningType')), parseMissing(read('joiningType')), jtId, JT.U)` with `jtId` per `JT` above.
- **Joining_Group**: from `ArabicShaping.txt` (`cp; name; jt; jg`), intern group names, fallback `No_Joining_Group`.
- **Brackets**: `BidiBrackets.txt` (`cp; pair; o|c`). Emit sorted `[cp, type(0|1), pair, …]`. Normalize the canonical-equivalent pairs so `2329↔3008` and `232A↔3009` match (map `2329→3008`, `232A→3009` in stored `pair`, and add entries so lookups on `3008/3009` resolve too). BD16.
- **Mirroring**: `BidiMirroring.txt` (`cp; mirror`). Emit sorted `[cp, mirror, …]`; `mirror(cp)` returns `cp` when absent.
- Binary-search `lookup(tbl, cp)` over the flat `[start,end,id]` triples; `bracket`/`mirror` search their pair arrays.
- File header comment: `// GENERATED by scripts/gen-ucd.mjs from Unicode 16.0.0 — do not edit.`

- [ ] **Step 4: Run the generator**

Run: `npm run gen:ucd`
Expected: downloads print, then `wrote src/unicode-data.ts and test fixture`. `src/unicode-data.ts` and `test/fixtures/unicode/BidiCharacterTest.txt` now exist.

- [ ] **Step 5: Write the sanity test**

Create `test/unicode-data.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BC, JT, bidiClass, combiningClass, script, joiningType, bracket, mirror, scriptTag } from '../src/unicode-data.js';

describe('unicode-data accessors', () => {
  it('bidiClass: Latin L, Hebrew R, Arabic letter AL, digit EN, Arabic-Indic AN', () => {
    expect(bidiClass(0x0041)).toBe(BC.L);   // A
    expect(bidiClass(0x05D0)).toBe(BC.R);   // Hebrew alef
    expect(bidiClass(0x0627)).toBe(BC.AL);  // Arabic alef
    expect(bidiClass(0x0039)).toBe(BC.EN);  // 9
    expect(bidiClass(0x0661)).toBe(BC.AN);  // Arabic-Indic one
    expect(bidiClass(0x2068)).toBe(BC.FSI); // FSI isolate initiator
  });
  it('combiningClass: base 0, combining accent above 230', () => {
    expect(combiningClass(0x0041)).toBe(0);
    expect(combiningClass(0x0301)).toBe(230); // combining acute
  });
  it('script + tag: Latin ltr latn, Arabic rtl arab', () => {
    expect(scriptTag(script(0x0041))).toEqual({ tag: 'latn', rtl: false });
    expect(scriptTag(script(0x0627))).toEqual({ tag: 'arab', rtl: true });
  });
  it('joiningType: Arabic beh dual-joining D, alef right-joining R, non-joining U', () => {
    expect(joiningType(0x0628)).toBe(JT.D); // beh
    expect(joiningType(0x0627)).toBe(JT.R); // alef
    expect(joiningType(0x0041)).toBe(JT.U); // A
    expect(joiningType(0x064B)).toBe(JT.T); // fathatan (transparent)
  });
  it('bracket + mirror', () => {
    expect(bracket(0x0028)).toEqual({ type: 0, pair: 0x0029 }); // ( open -> )
    expect(bracket(0x0029)).toEqual({ type: 1, pair: 0x0028 }); // ) close -> (
    expect(bracket(0x0041)).toBeUndefined();
    expect(mirror(0x0028)).toBe(0x0029);
    expect(mirror(0x0041)).toBe(0x0041);
  });
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/unicode-data.test.ts`
Expected: PASS (6 tests).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-ucd.mjs package.json .gitignore src/unicode-data.ts test/fixtures/unicode/BidiCharacterTest.txt test/unicode-data.test.ts
git commit -m "feat(8u0.2): UCD generator + generated unicode-data.ts"
```

---

### Task 2: `paragraphLevel` (UAX #9 P2/P3)

**Files:**
- Create: `src/bidi.ts`
- Test: `test/bidi.test.ts`

**Interfaces:**
- Consumes: `BC`, `bidiClass` from `./unicode-data.js`.
- Produces: `export function paragraphLevel(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): 0 | 1`.

- [ ] **Step 1: Write the failing test**

Create `test/bidi.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { paragraphLevel } from '../src/bidi.js';

const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!);

describe('paragraphLevel (P2/P3)', () => {
  it('auto: first strong Latin -> 0', () => { expect(paragraphLevel(cp('abc'), 'auto')).toBe(0); });
  it('auto: first strong Hebrew -> 1', () => { expect(paragraphLevel(cp('אbc'), 'auto')).toBe(1); });
  it('auto: leading neutrals then Arabic -> 1', () => { expect(paragraphLevel(cp('  ا'), 'auto')).toBe(1); });
  it('auto: digits are not strong -> default 0', () => { expect(paragraphLevel(cp('123'), 'auto')).toBe(0); });
  it('auto: skips an isolate initiator..PDI span', () => {
    // FSI(2068) R-text PDI(2069) then Latin: first strong outside the isolate is L
    expect(paragraphLevel([0x2068, 0x05D0, 0x2069, 0x0041], 'auto')).toBe(0);
  });
  it('explicit dir forces the level', () => {
    expect(paragraphLevel(cp('abc'), 'rtl')).toBe(1);
    expect(paragraphLevel(cp('א'), 'ltr')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/bidi.test.ts`
Expected: FAIL (cannot import `paragraphLevel`).

- [ ] **Step 3: Implement**

Create `src/bidi.ts`:
```ts
import { BC, bidiClass } from './unicode-data.js';

/** UAX #9 P2/P3: paragraph embedding level. 'auto' = first-strong. */
export function paragraphLevel(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): 0 | 1 {
  if (dir === 'ltr') return 0;
  if (dir === 'rtl') return 1;
  let isolate = 0;
  for (const c of codes) {
    const b = bidiClass(c);
    if (b === BC.LRI || b === BC.RLI || b === BC.FSI) { isolate++; continue; }
    if (b === BC.PDI) { if (isolate > 0) isolate--; continue; }
    if (isolate > 0) continue;                       // skip isolate span (P2)
    if (b === BC.L) return 0;
    if (b === BC.R || b === BC.AL) return 1;
  }
  return 0;                                          // P3 default
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/bidi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bidi.ts test/bidi.test.ts
git commit -m "feat(8u0.2): bidi paragraphLevel (P2/P3)"
```

---

### Task 3: `resolveLevels` (UAX #9 X1–X10, W1–W7, N0–N2, I1–I2)

**Files:**
- Modify: `src/bidi.ts`
- Test: `test/bidi.test.ts`

**Interfaces:**
- Consumes: `BC`, `bidiClass`, `bracket` from `./unicode-data.js`; `paragraphLevel`.
- Produces: `export function resolveLevels(codes: number[], paraLevel: 0 | 1): { levels: Int8Array; removed: boolean[] }`.

This is the core. Implement each rule group as a step against UAX #9. The conformance run (Task 5) is the real oracle; these unit tests catch gross errors early.

- [ ] **Step 1: Write failing unit tests (representative per rule group)**

Append to `test/bidi.test.ts`:
```ts
import { resolveLevels } from '../src/bidi.js';

function levelsOf(codes: number[], para: 0 | 1): number[] {
  const { levels, removed } = resolveLevels(codes, para);
  return [...levels].map((l, i) => (removed[i] ? -1 : l));
}
const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!);

describe('resolveLevels', () => {
  it('pure LTR: all level 0', () => { expect(levelsOf(cp('abc'), 0)).toEqual([0, 0, 0]); });
  it('pure RTL Hebrew in LTR paragraph: level 1', () => { expect(levelsOf(cp('אב'), 0)).toEqual([1, 1]); });
  it('W2: EN after AL becomes AN -> level 2 in RTL context', () => {
    // AL(0627) EN(0031): W2 makes the digit AN; I-rules give AN level 2 under R.
    expect(levelsOf([0x0627, 0x0031], 1)).toEqual([1, 2]);
  });
  it('N0: brackets take the embedding direction of their content', () => {
    // Hebrew (paren Hebrew paren) in RTL paragraph -> all level 1.
    expect(levelsOf([0x05D0, 0x0028, 0x05D1, 0x0029], 1)).toEqual([1, 1, 1, 1]);
  });
  it('N1: neutral between two R runs takes R', () => {
    expect(levelsOf([0x05D0, 0x0020, 0x05D1], 0)).toEqual([1, 1, 1]);
  });
  it('X6: RLO override forces R on Latin, RLE/PDF removed', () => {
    // RLO(202E) a b PDF(202C): the Latin becomes level 1; controls removed.
    expect(levelsOf([0x202E, 0x0061, 0x0062, 0x202C], 0)).toEqual([-1, 1, 1, -1]);
  });
  it('isolates: RLI..PDI raises the enclosed run', () => {
    // a RLI(2067) Hebrew PDI(2069) b : Hebrew at odd level, controls kept (level of para).
    const out = levelsOf([0x0061, 0x2067, 0x05D0, 0x2069, 0x0062], 0);
    expect(out[0]).toBe(0); expect(out[2]).toBe(1); expect(out[4]).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/bidi.test.ts`
Expected: FAIL (cannot import `resolveLevels`).

- [ ] **Step 3: Implement X1–X8 (explicit levels + isolates)**

Add to `src/bidi.ts`. Maintain the directional status stack and counters exactly per UAX #9 X1–X8. Constants and structure:
```ts
const MAX_DEPTH = 125;
const isRemovedByX9 = (b: number) =>
  b === BC.RLE || b === BC.LRE || b === BC.RLO || b === BC.LRO || b === BC.PDF || b === BC.BN;
const nextOdd = (l: number) => (l + 1) | 1;
const nextEven = (l: number) => (l + 2) & ~1;
```
Implement (per X1): initialise the stack with `{ level: paraLevel, override: BC of none, isolate: false }`, `overflowIsolate=0`, `overflowEmbedding=0`, `validIsolate=0`. Produce `levels: Int8Array` (seed each char with the current stack embedding level) and, for override status, rewrite the char's *type array* (a working `Int8Array types` copy of `bidiClass`) to L or R when an override is active (X6). Handle:
- **X2–X5** RLE/LRE/RLO/LRO: compute `nextOdd`/`nextEven`; if valid (≤ MAX_DEPTH and no overflow) push, else bump the matching overflow counter. The formatting char itself gets the *current* (pre-push) embedding level and is removed (X9).
- **X5a/X5b** RLI/LRI: the isolate char gets the current level (and override applied), then push a new isolate entry (like X2/X3) with `isolate:true`, incrementing `validIsolate`; on overflow bump `overflowIsolate`.
- **X5c** FSI: compute P2/P3 over the code points from just after this FSI up to its matching PDI; treat as RLI if that yields 1 else LRI.
- **X6** any other non-removed, non-B, non-BN type: assign current embedding level; if the stack top has an override, set `types[i]` to that override direction.
- **X6a** PDI: if `overflowIsolate>0` decrement it; else if `validIsolate===0` do nothing; else pop entries until (and including) the last isolate entry, resetting overflow embedding. The PDI char gets the level of the stack *after* popping, with override applied.
- **X7** PDF: unwind one embedding (respecting overflow counters).
- **X8** B: not expected mid-paragraph (caller splits); assign paragraph level.

- [ ] **Step 4: Implement X9/X10 (removed flags + isolating run sequences) and W/N/I**

- **X9:** set `removed[i] = isRemovedByX9(bidiClass(codes[i]))`. (Keep their assigned level for the test's `x`.)
- **X10:** build **isolating run sequences**. First form level runs (maximal runs of equal level over non-removed chars). Then chain a run ending in an isolate initiator to the run starting with its matching PDI into one sequence. For each sequence compute `sos`/`eos` from the higher of the sequence's boundary level and the adjacent (or paragraph) level → `L` if even else `R`. Run the following over each sequence's ordered non-removed positions (`seq`), reading/writing `types`:
  - **W1** NSM → type of previous char (sos if none); an NSM after an isolate control → ON.
  - **W2** EN → AN if the last strong type seen was AL.
  - **W3** AL → R.
  - **W4** single ES between two EN → EN; single CS between two EN, or two AN → EN/AN.
  - **W5** sequence of ET adjacent to EN → EN.
  - **W6** remaining ES/ET/CS → ON.
  - **W7** EN → L if the last strong type was L.
  - **N0** paired brackets (BD16): scan with a stack of open brackets (max 63; on overflow stop) pairing via `bracket(codes)`; for each pair, if it contains a strong type matching the embedding direction `e`, set both brackets to `e`; else if it contains the opposite strong direction, set both to `e` only when the preceding context strong type is that opposite direction (else embedding); else leave. Then any NSM following a changed bracket takes the bracket's new type.
  - **N1** a run of neutrals (incl. isolate controls treated as neutral) between two same strong directions (treating EN/AN as R for this) → that direction; use sos/eos at the ends.
  - **N2** remaining neutrals → embedding direction `e` (`L` if level even else `R`).
  - **I1/I2** implicit: for each non-removed char, if level even: R→+1, AN/EN→+2; if level odd: L/EN/AN→+1.

Write the `levels` back for these +1/+2 adjustments.

- [ ] **Step 5: Run unit tests to green**

Run: `npx vitest run test/bidi.test.ts`
Expected: all `resolveLevels` cases PASS. Debug against UAX #9 rule text until green.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → no errors.
```bash
git add src/bidi.ts test/bidi.test.ts
git commit -m "feat(8u0.2): bidi resolveLevels (X/W/N/I with isolates)"
```

---

### Task 4: `reorder` (UAX #9 L1/L2) + `reorderLine` + `mirror`

**Files:**
- Modify: `src/bidi.ts`
- Test: `test/bidi.test.ts`

**Interfaces:**
- Consumes: `resolveLevels`, `paragraphLevel`, `BC`, `bidiClass`; `mirror` re-exported from unicode-data.
- Produces:
  - `export function reorder(codes: number[], levels: Int8Array, removed: boolean[], paraLevel: 0 | 1): number[]`
  - `export function reorderLine(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): { paraLevel: 0 | 1; levels: Int8Array; removed: boolean[]; order: number[] }`
  - `export { mirror } from './unicode-data.js'`

- [ ] **Step 1: Write failing tests**

Append to `test/bidi.test.ts`:
```ts
import { reorder, reorderLine, mirror } from '../src/bidi.js';

describe('reorder (L1/L2)', () => {
  it('LTR only: identity order', () => {
    const { order } = reorderLine(cp('abc'), 'ltr');
    expect(order).toEqual([0, 1, 2]);
  });
  it('RTL Hebrew word in LTR paragraph reverses', () => {
    const { order } = reorderLine([0x05D0, 0x05D1, 0x05D2], 'auto'); // para becomes RTL
    expect(order).toEqual([2, 1, 0]);
  });
  it('mixed: Latin then Hebrew keeps Latin, reverses Hebrew (LTR para)', () => {
    // a b HEB0 HEB1 -> visual: a b HEB1 HEB0
    const { order } = reorderLine([0x0061, 0x0062, 0x05D0, 0x05D1], 'ltr');
    expect(order).toEqual([0, 1, 3, 2]);
  });
  it('L1: trailing whitespace resets to paragraph level (stays after RTL run)', () => {
    // HEB space, LTR paragraph: space (WS) resets to level 0 and sorts last.
    const { order } = reorderLine([0x05D0, 0x0020], 'ltr');
    expect(order).toEqual([0, 1]);
  });
  it('removed chars are excluded from order', () => {
    const { order } = reorderLine([0x202D, 0x0061, 0x202C], 'ltr'); // LRO a PDF
    expect(order).toEqual([1]);
  });
});

describe('mirror', () => {
  it('mirrors a bracket, leaves letters', () => {
    expect(mirror(0x0028)).toBe(0x0029);
    expect(mirror(0x0041)).toBe(0x0041);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bidi.test.ts`
Expected: FAIL (cannot import `reorder`/`reorderLine`).

- [ ] **Step 3: Implement**

Add to `src/bidi.ts`:
```ts
export { mirror } from './unicode-data.js';

/** UAX #9 L1 then L2. Returns visual-order indices, excluding X9-removed chars. */
export function reorder(codes: number[], levels: Int8Array, removed: boolean[], paraLevel: 0 | 1): number[] {
  const n = codes.length;
  const lv = Int8Array.from(levels);
  // L1: reset separators and the whitespace/isolate-control run before them,
  // and at end of line, to the paragraph level.
  const resetType = (b: number) =>
    b === BC.WS || b === BC.FSI || b === BC.LRI || b === BC.RLI || b === BC.PDI ||
    b === BC.RLE || b === BC.LRE || b === BC.RLO || b === BC.LRO || b === BC.PDF || b === BC.BN;
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const b = bidiClass(codes[i]);
    if (b === BC.B || b === BC.S) {                    // L1 (1)(2): separator itself
      lv[i] = paraLevel;
      for (let k = i - 1; k >= 0 && resetType(bidiClass(codes[k])); k--) lv[k] = paraLevel;
    }
    if (resetType(b)) { if (runStart < 0) runStart = i; } else runStart = -1;
  }
  if (runStart >= 0) for (let k = runStart; k < n; k++) lv[k] = paraLevel; // L1 (4): trailing run
  // L2: reverse contiguous runs from highest level down to lowest odd level.
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (!removed[i]) order.push(i);
  let hi = 0, lo = 63;
  for (const i of order) { if (lv[i] > hi) hi = lv[i]; if (lv[i] < lo) lo = lv[i]; }
  for (let level = hi; level >= Math.max(lo, 1) && level > 0; level--) {
    let s = 0;
    while (s < order.length) {
      if (lv[order[s]] < level) { s++; continue; }
      let e = s;
      while (e < order.length && lv[order[e]] >= level) e++;
      for (let a = s, b = e - 1; a < b; a++, b--) { const t = order[a]; order[a] = order[b]; order[b] = t; }
      s = e;
    }
  }
  return order;
}

export function reorderLine(codes: number[], dir: 'ltr' | 'rtl' | 'auto') {
  const paraLevel = paragraphLevel(codes, dir);
  const { levels, removed } = resolveLevels(codes, paraLevel);
  const order = reorder(codes, levels, removed, paraLevel);
  return { paraLevel, levels, removed, order };
}
```

- [ ] **Step 4: Run to verify passes**

Run: `npx vitest run test/bidi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bidi.ts test/bidi.test.ts
git commit -m "feat(8u0.2): bidi reorder (L1/L2) + reorderLine + mirror"
```

---

### Task 5: Full conformance against `BidiCharacterTest.txt`

**Files:**
- Create: `test/bidi-conformance.test.ts`
- Modify (fixes as bugs surface): `src/bidi.ts`

**Interfaces:**
- Consumes: `paragraphLevel`, `resolveLevels`, `reorder` from `./bidi.js`.

`BidiCharacterTest.txt` row format (fields `;`-separated):
`codepoints ; paragraphDirection ; resolvedParagraphLevel ; levels ; reorder`
- `paragraphDirection`: `0`=LTR, `1`=RTL, `2`=auto.
- `levels`: space-separated per-char level, `x` = removed (X9).
- `reorder`: space-separated **indices** (into the input) in visual order, omitting removed chars.

- [ ] **Step 1: Write the conformance driver**

Create `test/bidi-conformance.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { paragraphLevel, resolveLevels, reorder } from '../src/bidi.js';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, 'fixtures/unicode/BidiCharacterTest.txt'), 'utf8');
const DIR = { 0: 'ltr', 1: 'rtl', 2: 'auto' } as const;

interface Row { line: number; codes: number[]; dir: 'ltr'|'rtl'|'auto'; paraLevel: number; levels: (number|null)[]; order: number[]; }
const rows: Row[] = [];
text.split('\n').forEach((raw, idx) => {
  const line = raw.split('#')[0].trim();
  if (!line) return;
  const f = line.split(';');
  const codes = f[0].trim().split(/\s+/).map((h) => parseInt(h, 16));
  const levels = f[3].trim().split(/\s+/).map((s) => (s === 'x' ? null : Number(s)));
  const order = f[4].trim() ? f[4].trim().split(/\s+/).map(Number) : [];
  rows.push({ line: idx + 1, codes, dir: DIR[Number(f[1]) as 0|1|2], paraLevel: Number(f[2]), levels, order });
});

describe('UAX #9 conformance (BidiCharacterTest.txt)', () => {
  it(`loads rows`, () => { expect(rows.length).toBeGreaterThan(100000); });
  it('every row: paragraph level, levels, and reorder match', () => {
    const failures: string[] = [];
    for (const r of rows) {
      const pl = paragraphLevel(r.codes, r.dir);
      if (pl !== r.paraLevel) { failures.push(`L${r.line}: paraLevel ${pl}!=${r.paraLevel}`); if (failures.length > 20) break; continue; }
      const { levels, removed } = resolveLevels(r.codes, pl as 0|1);
      for (let i = 0; i < r.codes.length; i++) {
        const exp = r.levels[i];
        if (exp === null) { if (!removed[i]) failures.push(`L${r.line}[${i}]: expected removed`); }
        else if (removed[i] || levels[i] !== exp) failures.push(`L${r.line}[${i}]: level ${removed[i] ? 'x' : levels[i]}!=${exp}`);
      }
      const ord = reorder(r.codes, levels, removed, pl as 0|1);
      if (ord.join(',') !== r.order.join(',')) failures.push(`L${r.line}: reorder ${ord.join(' ')} != ${r.order.join(' ')}`);
      if (failures.length > 20) break;
    }
    expect(failures.slice(0, 20).join('\n')).toBe('');
  });
});
```

- [ ] **Step 2: Run and iterate to green**

Run: `npx vitest run test/bidi-conformance.test.ts`
Expected initially: FAIL with a short list of `L<line>[i]:` mismatches. Fix `src/bidi.ts` against the exact UAX #9 rule for each failing category (re-read the rule the failures cluster around), re-run, repeat until PASS. Commit intermediate fixes as needed:
```bash
git add src/bidi.ts && git commit -m "fix(8u0.2): bidi conformance — <rule>"
```

- [ ] **Step 3: Final full-suite check**

Run: `npm test`
Expected: all files pass (existing 1483 + new).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit the conformance test**

```bash
git add test/bidi-conformance.test.ts
git commit -m "test(8u0.2): full BidiCharacterTest.txt conformance"
```

---

### Task 6: `itemizeScripts` + `arabicJoiningForms`

**Files:**
- Modify: `src/bidi.ts`
- Test: `test/bidi.test.ts`

**Interfaces:**
- Consumes: `script`, `scriptTag`, `joiningType`, `JT`, `bracket` from `./unicode-data.js`.
- Produces:
  - `export function itemizeScripts(codes: number[]): { start: number; end: number; script: number; otTag: string; rtl: boolean }[]` — `end` exclusive.
  - `export function arabicJoiningForms(codes: number[], start: number, end: number): ('isol' | 'init' | 'medi' | 'fina' | null)[]`

- [ ] **Step 1: Write failing tests**

Append to `test/bidi.test.ts`:
```ts
import { itemizeScripts, arabicJoiningForms } from '../src/bidi.js';

describe('itemizeScripts', () => {
  it('splits Latin | Arabic and tags each', () => {
    const segs = itemizeScripts([0x0041, 0x0042, 0x0627, 0x0628]); // AB + arabic beh/alef
    expect(segs.map((s) => [s.start, s.end, s.otTag, s.rtl])).toEqual([
      [0, 2, 'latn', false], [2, 4, 'arab', true],
    ]);
  });
  it('folds Common/Inherited into the surrounding run', () => {
    // A, combining acute (inherited), space (common), B -> one Latin run
    const segs = itemizeScripts([0x0041, 0x0301, 0x0020, 0x0042]);
    expect(segs.length).toBe(1);
    expect(segs[0].otTag).toBe('latn');
  });
});

describe('arabicJoiningForms', () => {
  it('two dual-joining letters -> init, fina', () => {
    // beh(D) beh(D): first initial, second final
    expect(arabicJoiningForms([0x0628, 0x0628], 0, 2)).toEqual(['init', 'fina']);
  });
  it('three dual-joining -> init, medi, fina', () => {
    expect(arabicJoiningForms([0x0628, 0x0628, 0x0628], 0, 3)).toEqual(['init', 'medi', 'fina']);
  });
  it('right-joining alef then beh -> isol/fina then init? alef breaks left-join', () => {
    // alef(R) joins only to its right; beh(D) after: alef=fina, beh=init? No: alef R
    // joins previous only. Sequence beh(D) alef(R): beh=init, alef=fina.
    expect(arabicJoiningForms([0x0628, 0x0627], 0, 2)).toEqual(['init', 'fina']);
  });
  it('transparent mark between joiners is skipped', () => {
    // beh(D) fathatan(T) beh(D): mark is null, letters still init/fina.
    expect(arabicJoiningForms([0x0628, 0x064B, 0x0628], 0, 3)).toEqual(['init', null, 'fina']);
  });
  it('single letter -> isol', () => {
    expect(arabicJoiningForms([0x0628], 0, 1)).toEqual(['isol']);
  });
  it('non-joining (U) letter -> isol', () => {
    expect(arabicJoiningForms([0x0041], 0, 1)).toEqual(['isol']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bidi.test.ts`
Expected: FAIL (cannot import `itemizeScripts`/`arabicJoiningForms`).

- [ ] **Step 3: Implement**

Add to `src/bidi.ts`:
```ts
import { script, scriptTag, joiningType, JT } from './unicode-data.js';

// Script ids for Common/Inherited/Unknown come from the generated table; expose
// them by name via a tiny lookup so itemization can fold them into neighbours.
// gen-ucd emits `scriptNames` (id -> name); compare against 'Common'/'Inherited'.
import { scriptNames } from './unicode-data.js';
const COMMON = scriptNames.indexOf('Common');
const INHERITED = scriptNames.indexOf('Inherited');

export function itemizeScripts(codes: number[]) {
  const segs: { start: number; end: number; script: number; otTag: string; rtl: boolean }[] = [];
  let cur = -1, start = 0;
  const resolved = codes.map((c) => script(c));
  for (let i = 0; i < codes.length; i++) {
    let s = resolved[i];
    if (s === COMMON || s === INHERITED) s = cur < 0 ? s : cur;   // fold into running script
    if (cur < 0) { cur = s; start = 0; continue; }
    if (s !== cur && s !== COMMON && s !== INHERITED) {
      const { tag, rtl } = scriptTag(cur);
      segs.push({ start, end: i, script: cur, otTag: tag, rtl });
      cur = s; start = i;
    }
  }
  if (codes.length) { const { tag, rtl } = scriptTag(cur < 0 ? script(codes[0]) : cur); segs.push({ start, end: codes.length, script: cur, otTag: tag, rtl }); }
  return segs;
}

export function arabicJoiningForms(codes: number[], start: number, end: number) {
  const n = end - start;
  const out: ('isol' | 'init' | 'medi' | 'fina' | null)[] = new Array(n).fill(null);
  const jt = (i: number) => joiningType(codes[start + i]);
  const prevJoin: boolean[] = new Array(n).fill(false);  // joins to previous non-T
  const nextJoin: boolean[] = new Array(n).fill(false);  // joins to next non-T
  // previous non-transparent index
  const prevIdx: number[] = new Array(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) { if (jt(i) === JT.T) { prevIdx[i] = last; continue; } prevIdx[i] = last; last = i; }
  for (let i = 0; i < n; i++) {
    if (jt(i) === JT.T) continue;                        // marks: leave null
    const p = prevIdx[i];
    // this letter joins to previous if previous is D/L (can join on its left)
    // and this letter can join on its right (D/R/C).
    const canJoinRight = jt(i) === JT.D || jt(i) === JT.R || jt(i) === JT.C;
    const canJoinLeft = jt(i) === JT.D || jt(i) === JT.L || jt(i) === JT.C;
    if (p >= 0 && canJoinRight) {
      const pj = jt(p);
      if (pj === JT.D || pj === JT.L || pj === JT.C) { prevJoin[i] = true; nextJoin[p] = true; }
    }
    void canJoinLeft;
  }
  for (let i = 0; i < n; i++) {
    if (jt(i) === JT.T) continue;
    const pj = prevJoin[i], nj = nextJoin[i];
    out[i] = pj && nj ? 'medi' : pj ? 'fina' : nj ? 'init' : 'isol';
  }
  return out;
}
```
Note: `gen-ucd.mjs` (Task 1, Step 3) must also `export const scriptNames: string[]` in `src/unicode-data.ts`. Add that export when implementing Task 1 if not already present, then re-run `npm run gen:ucd`.

- [ ] **Step 4: Run to verify passes**

Run: `npx vitest run test/bidi.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck` → clean. Run: `npm test` → all pass.
```bash
git add src/bidi.ts src/unicode-data.ts test/bidi.test.ts
git commit -m "feat(8u0.2): script itemization + Arabic joining-form derivation"
```

---

## Self-Review

**Spec coverage:**
- gen-ucd.mjs (download/parse/emit, pinned version) → Task 1. ✓
- unicode-data.ts accessors (bidiClass/ccc/script/joiningType/joiningGroup/bracket/mirror/scriptTag) → Task 1 (+ `scriptNames`, `JT`, `BC`). ✓
- N0 canonical bracket equivalence → Task 1 Step 3. ✓
- paragraphLevel P2/P3 incl. isolate spans → Task 2. ✓
- resolveLevels X1–X10, W1–W7, N0–N2, I1–I2 with isolates → Task 3. ✓
- reorder L1/L2, reorderLine, mirror → Task 4. ✓
- Full BidiCharacterTest.txt conformance → Task 5. ✓
- itemizeScripts + arabicJoiningForms → Task 6. ✓
- Committed fixture, gitignore, package.json → Task 1. ✓
- Degrade-never-throw, pure functions, zero deps → global constraints, honored in each signature.

**Placeholder scan:** No TBD/TODO. The one intentional cross-task note (`scriptNames` export needed by Task 6) is called out explicitly in Task 1's interface and Task 6 Step 3. resolveLevels rule bodies are specified rule-by-rule with exact class transitions rather than transcribed line-by-line, since the conformance run (Task 5) is the executable oracle that drives them to correctness — this is deliberate for a 400-line standardized algorithm, not a placeholder.

**Type consistency:** `BC`/`JT` enum shapes, `bidiClass(cp):number`, `resolveLevels → {levels:Int8Array; removed:boolean[]}`, `reorder(...):number[]`, `itemizeScripts` seg shape, and `arabicJoiningForms` return union are used identically across Tasks 1–6. `paraLevel: 0|1` consistent. Fixture path `test/fixtures/unicode/BidiCharacterTest.txt` identical in Tasks 1 and 5.
