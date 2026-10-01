# WordprocessingML model — design (`m2fp.3`)

Epic `m2fp` imports DOCX over the flow engine. `m2fp.1` reads the ZIP,
`m2fp.2` reads the OPC package (`opcread.ts`). This issue turns a package's
`document.xml`, `styles.xml`, `numbering.xml` and theme into a neutral block
model with every inherited property RESOLVED. `m2fp.5` lowers that model to
`FlowElement[]` and owns the skipped report; nothing here produces PDF.

## Decisions taken in brainstorming

1. **The model carries what the flow engine can render** — no more. Runs:
   bold, italic, underline, strike, size, colour, font family, highlight/
   shading, link. Paragraphs: heading level, alignment, spacing, indent, list
   membership. A property Word states that we do not model (superscript, caps,
   tabs, borders, …) is RECORDED BY NAME on the node, so `m2fp.5` can report
   it as degraded. Inheritance is fully implemented for the modelled
   properties only.
2. **Several small pure leaves plus one assembly module**, so every rule is
   testable from one hand-built XML file.
3. **Namespaces are RESOLVED**, never matched by stripped local names.
4. **List labels are computed here**, including numbering that continues
   across interrupting paragraphs.
5. **Theme fonts are resolved** through the theme part (`minorHAnsi` etc.).

## Modules

The prefix is `wml*`, never `docx*`: `docxstyles.ts`, `docxflow.ts` and
`docxexport.ts` are the WRITER and share no code with this. None of these is
exported from `index.ts`; `m2fp.5` publishes the entry points.

- **`xmlns.ts`** — a namespace-resolved view over `parseXml(bytes, limits,
  { qnames: true })`: each element gets `ns` (URI) and `local`, each attribute
  is looked up by `(ns, local)`, through a per-element `xmlns` scope stack. A
  pure leaf over `xml.js`. `xmprdf.ts` keeps its own RDF-specific binding; this
  is the general one, and a later issue may fold the two.
- **`wmlns.ts`** — the namespace constants and their aliases: WordprocessingML
  transitional (`http://schemas.openxmlformats.org/wordprocessingml/2006/main`)
  and Strict (`http://purl.oclc.org/ooxml/wordprocessingml/main`) are the SAME
  vocabulary; likewise the relationships namespace (transitional
  `…/officeDocument/2006/relationships`, Strict
  `http://purl.oclc.org/ooxml/officeDocument/relationships`) and DrawingML.
  Folded into this module rather than `xmlns.ts`, which knows no vocabulary.
- **`wmlstyles.ts`** — parses `styles.xml` and the theme's font scheme, and
  resolves paragraph and run properties (below).
- **`wmlnumbering.ts`** — parses `numbering.xml` and runs the list counter.
- **`wmlbody.ts`** — `document.xml`'s body to `WmlBlock[]`, applying the two.
- **`wmlread.ts`** — `readDocx(bytes, limits): WmlDocument` over `opcread.ts`:
  finds the main document by relationship type, its styles, numbering and theme
  (styles and numbering through the main document's relationships, theme the
  same), maps image rIds to part paths and hyperlink rIds to URLs, and reads the
  page from the body's final `w:sectPr`. The only module here that touches a
  package; the other five take bytes or parsed trees.

## Model

```ts
interface WmlDocument {
  blocks: WmlBlock[];
  page?: { widthPt: number; heightPt: number;
           margins: { top: number; right: number; bottom: number; left: number } };
  /** Every construct seen and not modelled, by qualified name, with a count. */
  unsupported: { name: string; count: number }[];
}
type WmlBlock = WmlParagraph | WmlTable;

interface WmlParagraph {
  kind: 'paragraph';
  styleName?: string;           // w:name of the resolved style, not its id
  heading?: number;             // 1..9, from the resolved outlineLvl + 1
  props: ParaProps;
  list?: { numId: number; ilvl: number; ordinal: number; label: string; bullet: boolean };
  inlines: WmlInline[];
  /** Stated properties not modelled (pPr children), by local name. */
  unmodelled: string[];
}
interface ParaProps {
  align?: 'left' | 'center' | 'right' | 'justify';
  spaceBeforePt?: number; spaceAfterPt?: number;
  line?: { auto: number } | { exactPt: number } | { atLeastPt: number };
  indent?: { leftPt?: number; rightPt?: number; firstLinePt?: number; hangingPt?: number };
}
type WmlInline =
  | { kind: 'text'; text: string; props: RunProps;
      link?: { url: string } | { anchor: string }; unmodelled: string[] }
  | { kind: 'break'; type: 'line' | 'page' | 'column' }
  | { kind: 'tab' }
  | { kind: 'image'; part?: string; widthPt: number; heightPt: number; alt?: string };
interface RunProps {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean;
  sizePt: number;
  color?: [number, number, number];        // undefined = auto
  font?: string;                           // ascii/hAnsi face, theme resolved
  eastAsiaFont?: string;
  highlight?: [number, number, number];    // w:highlight name or w:shd fill
}
interface WmlTable {
  kind: 'table';
  gridPt: number[];
  rows: { header: boolean; cells: WmlCell[] }[];
  unmodelled: string[];
}
interface WmlCell {
  span: number;                             // w:gridSpan, clamped >= 1
  vMerge?: 'restart' | 'continue';
  shading?: [number, number, number];
  blocks: WmlBlock[];
}
```

