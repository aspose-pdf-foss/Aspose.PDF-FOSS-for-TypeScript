# CMYK / Adobe APP14 JPEG Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last uncovered JPEG config by committing real-encoder CMYK fixtures — one Adobe `transform=0`, one `transform=2` (YCCK) — with an analytic ground truth we author ourselves, plus tests proven to be load-bearing.

**Architecture:** Author a 61×37 interleaved CMYK plane set (`synth-cmyk.raw`) and feed it *directly* to two encoders, so the file we design **is** the exact encoder input — no RGB→CMYK conversion, no colour-management guesswork. Two encoders are required because neither can produce the other's transform byte: ImageMagick always writes `transform=2`, libvips always writes `transform=0`. Both run once at authoring time in a scratch directory and are then uninstalled; only frozen bytes are committed, so the suite stays zero-dep and hermetic.

**Tech Stack:** `@imagemagick/magick-wasm@0.0.41` (Apache-2.0, wasm) and `sharp@0.35.3` (Apache-2.0) as one-off authoring tools; vitest for the tests; no runtime or dev dependency added to the repo.

**Spec:** `docs/superpowers/specs/2026-07-17-jpeg-cmyk-fixture-design.md`
**Issue:** `aspose-pdf-foss-for-ts-66o`

## Global Constraints

- **No `src/` changes.** The decoder is already correct for both branches. Any edit to `src/` outside Task 2's temporary, reverted negative control means the plan has gone off the rails — stop and re-read the spec.
- **No dependency may be added to `package.json`** — not `dependencies`, not `devDependencies`. The encoders are installed in a scratch directory and uninstalled afterwards. Adding either as a dev dep violates the zero-dependency and hermetic-test conventions and defeats the whole approach.
- **No generator script is committed.** Assets are committed directly, matching `fonts/` and the parent design ("a regression fixture that re-downloads is not a regression fixture"). The authoring recipe lives in `PROVENANCE.md` prose only.
- **Fixture bytes are frozen.** Once committed, they must never be regenerated casually — regenerating changes the SHA-256s recorded in `PROVENANCE.md`.
- **Exact source values:** 61×37, 8-bit, interleaved C,M,Y,K. Flat corner (`x<16, y<12`) = `C=32 M=96 Y=160 K=64`. Elsewhere: `C = round(x/60*255)`, `M = round(y/36*255)`, `Y = (floor(x/8) % 2) ? 224 : 32`, `K = 128`.
- **Exact file names:** `test/fixtures/jpeg/synth-cmyk.raw`, `synth-cmyk-t0-baseline.jpg`, `synth-cmyk-ycck-baseline.jpg`.
- **`synth-cmyk.tif` is scaffolding and must NOT be committed.**
- Scratch directory for authoring: `C:\Users\user\AppData\Local\Temp\claude\s--Aspose-PAS-gitlab-com-esopsa-pdf4ts-aspose-pdf-foss-for-ts\8b46bf58-a3a5-4e45-8ae5-d2cf75bff217\scratchpad\cmykprobe` (already exists with both packages installed).

---

### Task 1: Author the source and generate the two fixtures

**Files:**
- Create: `test/fixtures/jpeg/synth-cmyk.raw` (9,028 bytes)
- Create: `test/fixtures/jpeg/synth-cmyk-t0-baseline.jpg` (~642 bytes)
- Create: `test/fixtures/jpeg/synth-cmyk-ycck-baseline.jpg` (~852 bytes)
- Scratch only (never committed): `<scratch>/gen.mjs`, `<scratch>/synth-cmyk.tif`

**Interfaces:**
- Consumes: nothing.
- Produces: the three fixture files above. Task 2 reads them by exact name. Their invariants — 61×37, `comps=4`, corner `32,96,160,64`, APP14 transform bytes 0 and 2 — are what Task 2 asserts.

- [ ] **Step 1: Write the authoring script**

Create `<scratch>/gen.mjs`. Note `pipelineColourspace('cmyk')` on the sharp
pipeline — it is load-bearing and Step 3 verifies it took effect.

