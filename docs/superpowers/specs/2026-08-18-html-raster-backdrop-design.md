# Raster backdrop for HTML fixed mode (kf8h.2)

`doc.ToHtml({ mode: 'fixed' })` already emits real, styled, selectable text: one
`interpret` pass sends every glyph run to an absolutely-positioned `<span>` and
every other op to an internal `SvgSink`. The backdrop is therefore **vector**,
and glyph-less by construction — `HtmlSink.glyphRun` never forwards a run to the
SVG.

This adds a raster alternative to that backdrop, in the two forms Go ships.

## Why raster at all, when vector is higher fidelity

The SVG backdrop reproduces only what the interpreter and `SvgSink` can express,
and `README.md` already records where that falls short: a non-isolated group
that both composites as a unit and blends internally has no SVG expression;
knockout groups render as ordinary groups; JBIG2 becomes a gray placeholder in
`ToSvg` while rendering fully in `ToImage`. A raster is exact by construction for
all of it, and it bounds output size for a graphics-heavy page.

## What ships

Two raster backdrops, not one, because Go's two raster modes differ in what the
raster *contains* and that difference determines the text layer:

| `backdrop` | the backdrop holds | text layer | Go mode |
|---|---|---|---|
| `'vector'` | graphics as inline SVG | visible spans | `HTMLModeNative` |
| `'raster'` | graphics as PNG, **no glyphs** | visible spans | `HTMLModeText` |
| `'page'` | the whole page as PNG | **transparent** spans | faithful |

With `kf8h.3` closed as already-done, these three plus `mode: 'semantic'` cover
all four modes Go ships. The epic's "four modes" was a proxy for capabilities;
this is the last of them.

**Invariant: the text treatment is derived from the value, never chosen.** A
glyph-less backdrop needs visible text or the page has none; a full-page backdrop
needs transparent text or every glyph is drawn twice — once baked into the
raster, once by the browser with a substituted face, landing on different pixels.
The other two combinations are an invisible page and a double-drawn one, and a
single three-valued option makes both unrepresentable. Two orthogonal options
(`backdrop` plus `text`) would admit them and then need validation to fence them
off.

That double-draw is not hypothetical: `ToDocx({ mode: 'textbox' })` does exactly
it today, stacking visible frames over a full-page raster. Filed as `tvc4`,
deliberately not fixed here.

## Option surface

```ts
// HtmlOptions — 'fixed' mode only, like `box` and `fonts`
backdrop?: 'vector' | 'raster' | 'page';   // default 'vector'
backdropScale?: number;                     // default 2
```

`backdropScale` multiplies the 72-DPI point size and is passed to `ToImage` as
`scale`. Default 2 so a page is crisp on a HiDPI display at 100% zoom, the size
at which a fixed-mode page is actually read. Everything else `ToImage` takes is
already determined and must not be stated twice: `box` and `annotations` are
existing `HtmlOptions`. `width`/`height` are deliberately not exposed — they let
a caller produce a raster whose aspect ratio does not match the page.

`ImageOptions.background` is `'white'` for **both** raster modes. `.pg` already
paints `background:#fff`, so an RGBA PNG would carry an alpha channel that every
pixel of the page div sits behind anyway — larger bytes for an invisible
difference.

### The name, and a rename

`backdrop`, not `background`. `ImageOptions.background` already means
`'white' | 'transparent'` and `DocxOptions.background` means `'none' | 'raster'`;
a third meaning on `HtmlOptions` would give one key three unrelated meanings
across three bags that callers mix in the same file. Unlike the
`MarkdownExportOptions`/`MarkdownOptions` case `CLAUDE.md` records, these are
different types, so nothing would catch a mix-up at compile time.

`backdrop` is also already this codebase's word for the thing: `htmlfixed.ts`
documents `HtmlSink` as painting onto "an internal `SvgSink` backdrop", and
`docxtextbox.ts`'s field is literally `backdrop?: { rid }`.

So the key is renamed everywhere it means this:

- `HtmlOptions` gains `backdrop`.
- `DocxOptions.background` → `backdrop`, and its values `'none' | 'raster'` →
  `'none' | 'page'`. The value rename follows from the key rename rather than
  being extra churn: leaving it as `'raster'` would make `backdrop: 'raster'`
  mean *glyph-less* in HTML and *full page* in DOCX — the same key and the same
  value meaning two different things, which is the collision being removed.
- `ImageOptions.background` is untouched. That one genuinely is a background
  colour.

Both DOCX changes are breaking and land together. The package is `0.0.0`.

