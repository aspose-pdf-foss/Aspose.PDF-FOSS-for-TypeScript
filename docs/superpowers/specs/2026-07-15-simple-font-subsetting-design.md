# Simple-Font Subsetting for `Optimize` — Design

**Issue:** aspose-pdf-foss-for-ts-4by · Optimize: extend font subsetting to simple TrueType + simple CFF
**Follows:** `2026-07-15-document-optimize-design.md` (issue `doo`)
**Date:** 2026-07-15

## Problem

`doo` shipped `Optimize` with font subsetting scoped to Type0/Identity-H, where
code→GID resolution is exact. Every simple font — TrueType, Type1, Type3, CFF —
is skipped and reported. This issue lifts that restriction for **simple TrueType**
and **simple CFF**. Type1 (`FontFile`) and Type3 stay out of scope: neither has an
sfnt/CFF program the shrinker can consume.

## Correction to the `doo` spec

`doo`'s follow-up note claims "the shrinker already handles both outline formats —
only the scan's resolution chain is missing". **That is true for TrueType and
false for CFF.**

`shrinkCff` (fontshrink.ts) re-assembles through `assembleCidCff`, which emits a
**CID-keyed** program: a `/ROS`, a charset publishing `gid → CID` integers, an
FDArray/FDSelect, and a String INDEX holding only `Adobe`/`Identity`. That is
correct for `CIDFontType0`, where the viewer resolves CID → charset → GID.

