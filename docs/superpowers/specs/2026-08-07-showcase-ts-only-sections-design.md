# Feature Showcase — TypeScript-only sections — design

Extend `_examples/feature-showcase/` with six new sections covering the
capabilities this library has and the Go original does not: barcodes,
optional-content layers, tagged PDF, HTML export, digital signatures, and
standards validation.

Supersedes the non-goal recorded in
[`2026-08-06-feature-showcase-example-design.md`](./2026-08-06-feature-showcase-example-design.md),
which deferred exactly this list so the initial port stayed a faithful port.

## Goal and non-goals

**Goal.** Six new sections in the existing showcase document, each exercising a
real public API against real output, plus the sibling artifacts two of those
features inherently produce. `verify.ts` asserts every claim on re-opened bytes.

**Non-goals.**

- No new binary assets. Every new section draws from code or reuses
  `assets/`.
- No LTV (`AddValidationData`) or timestamped signatures — both need live
  OCSP/CRL/TSA endpoints, and a showcase must run offline and deterministically.
- No encryption, for the reason the original design gives: an encrypted file
  does not render in GitHub's inline PDF preview.
- No hand-authored structure on the twelve pre-existing sections. `AutoTag`
  covers them in one pass (see "Tagging order" below).

## Layout

Six new modules, one per section, following the established convention: each
exports a single `addXxx(...)` taking the `Page` it fills plus the `Document`
where it needs one.

```
_examples/feature-showcase/
  barcodes.ts        Barcodes & QR Codes
  layers.ts          Optional-Content Layers
  tagged.ts          Tagged PDF & Logical Structure
  htmlexport.ts      HTML Export
  compliance.ts      PDF/A · PDF/X · PDF/UA Validation
  signing.ts         Digital Signatures
  signcred.ts        run-time signer credentials (no checked-in secrets)
```

They append after *Rendering & Imposition* as a closing block, each with a
`DEST_*` constant and a `Section` entry in `main.ts`, so both the TOC and the
outline pick them up with no special-casing.

### Outputs

| Path | Written by | Contents |
|---|---|---|
| `docs/feature-showcase.pdf` | `main.ts` | the showcase, now tagged, unchanged name |
| `docs/feature-showcase.html` | `htmlexport.ts` | semantic (reflowable) export |
| `docs/feature-showcase-fixed.html` | `htmlexport.ts` | fixed export, fonts embedded as WOFF |
| `docs/feature-showcase-pdfa.pdf` | `compliance.ts` | `ConvertToPdfA('2b')` on an extracted copy |
| `docs/feature-showcase-signed.pdf` | `signing.ts` | certified + approval-signed copy |

Only the first is a committed artifact linked from `README.md`. The other four
are build products and go in `.gitignore`.

## The four self-contained sections

### barcodes.ts — Barcodes & QR Codes

A card grid over `page.AddBarcode`, with no document interaction at all:

- Code 128 (`text: true`, so the human-readable payload shows)
- EAN-13 and UPC-A — the check-digit symbologies, side by side
- EAN-8
- QR at `ecc: 'L'` and `ecc: 'H'` carrying the same payload, so the card labels
  can state the version each one needed
- one QR in `render: 'raster'` beside its `'vector'` twin — the `/ImageMask`
  stencil vs filled rectangles
- one Code 128 with a non-black `color` and `quietZone: false`

### layers.ts — Optional-Content Layers

A small floor-plan schematic drawn in three OCGs through
`PageGraphics.BeginLayer(layer)` / `EndLayer()`:

- **Walls** — always on
- **Furniture** — on, and a nested child layer under it via `AddLayer(name,
  { parent })`, so `/D /Order` has a tree rather than a flat list
- **Dimensions** — created `{ visible: false }`, so the viewer's layers panel
  has something to switch *on*

The Aspose logo binds to its own layer through `AddImage({ layer })` and a
Code 128 through `AddBarcode({ layer })`, showing the two non-vector binding
paths.

