# Dynamic XFA oracle — provenance (`164g.6`)

A genuinely dynamic XFA form, and the box **pdf.js's XFA layout engine** gives
every named node of it, as published and in two derived variants. It is the
oracle for the dynamic layout epic (`164g`) where the hybrid forms in
`../xfa/` cannot help: their flow oracle (`164g.5`) has no `tb` chain, no
`<occur>` repetition and no page breaking. Tests in
`test/xfa-dynamic-oracle.test.ts`.

| File | What |
|---|---|
| `opm1644.pdf` | OPM Form 1644, *Child Care Provider Information for the Child Care Subsidy Program for Federal Employees* |
| `goldens.json` | Per-node boxes from pdf.js, for three variants of it |

## The form

- **Source:** <https://www.opm.gov/forms/pdf_fill/opm1644.pdf>, fetched
  **2026-10-09**. The URL is not versioned, so a later fetch need not match.
- **SHA-256:** `57f1e6fe7fcb36f6d9f18856f24c32dbdc54e9ded79b9c7cab07227f6bd6d588`
  (2,587,175 bytes).
- **Producer:** Adobe LiveCycle Designer 8.0 (its own XFA `config` packet).
- **Licence:** a work of the United States federal government (Office of
  Personnel Management), not subject to copyright in the US (17 U.S.C. § 105).
- **Why it is dynamic:** `/NeedsRendering true` and **no** AcroForm fields, so
  a viewer has nothing to show but what it lays out from the template. That is
  also exactly what makes pdf.js take its XFA path (`isPureXfa`). The PDF's own
  page is Designer's one-page placeholder; pdf.js lays the template out on two.

### How it was found, and why only one

The OPM standard-form and OPM-form indexes were scanned (some 110 PDFs), plus
IRS, USCIS and GSA forms. Every federal form Designer saved was a **hybrid**
(static, with an AcroForm) except OPM 1644. And across all of them
`<occur max="-1">` appears only where Designer puts it by default — on a
table's **header row** — so no federal form found repeats a subform from data
as published. That is why two of the three variants below are derived.

## The three variants

`test/helpers/xfa-dynamic.ts`'s `deriveVariant` builds each from the vendored
bytes, and the generator and the suite both call it. Every edit must match
**exactly once** or it throws, and `goldens.json` records the SHA-256 of the
template and datasets text pdf.js was fed, which the suite reproduces.

| Variant | Edit | What it exercises |
|---|---|---|
| `published` | none | A `tb` root (`OF1644`) whose two page-tall `position` subforms break onto two instances of the **one** `<pageArea>`; tables, nested tables, `row`, `colSpan="-1"` and `colSpan="2"` |
| `header` | datasets only: three `SectionI.Header` data groups | **Data-driven `<occur>` repetition** inside a table: three header rows stacked at the row pitch, pushing SectionI's own rows down while the positioned SectionII does not move |
| `pages` | template: `<occur max="-1"/>` on `Page2`; datasets: three `Page2` groups with `FieldQ1FinInst` = `Bank 1..3` | A subform **repeated across page breaks**: `Page2[0..2]` on pages 2–4, each bound to its own data group |

## The generator

`npm run gen:xfa` (`scripts/gen-xfa-goldens.ts`), not run by `npm test`. Needs
`npm i --no-save puppeteer` (and its headless Chrome), network access to
`registry.npmjs.org`, and `tar` on `PATH`.

- **pdf.js:** the `pdfjs-dist` **6.3.289** npm release (2026-08-29), verified
  against its registry integrity
  `sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==`,
  built from pdf.js commit `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`.
- **Browser:** Chrome/152.0.7977.54 headless, through puppeteer.
- **How:** each variant document is served to a page that calls pdf.js's own
  `getDocument({ enableXfa: true })`, `page.getXfa()` and `XfaLayer.render`
  with `pdf_viewer.css` — the same code path pdf.js's viewer takes — and every
  element carrying an `xfaname` is read back with `getBoundingClientRect`. At
  scale 1 one CSS px is one point, so boxes are in points from the page's top
  left, rounded to 0.01.
- **Why a browser, not pdf.js alone:** pdf.js sizes and positions every node
  and paginates, but leaves the placement of a flowed container's children to
  CSS (flex and grid). Its HTML alone does not state where a `tb` child lands.
- **SOM names** are derived, not read: pdf.js keeps a node's
  `data-element-id` when it splits that node across pages and gives a
  repeated instance a fresh one, so a node's occurrence index is the order in
  which its id first appears under the same parent path. An unnamed container
  carries no `xfaname` and is left out, so its children are numbered under the
  nearest NAMED one. That is the converter's DATA path (`XfaField.dataPath`),
  not its SOM name, which since `fdq3` spells the level `#subform[n]` as
  LiveCycle does (`../xfa/PROVENANCE.md`); the tests join through it. Page-area furniture
  (the page-number draw) is named `#pageArea[Page1].…` so it cannot pass for
  form content.
- **Reproducible:** two consecutive runs produced byte-identical
  `goldens.json`.

## What it established on its first run

