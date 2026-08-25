# Real-world WOFF2 Regression Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit a `.woff2` produced by Google's reference encoder from a TTF this repo already vendors, and assert our WOFF2→sfnt reconstruction reproduces that TTF.

**Architecture:** `wawoff2` (Emscripten build of Google's `woff2`) is installed one-off, run over `fonts/LiberationSans-Regular.ttf`, and removed; only its output is committed. A measurement pass first establishes, table by table, what "matches the original" actually means for a WOFF2 round-trip — that partition is recorded in `PROVENANCE.md` and locked by the test suite. Assertions are layered: byte equality where the round-trip provably preserves bytes, structural equality (outlines, components, instructions, advances) everywhere else.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `node:zlib` brotli. `wawoff2` 2.0.1 (MIT) at authoring time only.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `wawoff2` is installed one-off and **must be removed before the final commit** — it is never a dev dependency in the committed `package.json`.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension (e.g. `import { parseSfnt } from '../src/sfnt.js'`).
- **Hermetic tests.** No network, no optional tooling, no conditional skips. The suite must pass from the committed bytes alone.
- **Both gates green before closing:** `npm run typecheck` and `npm test`.
- Task tracking is **bd**, not TodoWrite or markdown TODOs. Issue: `aspose-pdf-foss-for-ts-da9` (already claimed).
- Fixture path: `test/fixtures/fonts/LiberationSans-Regular.woff2`. Test file: `test/woff2-real.test.ts`.

## TDD adaptation — read before Task 1

`src/woff.ts` already exists and is believed correct, so a correct new test **passes on first run**. "Write a failing test first" is therefore not the available discipline here. The substitute, which this repo already practices (see the closing section of `test/fixtures/jpeg/PROVENANCE.md`), is a **mutation check**:

> After each test passes, temporarily break the specific code path it covers in `src/woff.ts`, re-run, and confirm the test fails. Then revert the break.

A test that stays green under mutation is asserting nothing and must be strengthened before the task is committed. Every task below has this as an explicit step. Revert the mutation with `git checkout -- src/woff.ts` — never commit one.

## File Structure

| File | Responsibility |
|---|---|
| `test/fixtures/fonts/LiberationSans-Regular.woff2` | Create — the fixture bytes (encoder output, frozen) |
| `test/fixtures/fonts/PROVENANCE.md` | Create — encoder version, exact command, SHA-256s, measured table partition |
| `test/woff2-real.test.ts` | Create — all assertions against the fixture |
| `src/woff.ts` | Modify **only if** the measurement or a test exposes a real defect |

Scratch scripts (generation, measurement) live in the scratchpad directory and are **not committed** — they run once, and their output is what lands.

## Relevant existing API

Read these before writing test code; the plan's snippets rely on them.

```ts
// src/sfnt.ts
export function parseSfnt(bytes: Uint8Array): SfntFont;   // accepts sfnt, WOFF, or WOFF2
export interface GlyphPoint { x: number; y: number; on: boolean; }
export class SfntFont {
  readonly raw: Uint8Array;                        // the *reconstructed* sfnt bytes
  readonly tables: Map<string, { offset: number; length: number }>;  // @internal, accessible
  numGlyphs: number;
  indexToLocFormat: 0 | 1;
  unitsPerEm: number;
  cmap: Map<number, number>;
  glyphData(gid: number): Uint8Array;              // raw glyf bytes for one glyph
  componentGids(gid: number): number[];            // [] for simple/empty glyphs
  glyphOutline(gid: number, depth?: number): GlyphPoint[][];
  advanceWidth(gid: number): number;
}

// src/woff.ts
export function sfntFromWoff(bytes: Uint8Array): Uint8Array;   // WOFF/WOFF2 -> sfnt bytes

// src/document.ts
AddFont(bytes: Uint8Array, opts?: AddFontOptions): EmbeddedFont;
```

`tables` is marked `@internal` by JSDoc only — it is a normal public property at the type level, so tests may read it. `.raw` on a font parsed from a WOFF2 is the reconstruction, which is what makes byte-level comparison against the original TTF possible.

---

### Task 1: Generate the fixture, measure the round-trip, document provenance

**Files:**
- Create: `test/fixtures/fonts/LiberationSans-Regular.woff2`
- Create: `test/fixtures/fonts/PROVENANCE.md`
- Create: `test/woff2-real.test.ts`
- Scratch (not committed): `<scratchpad>/gen-woff2.mjs`, `<scratchpad>/measure-woff2.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the fixture at `test/fixtures/fonts/LiberationSans-Regular.woff2`; the measured byte-identical tag list, transcribed into `PROVENANCE.md` and consumed literally by Task 2.

- [ ] **Step 1: Install the encoder (one-off)**

```bash
npm i -D wawoff2
```

Expected: adds `wawoff2@2.0.1`. This dependency is temporary and is removed in Step 8.

- [ ] **Step 2: Generate the fixture**

Write `<scratchpad>/gen-woff2.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compress } from 'wawoff2';

