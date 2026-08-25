# Type 1 embedding and indexing — design

Issue: `l1my.5`, under epic `l1my` (Font sourcing by name, `gap-vs-go`).
Date: 2026-08-24.

`AddFont` is `parseSfnt`, which accepts a bare sfnt, WOFF, WOFF2 and a `ttcf`
collection and nothing else. `type1.ts` exists but is read-only, for
interpreting a program embedded in a document we are *rendering*: it is
imported by `glyphoutline.ts`, `glyphprogram.ts` and `raster.ts` alone, and by
nothing on the authoring side.

So a `.pfb` cannot be embedded, and — the reason this issue exists — a `.pfb`
in `/usr/share/fonts`, which several Linux distributions still ship, cannot be
found by family name either.

This is the design for both halves: reading a Type 1 program into the sfnt
model the authoring stack already speaks, and indexing one by name.

## The finding that shapes everything

**The hard part is already built.** `type1charstring.ts` interprets a Type 1
charstring into a `Path` of `M`/`L`/`C`/`Z` segments in glyph units
(`pagerender.ts`), with `C` an unflattened cubic. That is exactly the Type 2
charstring vocabulary — `rmoveto`, `rlineto`, `rrcurveto`, with the close
implicit — so converting Type 1 to CFF needs **no charstring transcoder at
all**: run the existing, tested interpreter and re-emit its path as deltas.

`sfntwrite.ts` then already has `otfFromCff(cff, cmap, metrics)`, which wraps a
bare CFF as an `OTTO` sfnt. The output is something `parseSfnt` reads and the
whole subset-and-embed path consumes unchanged.

The cost of that route is **hints**. Outlines carry none, so `hstem`, `vstem`,
hint replacement and flex are lost. That is a decision, recorded below, not an
oversight.

## Three decisions

**The conversion is EAGER, inside `parseSfnt`.** A Type 1 becomes a synthetic
OTTO before anything else sees it — the rule `woff.ts` and `ttc.ts` already
follow, and `ttc.ts` states it as an invariant for the same reason. That single
placement is what makes subsetting, `/FontFile3`, Identity-H emission,
`/ToUnicode`, `LoadFontByName`, `LoadFontFamily` and the whole `fontmatch.ts`
rule set work with **no downstream change whatsoever**. The alternative —
keeping a `Type1Font` on `EmbeddedFont` and branching at embed time — forks
every consumer of `SfntFont`, which is most of the authoring stack.

**Hints are dropped, and that is settled rather than deferred.** Preserving them
means mapping Type 1 operators onto Type 2 ones directly, which is a second
charstring grammar to get right: subrs are unbiased here and biased there,
`closepath` exists here and not there, `255` is a 32-bit integer here and 16.16
fixed there, and flex arrives through `callothersubr` rather than as an
operator. `type1.ts`'s own header records those divergences as the reason the
two interpreters are separate; a transcoder walks straight back into them. The
loss costs a little stem regularity at small sizes in third-party viewers.
**It is invisible to this suite** — `raster.ts` is a scanline filler over
flattened outlines and ignores hints entirely — so it is documented in README
and CLAUDE.md rather than left to be discovered.

**Both halves land together.** The issue text assumed embedding and indexing
were separable, with the name reader worth building only afterwards. That is
half right: the *order* holds, but the cost split does not. `type1.ts` parses
only `/FontMatrix` from the cleartext header today, and embedding needs
`/FontName` regardless — without it `/BaseFont` comes out as `Embedded`, which
is what `sfntwrite.ts`'s `buildName()` hardcodes. Once that parse exists,
`/FamilyName`, `/Weight` and `/ItalicAngle` are a few lines more. Shipping
embedding alone would also leave the motivating case unfixed: a caller would
still have to name the `.pfb` by path, which is the thing this epic exists to
avoid.

## Module layout

| File | Responsibility |
|---|---|
| `src/type1header.ts` | **new, pure leaf.** The cleartext header fields, and `isType1`. |
| `src/type1cff.ts` | **new, pure.** `sfntFromType1(bytes)` — interpret, re-emit, assemble, wrap. |
| `src/type1.ts` | takes `/FontMatrix` from `type1header.ts` rather than scanning for it itself. |
| `src/sfnt.ts` | one branch in `parseSfnt`'s existing signature dispatch. |
| `src/fontsource.ts` | `.pfb`/`.pfa` in `FONT_EXT`; a Type 1 branch in `peekNames`. |

