# Inline `<svg>` through the existing SVG importer — design

**Issue:** `zch2.12` — `zch2.7` suppresses an inline `<svg>` subtree and reports
it as `dropped`. This renders it instead.

**Goal:** an inline `<svg>` draws through `svgembed.ts`, and what the importer
could not render folds into the same `skipped` report the rest of the HTML
stack uses.

## What the issue got right, and what it got wrong

**Right — the seam is the established one.** `cssflow.ts` may not import
`document.js`, so it takes an injected function. This is the THIRD instance:
`resolveImage` (`zch2.6`), `makeFloat` (`zch2.10`), `renderSvg` (here).

**Wrong — "the importer already exists" understates the gap, and this is the
crux.** `addSvgObject` takes `data: Uint8Array` — SVG SOURCE BYTES — and
`svgdraw.ts` walks an `xml.ts` `XmlNode` tree. The HTML parser produced
`HtmlElement`s. There is no path between them, and `src/` has NO DOM-to-markup
serializer; the only tree serializer in the repo is
`test/helpers/wpt-tree.ts`, which emits the html5lib debug format rather than
markup. Rendering through the existing importer therefore requires
RE-SERIALIZING the subtree, which the issue treats as free.

**Wrong — the report cannot be folded without splitting `svgembed.ts`.** The
issue frames folding as a presentation choice. It is a TIMING problem: the
importer reports what it could not draw only when it draws, and
`flow.AddHtml` hands `skipped` back BEFORE `Render()` runs — the structural
limit `zch2.14` hit. Folding is possible only if the import happens at BUILD
time, which needs an entry that takes a `Document` and no `Page`.

**Not named — the serializer has to undo two HTML-parser adjustments**, and
both are silent when missed. See below.

**Not named, and MEASURED WRONG in this design's own first draft:** a
viewBox-only `<svg>` FILLS the available width in a browser. The
recommendation here originally argued the opposite — that a sizeless inline
SVG is "a small fixed box" and filling the column "would render conspicuously
wrong". Chrome 152 says otherwise, and the correction is recorded because the
wrong rule was one approval away from being specified.

## Decisions

1. **Serialize the subtree to markup** and feed the existing `addSvgObject`
   path, so the whole importer — paths, gradients, masks, filters, text — is
   reused with no edits to what it does.
2. **Fold both importer lists into `NotRendered`** under `construct: 'svg'`,
   with `kind` carrying the difference. The closed 20-name vocabulary does not
   grow and no exhaustive `switch` breaks.
3. **Size CSS-first, measured against Chrome** (table below).
4. **Split `svgembed.ts`** along the line it already has, so the import runs at
   BUILD time and decision 2 is reachable at all.

## Architecture

### Where suppression ends

`cssbox.ts:292` asks `elementPolicy`, which returns `suppress`/`dropped`/`svg`
for the SVG namespace, pushes the record and returns a box with NO content.
That is the line this replaces. `elementPolicy` keeps `math` and `iframe` and
loses `svg`; `cssbox.ts` gains an `svg` box kind carrying the element, so the
subtree survives the box walk.

**Invariant:** the ELEMENT survives, not its text. The leak `zch2.7` closed —
SVG `<text>` arriving in the paragraph flow as body text — stays closed,
because the subtree becomes a replaced box rather than inline content.

### The serializer — a new pure leaf over `htmldom.js`

`<svg>` subtree in, XML markup out. It must undo exactly what the parser did:

**Invariant:** an adjusted foreign attribute carries a DISPLAY key with a
SPACE. `htmlforeign.ts:87` stores `xlink:href` as `xlink href`. Emitted
verbatim that is not a name `parseXml` can read, so the map is inverted on the
way out.

**Invariant:** element and attribute names are ALREADY case-adjusted
(`linearGradient`, `viewBox`) and are emitted as stored. Lower-casing them —
the obvious defensive move when writing XML from an HTML DOM — breaks every
gradient and every viewBox.

Beyond that: attribute values escaped and quoted, text nodes escaped, elements
self-closed.

**Note, and it is a real benefit rather than a hazard:** `parseXml` is STRICT —
it throws `PdfParseError` on a mismatched end tag or an unquoted value — so the
serializer's output is validated by the thing that consumes it.

**Invariant:** failure is a VALUE. A subtree that will not serialize, or markup
`parseXml` rejects, reports `svg`/`dropped` and renders nothing — which is the
behaviour it has today, so the worst case is no worse than the status quo.

### The `svgembed.ts` split

