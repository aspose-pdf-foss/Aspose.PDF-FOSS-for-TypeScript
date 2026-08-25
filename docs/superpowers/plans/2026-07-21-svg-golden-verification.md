# SVG Transparency Golden Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that a real SVG engine paints `Page.ToSvg()`'s transparency output the way `Page.ToImage()` composites it, by committing browser-rendered goldens produced out of band.

**Architecture:** A manual `npx`-only generator rasterizes our SVG under headless Chrome and resvg, cross-checks the two engines, and commits the agreed PNG to `test/fixtures/svg/`. The suite compares `ToImage()` against those frozen goldens with no new test-time dependency. The oracle is two independent implementations of the same transparency math — `src/raster.ts` composites from PDF semantics, the browser composites our emitted markup.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `node:zlib`. Generator-only, never installed: `tsx`, `puppeteer`, `@resvg/resvg-js`.

**Spec:** `docs/superpowers/specs/2026-07-21-svg-golden-verification-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Never add to `dependencies`.
- **`devDependencies` stays `@types/node` + `typescript` + `vitest`.** The generator's packages are invoked through `npx` and must never be written to `package.json`.
- **ESM + NodeNext.** Import specifiers carry the `.js` extension even for `.ts` sources (`import { Page } from './page.js'`).
- **Errors** are `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **Both gates green before closing:** `npm run typecheck` and `npm test`.
- Issue is `aspose-pdf-foss-for-ts-0k7`; branch `feat/svg-golden-verification` already exists with the spec committed.

## Two Spec Deviations Found During Planning

Both are simplifications; neither changes the design.

1. **`test/helpers/decode-png.ts` already exists** with `decodePng(bytes): DecodedPng` and `.at(x, y)`. The spec's "create a PNG decoder" task is replaced by Task 1, which *extends* it — the existing decoder hard-fails on any filter type but 0, and Chrome and resvg both emit adaptive filtering.
2. **No golden-specific builders are needed.** The seven builders in `test/helpers/build-transparency-fixtures.ts` already paint large flat regions, and `test/raster-transparency.test.ts` already documents exact probe coordinates and hand-computed ISO 32000-1 expected colors. Reuse both verbatim.

## File Structure

| Path | Responsibility |
|---|---|
| `test/helpers/decode-png.ts` | **Modify.** Add PNG filter types 1–4 so foreign PNGs decode. |
| `test/helpers/compare-image.ts` | **Create.** Pure comparison: interior sampling and whole-image diff. No PDF knowledge. |
| `scripts/gen-svg-goldens.ts` | **Create.** Manual generator: build PDF → `ToSvg` → rasterize twice → cross-check → write golden + provenance row. |
| `test/fixtures/svg/*.png` | **Create.** The committed goldens. |
| `test/fixtures/svg/PROVENANCE.md` | **Create.** Producer, version, command, SHA-256, coverage and non-coverage. |
| `test/svg-golden.test.ts` | **Create.** Per-fixture comparison of `ToImage()` against the golden. |

`scripts/gen-svg-goldens.ts` is `.ts`, not `.mjs` like `gen-ucd.mjs`, because it must import the TypeScript fixture builders directly. It runs under `npx tsx`.

---

### Task 1: Decode foreign PNGs

`decodePng` asserts filter type 0 because `src/pngencode.ts` only ever writes 0. Chrome and resvg use adaptive filtering, so every golden would throw on load.

