# DOCX textbox mode — fixed positioning

Design for `aspose-pdf-foss-for-ts-8yt9.4`, the last child of the
`PDF to DOCX export` epic (`8yt9`). It adds a second layout mode beside the flow
mode `8yt9.2` shipped, reproducing each PDF page's own geometry instead of
reflowing it.

## Problem

`ToDocx` reflows. Pages concatenate with no page break, text is placed by Word
according to its own metrics, and the PDF's page geometry is discarded — which
is right for a reflowable deliverable and wrong for anyone converting a form, an
invoice, a certificate or a two-column paper, where *where the text sits* is the
content.

`ToHtml` already answers this with `mode: 'fixed'` ([htmlfixed.ts]), and the
positioned inputs a DOCX would need already exist: `TextFragment.quad`,
`ImageEvent.quad`, `page.ToImage()`. What is missing is a body producer that
emits positioned WordprocessingML, and a decision about which of the several
constructs that can position text in a `.docx` to use.

Two things stand in the way that are more than a mapping table:

- **The document model has no geometry.** `docmodel.ts` is deliberately
  position-free and is read by three serializers. Textbox mode cannot come from
  it, so it needs its own path to the page — which means deciding where that
  path lives without privileging one serializer.
- **The extraction stack has no colour.** `text.ts`'s `visitContent` tracks the
  CTM and nothing else; `GlyphEvent` and `TextFragment` both carry font, size,
  baseline and emphasis, but no fill colour. Colour is unremarkable in a
  reflowable export and visibly wrong in a positioned reproduction.

## Approach

Two new modules, both pure, plus a mode switch in the one module that already
reads a `Document`:

- **`docxgroup.ts`** — the adaptive merge. Glyph events in, positioned groups
  out. Its own module for `docinfer.ts`'s reason: every threshold is testable
  from hand-built events with no PDF in sight, and burying it in the mapper
  would make it reachable only through generated XML.
- **`docxtextbox.ts`** — positioned groups, image placements and an optional
  backdrop in; the inner XML of `<w:body>` out. Emits through `docxflow.ts`'s
  `runXml`/`paragraphXml`/`sanitizeXml`/`drawingXml` and `docxstyles.ts`'s unit
  constants. Touches no `Document` and allocates no package part.

  **Invariant:** there is one paragraph emitter and one run emitter for the
  whole export. `docxflow.ts` gains the frame, size and colour *vocabulary*
  rather than `docxtextbox.ts` gaining a second pair — a second emitter is how a
  frame comes to lose the `xml:space` attribute or the control-character strip
  the rest of the document has, exactly as `docxtable.ts` takes its paragraph
  builder as an argument for the same reason.
- **`docxexport.ts`** — branches once, at the `docxBody(...)` call, and gathers
  the positioned inputs. Still the only module here that reads a `Document`.

Plus one shared-model change, scoped as narrowly as it can be: `GlyphEvent`
gains a fill colour.

The gather is **one** `visitContent` pass per page, not two: `ContentVisitor`
carries a `glyph` and an `image` hook, so text and image placements arrive
together, in content order, from a single walk. `background: 'raster'` adds a
`page.ToImage()` call beside it.

```
                    ┌─ glyph ─► groupGlyphs() ─► TextGroup[] ─┐
visitContent(page) ─┤                                          ├─► docxTextboxBody()
                    └─ image ─► images.add() ─► placements ────┤            │
page.ToImage({box}) ──────────► images.add() ─► backdrop ──────┘            ▼
                                    (background: 'raster' only)      w:body XML
```

Three alternatives were considered and rejected:

- **A `RenderSink` over `interpret`**, mirroring `htmlfixed.ts` exactly. It
  would buy annotation `/AP` compositing and fill colour for free
  (`TextRunInfo.color`). Rejected because roughly fifteen `RenderSink` methods —
  clip, blend, offscreen, knockout, soft mask, shading, stroke — have no DOCX
  expression; `htmlfixed.ts` delegates them to `SvgSink`, and a DOCX has no
  backdrop to delegate to unless the raster option is on, so they would be
  no-op stubs. The sink also needs a `Document` for images, which collapses the
  pure/impure split every other module in this stack makes.
- **Extending `docmodel.ts` with geometry.** Rejected outright: it is read by
  three serializers, and adding coordinates privileges one while putting
  `test/html-identity.test.ts` and the Markdown snapshots at risk — the same
  reasoning the flow-mode design used to reject re-deriving styling inside the
  serializer.
