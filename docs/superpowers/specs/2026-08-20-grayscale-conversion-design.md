# ConvertToGrayscale — design

Issue: `10u9.1`, under epic `10u9` (Colour and raster breadth, `gap-vs-go`).
Date: 2026-08-20.

Go has `grayscale.go`; TS has nothing. This is the design for
`Document.ConvertToGrayscale()`, which converts a document's colour to
DeviceGray across page content, form XObjects, patterns, Type 3 glyph
procedures, image XObjects, shadings and annotations.

## Scope

Document-level only. `doc.ConvertToGrayscale()` converts every shared object
exactly once, in place, keyed by object number — a form XObject placed on five
pages, or an image behind three placements, converts once and correctly.

There is deliberately no `Page.ConvertToGrayscale()` and no page range. Either
would have to copy-on-write every form XObject, image, pattern and Type 3 font
that a neighbouring page also uses, since converting a shared object greys the
neighbour too. That is a large amount of resource plumbing bought for a use
case nobody has: "make this document grey" is the request.

## The greying rule

One rule, one owner, in `grayscale.ts`:

```
luma = 0.299 R + 0.587 G + 0.114 B          (Rec. 601, on the encoded values)
```

Rec. 601 rather than Rec. 709 for two reasons. It is what Ghostscript and the
rest of the PDF tooling emit, so a document converted here matches the same
document converted elsewhere. And it is exactly JPEG's own Y channel, which is
what keeps the coefficient-domain route (see **Non-goals**) available later: a
baseline JPEG's Y *is* Rec. 601 luma, so dropping the chroma components in the
DCT domain would be an exact, generation-free greying. Choosing Rec. 709 would
close that door for a photometric argument that no other tool acts on.

Non-device colour reaches the rule through `resolveColorSpace` in
`colorspace.ts`, which already reduces ICCBased, Indexed, Separation, DeviceN,
CalRGB and Lab to RGB. That is the whole reason those spaces need no cases of
their own here, and it holds this feature to the repo's existing rule that
"what colour is this operand" has exactly one owner — the rule `paths.ts` and
`text.ts`'s glyph colour already follow.

DeviceGray, DeviceRGB and DeviceCMYK are converted in float directly rather
than through `resolveColorSpace`, whose `toRgb` quantizes to 8-bit. The error
is invisible either way; the direct path is both exact and cheaper, and those
three are the 99% case.

## Approach: operator-level neutralization

Rejected alternatives are recorded first, because the reasoning is the design.

**Retargeting the colour spaces** — rewriting every `/Resources /ColorSpace`
entry and every image `/ColorSpace` to DeviceGray — produces a tidier file with
no dead resources. It was rejected because it multiplies the ways to be
half-wrong: a colour space object shared between an image we can convert and
one we cannot (a colour-key `/Mask`, a JPX we will not re-encode) leaves the
document self-inconsistent; ICCBased profiles must be dropped or replaced;
Indexed palettes must be rewritten in lockstep with every referencing image.

**Rasterizing each page to a grey image** is complete by construction and
destroys text, vectors, searchability and file size. Named only to record it as
rejected.

What we do instead: never retarget a named colour space. Every colour-*setting*
operator becomes `g`/`G` carrying the luma of the colour it set, and `cs`/`CS`
becomes `/DeviceGray`. Named `/ColorSpace` resources are left unreferenced;
`Optimize`'s `drprune` pass already sweeps that class of thing. Images,
shadings and patterns convert at the object level, once each.

### Invariant: the two phases are order-independent

**Phase 1** (object-level) converts each image XObject, shading and function
once, keyed by object number, installed via `doc.replaceObject` at the same
number so every referrer follows without being touched — `imageopt.ts`'s rule.

**Phase 2** (content-level) rewrites each content stream once, also keyed by
object number.

The content pass *reads* colour-space resources that no pass ever *rewrites*.
That is what makes the two phases order-independent, and it is the whole
argument for this approach over retargeting, which would have had phase 2
resolving spaces phase 1 had already moved out from under it.

The single exception is stated below and is safe precisely because it touches
the one colour-space shape no image can reference.

## Module layout

Five new modules, following the repo's pure-core / one-Document-toucher split.

