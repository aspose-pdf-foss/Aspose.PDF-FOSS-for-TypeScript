# Complex-text shaping — Phase 2: Unicode data + bidi (UAX #9)

**Issue:** aspose-pdf-foss-for-ts-8u0.2 (parent 8u0; blocks 8u0.3)
**Date:** 2026-07-09
**Status:** Approved design

Phase 2 of the complex-text-shaping work (parent spec:
`2026-07-08-complex-text-shaping-design.md`). It delivers **only** the pure,
dependency-free Unicode foundation — the UCD data generator, the generated data
module, and `bidi.ts` — plus exhaustive conformance tests. It is independent of
Phase 1 (`otlayout.ts`) and inert until Phase 3 (8u0.3) wires it into shaping.

## Scope boundary

**In scope:** `scripts/gen-ucd.mjs`, generated `src/unicode-data.ts`,
`src/bidi.ts`, tests, a committed `BidiCharacterTest.txt` fixture, and
`.gitignore` / `package.json` updates.

**Out of scope (Phase 3 / later):** `shape.ts`, `otemit.ts`, `AddText`/document
wiring, Unicode normalization (NFC/NFD), line-breaking (UAX #14), width/
measurement, glyph selection. No existing document/render/emit path is touched;
byte-for-byte output is unchanged for every current document.

## Decisions (from brainstorming)

1. **Full UAX #9 including isolates** — all rules P2–P3, X1–X10 (explicit
   embeddings/overrides **and** isolates LRI/RLI/FSI/PDI), W1–W7, N0–N2 (paired
   brackets), I1–I2, L1–L2. Conformant, not a subset.
2. **Conformance via the official `BidiCharacterTest.txt`, run in full** —
   committed under `test/fixtures/unicode/` (~2 MB, dev-only, never shipped);
   a vitest driver runs every row. The 40 MB class-based `BidiTest.txt` is not used.
3. **Raw UCD sources are downloaded on demand by `gen:ucd` into a gitignored
   `unicode/` dir** — only the generated `src/unicode-data.ts` and the test
   fixture are committed. Building and testing never need the network; only
   regeneration does.