**Constraint to document in a comment, not work around:** text stamping
(`AddText`/`AddTextBlock`) takes no `layer` option — only `PageGraphics`
sequences, image XObjects, barcodes and annotation `/OC` bind to a layer. The
legend is therefore base content and stays visible whatever is toggled. Faking
it would misrepresent the API.

### htmlexport.ts — HTML Export

Writes both siblings and reports on them:

```ts
doc.ToHtml()                                        // semantic
doc.ToHtml({ mode: 'fixed', fonts: 'embed' })       // positioned
```

The page shows each output's byte size and a genuine excerpt of the emitted
markup (escaped and clipped to fit), and explains the split: semantic mode
reflows from the structure tree, fixed mode reproduces positioned pages and
inlines each embeddable font program as a base64 WOFF `@font-face`.

This section must run **after** tagging: `ToHtml` takes the tagged path the
moment `GetStructTree()` is non-null, and the semantic export is only worth
showing once there is a tree to reflow from.

### compliance.ts — PDF/A · PDF/X · PDF/UA Validation

Runs all three validators over the finished document and renders the findings
through the existing `createTable` authoring layer — rule, severity, count,
clause — from the real `ValidationReport`, never from a hard-coded list:

```ts
doc.ValidatePdfA('2b')
doc.ValidatePdfX('4')
doc.ValidatePdfUa()
```

**This document genuinely fails PDF/A-2b**, and the page says so in plain
words: the Standard-14 faces the showcase stamps with are not embedded, and
there is no `/OutputIntent`. Reporting a pass here would be a lie, and the
honest failure is the more useful demonstration — it is what a user's own first
run will look like.

Then `ConvertToPdfA('2b')` on a copy (`doc.ExtractPages(...)` — never the live
document, which still has to be saved unconverted) writes the sibling, and the
page reports which `ConvertAction`s the `ConversionReport` applied and which
issues it could not resolve.

## tagged.ts and the tagging order

`autoTag` appends into whatever tree already exists — `CreateStructTree()`
returns the existing root rather than clearing it — and it re-walks *every*
text block on every page. Hand-tagging first and auto-tagging after therefore
double-tags the same content, once by hand and once heuristically. The order
below is what avoids that, and the reason each step sits where it does:

`barcodes.ts` and `layers.ts` are filled early, with the other body sections,
precisely so the `AutoTag` pass covers them like any other page. Only the four
sections that *report on the finished document* have to be filled late.

```
… existing 12 sections, then barcodes + layers
  → per-page furniture (logo, watermark, footers)
  → render/imposition thumbnails
  → doc.Optimize()
  → doc.AutoTag({ lang: 'en-US', title: DOC_TITLE, alt })   ← one pass, whole doc
  → validate: PDF/UA + PDF/A + PDF/X
  → fill the tagged, compliance, html and signing pages
  → hand-tag those four pages (root.Append + MarkContent)
  → ToHtml siblings
  → WriteTo → verify → sign sibling
```

**`Optimize()` moves before tagging deliberately.** Its dedup pass merges
byte-identical streams; run after MCIDs are embedded it can fuse two pages'
content streams, and the `/ParentTree` then maps one page's MCIDs onto another's
content. Tagging adds little that recompression would have shrunk, so nothing is
lost by the reorder.

**The four late pages are hand-tagged because they are filled after the
`AutoTag` pass**, which is the honest consequence of a document that reports on
itself. That is not a workaround to hide — it is what demonstrates the authoring
API (`StructElement.Append` + `MarkContent`) beside the heuristic one, and it
cannot double-tag, because `AutoTag` has already run and does not run again.

The section page itself reports:

- the real `AutoTagReport` counts (headings, paragraphs, figures, artifacts,
  tables)
