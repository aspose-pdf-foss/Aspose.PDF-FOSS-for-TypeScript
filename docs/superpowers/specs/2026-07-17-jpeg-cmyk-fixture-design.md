# CMYK / Adobe APP14 JPEG Fixture — Design

**Issue:** aspose-pdf-foss-for-ts-66o · Real-world CMYK / Adobe APP14 JPEG fixture
**Date:** 2026-07-17
**Parent:** `docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md` (w6m), split from `ehd`

## Problem

The last uncovered JPEG config, and the one where the blind spot is structural
rather than accidental.

`src/jpeg.ts`'s `cmyk()` (jpeg.ts:345) implements two conventions that exist
purely by shared agreement between encoder and decoder:

1. **The Adobe inversion.** If an APP14 `Adobe` marker is present, all four
   channels are stored inverted (`c = 255 - c`, …).
2. **The YCCK transform** (`transform=2`): the first three channels are YCbCr and
   need a YCbCr→RGB→CMY conversion, distinct from plain CMYK (`transform=0`).

Nothing in the tree checks either against bytes we did not write:

- `test/helpers/build-jpeg-arith.ts:234` and `test/helpers/build-jpeg-lossless.ts`
  write the APP14 transform byte **and** perform the inversion themselves. Writer
  and reader therefore agree *by construction* — the round-trip suite cannot
  disagree with itself.
- `src/jpegencode.ts:57` deliberately emits CMYK with **no APP14 and no
  inversion**, so the encoder round-trip never enters the Adobe branch at all.
- The vendored libjpeg-turbo set and `ehd`'s `synth-*` are gray/RGB only.

This is exactly the class that produced `hof` (the `parseDAC` nibble swap): our
reader and our writer were wrong in the same direction, and only third-party
bytes exposed it.

## Ground truth: author the CMYK planes, do not convert to them

`66o` as filed assumed the source must be an RGB image put through the tool's
RGB→CMYK conversion, which would make the CMYK values libvips's or IM's rather
than ours, forcing a paired raw dump to serve as truth.

That assumption is unnecessary. **Both encoders accept CMYK input directly**, so
a CMYK plane set we design *is* the exact encoder input — the same relationship
`synth-rgb.ppm` has to `ehd`'s JPEGs. Ground truth stays analytic and ours, and
no colour-management guesswork enters.

`synth-cmyk.raw` — 61×37, 8-bit, interleaved C,M,Y,K (9,028 bytes):

| Region | Content | Purpose |
|---|---|---|
| corner `x<16, y<12` | flat `C=32 M=96 Y=160 K=64` | four **distinct** values: a channel swap cannot alias into a pass, and a flat region has no lossy excuse |
| elsewhere | C ramps on x, M ramps on y, Y = 8px bars, K flat 128 | per-channel-distinct content; low-frequency, so loss stays small |

**61×37** matches `ehd`: both dimensions are non-multiples of 8, so both edges
carry a partial MCU.

Rationale for low-frequency content is `ehd`'s and unchanged: we choose the
content, so we choose the loss, which buys assertions an order of magnitude
tighter than the vendored set's. Fidelity content is not what real fixtures are
for — every realistic breakage in this class (swapped channels, missing
inversion, wrong transform) is gross, not subtle.

## Two encoders, because each reaches exactly one branch

This is forced by the tools, not a preference. **Verified empirically, not assumed:**

| Encoder | APP14 | Note |
|---|---|---|
| `@imagemagick/magick-wasm` 0.0.41 (IM 7.1.2-25 Q8) | **`transform=2`** (YCCK) | always; `jpeg:colorspace` = `cmyk`/`0`/`4`/`12` and an explicit `colorSpace=CMYK` all produced **byte-identical** 852-byte output |
| `sharp` 0.35.3 (libvips) | **`transform=0`** (plain CMYK) | libjpeg's `jpeg_default_colorspace` maps `JCS_CMYK`→`JCS_CMYK`; IM only gets YCCK by explicitly overriding it |

Neither tool can produce the other's file, so covering both branches requires
both. Setting `img.colorSpace = ColorSpace.YCCK` in magick-wasm is **not** a way
to select the transform: it *converts pixels*, yielding a 3-component JFIF file
with K dropped entirely.

