# BMP decode — design

Issue: `10u9.2`, under epic `10u9` (Colour and raster breadth, `gap-vs-go`).
Date: 2026-08-21.

Go has `bmp.go`; TS has nothing. `AddImage` accepts JPEG and PNG and refuses
everything else, and README's Limitations says so outright: "Other raster
formats are out of scope." This is the design for BMP input — a new pure
decoder in `src/bmp.ts` plus a `sniff()` branch, after which every existing
image consumer accepts BMP with no change of its own.

## Scope

Input only. BMP is not a PDF construct — there is no `BMPDecode` filter — so
nothing here touches reading, rendering or saving. A BMP is decoded to samples
at embed time and stored as `FlateDecode`, exactly as a PNG is; the saved file
carries no trace of having been a BMP.

The public surface is one widened union. `AddImageOptions.format` becomes
`'jpeg' | 'png' | 'bmp'`, and the same widening applies to the three other
option bags carrying that union — `flow.ts`, `floatbox.ts`, `tableauthor.ts`.
That is a widening, so no existing call changes meaning. There is no new
exported function: `decodeJpeg`, `decodeCcitt` and every other decoder in this
repo are internal, with `index.ts` exposing only `ImageInfo` and
`AddImageOptions`, and BMP follows them.

Consumers that gain BMP for free, none of them modified: `page.AddImage`,
`flow.AddImage`, `cell.setImage`, `FloatingBox`'s images, and a signature
appearance's `image`.

## Module layout

`src/bmp.ts` is pure: its only repo import is `errors.ts`, for the shared error
vocabulary — exactly what `jpeg.ts`, the closest analogue, imports. It never
learns that PDF exists, which is what lets every bit depth, mask rule and RLE
escape be tested from raw bytes with no document in sight — the split
`svgdraw.ts` / `svgembed.ts` and `docxflow.ts` / `docxexport.ts` already make.

```ts
export type BmpImage =
  | { kind: 'indexed'; width: number; height: number; bpc: 1 | 2 | 4 | 8;
      palette: Uint8Array;   // RGB triples, already swapped from BMP's BGR
      samples: Uint8Array }  // top-down, rows padded to a BYTE
  | { kind: 'rgb'; width: number; height: number;
      samples: Uint8Array;   // 8-bit RGB, top-down
      alpha?: Uint8Array }   // one byte per pixel, top-down
  | { kind: 'embedded'; format: 'jpeg' | 'png'; payload: Uint8Array };

export function decodeBmp(data: Uint8Array): BmpImage;
```

`imageembed.ts` gains `buildBmpXObject(img: BmpImage): BuiltImage`, a single
`switch` whose every arm reuses machinery the PNG path already built.

**Invariant:** the `embedded` arm is what keeps `bmp.ts` pure. BI_JPEG and
BI_PNG wrap a complete JPEG or PNG file inside the BMP container, so the
decoder slices the payload and names its format while `imageembed.ts` hands it
to `buildJpegXObject` / `buildPngXObject`. Decoding it inside `bmp.ts` would
give the module a dependency on JPEG decoding for a case that needs none.

**Invariant:** there is no `'gray'` kind. A grayscale BMP is a palette BMP
whose palette happens to be grey, and `/Indexed` carries it exactly; a third
kind would be a second spelling of the first. `palette` is likewise
non-optional on the `indexed` arm rather than optional across the union, so
"indexed with no palette" is unrepresentable rather than guarded at each use.

## The container

| Field | Rule |
|---|---|
| File header | 14 bytes: `BM`, `bfSize`, two reserved words, `bfOffBits` at offset 10 |
| DIB size | at offset 14: `12` CORE, `40` INFO, `52`/`56` V2/V3, `64` OS/2 v2, `108` V4, `124` V5 |
| Palette entry | 3 bytes (RGBTRIPLE) for CORE, 4 (RGBQUAD) otherwise — the one thing the header size changes downstream |
| Palette count | `biClrUsed` when non-zero, else `1 << bpp` |
| Pixel start | `bfOffBits` as given, not computed |
| Row order | `height < 0` is top-down; a positive height is bottom-up and its rows are reversed |
| Row stride | 4-byte aligned on the way in; restrided to byte-aligned on the way out |

