# XFA growable sizes measured with the named face (`164g.7`)

Fields, draws and subforms whose size the template does not state take it from
their text: absent `w`/`h`, and `minW`/`minH`/`maxW`/`maxH`. 164g.1 refuses
every such leaf ("needs text measurement (164g.7)"). This design measures them,
and corrects one 164g.1 table rule the 164g.6 oracle disputed.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Which faces count as "the named face"? | **Embedded in the document, then registered font folders, by exact family and style, plus a CLOSED table of metric-compatible substitutes** (Arial, Times New Roman, Courier New to the bundled Liberation faces). This overrides the issue text's "exact face only"; it is the requester's decision. |
| 2 | `min*` inside a flowed parent | **The spec (p. 276): a floor everywhere.** pdf.js applies it only in a positioned parent, so OPM 1644's `Q1` is a recorded divergence. |
| 3 | Rich text (`exData`) | **Measured**, over the vocabulary below. |
| 4 | An empty growable text field | **One empty line** in its own font, plus insets, raised to `minH`. An interpretation: the spec does not settle it. |

## Sources

XFA Specification 3.3, as pinned by 164g.1 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`), cited by
page:

- **Growable axes** (p. 275-277). Both `w` and `h` stated: fixed, `min*`/`max*`
  ignored. Only `h` stated: grows in width, `minH`/`maxH` ignored. Only `w`:
  grows in height. Neither: both. A `-1` in any of the six is undefined. `max*`
  of zero means absent. `min > max` is non-conforming: "emit a warning and swap".
- **Growable width** (p. 278): text records are lines; characters are placed
  "until a newline character is encountered or a width limit is reached"; "the
  final width of the region is equal to the width of the longest line plus the
  width of the caption", when the caption is left or right.
- **Growable height** (p. 279): grows "to accommodate the text within its usable
  region", which "excludes the caption region".
- **Line height** (p. 61): "the distance between the top of the bounding box for
  the highest glyph on the line and the bottom of the bounding box for the
  lowest glyph", the box being "the box that all glyphs in that font occupy";
  `para lineHeight` wins when greater; `spaceAbove`/`spaceBelow` add their
  maximum between paragraphs.
- **Horizontal** (p. 56, 58): text layout units per UAX #14; `para marginLeft`,
  `marginRight`, and `textIndent` on a paragraph's first line; a word too wide
  for the region breaks between characters.
- **Font defaults** (Template Reference, `font` element, p. 743-744):
  `size="10pt"`, `typeface` Courier, `posture="normal | italic"`,
  `weight="normal | bold"` -- the first listed value being the default.
  **A conflict, recorded:** the prose table on p. 58 says the default weight
  "is bold". The reference syntax wins, as it is normative where the prose is
  descriptive, and it is what pdf.js does: OPM 1644's `Q1` states no `weight`
  and is laid out normal. `xfarich.ts` applies these defaults.
- **Table cells** (p. 329): cells "expand" to the designated column width, and
  "as usual in layout when a fixed size is allotted for an object, the visible
  representation of the object may extend beyond the allotted region". **A stated
  column width is therefore the cell's box even when the cell is wider.** 164g.1
  read "expands" as "never shrinks" and refused; that was a misreading, and
  pdf.js agrees with the correction.
- **Rich text** (ch. 27, p. 1187-1221): elements `html body p span b i br a sub
  sup`; CSS `font` and `font-family/-size/-style/-weight/-stretch`, `margin*`,
  `line-height`, `text-indent`, `letter-spacing`, `vertical-align`,
  `kerning-mode`, `xfa-font-*-scale`, tab attributes, `color`,
  `text-decoration`, orphan/widow and page-break controls. Unrecognised
  elements are ignored WITH their content (p. 1187). Consecutive spaces collapse
  except inside `xfa-spacerun:yes`, where each U+00A0 or U+0020 is a space
  (p. 1220).

**Interpretation, recorded:** "the box that all glyphs in that font occupy" is
read as the font's **hhea ascender minus descender**, not the `head` bounding
box. pdf.js measures 10pt Arial as exactly `(1854 + 434) / 2048 × 10` = 11.17pt,
which is hhea; the `head` box would give 13.3pt.

## Scope

**Measured:** a draw's `<value>` (`<text>` or `<exData contentType="text/html">`)
and a text-like field (`textEdit`, `numericEdit`, `dateTimeEdit`,
`passwordEdit`). A field measures its bound datasets value, else its template
default; an empty value measures one empty line; a `passwordEdit` measures one
mask character (U+2022, else `*` when the face lacks it) per character, never the
value.

**Refused, each by name:** a growable leaf with any other `ui` (check button,
choice list, button, image, signature, barcode); a non-empty field value under a
display `<format><picture>`; a face no tier resolves, or a character it has no
glyph for; a caption with no `reserve` on a growable axis; a non-default
`fontHorizontalScale`, `fontVerticalScale`, `letterSpacing`, `baselineShift`,
`kerningMode="pair"`, `font-stretch`, `vertical-align`/`sub`/`sup`, hyphenation,
`hAlign="radix"`, a tab character or tab attribute, a list (`ol`/`ul`/`li`), an
embedded-object `span`; and, on a width-growable axis only, text whose width
depends on repeated or edge whitespace (`layoutRuns` collapses runs of spaces).

**Unchanged:** `maxH`/`maxW` exceeded on a non-wrapping axis still refuses, as
clipping is not modelled; repetition (164g.2) and page breaking (164g.3).

## Architecture

```
xfatemplate.ts ── LayoutNode.text?: LeafText        (built by xfarich.ts)
      │
