# SVG `<image>` embedding — design

Issue: `aspose-pdf-foss-for-ts-1gg0.9` (epic `1gg0`, page-furniture &
text-authoring parity gaps). Date: 2026-07-30. Deferred from `1gg0.3`.

## Scope

`page.AddSVGObject` reports `image` in `skipped` and paints nothing where an
`<image>` sits. v1 embeds one whose `href` is a **`data:` URI** carrying a PNG or
JPEG, through `imageembed.ts`, covering:

- **The href** — `data:[<mediatype>][;base64],<payload>`, base64 or
  percent-encoded. `xlink:href` needs no separate handling: `xml.ts` strips
  namespace prefixes, so it arrives as `href` (the same reason `<use>` reads only
  `href`).
- **Geometry** — `x`, `y`, `width`, `height`, and `preserveAspectRatio` (the nine
  align keywords × `meet` / `slice` / `none`).
- **Inherited context** — `transform`, `clip-path` and group `opacity`, all of
  which `walk` already applies around the element.
- **Reuse** — two `<image>` elements with the same href, or one reached twice
  through `<use>`, embed **one** XObject.

Out of scope, each reported in `skipped`:

- **A non-`data:` href.** Decided explicitly: the library does no I/O and takes no
  dependency, and `skipped` is already the documented channel for what a caller
  loses. A resolver option (`image?: (href) => Uint8Array | undefined`) can be
  added later without breaking this, and is the natural follow-up for
  relative-path SVGs exported by design tools.
- **An `image/svg+xml` payload.** Recursion into a nested SVG needs its own form
  XObject, resource scope and cycle guard; that is a feature, not a branch.

## Three facts that shaped the design

### 1. An Image XObject is a stream, so the walker cannot build one

The same wall `1gg0.19` hit with tiling patterns and `1gg0.8` with fonts.
`svgdraw.ts` allocates nothing — `/ExtGState` and shading-pattern entries are
*direct* dicts in the form's own `/Resources` — but a stream must be an indirect
object, and only `svgembed.ts` may allocate.

So `<image>` takes the established shape, a sink the embedder implements:

```ts
/** Allocates an Image XObject (and its /SMask) and returns its reference.
 *  svgembed.ts implements it, because an Image XObject IS a stream and streams
 *  must be indirect objects. Mirrors SvgTileSink, for the same reason. */
export interface SvgImageSink {
  image(built: BuiltImage): PdfObject;
}
```

`imageembed.ts` already splits along exactly this line:
`buildImageXObject(data, format?) → BuiltImage` is pure and allocates nothing,
which is what makes the sink a three-line implementation rather than a second
image encoder.

### 2. `buildImageXObject` throws, and an SVG walk must not

It raises `UnsupportedFeatureError` (unrecognized magic bytes, an unsupported
JPEG component count) and `PdfParseError` (no SOF marker, a malformed PNG). Those
are right for `page.AddImage`, where the caller handed over one image
deliberately, and wrong here: one corrupt icon in a 200-element illustration must
not abort the whole placement.

`svgimage.ts` therefore catches and converts to `undefined`, which the walker
reports as `image`. This is the SVG stack's existing contract — render what you
can, name what you could not — and it is why the decode lives in a module of its
own rather than inline in `walk`.

The catch is deliberately broad rather than a two-error `instanceof` list: the
distinction a caller can act on is "this image did not render", and a narrower
catch would let a future decoder change turn a skipped icon into a thrown call.

### 3. The walker is y-down, and a PDF image is y-up

Content is emitted in raw viewBox units with y pointing **down**; the single flip
happens in `placementMatrix`. A PDF Image XObject fills the unit square with its
first row at `v = 1`. So an upright image at rect `(x, y, w, h)` in walker space
is

```
cm = [w·sx, 0, 0, −h·sy, x + tx, y + ty + h·sy]
```

— the local `−h` is the second flip that cancels the placement one. Getting this
wrong yields a vertically mirrored image that no operator assertion I write myself
would catch, which is what makes the raster round-trip below load-bearing rather
than decorative.

## Modules

- **`src/svgimage.ts`** — NEW. Pure. Parses a `data:` URI to bytes, builds the
  `BuiltImage`, and resolves the geometry (intrinsic size, `fitBox`, the `cm`
  above, and whether a clip is needed). Mirrors `svgpattern.ts`'s role: all the
  arithmetic, none of the plumbing.
- **`src/svgtransform.ts`** — extract the align/scale core of `placementMatrix`
  into a pure `fitBox(src, dest, par, fit?) → { sx, sy, tx, ty }`. Its `tx`/`ty`
  are already measured y-**downward** from the destination's top-left, which is
  exactly the walker's frame, so root placement and `<image>` share one
  implementation of `meet`/`slice`/align and cannot drift. `placementMatrix`
  keeps sole ownership of the flip.
- **`src/svgdraw.ts`** — the `image` case in `walk`; `SvgImageSink`; an
  `xobj: PdfDict` on `Emitter` with the same per-stream lifecycle as `pat` and
  `extg`, plus an href→ref cache **shared** through `child()`.
- **`src/svgembed.ts`** — implements `SvgImageSink`.

