# TIFF test fixtures — provenance

TIFFs from encoders we did not write, here to validate `src/tiff.ts` against
bytes it did not produce. Issue `10u9.9`; the decoder itself is `10u9.3`, whose
design is `docs/superpowers/specs/2026-08-21-tiff-decode-design.md`.

**Why they exist.** `test/tiff.test.ts` drives the decoder from
`test/helpers/build-tiff.ts`, so its container expectations are hand-computed
against our own builder — encoder-versus-decoder inside one repo. A misreading
both halves share cancels out and the suite stays green. That file says so in
its own header rather than implying otherwise. These fixtures are the missing
anchor, and they earned their keep on the first run: see **What this found**.

---

## Producers

Neither is a dependency of this repo. Both were installed once **outside** it,
used, and uninstalled — the pattern `test/fixtures/jpeg/PROVENANCE.md` records.

| | Version | License | Writes |
|---|---|---|---|
| **libtiff** `732665c` via libvips 8.18.3 via [sharp](https://github.com/lovell/sharp) 0.35.3 | see left | Apache-2.0 (sharp), libtiff's own | Everything below except the `MM` file |
| **[utif2](https://github.com/image-js/utif)** 4.1.0 | 4.1.0 | MIT | `utif-rgba-mm.tif` |

**Why two.** They cover different halves and neither alone is enough. libtiff
writes what real-world files actually contain — LZW, Deflate, PackBits, JPEG,
G4, tiles, strips, CMYK — but only in **native byte order**, little-endian
here, and sharp exposes no knob for it. utif2 is an unrelated pure-JS
implementation that writes **big-endian**. Two independently written encoders
agreeing with our decoder is a stronger anchor than one, and it is what lets
the `II`/`MM` differential be made between two foreign encoders rather than
between two paths through our own builder.

Regenerate with:

```
mkdir /tmp/tiffgen && cd /tmp/tiffgen && npm init -y
npm install sharp@0.35.3 utif2@4.1.0
node <repo>/scripts/gen-tiff-fixtures.mjs --modules /tmp/tiffgen
```

That script is committed and is **not** run by `npm test`.

## The images are ours; only the bytes are third-party

The shared-convention bug class needs the **bytes** to come from elsewhere, not
the picture — so choosing our own source content is free, and choosing it means
every assertion can be exact rather than approximate. Both sources are frozen
here as the encoder saw them:

| File | What it is |
|---|---|
| `source-rgb.raw` | 20×12×3 interleaved RGB, the input to every RGB case |
| `source-bilevel.raw` | 20×12×1, the input to both G4 cases (0x00 / 0xff) |
| `libtiff-cmyk.source.raw` | 20×12×4, the CMYK input — see the CMYK note below |

They are 20×12 and deliberately asymmetric, against the fixture traps this repo
already records: **not square** (a transposition would show), **every row
differs** (a row-order flip would show), **every channel differs** (a channel
swap would show), the width is **not a multiple of the 16px tile** (so an edge
tile is partial and the padding rule is exercised), and **not a multiple of 8
bits** at 1bpp (so row padding is too).

## Ground truth comes from a third decoder

A fixture meant to catch a bug our writer and reader would agree on cannot take
its expected values from us either. At generation time each encoded file is
handed **back to libvips**, and its decode is frozen beside it as
`<name>.expected.raw`.

**Be precise about how independent that is.** libvips *uses libtiff* for TIFF
I/O, so for the container — strip and tile offsets, tags, predictor — the
round trip is one library on both sides. That still does the job, because the
bug class is *our* reader agreeing with *our* writer and both diverging from the
format, and libtiff is the format authority; but it is not two independent
parties, and an earlier draft of this file wrongly implied it was. Where the
comparison genuinely does cross implementations is the **codecs** — libvips
decodes the embedded JPEG with libjpeg, against our own `jpeg.ts` — and that is
exactly where it found a bug. `utif-rgba-mm.tif` is the one file that is
two-sided end to end: utif2 wrote it and libvips read it, and they share no
code.

**One exception, and it matters.** `libtiff-cmyk.expected.raw` is *not* used as
the oracle. libvips applies an ICC transform on the way out of a CMYK file, so
its read-back differs from the stored bytes by a few counts per channel
(measured: `22,9,169,252` stored against `21,9,185,248` read back) — close
enough to look like rounding, far enough to fail an exact compare. That file is
uncompressed, so the exact ground truth is the encoder input,
`libtiff-cmyk.source.raw`. The `.expected.raw` is kept for reference only.

---

## The files

| File | SHA-256 | Bytes | What it covers |
|---|---|---|---|
| `libtiff-g4-tiled.tif` | `254c3235…fddefd7f` | 310 | **The reason this directory exists.** CCITT G4 in 16×16 tiles across a 20px-wide image, so the right-hand tile is 4 columns of picture in a 16-column block — the only shape that separates the *block* width `decodeCcitt` must be told from the *image* width |
| `libtiff-g4-strips.tif` | `dac59f25…96837375` | 288 | The same picture, strip-organised (`RowsPerStrip` 4). Its differential partner: tiles and strips assemble differently and pass different widths, so a bug in either shows as the two disagreeing |
| `libtiff-lzw-tiled-pred.tif` | `42f0d25e…0d34d042` | 528 | LZW + predictor 2 across a tile boundary — block width ≠ image width for the un-differencing walk too |
| `libtiff-lzw-strips.tif` | `c096367f…b60e84ba` | 1058 | Multi-strip LZW, no predictor: pins the per-block codec reset, which a single-block image cannot see |
| `libtiff-packbits.tif` | `e72343c4…9e61e595` | 954 | PackBits (PDF's RunLengthDecode) |
| `libtiff-deflate-pred.tif` | `515d9162…1a56af7e` | 300 | Deflate + predictor 2 |
| `libtiff-cmyk.tif` | `908db7a2…bc68c253` | 1198 | Photometric 5, 4 samples per pixel, uncompressed |
| `libtiff-jpeg-rgb.tif` | `a8d1a0c8…2a3a437b` | 845 | Compression 7 with shared tables (tag 347 `JPEGTables`). **This is the file that found the bug below.** Note libvips picks photometric **2** at this quality, and writes the embedded stream with SOF component ids `'R','G','B'` |
| `utif-rgba-mm.tif` | `81e4d80d…3c2a459a` | 1960 | **Big-endian.** Uncompressed RGBA from an unrelated implementation |

## What this found

`libtiff-jpeg-rgb.tif` failed on its first run, and the cause was a real defect
in `src/jpeg.ts`, not in the fixture.

libtiff writes a JPEG-compressed RGB TIFF whose embedded stream carries SOF
component ids `'R','G','B'` (82/71/66) and **no** Adobe APP14 marker — the
standard signal that the components are already RGB. `combinePlanes` assumed any
three-component JPEG was YCbCr and applied the inverse transform regardless, so
the whole image decoded with R and B pinned near zero (`0,142,0` where the
source is `7,3,0`). Fixed by testing those ids, which is what libjpeg's own
`jpeg_default_colorspace` does; an Adobe marker still outranks them.

Nothing in `test/tiff.test.ts` could have caught it, because our builder never
writes that shape. `decodeJpeg` is shared, so PDF `DCTDecode` images carrying
RGB-component JPEGs were affected too.

## What these fixtures do NOT anchor

As load-bearing as the rest of this file. Neither producer can write these, so
they remain builder-anchored in `test/tiff.test.ts`:

- **Palette (photometric 3)** — sharp expands a palette to RGB on read and
  emits no `ColorMap`; utif2 writes RGBA only.
- **WhiteIsZero (photometric 0)** — every file here is BlackIsZero, G4 included.
- **CCITT RLE (compression 2) and Group 3 (compression 3)** — sharp accepts only
  `ccittfax4` of the CCITT family.
- **`FillOrder` 2**, **`PlanarConfiguration` 2** (a declared non-goal),
  **BigTIFF**, **16-bit samples**.
- **2- and 4-bit gray.** libtiff *can* write them, and they are deliberately
  left out: our decoder returns sub-8-bit samples still packed, while libvips
  expands them to 8 bits, so comparing the two needs a scaling convention that
  would be our claim rather than the file's. The 1bpp G4 files already exercise
  packed rows and their byte padding.
- **The `DCTDecode` passthrough route.** It requires a single-strip JPEG with no
  shared tables, and libtiff always emits `JPEGTables`, so this producer cannot
  reach it. `libtiff-jpeg-rgb.tif` exercises the decode path instead — which is
  the route real-world TIFFs actually take.
- **Associated (premultiplied) alpha.** utif2 declares `ExtraSamples=1` but does
  not premultiply its samples. Its alpha is 255 everywhere on purpose, where the
  two readings coincide; with partial alpha the fixture would be asserting our
  division rule against a producer that got the flag wrong.
- **Multi-page files.** Reachable from sharp only via `pyramid: true`, whose
  second IFD is a downsampled pyramid level rather than an independent image —
  not the shape `tiffPageCount` and `opts.page` are for.