xfaconvert.ts ─── measure = (node, box) => measureLeaf(...)   (xfafont.ts + xfatext.ts)
      │
xfaflow.ts ────── layoutPage(root, measure?)        still a pure leaf
```

### `xfarich.ts` (new, pure over `xml.js`)

`leafText(el): LeafText`. Turns a leaf's `<value>`, `<font>`, `<para>`,
`<margin>`, `<caption>` and `<ui>` into:

```ts
interface TextRunSpec { text: string; family: string[]; size: number; bold: boolean; italic: boolean }
interface ParaSpec { runs: TextRunSpec[]; marginLeft: number; marginRight: number;
  textIndent: number; lineHeight: number; spaceAbove: number; spaceBelow: number }
interface LeafText {
  kind: 'draw' | 'field';
  paras: ParaSpec[];          // plain text: one per record (newline)
  insets: { l: number; r: number; t: number; b: number };
  caption?: { placement: 'left' | 'right' | 'top' | 'bottom'; reserve?: number };
  password?: boolean;
  /** A field's template default; the converter substitutes a bound value. */
  isDefault?: boolean;
  refusal?: string;
}
```

Never throws. Rich-text CSS inherits from the leaf's `<font>`/`<para>`, then down
the element tree; an unrecognised element is dropped with its content (p. 1187);
`a` is transparent. A field's plain-text value is re-split by the converter when
a bound datasets value replaces the default (`withValue(t, value)`).

### `xfatext.ts` (new, pure)

```ts
interface FaceMetrics { unitsPerEm: number; ascent: number; descent: number;
  advance(cp: number): number | undefined /* undefined = no glyph */ }
