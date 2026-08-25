# Feature Showcase example — design

Port the Go library's `_examples/feature_showcase/main.go` (2513 lines) to
TypeScript against the current `aspose-pdf-foss-for-ts` API, producing a single
"annual report"-style PDF that exercises every major capability in one narrative.

Source: <https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/blob/main/_examples/feature_showcase/main.go>

## Goal and non-goals

**Goal.** Reproduce all fourteen sections of the Go showcase, section for
section, translated to the TypeScript API surface. The output is a committed
artifact (`docs/feature-showcase.pdf`) linked from `README.md`, regenerated
when the example changes meaningfully.

**Non-goals.** No new sections for TypeScript-only features (barcodes,
optional-content layers, tagged PDF, HTML export, digital signatures, PDF/A
validation). Those are covered by the README and the test suite; adding them
here would make the port a different document from the one being ported.
Encryption stays off, for the reason the Go file gives: an encrypted file does
not render in GitHub's inline PDF preview.

## Layout

```
_examples/feature-showcase/
  main.ts            document scaffolding, section registry, named destinations,
                     page labels, metadata/XMP, per-page furniture, optimize, save
  theme.ts           palette, shared text styles, sectionHeader, addUnifiedFooter,
                     centeredRect, rectToQuads, the rect-based addText helper
  assets.ts          asset loading, one readFileSync per file, cached
  cover.ts           page i   — cover
  contents.ts        page ii  — table of contents
  text.ts            page 1   — text capabilities
  image.ts           page 2   — JPEG embedding
  forms.ts           page 3   — AcroForm field types
  annotations.ts     page 4   — annotation gallery
  redaction.ts       page 5   — mark-mode vs applied redaction
  bill.ts            page 6   — restaurant bill (single-page table)
  sales.ts           page 7+  — multi-page sales report
  landscape.ts       page N   — landscape 12-month chart
  vector.ts          page N+1 — vector graphics gallery
  flatten.ts         page N+2 — form & annotation flattening
  flowshowcase.ts    page N+3 — flow layout, "Giants of Physics"
  render.ts          page N+4 — rendering & imposition thumbnails
  assets/            10 binary assets + PROVENANCE.md
docs/feature-showcase.pdf
```

One module per Go function boundary. Each section module exports a single
function taking the `Page` it fills (and `Document` where it needs one), so no
module needs to hold the whole document in context and each can be read and
reasoned about alone. `theme.ts` is the only shared surface between them.

### Running it

`tsx@4.23.1` is already present in `node_modules` but *extraneous* — not
declared in `package.json`. Move it into `devDependencies` and add:

```json
"example:showcase": "tsx _examples/feature-showcase/main.ts"
```

Node 24's native type-stripping cannot substitute for it: the example imports
`../../src/index.js`, and `src/` modules import each other with `.js`
specifiers under NodeNext, which Node does not rewrite to `.ts`. Verified —
`node main.ts` fails with `ERR_MODULE_NOT_FOUND`.

`_examples` is added to `tsconfig.json`'s `include` so `npm run typecheck`
covers the example. It is excluded from the published package by the existing
`"files": ["dist"]`.

## Assets

Nine files copied verbatim from the Go repository into `assets/`:

| File | Use |
|---|---|
| `starry-night.jpg` | image-embedding page (Van Gogh, public domain) |
| `newton.jpg`, `einstein.jpg` | flow-layout portraits |
| `sales-banner.jpg` | sales-report table image cell |
| `aspose-pinwheel.svg` | cover mark |
| `aspose-logo.svg` | per-page corner stamp |
| `github-mark.svg` | cover CTA icon |
| `aspose-logo.png` | push-button icon |
| `DejaVuSans.ttf` | Unicode / RTL / formula text |

`PROVENANCE.md` records source URL, SHA-256 and license per file, matching the
convention `test/fixtures/*` already follows for third-party binaries.

The Go repo's tenth asset, `go-logo.svg`, has no counterpart here. Rather than
substitute another vendor's trademark, the second cover CTA gets `book-icon.svg`
— a small unbranded document glyph authored for this example and committed as
our own file, so it carries no third-party rights. The cover's two CTA links
retarget this repository: source code, and the README as the API reference.

## API translation

The two libraries share a feature set but not a surface. The table below is the
complete mapping; anything not listed translates name-for-name.