```js
import { initializeImageMagick, ImageMagick, MagickFormat, MagickReadSettings, CompressionMethod } from '@imagemagick/magick-wasm';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
await initializeImageMagick(readFileSync(require.resolve('@imagemagick/magick-wasm/magick.wasm')));

const W = 61, H = 37;

// The source we design: each channel distinct so a swap cannot alias into a
// pass; flat corner has four different values and no lossy excuse.
const raw = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (x < 16 && y < 12) { raw[i] = 32; raw[i + 1] = 96; raw[i + 2] = 160; raw[i + 3] = 64; }
  else {
    raw[i]     = Math.round((x / (W - 1)) * 255);        // C ramps on x
    raw[i + 1] = Math.round((y / (H - 1)) * 255);        // M ramps on y
    raw[i + 2] = (Math.floor(x / 8) % 2) ? 224 : 32;     // Y = 8px bars
    raw[i + 3] = 128;                                     // K flat
  }
}
writeFileSync('synth-cmyk.raw', raw);

const settings = new MagickReadSettings({ format: MagickFormat.Cmyk, width: W, height: H, depth: 8 });

// transform=2 (YCCK) -- ImageMagick, reading the raw planes directly.
ImageMagick.read(raw, settings, (img) => {
  img.quality = 90;
  img.settings.setDefine(MagickFormat.Jpeg, 'sampling-factor', '1x1');
  img.write(MagickFormat.Jpeg, (d) => writeFileSync('synth-cmyk-ycck-baseline.jpg', d));
});

// Carrier for sharp, which has no raw-CMYK input path. Scaffolding only.
ImageMagick.read(raw, settings, (img) => {
  img.settings.compression = CompressionMethod.NoCompression;
  img.write(MagickFormat.Tiff, (d) => writeFileSync('synth-cmyk.tif', d));
});

// transform=0 (plain CMYK) -- sharp/libvips.
await sharp('synth-cmyk.tif')
  .pipelineColourspace('cmyk')   // MANDATORY: without it libvips round-trips via sRGB
  .toColourspace('cmyk')
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
  .toFile('synth-cmyk-t0-baseline.jpg');

console.log('generated');
```

- [ ] **Step 2: Run it**

```bash
cd "C:/Users/user/AppData/Local/Temp/claude/s--Aspose-PAS-gitlab-com-esopsa-pdf4ts-aspose-pdf-foss-for-ts/8b46bf58-a3a5-4e45-8ae5-d2cf75bff217/scratchpad/cmykprobe"
node gen.mjs && ls -l synth-cmyk.raw synth-cmyk-t0-baseline.jpg synth-cmyk-ycck-baseline.jpg
```

Expected: `generated`, then `synth-cmyk.raw` exactly **9028** bytes,
`synth-cmyk-t0-baseline.jpg` **~642** bytes, `synth-cmyk-ycck-baseline.jpg`
**~852** bytes.

**If `synth-cmyk-t0-baseline.jpg` is ~1521 bytes, `pipelineColourspace` did not
take effect** — the file is an sRGB round-trip and is unusable. Do not proceed;
fix the pipeline first.

- [ ] **Step 3: Verify the marker structure before trusting the bytes**

Create `<scratch>/check.mjs`:

```js
import { readFileSync } from 'node:fs';

function scan(buf) {
  let i = 2, app14 = 'none', sof = '?';
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (m === 0xee && buf.slice(i + 4, i + 9).toString('latin1') === 'Adobe') app14 = buf[i + 15];
    if (m === 0xc0 || m === 0xc2) {
      const nc = buf[i + 9];
      const s = [];
      for (let c = 0; c < nc; c++) s.push(`${buf[i + 11 + c * 3] >> 4}x${buf[i + 11 + c * 3] & 15}`);
      sof = `SOF${m === 0xc0 ? 0 : 2} nc=${nc} ${s.join(',')}`;
    }
    i += 2 + len;
  }
  return { app14, sof };
}

for (const n of ['synth-cmyk-t0-baseline.jpg', 'synth-cmyk-ycck-baseline.jpg']) {
  console.log(n, scan(readFileSync(n)));
}
```

Run: `node check.mjs`

Expected exactly:
```
synth-cmyk-t0-baseline.jpg   { app14: 0, sof: 'SOF0 nc=4 1x1,1x1,1x1,1x1' }
synth-cmyk-ycck-baseline.jpg { app14: 2, sof: 'SOF0 nc=4 1x1,1x1,1x1,1x1' }
```

If either `app14` is `none` or the transforms are not 0 and 2 respectively, stop
— the fixtures do not cover the branches they exist to cover.

- [ ] **Step 4: Copy the three files into the repo**