- **Colour on `TextFragment`.** Rejected; see *Shared-model change* below. It is
  the obvious place and it is the wrong one.

## Scope

In scope:

- `src/text.ts` — `GlyphEvent` gains `color`; `walkScope` tracks the fill
  colour. `TextFragment` and `GetTextFragments` are unchanged.
- `src/docxgroup.ts`, `src/docxtextbox.ts` (both new).
- `src/docxflow.ts` — `ParaProps` gains an optional `frame`, `RunFmt` gains an
  optional `size` and `color`. Vocabulary only: unset, every existing call site
  emits the bytes it emits today.
- `src/docxexport.ts` — the mode switch, the positioned-input gather, per-page
  sections.
- `src/document.ts`, `src/page.ts`, `src/node.ts`, `src/index.ts` — the public
  option bag.
- `README.md`, `CLAUDE.md`.

Out of scope, each recorded as a limitation rather than left to be discovered:

- **Rotated and vertical runs** are placed unrotated at their quad's top-left. A
  `w:framePr` frame has no rotation, and visible ink beats silently dropped
  content — the rule `svgdraw.ts` sets.
- **`/Link` hyperlinks** are not recovered in textbox mode. The annotation walk
  exists and can feed the same mapper later, because the mapper takes positioned
  input rather than a `Document`.
- **Annotation and form-field text** is absent unless `background: 'raster'`
  puts its ink in the backdrop. `page.GetTextFragments` walks page content only;
  `page.ToImage` composites `/AP` by default.
- **No `w:tbl`.** A table's cell text is already positioned, and its rules are
  vector ink. Emitting a grid would fight the frames placing the same text.
- **Vector ink generally** — fills, strokes, shadings — reaches the output only
  through `background: 'raster'`.

## Positioning construct

A **`w:framePr` text frame**: a paragraph property in the main `w:` namespace,
ECMA-376 Part 1.

```xml
<w:p><w:pPr>
  <w:framePr w:w="2880" w:h="240" w:hRule="atLeast"
             w:x="1440" w:y="2160"
             w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>
</w:pPr>
<w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>
```

**Invariant:** the package's namespace list does not change. `docxpackage.ts`
declares exactly `w`, `r` and `wp` on the root, and `drawingXml` declares `a`
and `pic` inline on the elements that use them. A frame needs none of that —
which is the whole reason it was chosen over the two alternatives:

- **VML `<w:pict><v:shape><v:textbox>`** can express rotation, but it is
  ECMA-376 *Transitional* only (deprecated), and needs the `v` namespace on the
  root.
- **DrawingML `wps:wsp` inside `wp:anchor`** is what modern Word writes and is
  the most faithful, but `wps` is a Microsoft 2010 extension outside ECMA-376,
  so conformance requires `mc:AlternateContent` with a VML fallback — meaning
  both other constructs get written anyway, plus `mc:Ignorable` on the root.

Since this repository's DOCX claim is *structural conformance to ECMA-376* and
explicitly not compatibility with any particular consumer, the construct inside
Part 1 that needs no extension namespace is the one to hold.

**Invariant:** there is exactly one positioning construct in the mode. Text
frames, image frames and the raster backdrop are all `w:framePr` paragraphs;
an image frame's paragraph holds one run holding the `w:drawing` that
`docxflow.ts`'s `drawingXml` already builds. A second mechanism for pictures is
how a page comes to place its text against one origin and its images against
another.

## `docxgroup.ts` — the adaptive merge

```ts
export interface TextGroup {
  /** Page-space axis box [x0,y0,x1,y1] covering every glyph in the group. */
  quad: [number, number, number, number];
  fontSize: number;
  color?: Rgb;
  bold?: boolean;
  italic?: boolean;
  text: string;
  /** True when any contributing glyph was rotated or vertically set. */
  skewed?: boolean;
}

export function groupGlyphs(glyphs: GlyphEvent[], opts?: GroupOptions): TextGroup[];
```

Consecutive glyphs join one group while they share a baseline (within the same
tolerance `fragmentsFromGlyphs` already uses, so a kerned pair still merges), a
font size, an emphasis, a colour, and are separated by less than the gap
threshold. Any of those changing starts a new group.

A group whose glyphs carry an `angle` or `vertical` sets `skewed`, which
`docxtextbox.ts` reads only to place the group unrotated at its quad's top-left
and to count it for the limitation — a frame has no rotation to give it.

