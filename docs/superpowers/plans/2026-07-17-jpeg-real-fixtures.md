# Real-World JPEG Regression Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor real libjpeg-encoded JPEGs and assert `decodeJpeg` reproduces them, closing the shared-convention blind spot where our decoder and our fixture builder could be wrong in the same direction.

**Architecture:** Four frozen assets from libjpeg-turbo `testimages/` land in `test/fixtures/jpeg/`, pinned by upstream commit and verified by SHA-256. Three JPEGs of one 227×149 image share a single uncompressed original (`testorig.ppm`) as ground truth. A new `test/helpers/read-pnm.ts` parses that original; `test/jpeg-real.test.ts` decodes each JPEG and asserts the *error distribution* against it.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, `node:fs`/`node:url`/`node:path`. No new dependencies — runtime or dev.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add any npm dep, runtime or dev.
- **ESM + NodeNext:** every relative import specifier carries a `.js` extension (e.g. `./read-pnm.js`), even from `.ts` files.
- **No `src/` changes.** This plan is fixtures + tests only. The arithmetic bug it exposes is owned by `aspose-pdf-foss-for-ts-hof`; do **not** fix it here.
- **Upstream pin:** commit `cce89f35f9b6718ae662604a620aa506fbd6e579` (2026-07-16) of `https://github.com/libjpeg-turbo/libjpeg-turbo`. Every raw URL below uses this SHA, never `main`.
- **Fixtures are frozen bytes.** No generator/fetch script — a regression fixture that re-downloads is not a regression fixture. Assets are committed directly, as `fonts/` does.
- **`testorig.ppm` is the uncompressed SOURCE**, not a reference decode. Deltas are lossy-compression loss, so per-pixel `near(a,b,3)` assertions are invalid. Assert on the error distribution.
- Before closing: `npm run typecheck` and `npm test` must both be green.
- Spec: `docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md`

---

### Task 1: Vendor the fixtures, licence, and provenance

Frozen third-party assets plus the compliance paperwork. Reviewer gate: licensing and provenance are correct and the bytes are exactly upstream's.

**Files:**
- Create: `test/fixtures/jpeg/testorig.jpg` (5,770 B)
- Create: `test/fixtures/jpeg/testimgint.jpg` (5,756 B)
- Create: `test/fixtures/jpeg/testimgari.jpg` (5,126 B)
- Create: `test/fixtures/jpeg/testorig.ppm` (101,484 B)
- Create: `test/fixtures/jpeg/LICENSE-IJG.txt` (verbatim upstream `README.ijg`, 12,799 B)
- Create: `test/fixtures/jpeg/PROVENANCE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the six paths above. Task 3 reads `testorig.ppm`, `testorig.jpg`, `testimgint.jpg`; Task 4 reads `testimgari.jpg`.

**Why `LICENSE-IJG.txt` is upstream's README verbatim:** IJG licence condition (1) requires that "this README file must be included, with this copyright and no-warranty notice unaltered". Copying the file byte-for-byte discharges that with no judgement call. Our own notes go in the separate `PROVENANCE.md` so the licence file stays unaltered. This mirrors `fonts/LICENSE-OFL.txt`.

- [ ] **Step 1: Download the six upstream files**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
mkdir -p test/fixtures/jpeg
SHA=cce89f35f9b6718ae662604a620aa506fbd6e579
BASE="https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/$SHA"
for f in testorig.jpg testimgint.jpg testimgari.jpg testorig.ppm; do
  curl -sL --fail -o "test/fixtures/jpeg/$f" "$BASE/testimages/$f"
done
curl -sL --fail -o test/fixtures/jpeg/LICENSE-IJG.txt "$BASE/README.ijg"
ls -l test/fixtures/jpeg/
```

Expected: five files with sizes 5770, 5756, 5126, 101484, 12799.

- [ ] **Step 2: Verify the bytes are exactly upstream's**

