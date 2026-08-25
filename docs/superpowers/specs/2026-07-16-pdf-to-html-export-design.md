# PDF → HTML export (`doc.ToHtml` / `page.ToHtml`)

Issue: `aspose-pdf-foss-for-ts-hdx`

## Goal

A third output alongside SVG and PNG: HTML. Two modes behind one option — a
reflowable `semantic` mode that yields meaningful markup, and a `fixed` mode
that reproduces page appearance with positioned text over a vector backdrop.
Composition over new machinery: the export layer reuses the existing
interpreter, extractors, and table model. Zero runtime dependencies.

## Public API

```ts
export interface HtmlOptions {
  /** Reflowable semantic markup, or positioned page reproduction. Default 'semantic'.
   *  Phase 1 ships 'semantic' only; the union widens to include 'fixed' in Phase 2. */
  mode?: 'semantic' | 'fixed';
  /** Which page box defines the page size. Default 'crop'. `fixed` only. */
  box?: 'crop' | 'media';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
  /** Omit doctype/head/CSS and emit only the body markup. Default false. */
  fragment?: boolean;
  /** <title> text. Defaults to /Info /Title, else empty. */
  title?: string;
}

class Page     { ToHtml(options?: HtmlOptions): string }
class Document { ToHtml(options?: HtmlOptions): string }
```

Both return a **standalone HTML document** by default, mirroring the precedent
that `Page.ToSvg()` returns a standalone `<svg>`. `Page.ToHtml()` covers one
page; `Document.ToHtml()` covers all pages in one document. `fragment: true`
drops the shell and returns body markup only, for callers assembling their own
page.

`HtmlOptions` is exported from `index.ts` as a type.

### Relationship to the issue's original acceptance criteria

The issue reads *"tagged PDFs drive semantic structure …, untagged fall back to
positioned layout"*. That phrasing predates the mode split and is superseded:
mode is **explicit** and defaults to `semantic`. Tagged vs. untagged selects the
*source of structure* within semantic mode (StructTree vs. heuristics), not the
mode itself. `fixed` is what a caller asks for when they want positioned layout.
The bd acceptance criteria are updated to match.

## Modules

| File | Phase | Responsibility |
|---|---|---|
| `src/html.ts` | 1 | Entry points, document shell (doctype/head/CSS), escaping, mode dispatch |
| `src/htmlsemantic.ts` | 1 | Tagged StructTree walk; untagged heuristic fallback |
| `src/htmlfixed.ts` | 2 | `HtmlSink implements RenderSink` — SvgSink backdrop + positioned spans |
| `src/htmlfont.ts` | 2 | PDF font → CSS stack + weight + style; dedup into CSS classes |

Each is independently testable and depends only on existing exported models
(`TextRunInfo`, `TextBlock`, `Table`, `StructElement`).

`htmlfont.ts` is **Phase 2 only**: semantic mode emits no font styling at all.
CSS font mapping exists to place text in `fixed` mode; inlining per-run fonts
into semantic output would fight the reflowability that mode is for.

### Addition to `struct.ts`: `StructElement.Nodes`

The tagged walk must preserve the **interleaving** of an element's own text and
its child elements — a `Link` inside a `P` is ordinary. The existing public API
cannot express this: `Children` yields elements only and `ContentItems` yields
MCIDs only, so the order between them is lost and mixed-content text would be
dropped, failing the round-trip criterion. `struct.ts` already walks `/K` in
order privately via `kids()`; this exposes it in the form a renderer needs:

```ts
export interface StructTextNode { kind: 'text'; text: string; page: Page }
export type StructNode = StructElement | StructTextNode;

class StructElement {
  /** Direct kids in /K order: child elements and own text runs, interleaved.
   *  OBJR kids are skipped (no text contribution), matching GetText. */
  get Nodes(): StructNode[]
}
```

Each text node carries its own page, which is also what `Page.ToHtml`'s per-page
filtering keys on.

### Targeted lifts of existing private helpers

Two helpers are needed by a second consumer. Each is lifted to a shared home and
its original caller imports it back, so there is one implementation rather than
a copy:

- `deviceGray` → `src/colorspace.ts` (its natural home — it is a
  `ColorConverter`). It is **already** copy-pasted in `pagerender.ts` and
  `svgrender.ts`; the `imageHref` lift below would add a third copy. Consumers:
  `pagerender.ts`, `svgrender.ts`, `imagehref.ts`.
- `headingRanks` from `autotag.ts` → new `src/textrank.ts`, along with its
  `roundSize` and `dominantSize` collaborators. Ranks font sizes document-wide
  into body text vs. heading levels. Consumers: `autotag.ts`, `htmlsemantic.ts`.
- `imageHref` from `SvgSink` in `svgrender.ts` → new `src/imagehref.ts`.
  DCTDecode passthrough → `data:image/jpeg`; otherwise re-encode via `encodePng`
  / `pngDataUri`. Consumers: `SvgSink`, `htmlsemantic.ts`. This is a family of
  four coupled private methods — `imageHref`, `samplesToPng`,
  `isIndexedColorSpace`, `maskHref` — which all reach only for `this.doc`. They
  lift together as free functions taking `doc` as the first parameter; `SvgSink`
  keeps thin wrappers so its call sites are unchanged.

`SvgSink` itself is exported from `svgrender.ts` for `htmlfixed.ts` to wrap. It
is **not** re-exported from `index.ts` — it stays internal.

## Data flow — `fixed` mode

```
page → baseMatrix(box) → interpret(doc, page, sink, { annotations })
                              ↓
                         HtmlSink
                         ├─ save/restore/addClip/fill/stroke/image/shading → SvgSink (backdrop)
                         └─ glyphRun(info) → positioned <span>
```

`RenderSink.glyphRun` is the single text hook, so one `interpret()` pass yields
both layers: every non-text op is delegated to an internal `SvgSink`, and text
is diverted to HTML. Text is therefore never drawn twice, and no new
`SvgOptions` flag is required.

Per-page output:

```html
<div class="pg" style="width:612px;height:792px">
  <svg class="bd" viewBox="0 0 612 792">…</svg>
  <span class="f1" style="left:72px;top:70px">Quarterly Report</span>
</div>
```

The div is `position:relative` and sized to the selected box; the backdrop is
absolutely positioned at its origin; spans are absolutely positioned above it.
All lengths are CSS **px**, one per PDF unit — the `SvgSink` backdrop's viewBox
is unitless user-units rendered as px, so px is what keeps the text overlay
registered to the vector layer.

Span placement derives from `L = translate(0, rise) × tm × ctm` (the `ctm`
already folds in `baseMatrix`), whose translation part `(L[4], L[5])` is the
device-space baseline origin. `fontFamily`/`bold`/`italic`/`color` from
`TextRunInfo` resolve to a CSS class via `htmlfont.ts` (see below), and
`htmlfont` also supplies the **ascent ratio** used to convert the PDF baseline to
a CSS `top`:

- **Fast path** — axis-aligned, upright, uniform scale (`L[1]≈L[2]≈0`, `L[0]>0`,
  `L[3]<0`, `|L[0]|≈|L[3]|`): let `deviceSize = fontSize·|L[3]|`. Emit
  `left:L[4]; top:L[5] − ratio·deviceSize; font-size:deviceSize`. No transform —
  the clean case for the vast majority of runs.
- **General path** — rotation, skew, or non-uniform scale: emit
  `left:L[4]; top:L[5]; transform-origin:0 0;
  transform: matrix(L[0],L[1],−L[2],−L[3],0,0) translateY(−ratio·fontSize px);
  font-size:fontSize`. The inner `translateY` applies the baseline→top shift in
  the run's *local* space so it rotates with the text; the `−L[2]/−L[3]` sign
  flip is the same PDF-y-up → CSS-y-down flip `SvgSink.glyphRun` already uses. A
  rotated/skewed run is thus reproduced, never dropped.

Both paths match `SvgSink` in ignoring `hscale` for glyph *shape* (a pre-existing
backend limitation), keeping the two text backends consistent.

Images and vectors need no HTML-side handling: the backdrop already inlines
images as data URIs through the same `imageHref` the SVG backend uses.