`type1header.ts` is its own module rather than part of `type1.ts` because three
unrelated callers want it and only one of them wants the interpreter:
`fontsource.ts` indexes thousands of files and must not pull in a charstring
engine to read a family name, `type1cff.ts` wants `/FontName` and `/FontBBox`,
and `type1.ts` wants `/FontMatrix`. It is also not part of `fontnames.ts`, which
is specifically the *sfnt* `name` table; `fontsource.ts` maps between the two
shapes at the one place that needs both.

### `type1header.ts`

```ts
export interface Type1Header {
  /** /FontName — becomes the sfnt PostScript name and hence /BaseFont. */
  fontName?: string;
  /** /FamilyName. */
  familyName?: string;
  /** /Weight — 'Bold', 'Light', ... the words fontmatch.ts already parses. */
  weight?: string;
  /** /ItalicAngle; 0 when absent. */
  italicAngle: number;
  /** /FontBBox, or undefined when the font states none. */
  bbox?: [number, number, number, number];
  /** Units per em from /FontMatrix — 1000 for nearly every real font. */
  unitsPerEm: number;
}

/** Whether `bytes` opens as a Type 1 program: a PFB segment header (0x80 0x01)
 *  or a PostScript comment (`%!`). A prefix is enough. */
export function isType1(bytes: Uint8Array): boolean;

/** Read the cleartext header. `bytes` need only reach the `eexec` keyword, so
 *  a few hundred bytes of prefix suffice — which is what keeps the folder
 *  index's partial-read cost model intact. */
export function readType1Header(bytes: Uint8Array): Type1Header;
```

## The conversion

Per glyph: `runType1Charstring` gives a `Path` and a width; the path is walked
into Type 2 operators; `assembleCidCff` builds a CID-keyed CFF with identity
charset; `otfFromCff` wraps it. Three invariants, each silently wrong if missed.

**Invariant: glyph ids are RENUMBERED so `.notdef` is gid 0.** `Type1Font`
numbers glyphs by order of appearance in `/CharStrings`, which carries none of
the CFF conventions — `type1.ts`'s own documentation records that the bundled
`NimbusSans-Regular.t1` lists `/.notdef` **last**, so assuming gid 0 is
`.notdef` is wrong by 854 on the one real font available. CFF requires gid 0 to
be `.notdef`.

**Invariant: every charstring emits its width explicitly.** `assembleCidCff`
writes `Private [0 0]` — a Private DICT of size zero, so no body — which leaves
`nominalWidthX` and `defaultWidthX` both at their default of 0. A width operand
is a *delta from `nominalWidthX`*, so with 0 it is the width itself; and an
*omitted* width means `defaultWidthX`, i.e. 0, a glyph that does not advance.
Omitting it therefore produces a font whose every glyph piles up on the last.

**Invariant: `cmap` is built from glyph NAMES through `glyphToUnicode`**
(`encoding.ts`), the existing owner of that mapping, not from the font's
built-in `/Encoding` array. The built-in encoding addresses at most 256 codes
and says nothing about the rest of `/CharStrings`; a font with 800 glyphs would
lose most of them.

**Coordinates are rounded to integers.** Type 1 glyph space is integral in
practice, and rounding keeps the emitter to the plain Type 2 operand encoding
rather than needing 16.16 fixed.

**`seac` needs no case.** The interpreter already resolves an accented
composite into a single merged path, so it arrives here as ordinary outline.

**Ascent and descent come from `/FontBBox`.** A Type 1 program has no `OS/2`
table and states no typographic ascender, so the bounding box is the only
available source. It is an approximation, and the code says so.

## The index half

`FONT_EXT` gains `.pfb` and `.pfa`, so a Type 1 is found by default and does not
need `l1my.4`'s opt-in `sniff`.

`peekNames` gains a Type 1 branch. **The cost model survives unchanged:** the
cleartext header is the *first* few hundred bytes of the file, ahead of the
`eexec` section, so indexing one reads a prefix and touches no glyph data —
exactly the property `l1my.1` built the partial-read scheme for. A collection
yields one face; a Type 1 yields one face; the shapes match.

Its fields map onto the existing `FontNames`: `/FamilyName` → `family`,
`/FontName` → `postScriptName`, `/Weight` → `subfamily` (the same string
`fontmatch.ts`'s `weightFromSubfamily` already parses, so `Bold` and `Light`
resolve with no new rule), `/ItalicAngle !== 0` → `italic`, and `weight` left at
400 so that `deriveStyle`'s corroboration path — which fires exactly at 400 —
does the work. `head.macStyle` has no counterpart here and `bold` stays false,
which is correct: the `/Weight` string is the positive evidence, and
`fontmatch.ts` OR-s its signals.