**Invariant:** this module groups *glyphs*, not `TextFragment`s. Fragments merge
across colour changes by design, so grouping from them would paint a whole line
the colour of its first word; and re-deriving the split afterwards cannot
recover a boundary the fragment already dissolved.

**Invariant:** the gap threshold is what keeps a two-column page in two columns.
`TextLine` assembles every fragment sharing a baseline, so a line in the left
column and one in the right merge into a single line — correct for reading order
and fatal for a positioned reproduction, since Word would then decide the width
of the gutter. Grouping stops at the gutter instead.

**Note, to be measured rather than assumed:** the threshold is stated as a
multiple of the font size, and the value is to be settled against fixtures, not
picked in advance. The leader-dot case (`Introduction ....... 3`) and the
two-column gutter are the two that bound it from opposite sides.

## `docxtextbox.ts` — geometry

Against the sizing box `B` (the page's `CropBox`, or `MediaBox` under
`box: 'media'`):

```
w:x = round((quad[0] - B[0]) * TWIPS_PER_PT)
w:y = round((B[3] - quad[3]) * TWIPS_PER_PT)
```

**Invariant:** the frame's top comes from `quad[3]`, not from a font ascent.
A `TextFragment`/`TextGroup` quad runs `baseline .. baseline + fontSize`, so its
top edge is already where Word starts the line box. `htmlfixed.ts` subtracts
`ascent * dev` because a CSS `top` is the em-box top and it knows the
substituted face's ascent; a frame does not need that, and inventing an ascent
for a face we did not choose would be a guess with nothing behind it.

Sizing:

```
w:w     = min(quadWidth * WIDTH_HEADROOM + PAD, B_right - x)
w:h     = quad height
w:hRule = "atLeast"
w:wrap  = "none"
w:hAnchor = w:vAnchor = "page"
```

`WIDTH_HEADROOM` starts at 1.25 and `PAD` at 2pt — a starting point to be
tuned against fixtures, not a derived figure. Both are module constants, named
so the plan can move them without hunting literals.

**Invariant:** a frame errs wide, never narrow. Word re-measures the text with a
substituted face, and a frame narrower than the result wraps to a second line
and displaces everything below it inside that frame. `w:wrap="none"` means an
over-wide frame displaces nothing at all, so the two errors are not symmetric.

**Invariant:** `w:hRule` is `atLeast`, not `exact`. An overflowing line
overlapping its neighbour is visible; a clipped one is gone.

**Invariant:** the backdrop frame is emitted first. Frames stack in document
order, so a backdrop emitted after the text hides the page.

Runs inside a frame carry `w:sz` (half-points, from `fontSize`), `w:b`/`w:i`
from the group's emphasis, and `w:color` from its colour. Text goes through
`sanitizeXml` and `escapeXml` on `docxflow.ts`'s terms — every `w:t` keeps
`xml:space="preserve"`, since a group's trailing space is as load-bearing here
as it is in flow mode.

## Pagination

Each PDF page becomes its own WordprocessingML section, carrying that page's own
`w:pgSz` and zero margins.

**Invariant:** a non-final section's `w:sectPr` lives inside the **last
paragraph's** `w:pPr` for that section; only the final section's is a direct
child of `w:body`. The two spellings are not interchangeable, and the wrong one
is a file Word refuses — the same class of rule as `w:tcPr`'s ordered children.

**Invariant:** each page emits one ordinary, unframed paragraph to anchor its
section break. A framed paragraph is lifted out of the flow, so a page of
nothing but frames has no flow content and its section collapses into the next.

**Invariant:** `docxexport.ts`'s existing document-wide `sectPr`, taken from
`pages[0]`, stays flow mode's and is not shared. Flow mode states one page size
for the whole document deliberately; textbox mode must state each page's own, or
a mixed-size document silently reflows.

## Shared-model change — `GlyphEvent.color`

`text.ts`'s `walkScope` tracks the CTM and no other graphics state. It gains
fill-colour tracking:

- The `q`/`Q` stack widens from `Matrix` to a state record carrying the CTM and
  the fill colour.
- `g`, `rg`, `k`, `cs`, `sc` and `scn` resolve through `colorspace.ts`'s
  `resolveColorSpace`, exactly as `paths.ts` already does — one owner for
  "what colour is this operand", not a second copy.