| Module | Role | Imports |
|---|---|---|
| `grayscale.ts` | Leaf. `luma()` and `grayOf(components, space)` — the one owner of "what grey is this colour". | `colorspace.ts` only |
| `grayops.ts` | Pure content-operator rewriter: `ContentOp[]` + a colour-space lookup → rewritten ops + a change count. | `grayscale.ts`, `content.ts`, `types.ts` |
| `grayimage.ts` | Pure over `(stream, resolve, inflate)` → a replacement stream or a skip reason. | `grayscale.ts`, `image.ts`, codecs |
| `grayshading.ts` | Pure over a shading dict → converted dict and functions. | `grayscale.ts`, `pdffunction.ts` |
| `grayconvert.ts` | The only module here that touches a `Document`: enumeration, `replaceObject`, the report. | all of the above |

`grayimage.ts` and `grayshading.ts` take `resolve`/`inflate` as **arguments**
rather than importing `document.ts` — the `glyphprogram.ts` pattern — so every
conversion rule is testable from a hand-built dict without building a file.

`grayops.ts` must not import `document.ts` either: its colour-space lookup
arrives as a callback, which is what lets the whole operator table be driven
from hand-built `ContentOp` lists.

## The content pass

### Enumeration

Six sources, each recursing into its own `/Resources`, deduped by object number
and cycle-guarded, threading an inherited resource dict for a form that has
none of its own (as `glyphusage.ts` already does):

1. Page `/Contents` (single stream or array)
2. Form XObjects, recursively
3. Tiling patterns (`/PatternType 1`)
4. Type 3 font `/CharProcs`
5. Annotation `/AP` streams — `/N`, `/R`, `/D`, including the per-state dict form
6. ExtGState `/SMask /G` transparency groups

Dedup by object number is a correctness rule, not an optimization. A form
XObject reached through two pages would be `replaceObject`-ed twice, and the
second write would be built from the first write's output rather than from the
original — so the report's `operators` count would double-count, and any pass
that is not perfectly idempotent would compound. Convert once.

### The rewriter

