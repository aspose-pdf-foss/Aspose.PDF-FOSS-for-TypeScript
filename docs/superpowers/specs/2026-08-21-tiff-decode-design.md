# TIFF decode — design

Issue: `10u9.3`, under epic `10u9` (Colour and raster breadth, `gap-vs-go`).
Date: 2026-08-21.

Go has `tiff.go`; TS has nothing. This is the design for TIFF input to
`AddImage`, the third format after `10u9.2` added BMP.

The issue's title names the point: nearly every codec TIFF needs is already
here and separately tested — `decodeCcitt` (G3/G4), `lzwDecode`,
`applyPredictor` with TIFF predictor 2 already implemented, `runLengthDecode`
(PDF's RunLengthDecode is PackBits), `decodeJpeg`, and `node:zlib`. What is
actually new is the **container**: byte order, the IFD chain, and strip/tile
assembly.

## Scope

Input only, as BMP is. TIFF is not a PDF construct, so a TIFF is decoded to
samples at embed time and stored as `FlateDecode` — or, in one case, passed
through as `DCTDecode` — and the saved file carries no trace of having been a
TIFF.

Covered: compression 1 (none), 2 (CCITT RLE), 3 (T.4/G3), 4 (T.6/G4), 5 (LZW),
7 (JPEG), 8 and 32946 (Deflate), 32773 (PackBits); photometric 0 (WhiteIsZero),
1 (BlackIsZero), 2 (RGB), 3 (Palette), 5 (CMYK); strips **and** tiles;
predictor 1 and 2; `FillOrder` 1 and 2; `BitsPerSample` 1, 2, 4 and 8; both
byte orders; and multi-image files.

Declined with a named reason: BigTIFF, `PlanarConfiguration` 2, photometric 4
(transparency mask), 6 (YCbCr) and 8 (CIELab) outside the JPEG route,
compression 6 (old-style JPEG), `BitsPerSample` 16 and 32, and `Predictor` 3
(floating point).

## Module layout

`src/rasterimage.ts` is a new **leaf** holding the decoded-raster vocabulary
and nothing else — no functions, no imports. `src/bmp.ts` and `src/tiff.ts`
both produce it, and `imageembed.ts` maps it in one place.

```ts
export type RasterImage =
  | { kind: 'indexed'; width: number; height: number; bpc: 1 | 2 | 4 | 8;
      palette: Uint8Array; samples: Uint8Array }
  | { kind: 'gray';    width: number; height: number; bpc: 1 | 2 | 4 | 8;
      samples: Uint8Array; alpha?: Uint8Array }
  | { kind: 'rgb';     width: number; height: number;
      samples: Uint8Array; alpha?: Uint8Array }
  | { kind: 'cmyk';    width: number; height: number; samples: Uint8Array }
  | { kind: 'embedded'; format: 'jpeg' | 'png'; payload: Uint8Array };
```

This is `10u9.2`'s `BmpImage` moved and widened. That issue deliberately
defined the type minimally and recorded that it would be generalized when a
second caller existed rather than before; this is that moment. `BmpImage` is
renamed away entirely rather than kept as an alias — one name for one thing —
and `buildBmpXObject` becomes `buildRasterXObject`.

**Invariant:** the two new arms are why the type had to move rather than be
widened in place. BMP has no `gray` (its grayscale is a grey palette, which
`/Indexed` carries exactly) and no `cmyk`; both are TIFF-only, and putting
them on a type owned by `bmp.ts` would make BMP's module the home of colour
models it cannot produce.

**Invariant:** `10u9.2`'s two BMP test files are the fence proving this move is
behaviour-neutral. They must stay green with no change beyond the type's name —
if an assertion has to move, the refactor changed behaviour and that is the
finding.

`src/tiff.ts` is pure but for `errors.js` and the codecs it drives:

```ts
export function decodeTiff(data: Uint8Array, page?: number): RasterImage;
export function tiffPageCount(data: Uint8Array): number;
```

`tiffPageCount` is the only thing here exported from `index.ts`, because
`AddImageOptions.page` is useless without a way to learn the bound. `decodeTiff`
stays internal, as every other decoder in this repo does.

## The container

| | Rule |
|---|---|
| Byte order | `II` (little-endian) or `MM` (big-endian) at bytes 0–1 |
| Magic | `42` at offset 2; `43` is BigTIFF and is refused |
| First IFD | `u32` at offset 4 |
| IFD | `u16` entry count, then that many 12-byte entries, then a `u32` next-IFD offset; 0 ends the chain |
| Entry | tag `u16`, type `u16`, count `u32`, value-or-offset `u32` |

**Invariant:** byte order is decided once and every multi-byte read goes through
that one reader. This is the structural difference from BMP, which is
little-endian always. A second read site assuming an order misreads an `MM`
file completely, and a large share of real TIFFs — anything from a Motorola-era
or scanner lineage — are `MM`.

**Invariant:** a value occupying **4 bytes or fewer is stored inline** in the
entry, left-justified, not at an offset. Reading it as an offset lands
somewhere plausible inside the file rather than failing, so the image decodes
into garbage with no error raised anywhere.

**Invariant:** the IFD chain is cycle-guarded and every offset is bounds-checked
against the file length. A file may point its next-IFD at itself, and
`tiffPageCount` would then never return — the same class of guard as the
depth bound on `/UseCMap`.

**Invariant:** tag defaults are not all zero, and one is load-bearing.
`RowsPerStrip` defaults to 2³²−1, which means *the whole image is a single
strip*; defaulting it to 0 or 1 breaks every single-strip file, which is most
of them. `BitsPerSample`, `SamplesPerPixel`, `Compression`,
`PlanarConfiguration`, `Predictor` and `FillOrder` all default to 1.
`PhotometricInterpretation` has **no** default and its absence is damage, not a
shape to guess at.

## Blocks: strips and tiles are one thing

Both are a rectangular block of the image, separately compressed. A strip is
full-width by `RowsPerStrip`; a tile is `TileWidth` by `TileLength` on a grid
of `ceil(w/tw)` by `ceil(h/tl)`. One block loop serves both, differing only in
where each block's geometry comes from.

**Invariant:** codec state **resets per block**. For LZW and CCITT in
particular, concatenating the blocks and decoding once produces garbage after
the first one. This is the structural reason the loop exists, not a
convenience — and it is invisible to any single-block fixture.

**Invariant:** a partial edge **tile still contains a full tile of data** —
TIFF pads to the tile grid and the image is cropped out of it — whereas a final
**strip is genuinely short**. Treating an edge tile as short reads the next
tile's bytes as this one's remainder and misaligns every block after it.

**Invariant:** `decodeCcitt`'s `rows`, and `applyPredictor`'s `columns`, are the
**block's** dimensions, not the image's. With tiles those differ, and passing
the image's silently decodes the first tile plausibly and the rest wrongly.

## Compression routing

| Value | Route |
|---|---|
| 1 | block bytes used as-is |
| 2 | `decodeCcitt` with `k: 0`, `byteAlign: true` |
| 3 | `decodeCcitt`, `k: 1` when `T4Options` bit 0 is set else `k: 0`, `byteAlign` from bit 2 |
| 4 | `decodeCcitt` with `k: -1` |
| 5 | `lzwDecode(block, 1)` |
| 7 | JPEG, below |
| 8, 32946 | `inflateSync` |
| 32773 | `runLengthDecode` |

`decodeCcitt` reads `k` only for its **sign** — `< 0` is pure 2D, `0` is pure
1D, anything positive is mixed — so the particular positive value carries no
meaning and 1 is passed rather than T.4's conventional 4, which would suggest a
significance it does not have.

**Note, and the reason the length is asserted:** PDF's `RunLengthDecode` treats
byte 128 as end-of-data, while TIFF PackBits has no EOD marker and reserves
that value. Real encoders do not emit it, so the existing decoder is correct in
practice — but every block's decoded length is checked against what its
geometry needs, which turns a silent early stop into an error rather than a
half-black strip.

**JPEG (compression 7)** takes the cheapest faithful route, exactly as BMP's
`BI_JPEG` does: a single block, covering the whole image, with no `JPEGTables`
becomes an `embedded` result — a `DCTDecode` passthrough with no decode and no
re-encode. Otherwise each block is decoded through `decodeJpeg`, with
`JPEGTables` (tag 347) minus its trailing EOI prepended, which is the
abbreviated-datastream rule.

**Invariant:** photometric 6 (YCbCr) is refused for the raw-sample routes but
**accepted on the JPEG route**, because a JPEG datastream carries its own
colour transform and both `decodeJpeg` and a viewer's `DCTDecode` apply it.
This reads as an inconsistency, so it is stated rather than left to be
discovered.

## Photometric, palette and alpha

0 → `gray` with samples inverted · 1 → `gray` · 2 → `rgb` · 3 → `indexed` ·
5 → `cmyk`.

The `rgb` and `cmyk` arms carry no `bpc` and are 8-bit by construction, so
`BitsPerSample` other than 8 is refused for those two photometrics — sub-byte
multi-channel samples are outside Baseline and outside this scope. `gray` and
`indexed` carry their depth and accept 1, 2, 4 and 8.

**Invariant:** polarity is normalized in exactly one place, driven by the
photometric tag, and `gray` always means **DeviceGray: 0 is black**. TIFF says
the opposite half the time — `PhotometricInterpretation` 0 is WhiteIsZero,
which is what fax uses — and `decodeCcitt` emits 0 = white by its own
documented contract. Inverting in two places, or in neither, yields a
photographic negative, which reads as a bad scan rather than as a decoder bug.

**Invariant:** `ColorMap` (tag 320) is **three consecutive planes** — all reds,
then all greens, then all blues — not RGB triples, and its values are 16-bit
0–65535, not 0–255. Read as interleaved triples it produces a palette that is
wrong in a colourful and entirely plausible way; read as low bytes it produces
a nearly black one.

**Invariant:** `ExtraSamples` (tag 338) value 1 means **associated —
premultiplied — alpha, and it must be divided out**. PDF's `/SMask` composites
colour × alpha, so handing it premultiplied colour multiplies alpha in twice:
the image renders too dark, worst exactly where it is most transparent. Where
alpha is 0 the colour is undefined and 0 is emitted. Value 2 is unassociated
and passes through. Value 0 is *unspecified*, which is not a claim of
transparency — the channel is dropped and the image is opaque.

## Mapping to PDF

| Arm | Result |
|---|---|
| `indexed` | `/Indexed /DeviceRGB hival ‹palette string›` at its bpc |
| `gray` | `/DeviceGray` at its bpc |
| `rgb` | `/DeviceRGB` 8bpc, plus an 8-bit `/DeviceGray` `/SMask` when alpha is present |
| `cmyk` | `/DeviceCMYK` 8bpc |
| `embedded` | `buildJpegXObject` / `buildPngXObject` unchanged |

## Detection and the public surface

`sniff()` gains a TIFF branch: `II` followed by `42`, or `MM` followed by `42`,
each read in its own order. That is four bytes of structure rather than BMP's
two, so unlike BMP it needs no secondary check.

`AddImageOptions.format` becomes `'jpeg' | 'png' | 'bmp' | 'tiff'`, with the
same widening in `flow.ts`, `floatbox.ts` and `tableauthor.ts`.

**Invariant:** `AddImageOptions.page` is 0-based, defaults to 0, and **throws
when non-zero for a format that has no pages** rather than being silently
accepted. Accepting an option and ignoring it is the trap `textedit.ts`'s
`region` is already documented against — a caller who thinks they selected page
3 and got page 1 has no way to tell.

## Errors

`PdfParseError` for damage: bad magic, a truncated IFD, an offset outside the
file, a cyclic IFD chain, a missing `PhotometricInterpretation`, a block whose
byte count or decoded length falls short of what its geometry needs.

`UnsupportedFeatureError` for declined shapes: BigTIFF, `PlanarConfiguration`
2, photometric 4/6/8 outside the JPEG route, compression 6 and any unknown
compression, `BitsPerSample` outside {1, 2, 4, 8}, `Predictor` 3, and a page
index outside the file's IFD count.

A pixel-count bound guards `width * height` before any allocation, as `bmp.ts`
and `jbig2halftone.ts` already do.

## Testing, and what cannot be anchored

`test/tiff.test.ts` drives the pure decoder from `test/helpers/build-tiff.ts`,
a deliberately dumb builder that writes IFDs in **both** byte orders.

**This feature has no third-party anchor, and that is a real difference from
`10u9.2`.** BMP had two published annotated hex dumps to transcribe; TIFF has
no equivalent. What mitigates it, and what does not:

- The *payload* codecs are all existing repo code with their own suites and
  real-world fixtures — `ccitt.ts`, `lzw.ts`, flate, `jpeg.ts`, PackBits. What
  is genuinely new and unanchored is the container.
- **An `II` file and an `MM` file encoding the same image must decode
  identically.** The two take different paths through the reader, so a shared
  bug in the builder cannot make them agree. This is the one real differential
  available here and it is worth having.
- Everything else is hand-computed expectations against the builder, which is
  encoder-versus-decoder inside one repo and proves less than it looks.

The test header says so plainly, and a follow-up issue is filed for
real-producer TIFF fixtures beside `10u9.8`'s BMP one.

**Fixture traps.** BMP's three carry over — a vertically symmetric image cannot
see the row order, a grey image cannot see a channel swap, a square one cannot
see a transposition. TIFF adds two of its own: **a single-block image cannot
see the per-block codec reset**, so the LZW and CCITT cases need at least two
strips or they pass whatever the code does; and **a tile grid that divides the
image exactly cannot see the edge-tile padding rule**, so the tile case needs a
width that is not a multiple of `TileWidth`.

**Mutation verification** per CLAUDE.md, over at least: the byte-order swap,
the inline-value rule, the `RowsPerStrip` default, the per-block codec reset,
the edge-tile padding, the polarity normalization, the `ColorMap` plane layout,
and the premultiplied-alpha division. Findings go in the test header, naming
anything that stays green.

## Non-goals

- **Writing TIFF.** Nothing in this library emits raster files.
- **BigTIFF**, `PlanarConfiguration` 2, YCbCr and CIELab raw samples,
  old-style JPEG (6), 16- and 32-bit samples, floating-point predictor. Each
  refused with a named reason; any can become a follow-up if a real file needs
  it.
- **Turning a multi-page TIFF into multiple PDF pages.** `AddImage` embeds one
  image into one rectangle; `page` plus `tiffPageCount` lets a caller loop and
  decide the layout, which is a decision the library should not make for them.
- **Real-producer fixtures**, filed as a follow-up for the reason above.