Both are **one-off authoring steps, uninstalled afterwards** — the established
pattern from `PROVENANCE.md`'s Generated section. Neither becomes a dev
dependency; what is committed is frozen bytes, so the suite stays zero-dep and
hermetic.

### `pipelineColourspace` is mandatory for sharp

The single sharpest trap here, and the reason the issue's "libvips's conversion
is not ours" warning was well founded — it just applies to the *pipeline*, not
the input:

```js
sharp(tif).toColourspace('cmyk')                            // WRONG
sharp(tif).pipelineColourspace('cmyk').toColourspace('cmyk') // correct
```

Without `pipelineColourspace('cmyk')`, libvips loads the CMYK TIFF, converts it
to **sRGB** for its working pipeline, then converts back to CMYK on write. The
round-trip corrupts the source:

| Variant | mean abs err | max | corner (want `32,96,160,64`) | bytes |
|---|---|---|---|---|
| `toColourspace` alone | **32.327** | 213 | `0,84,169,92` ✗ | 1,521 |
| `pipelineColourspace` + `toColourspace` | **0.062** | 3 | `32,96,160,64` ✓ | 642 |

Both emit `transform=0` with identical marker structure and **no ICC profile**,
so the 2.4× size difference is pixel data — the naive variant is simply encoding
a noisier, wrong image.

This matters beyond correctness of the command line. The failure is quiet: a mean
error of 32 does not look like a decoder bug, it looks like "CMYK is lossy", and
the natural response is to loosen the threshold until it passes. That would bake
libvips's sRGB round-trip into the reference and leave a fixture that cannot
distinguish a real regression from its own noise — worse than no fixture.

## Fixtures

Added to `test/fixtures/jpeg/`:

| File | Encoder | What it is | Measured err vs source |
|---|---|---|---|
| `synth-cmyk.raw` | — (ours) | encoder **input**: 61×37, 8-bit, interleaved CMYK | ground truth |
| `synth-cmyk-t0-baseline.jpg` | sharp | APP14 `transform=0`, SOF0, nc=4, all 1×1 | mean 0.062, max 3 |
| `synth-cmyk-ycck-baseline.jpg` | magick-wasm | APP14 `transform=2` (YCCK), SOF0, nc=4, all 1×1 | mean 0.680, max 8 |

The YCCK file's ~10× higher error is expected and not a defect: it carries an
extra lossy YCbCr↔CMY conversion the `transform=0` file does not.

`synth-cmyk.tif` (the intermediate uncompressed CMYK TIFF that carries the raw
planes from IM into sharp) is **not** committed — it is authoring scaffolding,
reproducible from `synth-cmyk.raw`, and committing it would imply it is a
fixture.

### Provenance / licence

- magick-wasm is Apache-2.0; sharp is Apache-2.0. Both are authoring tools whose
  *output* we commit; neither imposes an obligation on the emitted bytes.
- `synth-cmyk.*` are our own work product (source designed here, output of
  permissively-licensed encoders) and carry no third-party licence obligation —
  same standing as `ehd`'s `synth-*`.
- Not redistributed: `package.json` declares `files: ["dist"]`, so `test/` never
  enters the npm tarball.

## Assertions

`test/jpeg-real.test.ts` gains one `describe`. Per fixture:

- exact `width` 61, `height` 37, **`comps` 4**, `data.length` 61·37·4
- the flat corner equals `[32, 96, 160, 64]` **exactly** — the load-bearing
  assertion. Four distinct values in a flat region pins channel order, the Adobe
  inversion, and the transform simultaneously, with no lossy excuse.
- statistical bounds with headroom over measured:

| Fixture | mean | max |
|---|---|---|
| `synth-cmyk-t0-baseline.jpg` | `< 0.5` (measured 0.062) | `≤ 6` (measured 3) |
| `synth-cmyk-ycck-baseline.jpg` | `< 1.5` (measured 0.680) | `≤ 16` (measured 8) |

- **cross-check:** the two decode to the same picture within a tight bound,
  despite different transforms — a wrong YCCK branch cannot agree with a correct
  `transform=0` decode.

