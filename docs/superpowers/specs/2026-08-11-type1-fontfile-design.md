# Type 1 `/FontFile`: eexec decrypt and charstring interpreter

Design for `aspose-pdf-foss-for-ts-imxw.2`, third child of the `imxw` epic
(interpreter coverage for legacy font and function types).

## Problem

`buildGlyphSource` in [raster.ts](../../../src/raster.ts) loads `/FontFile2`
(TrueType) and `/FontFile3` (CFF), and nothing else. An embedded Type 1 program
under `/FontFile` therefore reaches no outline source at all, and the
non-embedded fallback takes over: the page renders in a bundled Standard-14
substitute face, with the wrong shapes. `ToImage` shows this; text extraction
does not, because PDF `/Widths` still drives advances and `/ToUnicode` still
drives characters. The failure is silent and visual only.

Two things are missing, and only one of them is about Type 1:

1. **No Type 1 reader.** eexec decryption, the `/CharStrings` and `/Subrs`
   dictionaries, and a Type 1 charstring interpreter.
2. **No code → glyph *name* route anywhere in the codebase.**
   [encoding.ts](../../../src/encoding.ts) stores every base encoding as
   code → *Unicode*. A Type 1 font's charstrings are keyed by glyph name, so
   the name route is a precondition, not a detail.

The second gap already causes a latent defect on a path that has nothing to do
with Type 1. A simple font with a bare `/FontFile3` (Type1C, no sfnt wrapper)
has no `cmap`, so [raster.ts:642-661](../../../src/raster.ts) falls through to
`return code` — "assume gid = code". `cff.ts` grew `charsetNames()` and
`builtinEncoding()` for exactly this question, and only `glyphusage.ts` ever
calls them. This spec routes both font types through one name resolver, because
two implementations of one question are how the two come to disagree.

## Scope

In scope:

- Type 1 program parsing and charstring interpretation, feeding `glyphPolys`.
- Annex D code → glyph-name tables and the `/Encoding` precedence that uses them.
- Routing name-keyed CFF through the same resolver, closing the `gid = code`
  guess.

Out of scope, deliberately:

- **Advance widths and metrics in the extraction path** — that is `imxw.4`,
  which this issue blocks. `hsbw` is interpreted here because it moves the pen;
  the width it also carries is exposed on the interpreter's result and read by
  the AFM cross-check below, but no production caller consumes it yet and PDF
  `/Widths` continues to drive advances. `imxw.4` is what wires it in.
- **`htmlfontembed.ts`** still declines `/FontFile`. Re-emitting a Type 1
  program as `@font-face` WOFF needs a Type 1 → CFF conversion, which is a
  feature of its own size. Filed as a follow-up issue; the HTML export keeps
  degrading to a CSS font stack, as it does today for any font it cannot embed.
- **`ToSvg`** needs nothing: `svgrender.ts` emits `<text>` elements with font
  attributes, never outlines. The rendering payoff is `ToImage` alone.

## Approaches considered

The issue names the decision outright: extend `cff.ts`'s Type 2 interpreter with
a mode flag, or write a separate one.

**Rejected: one interpreter with a mode flag.** The two grammars share the
operand encoding minus two cases, and diverge in every operator that clears the
stack:

| Byte | Type 2 (`cff.ts`) | Type 1 |
|---|---|---|
| `255` operand | 16.16 fixed | 32-bit integer |
| `28` operand | shortint | does not exist |
| `6` / `7` h/vlineto | alternates over the whole stack | exactly one argument |
| `10` callsubr | biased index | **no bias** |
| `13` | unused | `hsbw` — sets width *and* the initial point |
| `19` / `20` hintmask | stem-count byte skip | do not exist |
| `9` | does not exist | `closepath` |
| `21` / `22` / `4` moveto | may carry a width prefix | never |
| flex | operators `12 34`..`12 37` | the `callothersubr` 0/1/2 protocol |

A flag would fork inside nearly every branch, which is the shape the issue
already suspected: "a shared interpreter with a mode flag has historically been
where subtle divergences hide."

**Rejected: convert Type 1 to CFF in memory and reuse `CffFont`.** It moves the
whole problem into a converter that must be at least as correct as a direct
interpreter, and adds a lossy intermediate between the bytes and the outline.

**Chosen: a separate two-module stack**, mirroring the `cff.ts` / `cffstrings.ts`
split and the Go counterpart (`type1.go`, `type1_charstring.go`).

## Architecture

### `src/type1.ts` — the container