The vendored bytes are the whole point of this issue — if they are not upstream's, every assertion downstream is meaningless. Verify before trusting them.

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts/test/fixtures/jpeg"
cat <<'EOF' | sha256sum -c -
acc6ec555d41d15b368320edaa3b20958ee6fa97cb6e4a18d1213d5ae8bec73b *testorig.jpg
491679b8057739b3c8e5bacd1e918efb1691d271cbbd69820ff8d480dcb90963 *testimgint.jpg
4672c7f08864cd0a8c73a4fa4b66ca32b635d38464551c1ecf06564ae8c89b38 *testimgari.jpg
4afe49cb62ba87be1a958d7fd29b822a2ba1a0e966d1136f616ee5353691a002 *testorig.ppm
EOF
```

Expected: four lines each ending `: OK`. If any line says `FAILED`, stop — do not proceed. Re-download; if it still fails, the upstream pin is wrong or the transfer is corrupting bytes (check for CRLF mangling: these are binary files and must not pass through any text filter).

- [ ] **Step 3: Confirm the licence file is the IJG README**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
grep -c "Independent JPEG Group" test/fixtures/jpeg/LICENSE-IJG.txt
grep -n "copyright (C) 1991-2020, Thomas G. Lane, Guido Vollbeding" test/fixtures/jpeg/LICENSE-IJG.txt
```

Expected: a non-zero count, and the copyright line found. Do not edit this file.

- [ ] **Step 4: Write the provenance note**

Create `test/fixtures/jpeg/PROVENANCE.md`:

```markdown
# JPEG test fixtures — provenance

Real-world JPEGs from a trusted encoder (libjpeg), vendored to validate
`decodeJpeg` against bytes it did not produce. See
`docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md`.

**Upstream:** https://github.com/libjpeg-turbo/libjpeg-turbo
**Pinned commit:** `cce89f35f9b6718ae662604a620aa506fbd6e579` (2026-07-16)
**Path:** `testimages/` (except `LICENSE-IJG.txt`, which is the repo-root `README.ijg`)

| File | SHA-256 | What it is |
|---|---|---|
| `testorig.jpg` | `acc6ec55…8bec73b` | libjpeg baseline: JFIF APP0, SOF0, 227×149, 4:2:0, component IDs 1/2/3 |
| `testimgint.jpg` | `491679b8…dcb90963` | same image, second baseline encoder config |
| `testimgari.jpg` | `4672c7f0…e8c89b38` | same image, SOF9 arithmetic + DAC (T.81 default conditioning) |
| `testorig.ppm` | `4afe49cb…3691a002` | the **uncompressed original**: P6, 227×149, maxval 255 |

## testorig.ppm is the source, not a reference decode

`testorig.ppm` is the image libjpeg *compressed to produce* the JPEGs above — it
is not libjpeg's decode of them. Verified empirically: our decode of
`testorig.jpg` differs from it by mean absolute error 1.365 with a max of 34. A
reference decode would agree within ~1 LSB (IDCT variance); a max of 34 is lossy
loss on high-detail edges.

Consequence: assertions against it must be statistical. Per-pixel tolerance
(`near(a, b, 3)`, as `test/jpeg.test.ts` uses against synthetic fixtures) is the
wrong instrument and will fail.

## Licence

`LICENSE-IJG.txt` is upstream's `README.ijg`, **verbatim and unaltered** —
IJG licence condition (1) requires it be included with its copyright and
no-warranty notice unmodified. Do not edit it. Notes belong in this file instead.

These fixtures are not redistributed to npm consumers: `package.json` declares
`files: ["dist"]`, so `test/` never enters the published tarball.

## Coverage

Covers **RGB 4:2:0 only** — all three JPEGs are the same image. libjpeg-turbo
ships no grayscale, 4:4:4, or CMYK test image. Those configs are tracked by
`aspose-pdf-foss-for-ts-ehd`.

`testimgari.jpg`'s test is **skipped**: real arithmetic-coded JPEG currently
decodes to garbage. Tracked by `aspose-pdf-foss-for-ts-hof`.
```

- [ ] **Step 5: Confirm git treats the fixtures as binary and does not mangle them**