Headroom follows house practice (`ehd` set 0.6 over 0.2503, 1.5 over 0.7734):
loose enough that an IDCT refactor does not trip it, tight enough that any real
breakage — which moves the mean by tens, as `hof` did at 112.67 — dies instantly.

## What this finds

**No bug.** Both fixtures decode correctly today: the flat corner reproduces
exactly through both branches, so our Adobe inversion and YCCK math are already
right.

This is stated plainly because it differs from `testimgari`, which found `hof` on
its first run and whose value was self-evident. The value here is closing a
structural gap rather than fixing a live defect: these are the only bytes in the
tree that *could* catch drift in the APP14 conventions, because every other CMYK
path agrees with itself by construction. A guard that passes on day one is still
the only thing standing between a future `cmyk()` refactor and a silent break.

## Scope

**In:** three fixture files; a `PROVENANCE.md` CMYK section (encoder versions,
exact command lines, per-file SHA-256, the `pipelineColourspace` trap) closing the
Coverage table's `none` row; one `describe` in `jpeg-real.test.ts`.

**Out:** any change to `src/`. A no-APP14 4-component fixture (what
`jpegencode.ts` itself writes) — considered and dropped: IM/sharp cannot suppress
APP14, so it is not reachable from either encoder. 12-bit CMYK. Progressive CMYK.

## Follow-ups

None required. If a no-APP14 4-component fixture is later wanted, it needs a
third tool and should be filed separately.

## Appendix: authoring recipe

Run once, from a scratch directory, then uninstall both packages. Reproduced in
`PROVENANCE.md` so the fixtures can be regenerated without this spec.

```
npm install @imagemagick/magick-wasm@0.0.41 sharp@0.35.3
```

**1. Author the source** — `synth-cmyk.raw`, 61×37, interleaved C,M,Y,K:

```js
for (let y = 0; y < 37; y++) for (let x = 0; x < 61; x++) {
  const i = (y * 61 + x) * 4;
  if (x < 16 && y < 12) { raw[i] = 32; raw[i+1] = 96; raw[i+2] = 160; raw[i+3] = 64; }
  else {
    raw[i]   = Math.round((x / 60) * 255);        // C ramps on x
    raw[i+1] = Math.round((y / 36) * 255);        // M ramps on y
    raw[i+2] = (Math.floor(x / 8) % 2) ? 224 : 32; // Y = 8px bars
    raw[i+3] = 128;                                // K flat
  }
}
```

**2. YCCK (`transform=2`), via magick-wasm** — reads the raw planes directly:

```js
const settings = new MagickReadSettings({ format: MagickFormat.Cmyk, width: 61, height: 37, depth: 8 });
ImageMagick.read(raw, settings, (img) => {
  img.quality = 90;
  img.settings.setDefine(MagickFormat.Jpeg, 'sampling-factor', '1x1');
  img.write(MagickFormat.Jpeg, (d) => writeFileSync('synth-cmyk-ycck-baseline.jpg', d));
});
```

**3. `transform=0`, via sharp** — sharp has no raw-CMYK input path, so IM writes
an uncompressed CMYK TIFF as the carrier (scaffolding; not committed):

```js
ImageMagick.read(raw, settings, (img) => {
  img.settings.compression = CompressionMethod.NoCompression;
  img.write(MagickFormat.Tiff, (d) => writeFileSync('synth-cmyk.tif', d));
});

await sharp('synth-cmyk.tif')
  .pipelineColourspace('cmyk')   // MANDATORY — without it libvips round-trips via sRGB
  .toColourspace('cmyk')
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
  .toFile('synth-cmyk-t0-baseline.jpg');
```

**4. Verify before committing** — the fixtures are only worth anything if these
hold, and step 3's trap fails exactly here:

- both files carry APP14 with the expected transform byte (offset 11 of the
  `Adobe` payload) and `SOF0` with `nc=4`, all components 1×1
- both decode to a flat corner of exactly `32,96,160,64`
- `sharp` output is ~642 bytes, **not** ~1,521 (the larger is the sRGB round-trip)