| Go | TypeScript |
|---|---|
| `page.AddText(s, TextStyle, Rectangle)` | `theme.addText(page, s, rect, style)` → `page.AddTextBlock(s, [x,y,w,h], opts)` |
| `TextStyle.HAlign` / `VAlign` | `align` / `valign` |
| `TextStyle.LineSpacing` (multiplier) | `leading` (absolute points); helper computes `lineSpacing * fontSize` |
| `TextStyle.Rotation` / `Behind` | `rotate` / `behind` |
| `TextStyle.Underline` / `Strikethrough` / `Background` | same names on `TextBlockOptions` |
| `pdf.Color{R,G,B,A}` | `color: [r,g,b]` plus a separate `opacity` |
| `pdf.Rectangle{LLX,LLY,URX,URY}` | `[x, y, w, h]` — width/height, not opposite corners |
| `page.DrawLine` / `DrawRectangle` / `DrawRoundedRectangle` / `DrawCircle` / `DrawEllipse` / `DrawPolyline` / `DrawPolygon` / `DrawPath` | one `page.Graphics()` session per section: `drawLine`, `rect`, `roundedRect`, `circle`, `ellipse`, `polyline`, `polygon`, `moveTo`/`lineTo`/`curveTo`/`arc`/`close`, painted with `stroke()`/`fill()`/`fillStroke()`, committed with `apply()` |
| `ShapeStyle{FillGradient: RadialGradient{...}}` | `g.setFillGradient({ kind: 'radial', cx, cy, r, fx, fy, stops })` |
| `pdf.NewHighlightAnnotation(page, rect)` + `annots.Add` | `page.AddHighlight({ quads, color })` — and the fifteen sibling `page.Add*` adders |
| `form.AddTextField(pageNum, rect, name)` then `SetValue` then `SetStyle` | `doc.Form.AddTextField({ page, rect, name, value, borderColor, backgroundColor, textColor, borderWidth, font, fontSize })` — one call, styled at creation |
| `form.AddRadioGroup(name, []RadioItem{...})` | `doc.Form.AddRadioGroup({ name, selected, options: [{ page, rect, export }] })` |
| `submit.SetAppearance(ButtonAppearance{...})` | options on `AddPushButton`: `caption`, `rolloverCaption`, `downCaption`, `icon`, `iconPosition: 'icon-above-caption'` |
| `pdf.NewSubmitFormAction(url, nil, 0)` | `action: { type: 'submit', url }` |
| `pdf.NewTable().SetColumnWidths(...).SetBorder(...)` fluent chain | `createTable({ border, outerBorder, padding, font, fontSize })` then `setColumnWidths([{ fixed: 260 }, ...])` |
| `SetDefaultCellMargin(MarginInfo)` | table-level `padding` in `createTable` |
| `SetRepeatingRowsCount(3)` | `table.setRepeatingRowsCount(3)` |
| `SetOverflowMargins(60, 60)` | `AddTable(t, x, top, { autoPaginate: true, bottomMargin: 60, topMargin: 60 })` |
| `page.AddTable(table, Rectangle)` | `page.AddTable(table, x, top, { width })` — top-left anchor plus width |
| `TOCEntry{Page: *pdf.Page}` | `TOCEntry.page` is a **1-based page number** |
| `doc.NewFlow(FlowOptions)` | `doc.NewFlow({ format, columns, columnGap, marginLeft, ... })` |
| `flow.AddFloatBox(box, pdf.FloatLeft, 112)` | `flow.AddFloatBox(box, 'left')` — width lives on `doc.NewFloatingBox({ width: 112 })` |
| `pdf.NewFloatingBox().SetSpacing(2).SetBackground(c)` fluent | `doc.NewFloatingBox({ spacing, background, border, padding, width })` — options object |
| `doc.LoadSVG(path)` + `page.AddSVGObject(svg, rect)` | `page.AddSVGObject(bytes, [x,y,w,h])` |
| `p.RenderPNG(w, RenderOptions{DPI: 96})` | `page.ToImage({ scale: 96 / 72 })` |
| `doc.Extract(PageRange{From: 1, To: 8})` | `doc.ExtractPages([1, 2, 3, 4, 5, 6, 7, 8])` |
| `subset.NUp(NUpOptions{Rows: 2, Cols: 2, ...})` | `subset.NUp(2, 2, { margin: 14, gutter: 8, drawBorder: true })` — **cols first** |
| `subset.Booklet(BookletOptions{})` | `subset.Booklet({})` |
| `doc.Outlines()` + `NewOutlineItemCollection` per entry | `doc.SetOutlines([{ Title, Dest: { name }, Color, Bold, Open, Children }])` — one declarative tree |
| `named.Add(name, NewDestinationFit(page))` | `doc.SetNamedDestination(name, { page })` — defaults to `/Fit` |
| `SetPageLabels([{StartPage: 1, ...}])` | `SetPageLabels([{ startIndex: 0, ... }])` — **0-based index** |
| `doc.SetInfo(DocumentInfo{...})` | `doc.SetMetadata({ title, author, subject, keywords, creator, producer, custom })` |
| `doc.SyncInfoToXMP()` | not needed — `SetMetadata` mirrors shared fields to XMP already |
| `xmp.Custom = append(...)` + `doc.SetXMP(xmp)` | `doc.SetXmp({ custom: [{ namespace, prefix, name, value }] })` |
| `doc.SubsetFonts()` | `doc.Optimize({ fonts: true, dedup: false, compress: false, dr: false })` |
| `NewRedactAnnotation` + `SetInteriorColor` + `SetOverlayText` | `page.AddRedact({ rect, fill, overlayText, fontSize, textColor, align })` |
| `doc.ApplyRedactions()` | `page.ApplyRedactions()` / `doc.ApplyRedactions()` |
| `doc.Save(path)` | `doc.WriteTo(path)` |