A simple CFF (`FontFile3` `/Subtype /Type1C`) resolves the other way: code →
glyph **name** (PDF `/Encoding` + `/Differences`, or the CFF's built-in Encoding)
→ charset **SID** → GID. Passing one through `shrinkCff` discards every glyph
name and the built-in encoding, and hands the viewer a CID-keyed program under a
simple font dict — invalid, not merely lossy. Simple CFF therefore needs a
**name-keyed shrink path**, which is the larger half of this issue.

## Invariant

Unchanged from `doo`, and it drives every decision below:

> A glyph is blanked only when every site that could reference it was scanned
> successfully, and only when no plausible viewer chain resolves any shown code
> to it.

The failure mode being defended against is a silently blank glyph on a page that
looks fine until someone reads it.

## Design 1: candidate unions instead of a single mapping

Simple fonts have **more than one defensible code→GID chain**, and viewers differ
on which they pick. A symbolic TrueType that also carries `/Differences`, or a
CFF with both a PDF `/Encoding` and a built-in one, are ambiguous by construction.
Picking one chain and hoping is exactly the hazard this issue exists to avoid;
skipping every ambiguous font gives up most of the real-world win.

So the scan takes the **union** of every plausible chain's answer:

```ts
interface CodeMapper {
  codeWidth: 1 | 2;
  /** Every GID any plausible viewer chain could show for `code`.
   *  `undefined` — no chain resolved it — forces a skip. */
  gidsOf(code: number): number[] | undefined;
}
```

A union is safe in one direction only, which is the direction that matters: keep
a glyph some chain might show and, at worst, waste a few hundred bytes. A chain
that fails to resolve is not a hazard — a viewer following it renders `.notdef`,
so there is no glyph to preserve. Only when **all** chains fail is the code
unaccounted for, and the font is skipped with a reason.

Type0 keeps its single exact chain and returns a one-element array.

## Design 2: simple TrueType (PDF 32000 9.6.6.4)

`shrinkGlyf` already copies `cmap`/`hmtx`/`hhea`/`maxp` verbatim and never
renumbers, so a simple TrueType needs no shrinker work — only the scan.

**Symbolic** (`/FontDescriptor /Flags` bit 3):
- `cmap` subtable (3,0): `code`, then `0xF000 | code`.
- else subtable (1,0): `code`.
- neither present → skip, reported.

**Nonsymbolic**:
- `/Encoding` + `/Differences` → Unicode → the best **Unicode** cmap subtable.
- glyph name → `post` table name→GID, for names outside the AGL (`gXX`, custom
  subset names) where the Unicode chain cannot answer.

Both symbolic and nonsymbolic chains are unioned whenever both are applicable.

### Supporting changes

- **`readCmap` (sfnt.ts:245) selects one best Unicode subtable and discards the
  rest**, including symbol tables — and it falls back to (3,0) at score 1, so its
  result cannot be assumed Unicode. Add `SfntFont.cmapSubtable(plat, enc)`: a
  lazy, cached, per-subtable accessor over the already-parsed `cmap` directory.
  `readCmap` and the render path are untouched.
- **`parseCmapSubtable` supports only formats 4 and 12.** Mac (1,0) subtables are
  format 0. Add formats **0** and **6**; the renderer benefits too.
- **`post` v2.0 glyph names**: new lazy `SfntFont.postNames()`. v3.0 carries no
  names and returns `undefined`.
- **`buildSimpleEncoding` (font.ts:140) cannot be reused as-is.** On a
  `/Differences` name outside the AGL it does `table[code] = glyphToUnicode(name)
  ?? table[code]` — silently *keeping the base encoding's* Unicode. For text
  extraction that is a reasonable guess; here it would resolve to the wrong GID
  and blank a glyph that is shown. The scan needs a variant that reports the name
  and an explicit `undefined`, so the `post` chain can take over and an
  unresolvable code forces a skip rather than a guess.

## Design 3: simple CFF

### Shrink path: `shrinkNameKeyedCff`

Same sparse-blanking contract as the CID path — `numGlyphs` and GID numbering
intact, unused charstrings replaced by a bare `endchar` — but the program is
re-assembled **name-keyed**, preserving every structure the code→name→GID chain
runs through:

| Region | Treatment |
|---|---|
| Name INDEX | copied |
| String INDEX | **copied verbatim** — keeps every SID ≥ 391 valid |
| charset | **raw bytes copied** — SIDs unchanged; predefined (0/1/2) left as-is |
| Encoding | **raw bytes copied** — predefined (0/1) left as-is |
| Private DICT | raw bytes copied, `Subrs` (op 19) dropped |
| Global/Local Subr INDEX | emitted empty; kept charstrings are flattened |
| CharStrings INDEX | rebuilt, same count, unused → `endchar` |

charset and Encoding are copied as **raw bytes** rather than re-emitted from a
parse. Re-emitting charset as format 0 would work but inflates a range-coded
charset; re-emitting Encoding cannot express a glyph with no code in either
format. Copying needs only a length computation (charset: format 0 →
`1 + 2*(numGlyphs-1)`; formats 1/2 → walk ranges until `numGlyphs` is covered.
Encoding: format 0 → `2 + nCodes`; format 1 → `2 + 2*nRanges`; `+ 1 + 3*nSups`
when the high bit is set).

**Top DICT** is re-emitted from **byte spans**, not from `parseDict`'s decoded
numbers: real (BCD) operands like `FontMatrix` and unknown operators are copied
verbatim, and only the offset-bearing operators — `charset` (15), `Encoding`
(16), `CharStrings` (17), `Private` (18) — are rewritten, each in the fixed
5-byte `dictInt5` form. Fixed width means the Top DICT's length is known before
its offsets are, so the program lays out in a single pass, exactly as
`assembleCidCff` already does.

New: `parseDictSpans` (cffsubset.ts) and `src/cffstrings.ts`, the 391 CFF
standard strings — needed to turn a charset SID into a glyph name.

### Usage chain

Built once per font from the charset: `nameToGid` (SID → name via standard
strings + String INDEX), and `unicodeToGid` derived from it through
`glyphToUnicode`. Then, unioned:

1. `/Differences` name → `nameToGid` — exact.
2. code → Unicode (base encoding) → `unicodeToGid`.
3. CFF built-in Encoding → code → GID — exact, and the **only** chain when the
   font dict has no `/Encoding` (note `buildSimpleEncoding` defaults to WinAnsi
   there, which is wrong for CFF: the built-in encoding governs). Built-in offset
   0 = Standard, handled by chain 2; offset 1 = Expert → no chain, skip.

### `optimize.ts` dispatch

`FontFile3` `/Subtype /Type1C` routes to `shrinkNameKeyedCff`; `CIDFontType0C`
keeps `shrinkCff`. `/OpenType` whole-embeds with CFF outlines stay skipped
(unchanged) — rewrapping a shrunk `CFF ` table into an `OTTO` sfnt is a separate
concern and `assembleSfnt` already takes the tag when someone wants it.

## Testing

TDD per house style. New fixtures in `test/helpers/build-cff.ts` (a name-keyed
CFF with a real charset, String INDEX, and built-in Encoding) and
`test/helpers/build-optimize-pdf.ts` (simple-TrueType and simple-CFF PDFs).

- symbolic TrueType via (3,0) with and without the `0xF000` offset;
- symbolic TrueType via (1,0) format 0;
- nonsymbolic TrueType through `/Differences` → Unicode → (3,1);
- a `/Differences` name outside the AGL resolved through `post`;
- a TrueType with no usable cmap subtable → skipped, reason reported;
- simple CFF through `/Differences` → charset, and through the built-in Encoding;
- a name-keyed shrink round-trips: charset, String INDEX, Encoding, and Private
  survive byte-identically; kept glyph outlines match the original's;
- `GetText()` is byte-identical before and after `Optimize` for every fixture;
- existing Type0 coverage and the full suite stay green.