**Invariant:** `bfOffBits` is respected rather than derived from
`14 + dibSize + paletteBytes`. Gap bytes between the palette and the pixel data
are legal and real producers emit them; a computed offset reads the gap as
pixels and shifts the whole image. It is validated against the file length, and
a file whose `bfOffBits` is zero or out of range is damage, not a variant to
accommodate.

**Invariant:** the 64-byte OS/2 v2 header is accepted by reading its first 40
bytes, which are INFOHEADER-compatible by construction. Refusing it would be a
refusal over fields we do not read.

## The pixel matrix

| bpp | Compression | Route |
|---|---|---|
| 1, 2, 4, 8 | BI_RGB | `indexed` — indices pass through but for restride and flip |
| 4 | BI_RLE4 | run-decode to indices, then the same `indexed` route |
| 8 | BI_RLE8 | as above |
| 16 | BI_RGB | RGB555, expanded to 8 bits |
| 16, 32 | BI_BITFIELDS, BI_ALPHABITFIELDS | masks located per the rule below, extracted by shift and width |
| 24 | BI_RGB | BGR → RGB |
| 32 | BI_RGB | BGR**X**: the fourth byte is padding and is dropped |
| 32 | with a declared alpha mask (below) | BGRA → `rgb` + `alpha` |
| any | BI_JPEG, BI_PNG | `embedded`, delegated |

2 bpp is not in Microsoft's BMP definition — it is a Windows CE extension —
but PDF's `/BitsPerComponent` admits 2, so the `indexed` route carries it at no
cost. It is accepted where encountered and not advertised.

**Where the masks live**, which differs by header and is easy to get subtly
wrong: a `40`-byte INFOHEADER stores them *after* the header, in the bytes the
palette would otherwise occupy — three 4-byte masks for BI_BITFIELDS, four for
BI_ALPHABITFIELDS. A `52`-byte V2 header contains three masks *inside* itself,
and `56` (V3), `108` (V4) and `124` (V5) contain four, the fourth being alpha.
Reading a V2/V3 header's masks from after it instead consumes the first palette
entries as masks and then reads pixels as palette.

**Invariant:** a palette image's indices are never expanded to RGB. The
`indexed` route is lossless, is smaller by up to 24×, and is the only route
that works at 1, 2 and 4 bits per component, where the samples are still packed
several pixels to a byte. This is the same rule `10u9.1` established for
greying an Indexed image by rewriting its palette alone.

**Invariant:** channel expansion is `round(v * 255 / max)`, not the
replicate-high-bits trick (`v << 3 | v >> 2` for 5-bit). The two agree at 0 and
differ by up to 1/255 in between, and only the first maps `max` to exactly 255
for every mask width — which is what a 6-bit green channel needs and a 5-bit
one hides.

**Invariant:** the fourth byte of a 32-bpp pixel is alpha only when the header
*declares* it — BI_ALPHABITFIELDS, or a header carrying an alpha-mask field
(`56`, `108`, `124`) whose value is non-zero. A plain BITMAPINFOHEADER 32-bpp
BI_RGB file is BGRX and the byte is dropped. Honouring it unconditionally is the failure that hides: such padding
is very commonly zero across the whole image, so the picture becomes fully
transparent — drawn, correct in every structural assertion, and invisible.

**Invariant:** pixels an RLE stream never writes stay index 0 — after a delta
escape, or where a row ends before its width. The format leaves them undefined,
0 is what decoders in the wild produce, and it is the only choice whose output
cannot depend on uninitialized memory. RLE absolute-mode runs are word-aligned;
the escapes are `00 00` end-of-line, `00 01` end-of-bitmap, `00 02 dx dy`
delta.

## Detection

`sniff()` gains a BMP branch returning `'bmp'`, and its error message becomes
"expected JPEG, PNG or BMP".

**Invariant:** the branch requires *both* the `BM` magic and a known DIB header
size at offset 14. `BM` is two bytes against PNG's eight and JPEG's two-plus-
structure, so magic alone claims any file that happens to start with those
bytes and then fails deep inside the decoder with a message about a header
field, rather than at the front door with "unrecognized image format".

## Mapping to PDF

| Arm | Result |
|---|---|
| `indexed` | `imageStream(w, h, bpc, [/Indexed /DeviceRGB hival ‹palette string›], flate(samples))` |
| `rgb` | `imageStream(w, h, 8, /DeviceRGB, flate(samples))` |
| `rgb` + `alpha` | the above, plus `smask = imageStream(w, h, 8, /DeviceGray, flate(alpha))` |
| `embedded` | `buildJpegXObject(payload)` / `buildPngXObject(payload)` |

