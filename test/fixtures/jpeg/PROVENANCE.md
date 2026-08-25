# JPEG test fixtures — provenance

JPEGs from trusted third-party encoders, here to validate `decodeJpeg` against
bytes it did not produce. See
`docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md`.

Two classes live here, and the difference decides how tightly each can assert:

| Class | Files | Image content | Ground truth |
|---|---|---|---|
| **Vendored** | `testorig` / `testimgint` / `testimgari` | libjpeg-turbo's, not ours | `testorig.ppm`, upstream's uncompressed original |
| **Generated** | `synth-gray-*`, `synth-rgb444-*` | **ours, by design** | the `.pgm`/`.ppm` beside it — the exact encoder input |
| **Generated (CMYK)** | `synth-cmyk-*` | **ours, by design** | `synth-cmyk.raw`, the exact encoder input |

Both catch the shared-convention bug class, because in both the *bytes* come from
a real encoder rather than from `test/helpers/build-jpeg*.ts`. Only the choice of
image differs.

---

## Vendored — libjpeg-turbo `testimages/`

**Upstream:** https://github.com/libjpeg-turbo/libjpeg-turbo
**Pinned commit:** `cce89f35f9b6718ae662604a620aa506fbd6e579` (2026-07-16)
**Path:** `testimages/` (except `LICENSE-IJG.txt`, which is the repo-root `README.ijg`)

| File | SHA-256 | What it is |
|---|---|---|
| `testorig.jpg` | `acc6ec55…8bec73b` | libjpeg baseline: JFIF APP0, SOF0, 227×149, 4:2:0, component IDs 1/2/3 |
| `testimgint.jpg` | `491679b8…dcb90963` | same image, second baseline encoder config |
| `testimgari.jpg` | `4672c7f0…e8c89b38` | same image, SOF9 arithmetic + DAC (T.81 default conditioning) |
| `testorig.ppm` | `4afe49cb…3691a002` | the **uncompressed original**: P6, 227×149, maxval 255 |

### testorig.ppm is the source, not a reference decode

`testorig.ppm` is the image libjpeg *compressed to produce* the JPEGs above — it
is not libjpeg's decode of them. Verified empirically: our decode of
`testorig.jpg` differs from it by mean absolute error 1.365 with a max of 34. A
reference decode would agree within ~1 LSB (IDCT variance); a max of 34 is lossy
loss on high-detail edges.

Consequence: assertions against it must be statistical. Per-pixel tolerance
(`near(a, b, 3)`, as `test/jpeg.test.ts` uses against synthetic fixtures) is the
wrong instrument and will fail.

---

## Generated — mozjpeg `cjpeg` over a source we designed

Covers the two configs libjpeg-turbo's `testimages/` does not ship (`ehd`):
1-component grayscale, and 3-component RGB with **no chroma subsampling**.

**Encoder:** `mozjpeg version 3.1 (build 20150904)`, the `cjpeg.exe` vendored by
the `mozjpeg` npm package v8.0.0 (MIT). mozjpeg is a libjpeg-turbo fork, so these
bytes share the libjpeg lineage of the vendored set above.

**Installed one-off and removed.** The encoder is *not* a dev dependency: it ran
once at authoring time, and what is committed is its frozen output. Running the
test suite needs nothing but the bytes in this directory, so the zero-dependency
and hermetic-test conventions hold. This is the same shape as `fonts/` vendoring
TTFs without anyone needing a font compiler.

| File | SHA-256 | What it is |
|---|---|---|
| `synth-gray-baseline.jpg` | `eda86029…f564c48` | JFIF APP0, SOF0, 61×37, **nc=1**, 1×1 |
| `synth-rgb444-baseline.jpg` | `a625efb3…17b578e` | JFIF APP0, SOF0, 61×37, **nc=3, all components 1×1 (4:4:4)**, IDs 1/2/3 |
| `synth-gray.pgm` | `c24c8d28…79bab72` | encoder **input** for the above: P5, 61×37, maxval 255 |
| `synth-rgb.ppm` | `8868fbe5…0f406c1` | encoder **input** for the above: P6, 61×37, maxval 255 |
| `testorig-prog.jpg` | `3190dce1…016c52aa` | JFIF APP0, **SOF2 progressive**, 227×149, 4:2:0, IDs 1/2/3 — encoded from `testorig.ppm`, the vendored set's own source |

### Command lines

```
cjpeg -revert -baseline -quality 90 -grayscale    -outfile synth-gray-baseline.jpg   synth-gray.pgm
cjpeg -revert -baseline -quality 90 -sample 1x1   -outfile synth-rgb444-baseline.jpg synth-rgb.ppm
cjpeg -revert -progressive -quality 90            -outfile testorig-prog.jpg         testorig.ppm
```

