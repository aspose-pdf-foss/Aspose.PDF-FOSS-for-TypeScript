# UAX #14 Line-Breaking for Wrapped (Shaped) Text — Design

**Issue:** aspose-pdf-foss-for-ts-aq4 (follow-up to complex-text shaping 8u0.3)
**Date:** 2026-07-10
**Status:** Approved

## Problem

`AddTextBlock` wraps text by splitting on `\n` (paragraphs) and ASCII space
(words), then greedily packing words into the box (`src/layout.ts`,
`layoutText`). Break opportunities therefore exist **only at U+0020 spaces**. This
cannot wrap space-less scripts (CJK), and ignores the UAX #14 break rules that
govern Arabic and other complex scripts. The Phase 2 design and the 8u0.3 plan
explicitly deferred UAX #14 line-breaking to this issue.

The core difficulty: UAX #14 introduces **zero-width** break opportunities
(between two CJK ideographs, after a hyphen) — there is no separator character to
consume when breaking or to restore in the re-flowable remainder.

## Decisions

Two design decisions were made during brainstorming:

1. **Application scope: universal path, Latin parity preserved.** One code path,
   but tailored so existing Latin / Standard-14 wrapping output stays
   byte-for-byte identical; CJK and complex scripts gain breaks.
2. **Conformance: full UAX #14 default algorithm.** Implement the complete
   algorithm (all ~44 break classes, rules LB1–LB31 via the pair table) as a pure
   function, verified against Unicode's `LineBreakTest.txt`, mirroring the bidi
   work's `BidiCharacterTest.txt` conformance fixture.

## Architecture

Three layers, each independently testable, following the existing UCD/bidi
patterns.

### 1. Data layer — `scripts/gen-ucd.mjs` → `src/unicode-data.ts`

Extend the pinned-version (Unicode 16.0.0) generator to download two more UCD
files and emit them into the committed, generated `src/unicode-data.ts`:

- **`LineBreak.txt`** → a range-compressed `_lb` `[start, end, id]` triple table
  plus an `LB` class enum, with a `lineBreak(cp: number): number` binary-search
  accessor — mirroring `bidiClass` / `joiningType` exactly. The `LB` enum covers
  the UAX #14 classes: `BK, CR, LF, CM, NL, SP, ZW, OP, CL, CP, QU, GL, NS, EX,
  SY, IS, PR, PO, NU, AL, HL, ID, IN, HY, BA, BB, B2, CB, CJ, WJ, H2, H3, JL, JV,
  JT, AI, SA, SG, XX, RI, EB, EM, ZWJ` (and the default/unknown mapping for
  unassigned code points, per `@missing` lines).
- **`auxiliary/LineBreakTest.txt`** → committed as a conformance fixture, exactly
  as `BidiCharacterTest.txt` is committed for bidi.

No hand-editing of `unicode-data.ts`; it is regenerated via `npm run gen:ucd`.

### 2. Pure engine — `src/linebreak.ts` (new)

```ts
export const LBRK = { PROHIBITED: 0, ALLOWED: 1, MANDATORY: 2 } as const;

/** UAX #14 break classification of the boundary BEFORE each position.
 *  result.length === codes.length; result[0] is PROHIBITED (start of text / LB2).
 *  Pure; never throws for any input (unassigned → AL per default). */