`Type1Font`, the parsed program. Accepts the three shapes the same bytes arrive
in: a raw PFA/PFB file, a PFB with `0x80`-tagged segment headers, and a PDF
`/FontFile` stream body (clear + binary + trailer already concatenated, with
`/Length1`/`/Length2`/`/Length3` describing the split — which this parser does
not need, since it finds the boundary itself).

Parsing:

1. Strip PFB segment headers when present.
2. Split on the `eexec` token; skip the whitespace that follows it.
3. Sniff hex versus binary: per the Type 1 spec, if the first four non-whitespace
   bytes are all hex digits, the section is hex-encoded — decode it first.
4. Decrypt with `R = 55665`, `c1 = 52845`, `c2 = 22719`, discarding 4 leading
   plaintext bytes.
5. Token-scan the plaintext for `/lenIV` (default 4), `/Subrs`
   (`dup <i> <len> RD <binary> NP`) and `/CharStrings`
   (`/<name> <len> RD <binary> ND`). `RD`/`ND`/`NP` are also spelled
   `-|`/`|-`/`|`; both spellings are accepted, since the name is a procedure the
   font defines and either is conformant.
6. Decrypt each charstring with `R = 4330`, discarding `lenIV` bytes.
7. From the *clear* portion, read `/FontMatrix` (→ `unitsPerEm`) and `/Encoding`
   — either the literal `StandardEncoding def` or a run of
   `dup <code> /<name> put`.

Public surface, chosen so the outline path needs no Type 1 knowledge:

```ts
class Type1Font {
  readonly unitsPerEm: number;      // from /FontMatrix, normally 1000
  readonly numGlyphs: number;
  glyphPath(gid: number): Path;     // structural match with CffFont
  gidForName(name: string): number | undefined;
  builtinEncodingNames(): Map<number, string> | undefined;  // code -> glyph name
}
```

The encoding accessor is deliberately *not* called `builtinEncoding`:
`CffFont.builtinEncoding()` already exists and returns code → **gid**. Two
same-named methods returning different things across the two program types is
the kind of collision `gidForCode` would silently get wrong, since both are
`Map<number, …>`.

Glyph ids are this parser's own numbering — order of appearance in
`/CharStrings` — because Type 1 has no glyph-id space of its own. Nothing
outside `raster.ts` and `glyphoutline.ts` ever sees them, and they are never
written to a file.

### `src/type1charstring.ts` — the interpreter

Pure: charstrings, subrs and a `lenIV`-decrypted byte array in, a cubic `Path`
out. No PDF and no container knowledge, so it is testable on hand-written
charstrings.

Operators: `hstem vstem vmoveto rlineto hlineto vlineto rrcurveto closepath
callsubr return hsbw endchar rmoveto hmoveto vhcurveto hvcurveto`, and escapes
`dotsection vstem3 hstem3 seac sbw div callothersubr pop setcurrentpoint`.

Three of these carry the whole risk:

- **`hsbw` is outline-affecting, not merely metric.** It sets the current point
  to `(sbx, 0)` before any drawing. Treating it as a width-only operator leaves
  every glyph in the font horizontally displaced by its own left sidebearing —
  a uniform-looking error that reads as a font that is simply "a bit off".
- **`callsubr` does not bias its index.** Type 2's bias is a Type 2 invention.
  The PROVENANCE for `NimbusSans-Regular.woff2` records that a bias error in
  `cff.ts` survived an entire green suite, which is why the real-font oracle
  below is not optional.
- **Flex arrives through `callothersubr`, not an operator.** OtherSubrs 1 opens a
  flex, seven `rmoveto`s accumulate reference and control points, OtherSubrs 0
  closes it into two curves. Hint replacement (OtherSubrs 3) draws nothing but
  must still leave a value for the `pop` that follows it. An *unknown*
  othersubr leaves its arguments on the PostScript stack for subsequent `pop`s,
  per the spec — silently dropping them desynchronizes everything after.

`seac` composes a base and an accent glyph selected by **StandardEncoding
codes**, which resolve through the Annex D name table below.

Failure handling matches `cff.ts` exactly: depth-bounded recursion, and a throw
inside a glyph degrades to whatever was drawn rather than failing the page.

### `src/encoding.ts` — Annex D name tables

Code → glyph-name arrays for the three base encodings a font may name,
transcribed from ISO 32000-1 Annex D Table D.2, plus
`baseEncodingNamesByName(name)` alongside the existing `baseEncodingByName`.