type FaceLookup = (family: string[], bold: boolean, italic: boolean) => FaceMetrics | { reason: string };
type MeasureBox = { width: number } | { maxWidth?: number };
function measureLeaf(t: LeafText, box: MeasureBox, faces: FaceLookup): { w: number; h: number } | { reason: string };
```

Lines are broken by `layoutRuns` (the one wrapping engine), one measuring
`FontDriver` per resolved face; each line's height is `max(ascent) + max(descent)`
over the runs that land on it, scaled per run's size, or `lineHeight` if
greater. Width-growable: lines break only at newlines, or at `maxWidth` when
given; `w` = longest line + paragraph margins (+ first-line indent) + insets +
left/right caption reserve. Height: sum of lines + max(spaceAbove, spaceBelow)
between paragraphs + insets + top/bottom caption reserve. An empty paragraph
list is one empty line in the leaf's own `<font>`.

### `xfafont.ts` (new; holds the `Document`)

`faceLookup(doc): FaceLookup`, memoized per conversion. Each family name in the
list is tried in order; a generic keyword never resolves (`cssfont.ts`'s rule).
For each name, the first tier yielding a face that covers every character of the
run wins:

1. **Embedded.** `/FontFile2` and `/FontFile3 /OpenType` programs, identified by
   their own `name` table through `fontnames.ts` and `fontmatch.ts`'s
   `familyMatches`/`deriveStyle` — never by `/BaseFont` spelling, so
   `Arial,Bold` and `ABCDEF+Arial-BoldMT` agree. A bare CFF or Type 1 program has
   no `name` table and is no candidate.
2. **Registered folders.** The folders `LoadFontByName` searches, matched by
   `fontmatch.ts`'s face rule, parsed directly with `parseSfnt` — never through
   `LoadFontFamily`, which creates an embeddable font.
3. **Substitutes**, a closed table: `Arial` → Liberation Sans, `Times New Roman`
   → Liberation Serif, `Courier New` → Liberation Mono (exact names,
   case-insensitive), mapped onto the bundled `std14fonts.ts` faces by style.
   Measured: the bundled faces equal OPM 1644's embedded Arial and Times New
   Roman on advances and on hhea, typo and win line metrics. `Helvetica`,
   `Times` and `Courier` are NOT in it: their vendors' vertical metrics differ.

Coverage: a code point counts when the face's Unicode cmap maps it to a glyph id
above 0 and below `numGlyphs`. The lookup writes nothing to the document; pinned
through the sign path.

### `xfaflow.ts` (changed)

`layoutPage(root, measure?)`. With no `measure`, every leaf behaves exactly as
today. With one:

- A leaf with an unstated axis asks `measure(n, box)`: `{ width }` when `w` is
  stated or imposed by a table column, else `{ maxWidth }` from a non-zero `maxW`.
  The engine applies `min*`/`max*` through its existing `grow` — now for leaves
  too, in every parent layout (decision 2) — and swaps `min > max` with a warning
  recorded on the result.
- **Tables** resolve column widths first, from each single-span cell's stated or
  measured natural width, and then measure each cell's height at its final width.
- **p. 329:** a cell takes its column's width. A stated-size leaf, a positioned
  subform, or a re-measured text leaf is narrowed; a flowed container (`tb`,
  `lr-tb`, table) whose extent depends on its width still refuses, named.

### `xfaconvert.ts` (changed)

Builds `measure` from `faceLookup(doc)`, the leaf's `LeafText` and the bound
value from `XfaValues` (by the field's SOM name), and passes it to
`layoutPage`.

## Oracle and tests

- **Unit, pure:** `xfarich` (plain records; the `exData` vocabulary;
  `xfa-spacerun`; inheritance; dropped unknown elements; every refusal);
  `xfatext` with synthetic metrics (wrap at width and at `maxWidth`; longest line;
  mixed-face line height; `lineHeight`; paragraph spacing; margins, indent and
  caption on every side; empty field; password mask); `xfafont` (tier order,
  name-table matching, coverage fall-through, the substitute table's exact names
  and the absence of `Helvetica`, no mutation via the sign path); `xfaflow`
  (column narrowing, the `lr-tb` refusal, a measured cell at column width,
  `min*` floors in `tb` and `row`, `min > max` swap, no-measurer unchanged).
- **Oracle (`test/xfa-dynamic-oracle.test.ts`):** the `Header` occur rows block
  page-level layout until 164g.2, so the `SectionII` and `SectionIIIpt2` tables
  are laid out as **isolated subtrees** and compared with pdf.js relative to each
  table's origin. `Q1`: its measured content (before `minH`) equals pdf.js's
  14.05pt to 0.05; its final height is exactly `minH`, 16.56pt, the recorded
  divergence. `SectionIIIpt2`'s over-wide draws take their column widths and
  agree with pdf.js. The page-level count stays `{0, 0, 0}`.
- **Fences:** `xfa-real.test.ts`'s 199 f1040 rects and `xfa-flow-oracle`'s 40,
  with the measurer in place; every pre-existing `xfaflow` case.

## Documentation

CLAUDE.md entries for `xfarich.ts`, `xfatext.ts`, `xfafont.ts`, and the corrected
p. 329 note under `xfaflow.ts`. CHANGELOG: **Added** (growable XFA fields and
draws measured) and **Changed** (an over-wide table cell takes its column).
README's XFA limitation line. `test/fixtures/xfa-dynamic/PROVENANCE.md`: the
`Q1` divergence and the hhea interpretation.