`xobj` must be per-stream and the cache document-wide: a `<pattern>` tile's
content stream cannot see the form's `/Resources`, so an image used in both is
registered in each — as the same indirect ref, under each stream's own key.

## Geometry

| SVG | PDF |
|---|---|
| `x`, `y` (default 0) | the rect origin, y-down |
| `width`, `height` present and > 0 | the destination box |
| both **absent** | the intrinsic pixel size, from the XObject's `/Width`/`/Height` |
| exactly one absent | derived from the other through the intrinsic aspect ratio |
| `width` or `height` **≤ 0** | nothing drawn |
| `preserveAspectRatio` (default `xMidYMid meet`) | `fitBox`, folded into the `cm` |
| `… slice` | the same, plus `re W n` clipping to the rect |
| `transform`, `clip-path`, `opacity` | already emitted by `walk` around the element |

Percentage `width`/`height` are read as their bare number, consistent with every
other length in this stack (`attrNum` is `parseFloat`), and noted as a limitation
rather than reported — the same treatment `1gg0.3` gave lengths elsewhere.

`meet` and `none` need no clip: the fitted box never leaves the rect. `slice`
does, by definition. The clip is the element's own rect, not the viewport —
`svgembed.ts` already clips the whole placement to the target rect.

Two rules the walker already enforces and the `image` case must not break: it
paints only when `!inDefs`, so an `<image>` inside `<defs>` or `<symbol>` is
indexed for `<use>` and drawn nowhere; and the decode still runs in that case only
if it is free of side effects — so the sink is called from the painting branch,
never from the walk itself, or a `<defs>` image would allocate an XObject nothing
references.

### Opacity, stated plainly

`svgstyle.ts` folds group `opacity` into `fillOpacity` and `strokeOpacity`,
because PDF has no group alpha short of a transparency group. Using `fillOpacity`
for the image therefore also applies `fill-opacity`, which SVG says does **not**
apply to `<image>`. The two cannot be separated after the fold, and group opacity
on an image (a watermark) is worth far more than the fidelity of a property
authors do not set on images. Recorded here and in the README beside the existing
group-opacity note.

## Reporting

`image` stops being unconditionally named. It is reported when, and only when,
ink that should exist does not:

| Condition | Reported |
|---|---|
| href is absent, empty, or not a `data:` URI | `image` |
| payload is not PNG/JPEG by magic bytes (incl. `image/svg+xml`) | `image` |
| payload is corrupt (decode throws) | `image` |
| `width` or `height` ≤ 0 | *nothing* — SVG 1.1 §5.6 makes zero a deliberate no-render |
| a `data:` URI whose declared media type contradicts its bytes | *nothing* — the bytes win, and the image renders |

The last row is a choice: data URIs in the wild carry wrong media types, and
sniffing is what `AddImage` already does. The declared type is never consulted.

## Errors

No new error conditions, and no new throw sites: `addSvgObject`'s existing
guarantee — validation before allocation, a rejected call leaves the document
byte-identical — is untouched, because every image failure is a skip.

## Testing

`svgimage.ts` carries the pure weight: base64 and percent-encoded payloads,
whitespace inside a base64 payload (pretty-printers wrap long attribute values),
a missing comma, an empty payload, a non-`data:` scheme, corrupt bytes, and the
intrinsic-size fallback. `fitBox` gets its own table: the nine align keywords ×
`meet`/`slice`/`none`, plus the extraction's regression guard — `placementMatrix`
must produce byte-identical output for the existing golden set, which the current
SVG suite already pins.

`svgdraw.ts`/`svgembed.ts`, on emitted operators: `/ImN Do` inside the form, the
`cm` for the default `meet` fit, the `slice` clip, `skipped: ['image']` for an
external href, and **one** XObject for two identical hrefs (assert the ref, not
just the count — a per-element key that happens to collide would pass a count).

### The reader that can disagree with us

An operator assertion cannot catch a mirrored image, because I would write both
sides of it. `raster.ts` decodes an Image XObject and inverse-maps device pixels
to image UV with its own local Y-flip — code written separately from this
writer — so the round trip in the `svg-*-render.test.ts` idiom is the real check:
place a 2×2 PNG from `buildPngRgbWith` with a distinct top-left colour at
1 px/pt, `Save` → `Open` → `ToImage`, and sample the four corners. That pins
orientation, position and scale at once, and it is the assertion to mutate against
(flip the sign of `d` in the `cm` and it must go red).

Also mutation-prove the `slice` clip and the href dedup, per the repo rule.

## Documentation

`README.md`: drop `<image>` from the not-rendered list on the SVG feature bullet,
describe the supported href and geometry, and record the two approximations (the
`fill-opacity` fold, percentage lengths). Add the data-URI-only policy to the
Limitations section, since it is the kind of thing a caller discovers by getting
`skipped: ['image']` back.

## Follow-ups

1. **A caller-supplied image resolver** — `image?: (href) => Uint8Array | undefined`
   on `AddSVGOptions`, so relative-path and `http:` hrefs can be supplied by the
   caller without the library doing I/O. The obvious next step for design-tool
   exports.
2. **Nested SVG payloads** — `<image href="data:image/svg+xml;…">` recursing
   through `drawSvg` into its own form XObject, behind a depth guard.
