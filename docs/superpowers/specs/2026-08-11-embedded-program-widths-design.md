# Glyph widths from the embedded font program

Design for `aspose-pdf-foss-for-ts-imxw.4`, the last child of the `imxw` epic
(interpreter coverage for legacy font and function types).

## Problem

A simple font's advances come from `/Widths`. When `/Widths` cannot answer,
[font.ts](../../../src/font.ts)'s `advance()` falls back to a guess, and the
guess is wrong in two distinct ways:

**No `/Widths` at all.** `parseSimpleWidths` returns `undefined`, and the font
measures from `std14Widths(this.name, …)` — the Adobe AFM tables for whichever
Standard-14 face `normalizeFont` maps `/BaseFont` onto. An embedded font named
`/AAAAAB+MyCustomFont` normalises to **Helvetica**, so the renderer draws that
font's real outlines at Helvetica's advances. Only a Standard-14 face may omit
`/Widths` (32000-1 9.6.2.2), so such a file is malformed — but the font program
is right there, and it knows.

**`/Widths` present but short.** A code outside `FirstChar..LastChar` gets
`/MissingWidth`, which defaults to **0**. Every such glyph advances nowhere, so
they pile up on one another. This is the more common shape of the two.

Both reach `GetText`, `GetTextFragments`, `ToImage` and `ToSvg` alike, because
`text.ts` and `pagerender.ts` build the same `TextFont`.

## Scope

In scope: widths from an embedded program for all three kinds a simple font may
carry — Type 1 (`/FontFile`), TrueType (`/FontFile2`) and CFF (`/FontFile3`).

Out of scope:

- **Composite (Type 0) fonts.** Their `/W` array is keyed by CID and `/DW`
  supplies a real default (1000), so neither failure above applies.
- **Vertical metrics.** `/W2`/`/DW2` are a composite-font concern.
- **Type 3 widths**, which `imxw.1` already fixed: `TextFont.widthScale` is
  `fontMatrix[0]`, so `/Widths` are read in the font's own glyph space. A Type 3
  font has no `/FontFile*` and cannot reach the new path at all.

## A question this closes rather than answers

The issue's notes ask about the `/FontMatrix` skew terms `b` and `c`, which
`drawType3Run` applies to the ink while `glyphDisplacement` ignores them in the
advance. That asymmetry is **correct, not a bug**: 32000-1 9.4.4 defines the
glyph displacement as the scalar `tx` along the writing direction, so only the
`a` term reaches the advance, and a rotated `/FontMatrix` skews the drawn glyph
without steering the pen. Recorded here so it is not reopened.

## Architecture

### The obstacle

Resolving a character code to a glyph id over an embedded program already exists
— `buildGlyphSource` and `gidForCode` in [raster.ts](../../../src/raster.ts),
built for rendering in `imxw.2`. `font.ts` cannot import it: `raster.ts` imports
`font.ts`.

Writing a second copy is the option this codebase most consistently rejects. The
invariant `imxw.2` established is that code → glyph *name* has exactly one
owner, precisely because two copies of that question came to disagree. The same
reasoning applies one level down.

### `src/glyphprogram.ts` — the shared half

A new module owning "what program does this font descriptor carry, and what does
it say about a glyph":

```ts
export interface EmbeddedProgram { sfnt?: SfntFont; cff?: CffFont; type1?: Type1Font; }

/** Load whichever of /FontFile, /FontFile2, /FontFile3 the descriptor carries. */
export function loadEmbeddedProgram(
  fd: PdfObject | undefined, resolve: Resolve, inflate: Inflate,
): EmbeddedProgram;

/** Code -> gid for a simple font, over whichever program is present. */
export function gidForProgram(
  prog: EmbeddedProgram, code: number, text: string,
  nameForCode: ((code: number) => string | undefined) | undefined,
): number | undefined;

/** The program's own advance for `gid`, normalised to 1/1000 em. */
export function programAdvance(prog: EmbeddedProgram, gid: number): number | undefined;
```

Parameterised on `resolve`/`inflate` rather than on a `Document`, so it imports
only `types.ts`, `sfnt.ts`, `cff.ts` and `type1.ts`. `raster.ts`'s
`buildGlyphSource` delegates to it and keeps what is genuinely its own — the
Type 0 branch, `/CIDToGIDMap`, and the Standard-14 substitute face.

The delegation must be behaviour-preserving to the byte, including the two
rules `imxw.2` left in `gidForCode`: a Type 1 program answers `undefined` for a
name it does not define (no substitute exists), while a CFF whose charset could
not be read at all still falls through to "assume gid = code". That last one is
a guess, but it is the only option for a font with no readable charset, and
removing it here would be an unrelated behaviour change smuggled into a
refactor.

**Cycle risk, to be verified rather than assumed.** The new edge is
`font.ts → glyphprogram.ts → type1.ts → pagerender.ts → font.ts`. `type1.ts`
imports `Path` from `pagerender.ts` as `import type`, which is erased, so there
is no runtime cycle — `glyphoutline.ts` already depends on exactly that. The
implementation must confirm `npm run typecheck` stays clean; if it does not, the
fix is to move `Path`/`Seg` into their own module rather than to duplicate code.

### Unit normalisation — the trap

The three programs report advances in three different spaces:

| Program | Advance from | Units |
|---|---|---|
| Type 1 | `hsbw` | glyph space, `/FontMatrix`-derived, in practice 1000/em |
| CFF | the charstring's width prefix | charstring units, `/FontMatrix`-derived, usually 1000/em |
| TrueType | `hmtx` | font units — **commonly 2048/em** |

`programAdvance` returns `raw * 1000 / unitsPerEm` for all three, so callers see
one space. Skipping this makes a 2048/em TrueType measure **2.048× too wide** —
large enough to be obvious once, and easy to miss because the two other kinds
are almost always 1000 and would look fine.

`CffFont` needs a small addition: its Type 2 interpreter already computes the
charstring width into `T2Ctx.width` (from `defaultWidthX`/`nominalWidthX` and
the optional leading operand), but `glyphPath` returns only the path. A
`glyphWidth(gid)` accessor exposes what is already computed.
`SfntFont.advanceWidth(gid)` and `Type1Font.glyphWidth(gid)` already exist.

### Resolution order

`TextFont.advance(code)` becomes, in order:

1. `/Widths[code]`, when the array covers the code. Unchanged, and it always
   wins — a producer that states a width has said what it means.
2. An explicit `/MissingWidth`. Also the producer's own answer, including a
   deliberate 0 for codes that should not advance.
3. The embedded program's advance for that code.
4. Today's Standard-14 AFM table, then `ESTIMATED_WIDTH`.

Rung 3 needs both routes a simple font can take from a code to a glyph, and
`font.ts` already holds each: `glyphNameResolver(resolveSimpleEncoding(dict, …),
type1?.builtinEncodingNames())` for the name-keyed programs — the machinery
`imxw.2` built, in the module that owns it — and `this.simple`, the code →
Unicode table, for a TrueType `cmap` lookup. `gidForProgram` takes them as
arguments rather than importing `font.ts`, which is what keeps the new module
free of the cycle.

Rung 2 requires a change: `parseSimpleWidths` currently collapses a missing
`/MissingWidth` into `?? 0`, losing the difference between "the font says zero"
and "the font says nothing". It must report presence.

### Laziness

The program is loaded on the **first code that reaches rung 3**, not at
construction. A font with complete `/Widths` — nearly all of them — never
touches its `/FontFile*`, so the common path costs nothing and stays
byte-identical. `TextFont` retains one thunk closing over `dict`, `resolve` and
`inflate`; the loaded program and each resolved code are memoised.

### Consistency with the renderer

Not asserted, but structural: `text.ts` and `pagerender.ts` construct `TextFont`
identically, and `glyphDisplacement` is the single place a displacement is
decided. Extraction and rendering therefore cannot disagree about a width, which
is what the issue's acceptance criterion asks for.

## Testing

**`test/glyphprogram.test.ts`** — the new module directly:

- `loadEmbeddedProgram` picks each of the three keys, and returns an empty
  result for a descriptor with none
- `programAdvance` normalises: a synthetic 2048/em TrueType must report half its
  raw `hmtx` value, which is the assertion that fails at 2.048×
- `gidForProgram` over each kind: Type 1 by name, name-keyed CFF by charset,
  TrueType by `cmap`

**`test/font-program-widths.test.ts`** — the resolution order, one case per rung:

- `/Widths` wins over a program whose widths deliberately differ, so precedence
  is visible rather than coincidental
- a code past `LastChar` with no `/MissingWidth` takes the program's width
- the same code with an explicit `/MissingWidth` takes that instead, including 0
- a font with no `/Widths` takes the program's widths throughout
- an unreadable program degrades to the AFM guess without throwing
- a Type 3 font with a non-standard `/FontMatrix` still measures through
  `fontMatrix[0]` — a regression guard for `imxw.1`

**Real fonts**, extending `test/type1-real.test.ts`'s pattern with oracles the
width path never reads: `NimbusSans-Regular.t1` embedded with no `/Widths`,
checked against `NimbusSans-Regular.afm`; and `NimbusSans-Regular.otf` for the
CFF path, checked against the same AFM.

**Acceptance**, matching the issue: `GetTextFragments` positions successive
glyphs at the program's advances for an embedded Type 1 font, and a Type 3 font
with a non-standard `/FontMatrix` keeps spacing correctly.

**Load-bearing, not merely green.** Each assertion confirmed by breaking the
path: drop the `1000 / unitsPerEm` normalisation, reorder rungs 1 and 3, treat
absent `/MissingWidth` as present, and return the raw CFF width without the
nominal-width offset.

## Files

| File | Change |
|---|---|
| `src/glyphprogram.ts` | new — program loading, code→gid, normalised advance |
| `src/cff.ts` | expose `glyphWidth(gid)` from the existing `T2Ctx.width` |
| `src/font.ts` | rungs 2 and 3 in `advance`; `/MissingWidth` presence; lazy thunk |
| `src/raster.ts` | `buildGlyphSource`/`gidForCode` delegate to the new module |
| `test/glyphprogram.test.ts` | new |
| `test/font-program-widths.test.ts` | new |
| `test/type1-real.test.ts` | extend with the AFM width cross-checks |
| `CLAUDE.md` | the one-owner and normalisation invariants; the `b`/`c` resolution |
| `README.md` | note that embedded programs supply widths when `/Widths` cannot |