A CRLF filter silently corrupting a fixture would make every later assertion lie. Check that what git staged round-trips to the same hash.

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/fixtures/jpeg/
git diff --cached --numstat -- test/fixtures/jpeg/
```

Expected: the four binary files show `-	-	<path>` (dashes = binary, not line counts). `LICENSE-IJG.txt` and `PROVENANCE.md` show real line counts — that is correct, they are text.

If a `.jpg`/`.ppm` shows line counts instead of `-`, git is treating it as text. Stop and add `test/fixtures/jpeg/*.jpg binary` / `*.ppm binary` to `.gitattributes`, then re-add.

- [ ] **Step 6: Commit**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/fixtures/jpeg/
git commit -m "test(w6m): vendor real-world JPEG fixtures from libjpeg-turbo

testorig.jpg / testimgint.jpg (baseline 4:2:0) and testimgari.jpg (SOF9
arithmetic), plus testorig.ppm -- the uncompressed original all three were
encoded from, which serves as ground truth for all of them.

Pinned to libjpeg-turbo cce89f35, verified by SHA-256. LICENSE-IJG.txt is
upstream README.ijg verbatim per IJG licence condition (1); our notes live in
PROVENANCE.md so the licence file stays unaltered. Follows the fonts/ precedent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `readPnm` helper

**Files:**
- Create: `test/helpers/read-pnm.ts`
- Test: `test/helpers/read-pnm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readPnm(buf: Uint8Array): Pnm` where
  `interface Pnm { magic: 'P5' | 'P6'; width: number; height: number; max: number; data: Uint8Array }`.
  `data` is interleaved samples — 3 bytes/px for P6, 1 byte/px for P5. Tasks 3 and 4 call this.

Helper tests live beside helpers (`test/helpers/build-jpeg.test.ts` is the precedent), so this test goes in `test/helpers/`, not `test/`.

- [ ] **Step 1: Write the failing test**

Create `test/helpers/read-pnm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readPnm } from './read-pnm.js';

const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe('readPnm', () => {
  it('parses a P6 header and payload', () => {
    const p = readPnm(join(bytes('P6\n2 1\n255\n'), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.magic).toBe('P6');
    expect(p.width).toBe(2);
    expect(p.height).toBe(1);
    expect(p.max).toBe(255);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('parses a P5 grayscale header and payload', () => {
    const p = readPnm(join(bytes('P5\n3 1\n255\n'), Uint8Array.from([7, 8, 9])));
    expect(p.magic).toBe('P5');
    expect(p.width).toBe(3);
    expect([...p.data]).toEqual([7, 8, 9]);
  });

  it('accepts arbitrary whitespace between header fields', () => {
    const p = readPnm(join(bytes('P6  2\t1\n\n255 '), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.width).toBe(2);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips comments anywhere in the header', () => {
    const p = readPnm(join(bytes('P6\n# CREATOR: cjpeg\n2 1\n# another\n255\n'), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.width).toBe(2);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does not treat a 0x23 byte in the payload as a comment', () => {
    // 0x23 is '#'. It is only a comment in the header; payload is opaque.
    const p = readPnm(join(bytes('P6\n1 1\n255\n'), Uint8Array.from([0x23, 0x23, 0x23])));
    expect([...p.data]).toEqual([0x23, 0x23, 0x23]);
  });

  it('throws on 16-bit maxval', () => {
    expect(() => readPnm(join(bytes('P5\n1 1\n65535\n'), Uint8Array.from([0, 0]))))
      .toThrow(/16-bit/);
  });

  it('throws on a short payload', () => {
    expect(() => readPnm(join(bytes('P6\n2 1\n255\n'), Uint8Array.from([1, 2, 3]))))
      .toThrow(/short payload/);
  });

  it('throws on unsupported magic', () => {
    expect(() => readPnm(bytes('P3\n1 1\n255\n0 0 0\n'))).toThrow(/unsupported magic/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/helpers/read-pnm.test.ts
```

Expected: FAIL — cannot resolve `./read-pnm.js` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `test/helpers/read-pnm.ts`:

```ts
// Minimal binary PNM reader for test fixtures: P6 (RGB) and P5 (grayscale).
// Parses the ASCII header -- magic, width, height, maxval -- and returns the raw
// sample payload. Only 8-bit (maxval <= 255) is supported; that is what the
// vendored fixtures use.

export interface Pnm {
  magic: 'P5' | 'P6';
  width: number;
  height: number;
  max: number;
  /** Interleaved samples: 3 bytes/px for P6, 1 byte/px for P5. */
  data: Uint8Array;
}

const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