```bash
cd "C:/Users/user/AppData/Local/Temp/claude/s--Aspose-PAS-gitlab-com-esopsa-pdf4ts-aspose-pdf-foss-for-ts/8b46bf58-a3a5-4e45-8ae5-d2cf75bff217/scratchpad/cmykprobe"
cp synth-cmyk.raw synth-cmyk-t0-baseline.jpg synth-cmyk-ycck-baseline.jpg \
   "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts/test/fixtures/jpeg/"
```

Do **not** copy `synth-cmyk.tif`.

- [ ] **Step 5: Confirm the TIFF did not sneak in, then commit**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git status --short test/fixtures/jpeg/
```

Expected: exactly three `??` lines — `synth-cmyk.raw`,
`synth-cmyk-t0-baseline.jpg`, `synth-cmyk-ycck-baseline.jpg`. No `.tif`.

```bash
git add test/fixtures/jpeg/synth-cmyk.raw \
        test/fixtures/jpeg/synth-cmyk-t0-baseline.jpg \
        test/fixtures/jpeg/synth-cmyk-ycck-baseline.jpg
git commit -m "$(cat <<'EOF'
test(jpeg): real CMYK fixtures, Adobe transform=0 and YCCK transform=2 (66o)

The source is ours: both encoders read CMYK directly, so the plane set we
designed IS the exact encoder input -- no RGB->CMYK conversion, so ground
truth stays analytic, the same standing synth-rgb.ppm has in ehd.

Two encoders because neither reaches the other's branch: ImageMagick always
writes transform=2, libvips always writes transform=0.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add the tests, and prove they are load-bearing

**Files:**
- Modify: `test/jpeg-real.test.ts` (append one `describe` after the existing `synth-*` block, currently ending line 157)
- Temporarily modify then revert: `src/jpeg.ts:350` (negative control only)

**Interfaces:**
- Consumes: the three fixtures from Task 1; the existing `fixture(name)` helper (`test/jpeg-real.test.ts:33`) and `errorVs(data, refData)` (line 40), both already in the file. Do **not** redefine either.
- Produces: no exports. `readPnm` is **not** used — `synth-cmyk.raw` is headerless, so it is read with `fixture()` directly.

**Why this task has no red-green cycle:** there is no production code to write —
the decoder is already correct, so these tests pass the moment the fixtures
exist. A test that has never been seen failing is not yet a guard. Steps 3–5 are
the substitute: deliberately break `cmyk()` and confirm the tests catch it.

- [ ] **Step 1: Write the tests**

Append to `test/jpeg-real.test.ts`:

```ts
// The one config neither libjpeg-turbo's testimages/ nor cjpeg can supply:
// 4-component CMYK with an Adobe APP14 marker. These are the only bytes in the
// tree that check the APP14 conventions against an encoder that is not us --
// build-jpeg-arith.ts and build-jpeg-lossless.ts write the transform byte AND
// the inversion themselves, so writer and reader agree by construction and the
// round-trip suite can never disagree with itself. src/jpegencode.ts sidesteps
// the branch entirely by emitting CMYK with no APP14 at all.
//
// synth-cmyk.raw is headerless (61*37*4 interleaved C,M,Y,K) and is the exact
// input both encoders read -- ground truth is analytic and ours.
//
// Two encoders because neither reaches the other's branch: ImageMagick always
// writes transform=2 (YCCK), libvips always transform=0. See PROVENANCE.md.
describe('decodeJpeg — real CMYK fixtures over a synthetic source (61x37)', () => {
  const src = fixture('synth-cmyk.raw');
  const N = 61 * 37 * 4;

  it('the authored source is the expected size', () => {
    expect(src.length).toBe(N);
    // The flat corner's four channels are deliberately distinct.
    expect([...src.subarray(0, 4)]).toEqual([32, 96, 160, 64]);
  });

  // transform, mean bound, max bound -- YCCK is looser because it carries an
  // extra lossy YCbCr<->CMY conversion the transform=0 file does not.
  const cases = [
    { name: 'synth-cmyk-t0-baseline.jpg', label: 'Adobe transform=0 (plain CMYK)', mean: 0.5, max: 6 },
    { name: 'synth-cmyk-ycck-baseline.jpg', label: 'Adobe transform=2 (YCCK)', mean: 1.5, max: 16 },
  ];

  for (const { name, label, mean, max } of cases) {
    describe(label, () => {
      const dec = decodeJpeg(fixture(name));

      it('decodes as 4 components at the declared frame size', () => {
        expect(dec.width).toBe(61);
        expect(dec.height).toBe(37);
        expect(dec.comps).toBe(4);
        expect(dec.data.length).toBe(N);
      });

      it('reproduces the authored source within lossy tolerance', () => {
        const e = errorVs(dec.data, src);
        expect(e.mean).toBeLessThan(mean);
        expect(e.max).toBeLessThanOrEqual(max);
      });

      it('reproduces the flat corner exactly, pinning order and inversion', () => {
        // Four distinct values in a flat region: no lossy excuse. A dropped
        // Adobe inversion, a wrong transform branch, or a channel swap all die
        // here -- none of them can land on 32,96,160,64 by accident.
        expect([...dec.data.subarray(0, 4)]).toEqual([32, 96, 160, 64]);
      });
    });
  }

  it('both transforms agree with each other', () => {
    // Same source, different Adobe transform: a wrong YCCK branch cannot agree
    // with a correct transform=0 decode.
    const a = decodeJpeg(fixture('synth-cmyk-t0-baseline.jpg')).data;
    const b = decodeJpeg(fixture('synth-cmyk-ycck-baseline.jpg')).data;
    expect(errorVs(a, b).mean).toBeLessThan(1.5);
  });
});
```