const SRC = 'fonts/LiberationSans-Regular.ttf';
const OUT = 'test/fixtures/fonts/LiberationSans-Regular.woff2';

const ttf = readFileSync(SRC);
const woff2 = Buffer.from(await compress(ttf));
mkdirSync('test/fixtures/fonts', { recursive: true });
writeFileSync(OUT, woff2);

const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log(`input  ${SRC}  ${ttf.length} bytes  sha256 ${sha(ttf)}`);
console.log(`output ${OUT}  ${woff2.length} bytes  sha256 ${sha(woff2)}`);
console.log(`wawoff2 ${JSON.parse(readFileSync('node_modules/wawoff2/package.json')).version}`);
```

Run: `node <scratchpad>/gen-woff2.mjs`
Expected: a `.woff2` roughly 120–160 KB. **Record both SHA-256s and the version — Step 7 needs them verbatim.**

- [ ] **Step 3: Run the measurement pass**

Write `<scratchpad>/measure-woff2.mjs`. It reconstructs via our own code and classifies every table:

```js
import { readFileSync } from 'node:fs';
import { sfntFromWoff } from '../src/woff.js';   // adjust to a real relative path, or use tsx

const orig = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));
const woff2 = new Uint8Array(readFileSync('test/fixtures/fonts/LiberationSans-Regular.woff2'));
const rebuilt = sfntFromWoff(woff2);

const dir = (b) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(4); const m = new Map();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    m.set(String.fromCharCode(...b.subarray(o, o + 4)),
          { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) });
  }
  return m;
};
const A = dir(orig), B = dir(rebuilt);
const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

console.log('only in original :', [...A.keys()].filter((t) => !B.has(t)).join(',') || '(none)');
console.log('only in rebuilt  :', [...B.keys()].filter((t) => !A.has(t)).join(',') || '(none)');
for (const tag of [...A.keys()].sort()) {
  if (!B.has(tag)) continue;
  const a = orig.subarray(A.get(tag).off, A.get(tag).off + A.get(tag).len);
  const b = rebuilt.subarray(B.get(tag).off, B.get(tag).off + B.get(tag).len);
  const first = eq([...a], [...b]) ? -1 : [...a].findIndex((v, i) => v !== b[i]);
  console.log(`${tag.padEnd(5)} ${eq([...a], [...b]) ? 'IDENTICAL' : 'DIFFERS'}`.padEnd(18) +
    `len ${A.get(tag).len} -> ${B.get(tag).len}` + (first >= 0 ? `  first diff @${first}` : ''));
}
```

Run it (use `npx tsx` or compile, whichever the repo's tooling makes easiest).
Expected: a per-table `IDENTICAL` / `DIFFERS` listing. **Save this output — it is the source of truth for Tasks 2 and 4.**

- [ ] **Step 4: Investigate every DIFFERS table before accepting it**

For each table reported `DIFFERS`, determine *why*, and write the reason down. Legitimate causes:

| Table | Legitimate reason |
|---|---|
| `loca` | Recomputed from reconstructed `glyf`; `indexToLocFormat` may flip |
| `head` | `checkSumAdjustment` zeroed/recomputed; `indexToLocFormat` rewritten |
| `glyf` | Per-glyph padding to 2- or 4-byte boundaries may differ |

A `DIFFERS` on any other table — `cmap`, `hmtx`, `GSUB`, `GPOS`, `name`, `post`, `maxp`, `OS/2`, `prep`, `fpgm`, `cvt ` — is **not** expected and is a probable bug in `src/woff.ts`. Investigate it as a defect before proceeding; do not paper over it by moving the table to the "differs" list. If it is a real defect, fix `src/woff.ts` — that is this fixture earning its keep.

- [ ] **Step 5: Write the smoke test**

Create `test/woff2-real.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSfnt, type SfntFont } from '../src/sfnt.js';