export function readPnm(buf: Uint8Array): Pnm {
  let pos = 0;
  // Next header token, skipping whitespace runs and '#' comments-to-end-of-line.
  const token = (): string => {
    for (;;) {
      while (pos < buf.length && isWs(buf[pos])) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
      break;
    }
    const start = pos;
    while (pos < buf.length && !isWs(buf[pos])) pos++;
    return String.fromCharCode(...buf.subarray(start, pos));
  };

  const magic = token();
  if (magic !== 'P5' && magic !== 'P6') throw new Error(`readPnm: unsupported magic ${magic}`);
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (max > 255) throw new Error(`readPnm: 16-bit PNM unsupported (maxval ${max})`);
  pos++; // exactly one whitespace byte separates the header from the payload

  const need = width * height * (magic === 'P6' ? 3 : 1);
  const data = buf.subarray(pos, pos + need);
  if (data.length !== need) throw new Error(`readPnm: short payload: got ${data.length}, want ${need}`);
  return { magic, width, height, max, data };
}
```

Note the payload boundary: after `maxval` exactly **one** whitespace byte is consumed (`pos++`), never a run. The payload is opaque bytes and may legitimately begin with `0x20` or `0x23`, so the comment/whitespace skipping in `token()` must not run past the header.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/helpers/read-pnm.test.ts
npm run typecheck
```

Expected: 8 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/helpers/read-pnm.ts test/helpers/read-pnm.test.ts
git commit -m "test(w6m): add readPnm fixture helper

Minimal P6/P5 reader for the vendored uncompressed originals. P5 is included
for ehd's future grayscale fixtures; 16-bit maxval throws rather than silently
misreading.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Baseline real-bytes tests

The deliverable of the whole issue: `decodeJpeg` verified against bytes it did not produce.

**Files:**
- Create: `test/jpeg-real.test.ts`

**Interfaces:**
- Consumes: `readPnm` from Task 2 (`./helpers/read-pnm.js`); the fixtures from Task 1; `decodeJpeg` from `../src/jpeg.js`, which returns `JpegImage { width: number; height: number; comps: number; data: Uint8Array }`.
- Produces: nothing (leaf).

**Thresholds and their measured basis.** Each has headroom so ordinary IDCT refactors don't trip it, while any real breakage (swapped components, wrong upsampling, bad quant table) moves the mean by tens:

| Fixture | measured mean | measured max | measured within-8 |
|---|---|---|---|
| `testorig.jpg` | 1.365 | 34 | 98.21% |
| `testimgint.jpg` | 1.428 | 30 | 98.14% |

Asserted: mean `< 2.0`, max `<= 40`, within-8 `>= 97%`.

- [ ] **Step 1: Write the test**

This task is characterization of existing behavior, so the test passes on first run — there is no failing-test step to stage. Step 2 confirms it genuinely exercises the fixtures rather than passing vacuously.

Create `test/jpeg-real.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeJpeg } from '../src/jpeg.js';
import { readPnm } from './helpers/read-pnm.js';

// Real libjpeg-encoded fixtures -- the only JPEGs in the tree not produced by our
// own test/helpers/build-jpeg*.ts. They exist to catch the shared-convention bug
// class: a marker layout or component ordering that our decoder and our fixture
// builder get wrong in the SAME direction, which a round-trip against our own
// decoder can never see.
//
// Ground truth (testorig.ppm) is the UNCOMPRESSED SOURCE libjpeg compressed --
// not a reference decode -- so the deltas below are real lossy-compression loss.
// Per-pixel tolerance (the near(a,b,3) style used in jpeg.test.ts against
// synthetic fixtures) is therefore invalid here; assert the error distribution.
//
// Provenance, licence, pinned commit: test/fixtures/jpeg/PROVENANCE.md
// Design: docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, 'fixtures/jpeg', name)));

const ref = readPnm(fixture('testorig.ppm'));
const N = ref.width * ref.height * 3;

interface Err { mean: number; max: number; within8: number }

function errorVsRef(data: Uint8Array): Err {
  let sum = 0, max = 0, within8 = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(data[i] - ref.data[i]);
    sum += d;
    if (d > max) max = d;
    if (d <= 8) within8++;
  }
  return { mean: sum / N, max, within8: within8 / N };
}

describe('decodeJpeg — real libjpeg fixtures (227x149 RGB 4:2:0)', () => {
  it('reference original is the expected 227x149 P6', () => {
    expect(ref.magic).toBe('P6');
    expect(ref.width).toBe(227);
    expect(ref.height).toBe(149);
    expect(ref.max).toBe(255);
    expect(ref.data.length).toBe(N);
  });

  for (const name of ['testorig.jpg', 'testimgint.jpg']) {
    describe(name, () => {
      const dec = decodeJpeg(fixture(name));

      it('decodes to the frame declared in SOF0', () => {
        expect(dec.width).toBe(227);
        expect(dec.height).toBe(149);
        expect(dec.comps).toBe(3);
        expect(dec.data.length).toBe(N);
      });

      it('reproduces the uncompressed original within lossy tolerance', () => {
        const e = errorVsRef(dec.data);
        expect(e.mean).toBeLessThan(2.0);      // measured: 1.365 / 1.428
        expect(e.max).toBeLessThanOrEqual(40); // measured: 34 / 30
        expect(e.within8).toBeGreaterThanOrEqual(0.97); // measured: 98.21% / 98.14%
      });

      it('reproduces the flat top-left corner exactly', () => {
        // A flat region has no lossy excuse: a wrong DC, quant table, or
        // component order cannot survive this, cheaply and sharply.
        expect([...dec.data.subarray(0, 3)]).toEqual([...ref.data.subarray(0, 3)]);
      });
    });
  }

  it('both baseline encoder configs agree with each other', () => {
    // Same image, different encoder settings: they must land on the same picture
    // even though neither is bit-identical to the original.
    const a = decodeJpeg(fixture('testorig.jpg')).data;
    const b = decodeJpeg(fixture('testimgint.jpg')).data;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += Math.abs(a[i] - b[i]);
    expect(sum / N).toBeLessThan(2.0);
  });
});
```

