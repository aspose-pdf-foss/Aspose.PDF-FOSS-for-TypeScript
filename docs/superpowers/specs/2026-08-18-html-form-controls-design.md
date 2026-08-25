# Fillable HTML form controls (kf8h.1)

`doc.ToHtml({ mode: 'fixed' })` reproduces a page's appearance, and an AcroForm
widget currently reaches it the same way every other annotation does: `interpret`
composites its `/AP` stream, so a text field arrives as painted pixels and a
`<span>` of its value. Nothing in `html*.ts` knows a widget from a stamp.

This makes them real controls. It is the last of `kf8h`'s capability gaps after
`kf8h.2`; the reference is Go's `html_export_forms.go`, whose README bar is
"real fillable HTML controls", explicitly contrasted with Aspose rendering them
as static pictures.

## Option surface

```ts
// HtmlOptions — 'fixed' mode only
forms?: boolean;   // default false
```

Default `false`, so every existing caller's output is byte-identical.

`mode: 'semantic'` with `forms: true` **throws**. Reflowable output has no widget
geometry to place a control at, and accepting an option that cannot be honoured
is the silent-acceptance trap `textedit.ts` already guards against with
`region`.

**Divergence from Go, deliberate:** Go restricts `InteractiveForms` to
`HTMLModeText`/`HTMLModeNative` — our `backdrop: 'raster'` and `'vector'` — and
refuses it in faithful mode, because a full-page raster has the widget baked in.
Here it works with **all three** backdrops, including `'page'`. That restriction
is a property of Go's rasterizer, not of the format: our raster pass is ours to
parameterize, so the same suppression set that hides a widget from the vector
sink hides it from the raster.

## Architecture

### `htmlforms.ts` — pure, and emits no ink

```ts
export function pageFormControls(
  doc: Document, page: Page, form: Form, nextTabIndex: () => number,
): { html: string; converted: Set<PdfDict>; submits: boolean }
```

It returns the markup, **the widget dicts it claimed**, and whether it converted
a submit or reset button — the last so the caller knows whether to emit the
`<form>` envelope without re-walking the fields.

`nextTabIndex` is injected rather than counted internally because tab order runs
across the document while this function sees one page, the same shape
`docxtextbox.ts` uses for `nextDrawingId`. It touches no
renderer, no sink and no content stream — the split `svgdraw.ts`/`svgembed.ts`
and `runlink.ts`/`stamp.ts` already make, and the reason this can be tested from
a built document without rendering anything.

`Field.widgets()` is `protected` today and becomes a public `Widgets` accessor.
The alternative is for this module to re-derive "a merged field/widget dict is
its own widget, otherwise the resolved `/Kids`" — a rule `CLAUDE.md` already
records as easy to get wrong, and two copies of it is how the two come to
disagree about one document.

### Suppression: one set, two sinks

`converted` is the whole double-draw defence, and it must reach both renderers.

- **`interpret`** gains `hideWidgets?: ReadonlySet<PdfDict>`, which `drawAnnots`
  skips. This covers the vector backdrop *and* the text spans in one move: a
  widget whose `/AP` is never drawn never reaches `HtmlSink.glyphRun` either, so
  the field's value cannot arrive as both a `<span>` and a control `value`.
- **`raster.ts`** grows one internal entry that both backdrop kinds go through:

```ts
export function renderPageBackdropToPng(
  doc: Document, page: Page, opts: ImageOptions,
  o: { skipGlyphs: boolean; hideWidgets?: ReadonlySet<PdfDict> },
): Uint8Array
```

`renderPageToPng` and `renderPageGraphicsToPng` become thin wrappers over it, so
`page.ToImage` and `ImageOptions` still do not change. `htmlfixed.ts`'s current
`page.ToImage(img)` call for `backdrop: 'page'` is replaced by this, which is a
simplification in its own right: both backdrops route through one function
instead of two that could drift.

**Invariant: suppression is per WIDGET, not per page.** A field that fails to
convert keeps its appearance, so the page never shows a hole where a control
should be.

### Ordering

`pageFormControls` runs **before** the `interpret` pass, because the pass needs
the suppression set. Controls are emitted **after** the spans in the page div, so
they stack above the backdrop and the text and can actually be clicked.

## The mapping

| PDF field | HTML |
|---|---|
| text | `<input type="text">`, `type="password"` when `/Ff` Password, `<textarea>` when Multiline; `maxlength` from `/MaxLen` |
| checkbox | `<input type="checkbox" value="ExportName">`, checked from `/AS` else `/V` |
| radio | one `<input type="radio">` per widget, sharing the field's `name`; `value` is that widget's non-`Off` `/AP /N` key |
| choice | `<select>` with an `<option>` per entry; an editable combo (`/Ff` Edit) becomes `<input>` + `<datalist>` |
| pushbutton | `<button type="submit">` or `type="reset"` **only** when `/A` parses as SubmitForm or ResetForm; any other push button keeps its appearance and is not in `converted` |
| signature | `<input type="text" disabled>` — see below |