**Files:**
- Modify: `test/helpers/decode-png.ts:35-40`
- Test: `test/decode-png.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `decodePng(bytes: Uint8Array): DecodedPng` — unchanged signature, now accepting filter types 0–4. `DecodedPng` is `{ width, height, channels, colorType, data: Uint8Array, at(x, y): [number, number, number, number] }`.

- [ ] **Step 1: Write the failing test**

Create `test/decode-png.test.ts`. It builds PNGs by hand so the test does not depend on any external tool.

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from './helpers/decode-png.js';

/** Assemble a minimal 8-bit RGB PNG from pre-filtered rows. */
function makePng(width: number, height: number, filteredRows: number[][]): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: number[]) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    return [...be32(data.length), ...t, ...data, ...be32(crc([...t, ...data]))];
  };
  const ihdr = [...be32(width), ...be32(height), 8, 2, 0, 0, 0];  // 8-bit, colorType 2 (RGB)
  const idat = [...deflateSync(Buffer.from(filteredRows.flat()))];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}

describe('decodePng — adaptive filter types', () => {
  it('decodes filter 0 (None)', () => {
    const png = makePng(2, 1, [[0, 10, 20, 30, 40, 50, 60]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 0)).toEqual([40, 50, 60, 255]);
  });

  it('decodes filter 1 (Sub): each byte is a delta from the pixel to its left', () => {
    // Row: filter 1, then raw deltas. Pixel 0 has no left neighbour (a=0).
    const png = makePng(2, 1, [[1, 10, 20, 30, 5, 5, 5]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 0)).toEqual([15, 25, 35, 255]);   // 10+5, 20+5, 30+5
  });

  it('decodes filter 2 (Up): each byte is a delta from the pixel above', () => {
    const png = makePng(1, 2, [[0, 10, 20, 30], [2, 1, 2, 3]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(0, 1)).toEqual([11, 22, 33, 255]);
  });

  it('decodes filter 3 (Average): delta from floor((left + above) / 2)', () => {
    const png = makePng(2, 2, [[0, 10, 20, 30, 40, 50, 60], [3, 0, 0, 0, 0, 0, 0]]);
    const p = decodePng(png);
    // Row 1 pixel 0: a=0, b=10 → floor(10/2)=5. Pixel 1: a=5, b=40 → floor(45/2)=22.
    expect(p.at(0, 1)).toEqual([5, 10, 15, 255]);
    expect(p.at(1, 1)).toEqual([22, 30, 37, 255]);
  });

  it('decodes filter 4 (Paeth)', () => {
    const png = makePng(2, 2, [[0, 10, 20, 30, 40, 50, 60], [4, 0, 0, 0, 0, 0, 0]]);
    const p = decodePng(png);
    // Row 1 pixel 0: a=0, b=10, c=0 → Paeth picks b=10. Pixel 1: a=10, b=40, c=10 → 40.
    expect(p.at(0, 1)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 1)).toEqual([40, 50, 60, 255]);
  });

  it('rejects an unknown filter type', () => {
    const png = makePng(1, 1, [[9, 1, 2, 3]]);
    expect(() => decodePng(png)).toThrow(/filter/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/decode-png.test.ts
```

Expected: the filter-0 and unknown-filter cases PASS; filters 1–4 FAIL with `unexpected PNG filter 1 on row 0` (and 2, 3, 4).

- [ ] **Step 3: Implement adaptive unfiltering**

In `test/helpers/decode-png.ts`, replace the row loop (currently lines 35–40) with the code below. Leave everything else in the file untouched.

```ts
  const bpp = channels;                       // 8-bit only, so bytes-per-pixel == channels
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;          // left
      const b = prev ? prev[i] : 0;                    // above
      const c = prev && i >= bpp ? prev[i - bpp] : 0;  // upper-left
      let v: number;
      if (f === 0) v = src[i];
      else if (f === 1) v = src[i] + a;
      else if (f === 2) v = src[i] + b;
      else if (f === 3) v = src[i] + ((a + b) >> 1);
      else if (f === 4) v = src[i] + paeth(a, b, c);
      else throw new Error(`unexpected PNG filter ${f} on row ${y}`);
      row[i] = v & 255;
    }
  }
```

Also update the doc comment on line 17 to read:

```ts
/** Decode an 8-bit non-interlaced PNG (gray/RGB/RGBA, filter types 0-4). */
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/decode-png.test.ts
```

Expected: PASS, 6 tests.

Then confirm no regression in the suites that already use the decoder:

```bash
npx vitest run test/raster-transparency.test.ts test/pagerender.test.ts test/annotrender.test.ts
```

Expected: PASS, unchanged counts.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/decode-png.ts test/decode-png.test.ts
git commit -m "test(render): decode adaptive PNG filters

The helper only handled filter 0, which pngencode.ts always writes.
Foreign PNGs from Chrome and resvg use adaptive filtering, so goldens
would fail to load."
```

---

### Task 2: Image comparison helper

Pure functions over `DecodedPng`. No PDF, no fixture knowledge — so it is testable on synthetic images and reusable by both the test suite and the generator.

**Files:**
- Create: `test/helpers/compare-image.ts`
- Test: `test/compare-image.test.ts`

**Interfaces:**
- Consumes: `DecodedPng` from `test/helpers/decode-png.js`.
- Produces:
  - `samplesMatch(png: DecodedPng, probes: Probe[], tol?: number): string[]` — returns a human-readable failure message per probe that missed; empty array means all matched. `tol` defaults to `2`.
  - `type Probe = { x: number; y: number; rgb: [number, number, number]; note?: string }`
  - `diffImages(a: DecodedPng, b: DecodedPng): ImageDiff`
  - `type ImageDiff = { maxDelta: number; failFraction: number; width: number; height: number }` — `failFraction` is the fraction of pixels whose per-channel delta exceeds `DIFF_PIXEL_TOL`.
  - `const DIFF_PIXEL_TOL = 12` — per-channel delta above which a pixel counts as failing.

- [ ] **Step 1: Write the failing test**

Create `test/compare-image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { samplesMatch, diffImages, DIFF_PIXEL_TOL } from './helpers/compare-image.js';
import type { DecodedPng } from './helpers/decode-png.js';