4. **Generator is plain-node `.mjs`** — matches the existing
   `scripts/gen-std14-fonts.mjs`; no TypeScript-runner dev dependency added.
   (This deviates from the parent spec's literal `gen-ucd.ts` wording.)

**Unicode version:** pinned to **16.0.0** via a constant at the top of
`gen-ucd.mjs`; bump-and-regenerate to update.

## Module 1 — `scripts/gen-ucd.mjs` (dev-only)

`npm run gen:ucd`:

1. Downloads the pinned-version UCD files via `node:https` into gitignored
   `unicode/`:
   - `ucd/extracted/DerivedBidiClass.txt` → Bidi_Class (incl. `@missing` defaults)
   - `ucd/UnicodeData.txt` → Canonical_Combining_Class (field 3)
   - `ucd/Scripts.txt` → Script
   - `ucd/extracted/DerivedJoiningType.txt` → Joining_Type (incl. defaults)
   - `ucd/ArabicShaping.txt` → Joining_Group
   - `ucd/BidiBrackets.txt` → paired-bracket property + type
   - `ucd/BidiMirroring.txt` → mirror glyph
   - `ucd/BidiCharacterTest.txt` → conformance fixture
   Base URL: `https://www.unicode.org/Public/<version>/ucd/…`.
2. Parses each file into sorted, coalesced ranges (see Module 2 encoding).
3. Emits `src/unicode-data.ts` (generated header noting version + source files).
4. Copies `BidiCharacterTest.txt` into the committed
   `test/fixtures/unicode/BidiCharacterTest.txt` so a clean checkout tests offline.

The script is idempotent and re-runnable; downloaded raw files are cached in
`unicode/` and reused if present.

## Module 2 — `src/unicode-data.ts` (generated, committed, ships in package)

Range-compressed sorted tables as flat numeric arrays (`[start, end, value, …]`),
with binary-search accessors. Every table has **total code-point coverage** by
seeding each property's `@missing` default ranges, so every lookup resolves
without a special "not found" branch.

Accessors:

| Function | Returns |
|---|---|
| `bidiClass(cp): number` | Bidi_Class enum id (L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON, LRE, LRO, RLE, RLO, PDF, LRI, RLI, FSI, PDI) |
| `combiningClass(cp): number` | Canonical_Combining_Class (0–254) |
| `script(cp): number` | Script enum id |
| `joiningType(cp): number` | Joining_Type (U, R, L, D, C, T) |
| `joiningGroup(cp): number` | Joining_Group enum id |
| `bracket(cp): { type: 0\|1; pair: number } \| undefined` | paired-bracket: 0 = open, 1 = close; `pair` = the matching code point |
| `mirror(cp): number` | mirrored code point, or `cp` if none |

Plus exported enum constants (`BC.L`, `BC.AL`, …) used by `bidi.ts`, and a
`scriptTag(scriptId): { tag: string; rtl: boolean }` map (`arab`/rtl,
`hebr`/rtl, `latn`/ltr, …) for itemization.

**N0 canonical-equivalence:** the two canonically-equivalent bracket pairs
(U+2329/U+3008 and U+232A/U+3009) are normalized in the generated bracket table
so N0 matching treats them as equal, per UAX #9 BD16.

Estimated size ~100–150 KB (negligible beside the 3.1 MB bundled fonts).

## Module 3 — `src/bidi.ts` (pure, hand-written)

Small pure functions, plain arrays in/out, no shared mutable state, no font or
document dependency. Each is independently testable.

```ts
// P2/P3 first-strong (skips isolate-initiator…matching-PDI spans);
// 'ltr'/'rtl' force it, 'auto' derives. Returns paragraph embedding level.
export function paragraphLevel(codes: number[], dir: 'ltr' | 'rtl' | 'auto'): 0 | 1;

// X1–X10 + W + N + I. `levels[k]` = resolved level; `removed[k]` = true for
// X9-removed chars (RLE/LRE/RLO/LRO/PDF/BN).
export function resolveLevels(codes: number[], paraLevel: 0 | 1):
  { levels: Int8Array; removed: boolean[] };

// L1 (reset separators + trailing/pre-separator whitespace & isolates to
// paragraph level) then L2 (reverse runs by level, highest first).
// Returns visual-order indices, excluding X9-removed characters.
export function reorder(codes: number[], levels: Int8Array, removed: boolean[],
  paraLevel: 0 | 1): number[];

// Convenience: paragraphLevel → resolveLevels → reorder for one line.
export function reorderLine(codes: number[], dir: 'ltr' | 'rtl' | 'auto'):
  { paraLevel: 0 | 1; levels: Int8Array; removed: boolean[]; order: number[] };

// L4 mirror lookup, exposed for Phase 3 emission.
export function mirror(cp: number): number;

// Script itemization: Common/Inherited resolved to the surrounding run
// (paired-bracket matching keeps bracket pairs in one run); split at boundaries.
export function itemizeScripts(codes: number[]):
  { start: number; end: number; script: number; otTag: string; rtl: boolean }[];

// Arabic cursive joining (Arabic shaping, not bidi): per-position feature to
// enable, from Joining_Type (D/R/L/C/U) skipping Transparent (T) neighbours.
export function arabicJoiningForms(codes: number[], start: number, end: number):
  ('isol' | 'init' | 'medi' | 'fina' | null)[];
```

**Internal structure of `resolveLevels`:**

- **X1–X8** — a directional-status stack of `{ level, override, isolate }`
  entries (max depth `MAX_DEPTH = 125`), plus `overflowIsolate`,
  `overflowEmbedding`, and `validIsolate` counters, processing RLE/LRE/RLO/LRO,
  PDF, RLI/LRI/FSI (FSI resolved by P2/P3 over its isolate span), PDI, B, and
  BN exactly per the rules.
- **X9** — RLE/LRE/RLO/LRO/PDF/BN flagged in `removed`; they keep a level for
  the test's `x` handling but are excluded from reordering.
- **X10** — partition into **isolating run sequences** (matching isolate
  initiators to PDIs), each with sos/eos boundary types; run W/N/I per sequence.
- **W1–W7**, **N0** (BD16 paired-bracket stack, canonical-equivalence aware),
  **N1–N2**, **I1–I2** as specified.

**Degradation:** malformed/empty input returns identity (level = paraLevel,
order = 0..n-1), never throws — consistent with the library convention.

## Testing

- **`test/bidi-conformance.test.ts`** — reads
  `test/fixtures/unicode/BidiCharacterTest.txt`, and for **every** data row
  parses `codepoints; paragraphDirection; resolvedParagraphLevel; levels;
  reorder`, runs `paragraphLevel` + `resolveLevels` + `reorder`, and asserts the
  resolved paragraph level, per-character levels (`x` for removed), and visual
  reorder all match. Runs all three `paragraphDirection` values (auto/LTR/RTL)
  as encoded per row. This is the gold-standard gate and also validates the
  generated `unicode-data.ts` tables end-to-end.
- **`test/bidi.test.ts`** — focused units for what the conformance file exercises
  indirectly:
  - `itemizeScripts`: Latin↔Arabic↔Han boundaries, shared/common punctuation and
    inherited combining marks folded into the surrounding run, bracket pairs kept
    together.
  - `arabicJoiningForms`: isolated / initial / medial / final selection, a
    transparent mark between two joiners, right-joining vs dual-joining, and a
    non-joining (U) break.
  - `mirror`: a mirrored bracket and a non-mirrored character.

## Deliverables checklist

- `scripts/gen-ucd.mjs` + `package.json` `gen:ucd` script
- `.gitignore` entry for `unicode/`
- generated `src/unicode-data.ts` (committed)
- `src/bidi.ts`
- `test/fixtures/unicode/BidiCharacterTest.txt` (committed)
- `test/bidi-conformance.test.ts`, `test/bidi.test.ts`
- `npm run typecheck` and `npm test` green

## Follow-ups (filed separately, not in this issue)

- Parent spec drift: `gen-ucd.ts` → `.mjs`, and sources downloaded rather than
  vendored — reconcile the parent design doc.
- Unicode normalization (NFC/NFD) if Phase 3 shaping needs it.
- UAX #14 line-breaking (current plan breaks only at spaces).
