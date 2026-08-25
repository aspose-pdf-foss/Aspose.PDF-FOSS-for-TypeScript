# Coefficient-domain JPEG greying — design

Issue: `10u9.6`, under epic `10u9` (Colour and raster breadth, `gap-vs-go`).
Date: 2026-08-24.

`ConvertToGrayscale` greys a `DCTDecode` image by decoding it to RGB samples,
computing Rec. 601 luma per pixel, and re-encoding as a grey JPEG at
`opts.quality` — which sets `report.lossy`. A baseline JPEG's **Y channel is
already Rec. 601 luma**, so for a YCbCr JPEG that whole round trip is
re-deriving, lossily, a number the file already contains exactly.

This is the design for the direct route: keep component 0's quantized
coefficients and its quantization table verbatim, drop the two chroma
components, and re-emit a one-component baseline JPEG. No IDCT, no FDCT, no
requantization — an exact, generation-free greying that also produces a smaller
file.

## The issue's premise is half wrong, in our favour

The issue says this "needs a coefficient-level transcoder the repo does not
have". The **decode half already exists**: `Comp.blocks` (`jpeg.ts`) holds
quantized coefficients in **natural** order, and `assemble` is the only place
they meet the quantization table. Baseline, progressive and arithmetic scans all
normalize into that same array before anything is dequantized.

What is missing is narrower than a transcoder:

1. an entry point that hands back the `Frame` rather than samples — `decodeJpeg`
   builds one and throws it away; and
2. the **encode** half, which exists but is unreachable: `codeBlock`, `traverse`
   and the marker assembly are closures inside `encodeJpeg`, reachable only by
   handing it 8-bit samples.

So the work is an extraction on both sides plus a thin module between them.

## Scope

**Takes the exact route:** any 8-bit, 3-component, DCT-based JPEG whose
effective colour transform is not 0 — baseline, progressive and arithmetic
alike. They all land in the same `blocks` array, so covering the latter two is
nearly free, and it turns today's worst case (a progressive JPEG, decoded and
re-encoded) into an exact one. Output is always **baseline Huffman**, whatever
the input's coding.

**Declines to the existing route:** CMYK and YCCK (component 0 is not luma),
12-bit precision (the writer emits 8-bit), lossless (SOF3) and hierarchical
(no DCT blocks at all), 1-component (already grey; a component-count mismatch
against the `/ColorSpace` is a different bug and stays skipped as today), and
any 3-component file whose transform is 0.

A decline is **not** a `skipped` entry. The image converts either way; `route`
is what says which.

## The trap that decides eligibility

A JPEG whose SOF component ids are `'R'`, `'G'`, `'B'` (0x52/0x47/0x42) carries
transform 0: component 0 is **red, not luma**. Keeping it would emit the red
channel as "grey" — a picture that looks like a plausible photograph, with
nothing anywhere to flag it. libtiff writes exactly that shape for a
JPEG-compressed TIFF whose photometric is RGB, which is why `10u9.9` added the
fixture class and why `combinePlanes` grew the rule in the first place.

So the rule gets **one owner**. `jpegTransform(frame, adobe)` is lifted out of
`combinePlanes`, which then calls it, and `jpegtranscode.ts` calls it too. A
second copy is precisely how the decoder and the transcoder would come to
disagree about one file — and the disagreement renders rather than throws.

## Module layout

| File | Change |
|---|---|
| `src/jpeg.ts` | **+** `decodeJpegFrame(data)`: the existing marker walk and scan decode, returning `{ frame, qt, adobe }`. `decodeJpeg` becomes that call plus `assemble`. **+** `jpegTransform(frame, adobe)`, extracted from `combinePlanes`. |
| `src/jpegcoef.ts` | **new, pure.** `encodeJpegFromBlocks(spec)`: quantized blocks in natural order + quant tables + geometry → JPEG bytes. |
| `src/jpegencode.ts` | `encodeJpeg` keeps `toPlanes`, subsampling, `scaleQuantTable`, `fdct8x8`, `quantizeBlock`, then calls `encodeJpegFromBlocks`. Public signature unchanged. |
| `src/jpegtranscode.ts` | **new, pure.** `greyJpegFromCoefficients(bytes)`: the eligibility test plus the drop-chroma splice. |
| `src/grayimage.ts` | The `isDct` branch tries the transcoder first; on decline, today's path unchanged. |
| `src/grayconvert.ts` | `GrayImageResult.route` gains `'jpeg-exact'`. |