/** Build a DecodedPng backed by a solid colour, with optional per-pixel overrides. */
function solid(width: number, height: number, rgb: [number, number, number],
               overrides: Record<string, [number, number, number]> = {}): DecodedPng {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  for (const [key, v] of Object.entries(overrides)) {
    const [x, y] = key.split(',').map(Number);
    data.set(v, (y * width + x) * 3);
  }
  return {
    width, height, channels: 3, colorType: 2, data,
    at(x, y) {
      const i = (y * width + x) * 3;
      return [data[i], data[i + 1], data[i + 2], 255];
    },
  };
}

describe('samplesMatch', () => {
  it('returns no failures when every probe is within tolerance', () => {
    const p = solid(4, 4, [255, 128, 128]);
    expect(samplesMatch(p, [{ x: 1, y: 1, rgb: [255, 127, 130] }])).toEqual([]);
  });

  it('reports the probe that missed, with expected and actual', () => {
    const p = solid(4, 4, [255, 128, 128]);
    const fails = samplesMatch(p, [{ x: 2, y: 2, rgb: [0, 0, 255], note: 'in-cell' }]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain('(2,2)');
    expect(fails[0]).toContain('in-cell');
    expect(fails[0]).toContain('255,128,128');
  });

  it('honours an explicit tolerance', () => {
    const p = solid(4, 4, [100, 100, 100]);
    expect(samplesMatch(p, [{ x: 0, y: 0, rgb: [104, 100, 100] }], 2)).toHaveLength(1);
    expect(samplesMatch(p, [{ x: 0, y: 0, rgb: [104, 100, 100] }], 5)).toEqual([]);
  });
});

describe('diffImages', () => {
  it('reports zero difference for identical images', () => {
    const d = diffImages(solid(10, 10, [1, 2, 3]), solid(10, 10, [1, 2, 3]));
    expect(d.maxDelta).toBe(0);
    expect(d.failFraction).toBe(0);
  });

  it('counts only pixels beyond DIFF_PIXEL_TOL as failing', () => {
    // One pixel differs by exactly the tolerance (not failing), one by well over.
    const a = solid(10, 10, [100, 100, 100]);
    const b = solid(10, 10, [100, 100, 100], {
      '0,0': [100 + DIFF_PIXEL_TOL, 100, 100],
      '1,0': [200, 100, 100],
    });
    const d = diffImages(a, b);
    expect(d.maxDelta).toBe(100);
    expect(d.failFraction).toBeCloseTo(1 / 100, 6);
  });

  it('throws when dimensions differ, rather than comparing garbage', () => {
    expect(() => diffImages(solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0])))
      .toThrow(/dimension/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/compare-image.test.ts
```

Expected: FAIL — `Failed to resolve import "./helpers/compare-image.js"`.

- [ ] **Step 3: Write the implementation**

Create `test/helpers/compare-image.ts`:

```ts
import type { DecodedPng } from './decode-png.js';

/** A named point expected to hold a specific colour. */
export interface Probe {
  x: number;
  y: number;
  rgb: [number, number, number];
  note?: string;
}

export interface ImageDiff {
  maxDelta: number;
  failFraction: number;
  width: number;
  height: number;
}

/** Per-channel delta above which a pixel counts toward `failFraction`. Sized to
 *  absorb antialiasing along edges without hiding a wrong composite colour. */
export const DIFF_PIXEL_TOL = 12;

/** Check `probes` against `png`. Returns one message per miss; [] means all hit. */
export function samplesMatch(png: DecodedPng, probes: Probe[], tol = 2): string[] {
  const fails: string[] = [];
  for (const probe of probes) {
    const [r, g, b] = png.at(probe.x, probe.y);
    const [er, eg, eb] = probe.rgb;
    if (Math.abs(r - er) <= tol && Math.abs(g - eg) <= tol && Math.abs(b - eb) <= tol) continue;
    const where = probe.note ? `(${probe.x},${probe.y}) ${probe.note}` : `(${probe.x},${probe.y})`;
    fails.push(`${where}: expected ${er},${eg},${eb} (±${tol}), got ${r},${g},${b}`);
  }
  return fails;
}

/** Whole-image comparison. Catches gross geometry drift that probes would miss. */
export function diffImages(a: DecodedPng, b: DecodedPng): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let maxDelta = 0;
  let failing = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const pa = a.at(x, y);
      const pb = b.at(x, y);
      let worst = 0;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(pa[c] - pb[c]));
      if (worst > maxDelta) maxDelta = worst;
      if (worst > DIFF_PIXEL_TOL) failing++;
    }
  }
  return { maxDelta, failFraction: failing / (a.width * a.height), width: a.width, height: a.height };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/compare-image.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/compare-image.ts test/compare-image.test.ts
git commit -m "test(render): image comparison helper for goldens

samplesMatch for flat-interior probes, diffImages for whole-image drift."
```

---

### Task 3: The generator

Two unknowns here — whether `npx` can supply the packages to a script, and whether the two engines agree at all. Step 1 is a spike that settles both cheaply before any generator code is written.

**Files:**
- Create: `scripts/gen-svg-goldens.ts`
- Create: `test/fixtures/svg/` (output)
- Modify: `.gitignore` (add the scratch dir)

**Interfaces:**
- Consumes: the seven builders from `test/helpers/build-transparency-fixtures.js`; `Document` from `src/document.js`; `decodePng` from `test/helpers/decode-png.js`; `diffImages`, `samplesMatch` from `test/helpers/compare-image.js`.
- Produces: `test/fixtures/svg/<name>.png` for each entry in the shared fixture table, and `test/fixtures/svg/PROVENANCE.md`.

- [ ] **Step 1: Spike the toolchain**

Write a throwaway file at `scripts/_spike.ts` (deleted in Step 2):

```ts
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import puppeteer from 'puppeteer';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
  + '<rect width="20" height="20" fill="#fff"/><rect x="5" y="5" width="10" height="10" fill="red" opacity="0.5"/></svg>';

writeFileSync('spike-resvg.png', new Resvg(svg, { background: 'white' }).render().asPng());

const browser = await puppeteer.launch({
  args: ['--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning'],
});
const page = await browser.newPage();
await page.setViewport({ width: 20, height: 20, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`);
writeFileSync('spike-chrome.png', await page.screenshot({ clip: { x: 0, y: 0, width: 20, height: 20 } }));
await browser.close();
console.log('spike ok');
```

Run it:

```bash
npx --yes -p tsx -p puppeteer@23.11.1 -p @resvg/resvg-js@2.6.2 -c "tsx scripts/_spike.ts"
```

Expected: prints `spike ok` and writes two 20×20 PNGs, each showing a 50%-red square (`255,128,128`) on white.

**If the bare `import` fails to resolve under `npx -c`**, fall back to a scratch install and record which mechanism worked — the PROVENANCE command in Step 6 must match reality:

```bash
mkdir -p .goldens-tooling && cd .goldens-tooling \
  && npm init -y >/dev/null \
  && npm i --no-save tsx puppeteer@23.11.1 @resvg/resvg-js@2.6.2 \
  && cd .. && ./.goldens-tooling/node_modules/.bin/tsx scripts/_spike.ts
```

- [ ] **Step 2: Clean up the spike and ignore the scratch dir**

```bash
rm -f scripts/_spike.ts spike-resvg.png spike-chrome.png
```

Append to `.gitignore`:

```
# Out-of-band golden generation tooling (scripts/gen-svg-goldens.ts)
.goldens-tooling/
```

- [ ] **Step 3: Write the fixture table**

This table is shared by the generator and Task 4's test, so it lives in a helper both import. Create `test/helpers/svg-golden-fixtures.ts`.

Probe coordinates and expected colors are copied verbatim from `test/raster-transparency.test.ts`, where they are hand-computed from ISO 32000-1 §11.3.5.2 rather than read off an implementation.

```ts
import {
  constantAlphaPdf, luminositySoftMaskPdf, tilingPatternPdf,
  tilingPatternOffsetClipPdf, strokePatternPdf, blendModePdf, isolatedGroupPdf,
} from './build-transparency-fixtures.js';
import type { Probe } from './compare-image.js';

export interface GoldenFixture {
  /** File stem under test/fixtures/svg/. */
  name: string;
  pdf: () => Uint8Array;
  width: number;
  height: number;
  /** Flat-interior points whose composite value is a mathematical constant. */
  probes: Probe[];
}

const W = [255, 255, 255] as [number, number, number];
const BLUE = [0, 0, 255] as [number, number, number];

/** Backdrop cb = 0.5 in every channel, source cs = (1,0,0), both opaque.
 *  Values are the ISO 32000-1 §11.3.5.2 formulas evaluated by hand. */
const SEPARABLE: [string, [number, number, number]][] = [
  ['Multiply',   [128,   0,   0]],
  ['Screen',     [255, 128, 128]],
  ['Darken',     [128,   0,   0]],
  ['Lighten',    [255, 128, 128]],
  ['Difference', [128, 128, 128]],
  ['Exclusion',  [128, 128, 128]],
];

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    name: 'constant-alpha',
    pdf: constantAlphaPdf,
    width: 200, height: 200,
    probes: [
      { x: 100, y: 100, rgb: [255, 128, 128], note: 'ca 0.5 red over white' },
      { x: 10, y: 10, rgb: W, note: 'outside the square' },
    ],
  },
  {
    name: 'soft-mask-luminosity',
    pdf: luminositySoftMaskPdf,
    width: 200, height: 200,
    probes: [
      { x: 50, y: 100, rgb: [255, 0, 0], note: 'under the white half of the mask' },
      { x: 150, y: 100, rgb: W, note: 'under the black half of the mask' },
    ],
  },
  {
    name: 'tiling-pattern',
    pdf: tilingPatternPdf,
    width: 100, height: 100,
    probes: [
      { x: 5, y: 95, rgb: BLUE, note: 'user (5,5) in-cell' },
      { x: 15, y: 85, rgb: W, note: 'user (15,15) gap' },
      { x: 45, y: 55, rgb: BLUE, note: 'user (45,45) third tile' },
    ],
  },
  {
    name: 'tiling-pattern-offset-clip',
    pdf: tilingPatternOffsetClipPdf,
    width: 100, height: 100,
    probes: [
      { x: 45, y: 55, rgb: BLUE, note: 'user (45,45) in-cell inside the clip' },
      { x: 55, y: 45, rgb: W, note: 'user (55,55) gap' },
      { x: 65, y: 35, rgb: BLUE, note: 'user (65,65) in-cell' },
      { x: 5, y: 95, rgb: W, note: 'user (5,5) outside the clip' },
      { x: 95, y: 5, rgb: W, note: 'user (95,95) outside the clip' },
    ],
  },
  {
    name: 'stroke-pattern',
    pdf: strokePatternPdf,
    width: 100, height: 100,
    probes: [
      { x: 50, y: 50, rgb: BLUE, note: 'inside the stroke band' },
      { x: 50, y: 10, rgb: W, note: 'above the stroke band' },
    ],
  },
  {
    name: 'isolated-group',
    pdf: isolatedGroupPdf,
    width: 200, height: 200,
    probes: [
      // Drawn inline the overlap composites twice and reads (255,64,64).
      { x: 80, y: 120, rgb: [255, 128, 128], note: 'overlap — must not double-darken' },
      { x: 30, y: 170, rgb: [255, 128, 128], note: 'non-overlapping part' },
    ],
  },
  ...SEPARABLE.map(([mode, rgb]) => ({
    name: `blend-${mode.toLowerCase()}`,
    pdf: () => blendModePdf(mode),
    width: 100, height: 100,
    probes: [{ x: 50, y: 50, rgb, note: `${mode} of cs=(1,0,0) over cb=0.5` }],
  })),
  {
    name: 'blend-luminosity',
    pdf: () => blendModePdf('Luminosity'),
    width: 100, height: 100,
    // Neutral gray backdrop has no hue; source luminance is 0.3·1 → 77.
    probes: [{ x: 50, y: 50, rgb: [77, 77, 77], note: 'Luminosity → neutral gray 0.3' }],
  },
];
```

`blend-color`, `blend-hue` and `blend-saturation` are deliberately absent: their correct output is a range, not a point (see `test/raster-transparency.test.ts`, which asserts inequalities for `Color`). The whole-image diff in Task 4 still covers them if goldens are generated, but a point probe would encode an implementation detail as truth. Task 5 revisits this if the whole-image check proves informative.

- [ ] **Step 4: Write the generator**

Create `scripts/gen-svg-goldens.ts`:

```ts
// Generates test/fixtures/svg/*.png — browser-rendered goldens for ToSvg's
// transparency output. Rasterizes our SVG under headless Chrome and resvg,
// requires the two engines to agree, and writes the agreed PNG. An engine
// disagreement is reported, not resolved: a golden that freezes one engine's
// quirk is worse than no golden.
//
// Not part of `npm test` and its packages are never added to package.json.
// Run: npx --yes -p tsx -p puppeteer@23.11.1 -p @resvg/resvg-js@2.6.2 \
//        -c "tsx scripts/gen-svg-goldens.ts"
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import puppeteer from 'puppeteer';
import { Document } from '../src/document.js';
import { decodePng } from '../test/helpers/decode-png.js';
import { diffImages, samplesMatch } from '../test/helpers/compare-image.js';
import { GOLDEN_FIXTURES } from '../test/helpers/svg-golden-fixtures.js';

const CHROME_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning'];
const MAX_FAIL_FRACTION = 0.02;   // cross-engine: edge AA only

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'svg');

const browser = await puppeteer.launch({ args: CHROME_ARGS });

async function renderChrome(svg: string, width: number, height: number): Promise<Uint8Array> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  await page.close();
  return new Uint8Array(shot);
}

function renderResvg(svg: string): Uint8Array {
  return new Resvg(svg, { background: 'white', fitTo: { mode: 'original' } }).render().asPng();
}

mkdirSync(outDir, { recursive: true });

const rows: string[] = [];
const skipped: string[] = [];

for (const fx of GOLDEN_FIXTURES) {
  const svg = Document.Open(fx.pdf()).Pages[0].ToSvg();
  const chromePng = await renderChrome(svg, fx.width, fx.height);
  const resvgPng = renderResvg(svg);

  const c = decodePng(chromePng);
  const r = decodePng(resvgPng);
  const cross = diffImages(c, r);

  const cFails = samplesMatch(c, fx.probes);
  const rFails = samplesMatch(r, fx.probes);

  if (cross.failFraction > MAX_FAIL_FRACTION) {
    skipped.push(`${fx.name}: engines disagree — maxDelta ${cross.maxDelta}, `
      + `failFraction ${cross.failFraction.toFixed(4)}`);
    continue;
  }
  if (cFails.length || rFails.length) {
    skipped.push(`${fx.name}: engines agree with each other but not with PDF semantics\n`
      + [...cFails.map((f) => `    chrome ${f}`), ...rFails.map((f) => `    resvg  ${f}`)].join('\n'));
    continue;
  }

  writeFileSync(join(outDir, `${fx.name}.png`), chromePng);
  const sha = createHash('sha256').update(chromePng).digest('hex');
  rows.push(`| \`${fx.name}.png\` | ${fx.width}×${fx.height} | ${cross.maxDelta} | \`${sha}\` |`);
  console.log(`ok   ${fx.name} (cross-engine maxDelta ${cross.maxDelta})`);
}

await browser.close();

for (const s of skipped) console.error(`SKIP ${s}`);
console.log(`\n${rows.length} golden(s) written, ${skipped.length} skipped.`);
console.log('Paste these rows into test/fixtures/svg/PROVENANCE.md:\n');
console.log(rows.join('\n'));
```

Note the two distinct skip reasons. Engines-disagree means our markup is not portable. Engines-agree-but-wrong means our markup is portable and portably wrong — the more interesting finding, and the one the spec predicts for luminosity.

- [ ] **Step 5: Run the generator**

```bash
npx --yes -p tsx -p puppeteer@23.11.1 -p @resvg/resvg-js@2.6.2 -c "tsx scripts/gen-svg-goldens.ts"
```

Expected: a mix of `ok` and `SKIP` lines. **Do not tune thresholds to make skips go away.** Record every skip verbatim — it is the deliverable of Task 5. Confirm at least `constant-alpha` writes a golden; if *nothing* writes, the toolchain is misconfigured (most likely the viewport/background), not the library.

- [ ] **Step 6: Write PROVENANCE.md**

Create `test/fixtures/svg/PROVENANCE.md`, filling the table from the generator's output and the version/OS values from your actual run. Replace every bracketed value.

```markdown
# SVG Transparency Goldens — Provenance

Browser-rendered rasterizations of `Page.ToSvg()` output for the transparency
constructs. They exist to answer a question the builders cannot: does a real SVG
engine paint our markup the way `Page.ToImage()` composites it? Our rasterizer
works from PDF semantics and the browser works from our emitted markup, so the
two are independent implementations and agreement is evidence.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-svg-goldens.ts` (not run by `npm test`) |
| Committed bytes from | headless Chrome via puppeteer [VERSION] |
| Cross-checked against | `@resvg/resvg-js` [VERSION] |
| Node | [VERSION] |
| OS | [OS AND VERSION] |
| Date | 2026-07-21 |

Command:

```bash
npx --yes -p tsx -p puppeteer@[VERSION] -p @resvg/resvg-js@[VERSION] \
  -c "tsx scripts/gen-svg-goldens.ts"
```

Chrome is pinned to sRGB with LCD text and subpixel positioning disabled
(`--force-color-profile=srgb --disable-lcd-text
--disable-font-subpixel-positioning`) so its output is reproducible.

A golden is written only if Chrome and resvg agree (whole-image failing-pixel
fraction ≤ 2%) **and** both match the hand-computed ISO 32000-1 §11.3.5.2 probe
values. A fixture that fails either gate is listed under Divergences below
instead of being committed.

## Goldens

| File | Size | Cross-engine maxDelta | SHA-256 |
|---|---|---|---|
[GENERATOR ROWS]

## Divergences

[One subsection per skipped fixture: the generator's verbatim message, the
diagnosis, and either the commit that fixed it or the bd issue tracking it.
Write "None — every fixture agreed." only if the generator skipped nothing.]

## Covers

- ExtGState constant alpha (`ca` / `CA`).
- `/SMask` luminosity soft masks — coefficients and colour-interpolation space.
- Tiling patterns: lattice phase, `patternTransform` against our device-space
  covering rect, clip interaction, and `SCN` stroke patterns.
- Isolated transparency groups (`isolation="isolate"`).
- The six separable blend modes plus `Luminosity`.

## Does NOT cover

- **Non-isolated groups and knockout groups.** Backdrop removal is unimplemented
  — see `aspose-pdf-foss-for-ts-bbu`.
- **`Hue`, `Saturation`, `Color` blend modes.** Correct output for these is a
  range rather than a point, so there is no flat-interior probe value that is not
  itself an implementation detail.
- **Any renderer other than Chrome and resvg.** Firefox and Safari are unverified.
- **`ToImage` correctness.** These goldens check that the SVG matches the raster
  backend and the ISO formulas; the raster backend's own conformance is
  `test/raster-transparency.test.ts`.
- **Text, shadings, and images** under transparency. Only vector fills and
  strokes appear in these fixtures.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-svg-goldens.ts test/helpers/svg-golden-fixtures.ts \
        test/fixtures/svg/ .gitignore
git commit -m "test(render): SVG transparency golden generator

Rasterizes ToSvg output under Chrome and resvg, requires the engines to
agree and both to match the hand-computed ISO values, and commits the
agreed PNG. npx-only; nothing added to package.json."
```

---

### Task 4: The golden tests

**Files:**
- Create: `test/svg-golden.test.ts`

**Interfaces:**
- Consumes: `GOLDEN_FIXTURES` from `test/helpers/svg-golden-fixtures.js`; `decodePng`; `samplesMatch`, `diffImages` from `test/helpers/compare-image.js`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

The goldens already exist from Task 3, so this test should pass on first run — which is exactly why Task 6 exists. Create `test/svg-golden.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { samplesMatch, diffImages } from './helpers/compare-image.js';
import { GOLDEN_FIXTURES } from './helpers/svg-golden-fixtures.js';

// ESM: no __dirname. Same idiom as test/jpeg-real.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures', 'svg');

// A golden is committed only for fixtures where Chrome and resvg agreed with
// each other and with the ISO formulas. The rest are recorded as divergences in
// PROVENANCE.md; skipping here keeps the suite honest about what is verified.
const present = GOLDEN_FIXTURES.filter((fx) => existsSync(join(dir, `${fx.name}.png`)));

describe('ToSvg transparency — browser goldens', () => {
  it('has at least one golden committed', () => {
    expect(present.length).toBeGreaterThan(0);
  });

  for (const fx of present) {
    describe(fx.name, () => {
      const golden = decodePng(new Uint8Array(readFileSync(join(dir, `${fx.name}.png`))));
      const ours = decodePng(Document.Open(fx.pdf()).Pages[0].ToImage());

      it('renders at the golden’s dimensions', () => {
        expect([ours.width, ours.height]).toEqual([golden.width, golden.height]);
      });

      it('agrees with the browser on the composited interior colours', () => {
        // Tight: these points are flat, so antialiasing cannot explain a miss.
        expect(samplesMatch(golden, fx.probes)).toEqual([]);
        expect(samplesMatch(ours, fx.probes)).toEqual([]);
      });

      it('agrees with the browser across the whole page', () => {
        // Loose: sized for edge antialiasing, not for a wrong composite.
        const d = diffImages(golden, ours);
        expect(d.failFraction).toBeLessThanOrEqual(0.02);
      });
    });
  }
});
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run test/svg-golden.test.ts
```

Expected: PASS for every committed golden. A failure here means Task 3 wrote a golden it should have skipped — investigate rather than loosening the threshold.

- [ ] **Step 3: Run the full suite and typecheck**

```bash
npm run typecheck && npm test
```

Expected: both green; total test count up by the new files.

- [ ] **Step 4: Commit**

```bash
git add test/svg-golden.test.ts
git commit -m "test(render): compare ToImage against browser SVG goldens

Interior probes tight for the compositing math, whole-image loose for
geometry drift."
```

---

### Task 5: Triage the divergences

Consumes the `SKIP` lines from Task 3 Step 5. If there were none, this task is a single commit updating PROVENANCE.md to say so.

**Files:**
- Modify: `src/svgrender.ts` (only for contained emission fixes)
- Modify: `test/fixtures/svg/PROVENANCE.md`

- [ ] **Step 1: Diagnose each skipped fixture**

For each, dump the SVG and read what we emit:

```bash
npx tsx -e "import {Document} from './src/document.js'; import {luminositySoftMaskPdf} from './test/helpers/build-transparency-fixtures.js'; console.log(Document.Open(luminositySoftMaskPdf()).Pages[0].ToSvg())"
```

Classify each as **contained** (fixable by changing what `svgrender.ts` emits) or **structural** (needs rework of the offscreen model).

- [ ] **Step 2: Fix the contained ones**

The likely one, per the spec: SVG 1.1 masks default to `linearRGB` colour interpolation while PDF luminosity is computed on device values. If that is the diagnosis, the fix is on `src/svgrender.ts:98`:

```ts
      this.w.addDef(`<mask id="${id}" maskUnits="userSpaceOnUse" `
        + `style="mask-type:${type}" color-interpolation="sRGB">${inner}</mask>`);
```

Apply one fix at a time. After each, re-run the generator (Task 3 Step 5) and confirm that fixture moves from `SKIP` to `ok`. If a fix does not move it, revert the fix — do not stack speculative changes.

Note the residual risk even when this works: PDF uses 0.3/0.59/0.11 and CSS `mask-type:luminance` uses Rec.709 (0.2126/0.7152/0.0722). Working space and coefficients are separate problems. The `luminositySoftMaskPdf` fixture is pure black and white, where both coefficient sets agree, so it cannot detect a coefficient error. If the working-space fix lands, file a follow-up for a mid-gray mask fixture that can.

- [ ] **Step 3: File bd issues for the structural ones**

```bash
bd create "SVG <describe the divergence>" -p 4 -t bug \
  -d "Found by scripts/gen-svg-goldens.ts under 0k7. <generator message verbatim>. <diagnosis>. No golden is committed for test/fixtures/svg/<name>.png; see the Divergences section of test/fixtures/svg/PROVENANCE.md."
```

- [ ] **Step 4: Fill in the Divergences section**

Replace the placeholder in `test/fixtures/svg/PROVENANCE.md` with one subsection per skipped fixture: the generator's verbatim message, the diagnosis, and either the fixing commit or the bd issue id.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test
```

Expected: both green. Any fixture fixed in Step 2 now has a golden, and `test/svg-golden.test.ts` picks it up automatically.

```bash
git add src/svgrender.ts test/fixtures/svg/
git commit -m "fix(render): <the divergence fixed>

Found by the browser goldens: <what the engines painted vs what PDF
specifies>. Remaining divergences recorded in PROVENANCE.md."
```

---

### Task 6: Prove the goldens are load-bearing

Repo rule: a fixture that passes on the first run is not evidence. Break the code path and confirm the suite goes red. This task changes no committed code — every mutation is reverted.

**Files:** none committed. `src/svgrender.ts` is mutated and reverted.

- [ ] **Step 1: Establish the baseline**

```bash
npx vitest run test/svg-golden.test.ts
```

Expected: PASS. Note the passing test count.

- [ ] **Step 2: Mutate the tiling-pattern origin**

In `src/svgrender.ts:109`, shift the pattern origin:

```ts
        + `x="${fmt(use.bbox[0] + 7)}" y="${fmt(use.bbox[1])}" `
```

Regenerate only what this affects and re-run:

```bash
npx --yes -p tsx -p puppeteer@23.11.1 -p @resvg/resvg-js@2.6.2 -c "tsx scripts/gen-svg-goldens.ts"
```

Expected: `tiling-pattern` and `tiling-pattern-offset-clip` now SKIP with probe mismatches. **Revert the mutation and the regenerated goldens:**

```bash
git checkout src/svgrender.ts test/fixtures/svg/
```

- [ ] **Step 3: Mutate group isolation**

In `src/svgrender.ts:120`, drop the isolation attribute:

```ts
    const attrs = [`opacity="${fmt(use.alpha)}"`];
```

Regenerate. Expected: `isolated-group` SKIPs — its overlap probe reads roughly `255,64,64` instead of `255,128,128`, because without isolation the two squares composite separately. This is the one assertion that cannot pass by accident.

```bash
git checkout src/svgrender.ts test/fixtures/svg/
```

- [ ] **Step 4: Mutate a blend mode**

In `src/svgrender.ts`, find `blendCss` and make it map `Multiply` to `screen`. Regenerate. Expected: `blend-multiply` SKIPs, probe reading `255,128,128` instead of `128,0,0`.

```bash
git checkout src/svgrender.ts test/fixtures/svg/
```

- [ ] **Step 5: Confirm the tree is clean and green**

```bash
git status --short          # must show no modifications
npm run typecheck && npm test
```

Expected: clean tree, both gates green, same test count as Step 1.

If any mutation did **not** produce a SKIP, that construct is unverified — the golden is decorative. Say so plainly, add the finding to the Divergences section of PROVENANCE.md, and file a bd issue rather than leaving a fixture that cannot fail.

- [ ] **Step 6: Record the mutation results and close out**

Append to `test/fixtures/svg/PROVENANCE.md` under a new `## Mutation checks` heading: each mutation, and which fixtures went red. Then:

```bash
git add test/fixtures/svg/PROVENANCE.md
git commit -m "docs(render): record golden mutation checks

Confirms the goldens fail when pattern origin, group isolation, and
blend-mode mapping are broken."
```

- [ ] **Step 7: Push and close the issue**

```bash
git push -u origin feat/svg-golden-verification
bd close aspose-pdf-foss-for-ts-0k7
```

---

## Self-Review

**Spec coverage.** Generator with engine cross-check → Task 3. `test/fixtures/svg/` + PROVENANCE → Task 3 Steps 6–7. Golden test with interiors-tight/whole-image-loose → Tasks 2 and 4. PNG decoder → Task 1 (revised: extend, not create). Coverage table → Task 3 Step 3. Scope-of-fixes → Task 5. "Prove assertions load-bearing" → Task 6. Regenerability risk → mitigated by the pinned versions and command in PROVENANCE.

**Deviations from spec, both recorded above:** the decoder already exists; no golden-specific builders are needed. One coverage reduction: `Hue`/`Saturation`/`Color` get no point probe, justified in Task 3 Step 3 and listed under "Does NOT cover".

**Type consistency.** `Probe` is defined once in `compare-image.ts` and imported by `svg-golden-fixtures.ts`. `DecodedPng` keeps its existing shape; Task 1 changes only the decode loop, not the interface. `samplesMatch` returns `string[]` and is asserted with `.toEqual([])` in both the generator and the test. `diffImages` returns `failFraction`, used against `0.02` in both places.