A font stating no `/Weight` gets `subfamily` `'Regular'`, matching what
`namesFromTables` already does for an sfnt with no name ID 2 — so the two
sources of a `FontNames` cannot disagree about what "said nothing" looks like.

A Type 1 stating no `/FamilyName` leaves `family` empty and is skipped by
`indexFolder`, the same rule an sfnt stating no ID 1 already gets.

`AddFontOptions.faceIndex` is **ignored** for a Type 1, not rejected — a Type 1
program holds exactly one face, and a caller may not know which kind of file
they were handed. That is `ttc.ts`'s existing rule for a plain sfnt, applied to
one more single-face format rather than restated as a new one.

## Degradation

Unchanged from the rest of this feature: nothing here throws for a bad file.
A `.pfb` that will not parse yields no face from `peekNames` and is skipped, so
one corrupt font in `/usr/share/fonts` cannot break every lookup on the
machine. `AddFont` on a malformed Type 1 throws `PdfParseError` as it does for a
malformed sfnt — that is a caller handing us something specific and broken,
which is a different situation from a scan encountering a file.

## Testing

**`test/type1-header.test.ts`** — fields read from `NimbusSans-Regular.t1` and
from `test/helpers/build-type1.ts` synthetics, including a font stating no
`/FamilyName` and one stating no `/FontBBox`. `isType1` on a PFB, on a PFA, and
on an sfnt (false).

**`test/type1-cff.test.ts`** — the load-bearing file. For each glyph of the real
fixture, convert and compare the **CFF interpreter's** outline against the
**Type 1 interpreter's**. Those are two separately written interpreters
(`cff.ts` and `type1charstring.ts`), so their agreement is independent evidence
rather than the self-differential this repo warns about — the same anchoring
habit as checking CFF charstring widths against `hmtx`. Beside it, asserted
directly: `.notdef` is gid 0 after renumbering, and advances match `hsbw`.

**End to end** — `AddFontFile` a `.pfb`, draw text, `Save`, assert the output
carries `/FontFile3` with `/Subtype /CIDFontType0C` and that `GetText` reads the
text back.

**Index** — a temp folder holding a `.pfb`; `LoadFontByName` finds it by family,
`ResolveFontByName` reports the `/Weight`-derived style, and `LoadFontFamily`
fills the slot a two-weight pair provides.

**Recorded rather than glossed:** `type1.ts`'s documentation already states that
the one real fixture contains **no flex, no `seac` and no `div`**, and that all
360 of its `callsubr` calls reach a hint-replacement no-op. Those conversion
paths are therefore exercised by `build-type1.ts` synthetics alone, and
`PROVENANCE.md` already records which mutations that fixture provably cannot
catch. Do not read a green run of the real-fixture comparison as covering them.

**Every new assertion is mutation-checked**, per the repo rule. Two are called
out in advance as the ones most likely to pass either way: the `.notdef`
renumbering (a font whose `.notdef` happened to be first would not notice) and
the explicit width emission (a synthetic whose glyphs all have the same width
as `defaultWidthX` would not notice either).

## Out of scope

- **A hint transcoder.** Settled against above, not deferred. Revisiting it
  means replacing the conversion step, which the module boundary already
  isolates.
- **`.dfont`.** `l1my.6`.
- **Type 1 *simple*-font output** (`/Type1` with `/FontFile`, `/Differences`,
  `/Widths`). It would preserve the original program byte for byte, hints
  included, and is what most PDF producers emit — but the authoring stack is
  Type0/Identity-H throughout, so a second font-dict shape would fork
  `stamp.ts`, the encoder and `/ToUnicode`, and cap a font at 256 addressable
  glyphs. The conversion buys uniformity at the cost of hints, which is the
  trade this design accepts.
- **CFF `CharstringType 1`.** A CFF may legally declare Type 1 charstrings and
  carry them unconverted, which would preserve hints for nothing. Real
  consumers support it poorly, and our own `cff.ts` reads Type 2 only.
- **Reading a Type 1 that is already embedded in a document.** That is
  `glyphprogram.ts`'s existing job and is untouched.

## Documentation

`CHANGELOG.md` under `[Unreleased]`, **Added** — both halves, naming the hint
loss plainly, since a caller comparing output against another producer will
otherwise notice it and wonder.

`README.md`: `.pfb`/`.pfa` in the accepted-formats sentence beside WOFF/WOFF2,
and one sentence on the conversion and what it costs.

`CLAUDE.md`: entries for `type1header.ts` and `type1cff.ts` recording the eager
conversion placement, the three conversion invariants, the prefix-read property
that keeps the index cheap, and the fixture gap above.