`jpegcoef.ts` and `jpegtranscode.ts` are pure — no `Document`, no PDF objects —
so every rule below is testable from raw bytes, the split `bmp.ts` and
`psfunc.ts` already make.

### Interfaces

```ts
// jpegcoef.ts — the encoder's back half, shared by both producers.
export interface CoefComponent {
  /** Quantized coefficients, ZIG-ZAG order, `blocksPerLine * blocksPerColumn`
   *  blocks of 64. */
  blocks: Int32Array;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Sampling factors, relative to the frame. */
  h: number;
  v: number;
  /** Quantization table slot. */
  tq: number;
  /** Huffman table slot. */
  td: number;
}

export interface CoefFrame {
  width: number;
  height: number;
  comps: CoefComponent[];
  /** Quantization tables in NATURAL order, indexed by `tq`. */
  quant: Int32Array[];
  /** Emit an APP0 JFIF header. False for CMYK, as today. */
  jfif: boolean;
  optimizeHuffman: boolean;
}

export function encodeJpegFromBlocks(frame: CoefFrame): Uint8Array;
```

```ts
// jpegtranscode.ts
export type TranscodeResult =
  | { kind: 'ok'; data: Uint8Array; width: number; height: number }
  | { kind: 'decline'; reason: string };

export function greyJpegFromCoefficients(data: Uint8Array): TranscodeResult;
```

**Zig-zag is the interface**, and the choice is load-bearing in two directions.
JPEG entropy coding is *defined* over the zig-zag sequence — a run length counts
zeros along it — so that is the order the module actually speaks;
`quantizeBlock` already writes it (`jpegfdct.ts`) and `codeBlock` already reads
it, which means `encodeJpeg` crosses the new boundary unchanged and the
byte-identity fence has nothing to catch. The decoder's `Comp.blocks` is
**natural** order, so the one transposition in the system lives in
`jpegtranscode.ts`, on the new path only.

Making natural order the interface instead would invert both: it would change
`quantizeBlock`, a tested pure function, and add a transposition to every block
of every ordinary encode to serve the rarer caller. Whichever order is chosen,
exactly one side transposes; this is the side where a mistake is cheap to find,
because the transcoder's structural test compares coefficients directly.

The **quantization tables run the other way**, and the asymmetry is easy to get
backwards. `CoefFrame.quant` is **natural** order, because that is what
`scaleQuantTable` produces and what `encodeJpeg` already passes; the DQT writer
re-zigzags on the way out (`quant[t][ZIGZAG[k]]`). But `parseDQT` stores the
**wire** order it read, which is zig-zag — `assemble` is where it is currently
de-zigzagged, with `qn[ZIGZAG[k]] = q[k]`. So the transcoder converts the table
it took from the input, while passing the blocks straight through. Blocks
zig-zag, tables natural, in the same function: it is worth writing the direction
into the local names rather than trusting the reader to keep them apart.

## The splice

Component 0's blocks sit on the **original** MCU grid. At 4:2:0 that is
`ceil(w/16) * 2` columns, while a one-component frame needs `ceil(w/8)`. Those
differ by one whenever `w mod 16` falls in 1..8, and likewise for rows. The
padding blocks are **dropped**, not re-emitted.

`testorig.jpg` is 227×149 at 4:2:0, and lands in the trap on both axes:
227 mod 16 = 3 and 149 mod 16 = 5, so 30 columns become 29 and 20 rows become
19. Re-emitting them produces a file that still decodes — just wider and taller
than its own SOF claims, which viewers crop.

Everything else about the output:

- **Quantization table**: component 0's, verbatim, as slot 0. This is what makes
  the route exact; `opts.quality` has no meaning here and governs only the
  fallback.
- **Sampling**: the output component is 1×1 in a one-component frame.
- **Huffman tables**: rebuilt optimal for the new stream. The input's were tuned
  for three interleaved components, and progressive and arithmetic inputs carry
  no baseline tables at all.
- **Restart intervals**: dropped. The output is one continuous scan, so a DRI
  would be a lie.
- **Markers**: SOI, APP0 JFIF, DQT, SOF0, DHT, SOS, entropy, EOI.

## Data flow

```
isDct → greyJpegFromCoefficients(inflate(stream))
        ├─ ok      → geometry check against the dict → rebuild(…, 'DCTDecode')
        │            route: 'jpeg-exact',  lossy NOT set
        └─ decline → decodeJpeg → greySamples → encodeJpeg(quality)
                     route: 'jpeg',        lossy set
```