- [ ] **Step 2: Run the tests and verify they pass — and are not vacuous**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/jpeg-real.test.ts
```

Expected: 8 tests pass.

Now prove the thresholds actually bite, rather than passing no matter what. Temporarily swap the R and B channels of the decoded data inside `errorVsRef` (a fake "wrong component order" bug):

```ts
// TEMPORARY - revert after this step
const d = Math.abs(data[i - (i % 3) + (2 - (i % 3))] - ref.data[i]);
```

Re-run: the tolerance test **must** FAIL with a mean in the tens. If it still passes, the assertions are not exercising the fixtures — stop and fix. Revert the line and re-run to confirm 8 passing.

- [ ] **Step 3: Commit**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/jpeg-real.test.ts
git commit -m "test(w6m): assert decodeJpeg against real libjpeg baseline bytes

First validation of the JPEG chain against a third-party encoder. Both baseline
fixtures land within mean abs err 1.4 of the uncompressed original (98% of
samples within 8), the flat corner matches exactly, and the two encoder configs
agree with each other.

Assertions are statistical because the reference is the pre-compression source,
not a reference decode -- per-pixel tolerance would fail on legitimate lossy loss.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Skipped arithmetic test documenting `hof`

Separate from Task 3: a reviewer could reasonably accept the baseline coverage while disputing how the known-failing fixture is recorded.

**Files:**
- Modify: `test/jpeg-real.test.ts` (append one `describe` block before the closing of the file)

**Interfaces:**
- Consumes: `fixture`, `errorVsRef`, `N` from Task 3 (module-scope in the same file).
- Produces: nothing (leaf).

**Do not fix the bug.** `aspose-pdf-foss-for-ts-hof` owns it. This task only records the fixture and its expected failure so the suite stays green and the next engineer inherits the evidence.

- [ ] **Step 1: Append the skipped test**

Add to the end of `test/jpeg-real.test.ts`, after the existing `describe` block:

```ts
// KNOWN FAILING -- aspose-pdf-foss-for-ts-hof.
//
// Real arithmetic-coded JPEG (SOF9 + DAC) decodes to garbage: mean abs err
// 112.67 / max 236 / only 3.11% of samples within 2, against 1.365 for our
// BASELINE decode of the very same image. Output is correct for the first 32
// pixels -- exactly 2 MCUs at 4:2:0's 16px MCU width -- then diverges, and 401
// of 504 blocks come out flat (AC coefficients dying, DC roughly surviving).
//
// Not the custom-conditioning path: this file's DAC carries plain T.81 defaults
// (DC L=0 U=1, AC Kx=5). Prime suspect is the 3-component interleaved scan where
// Cb and Cr SHARE statistics tables (Cs=2 and Cs=3 both use Td=1/Ta=1); per T.81
// the statistics area is per table index, shared by every component using it.
//
// This is exactly the blind spot the fixture was vendored to find: jpegarith.ts
// and build-jpeg-arith.ts share the same wrong convention, so the synthetic
// round-trip suite passes. Un-skip this as part of hof's fix.
describe.skip('decodeJpeg — real arithmetic JPEG (blocked on hof)', () => {
  it('reproduces the uncompressed original within lossy tolerance', () => {
    const dec = decodeJpeg(fixture('testimgari.jpg'));
    expect(dec.width).toBe(227);
    expect(dec.height).toBe(149);
    expect(dec.comps).toBe(3);
    const e = errorVsRef(dec.data);
    expect(e.mean).toBeLessThan(2.0);
    expect(e.max).toBeLessThanOrEqual(40);
    expect(e.within8).toBeGreaterThanOrEqual(0.97);
  });
});
```

- [ ] **Step 2: Verify the suite is green and the test is skipped, not passing**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/jpeg-real.test.ts
```