## Architecture

`fixedBody`'s existing `interpret` pass is untouched, and the spans come from it
in all three modes — the issue's "do not rebuild `HtmlSink`'s span emission" is
respected literally. A raster mode adds a **second, independent** pass through
the rasterizer, then emits an `<img>` data URI in place of the `<svg>`.

Two passes rather than one fused pass, matching what `docxexport.ts` already does
with `page.ToImage`. Fusing them would mean teaching one sink to emit both
markup and pixels, which is the coupling `htmlfixed.ts`/`svgrender.ts` and
`svgdraw.ts`/`svgembed.ts` are both structured to avoid. The cost is one extra
interpretation of the page's content per raster page, paid only when a raster
backdrop is asked for.

**The backdrop replaces the SVG; it never layers over it.** Two backdrops is
double the bytes for one picture.

### Glyph suppression

`raster.ts` gains one export:

```ts
export function renderPageGraphicsToPng(
  doc: Document, page: Page, opts: ImageOptions,
): Uint8Array
```

Identical to `renderPageToPng` except that `RasterSink.glyphRun` short-circuits.
A separate entry rather than an `ImageOptions` flag, following the precedent of
`renderFormToRgba` — which exists in the same file to serve exactly one caller
(`svgembed.ts`'s `SvgRasterSink`). `ImageOptions` gains nothing and `page.ToImage`
is unchanged.

**Note:** `interpret` composites annotation `/AP` streams, so a `/FreeText`
annotation's glyphs are suppressed from the raster *and* emitted as spans. The
two layers stay consistent with no special handling — but this also means the
suppression must live in the sink, not in a pre-pass over page content, which
would miss them.

### Assembly

`sink.finish()` must yield the SVG and the spans separately so a raster mode can
drop the former. Per page:

```html
<div class="pg" style="width:Wpx;height:Hpx">
  <img src="data:image/png;base64,...">      <!-- raster modes only -->
  <span class="f0" style="left:..;top:..">…</span>
</div>
```

`FIXED_CSS` gains `.pg>img{position:absolute;left:0;top:0;width:100%;height:100%}`
so the raster scales back to point size whatever `backdropScale` was. For
`'page'`, the page div is `<div class="pg sel">` and `FIXED_CSS` gains
`.sel>span{color:transparent}` — one extra class and one extra rule, emitted
only in that mode. Transparent text remains selectable and findable by the
browser's own Find — which is the entire reason the mode exists rather than
handing the user `page.ToImage()`.

## Error handling

**Invariant: a page that fails to rasterize falls back to `'vector'` — both
raster modes, one rule, per page.**

`docxexport.ts` degrades by dropping the backdrop and keeping the text, which is
right there. Copying it here would be wrong: in `'page'` mode the text is
transparent, so dropping the backdrop leaves a *blank page*. Falling back to
vector restores the backdrop and the visible text together, which is why the
fallback is stated as one rule rather than as "skip the image".

This costs nothing to arrange, because the vector backdrop is produced by the
`interpret` pass that has already run by then.

## Testing

- **Fence.** `backdrop` absent produces byte-identical output to today. This is
  the assertion that the feature is additive; it is a fence, not a golden.
- `'raster'`: one `<img>`, no `<svg>`, spans present and not transparent.
- **The glyph-less claim, measured rather than trusted.** Render the same page
  through both entries and compare a pixel *inside a glyph's own quad* — taken
  from `GetTextFragments`, not guessed. Asserting only that the two PNGs differ
  would pass if the flag changed anything at all; asserting the pixel is the
  background colour is the claim itself.
- `'page'`: spans carry the transparent rule, and the PNG *does* contain the
  glyphs — the same pixel probe, inverted. One fixture, two opposite assertions,
  which is what stops the two modes being confused for each other.
- Degrade: a page that throws during rasterization comes back as vector with
  visible text. The assertion is that the page is not blank — the failure mode
  the rule exists to prevent.
- DOCX: the rename is mechanical, but `test/docx-textbox*.test.ts` must be
  re-pointed and the `'page'` value asserted, so a stale `background: 'raster'`
  is a compile error rather than a silently ignored key.

## Out of scope

- The text half: `HtmlSink`'s span emission, `htmlfont.ts`, `htmlfontembed.ts`.
- `tvc4`, the DOCX double-draw. This spec renames its option; it does not change
  its semantics.
- `kf8h.1` (fillable form controls) and `kf8h.4` (vertical writing), which are
  the epic's other two children.