- **pdf.js's names agree with ours.** The set of field names pdf.js lays
  out equals `parseXfaTemplate`'s data paths, all 61, for both the published form and the
  `header` variant. The two were derived independently — element ids in a
  rendered DOM against the template — so this is evidence for both.
- **Our engine placed none of it at first**, for three reasons: the repeating
  `Header` rows (`164g.2`); `Page2`, a second instance of the one `<pageArea>`
  (`164g.3`); and `SectionIIIpt2.Row3`'s `w="30mm"` draws in columns as narrow
  as 26.67mm, which 164g.1 refused and **pdf.js shrinks to the column**.
- **`164g.7` settled that last one in pdf.js's favour**, by XFA 3.3 p. 329: "the
  visible representation of the object may extend beyond the allotted region".
  Page-level layout now places `SectionIIIpt2`'s 35 fields, every one on
  pdf.js's box. Laid out ALONE, every field of `SectionII` agrees too, with one
  recorded divergence: pdf.js ignores `Q1`'s `minH` (it applies `min*` only in a
  positioned parent; p. 276 makes it a floor everywhere), so every row below
  `Q1` sits exactly `minH − 14.05pt` lower here, and the test asserts that
  difference rather than tolerating it. pdf.js measured `Q1` at exactly the
  hhea extent of 10pt Arial plus its insets, which is the reading `xfatext.ts`
  takes of p. 61.
- **It also overruled the plan for `164g.7` once:** `Table2SecII`, a nested
  table, is 0.003pt wider than its cell by mm rounding, and the plan refused
  every flowed container narrowed to its column. Only a one-line `lr-tb` refuses
  now, being the one container whose layout depends on the width it is given.
- **Since `164g.2` the Header rows are instantiated.** Each table's
  `<occur max="-1">` Header row is made once per `Header` data group, so no
  table refuses at its Header any more, and every placed box still agrees with
  pdf.js. The page-level count rises only from 35 to 37, because that loop runs
  without a text measurer. In `header`, the three instances push SectionI's
  later rows down exactly 2 x 18pt, and pdf.js shows the same shift
  (173.69 -> 209.69). SectionII does not move.
- **Since `164g.3` the form paginates.** OF1644's two page-tall subforms land
  on two instances of the one `<pageArea>`, and in `pages` `Page2[0..2]` on
  pages 2-4, exactly as pdf.js puts them. Every box the page-level loop places
  agrees with pdf.js on pdf.js's page (42, 42 and 52 fields, up from 37), and
  the `pages` variant converts onto four fresh pages with all 85 fields
  positioned, each `Page2` instance bound to its own data group (`Bank 1..3`).

## What it does NOT establish — read this before trusting a green run

- **pdf.js is not Adobe.** It is an independent reimplementation of XFA
  layout, so agreement is evidence and not conformance. No Acrobat-flattened
  output exists for this form: the development machine's Acrobat runs in
  Reader mode. If Acrobat Pro output becomes available, prefer it.
- **Fonts are pdf.js's and Chrome's.** The template names Arial, Times New
  Roman, Helvetica and Adobe Pi Std; pdf.js finds no Helvetica or Adobe Pi Std
  in the file and falls back. A node whose template states its `w` and `h` has
  a box independent of fonts; a node sized by its text (a `minH` draw such as
  `SectionII.Row1.Q1`) is measured with those fallbacks.
- **Two of the three variants are ours.** The `pages` variant's
  `<occur max="-1"/>` on `Page2` is a one-element template edit no federal form
  makes. The layout is still pdf.js's, but the shape was chosen to exist.
- **One form, one producer (Designer 8.0).** No `lr-tb` at all, an overflow
  leader that is declared (two tables name their header row in
  `<break overflowLeader>`) but never fires because no table splits, no
  `breakBefore` with a target, no `<occur>`
  with `min` or `initial`, no growable container that splits mid-content
  across a page (each page subform here is exactly a page tall), and no
  exclusion group.
- **Chrome's precision is part of every number.** Lengths come back in 1/64-px
  layout units, so a 5.842mm row (16.5603pt) reads 16.547pt and the loss
  accumulates down a table -- 0.066pt five rows down. The table tests allow one
  layout unit per row above a field; a rule that moves a box by less than that
  cannot be seen here.

## DoD DD 2875 and DD 1494 (d3mq)

Two dynamic US Department of Defense forms (`/NeedsRendering true`, no
AcroForm fields), US federal works, fetched **2026-10-12** from
`https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/` (the site now
refuses scripted access; compare against these hashes):

- `dod-dd2875.pdf` — 56,896 bytes, `e7247a22dac5633d00e761724f169d32186853300b9eec6d870df35103401885`
- `dod-dd1494.pdf` — 117,948 bytes, `16bb17a7ccffa46989e2e454fb964010ab9fdfc8f8ee0b7bd045f542e7ee7d41`