## Data flow — `semantic` mode

### Tagged (`GetStructTree()` non-null)

Walk the `StructElement` tree in `/K` (reading) order, mapping `StandardType` to
a tag:

| Structure type | HTML |
|---|---|
| `P` | `p` |
| `H1`–`H6` | `h1`–`h6` |
| `L` | `ul` |
| `LI` | `li` |
| `Lbl`, `LBody` | inline content of the `li` |
| `Table` | `extractTaggedTables` → existing `Table.toHtml()` |
| `Figure` | `img` with `Alt` as `alt` |
| `Link` | `a` |
| `Span` | `span` |
| `Document`, `Part`, `Sect`, `Div` | `div` |
| unmapped / custom role | `div` |

`ActualText` overrides extracted glyph text. `EffectiveLang` emits a `lang`
attribute when it differs from the enclosing element's.

The structure tree spans pages, so `Document.ToHtml()` walks it **once** rather
than per page — an element crossing a page break stays a single element.

`Page.ToHtml()` on a tagged document walks the same tree but keeps only the
subtrees that contribute content to this page, using `StructElement.Page` (which
already resolves `/Pg` up the ancestor chain). An element with no page-bearing
content is pruned; an element spanning this page and others is emitted with only
this page's content. Ancestors of a kept element are retained so nesting
survives — a `P` inside a `Sect` stays inside its `Sect`.

### Untagged

Per page: `GetStructuredText()` blocks + `GetTables()` + reachable images.

- `headingRanks` maps each block's dominant font size to `h1`–`h3`, else `p`.
- Blocks whose quad center falls inside a table's quad are dropped in favor of
  that table's `toHtml()` (the `centerInside` test autotag already uses).
- Images become `<img src="data:…">`.

Pages concatenate in page order.

## Error handling

No new error types. An image whose filter cannot be decoded already causes
`imageHref` to return undefined, and `SvgSink` emits a placeholder rect; the
lifted helper preserves that behavior exactly, so an exotic-codec image degrades
to a placeholder rather than failing the export. Semantic mode skips such an
image rather than emitting a broken `<img>`.

`ToHtml` **never throws**, matching `renderPageToSvg`, which wraps `interpret`
in a `try`/`catch` and degrades to whatever was emitted before the failure. Both
modes take the same guarantee: a page that fails mid-walk contributes whatever
it produced, and the surrounding document shell is still well-formed.

## Testing

`test/html.test.ts`, with fixtures built programmatically by `test/helpers/`
builders in the existing style.

- **Untagged semantic**: blocks → `<p>`; a larger-size block → `<h1>`; a table →
  `<table>`; an image → `<img src="data:">`.
- **Tagged semantic**: `h1` / `p` / `ul`>`li` / `table` from the tree; `Alt` →
  `alt`; `ActualText` wins over glyph text; `lang` emitted.
- **Fixed**: span count and `left`/`top` match run positions; backdrop `<svg>`
  present; page div matches the crop box; a rotated run carries `transform`;
  text is not double-drawn.
- **Font mapping** (`htmlfont`): each generic family resolves to its stack,
  weight, style, and ascent ratio; identical `(family,weight,style,color)` tuples
  share one class.
- **Placement math**: fast-path `top`/`font-size` arithmetic against a known
  matrix (e.g. an upright run at a scale of 2 yields `deviceSize = 2·fontSize`
  and `top = L[5] − ratio·deviceSize`); a run with `L[1]≠0` takes the transform
  path.
- **Round-trip** (acceptance criterion): text content of `ToHtml` equals
  `GetText`.
- **Multi-page**: `Document.ToHtml({ mode: 'fixed' })` over 2 pages → 2
  `<div class="pg">` inside exactly one `<html>`.
- **Per-page tagged filtering**: on a 2-page tagged doc, `page[1].ToHtml()`
  contains page 2's elements and none of page 1's, with ancestor nesting intact.
- **Shell**: `fragment: true` omits the doctype; `&`, `<`, `>`, `"` escape
  correctly.
- **Regression**: existing `autotag` tests stay green after the `headingRanks`
  lift.