**Invariant:** `/Opt` is read through `choiceopt.ts`'s `choiceEntries`, never
inline. An entry may be a plain string or an `[export, display]` pair, `/V` holds
the **export**, and `CLAUDE.md` records that every consumer which re-derived that
grammar got one of the two halves wrong — a list box highlighting nothing, a
combo drawing the export value. The `<option>`'s `value` is the export and its
text is the display.

**Invariant:** a radio widget's `value` comes from its own `/AP /N` key set,
never from `synthOnState`. That helper guesses an on-state for documents we did
not author and reads `/AS`, `/Opt`, `/V` and finally `'Yes'`; here the widget is
in front of us and its appearance dictionary states its on-state outright.

Attributes: `required` and `readonly`/`disabled` from `/Ff`, `name` from
`FullName`, and `tabindex` from a counter running across the **whole document**
in page order then `/Annots` order. Per-page indices would restart at each page
and interleave the tab order of a multi-page form.

### Signature fields

Converted, unlike Go, which leaves them painted. A signature cannot be *filled*
in a browser, so the control is `disabled`: it takes part in tab order and is
announced by a screen reader, and it promises nothing the page cannot keep.

A signed field shows its signer and signing date, read from `/V /Name` and
`/V /M` — the two keys `signature.ts`'s `buildSigValueDict` writes — with `/M`
parsed by `metadata.ts`'s `parsePdfDate`, which returns the raw string when it
cannot parse, so a malformed date degrades to showing itself rather than
throwing. An unsigned field shows nothing. Both carry an `aria-label` naming the
field and its state, so the two are distinguishable without sight.

Note this reads the signature *dictionary*, not `sigverify.ts`: the label states
what the document claims, and running verification during an HTML export would
make the output depend on trust stores and network-fetched revocation data.

A `<input type="file">` was rejected: a static exported page has nothing to
receive an upload, so it would offer an action that silently does nothing.

### The `<form>` envelope

A document-level `<form>` wraps every page div, and **only** when a submit or
reset button was actually converted — which is what `submits` reports, page by
page, OR-ed across the document. `action` and `method` come from the
SubmitForm action — via `actions.ts`, which `CLAUDE.md` records as the single
owner of the action grammar, and where a SubmitForm `/F` is a `/FS /URL` filespec
rather than a bare string.

One form for the whole document rather than one per page: a PDF's AcroForm is
document-scoped, a field's widgets may sit on different pages, and per-page forms
would submit a fragment of the field set.

## Styling

Suppressing `/AP` removes the field's painted border and background, so the
control supplies them:

| source | CSS |
|---|---|
| `/Rect` | `left` / `top` / `width` / `height`, in pt |
| `/MK /BC` | `border-color` (absent → no border) |
| `/MK /BG` | `background` (absent → transparent) |
| `/BS /W` | `border-width` (absent → 1pt when `/BC` is present) |
| `/DA` | `font-family`, `font-size`, `color`, via `resolveDA` |

`resolveDA` already resolves `/DA` with its `/AcroForm` fallback, and
`fieldstyle.ts` already owns the `/MK`+`/BS` vocabulary — this reads existing
parsers rather than adding any.

**Invariant:** a `/DA` font size of **0** means auto-size and must not become
`font-size:0`. It becomes a size derived from the widget's height, which is what
the PDF's own appearance generator does with it.

## Error handling

**Invariant:** a field that throws mid-conversion is dropped from `converted` and
contributes no markup, so its `/AP` still renders. Never leave a hole where
content used to be — the rule `kf8h.2`'s degrade already follows, and the reason
`converted` is built by the same pass that builds the markup rather than being
predicted from the field list.

`ToHtml` continues never to throw on document content. The one throw this adds
is an **option** error, raised before any rendering: `forms: true` with
`mode: 'semantic'`.

## Testing

- **Fence:** `forms` absent is byte-identical to today, in all three backdrops.
- One case per field type, asserting the element *and* its attributes.
- **The double-draw guard, and the sharpest test here:** a converted text field's
  value must appear exactly **once** in the output — in the control's `value`,
  never also as a `<span>`. Asserting only that the control exists would pass
  with the appearance still drawn behind it.
- `backdrop: 'page'` with `forms: true`: the control is present *and* the field's
  value is absent from the raster, by the pixel probe `kf8h.2` established —
  which is the only assertion that can see into a baked backdrop.
- An unconvertible push button keeps its appearance: it is absent from the
  markup and its ink is still drawn.
- `mode: 'semantic'` with `forms: true` throws.
- The `<form>` wrapper appears only with a submit/reset button, and is absent for
  a document of plain fields.

## Out of scope

- JavaScript actions on fields (`/AA`), which would need a scripting engine.
- Field appearance *regeneration* — `GenerateAppearances` is unrelated and
  untouched.
- `tvc4`, the DOCX double-draw, which is the same class of defect in another
  export and is tracked separately.