Expected: `8 passed | 1 skipped`.

- [ ] **Step 3: Confirm the skipped test still reproduces the bug**

A skipped test that has silently started passing (or started throwing for an unrelated reason) is worse than none — it would misdirect whoever picks up `hof`. Verify the recorded numbers are still what the fixture actually produces:

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npx vitest run test/jpeg-real.test.ts -t "arithmetic" 2>&1 | tail -5
```

Then temporarily change `describe.skip` to `describe` and re-run.

Expected: it FAILS on the `mean` assertion, reporting a mean in the low hundreds (~112), **not** an exception and not a pass. If it throws instead, or passes, the comment above it is now wrong — update the comment and `hof` to match reality before continuing.

Restore `describe.skip` and re-run: `8 passed | 1 skipped`.

- [ ] **Step 4: Full suite and typecheck**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
npm run typecheck
npm test
```

Expected: typecheck clean; full suite green with exactly one new skip. If any pre-existing test broke, the fixtures are not at fault — investigate before committing.

- [ ] **Step 5: Commit**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git add test/jpeg-real.test.ts
git commit -m "test(w6m): record real arithmetic JPEG failure, skipped pending hof

testimgari.jpg decodes to garbage (mean abs err 112.67 vs 1.365 for baseline on
the same image): correct for exactly 2 MCUs, then AC dies and 401/504 blocks go
flat. Skipped so the suite stays green; hof owns the fix and un-skipping.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Close out

- [ ] **Step 1: Link the issues**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
bd update aspose-pdf-foss-for-ts-hof --notes "Fixture + skipped test landed in w6m: test/jpeg-real.test.ts ('real arithmetic JPEG (blocked on hof)'). Un-skip as part of the fix. Evidence and suspect: test/fixtures/jpeg/PROVENANCE.md and docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md"
bd close aspose-pdf-foss-for-ts-w6m --reason "Vendored real libjpeg fixtures (libjpeg-turbo cce89f35) + statistical assertions. Baseline RGB 4:2:0 validated against third-party bytes for the first time (mean abs err 1.365/1.428). Found and filed hof (P1): real arithmetic JPEG decodes to garbage. Gray/4:4:4/CMYK deferred to ehd -- libjpeg-turbo ships no such image and no encoder is reachable."
bd ready
```

- [ ] **Step 2: Push (MANDATORY — work is not complete until this succeeds)**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
git pull --rebase
git push
git status
```

Expected: `git status` reports the branch up to date with `origin/main`. If the push fails, resolve and retry until it succeeds — do not stop with work stranded locally.

---

## Notes for the implementer

**Do not "fix" the arithmetic decoder.** Its failure is the expected, documented outcome of this plan and the reason `hof` exists. Landing a rushed fix here defeats the point: the bug wants a systematic-debugging session with the fixture already in the tree.

**Do not loosen a threshold to make something pass.** The thresholds already carry headroom over measured values. If a baseline test fails, the decoder changed, or the fixture bytes are corrupt (re-check the SHA-256 from Task 1 Step 2) — a failure is information, not an obstacle.

**Do not regenerate or re-download the fixtures during later tasks.** They are pinned, hashed, frozen bytes.

**README.md needs no update.** This plan adds no public API — it is fixtures and tests only. (`CLAUDE.md`: keep README in sync when adding or changing a *public API*.)