- [ ] **Step 2: Run them and confirm green**

Run:
```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/jpeg-real.test.ts
```

Expected: PASS, **19 tests** green in this file — the 11 pre-existing plus 8 new
(1 source check + 2 fixtures × 3 + 1 cross-check). A count other than 19 means
the `describe` block did not land as written.

If `both transforms agree with each other` fails, report the measured mean rather
than widening the bound — the spec predicts ≤ ~0.75 and a larger value means a
real disagreement between the branches.

- [ ] **Step 3: Negative control — break the Adobe inversion**

In `src/jpeg.ts:350`, change:

```ts
    if (adobe) { c = 255 - c; m = 255 - m; y = 255 - y; k = 255 - k; }
```

to:

```ts
    if (false) { c = 255 - c; m = 255 - m; y = 255 - y; k = 255 - k; }
```

- [ ] **Step 4: Confirm the new tests catch it**

Run: `npx vitest run test/jpeg-real.test.ts`

Expected: **FAIL** — both `reproduces the flat corner exactly` tests fail
(receiving `223,159,95,191`, the inverse of the expected `32,96,160,64`), and
both tolerance tests fail on a large mean.

If the tests still pass, they are not load-bearing and the fixture is worthless
— stop and diagnose before going further.

- [ ] **Step 5: Revert the negative control and confirm green again**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git checkout src/jpeg.ts
git diff --stat src/          # MUST be empty -- no src/ changes ship in this plan
npx vitest run test/jpeg-real.test.ts
```

Expected: `git diff --stat src/` prints nothing; vitest PASSes.

- [ ] **Step 6: Full gates and commit**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite green.

```bash
git add test/jpeg-real.test.ts
git commit -m "$(cat <<'EOF'
test(jpeg): assert CMYK decode against the authored source (66o)

Verified load-bearing rather than merely green: with the Adobe inversion in
cmyk() disabled, the corner assertions fail on 223,159,95,191 -- the exact
inverse of the expected 32,96,160,64. The corner pins channel order, the
inversion, and the transform branch at once, with no lossy excuse.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Document provenance and close the issue