`-revert` restores stock libjpeg defaults (Annex K quantization tables, no
mozjpeg trellis), so the output is canonical libjpeg-lineage rather than
mozjpeg-flavoured. `-baseline` is required because mozjpeg defaults to
progressive. `-sample 1x1` is what makes the RGB file 4:4:4.

`testorig-prog.jpg` (added for `10u9.6`) is the only file here covering **SOF2**,
and it is deliberately encoded from `testorig.ppm` rather than from the 61×37
synthetic source: that keeps the vendored set's lineage *and* its 227×149
geometry, where 227 mod 16 = 3 and 149 mod 16 = 5 both land in the range that
makes the Y plane's MCU-padded block grid one wider and one taller than a
one-component frame needs. `-progressive` is mozjpeg's default and is stated
explicitly only because the two synthetics above pass `-baseline` to suppress
it. A progressive scan reaches `Comp.blocks` through successive approximation
rather than in one pass, and before this file nothing in the suite read a
progressive JPEG we had not written ourselves.

### Why the source images look the way they do

**61×37**: both dimensions are non-multiples of 8, so both edges carry a partial
MCU.

**Low-frequency content** (flat regions, an edge, a smooth ramp, 8px bars): we
chose it, so we chose the loss. Decoded error lands at mean 0.2503 / max **3**
(gray) and 0.7734 / max **6** (RGB), against the vendored set's 1.365 / max 34 on
content nobody picked. That is what lets these assert an order of magnitude
tighter. Fidelity content is not what real fixtures are for: every realistic
breakage in this class — swapped component order, wrong upsampling, a bad quant
table — is gross, not subtle.

**Distinct per-channel content** in `synth-rgb.ppm`: R ramps on x, G ramps on y,
B is bars, and the flat top-left corner is `32,96,160` — three different values.
A component-order swap therefore cannot alias into a pass; the corner pins order
exactly, with no lossy excuse because the region is flat.

### Measured (thresholds in `jpeg-real.test.ts` carry headroom over these)

| Fixture | mean abs err | max | within 2 | within 8 |
|---|---|---|---|---|
| `synth-gray-baseline.jpg` | 0.2503 | 3 | 99.69% | 100% |
| `synth-rgb444-baseline.jpg` | 0.7734 | 6 | 97.90% | 100% |

---

## Generated — magick-wasm and sharp over a CMYK source we authored

Covers the config neither of the above can reach (`66o`): 4-component CMYK with
an Adobe APP14 marker, in **both** transforms.

**Encoders:** `@imagemagick/magick-wasm` v0.0.41 (ImageMagick 7.1.2-25 Q8,
Apache-2.0) and `sharp` v0.35.3 (libvips, Apache-2.0). **Both installed one-off
and removed**, same as `cjpeg` above: what is committed is frozen output, so the
suite needs nothing but these bytes.

**Two encoders is forced, not a preference.** Neither can produce the other's
file:

| Encoder | APP14 | Why |
|---|---|---|
| magick-wasm | **`transform=2`** (YCCK) | always — `jpeg:colorspace` = `cmyk`/`0`/`4`/`12` and an explicit `colorSpace=CMYK` all produce byte-identical output |
| sharp | **`transform=0`** (plain CMYK) | libjpeg's `jpeg_default_colorspace` maps `JCS_CMYK`→`JCS_CMYK`; IM only gets YCCK by explicitly overriding it |

Setting `img.colorSpace = ColorSpace.YCCK` in magick-wasm is **not** a way to
select the transform: it converts pixels, yielding a 3-component JFIF file with
K dropped.

| File | SHA-256 | What it is |
|---|---|---|
| `synth-cmyk-t0-baseline.jpg` | `7194a7ab…13a2b62` | APP14 **transform=0**, SOF0, 61×37, **nc=4**, all 1×1 |
| `synth-cmyk-ycck-baseline.jpg` | `4b7e4462…4308120` | APP14 **transform=2** (YCCK), SOF0, 61×37, **nc=4**, all 1×1 |
| `synth-cmyk.raw` | `10145c85…5e2ded4` | encoder **input** for both: headerless, 61×37×4 interleaved C,M,Y,K |

### The source is ours, with no colour conversion in the way

Both encoders read CMYK directly, so `synth-cmyk.raw` **is** the exact input they
saw — the same standing `synth-rgb.ppm` has for the `cjpeg` set. No RGB→CMYK
conversion happens, so no encoder's colour management contaminates the reference.