`hival` is the palette entry count minus one. The alpha arm is byte-for-byte
the shape `buildPngXObject` already produces for colour type 6, which is why it
needs no new machinery and no new test of the `/SMask` mechanism itself.

## Errors

`PdfParseError` for damage: truncation, a DIB size outside the six known
values, `bfOffBits` outside the file, a palette running into the pixel data, an
RLE run overrunning its row.

`UnsupportedFeatureError` for shapes we decline: a bpp outside
{1, 2, 4, 8, 16, 24, 32}, an unknown compression value, a compression that does
not match its bpp (BI_RLE4 outside 4 bpp, BI_RLE8 outside 8, bitfields outside
16 and 32), and a top-down RLE image — which the format forbids outright, so
accepting it would mean inventing a reading.

A pixel-count bound guards `width * height` before any allocation, as
`jbig2halftone.ts`'s pattern dictionary does for the one place a product of
header fields sizes a buffer.

**Invariant:** a V5 embedded ICC profile is ignored and the image treated as
sRGB, rather than refused. Visible ink beats a refused call — the rule
`svgdraw.ts` sets for an element it cannot render fully — and the alternative
is declining files that render correctly everywhere else.

## Testing

`test/bmp.test.ts` drives the pure decoder from `test/helpers/build-bmp.ts`,
which sweeps the matrix above.

**The anchor** is the two complete annotated hex dumps published in the BMP
format documentation — a 2×2 24-bit BITMAPINFOHEADER file and a 4×2 32-bit
BITMAPV4HEADER file with alpha — transcribed as byte literals and asserted
pixel for pixel. This repo's standing rule is that a differential test cannot
validate the parser it runs through, and for a format we only ever *read*, our
builder and our decoder can agree on a misreading with nothing to contradict
them. Those two dumps are byte sequences we did not author, which is the whole
point of including them; they are the BMP counterpart of T.88's published SLTP
constants.

`test/bmp-embed.test.ts` goes end to end through `page.AddImage`: the
`/Indexed` palette survives into the XObject, `/SMask` appears exactly when the
header declared alpha and is absent for BGRX, and a `Save()` round trip renders
the expected pixels.

**Fixture traps, to be designed around rather than discovered.** A vertically
symmetric image cannot see the row flip. A grey image cannot see the BGR swap.
A square image cannot see a width/height transposition. Every fixture is
therefore asymmetric on both axes, non-grey, and non-square, or the assertion
built on it passes whatever the code does.

**Mutation verification** per CLAUDE.md: break the row flip, the BGR swap, the
4-byte stride strip, the alpha-declaration rule and the `bfOffBits` read in
turn, and record which cases actually redden. The findings go in the test
file's header, naming anything the suite provably does not cover, rather than
a claim that it does.

## Documentation

README's Features line for image insertion, the API overview rows, and the
Limitations entry at "Image insertion is JPEG/PNG only" — which currently ends
"Other raster formats are out of scope" and must stop saying so. One limitation
is added by name: a V4/V5 file that declares an alpha mask and then writes
zeros everywhere renders fully transparent. That is the producer contradicting
itself and honouring the declaration is the defensible reading, but it is the
failure that will look like our bug, so it is written down rather than guarded.

CHANGELOG under `## [Unreleased]`, **Added**.

## Non-goals

- **Writing BMP.** Nothing in this library emits raster files; `Optimize`'s
  image pass encodes JPEG and `pngencode.ts` serves `ToImage`. There is no
  caller for a BMP encoder.
- **An embedded ICC profile from a V5 header.** Read as sRGB, documented. A
  follow-up if a real file ever needs it.
- **A real-producer fixture directory** (`test/fixtures/bmp/` with a
  `PROVENANCE.md`, as `fixtures/jpeg` and `fixtures/pdfx` have). No image
  tooling is available on this machine — `magick`, `python` and `ffmpeg` are
  all absent — so the published hex dumps are the anchor for now. Filed as a
  follow-up.
- **TIFF** is `10u9.3` and reuses `ccitt.ts`. Its decoder will want the same
  normalized-raster shape `BmpImage` describes, but that type is defined
  minimally for BMP here and generalized when a second caller actually exists,
  not before.