Everything up to and including `doc.allocObject` (`svgembed.ts:51`) touches only
the `Document`; only what follows touches the `Page`.

```ts
buildSvgForm(doc, data, size: [w: number, h: number], opts):
  { ref: PdfObject; skipped: string[]; rasterized: string[] }
```

`addSvgObject` becomes that call plus its existing page attachment.

**Invariant, and this design's FIRST DRAFT GOT IT BACKWARDS:** the builder takes
a SIZE, not a rect, and emits at the ORIGIN. `placementMatrix`
(`svgtransform.ts:156`) bakes the rect's `rx`/`ry` into the matrix it returns,
so a form built before its position is known cannot be handed a rect — there is
no x or y yet. Section 2 of the approved design said the rect "goes to the
builder … it is not a placement argument", which is exactly wrong: the viewBox
FIT needs only `w`/`h`, and the position is a translate. Recorded because the
wrong version reads perfectly plausibly.

`addSvgObject` therefore composes the translate — and the clip to the rect,
which is likewise page-side — around a form built at the origin.

**Invariant:** `addSvgObject`'s SIGNATURE and BEHAVIOUR do not move. Its emitted
bytes MAY: a matrix with `rx`/`ry` baked in becomes an origin matrix plus a
`cm` translate, which composes to the same placement. That is where this change
could disturb the importer, so its own suite and
`test/fixtures/svg/` are the fence, and a golden that moves must be shown to
compose identically rather than accepted.

### The seam, and why build time is the whole point

`cssflow.ts` gets `renderSvg` injected through `CssFlowOptions`, supplied by
`htmlflow.ts` closing over the `Document`. Omitted, an inline `<svg>` reports
as it does today, which keeps the leaf independently testable.

Calling it while MAPPING the box means the importer's `skipped` and
`rasterized` are in hand before `AddHtml` returns its report. At paint time
they could not reach it, and `doc.AddHtml` would report where `flow.AddHtml`
stayed silent — the divergence `zch2.5` exists to prevent.

### The fold

One record per importer finding: `construct: 'svg'`, `el` the inline `<svg>`,
`detail` the element name the importer named. `kind` is `dropped` when nothing
rendered and `degraded` for a skipped gradient AND for a rasterized subtree.

**Invariant, and it is a judgement rather than a mapping:** rasterization is
`degraded`. The importer is explicit that it is not a fidelity loss — the
content draws correctly — but it is resolution-bound and its text stops being
extractable, which is exactly "drawn, but not as the source specified". Calling
it a clean render hides a real consequence from a caller about to extract text.

## Sizing, measured against Chrome/152.0.7977.54

| markup | used size |
|---|---|
| `<svg viewBox="0 0 100 50">` in an 800px container | **800 x 400** |
| `<svg>` — no viewBox, no size | 300 x 150 |
| `<svg width="120" height="60" viewBox="0 0 100 50">` | 120 x 60 |
| `<svg viewBox="0 0 100 50" style="width:200px">` | 200 x 100 |
| `<svg width="40%" viewBox="0 0 100 50">` in 800px | 320 x 160 |

The rule: a stated CSS `width`/`height` wins; else the element's own
`width`/`height` attributes, percentages resolving against the containing
block; else, with a `viewBox` to give an aspect ratio, FILL the available width
and take the height from it; else 300 x 150.

**Invariant:** the px -> pt `x 0.75` crosses in `cssflow.ts` and nowhere else,
as it does for every other box.

## Testing

- The serializer from hand-built DOM: the `xlink href` inversion, preserved
  camelCase, escaping, and a ROUND TRIP through `parseXml`, which is the real
  check since the consumer validates the output.
- `buildSvgForm`'s extraction verified by `addSvgObject`'s EXISTING tests not
  moving.
- End to end: an inline `<svg>` draws; all three entry points agree; a skipped
  gradient and a rasterized filter each land as an `svg`/`degraded` record with
  the right `detail`.
- The five sizing rows become fixtures in the headless-Chrome box corpus, which
  makes the table above a fence rather than a note in a commit message.
- **Fences that must not move:** `rich-runs-identity`, `html-identity`, and the
  SVG importer's own suite.
- Every new rule gets a mutation check; anything uncovered is RECORDED.

## Stated limits

- **`<math>` stays suppressed and reported.** There is no MathML importer here.
- **An `<svg>` sharing a line with text is out of scope** — that is `zch2.11`'s
  atomic path.
- **A filtered subtree still rasterizes**, with the consequences the importer
  already documents.

## Module list

The serializer earns its CLAUDE.md entry when it lands, per the module-list
rule.