## Deliberate divergences

Four places where a faithful port is the wrong answer, because the TypeScript
library does the work the Go example had to do by hand.

**Markup annotations lose their manual decoration.** The Go file hand-draws the
yellow highlight box, the underline rule, the squiggle polyline and the
strikeout rule into the content stream, because its `/AP` was left for the
viewer to regenerate — which Acrobat does and MuPDF does not. This library
*generates* `/AP` for all four subtypes, so the parallel decoration is dropped
(~60 lines). `AddHighlight` defaults to `/CA 0.4`, so the text stays readable
under the fill without a manual draw-order dance.

**Markup takes `/QuadPoints`, not a rect.** A `rectToQuads` helper in
`theme.ts` converts, in the corner order the format wants.

**TOC labels come from `/PageLabels`.** Go computed `s.page.Number() - 2` and
passed it as an explicit `TOCEntry.Label`. `AddTOC` defaults each row's label to
the target page's logical label, so page labels are set *before* the TOC is
drawn and the explicit label is dropped — exercising the documented default
instead of working around its absence.

**SVG is re-parsed per placement.** There is no load-once SVG handle in this
library, so the per-page corner stamp calls `AddSVGObject` with the same bytes
once per page (~13 times). Acceptable at this scale, and noted in a comment so a
reader does not mistake it for an oversight.

## Ordering constraints

Three orderings are load-bearing and are asserted by the verification below
rather than left to comment:

1. **Page labels before the TOC.** `AddTOC` reads `/PageLabels` for each row's
   default label; drawing the TOC first yields decimal page numbers on the
   front matter.
2. **Redaction phases within one page.** `redaction.ts` adds `/Redact` marks for
   the two "applied" rows, calls `ApplyRedactions()`, and only then adds the
   two "mark-mode" marks. Reversing this applies all four and the page loses the
   contrast it exists to show.
3. **Furniture before the render page.** The thumbnails on the rendering page
   are rasterizations of finished pages, so the logo stamp, watermark and footer
   run before `render.ts` fills its page — otherwise the thumbnails show bare
   content.

Font optimization runs last, after all text is added: it drops glyphs nothing
draws, so text added afterwards could reference a dropped glyph.

## Verification

`npm run typecheck` passes with `_examples` in `include`, and
`npm run example:showcase` runs end to end and writes `docs/feature-showcase.pdf`.

Beyond that, the claims the document makes about itself are asserted on the
saved bytes, not eyeballed — reopening the output and checking:

- the flatten page carries no `/Annots` and contributes no `/AcroForm` fields,
  while the AcroForm page's fields are still present and interactive;
- the two applied-redaction values are absent from that page's `GetText()`,
  and the two mark-mode values are still present in it;
- every TOC entry's target page and every named destination resolves inside the
  document's page count, and every outline item's `{ name }` destination names a
  destination that exists.

These run as a script step at the end of `main.ts` and fail loudly, so a
regression in any of the three surfaces the example is demonstrating stops the
build rather than producing a quietly wrong artifact.

## README

Add the showcase to `README.md` — a line under Development pointing at
`docs/feature-showcase.pdf` and the `example:showcase` script — since the file
is a user-facing artifact and the README is the index for those.