Units cross to points ONCE, at parse: twips / 20, half-points / 2, EMU / 12700.
`bold`/`italic`/… are always present after resolution; `false` is a value.

## Resolution

**Order** (ECMA-376 Part 1 17.7.2), for a paragraph and each of its runs:

1. `docDefaults` (`pPrDefault`, `rPrDefault`);
2. the paragraph style's `basedOn` chain — the paragraph's `pStyle`, else the
   DEFAULT paragraph style (`w:default="1"`);
3. the numbering level's `pPr` (indent) for a list paragraph;
4. the character style's chain — the run's `rStyle`, else the default
   character style;
5. direct formatting (`w:pPr`/`w:rPr` on the element).

Within one chain, the nearer style overrides the farther (a derived style wins
over its base). Table styles and their conditional formatting are NOT applied;
a table naming a `tblStyle` records it in `unmodelled`.

**Toggle properties** (`b`, `i`, `strike`; also `caps`, `smallCaps`, `vanish`,
which are recorded, not modelled) do not override across the style LAYERS — they
combine by XOR (17.7.3). Each layer's value is its chain-resolved boolean (false
when unstated); the effective value is `paragraphLayer XOR characterLayer`, or
the `docDefaults` value when neither style layer states it; direct formatting
sets the value ABSOLUTELY. So a bold paragraph style with a bold character
style yields NOT bold. This is the rule most likely to be read wrong, which is
why it is anchored against Word itself (Testing).

**`basedOn`** is followed at most `maxNestingDepth` steps and a style met twice
ends the walk (a cycle is damage we survive, never a hang); an unknown
`basedOn` ends it too. Style ids are compared EXACTLY — ids are case-sensitive
and localized (`1` is Heading 1 in Russian Word), which is why headings come
from `outlineLvl` and names from `w:name`, never from ids.

**Indent:** resolved per field, except that `firstLine` and `hanging` are ONE
signed property — the nearest layer stating either decides and the other is
dropped; within one `w:ind`, `hanging` wins (added by the final review).

**Heading level** = resolved `w:outlineLvl` + 1 when it is 0..8. `9` (body
text) and absence mean no heading.

**Fonts:** `w:rFonts` `ascii` (else `hAnsi`) is `font`; `eastAsia` is
`eastAsiaFont`. A theme attribute (`asciiTheme="minorHAnsi"`) resolves through
the theme part's `a:fontScheme` (`minorFont`/`majorFont` → `a:latin`/`a:ea`
`typeface`), and a theme attribute outranks the literal one beside it, as
Word reads it. An unresolvable theme font leaves `font` from the next layer.

**Colour:** `w:color w:val` hex, `auto` → undefined; `themeColor` is ignored
(Word always writes the `val` fallback beside it). `w:highlight` is one of the
16 named colours (table in the module, from 17.18.40); `w:shd w:fill` hex,
`auto` → none; highlight outranks shading.

**Size:** `w:sz` half-points; absent everywhere → 10pt (the ECMA default when
`docDefaults` states none).

## Numbering

- `w:num` → `w:abstractNumId` → `w:abstractNum`; an abstract num carrying
  `w:numStyleLink` follows to the numbering style's `numPr` and the abstract
  num carrying the matching `w:styleLink` (depth-bounded, cycle-safe).
- `w:lvlOverride` replaces a level wholesale when it holds a `w:lvl`, and
  `w:startOverride` replaces only that level's start.
- A paragraph's list membership is its resolved `numPr` (direct, else its
  style chain's). `numId` 0 means NOT a list — it is how a paragraph opts out
  of a style's numbering.