- an indented excerpt of the produced structure tree
- the `alt` callback's effect: images it described became `/Figure` with `/Alt`,
  images it returned `undefined` for became `/Artifact`

`AutoTag({ title })` also sets `/ViewerPreferences /DisplayDocTitle` — a title
alone does not satisfy PDF/UA unless the viewer is told to show it — so the
PDF/UA report improves visibly as a result of this section, which the compliance
page can point at.

## signing.ts and signcred.ts

Signing appends incrementally and the signed bytes must not be mutated
afterwards, so it runs **last, on the saved file**, never on the live document:

1. `Document.OpenFile('docs/feature-showcase.pdf')`
2. `Certify(signer, { permissions: 'form-fill', appearance })` — an author
   signature with a DocMDP transform and a visible appearance placed on the
   signature section page's reserved rect
3. `Sign(signer2, { reason, subFilter: 'PAdES' })` — a second, approval
   signature
4. `WriteTo('docs/feature-showcase-signed.pdf')`
5. re-open the sibling, `await VerifySignatures()`, print signer CN, byte-range
   coverage and the DocMDP verdict for each

Two signatures rather than one, because the second is what exercises the
incremental-append invariant: the first signature's bytes must survive verbatim
under the second. A single signature would not distinguish append from rewrite.

`signcred.ts` mints credentials at run time — an RSA keypair from `node:crypto`
plus a self-signed X.509 certificate assembled with the library's own DER
encoder (`src/asn1.js`), mirroring `test/helpers/build-signer.ts`. **No
checked-in secrets, ever**, and nothing to expire.

`Sign` and `Certify` are async, so `main.ts` gains top-level await. `target:
ES2022` + `module: NodeNext` already permit it; no config change.

The section page in the main (unsigned) document explains what the sibling
contains and leaves the visible-appearance rect empty with a caption — the main
artifact is deliberately not signed, since signing it would freeze it against
the regeneration the example exists to perform.

## Shared code

`vector.ts` already carries the card-grid frame plus a comment explaining the
two-pass z-order trap it hides: `PageGraphics` buffers until `apply()` while
`addText` appends to `/Contents` immediately, so every frame must be committed
before any label is drawn or the fills paint over the labels. `barcodes.ts` and
`layers.ts` both need that same grid.

Lift it into `theme.ts` as a `cardGrid(page, labels, opts)` returning the label
and inner boxes, and convert `vector.ts` to use it. This is a targeted
improvement to the code the new sections sit on top of — not general
refactoring, and nothing else in the example changes.

**Invariant the helper carries:** the frames commit in their own `apply()`
before any caller draws a label. Three sections now depend on that ordering, and
it is invisible in the output when wrong on only one of them.

## Verification

`verify.ts` gains a fifth assertion group, all against **re-opened bytes**, not
the live model:

- the barcode page's content stream drew ink for each symbology, and the raster
  QR produced an `/ImageMask` XObject
- `/OCProperties` carries the expected layers, the nesting appears in
  `/D /Order`, and exactly one layer is in `/D /OFF`
- `GetStructTree()` is non-null, `IsTagged` is true, `/Lang` is set, and the
  four hand-tagged pages each resolve to at least one structure element
- both HTML siblings are non-empty; the semantic one contains heading markup
  (proving it took the tagged path, not the fallback)
- the signed sibling's `VerifySignatures()` returns two reports, both with
  intact coverage and a valid DocMDP verdict

A failure throws, exactly as the existing checks do, so a regression stops the
build rather than producing a quietly wrong artifact.

## Testing

The example is not covered by vitest. Its gates are:

- `npm run typecheck` — `_examples` is in the tsconfig `include`, so this is a
  real gate on the new modules
- `npm run example:showcase` — must run clean, with `verify.ts` reporting all
  checks passed

Both must be green before the work is closed.

## Documentation

`README.md` gains the six new sections in the showcase's description, and the
sibling artifacts get a line each explaining what they are and that they are
build products.