`npm run typecheck` and `npm test` must both be green before the issue closes.

## Delivery

Two phases against issue `hdx`, each independently reviewable and each producing
working software.

**Phase 1 — semantic mode.** `html.ts`, `htmlsemantic.ts`, `htmlfont.ts`, the
two helper lifts, `Page.ToHtml` / `Document.ToHtml`, tests, README. This alone
satisfies the acceptance criteria. Planned in
`docs/superpowers/plans/2026-07-16-pdf-to-html-semantic.md`.

**Phase 2 — fixed mode.** `htmlfixed.ts`, `htmlfont.ts`, `SvgSink` export,
`mode: 'fixed'`, tests. The baseline-placement open question is resolved below;
this phase gets its own plan. Until Phase 2 lands, `mode: 'fixed'` is not
accepted — passing it throws
`UnsupportedFeatureError`, and the option's type is narrowed to `'semantic'` so
the unimplemented mode is not reachable from the public type.

### `htmlfont.ts` — font mapping (Phase 2)

Input is the generic `fontFamily` (`serif`/`sans-serif`/`monospace`, already
derived in `pagerender.applyFontStyle`) plus `bold`/`italic` from `TextRunInfo`.
It emits a CSS font stack, weight, style, and — the piece unique to `fixed` mode
— a family-keyed **ascent ratio** for baseline placement:

| generic family | CSS stack | ascent ratio |
|---|---|---|
| `serif` | `"Times New Roman", Times, serif` | 0.836 |
| `sans-serif` | `Arial, Helvetica, sans-serif` | 0.846 |
| `monospace` | `"Courier New", Courier, monospace` | 0.756 |

`bold` → `font-weight:700`, `italic` → `font-style:italic`. Distinct
`(family, weight, style, color)` tuples dedup into CSS classes (`f0`, `f1`, …) in
the page `<style>`; `font-size` and position stay inline per span. The ascent
ratio keys on family only — the calibration below showed weight and style do not
change it.

### Resolved: text baseline placement

PDF positions text by its **baseline**; CSS positions a span by the **top of its
line box**, offset by the rendering font's ascent. `SvgSink.glyphRun` sidesteps
this because SVG `<text>` is baseline-anchored — HTML has no equivalent. With CSS
family mapping and no `@font-face`, the substitute font's ascent is not the PDF
font's, so no exact conversion exists; the placement is an approximation with a
bounded tolerance.

**Approach chosen:** `top = baseline − ascentRatio · size`, with `ascentRatio`
calibrated per font stack (table above). Calibration measured the DOM's own
baseline — a zero-size inline-block with `vertical-align:baseline` inside a
`line-height:1` box — so `ascentRatio = (baselineTop − boxTop) / fontSize` is
read exactly, with nothing eyeballed
(`_my/20260716/html-baseline-calibration.html`, throwaway harness).

**Measured (Chrome 150, Windows, dpr 1.25):** the ratio is size-independent —
the only variation (≤0.037em across 16/32/64/100 px) is device-pixel rounding —
and identical across regular/bold/italic. Generic `serif`≡Times New Roman
(0.836) and generic `sans-serif`≡Arial (0.846); generic `monospace` (0.824,
Consolas on this platform) differs from `Courier New` (0.756), so the export
names Courier New to match Std-14 PDFs faithfully and to pin a known ratio.

**Tolerance:** for a matched font (Windows/macOS ship all three) the baseline
lands within sub-pixel of intent. The worst case is a viewer lacking the named
font and falling back to a generic whose ascent differs — bounded by the ratio
gap (≈0.07em for monospace, <1px at body sizes). This residual drift is the
documented cost of not embedding font programs; `@font-face` embedding stays out
of scope (deferred follow-up).

## Out of scope

- `@font-face` embedding of font programs as data URIs. Deferred to a follow-up
  bd issue as an opt-in `fonts: 'embed'` once the export layer is proven; this
  spec ships CSS family mapping only.
- List reconstruction (`<ul>` / `<ol>`) from glyph positions in **untagged**
  semantic mode. Tagged lists are supported; untagged bullet detection is not.
- HTML → PDF (import). This is export only.
