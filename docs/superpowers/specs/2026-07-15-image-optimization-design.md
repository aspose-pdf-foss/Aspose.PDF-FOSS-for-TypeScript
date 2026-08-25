# Image Optimization (`doc.Optimize({ images })`) — Design

**Issue:** aspose-pdf-foss-for-ts-kqy · Optimize: image downsampling + recompression
**Date:** 2026-07-15
**Follows:** `2026-07-15-document-optimize-design.md` (framework + fonts/dedup/compress)
**Depends on:** aspose-pdf-foss-for-ts-aw0 · Baseline JPEG encoder (`encodeJpeg`) — shipped

## Problem

`doc.Optimize` shipped with three lossless concerns: fonts, dedup, compress. The
images concern was split out because "recompression honors target quality"
requires a JPEG encoder the tree did not have. `encodeJpeg` (src/jpegencode.ts)
now exists, so this spec restores the concern: downsample image XObjects to a
target DPI and recompress them at a target quality.

Unlike the other three, **this concern is lossy**. That single fact drives the
API, the defaults, and the report.

## Scope

In scope: image XObjects that are photographic and safely re-encodable —
`DCTDecode` images, plus Flate/LZW-coded 8-bit Gray/RGB/CMYK.

Out of scope, and hard-excluded by a dict guard (see "Guard"): `ImageMask`,
`BitsPerComponent != 8`, `Indexed`, JBIG2/CCITT bilevel, any image with `/Mask`,
and any image with a `/Decode` array. JPEG is the wrong codec for line art,
screenshots, and palettes; these exclusions are where the correctness traps live,
not a gap to be closed later.

Inline images (`BI`) are out of scope: replacing one means rewriting the content
stream that contains it, which is `editcontent.ts`'s job, not this pass's.

## Architecture

Three new modules, following the repo's one-concern-per-file convention.
`optimize.ts` gains a fourth concern and calls into them.

| Module | Responsibility |
|---|---|
| `src/imageusage.ts` | Content scan → per-image-stream max effective DPI + completeness |
| `src/resample.ts` | Pure box-filter downsample of an interleaved sample plane |
| `src/imageopt.ts` | Guard → decode → resample → encode → replace; the concern orchestrator |

### Why a new scanner

`visitContent` (src/text.ts) already tracks the CTM and emits an `ImageEvent`
per draw — but `ImageEvent` carries the CTM and a quad and **no reference to the
XObject it drew**. It cannot answer "which stream, at what scale", which is the
only question this concern asks.

This is the same gap that forced `glyphusage.ts` to exist rather than reuse
`visitContent`: `GlyphEvent` exposes decoded text but not the owning font dict.
`imageusage.ts` follows that precedent — a focused scanner over the `content.ts`
tokenizer, tracking `q`/`Q`/`cm` and resolving `Do` against the active scope's
`/XObject` resources.

**Sites walked**, matching `glyphusage.ts`: page `/Contents`; Form XObjects
(recursive, depth-capped at 8 per `MAX_XOBJECT_DEPTH`); annotation `/AP` `/N`,
`/D`, `/R` streams with their own `/Resources`; tiling-pattern content streams;
Type3 `/CharProcs`. Cycle-guarded by visited-dict sets.

Each site supplies a base CTM:

- **page `/Contents`** — identity. The array is concatenated before parsing, per
  PDF 32000 7.8.2 ("the division between streams may occur only at lexical token
  boundaries"), so a `q` in one part pairs with its `Q` in the next.
- **Form XObject** — the parent's CTM composed with the form's `/Matrix`.
- **annotation `/AP`** — the `/BBox`-to-`/Rect` fit of PDF 32000 12.5.5: the
  `/BBox` corners are transformed by `/Matrix` and the result scaled and
  translated into `/Rect`.
- **tiling pattern** — the pattern's `/Matrix` alone. PDF 32000 8.7.3.1 maps
  pattern space to the *default* space of the parent content stream, not to the
  CTM at fill time, so the placement is fully measurable.
- **Type3 `/CharProcs`** — **not measurable.** The real CTM is the font matrix
  times the text matrix times the CTM at show time, none of which this scan
  tracks. Images drawn from a Type3 glyph are marked incomplete rather than
  measured. The safety net alone would not cover this: an image drawn from *both*
  a page and a Type3 glyph is reached by the scan, so without this rule it would
  be measured from its page placement and could be downsampled below what the
  glyph needs.

The cycle guard **adds on entry and removes on exit**, unlike `glyphusage.ts`,
which adds permanently. That difference is load-bearing: glyphusage only needs to
know *whether* a font is used, so visiting a Form XObject once suffices, but a
Form drawn twice at different scales yields two DPIs and both must be measured.
Add/remove still breaks cycles, which is all the guard is for.

```ts
type ImageUsage = Map<PdfStream, { maxDpi: number; complete: boolean; reason?: string; name?: string }>;
```

## Effective DPI

An image XObject is painted into the unit square, so the CTM at the draw *is* the
placement. For CTM `[a b c d e f]`:

```
dpiX = Width  * 72 / hypot(a, b)
dpiY = Height * 72 / hypot(c, d)
```

`hypot` rather than `a`/`d` alone so rotated and skewed placements measure their
true device extent. A degenerate placement (either extent ~0) contributes no DPI
and is ignored.

### Placement policy

A stream keeps the **max** DPI over all its placements, so the most demanding
usage site sets the bar and no placement degrades. The downsample factor is:

```
scale = min(1, targetDpi / maxDpi)
newW  = max(1, round(Width  * scale))
newH  = max(1, round(Height * scale))
```

`min(1, ...)` means the pass **never upsamples**: an image already coarser than
the target is recompressed at quality but not resized.

When `dpi` is omitted, `scale` is 1 — recompress only.

### Undrawn images are skipped

An image XObject the scan never saw drawn is skipped and reported. This mirrors
the font scan's "reachable from a `/Font` resource dict the scan never walked"
rule: it is the safety net that makes the policy real rather than aspirational,
catching usage sites this design did not anticipate.

**It also handles `/SMask` correctly for free.** A soft mask is *referenced* by
its parent image, never *drawn* via `Do`, so the scan never sees it, so it is
never touched. Alpha masks are exactly where JPEG ringing is most visible, and
the general rule excludes them with no special case. `/Mask` stencils likewise.

Downsampling a base image while leaving its `/SMask` at full resolution stays
correct: PDF resamples a soft mask to its parent image independently of the
mask's own dimensions (PDF 32000 8.9.6.4).

## Per-image flow (`imageopt.ts`)

### Guard

Reject before decoding, each with a reported reason:

- `/ImageMask true` — bilevel stencil;
- `/BitsPerComponent` != 8 — the encoder is 8-bit;
- `/ColorSpace` `Indexed` — a palette; JPEG would destroy it;
- terminal filter `JBIG2Decode` or `CCITTFaxDecode` — bilevel;
- `/Mask` present — stencil or colour-key masking;
- `/Decode` present — a sample-inversion the re-encode would not reproduce.

### Colorspace

The colorspace is read for exactly one purpose: choosing the encoder's
`JpegKind`, i.e. how many components the samples carry and whether to apply the
YCbCr transform. It is **not** rewritten into the output dict (see "Encode and
replace").

`/ColorSpace` → `JpegKind`: `DeviceGray`/`CalGray` → `gray`; `DeviceRGB`/`CalRGB`
→ `rgb`; `DeviceCMYK` → `cmyk`; `ICCBased` by its `/N` (1 → `gray`, 3 → `rgb`,
4 → `cmyk`). Anything else (`Separation`, `DeviceN`, `Lab`, `Pattern`) → skipped,
reported: their component counts and interpretations do not map onto a baseline
JPEG frame.

The `/Decode` exclusion resolves a real trap for free. `buildJpegXObject` writes
`/Decode [1 0 1 0 1 0 1 0]` for Adobe-tagged CMYK, because such JPEGs store
inverted samples; `encodeJpeg` deliberately writes non-inverted CMYK with no
APP14. Excluding `/Decode`-bearing sources keeps the two conventions from ever
meeting.

### Samples

- `DCTDecode` → `decodeJpeg` (src/jpeg.ts) directly. **Not** `ImageInfo.Decode()`:
  that method is a *passthrough* for DCT (src/image.ts:88) and returns JPEG bytes,
  not samples. The issue's "build over ImageInfo.Decode" note is wrong on this
  point.
- Flate/LZW/ASCII chains → `ImageInfo.Decode()`, which applies predictors.

### Resample

`resample.ts` box-averages the source region for each destination pixel, over
interleaved samples with `n` channels. Box filtering matches the `box2x2`
precedent already in `jpegencode.ts` and is the right filter for downscaling:
it averages every contributing source pixel, so it neither aliases (as nearest
does) nor ignores pixels (as bilinear does at scale < 0.5).

Pure and independently testable: `(src, w, h, channels, newW, newH) → Uint8Array`.

### Encode and replace

`encodeJpeg(newW, newH, samples, kind, { quality })`, then build the replacement
dict by the **denylist** shape already used by `shrinkOne` (src/optimize.ts:124):

```ts
const d: PdfDict = new Map(original.dict);   // carry everything by default
d.delete('DecodeParms'); d.delete('DP'); d.delete('Length');
d.delete('Decode');                          // guard means source had none
d.set('Width', newW); d.set('Height', newH); // change on downsample
d.set('Filter', name('DCTDecode'));
```

Copy-then-override, rather than synthesizing a fresh dict, is load-bearing.
`buildJpegXObject` builds its dict from SOF markers alone and knows only seven
keys — routing through it would silently drop `/SMask`, `/OC`, `/Intent`, and
`/Metadata`. An image losing its `/SMask` renders its transparent background as
black, with no error anywhere. A denylist fails safe: an unanticipated key
survives instead of vanishing. `buildJpegXObject` is therefore **not** used on
this path; it stays the `AddImage` entry point it was written for.

**`/ColorSpace` and `/BitsPerComponent` are carried, never rewritten.** The
re-encode preserves the component count (`gray`→1, `rgb`→3, `cmyk`→4) and emits
8-bit samples in the same order, so the original colorspace object stays exactly
as valid as it was. Overwriting it with the `JpegKind`'s device equivalent would
discard an `ICCBased` profile and shift every colour in the image — a silent
fidelity loss with no error. `kind` is an input to the *encoder*, not a statement
about the dict.

### Commit rule

Replace the stream **only if strictly smaller** than the original; otherwise keep
the original and report it skipped. This is the same rule `fontshrink` and
`recompress` follow ("keep the original unless the rewrite is strictly smaller"),
and it means the pass can never inflate a file or spend quality for nothing.

## Pass order

Images run **first**: `images → fonts → dedup → compress`.

The argument is the one that already puts fonts before dedup: a pass that
rewrites stream payloads must run before dedup, so dedup can merge payloads the
rewrite just made byte-identical. A photo repeated once per page recompresses to
N identical streams, and dedup collapses them to one.

`compress` skips DCT streams (re-wrapping an image codec only grows it), so it
correctly ignores what `images` just wrote.

The cost is a redundant encode when a document repeats one image: each copy is
encoded, then dedup discards all but one. Running dedup first would avoid that,
but it would need a *second* dedup afterward to catch newly-identical output, and
a pipeline with one rule ("payload rewrites precede dedup") is worth more than
the saved cycles.

## API

```ts
doc.Optimize()                                  // lossless, unchanged
doc.Optimize({ images: { dpi: 150 } })          // opt in to the lossy pass
doc.Optimize({ images: { quality: 60 } })       // recompress, no downsample

interface OptimizeOptions {
  fonts?: boolean;    // default true
  dedup?: boolean;    // default true
  compress?: boolean; // default true
  /** LOSSY. Off unless set: recompresses images to JPEG. */
  images?: ImageOptions;
}

interface ImageOptions {
  /** Target DPI. Omit to recompress without downsampling. Never upsamples. */
  dpi?: number;
  /** IJG scale 1..100. Default 75. */
  quality?: number;
}
```

`images` is an **options object whose presence is the opt-in**, not a boolean.
The other three concerns are booleans defaulting to true because each is
lossless; `images` reads differently because it *is* different, and the type
makes it impossible to get the lossy pass by accident. There is deliberately no
`images: true` shorthand — it would mean "degrade my images at settings I did not
choose".

## Report

```ts
interface ImageOptimization {
  /** Object number of the image stream — the one stable identifier. */
  objNum: number;
  /** Resource key of some placement (e.g. 'Im0'), when the scan saw one drawn.
   *  Diagnostic only: an XObject reachable under different keys in different
   *  scopes reports whichever placement the scan met first. */
  name?: string;
  width: number; height: number;                  // after
  originalWidth: number; originalHeight: number;  // before
  bytesSaved: number;
}

interface SkippedImage { objNum: number; name?: string; reason: string }

interface OptimizeReport {
  // ...existing fields
  images: ImageOptimization[];
  /** Images left untouched, and why. */
  skippedImages: SkippedImage[];
  /** True when the images concern ran: output is no longer visually identical. */
  lossy: boolean;
  bytesSaved: number;
}
```

`skippedImages` is separate from `skipped` (which is `{ baseFont, reason }`)
rather than widening that type: the two carry different identifiers, and fonts'
skip list is already the fonts concern's debuggability surface.

The issue asked to revisit the report's losslessness wording. Rather than soften
the existing prose, this adds an explicit `lossy` flag. The no-argument
contract — "content and visual output preserved exactly" — stays stated exactly
as strongly as today, because it remains literally true: images cannot turn on by
accident.

`bytesSaved` keeps its existing documented meaning (an estimate: the sum of
per-stream raw byte deltas) and now includes image deltas.

## Testing

TDD per house style. Fixture builder `test/helpers/build-image-pdf.ts`; tests in
`test/imageusage.test.ts`, `test/resample.test.ts`, `test/imageopt.test.ts`, plus
additions to `test/optimize.test.ts`.

The load-bearing tests are the scan and the dict carry-over — a wrong DPI silently
degrades a page, and a dropped `/SMask` silently blackens one.

**Scan (`imageusage`):**
- one image drawn at two different scales resolves to the **max** DPI;
- a rotated `cm` measures true device extent (guards `hypot` vs. `a`/`d`);
- an image drawn only from an annotation `/AP` stream is found;
- an image inside a Form XObject inherits the composed CTM;
- an undrawn image is reported incomplete;
- a scope whose content stream fails to decode marks its images incomplete.

**Resample:** a flat plane resamples to the same flat value; a 2:1 downsample of
a known ramp box-averages exactly; `newW/newH` of 1 does not divide by zero.

**Pass (`imageopt`):**
- a 300-DPI image at `{ dpi: 150 }` halves both dimensions;
- at `{ dpi: 600 }` it is **not** upsampled and keeps its dimensions;
- `/SMask`, `/OC`, and `/Metadata` survive the rewrite attached to the new stream;
- an `ICCBased` `/ColorSpace` survives **by reference**, not flattened to
  `/DeviceRGB` (guards the carry-don't-rewrite rule);
- a CMYK image round-trips with no `/Decode` added;
- `ImageMask`, `Indexed`, `/Decode`-bearing, and 1-bpp images are skipped with reasons;
- a `Separation` colorspace is skipped;
- an image whose re-encode is not smaller is left **byte-identical**;
- output re-opens, the image re-decodes at the new dimensions, and `GetText()` is
  unchanged.

**Integration (`optimize`):**
- `Optimize()` with no args touches no image and reports `lossy: false`;
- `Optimize({ images })` reports `lossy: true`;
- two identical images recompress and then **dedup to one** (guards pass order);
- a signed document still throws.