const ORIGINAL = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));
const FIXTURE = new Uint8Array(readFileSync('test/fixtures/fonts/LiberationSans-Regular.woff2'));

/** Raw bytes of one table, from whichever sfnt the font was reconstructed from. */
export function tableBytes(f: SfntFont, tag: string): Uint8Array {
  const rec = f.tables.get(tag);
  if (!rec) throw new Error(`missing table ${tag}`);
  return f.raw.subarray(rec.offset, rec.offset + rec.length);
}

export const src = (): SfntFont => parseSfnt(ORIGINAL);
export const back = (): SfntFont => parseSfnt(FIXTURE);

describe('WOFF2 real fixture — parse', () => {
  it('reconstructs a glyf font with the original glyph count and metrics', () => {
    const a = back(), b = src();
    expect(a.outlines).toBe('glyf');
    expect(a.numGlyphs).toBe(b.numGlyphs);
    expect(a.numGlyphs).toBe(2620);
    expect(a.unitsPerEm).toBe(b.unitsPerEm);
  });

  it('reconstructs exactly the original table set', () => {
    expect([...back().tables.keys()].sort()).toEqual([...src().tables.keys()].sort());
  });

  it('reconstructs the original cmap', () => {
    expect([...back().cmap.entries()].sort()).toEqual([...src().cmap.entries()].sort());
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run test/woff2-real.test.ts`
Expected: 3 passed.

If "reconstructs exactly the original table set" fails, reconcile against Step 3's "only in original / only in rebuilt" lines. WOFF2 is permitted to drop `DSIG`, and `LiberationSans-Regular.ttf` carries a non-standard `FFTM` table — if either is absent from the rebuilt font, that is legitimate. Narrow the assertion to the tables actually expected to survive and record the exclusion and its reason in `PROVENANCE.md`.

- [ ] **Step 7: Mutation check**

Break the reconstruction and confirm the tests notice:

```bash
# In src/woff.ts, inside sfntFromWoff, corrupt one reconstructed byte —
# e.g. return a copy with sfnt[sfnt.length - 1] ^= 0xff, or force numGlyphs off by one.
npx vitest run test/woff2-real.test.ts     # expect FAIL
git checkout -- src/woff.ts                # revert
npx vitest run test/woff2-real.test.ts     # expect PASS again
```

- [ ] **Step 8: Remove the encoder**

```bash
npm rm wawoff2
git diff --stat package.json package-lock.json   # expect NO net change vs HEAD
```

Expected: `package.json` and `package-lock.json` return to their committed state. If they don't, restore them: `git checkout -- package.json package-lock.json`.

- [ ] **Step 9: Write `test/fixtures/fonts/PROVENANCE.md`**

Model it on `test/fixtures/jpeg/PROVENANCE.md`. It must contain, with **real values from Steps 2–4**, not prose placeholders:

```markdown
# Font test fixtures — provenance

A WOFF2 from a trusted encoder, here to validate `sfntFromWoff` against bytes it
did not produce. See `docs/superpowers/specs/2026-07-20-woff2-real-fixture-design.md`.

## LiberationSans-Regular.woff2

**Encoder:** `wawoff2` <version> (MIT), the Emscripten build of Google's `woff2`
reference implementation. **Installed one-off and removed** — not a dev
dependency. Running the suite needs nothing but these bytes and `node:zlib`.

**Source:** `fonts/LiberationSans-Regular.ttf`, already vendored here, which is
therefore the ground truth. No reference sfnt is committed alongside.

| File | SHA-256 | Bytes |
|---|---|---|
| `fonts/LiberationSans-Regular.ttf` (input) | <sha> | <n> |
| `LiberationSans-Regular.woff2` (output) | <sha> | <n> |

### Command

    import { compress } from 'wawoff2';
    writeFileSync(OUT, Buffer.from(await compress(readFileSync(SRC))));

### Why this face

It is the only vendored font that exercises the hard parts of the WOFF2 `glyf`
transform: 2620 glyphs, **1076 composites** (`compositeStream`), **1484 with
hinting instructions** (`instructionStream`), and **long `loca`**
(`indexToLocFormat=1`). `StandardSymbolsPS.ttf` and `D050000L.ttf` have zero
composites and zero instructions, so they would leave those streams untested.

### Measured round-trip — what "matches the original" means

A WOFF2 round-trip is not byte-identical by construction. Measured with
`sfntFromWoff` against the input TTF:

| Table | Result | Reason if differing |
|---|---|---|
| ... one row per table, transcribed from the measurement pass ... |

`test/woff2-real.test.ts` locks this partition: a table that survives intact
today must keep surviving intact, and one that legitimately differs is asserted
structurally instead.

## Licence

`LiberationSans-Regular.woff2` is the same OFL-1.1 font as its source; the grant
in `fonts/LICENSE-OFL.txt` covers it. Not redistributed to npm consumers:
`package.json` declares `files: ["dist"]`, so `test/` never enters the tarball.
```

- [ ] **Step 10: Commit**

```bash
git add test/fixtures/fonts/ test/woff2-real.test.ts
git commit -m "test(woff2): real-world fixture from Google's reference encoder

Encoded fonts/LiberationSans-Regular.ttf with wawoff2 (installed one-off and
removed) and committed the output. Ground truth is the TTF already vendored
here, so the fixture is a single binary with no reference sfnt beside it.

PROVENANCE.md records the measured table-by-table round-trip result, which is
what the assertions in later tasks are built on.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Lock the byte-identical table partition

**Files:**
- Modify: `test/woff2-real.test.ts`

**Interfaces:**
- Consumes: `tableBytes(f, tag)`, `src()`, `back()` from Task 1; the measured partition from `PROVENANCE.md`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the partition test**

Append to `test/woff2-real.test.ts`. **The two arrays below are the plan's prediction — replace them with the measurement from Task 1 Step 3 before running.** Every tag present in the font must appear in exactly one array.

```ts
/** Tables the WOFF2 round-trip preserves byte-for-byte. From PROVENANCE.md. */
const BYTE_IDENTICAL = [
  'GDEF', 'GPOS', 'GSUB', 'OS/2', 'cmap', 'cvt ', 'fpgm', 'gasp',
  'hhea', 'hmtx', 'kern', 'maxp', 'name', 'post', 'prep',
];

/** Tables WOFF2 is permitted to rebuild. Each is asserted structurally elsewhere. */
const REBUILT = ['glyf', 'head', 'loca'];

describe('WOFF2 real fixture — byte-identical tables', () => {
  it.each(BYTE_IDENTICAL)('reconstructs %s byte-for-byte', (tag) => {
    expect(Array.from(tableBytes(back(), tag)))
      .toEqual(Array.from(tableBytes(src(), tag)));
  });

  it('classifies every table in the font', () => {
    const all = [...src().tables.keys()].sort();
    expect([...BYTE_IDENTICAL, ...REBUILT].sort()).toEqual(all);
  });
});
```

- [ ] **Step 2: Reconcile with the measurement**

Run: `npx vitest run test/woff2-real.test.ts`

If "classifies every table in the font" fails, the arrays disagree with the real table set — fix the arrays, not the assertion. If a `BYTE_IDENTICAL` entry fails its byte comparison, do **not** silently move it to `REBUILT`: re-read Task 1 Step 4 and establish whether it is a defect in `src/woff.ts` first. Any move must be justified in `PROVENANCE.md` with a reason.

Expected once reconciled: all tests pass.

- [ ] **Step 3: Mutation check**

```bash
# In src/woff.ts, flip one byte of a reconstructed non-glyf table
# (e.g. corrupt the first byte of the decompressed 'cmap' payload).
npx vitest run test/woff2-real.test.ts     # expect the matching tag's case to FAIL
git checkout -- src/woff.ts
npx vitest run test/woff2-real.test.ts     # expect PASS
```

- [ ] **Step 4: Commit**

```bash
git add test/woff2-real.test.ts
git commit -m "test(woff2): lock the measured byte-identical table partition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Structural glyf equality across all 2620 glyphs

**Files:**
- Modify: `test/woff2-real.test.ts`

**Interfaces:**
- Consumes: `src()`, `back()` from Task 1.
- Produces: nothing later tasks depend on.

This is the core of the fixture's value: the `glyf` transform's `compositeStream` and `instructionStream` are exercised nowhere else in the tree with real data.

- [ ] **Step 1: Write the structural tests**

Append to `test/woff2-real.test.ts`:

```ts
/** Hinting instruction bytes of a *simple* glyph (`[]` for composite/empty). */
function simpleInstructions(f: SfntFont, gid: number): number[] {
  const g = f.glyphData(gid);
  if (g.length < 10) return [];
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const numContours = v.getInt16(0);
  if (numContours < 0) return [];                 // composite
  const p = 10 + numContours * 2;
  const len = v.getUint16(p);
  return Array.from(g.subarray(p + 2, p + 2 + len));
}

describe('WOFF2 real fixture — glyf reconstruction', () => {
  it('reproduces every glyph outline', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (JSON.stringify(a.glyphOutline(g)) !== JSON.stringify(b.glyphOutline(g))) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces every composite glyph component list', () => {
    const a = back(), b = src();
    let composites = 0;
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      const want = b.componentGids(g);
      if (want.length > 0) composites++;
      if (JSON.stringify(a.componentGids(g)) !== JSON.stringify(want)) bad.push(g);
    }
    expect(bad).toEqual([]);
    expect(composites).toBe(1076);   // guards the fixture itself against silent replacement
  });

  it('reproduces every simple glyph\'s hinting instructions', () => {
    const a = back(), b = src();
    let instructed = 0;
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      const want = simpleInstructions(b, g);
      if (want.length > 0) instructed++;
      if (JSON.stringify(simpleInstructions(a, g)) !== JSON.stringify(want)) bad.push(g);
    }
    expect(bad).toEqual([]);
    expect(instructed).toBe(1484);   // guards the fixture itself against silent replacement
  });
});
```

The `bad` array pattern beats asserting inside the loop: a failure reports *which* glyphs broke, not just the first.

- [ ] **Step 2: Run**

Run: `npx vitest run test/woff2-real.test.ts`
Expected: all pass. If the composite/instructed counts are off, re-derive them — the source font may differ from the plan's measurement; correct the literals and note it in `PROVENANCE.md`.

- [ ] **Step 3: Mutation check — one per stream**

Both must fail; each covers a different sub-stream:

```bash
# (a) compositeStream: in src/woff.ts glyf reconstruction, drop the MORE_COMPONENTS
#     flag handling so composites lose trailing components.
npx vitest run test/woff2-real.test.ts    # expect composite + outline cases to FAIL
git checkout -- src/woff.ts

# (b) instructionStream: emit instructionLength as 0 for every simple glyph.
npx vitest run test/woff2-real.test.ts    # expect the instructions case to FAIL
git checkout -- src/woff.ts

npx vitest run test/woff2-real.test.ts    # expect PASS
```

If (b) does not fail, the instruction assertion is not reaching real data — fix it before committing.

- [ ] **Step 4: Commit**

```bash
git add test/woff2-real.test.ts
git commit -m "test(woff2): structural glyf equality over all 2620 glyphs

Covers compositeStream (1076 composites) and instructionStream (1484
instructed glyphs) against real encoder output for the first time.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: hmtx advances and the rebuilt head/loca fields

**Files:**
- Modify: `test/woff2-real.test.ts`

**Interfaces:**
- Consumes: `src()`, `back()`, `tableBytes` from Task 1.
- Produces: nothing later tasks depend on.

`hmtx` has its own WOFF2 transform (leading-`lsb` elimination), so it is asserted through the parsed model even when Task 2 already covers its bytes — the two would diverge if the table were preserved but misparsed. `head` and `loca` are rebuilt, so they get masked/structural treatment.

- [ ] **Step 1: Write the tests**

Append to `test/woff2-real.test.ts`:

```ts
describe('WOFF2 real fixture — hmtx and rebuilt tables', () => {
  it('reproduces every advance width', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (a.advanceWidth(g) !== b.advanceWidth(g)) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces every left side bearing', () => {
    const a = tableBytes(back(), 'hmtx'), b = tableBytes(src(), 'hmtx');
    const numH = new DataView(tableBytes(src(), 'hhea').buffer,
      tableBytes(src(), 'hhea').byteOffset, tableBytes(src(), 'hhea').byteLength).getUint16(34);
    const av = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const bad: number[] = [];
    for (let g = 0; g < numH; g++) {
      if (av.getInt16(g * 4 + 2) !== bv.getInt16(g * 4 + 2)) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces head except the fields WOFF2 recomputes', () => {
    const a = Array.from(tableBytes(back(), 'head'));
    const b = Array.from(tableBytes(src(), 'head'));
    expect(a.length).toBe(b.length);
    // checkSumAdjustment @8..11 and indexToLocFormat @50..51 are recomputed.
    const mask = (t: number[]) => t.map((v, i) => (i >= 8 && i < 12) || i === 50 || i === 51 ? 0 : v);
    expect(mask(a)).toEqual(mask(b));
  });

  it('rebuilds loca consistently with glyf', () => {
    const a = back();
    expect(a.loca.length).toBe(a.numGlyphs + 1);
    expect(a.loca[0]).toBe(0);
    for (let g = 0; g < a.numGlyphs; g++) expect(a.loca[g + 1]).toBeGreaterThanOrEqual(a.loca[g]);
    expect(a.loca[a.numGlyphs]).toBeLessThanOrEqual(a.glyf.length);
    expect([0, 1]).toContain(a.indexToLocFormat);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/woff2-real.test.ts`
Expected: all pass.

If the `head` masked comparison fails, print the differing offsets and identify the field before widening the mask — an unexplained `head` difference is a bug, and every masked byte must be justified in `PROVENANCE.md`.

- [ ] **Step 3: Mutation check**

```bash
# In src/woff.ts hmtx reconstruction, add 1 to every reconstructed advance.
npx vitest run test/woff2-real.test.ts    # expect the advance-width case to FAIL
git checkout -- src/woff.ts
npx vitest run test/woff2-real.test.ts    # expect PASS
```

- [ ] **Step 4: Commit**

```bash
git add test/woff2-real.test.ts
git commit -m "test(woff2): hmtx advances/lsb and the rebuilt head and loca

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end embedding through Save/Open

**Files:**
- Modify: `test/woff2-real.test.ts`

**Interfaces:**
- Consumes: `FIXTURE` from Task 1; `Document` from `src/document.js`; `buildStampTarget` from `test/helpers/build-stamp-target.js`.
- Produces: nothing later tasks depend on.

Tasks 2–4 assert reconstruction in isolation. This asserts the reconstructed font survives the real embedding path — subsetting, `Save`, reopen — which is what a user actually does with a `.woff2`.

- [ ] **Step 1: Write the test**

Add the imports at the top of `test/woff2-real.test.ts`:

```ts
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
```

Append:

```ts
describe('WOFF2 real fixture — end to end', () => {
  it('embeds and subsets through AddFont/Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hamburgefonstiv', 20, 50, { font });
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toContain('Hamburgefonstiv');
  });

  it('subsets to far less than the full font', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hi', 20, 50, { font });
    // A 2620-glyph face subset to 2 glyphs must not approach the 410KB original.
    expect(doc.Save().length).toBeLessThan(100_000);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/woff2-real.test.ts`
Expected: all pass.

If the subset-size assertion fails, do not simply raise the bound — check whether subsetting actually ran. A near-410KB output means the whole face was embedded, which is a real defect worth filing.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: every test passes, including the pre-existing `test/woff.test.ts`. Note the new total; it should be the prior 1620 plus the cases added here.

- [ ] **Step 4: Commit**

```bash
git add test/woff2-real.test.ts
git commit -m "test(woff2): end-to-end embed and subset from the real fixture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Gates, follow-up issue, close, push

**Files:**
- Modify: `test/fixtures/fonts/PROVENANCE.md` (final "Coverage" section)

**Interfaces:**
- Consumes: everything above.
- Produces: the closed issue and a pushed branch.

- [ ] **Step 1: Both gates**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean, full suite green. Fix anything red before continuing — do not proceed on a partial pass.

- [ ] **Step 2: Confirm no dependency leaked in**

```bash
git diff origin/main -- package.json package-lock.json
```

Expected: **empty**. `wawoff2` must not appear anywhere in the committed tree:

```bash
git grep -n wawoff2 -- . ':!docs/'
```

Expected: no hits outside `docs/` (the spec and this plan legitimately name it).

- [ ] **Step 3: Add the Coverage section to PROVENANCE.md**

Mirror the closing section of `test/fixtures/jpeg/PROVENANCE.md`, stating what this fixture uniquely covers and — honestly — whether it found a bug:

```markdown
## Coverage

| Dimension | Covered by |
|---|---|
| brotli-compressed table directory from a real encoder | the fixture as a whole |
| `glyf` transform, `compositeStream` | 1076 composite glyphs |
| `glyf` transform, `instructionStream` | 1484 instructed glyphs |
| long `loca` (`indexToLocFormat=1`) | the fixture's rebuilt `loca` |
| `hmtx` transform against real advances | all 2620 glyphs |
```

Then state the outcome plainly — either the defect it exposed (as `testimgari.jpg` did) or, if none, that it is a guard and that the mutation checks in the task list proved it load-bearing rather than merely green.

- [ ] **Step 4: File the CFF-flavoured follow-up**

```bash
bd create "Real-world CFF-flavoured (OTF) WOFF2 fixture" -p 4 -t task \
  -d "test/fixtures/fonts/ covers glyf-flavoured WOFF2 only. A CFF-flavoured
file skips the glyf transform entirely and is a distinct path through
sfntFromWoff. The repo vendors no CFF/OTF font to encode, so this needs an
open-licence OTF sourced first. Split out of da9."
```

- [ ] **Step 5: Commit and close**

```bash
git add test/fixtures/fonts/PROVENANCE.md
git commit -m "docs(woff2): record fixture coverage and outcome

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

bd close aspose-pdf-foss-for-ts-da9 --reason "Real .woff2 from wawoff2 (Google's woff2 reference encoder) over fonts/LiberationSans-Regular.ttf committed at test/fixtures/fonts/, with PROVENANCE.md recording the measured table partition. test/woff2-real.test.ts asserts byte-identical tables, structural glyf equality over all 2620 glyphs including 1076 composites and 1484 instructed, hmtx advances/lsb, masked head, rebuilt loca, and end-to-end embed. Follow-up filed for CFF-flavoured WOFF2."
```

- [ ] **Step 6: Push — the session is not complete until this succeeds**

```bash
git pull --rebase
git push
git status        # MUST show "up to date with origin"
```

---

## Self-review notes

**Spec coverage.** Every section of `docs/superpowers/specs/2026-07-20-woff2-real-fixture-design.md` maps to a task: fixture generation and one-off tool removal → Task 1 Steps 1–2, 8; layout and licence → Task 1 Step 9; measurement pass → Task 1 Steps 3–4; the six spec test rows → Task 1 Step 5 (parse), Task 2 (byte-exact), Task 3 (glyf), Task 4 (hmtx, head/maxp), Task 5 (end-to-end); "fix `src/woff.ts` if a defect surfaces" → Task 1 Step 4 and the mutation checks; CFF follow-up → Task 6 Step 4; success criteria → Task 6 Steps 1–3.

**Deliberate deviation from the spec.** The spec's test table lists `maxp` alongside `head` for field-by-field comparison. `maxp` is expected on the byte-identical list (Task 2), so Task 4 covers only `head`. If the Task 1 measurement puts `maxp` in `REBUILT`, that is a surprise worth investigating as a defect before adding a masked `maxp` comparison.

**Known adaptation.** The spec says assert `lsb` via the parsed model; `SfntFont` exposes `advanceWidth(gid)` but no `lsb` accessor, so Task 4 reads `lsb` from the raw `hmtx` bytes instead. Same assertion, available API.