61×37 for the same reason as the `cjpeg` set (partial MCU on both edges). C ramps
on x, M ramps on y, Y is 8px bars, K is flat 128; the flat corner is
`32,96,160,64` — **four distinct values**, so a channel swap cannot alias into a
pass, and a flat region gives a dropped Adobe inversion no lossy excuse.

### Regenerating: `pipelineColourspace` is mandatory

```js
// magick-wasm, transform=2:
const settings = new MagickReadSettings({ format: MagickFormat.Cmyk, width: 61, height: 37, depth: 8 });
ImageMagick.read(raw, settings, (img) => {
  img.quality = 90;
  img.settings.setDefine(MagickFormat.Jpeg, 'sampling-factor', '1x1');
  img.write(MagickFormat.Jpeg, (d) => writeFileSync('synth-cmyk-ycck-baseline.jpg', d));
});

// sharp, transform=0. sharp has no raw-CMYK input path, so IM writes an
// uncompressed CMYK TIFF as a carrier (scaffolding, deliberately not committed).
await sharp('synth-cmyk.tif')
  .pipelineColourspace('cmyk')   // MANDATORY
  .toColourspace('cmyk')
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
  .toFile('synth-cmyk-t0-baseline.jpg');
```

Without `pipelineColourspace('cmyk')`, libvips loads the CMYK TIFF, converts it
to **sRGB** for its working pipeline, and converts back on write — while still
emitting a perfectly plausible `transform=0` file:

| Variant | mean abs err | max | corner (want `32,96,160,64`) | bytes |
|---|---|---|---|---|
| `toColourspace` alone | **32.327** | 213 | `0,84,169,92` ✗ | 1,521 |
| `pipelineColourspace` + `toColourspace` | **0.062** | 3 | `32,96,160,64` ✓ | 642 |

Neither embeds an ICC profile and their marker structure is identical, so the
2.4× size gap is pixel data: the naive variant simply encodes a wrong image. The
failure is quiet — a mean of 32 reads as "CMYK is lossy" and invites loosening
the threshold, which would bake libvips's sRGB round-trip into the reference and
leave a fixture that cannot tell a regression from its own noise. **If a
regenerated `synth-cmyk-t0-baseline.jpg` is ~1,521 bytes, it is wrong.**

### Measured (thresholds in `jpeg-real.test.ts` carry headroom over these)

| Fixture | mean abs err | max |
|---|---|---|
| `synth-cmyk-t0-baseline.jpg` | 0.062 | 3 |
| `synth-cmyk-ycck-baseline.jpg` | 0.680 | 8 |

YCCK's ~10× higher error is expected, not a defect: it carries an extra lossy
YCbCr↔CMY conversion.

---

## Licence

`LICENSE-IJG.txt` is upstream's `README.ijg`, **verbatim and unaltered** —
IJG licence condition (1) requires it be included with its copyright and
no-warranty notice unmodified. Do not edit it. Notes belong in this file instead.

The `synth-*` files are our own work product (source images designed here, output
of an MIT-licensed encoder) and carry no third-party licence obligation.

These fixtures are not redistributed to npm consumers: `package.json` declares
`files: ["dist"]`, so `test/` never enters the published tarball.

## Coverage

| Config | Fixture |
|---|---|
| RGB 4:2:0 baseline | `testorig.jpg`, `testimgint.jpg` |
| RGB 4:2:0 arithmetic (SOF9 + DAC) | `testimgari.jpg` |
| Grayscale baseline (1 component) | `synth-gray-baseline.jpg` |
| RGB 4:4:4 baseline (no subsampling) | `synth-rgb444-baseline.jpg` |
| **CMYK / Adobe APP14, transform=0** | `synth-cmyk-t0-baseline.jpg` |
| **CMYK / Adobe APP14, transform=2 (YCCK)** | `synth-cmyk-ycck-baseline.jpg` |
| **RGB 4:2:0 progressive (SOF2)** | `testorig-prog.jpg` |

`testimgari.jpg` earned its keep immediately (`aspose-pdf-foss-for-ts-hof`): it
decoded to garbage because `parseDAC` read the DC conditioning byte's L/U
nibbles in the wrong order, and our own JPEG builders wrote them in that same
wrong order — so the synthetic round-trip suite could never see it. libjpeg
emits a DAC on every arithmetic frame, even one carrying the T.81 defaults, so
this fixture is the only thing in the tree that exercises that byte for real.

Unlike `testimgari.jpg`, the CMYK pair found **no bug** — the Adobe inversion and
YCCK math were already right. They are a guard, not a fix: every other CMYK path
in the tree agrees with itself by construction, so these are the only bytes that
could catch drift. Verified load-bearing rather than merely green — disabling the
inversion in `cmyk()` fails the corner assertions on `223,159,95,191`.