export function lineBreakOpportunities(codes: number[]): Uint8Array;
```

Implements the UAX #14 **default** algorithm:

- **Class resolution** (LB1): `AI, SG, XX → AL`; `SA → CM` if the code point is a
  combining mark else `AL`; `CJ → NS`; `CB` handled per LB20; treat resolved
  classes downstream.
- **Rules LB2–LB31** via the pair table, including the stateful cases:
  - LB4/LB5 mandatory breaks (`BK`, `CR`, `LF`, `NL`), LB6 no break before them.
  - LB7 (SP/ZW), LB8 (break after ZW), LB8a (no break after ZWJ).
  - LB9 combining marks / ZWJ attach to the preceding non-space base (`X CM* → X`),
    LB10 (stray CM → AL).
  - LB11–LB19 (WJ, GL, CL/CP/QU/OP spacing, B2, `HY`/`BA`/`NS`/`BB`, HL, IN, quotes).
  - LB21a (HL HY/BA prohibits the next break), LB22, LB23/LB23a (alpha-numeric,
    PR/PO with numeric), LB24, LB25 (numeric sequences — the regex-style rule),
    LB26/LB27 (Korean syllable blocks: H2/H3/JL/JV/JT), LB28–LB30, LB30a
    (regional-indicator pairs), LB30b (EB/EM), LB31 (default: break allowed).

The function is the **conformance surface** — the complete spec algorithm,
independent of how the wrapper consumes it. Zero runtime deps; operates over a
code-point array (callers use `[...text].map(c => c.codePointAt(0)!)`, matching
`shape.ts`).

### 3. Wrapper integration — `src/layout.ts`

Preserve the paragraph-split and greedy **space-based word packing unchanged** —
this is what guarantees Latin byte-parity. The single behavioral change targets
the **over-wide token** case: today a token wider than the box (a whole CJK run
has no spaces, so it is one token) is placed alone and overflows horizontally.
Instead, sub-break **only over-wide tokens** at their UAX #14 opportunities into
box-fitting pieces:

- A normal Latin word that fits the box → untouched → identical output.
- A space-less CJK paragraph is one giant token → sub-broken → wraps.
- An over-wide hyphenated Latin word → breaks at the hyphen rather than
  overflowing (a strict improvement; only affects words already wider than the
  whole box).

The wrapped-line model replaces the `endsParagraph: boolean` with a per-line
`sepAfter: ' ' | '' | '\n'`, so the re-flowable remainder restores the correct
separator: `' '` for a soft space wrap, `'\n'` for a paragraph boundary, and
`''` for a zero-width CJK/complex break. Sub-pieces of one original token are
joined with `''` (no phantom space) during both line emission and remainder
reconstruction.

This flows through `layoutText`, so both the non-shaped embedded path and the
shaped per-line path (`buildShapedBlockBody`, `shapedDriver`) inherit CJK
wrapping with no changes at those call sites. Mandatory breaks (LB4/LB5) inside a
sub-broken token are honored as forced breaks.

## Data Flow

```
text → paragraphs (split '\n')
     → words (split ' ', collapse empties)  [Latin path unchanged]
     → for each over-wide word:
          codes = [...word].map(cp)
          brk   = lineBreakOpportunities(codes)   // src/linebreak.ts
          → sub-pieces at ALLOWED/MANDATORY boundaries that fit boxWidth
     → greedy pack (space-joined words, ''-joined sub-pieces)
     → keep height-fitting lines; rebuild remainder with sepAfter
```

## Testing

- **Conformance** — `test/linebreak-conformance.test.ts` parses
  `test/fixtures/unicode/LineBreakTest.txt` (~9800 cases) and asserts every `÷`
  (break) / `×` (no-break) boundary against `lineBreakOpportunities`. Mirrors
  `test/bidi-conformance.test.ts`, which reads
  `test/fixtures/unicode/BidiCharacterTest.txt`.
- **Unit** — targeted: CJK ideograph↔ideograph break; no break before closing
  punctuation (`CL`/`CP`); non-breaking space / word-joiner (`GL`/`WJ`); hyphen
  and break-after (`HY`/`BA`); mandatory (`BK`/`CR`/`LF`/`NL`); combining-mark
  attachment (`CM`); regional-indicator pairs (`RI`).
- **Integration** — `AddTextBlock` with a long CJK string wraps to multiple
  lines (previously one overflowing line); a shaped CJK block wraps and
  round-trips through `Save`/`GetText`.
- **Regression / parity** — existing `layoutText` / `textblock` / stamp tests
  stay green (Latin output byte-identical), plus an explicit assertion that a
  fitting hyphenated Latin word (e.g. `well-known`) wraps exactly as before.

## Scope / Non-Goals

- No hyphenation dictionaries (no soft-hyphen insertion beyond honoring existing
  `SHY` U+00AD per UAX #14).
- No script-specific line-break tailorings (e.g. CSS `line-break: strict`); only
  the UAX #14 default algorithm.
- No change to justification: the shaped/embedded path already falls back to left
  alignment; `Tw` justification for Standard-14 is unaffected.
- Vertical writing remains out of scope.

## Files

| File | Change |
|---|---|
| `scripts/gen-ucd.mjs` | add `LineBreak.txt` + `auxiliary/LineBreakTest.txt`; emit `_lb`/`LB`/`lineBreak` |
| `src/unicode-data.ts` | (generated) gains `LB`, `_lb`, `lineBreak()` |
| `src/linebreak.ts` | **new** — `lineBreakOpportunities()`, full UAX #14 LB1–LB31 |
| `src/layout.ts` | over-wide-token sub-break; `sepAfter` line model + remainder |
| `unicode/LineBreak.txt`, `unicode/LineBreakTest.txt` | cached UCD inputs (gitignored under `/unicode/`) |
| `test/fixtures/unicode/LineBreakTest.txt` | committed conformance fixture (alongside `BidiCharacterTest.txt`) |
| `test/linebreak-conformance.test.ts` | **new** — `LineBreakTest.txt` conformance run |
| `test/linebreak.test.ts` | **new** — unit tests |
| `test/textblock.test.ts` | CJK wrap integration + Latin parity assertions |