**Three encodings, not four.** PDFDocEncoding gets no column: 32000-1 Table 114
admits only `MacRomanEncoding`, `MacExpertEncoding` and `WinAnsiEncoding` as
`/BaseEncoding`, with StandardEncoding as the implicit default. PDFDoc is a
text-string encoding, so a name column for it would be dead code — and
`encoding.ts`'s `pdfDocEncoding` is an approximation (`winAnsi.slice()` plus two
entries), so cross-checking against it would fail for reasons unrelated to this
work. `baseEncodingNamesByName` returns `undefined` for anything it has no table
for, including `MacExpertEncoding`, rather than defaulting to WinAnsi the way
`baseEncodingByName` does: the *next* authority is the font program's own
encoding, which is a real answer, and a default would silently outrank it.

The 95 shared ASCII names are generated once with two documented overrides
(StandardEncoding's `/quoteright` at 0x27 and `/quoteleft` at 0x60, where the
other two carry `/quotesingle` and `/grave`), and each encoding's high range is
its own map. Same data as a single four-column table, arranged to minimise
transcription error.

The alternative — deriving names by reversing the AGL from the code → Unicode
arrays already present — was rejected on the evidence already recorded for
`cidunicode.ts`: inversion of a many-to-one mapping agreed with Adobe's own
tables on as little as 39% of CIDs. The alphabet is smaller here but the trap is
the same, and `quoteright`/`quotesingle` and `hyphen`/`minus` are exactly the
pairs that collide.

A secondary benefit: the new table is an independent transcription of the same
Annex D rows the existing code → Unicode arrays were built from, so the two can
be cross-checked against each other. `macRoman` still carries a "transcribe
below" comment from when it was written.

### `src/font.ts` — encoding precedence

`SimpleEncoding` gains the base encoding's *names* beside its Unicode
(`baseNames`), and `glyphNameResolver(enc, builtin)` applies the precedence
once, in the module that already owns `/Encoding`:

1. The `/Differences` name at that code, when there is one.
2. Otherwise the named base encoding's Annex D name (`/Encoding` as a name, or
   `/BaseEncoding` inside the dict).
3. Otherwise the font program's own built-in `/Encoding`.
4. Otherwise StandardEncoding.

This ordering is 32000-1 9.6.6.2. Note that rung 3 sits *below* an explicitly
named base encoding but *above* the default — a font dict with no `/Encoding`
at all is the case where the program's own encoding governs, which
`SimpleEncoding.implicit` already records.

### `src/glyphoutline.ts` and `src/raster.ts` — wiring

`CffFont` and `Type1Font` both satisfy `{ unitsPerEm, glyphPath(gid) }`.
`glyphoutline.ts` names that structurally:

```ts
export interface CharstringProgram { readonly unitsPerEm: number; glyphPath(gid: number): Path; }
```

