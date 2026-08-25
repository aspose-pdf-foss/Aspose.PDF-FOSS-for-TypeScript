# Nested `image/svg+xml` payloads in SVG `<image>`

Issue: `1gg0.22` (epic `1gg0` — page-furniture & text-authoring parity gaps).
Deferred from `1gg0.9` (SVG `<image>` embedding).

## Problem

An `<image>` whose payload is an SVG renders nothing today. The bytes decode
fine, but `buildImageXObject` sniffs them for PNG/JPEG magic numbers, fails, and
the element is reported in `result.skipped`. An SVG is not a raster, so it needs
a different destination: a nested Form XObject drawn by the same walker.

`1gg0.21` shipped `opts.resolveImage`, so the bytes can now arrive from two
places — a `data:` URI or the caller — and both must be able to carry an SVG.

## Decisions

**A payload type, not a `BuiltImage`.** `decodeImage` returns a built raster or
nothing, which cannot express "these are SVG bytes". `svgimage.ts` gains

```ts
export type ImagePayload =
  | { kind: 'raster'; built: BuiltImage }
  | { kind: 'svg'; bytes: Uint8Array };

export function decodePayload(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): ImagePayload | undefined
```

over the same two-source lookup `decodeImage` already performs: the `data:` path
first, the resolver as the fallback. So a caller resolving `logo.svg` out of a
map gets it drawn as vector, which is the obvious expectation once both features
exist.

`decodeImage` is left exactly as it is and remains what `feImage` calls. A
filter primitive rasterizes its input, so nesting a vector document there is a
different feature; an SVG payload in an `feImage` keeps reporting as it does
today.

**Sniff for SVG before attempting a raster build.** Skip a UTF-8 BOM and any
leading whitespace; if the next byte is `<`, treat the bytes as XML. PNG and
JPEG magic numbers are unambiguous and never begin with `<`, so the order is
safe, and testing for `<` rather than for a literal `<svg` accepts the XML
declarations, DOCTYPEs and comments real files carry. Whether the root element
is actually `<svg>` is settled after parsing.

**`Emitter.subdoc()`, distinct from `child()`.** This is the heart of the
change. A nested SVG is a separate *document*, not a forked stream, and
`child()` shares precisely the state that must not cross a document boundary:

| Shared by `child()` | Why a nested document must not share it |
|---|---|
| `ids` | An outer id would satisfy a nested `url(#…)`, and vice versa. |
| `css` | The outer stylesheet would style nested elements. |
| `markerForms` | Keyed `${id}\|${strokeWidth}` — an outer and a nested `#arrow` collide and the wrong marker is drawn. |
| `active`, `activePatterns`, `activeMasks`, `activeMarkers` | Id-keyed cycle guards; an outer id in flight would suppress an unrelated nested one. |

`subdoc()` gives all of those fresh, plus its own `viewport` (the nested
viewBox). It shares only what is genuinely document-wide: `streams`,
`imageSink`, `fonts`, `raster`, `resolveImage`, `images` (href-keyed), `masks`
(content-keyed), and `skipped` / `rasterized` — a loss inside a nested SVG is
still a loss in the outer result.

**Depth guard.** An `svgDepth` counter on `Emitter`, incremented by `subdoc()`,
refusing past **4**. A `data:` URI cannot reference itself, so nesting is
already bounded by the input's length; the guard exists against pathological
input and unbounded stack growth, not against a true cycle.

**Placement: the nested viewBox wins.** The `<image>` element's `x`/`y`/`width`/
`height` establish a viewport, and the nested SVG's own `viewBox` +
`preserveAspectRatio` map its content into it through `viewBoxFitDown` — the
same call `<pattern>` and `<marker>` viewports already use, translated by the
element's `x`/`y`. One fit, applied once. The `<image>`'s own
`preserveAspectRatio` is not consulted when the payload has a viewBox.

The alternative — treating the payload's size as intrinsic, running
`imagePlacement` so the `<image>`'s `preserveAspectRatio` picks a sub-box, then
fitting the viewBox into *that* — applies a fit twice and needs both code paths.

**Always clip to the image rect.** An `re W n` around the `Do` in the parent
stream. A new viewport clips by default, and under `slice` the content is scaled
past the rect while still lying inside the viewBox, so the form's `/BBox` alone
would let it spill.

## Changes

### `svgimage.ts`

Add `ImagePayload`, `decodePayload`, and a module-private `looksLikeXml(bytes)`.
`decodeImage` and `tryBuild` are untouched.

### `svgdraw.ts`

- `Emitter` gains `svgDepth = 0`, `svgForms = new Map<string, PdfObject>()`
  (href → the nested form's ref, shared like `images`), and a `subdoc()` method.
- `child()` copies `svgDepth` and `svgForms` like every other shared field.
- `drawImage` switches on `decodePayload`: the raster branch is today's code, the
  svg branch builds or reuses a nested form and places it.
- A new `nestedSvgForm(e, bytes)` builds the form: parse, check the root, walk
  into a `subdoc()`, emit through `e.streams`.

### Failure modes

All report `skipped: ['image']` and draw nothing, consistent with today:

- `parseXml` throws (malformed payload) — caught, because one bad payload must
  not abort a 200-element placement.
- The root element is not `<svg>`.
- `svgDepth` would exceed 4.

### Deliberately unchanged

`filterPx` is copied unchanged into a `subdoc()`, exactly as `child()` already
does for pattern tiles and marker forms. A `<filter>` inside a nested SVG
therefore rasterizes at the outer placement's scale rather than the fitted one.
That approximation predates this change and widening the change to fix it is out
of scope.

## Testing

`test/svg-image.test.ts` (unit, no Document) — the payload sniff:

- SVG bytes yield `{ kind: 'svg' }`; PNG bytes yield `{ kind: 'raster' }`.
- A UTF-8 BOM, leading whitespace, an `<?xml …?>` declaration and a comment
  before `<svg` all still sniff as svg.
- Bytes that are neither yield `undefined`.
- A resolver may supply SVG bytes, not only a `data:` URI.

`test/svg-embed-image.test.ts` (integration through `AddSVGObject`):

- A nested `data:image/svg+xml` payload draws as a Form XObject with the `cm`
  that `viewBoxFitDown` predicts, and `skipped` is empty.
- A resolver-supplied SVG payload does the same.
- **Id collision**: the outer document and the nested payload both define `#g`,
  with different content; the nested reference must draw the *nested* one. This
  is the test that proves `subdoc()` rather than `child()`.
- A nested payload's own losses surface in the outer `skipped`.
- Depth exhaustion reports `['image']` and draws nothing.
- A malformed payload, and a payload whose root is not `<svg>`, each report
  `['image']`.
- Two elements sharing one nested href allocate one form.
- Under `slice`, the clip rect is emitted.

Then the mutation pass CLAUDE.md requires — each targets a failure that is
invisible in ordinary use:

- Use `child()` instead of `subdoc()` → the id-collision test must go red.
- Drop the depth guard → the depth test must go red.
- Drop the `re W n` clip → the slice test must go red.

## Documentation

`README.md`: the `<image>` paragraph currently says a payload that is not
PNG/JPEG, "including `image/svg+xml`", is reported. That clause is now wrong and
must describe the nested rendering, the depth cap, and the fact that the nested
viewBox governs the fit. The `AddSVGObject` API-table row needs the same.