**Why they are here:** they put FILLABLE fields on their master pages -- DD
2875's CUI marking choice lists (one inside a positioned `Footer` subform), DD
1494's classification and `start`/`stop` fields -- and pdf.js lays them out on
3 and 14 pages. `master-goldens.json` holds pdf.js 6.3.289's box (in Chrome)
for every node it names under a page area, per page: 25 and 84 nodes.
`test/xfa-master-oracle.test.ts` checks every page-area FIELD box against our
master layout of that page area (XFA 3.3 p. 288: the background is copied onto
each page instantiating it), within 0.05pt.

**Naming, measured:** pdf.js names a page-area node `#pageArea[<name>].<path>`,
numbered from `[0]` on EVERY page -- the copy on page 3 is `start[0]`, not
`start[2]` -- so the test matches by page area and path with no normalization.

**What it does NOT compare:** the BODY. Until `bkdi` our engine refused it
("wraps after a line of mixed heights"). Since then DD 2875 converts end to end
on pdf.js's 3 pages, but its body positions are compared with nothing. Since
`164g.8` DD 1494's body IS compared: `master-goldens.json` keeps its body nodes
as `body`, and every one of its 301 fields lands on pdf.js's page and box across
14 pages, each on pdf.js's page area. It pins splitting a `tb` subform between
its children; its `breakBefore`s all land where a page starts anyway, so it does
not discriminate breaks inside a split, and its `<overflow>` leaders never fire.
`gen:xfa` downloads from the registry over `node:https` with a 60-second
timeout, since `fetch`'s 10-second connect timeout failed on a slow network. Nor values:
the master fields bind `match="global"` (`yy09`). pdf.js is a
reimplementation -- evidence, not Adobe conformance.

## `chrome-goldens.json` -- the chrome oracle (164g.4)

**What it holds:** for the published OPM 1644 and both DD forms, what pdf.js
6.3.289 renders in Chrome on each page: every element pdf.js gives the class
`xfaBorder` (its box and its four computed border widths, styles and colours),
and the text of every `xfaDraw` and `xfaCaption`, with its box. 118, 119 and 383
borders; 58, 78 and 359 texts. Generated by the same `npm run gen:xfa` run,
pinned pdf.js and Chrome (SHA-256 of the JSON
`b88aa2279d5283d67a8caeddadc174716543cded69bc23184b8036fcf11bf54f`);
`goldens.json` and `master-goldens.json` did not move when it was added.

**What `test/xfa-chrome-oracle.test.ts` compares:**

- **Page count**, and that every page carries chrome (`report.chromePages`).
- **Text membership:** the page-content fragments whose centre falls in each
  pdf.js box, joined, must spell its text, spaces ignored -- pdf.js wraps with
  browser metrics, so a line break may swallow a different space. Matched 52 of
  55, 74 of 78 and 304 of 335 (49 and 268 until `164g.17` measured
  `xfa-spacerun` spans; those spans were 43 of the misses, and 36 match now;
  301 until `164g.18` read U+2029 in rich text as a paragraph break).
- **Push-button captions** separately: a button's caption is its FACE, so it is
  checked against the widget's `/MK /CA`, not page text. 3, 0 and 24 buttons,
  every one equal to pdf.js's text. This case found that the converter created
  every push button with no `/CA` at all -- 27 labels drawn nowhere and
  reported nowhere -- and `DD 1155`'s Reset button anchors the reading on what
  Adobe wrote.
- **Borders:** every all-solid pdf.js border must have, on each side, a stroke
  of ours whose OUTER edge lies on that side within 1pt and spans it. Widths are
  compared as Chrome reports them: a CSS border snaps to whole device pixels and
  one below a pixel draws as one, so our 0.5pt reads back as `1`. Matched 46 of
  48, 62 of 62 and 53 of 53. Comparing raw widths matched NONE, while every box
  agreed to the hundredth.

**The residual misses, every one accounted for:**

- **Refused text**, each named in `report.skipped` as `what: 'chrome'`:
  a tab, `margin-top` on an inline element, `tab-interval`,
  `text-valign`, the embedded-object `Page n of m` span, and
  faces with no substitute (`Myriad Pro`, `Arial Narrow`). These were
  `164g.7`'s measurement refusals all along; before this oracle a refused leaf
  whose runs the refusal had emptied was dropped by `textOps` with NO report.
- **DD 1494's `JSwarn`** ("FORM WILL NOT WORK CORRECTLY WITHOUT JAVASCRIPT"),
  on 14 pages: a `layout:ready` script hides it in Adobe and pdf.js shows it.
  We paint none of it, because its face (`Myriad Pro`) resolves nothing --
  reported, and by accident the answer Adobe gives.
- **Two OPM borders** below Q1: pdf.js lays Q1 out 2.5pt shorter than we do
  (it applies `min*` only in a positioned parent; see `xfaflow.ts`), so every
  box beneath it in Section II sits 2.5pt higher there.

**What it does NOT compare:** pixels, fills, dashed or dotted or 3-D borders
(pdf.js maps `lowered`/`raised` to CSS `inset`/`outset`, which is not Adobe's
drawing), corner radii, text position within its box, colour, or decoration.
And pdf.js is a reimplementation -- evidence, not Adobe conformance.