`OutlineSource` gains `type1?: Type1Font`, and `glyphPolys`'s CFF and Type 1
cases collapse into one branch over `CharstringProgram` rather than two copies
of the same four lines. `cff` stays a named field because CFF-specific callers
(`gidForCode`'s `isCID` test, `htmlfontembed.ts`, `cffsubset.ts`) need the
concrete type.

`GlyphSource` gains `type1?: Type1Font` and a resolved code → glyph-name
function. `buildGlyphSource` tries `/FontFile` after `/FontFile2` and
`/FontFile3` — last, so a font carrying more than one program keeps today's
precedence — and a `Type1Font` constructor that throws is caught exactly as a
bad CFF or sfnt is, falling back to the Standard-14 substitute.

`gidForCode` gains a name branch, taken by a Type 1 program and by a name-keyed
CFF with no usable `cmap`: resolve the code to a glyph name, then the name to a
gid (`Type1Font.gidForName`, or `CffFont.charsetNames()` with
`builtinEncoding()` as the fallback). A name the program does not define yields
no gid, and the existing placeholder-box path handles it — the same degradation
a missing glyph already gets.

## Testing

### Synthetic — `test/helpers/build-type1.ts`

Builds a Type 1 program (eexec encryption, per-charstring encryption) and a PDF
embedding it under `/FontFile` with correct `/Length1`/`/Length2`/`/Length3`,
in the style of the existing builders. It covers what a real font will not
exercise:

- hex-encoded eexec, and PFB `0x80` segment headers
- a non-default `/lenIV`
- `-|`/`|-`/`|` as the alternative spellings of `RD`/`ND`/`NP`
- each rung of the encoding precedence, including a `/Differences` name the
  program does not define
- `seac`, `div`, `closepath`, unbiased `callsubr`, and the flex and
  hint-replacement othersubr protocols
- a malformed program, asserting the Standard-14 fallback rather than a throw

### Real font — `test/type1-real.test.ts`

A synthetic suite cannot catch our encoder and decoder agreeing with each other
and both disagreeing with the format, which is the class `test/fixtures/` exists
for. Two files from
[ArtifexSoftware/urw-base35-fonts](https://github.com/ArtifexSoftware/urw-base35-fonts)
(`fonts/`, branch `master`) — the same upstream `NimbusSans-Regular.otf`,
`D050000L.ttf` and `StandardSymbolsPS.ttf` already come from, under the AGPLv3 +
font exception already covered by `fonts/LICENSE-URW-AGPL.txt`:

| File | Bytes | SHA-256 |
|---|---|---|
| `NimbusSans-Regular.t1` | 104,001 | `779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa` |
| `NimbusSans-Regular.afm` | 116,120 | `ed4ead49b4d090c80c1d4a8d771879153a41af262d331168dd2635508634cfa1` |

The `.t1` is raw PFA-framed with a **binary** eexec section: it opens
`%!PS-AdobeFont-1.0: NimbusSans-Regular 1.00`, the `eexec\r` at offset 890 is
followed directly by binary, and it closes with the conventional 512 zeros and
`cleartomark`. That maps onto a PDF `/FontFile`'s three lengths without
re-encoding, so the fixture is embedded verbatim.

Two oracles, **neither of which the Type 1 interpreter reads**:

1. **AFM advances against `hsbw`.** The `.afm` publishes `WX` for all 855
   glyphs; `hsbw` publishes the same number inside the charstring. This is the
   direct analogue of the `hmtx` lsb cross-check that the OTF fixture's
   PROVENANCE records as the *only* assertion which caught the subr-bias
   mutations.
2. **Outlines against the already-vendored `NimbusSans-Regular.otf`.** Same
   design, same 855 glyphs, matched by name — but read through `cff.ts`'s Type 2
   interpreter, which shares no code with the Type 1 one. The PROVENANCE warns
   that a differential test between two copies of one font validates only the
   round-trip; that warning does not apply here, precisely because the two sides
   run through independent interpreters that were never derived from each other.
   Comparison is on flattened outlines within a tolerance, since URW's own
   Type 1 → CFF conversion is not required to preserve control points exactly.

A `PROVENANCE.md` entry records producer, command, hashes, and what the fixture
does and does not cover, as every other fixture directory does.

### Acceptance

A page embedding the real `/FontFile` renders glyph outlines from the embedded
program, asserted to differ measurably from the Standard-14 substitute that is
drawn today — the issue's stated criterion.

### Load-bearing, not merely green

Per the fixture rules, each assertion is confirmed by breaking the path it
covers and watching the suite go red. At minimum: bias `callsubr`, drop `hsbw`'s
sidebearing, invert the flex point order, skip the `lenIV` prefix, and swap two
Annex D names in the same encoding column.

## Risks

- **Annex D transcription.** ~229 rows entered by hand. Mitigated by the
  cross-check against the existing Unicode arrays and by the real font, whose
  built-in encoding covers the Standard column independently.
- **`callothersubr` beyond 0–3.** Rare and font-specific. The spec's rule (leave
  arguments for `pop`) is implemented; anything further degrades to a missing
  glyph rather than a corrupt one.
- **Fixture size.** ~220 KB added to `test/`. `package.json` declares
  `files: ["dist"]`, so nothing reaches the published tarball.

## Files

| File | Change |
|---|---|
| `src/type1.ts` | new — container, ~250 lines |
| `src/type1charstring.ts` | new — interpreter, ~250 lines |
| `src/encoding.ts` | Annex D name table + `baseEncodingNamesByName` |
| `src/font.ts` | base-encoding names on `SimpleEncoding` |
| `src/glyphoutline.ts` | `CharstringProgram`, `type1` on `OutlineSource` |
| `src/raster.ts` | `/FontFile` load, name branch in `gidForCode` |
| `CLAUDE.md` | the two invariants above: `hsbw` moves the pen, and the name route has one owner |
| `README.md` | Limitations: Type 1 embedded programs no longer substitute |
| `test/helpers/build-type1.ts` | new |
| `test/type1.test.ts` | new |
| `test/type1-real.test.ts` | new |
| `test/fixtures/fonts/PROVENANCE.md` | the `.t1` + `.afm` entry |