**Files:**
- Modify: `test/fixtures/jpeg/PROVENANCE.md` (add a CMYK section; update the two-class table near line 9, the Coverage table's `none` row at line 128, and the trailing CMYK caveat at lines 130-131)

**Interfaces:**
- Consumes: the committed fixtures from Task 1 (for SHA-256s) and the measured errors confirmed in Task 2.
- Produces: documentation only.

- [ ] **Step 1: Compute the SHA-256s**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts/test/fixtures/jpeg"
sha256sum synth-cmyk.raw synth-cmyk-t0-baseline.jpg synth-cmyk-ycck-baseline.jpg
```

Record the real digests. Use the file's existing abbreviated style
(first 8 chars, `…`, last 7).

- [ ] **Step 2: Add the CMYK section**

Insert after the "Generated — mozjpeg `cjpeg`" section (before `## Licence`),
substituting the digests from Step 1:

````markdown
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
| `synth-cmyk-t0-baseline.jpg` | `<from Step 1>` | APP14 **transform=0**, SOF0, 61×37, **nc=4**, all 1×1 |
| `synth-cmyk-ycck-baseline.jpg` | `<from Step 1>` | APP14 **transform=2** (YCCK), SOF0, 61×37, **nc=4**, all 1×1 |
| `synth-cmyk.raw` | `<from Step 1>` | encoder **input** for both: headerless, 61×37×4 interleaved C,M,Y,K |

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
````

- [ ] **Step 3: Update the two-class table**

The file's opening table (line ~9) says two classes live here. `synth-cmyk-*` is
a third: our source, but read directly rather than via a PNM. Change the
**Generated** row's Files cell from `synth-*` to `synth-gray-*`, `synth-rgb444-*`
and add a row:

```markdown
| **Generated (CMYK)** | `synth-cmyk-*` | **ours, by design** | `synth-cmyk.raw`, the exact encoder input |
```

- [ ] **Step 4: Close out the Coverage table**

Replace the `none` row (line ~128):

```markdown
| **CMYK / Adobe APP14, transform=0** | `synth-cmyk-t0-baseline.jpg` |
| **CMYK / Adobe APP14, transform=2 (YCCK)** | `synth-cmyk-ycck-baseline.jpg` |
```

Delete the two-line caveat that follows it ("CMYK stays open because `cjpeg` has
no CMYK input path…", lines ~130-131) — it is now false.

- [ ] **Step 5: Note what these do and do not find**

Append to the end of the file, after the `testimgari.jpg` paragraph:

```markdown
Unlike `testimgari.jpg`, the CMYK pair found **no bug** — the Adobe inversion and
YCCK math were already right. They are a guard, not a fix: every other CMYK path
in the tree agrees with itself by construction, so these are the only bytes that
could catch drift. Verified load-bearing rather than merely green — disabling the
inversion in `cmyk()` fails the corner assertions on `223,159,95,191`.
```

- [ ] **Step 6: Verify the doc matches the tree**

Re-read `PROVENANCE.md` start to finish. Confirm: every SHA-256 is a real digest
from Step 1 (no placeholder survived), no sentence still claims CMYK is
uncovered, and every filename named exists:

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts/test/fixtures/jpeg"
grep -o 'synth-cmyk[a-z0-9.-]*' PROVENANCE.md | sort -u | while read f; do
  [ -e "$f" ] || echo "MISSING: $f"
done
grep -n 'none\|stays open\|<from Step 1>' PROVENANCE.md
```

Expected: no `MISSING:` lines. The second `grep` must not report any surviving
`<from Step 1>` placeholder, nor any line claiming CMYK is uncovered.
(`synth-cmyk.tif` will be reported MISSING and that is **correct** — it is
described as deliberately not committed. No other file may be.)

- [ ] **Step 7: Commit and close the issue**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/fixtures/jpeg/PROVENANCE.md
git commit -m "$(cat <<'EOF'
docs(jpeg): provenance for the CMYK fixtures, closing the coverage gap (66o)

Records both encoders and why two are needed, and the pipelineColourspace
trap: without it libvips round-trips the source through sRGB (mean err 32.3
vs 0.062) while still emitting a plausible transform=0 file.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
bd close aspose-pdf-foss-for-ts-66o
```

- [ ] **Step 8: Push (mandatory per CLAUDE.md — work is not complete until this succeeds)**

```bash
git pull --rebase && git push && git status
```

Expected: `git status` reports the branch up to date with `origin/main`.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Ground truth: author the planes | 1 (Steps 1-2) |
| Two encoders, each one branch | 1 (Steps 1-3) |
| `pipelineColourspace` mandatory | 1 (Steps 1-2 guard), 3 (Step 2 documents) |
| Fixtures table + `.tif` not committed | 1 (Steps 4-5) |
| Provenance / licence | 3 (Step 2) |
| Assertions incl. cross-check | 2 (Step 1) |
| "What this finds" (no bug; guard only) | 2 (Steps 3-5 prove it), 3 (Step 5 records it) |
| Scope: no `src/` changes | Global Constraints; enforced at 2 Step 5 |

**Placeholder scan:** the only `<from Step 1>` markers are in Task 3's doc
template, where the digests are computed one step earlier and Step 6 greps to
prove none survived. No `TBD`/`TODO`.

**Type consistency:** `errorVs(data, refData)` and `fixture(name)` match
`test/jpeg-real.test.ts:33,40` exactly and are reused, not redefined. `readPnm`
is deliberately unused (`.raw` is headerless). Fixture names are identical across
all three tasks and the spec.