A `q`/`Q` stack of `{ fill, stroke }` colour spaces, both starting at
DeviceGray (PDF's initial colour is black in DeviceGray). An unbalanced `Q`
clamps at the bottom of the stack rather than throwing — damaged content must
not take the conversion down, the rule the four non-object grammars already
follow.

| Operator | Action |
|---|---|
| `g` `G` | untouched; records DeviceGray |
| `rg` `RG` | → `g`/`G` with the luma; records DeviceGray |
| `k` `K` | → `g`/`G` with the luma; records DeviceGray |
| `cs` `CS` | resolve the name in `/Resources /ColorSpace`, record the converter, emit `/DeviceGray` |
| `sc` `scn` `SC` `SCN` | operands → luma **through the recorded space** → `g`/`G` |
| `sh` `gs` `Do` | unchanged — those resources convert in phase 1 |
| `d0` `d1` | unchanged; `d1` declares a shape-only glyph whose colour is ignored anyway |
| `BI` | inline image, converted in place (phase 5) |

Numbers are rounded to 4 decimals, as `pdfxcolor.ts` already does — PDF numbers
gain nothing from more.

### The one colour-space resource we do rewrite

An *uncoloured* tiling pattern is `c1 … cn /P0 scn` in a `[/Pattern base]`
space, so the operands can only shrink to one number if that space's base
shrinks too. A `[/Pattern base]` colour space is referenced by nothing but
`cs` + `scn` — never by an image, never by a shading — so retargeting exactly
that array to `[/Pattern /DeviceGray]` cannot desynchronize anything. It is
the sole place this design rewrites a colour-space resource, and the sole
exception to the order-independence invariant above.

A *coloured* tiling pattern (`/P0 scn`, no numeric operands) takes its colour
from its own content stream, which the enumeration already converts.

## Images

Two lists, and the distinction is load-bearing: `images` holds what was
converted, `skipped` holds what could not be and why. An image with no colour
to convert — an `/ImageMask`, an already-DeviceGray or CalGray image, an
ICCBased with `/N 1` — appears in **neither**. A skip list padded with hundreds
of non-gaps is a skip list nobody reads, and the skip list is the first place a
caller looks when a converted document still shows colour.

### Routes, in priority order

1. **Indexed, at any `/BitsPerComponent`.** Rewrite the lookup table alone:
   each palette entry through luma, base becomes DeviceGray, one byte per
   entry. Sample data is never touched. Lossless, shrinks the palette, and it
   is the only route that works at 1, 2 and 4 bpc — `ImageInfo.Decode()` hands
   back still-packed samples below 8 bpc, so the sample routes cannot.
2. **DCTDecode.** Decode → luma → `encodeJpeg(…, 'gray', { quality })`,
   default quality 90. Sets `lossy` on the report.
3. **Other decodable 8-bpc samples** — Flate, LZW, RunLength, JPX. Decode →
   luma → `encodeStream` Flate, `/BitsPerComponent 8`. JPX takes this route
   because the repo has a JPEG 2000 *decoder* and no encoder; the result will
   usually be larger, and `bytesDelta` in the report makes that visible rather
   than surprising.
4. Anything else — skipped, with the reason.

CCITTFax and JBIG2 images are bilevel and already monochrome; they convert only
if their `/ColorSpace` is an Indexed palette, via route 1.

### Guards, each reported as a skip

- **A colour-key `/Mask` array.** Two different colours can share a luma, so a
  range in RGB is not a range in grey: the converted mask would start matching
  pixels it never matched. There is no faithful conversion, so the image is
  left in colour and reported.
- **A `/Decode` array.** `ImageInfo.Decode()` does not apply it, so the samples
  we would grey are not the samples that get drawn. Matches `imageopt.ts`'s
  guard for the same reason.
- A filter we cannot decode.

### The replacement dict

Copy-then-override — a **denylist, not an allowlist**. This is `imageopt.ts`'s
rule and it is here for its reason: synthesizing a fresh dict from what the
converter knows silently drops `/SMask`, `/OC`, `/Intent` and `/Metadata`, and
an image that loses its `/SMask` renders its transparent background black with
no error raised anywhere.

Override `/ColorSpace`, `/Filter`, `/Length`, `/BitsPerComponent`; delete
`/DecodeParms`, `/DP` and `/Decode` (the guard means the source had no
`/Decode`).

One rule `imageopt.ts` does not cover: **`/SMask /Matte` is an array in the
parent image's colour space**, so it converts alongside the parent. The
`/SMask` stream itself is DeviceGray by specification and is left alone.

## Shadings and functions

`/ColorSpace` becomes `/DeviceGray`. `/Background` is an array in the shading's
own space and converts through luma.

`/Function` conversion is exact where exactness is free and resampled
otherwise:

- **Type 2 (exponential).** Map `/C0` and `/C1` through luma, keep `/N`. Exact,
  and a two-stop gradient stays a few bytes.
- **Type 3 (stitching).** Recurse into `/Functions`; `/Bounds` and `/Encode`
  are untouched, being domain-side.
- **Types 0 and 4.** Evaluate through `parseFunction` — which returns an opaque
  `(input) => output` for every type — and re-emit as a 1-output type 0 sampled
  function, `/BitsPerSample 8`.

Two shapes are easy to miss, and both are decided here rather than left to the
implementation:

- `/Function` may legally be an **array of n one-output functions**, one per
  colour component. That is not a recursion case but a *joining* case — the
  array is evaluated jointly and collapses to a single converted function.
- The function is **not always one-input**. Shading types 2–7 take a
  one-input function, sampled at `/Size [256]`; but a type 1 (function-based)
  shading takes a **two-input** function over its `/Domain` rectangle, sampled
  at `/Size [64 64]`. A resampler that assumes one input silently produces a
  flat grey wash for every function-based shading — plausible output for a
  construct nobody looks at closely, so the two-input case gets its own
  fixture rather than being trusted.

### Mesh shadings

Types 4–7 **without** a `/Function` carry per-vertex colour bit-packed into the
stream data alongside `/BitsPerCoordinate` and `/BitsPerFlag`, with the colour
ranges in `/Decode`. Converting those means rewriting bit-packed vertex data
and is out of scope: skipped, reported, follow-up issue filed.

With a `/Function` present the vertex data carries only a parametric `t`, so
those convert for free through the path above. The gap is narrower than "mesh
shadings are unsupported" suggests, and the report says which.

## Annotations and remaining object-level colour

- `/C` (border/background) and `/IC` (interior): 1, 3 or 4 components collapse
  to one. **An empty `/C` array is legal and means no colour** — it must stay
  empty rather than becoming `[0]`, which would paint a black border where the
  document asked for none.
- A widget's `/MK /BG` and `/MK /BC`: the same rule, including the empty case.
- `/DA` strings go through **the same `grayops` rewriter**, over the string's
  bytes. Not through `parseDA`, which reduces a `/DA` to
  `{ fontName, size, color }` and would drop every operator it does not
  recognise on re-emission. A `/DA` is a content-stream fragment and deserves
  the content rewriter; one rewriter, two consumers.
- `/AcroForm /DA` gets the same treatment.

Appearance streams are already in the phase 2 enumeration, so a widget's drawn
colour and its `/MK` cannot end up disagreeing.

`/OutputIntents` is deliberately left alone. A DeviceCMYK output intent on a
greyed document is odd but not invalid, and replacing it is PDF/X
remediation's job, not this call's.

## Public API

```ts
Document.ConvertToGrayscale(opts?: GrayscaleOptions): GrayscaleReport
```

```ts
export interface GrayscaleOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
}

export interface GrayImageResult {
  objNum: number;
  /** The colour space it came from, e.g. 'DeviceRGB', 'Indexed'. */
  from: string;
  route: 'palette' | 'jpeg' | 'flate';
  /** Negative when the converted image is smaller. */
  bytesDelta: number;
}

export interface GraySkipped {
  objNum?: number;
  what: 'image' | 'shading' | 'content' | 'annotation';
  reason: string;
}

export interface GrayscaleReport {
  /** Content streams rewritten. */
  streams: number;
  /** Colour operators changed across all of them. */
  operators: number;
  images: GrayImageResult[];
  shadings: number;
  annotations: number;
  /** What could not be converted, and why. The first place to look when a
   *  converted document still shows colour. */
  skipped: GraySkipped[];
  /** True when any image was re-encoded through JPEG: the output is no longer
   *  a lossless greying of the original. */
  lossy: boolean;
  bytesDelta: number;
}
```

Shaped after `OptimizeReport`, including its honesty about `lossy` and its skip
list.

### Errors

Throws `UnsupportedFeatureError` for a signed document, exactly as `Optimize`
does and for the same reason: `Save()` returns the cached signed bytes
verbatim, so every change would be discarded silently.

`isSigned` is currently private to `optimize.ts` with one caller. It moves to
`signature.ts` — the module that already owns "what is a signature" — and both
callers import it. One owner, no second copy.

Nothing else throws. A stream that will not parse is reported in `skipped` and
left alone.

## Testing

Four layers, and the second is the one that matters.

1. **Pure units.** `luma`; `grayops` over hand-built `ContentOp` lists (every
   operator, `q`/`Q` nesting, an unbalanced `Q`, Separation/DeviceN/Indexed/Lab
   through a stub lookup); `grayimage` and `grayshading` from hand-built dicts.
   No PDF built for any of it.
2. **The global pixel oracle.** Build one document exercising every construct —
   a `PageGraphics` gradient, an RGB JPEG, a PNG, an Indexed image, a tiling
   pattern, a form XObject, a Type 3 font, an annotation with `/C` and `/IC`, a
   widget with `/DA` and `/MK` — convert, render every page through `ToImage()`
   and assert **R === G === B for every pixel**. A missed content stream renders
   in colour and leaves every structural assertion green; this is the only
   check that sees it.
3. **Function conversion against an outside oracle.** Evaluate the *converted*
   function at N points and compare against the luma of the *original's*
   output. Asserting the emitted dict would only prove the writer agrees with
   itself — the repo's standing rule that a differential test cannot validate
   the parser it runs through.
4. **A byte-identity fence.** Converting an already-grey document must change
   nothing, asserted on `Save()` bytes. Cheap, and it catches a pass that
   rewrites unconditionally.

Then, per CLAUDE.md, each pass is broken and the oracle confirmed to go red.
At least one construct is expected to be invisible to the pixel oracle — a
Type 3 charproc and a tiling pattern are the candidates, since a fixture may
draw them in a colour whose luma happens to match. Anything the oracle cannot
see gets its own assertion, and the finding is recorded in the invariant
comment rather than quietly assumed.

## Phases

1. `grayscale.ts` + `grayops.ts` + enumeration + the `ConvertToGrayscale`
   entry point and report skeleton → content streams convert end to end
2. `grayimage.ts` → images
3. `grayshading.ts` → shadings and functions
4. Annotations, `/DA`, `/MK`
5. Inline images (`BI`) — last because it is the phase that could grow. If it
   does, it becomes its own issue and drops out of the oracle fixture
   explicitly rather than silently
6. README and CHANGELOG

## Non-goals, each getting a follow-up issue

- **Mesh shadings 4–7 without a `/Function`** — bit-packed vertex colour.
- **Colour-key `/Mask` images** — no faithful range conversion exists.
- **Coefficient-domain JPEG greying.** A baseline JPEG's Y channel *is* Rec.
  601 luma, so dropping the chroma components in the DCT domain would be an
  exact, generation-free conversion producing a smaller file than route 2. It
  needs a coefficient-level transcoder the repo does not have. The Rec. 601
  choice above is what keeps this available.
- **`/OutputIntents` rewriting** — PDF/X remediation's concern.
- **Page-level or page-range conversion** — see **Scope**.