- **Counter:** one counter set per ABSTRACT num (lists sharing an abstract num
  continue each other, which is Word's behaviour), with each `num` carrying a
  `startOverride` restarting its levels the first time it is used. Visiting a
  level increments it and resets every deeper level (or only those whose
  `w:lvlRestart` permits); a level first met uses its `w:start`. Interrupting
  non-list paragraphs do not reset anything.
- **Label:** `w:lvlText` with each `%N` replaced by level N-1's current value
  formatted by THAT level's `w:numFmt`: `decimal`, `decimalZero`,
  `lowerRoman`, `upperRoman`, `lowerLetter`, `upperLetter`, `bullet`, `none`;
  any other format falls back to decimal and is recorded. `bullet` sets
  `bullet: true` and the label is the `lvlText` verbatim.

## Body

- `w:p` → paragraph; `w:tbl` → table (`w:tblGrid` widths, `w:tr` with
  `w:tblHeader` → `header`, `w:tc` with `w:gridSpan`/`w:vMerge`/`w:shd`, cell
  content recursively). Nested tables recurse.
- `w:r` children: `w:t` text (with `xml:space` irrelevant — the text is taken
  verbatim), `w:tab`, `w:br` (`type` line/page/column; `textWrapping` is line),
  `w:cr` → line break, `w:drawing` → `wp:inline` image (`wp:extent` EMU,
  `wp:docPr/@descr` alt, `a:blip/@r:embed` rId). A `wp:anchor` (floating)
  drawing becomes an image too but is recorded as `w:drawing/anchor`
  (degraded: it is placed inline).
- `w:hyperlink` → its runs carry `link: { url }` (from `r:id`, resolved by
  `wmlread.ts`) or `link: { anchor }` (`w:anchor`).
- **Transparent** (descended, not recorded): `w:sdt`/`w:sdtContent`,
  `w:smartTag`, `w:customXml`, `w:ins`, `w:fldSimple`. `w:fldSimple` keeps its
  result runs.
- **Dropped silently**: `w:del`, `w:bookmarkStart`/`End`, `w:proofErr`,
  `w:rPr`/`w:pPr` as content, `w:lastRenderedPageBreak`, and a complex field's
  INSTRUCTION (`w:instrText` between `fldChar begin` and `separate`); its
  result runs are kept. The field itself is recorded (`w:fldChar`).
- **Markup compatibility:** `mc:AlternateContent` takes the first `mc:Choice`
  whose `Requires` prefixes all resolve to namespaces we understand (WML, r,
  DrawingML, wp, pic), else `mc:Fallback`; elements and attributes in a
  namespace listed in `mc:Ignorable` are skipped silently.
- **Everything else** is recorded in `unsupported` by qualified name
  (`w:footnoteReference`, `w:txbxContent`, `m:oMath`, …), and its descendant
  runs' text is KEPT where it has any — visible content beats a silently
  dropped subtree (`svgdraw.ts`'s rule).

## Limits and errors

- XML nesting is bounded by `parseXml` (`maxNestingDepth`).
- Styles, abstract nums, nums and body blocks count against
  `maxContainerItems` as they are produced.
- `basedOn`/`numStyleLink` walks are bounded by `maxNestingDepth`.
- Malformed XML in a required part (`document.xml`) is `PdfParseError`; a
  missing or malformed `styles.xml`/`numbering.xml`/theme degrades to
  "no styles"/"no lists"/"no theme" and is recorded in `unsupported`
  (`styles.xml: unreadable`), since the document's text is still readable.
- A package with no `officeDocument` relationship, or one naming no part, is
  `PdfParseError` ("not a WordprocessingML document").
- Every `catch` calls `rethrowLimit` first.

## Testing

- **Hand-built XML** for every rule above: each resolution layer alone, the
  nearer-style rule, toggle XOR across layers and absolute direct formatting,
  `basedOn` cycle and unknown base, default styles, theme fonts, colour/
  highlight/shading precedence, heading from `outlineLvl` with a localized id,
  every numbering rule (override, startOverride, restart, shared abstract,
  numId 0, numStyleLink, each numFmt), every body container class, MC
  selection and `mc:Ignorable`, and the namespace aliases (a Strict-URI
  document and a document binding `w` to a different prefix read identically).
- **`ToDocx` round trip** through `readDocx`: headings, a bullet and a numbered
  list, an image, a link, a table with a span.
- **Word fixtures:** `word2010-basic.docx` reads as Heading 1 (via id `1`),
  `1.`/`2.`, the image part and the link URL. A second fixture,
  `word2010-styles.docx`, generated by extending `scripts/gen-docx-word.ps1`,
  exercises toggle XOR, style chains, direct formatting, a restarted list and two `w:num`s sharing one abstract num;
  its GROUND TRUTH is Word's own computed formatting read back through COM
  (`Range.Font.Bold`, `.Italic`, `.Size`, `.Name`, `ListFormat.ListString`) per
  run and paragraph, committed as JSON beside the file. That makes Word, not
  our reading of 17.7.3, the oracle for the rules most likely to be misread.
- **Mutation:** every rule broken once must redden something; what stays green
  is recorded as a redundant defence or pinned.