The dict-versus-JPEG geometry guard and the component-count guard stay exactly
where they are and apply to both routes; only the encode half branches.

**A deliberate cost, recorded as a decision rather than an oversight:** a
decline pays a second parse of the same bytes, because the transcoder discards
its `Frame` and the fallback then calls `decodeJpeg`. Sharing it would mean
exporting the sample-assembly step and moving JPEG internals into
`grayimage.ts`. One extra entropy decode on the uncommon path is the cheaper
price.

## Error handling

`greyJpegFromCoefficients` **declines** rather than throwing, for everything —
an unsupported shape and a malformed file alike. A malformed JPEG then reaches
`decodeJpeg` in the fallback, where `grayscaleImage`'s existing `catch` reports
`decode failed: …` into `skipped` exactly as today. One error path, not two.

## What changes for a caller

`report.lossy` stays **false** for a document whose JPEGs all take the exact
route — the headline change, since today any RGB JPEG sets it.

The exact route's output is **not** byte-identical to today's for the same
image: `YCbCr → RGB → Rec. 601 luma` round-trips through two clampings and lands
within about ±1 of the Y plane rather than on it. The coefficient path is the
more faithful of the two. Existing assertions that compare grey samples against
`greySamples` must therefore say which route they mean.

## Testing

**Written and confirmed red before the extraction**, because the whole refactor
rests on it: `test/jpeg-encode-identity.test.ts` pins the sha256 of `encodeJpeg`
output for gray, RGB 4:4:4, RGB 4:2:0 and CMYK at two qualities, and is verified
to go red on a deliberate one-LSB nudge to a quantization table. The existing
round-trip tests assert decoded pixels, so a change in Huffman table selection
or in marker order that still decodes identically would slip past them. This is
a **fence**, not a golden to refresh when it goes red.

Then, in `test/jpeg-transcode.test.ts`:

- **Exactness**, over `testorig.jpg` (baseline) and `testimgari.jpg`
  (arithmetic): decode the transcoded output and assert it is byte-identical to
  the Y plane the *original* decode produced. The anchor is the input file's own
  luma, not our encoder.
- **Structural**: re-parse the output and assert component 0's quantized blocks
  and its quantization table equal the input's. This asserts coefficient
  preservation without going through pixels at all — the claim the feature
  actually makes.
- **The padding trap**: `testorig.jpg` covers it on both axes; a built 20×20
  4:2:0 case asserts the output's block counts directly, so a failure names the
  arithmetic rather than showing a wrong picture.
- **The transform trap**: an `'R','G','B'`-id JPEG declines, asserted both as
  `route: 'jpeg'` *and* as the output being the luma rather than the red
  channel. A route assertion alone would pass for a build that took the exact
  path and happened to be checked on a grey-ish image.
- **Declines**: CMYK, YCCK, 12-bit, lossless, 1-component.

And end to end in `test/grayscale-convert.test.ts`: `route: 'jpeg-exact'` with
`lossy: false`, beside the existing `'jpeg'` case.

### A real progressive fixture

`testimgint.jpg` is a second **baseline** encoder config, not progressive, so
the vendored set covers progressive nowhere. Building one by hand would measure
our encoder against our decoder — the trap `PROVENANCE.md` names.

`test/fixtures/jpeg/PROVENANCE.md` already documents the recipe for this exact
situation: install the `mozjpeg` npm package (v8.0.0, MIT) one-off, run its
vendored `cjpeg.exe`, commit the frozen output, remove the package. So:

```
cjpeg -revert -progressive -quality 90 -outfile testorig-prog.jpg testorig.ppm
```

over the same `testorig.ppm` source the vendored files came from, keeping the
lineage and the 227×149 padding-block geometry. `PROVENANCE.md` gains the file,
its SHA-256, and the command line, in the existing table.

If mozjpeg cannot be installed on the box, the fallback is to record the gap in
the test file rather than to fake it with a hand-built stream.

## Out of scope

- **Coefficient-domain anything else.** No crop, no rotate, no requantization.
- **A public export.** `encodeJpegFromBlocks` and `greyJpegFromCoefficients`
  stay internal until a second caller exists.
- **Progressive output.** The output is always baseline, whatever went in.
- **`/SMask` and `/Decode`.** Unchanged; the existing guards run first.

## Documentation

`CHANGELOG.md` under `[Unreleased]`, and `README.md` in both places that
currently describe the JPEG route as lossy (the Features bullet and the
grayscale section). The `src/` architecture entry for the JPEG modules is
`10u9.11`'s job, not this issue's.
