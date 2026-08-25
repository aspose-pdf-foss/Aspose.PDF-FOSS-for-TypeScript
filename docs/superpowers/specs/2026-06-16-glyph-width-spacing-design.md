# Real Glyph-Width Spacing for Text Extraction — Design

**Issue:** aspose-pdf-foss-for-ts-722 (P3, feature)
**Date:** 2026-06-16
**Discovered from:** aspose-pdf-foss-for-ts-e37 (Page text extraction)

## Goal

Replace the 0.5em-per-char glyph-advance estimate in `Page.GetText()` with real
font metrics so intra-line spacing and run geometry are accurate. Read embedded
width tables — `/Widths` for simple fonts, the descendant font's `/W` for Type0 —
and feed true advances into both `Tm` advancement and run `endX`. Line breaking
and run ordering are unaffected.

## Scope decisions (settled during brainstorming)

1. **Embedded widths only.** Use `/Widths` (simple) and `/W` (Type0/CID) when
   present. Fonts with no embedded widths — including the 14 standard fonts that
   ship metrics only in built-in AFM tables — keep the existing 0.5em estimate.
   Bundling AFM width tables for the standard-14 is **out of scope** (possible
   follow-up). Most real PDFs embed `/Widths` even for base fonts, so this covers
   the common case without shipping ~14×256 static constants.
2. **Internal-only change.** `decode(bytes): string` stays as a thin wrapper so
   existing callers and tests are untouched; a new `decodeRun` carries the width.
3. **Per-run return shape** `{ text, width, ncodes, nWordSpaces }` rather than
   per-code width arrays — single-pass, minimal allocation.
4. **Non-breaking.** Existing integration fixtures use Helvetica with no
   `/Widths`, so they stay on the estimate path and keep their current output.

## The core correctness fix

Glyph advance is per **character code**, but `decode()` returns a *string* whose
length differs from the code count: `/ToUnicode` can map one code to multiple
chars (ligatures → "ﬁ" = "fi") or to none, and unmapped Type0 codes are dropped.
The current code measures advance from `text.length` (`emitRunAt`) and char count
(`advance`), which is wrong whenever decoded length ≠ code count. The new design
measures per code, decoupling advance from output length.

## Component changes

### `src/font.ts`

**Constructor — parse width tables:**

- **Simple fonts:** read `/FirstChar` (int) and `/Widths` (number array). Build a
  `code → width` lookup covering `FirstChar .. FirstChar+Widths.length-1`. Read
  `/MissingWidth` from `/FontDescriptor` (default `0`) for in-range gaps and
  out-of-range codes. If `/Widths` is absent entirely, the font has **no width
  info** → estimate path.
- **Type0 fonts:** resolve `/DescendantFonts[0]`; read its `/W` array and `/DW`
  (default `1000`). Parse both `/W` entry forms:
  - `c [w1 w2 w3 ...]` — widths for consecutive CIDs starting at `c`.
  - `cFirst cLast w` — width `w` for every CID in `cFirst..cLast`.
  Build a `cid → width` lookup; misses use `/DW`. CID is taken equal to the code
  (Identity), consistent with the existing Type0 decode path. If no `/W` and no
  `/DW`, `/DW` defaults to 1000 — Type0 fonts therefore always have width info.

Widths are stored in glyph space (1000 units = 1 em); the returned `width` is the
sum divided by 1000 (em units).

**New method:**

```ts
decodeRun(bytes: Uint8Array): {
  text: string;        // decoded Unicode (same as decode())
  width: number;       // Σ(glyphWidth/1000) in em units, excludes Tc/Tw
  ncodes: number;      // number of codes consumed (for Tc)
  nWordSpaces: number; // count of single-byte code 0x20 (for Tw)
};
```

Iterates codes exactly as `decode` does (codeWidth-byte steps). For each code:
accumulates decoded text, adds the glyph width (or, when the font has no width
info, `0.5`), increments `ncodes`, and increments `nWordSpaces` when `codeWidth
=== 1 && code === 0x20`.

```ts
decode(bytes: Uint8Array): string { return this.decodeRun(bytes).text; }
```

A private `hasWidths` flag (true when `/Widths` or `/W`/`/DW` produced a table)
selects real-width vs. estimate accumulation.

### `src/text.ts`

Replace the two 0.5em sites (`advance()` and `emitRunAt`'s `text.length * 0.5`)
with the run width from `decodeRun`:

- **`show()`** — `const { text, width, ncodes, nWordSpaces } = font.decodeRun(bytes)`;
  compute text-space advance
  `tx = (width * fontSize + ncodes * charSp + nWordSpaces * wordSp) * hscale`;
  emit the run with device end derived from `tx`; then `tm = mul(translate(tx,0), tm)`.
- **`showArray()`** (TJ) — same per string element; the numeric TJ adjustments
  (and their large-gap → space heuristic) are unchanged.
- **`emitRunAt`** — takes the text-space advance and sets
  `endX = x + tx * vscale(comb)` instead of estimating from `text.length`.
- **`advance()`** — folded into the `show`/`showArray` width computation; removed
  as a separate function (single width source).

Run `x`, `y`, `size` and the assembly logic (`assembleLines`) are unchanged.

## Testing

- **`test/font.test.ts`** — `decodeRun` width assertions:
  - simple font with `/FirstChar` + `/Widths` → exact per-code widths summed.
  - in-range gap / out-of-range code → `/MissingWidth`.
  - font with no `/Widths` → estimate (`0.5 × ncodes`).
  - Type0 with `/W` (both entry forms) + `/DW` → exact and default widths.
  - `decode()` still returns text unchanged (regression guard).
- **`test/text.test.ts`** — integration fixture with explicit narrow `/Widths`
  where real metrics flip the space-inference outcome vs. the 0.5em guess (e.g.,
  glyphs narrow enough that two runs sit adjacent with real widths but would read
  as gapped under the estimate, or vice versa). Assert the corrected text.
  Existing Helvetica fixtures (no `/Widths`) keep current output — verifies the
  change is non-breaking.

Run `npm run typecheck` and `npm test` green before closing.

## Out of scope (possible follow-ups)

- Bundled AFM width tables for the 14 standard fonts.
- Non-Identity CID maps (`/CIDToGIDMap` stream, non-Identity `/Encoding` CMaps)
  for width lookup — Identity is assumed, matching the current decode path.
- Vertical writing-mode advances (`/W2`, `/DW2`).