- `GlyphEvent` gains `color?: Rgb`, absent rather than defaulted, the fence
  `TextFragment.bold`/`.italic` already established.

**Invariant:** `TextFragment` gains nothing. `fragmentsFromGlyphs` merges
consecutive glyphs sharing font, size and baseline *across* show operators, and
colour is deliberately not part of that identity — `docmodel.ts`'s untagged link
recovery is written against a whole line commonly being one fragment. Adding a
colour field without changing the identity paints a line the colour of its first
word; adding it to the identity moves every untagged fragment snapshot and
disturbs the premise `splitLineLinks` relies on. Textbox mode runs its own
`visitContent` pass and groups glyphs itself, so it needs neither.

**Note:** text render mode `Tr 1`/`5` (stroke-only) takes the fill colour. A
stroke-outlined heading is rare and the miss is a shade rather than a
disappearance; tracking the stroke colour as well would double the state for
that one case.

## Public API

```ts
export interface DocxOptions {
  /** Reflowable, or positioned page reproduction. Default 'flow'. */
  mode?: 'flow' | 'textbox';
  /** Page backdrop in 'textbox' mode. Default 'none'. */
  background?: 'none' | 'raster';
  /** Which box sizes the page. Default 'crop'. 'textbox' mode only. */
  box?: 'crop' | 'media';
}

doc.ToDocx(options?: DocxOptions): Uint8Array;
page.ToDocx(options?: DocxOptions): Uint8Array;
```

`node.ts`'s `saveDocxFile` takes the same bag and passes it through.

This reverses `8yt9.2`'s "no option bag by design" — which held because a
`.docx` contains its images and takes its page size from the document, leaving
a caller nothing to decide. A second layout mode is something to decide, so the
rationale expires. The shape mirrors `HtmlOptions` deliberately: a caller who
knows `ToHtml({ mode: 'fixed' })` should not have to learn a second idiom.

**Invariant:** flow mode's output is byte-identical to `8yt9.3`'s, and
`docxflow.ts` never learns the mode exists — it gains optional vocabulary that
emits nothing when unset, not a branch. `docxexport.ts` branches once.

## Testing

- **`test/docx-group.test.ts`** — the merge, driven from hand-built
  `GlyphEvent`s with no PDF built, the way `test/docinfer.test.ts` is: the
  leader-gap split, the two-column gutter, a colour change mid-line, a size
  change, and an emphasis change.
- **`test/docx-textbox.test.ts`** — geometry asserted as numbers (a group at a
  known quad lands at known twips), the section-per-page structure and its two
  spellings, images and backdrop as frames holding drawings, and the rotated-run
  fallback. Read back through `test/helpers/unzip.ts`.
- **`test/docx-flow-identity.test.ts`** — `doc.ToDocx()` and
  `doc.ToDocx({ mode: 'flow' })` produce bytes identical to each other and to a
  committed snapshot. This is what makes the option bag provably free, the fence
  `test/rich-runs-identity.test.ts` and `test/html-identity.test.ts` already set
  for their layers.
- **The glyph-colour fence** is the *existing* suite staying green unchanged —
  `test/text-fragments.test.ts`, the untagged `docmodel` tests and the Markdown
  snapshots. Their not moving is the evidence that colour landed on
  `GlyphEvent` alone.

Per this repository's rule, each assertion is proven load-bearing by breaking
the path it covers and confirming the suite goes red — not by watching it pass.
Two are known to need care:

- A **single-column** fixture cannot pin the gutter threshold: every gap is
  below it whatever the value. The two-column case is the only one that fails
  when the threshold is raised.
- A **monochrome** fixture cannot pin the colour split, and a fixture whose
  colour change coincides with a font change cannot either — the font change
  splits the group on its own. The colour boundary must fall mid-run, in one
  face, at one size.

No CI here can open Word. These tests prove structural conformance to ECMA-376
and nothing about a particular consumer.

## Documentation

`README.md`: the DOCX row in the API overview gains the option bag; the
**"DOCX export is flow mode"** limitation is rewritten — it currently reads
"Reproducing the PDF's own pagination is a later feature", which this issue
makes false — and the textbox-mode limitations above are stated there.

`CLAUDE.md`: `docxgroup.ts` and `docxtextbox.ts` join the DOCX module
description with their invariants; the `text.ts` entry records
`GlyphEvent.color` and why `TextFragment` did not gain it.
