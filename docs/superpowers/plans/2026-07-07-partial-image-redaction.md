# Partial Image Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redact the part of an image XObject covered by a redaction region — decode the image, black out only the covered pixels, and re-encode — instead of throwing on partial coverage.

**Architecture:** The rasterizer's existing `decodeImageRgba` decodes the image to RGBA; a new pure module `imageredact.ts` maps device rects to pixel boxes (via the inverse image CTM), blanks those pixels, and re-encodes as a DeviceRGB FlateDecode XObject (plus a DeviceGray `/SMask` when the source had alpha). `redact.ts` orchestrates: it registers the re-encoded image as a *new* object (copy-on-write) under a fresh `/XObject` name and rewrites the covered `Do` operand, so shared images and other placements are unaffected.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), `node:zlib` (`deflateSync`), vitest. Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension.
- **strict TypeScript** — `npm run typecheck` must stay green.
- **TDD** — failing vitest test first; fixtures built programmatically in `test/helpers/`.
- **Public error type** — throw `UnsupportedFeatureError` (from `errors.ts`) for the fail-closed limits.
- **Quality gates before closing** — `npm run typecheck` and `npm test` both green.
- **Matrix convention** (`text.ts`): `Matrix = [a,b,c,d,e,f]`, `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
- **`ImageRgba`** (`raster.ts`): `{ w, h, data }`, straight-alpha RGBA 8-bit, **row 0 = top**; pixel `(x,y)` at `data[(y*w+x)*4 + k]`, `k∈{0:R,1:G,2:B,3:A}`.
- **Fail-closed limits stay `UnsupportedFeatureError`** (each has a follow-up issue): undecodable codecs (DCT/JPX/JBIG2), rotated/skewed placement, partial inline images.
- **Beads issue:** `aspose-pdf-foss-for-ts-gq8`.

---

## Task 1: Matrix inverse + image CTM on `ImageEvent`

Expose the placement matrix at the redaction site and add the affine inverse used to map device rects into image space.

**Files:**
- Modify: `src/text.ts` (add `invert`; add `ctm` to `ImageEvent` at ~line 165 and to the `emitImage` call at ~line 407)
- Test: `test/imagegeom.test.ts` (new)

**Interfaces:**
- Consumes: existing `Matrix`, `apply`, `mul` from `./text.js`.
- Produces:
  - `invert(m: Matrix): Matrix` from `text.ts` — throws on a singular matrix.
  - `ImageEvent.ctm: Matrix` — the CTM active at the image draw (unit square → device).

- [ ] **Step 1: Write the failing test**

Create `test/imagegeom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { invert, apply, Matrix, visitContent, ImageEvent } from '../src/text.js';
import { Document } from '../src/document.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';

describe('invert', () => {
  it('round-trips a point through a scaled+flipped+translated matrix', () => {
    const m: Matrix = [2, 0, 0, -3, 10, 20];
    const mi = invert(m);
    const [x, y] = apply(m, 4, 5);
    const [bx, by] = apply(mi, x, y);
    expect(bx).toBeCloseTo(4);
    expect(by).toBeCloseTo(5);
  });

  it('throws on a singular matrix', () => {
    expect(() => invert([0, 0, 0, 0, 1, 1])).toThrow();
  });
});

describe('ImageEvent.ctm', () => {
  it('carries the placement matrix', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // q 100 0 0 100 50 50 cm /Im0 Do Q
    const evs: ImageEvent[] = [];
    visitContent(doc, doc.Pages[0], { image: (e) => evs.push(e) });
    expect(evs).toHaveLength(1);
    expect(evs[0].ctm).toEqual([100, 0, 0, 100, 50, 50]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/imagegeom.test.ts`
Expected: FAIL — `invert` not exported; `ctm` missing on `ImageEvent`.

- [ ] **Step 3: Add `invert` to `text.ts`**

After `apply` (~line 30) in `src/text.ts`:

```ts
/** Inverse of a 2×3 affine matrix. Throws when the linear part is singular. */
export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error('invert: singular matrix');
  return [
    d / det, -b / det, -c / det, a / det,
    (c * f - d * e) / det, (b * e - a * f) / det,
  ];
}
```

- [ ] **Step 4: Add `ctm` to `ImageEvent` and emit it**

In `src/text.ts`, add to the `ImageEvent` interface (~line 165):

```ts
  /** The CTM active at the image draw (maps the image unit square to device). */
  ctm: Matrix;
```

In `emitImage` (~line 407), include it in the emitted event:

```ts
  ctx.visitor.image({ addr, quad: bboxOfUnitSquare(ctm), ctm, kind, mcid, artifact: artifact || undefined });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/imagegeom.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/text.ts test/imagegeom.test.ts
git commit -m "feat(gq8): matrix invert + image CTM on ImageEvent"
```

---

## Task 2: Pure image-redaction core (`imageredact.ts`)

The pure, `Document`-free pieces: device-rect → pixel-box mapping, pixel blanking, and RGBA → FlateDecode-XObject re-encoding.

**Files:**
- Modify: `src/raster.ts` (export `decodeImageRgba` and the `ImageRgba` interface — ~lines 524, 573)
- Create: `src/imageredact.ts`
- Test: `test/imageredact.test.ts` (new)

**Interfaces:**
- Consumes: `Matrix`, `invert`, `apply` from `./text.js`; `Rect` from `./text.js`; `ImageRgba` from `./raster.js`; `PdfDict`, `PdfObject`, `name` from `./types.js`; `deflateSync` from `node:zlib`.
- Produces (from `imageredact.ts`):
  - `type PixelBox = { x0: number; y0: number; x1: number; y1: number }` (half-open, `x0<x1`, `y0<y1`).
  - `coveredPixelBox(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox | undefined` — pixel box for one device rect; `undefined` when the rect misses the image; throws `UnsupportedFeatureError` on a rotated/skewed `ctm`.
  - `blankPixels(img: ImageRgba, boxes: PixelBox[]): void` — RGB→0, alpha→255 inside each box.
  - `encodeRgbaXObject(img: ImageRgba): { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } }`.

- [ ] **Step 1: Export the decoder from `raster.ts`**

In `src/raster.ts`, change the `ImageRgba` interface (~line 524) and `decodeImageRgba` function (~line 573) declarations to be exported:

```ts
export interface ImageRgba { w: number; h: number; data: Uint8Array; }
```

```ts
export function decodeImageRgba(doc: Document, stream: PdfStream, fill: Rgb): ImageRgba | undefined {
```

(No behavior change; only the `export` keyword is added.)

- [ ] **Step 2: Write the failing test**

Create `test/imageredact.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { coveredPixelBox, blankPixels, encodeRgbaXObject } from '../src/imageredact.js';
import type { ImageRgba } from '../src/raster.js';
import type { Matrix } from '../src/text.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isName } from '../src/types.js';

// A 4×4 image placed at device [0,0,100,100] via cm = [100,0,0,100,0,0].
const CM: Matrix = [100, 0, 0, 100, 0, 0];

function solid(w: number, h: number, rgba: [number, number, number, number]): ImageRgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { w, h, data };
}

describe('coveredPixelBox', () => {
  it('maps the left device half to the left pixel columns', () => {
    const box = coveredPixelBox(CM, 4, 4, [0, 0, 50, 100]);
    expect(box).toEqual({ x0: 0, y0: 0, x1: 2, y1: 4 });
  });

  it('flips rows for a top device band (v→row: row 0 is top)', () => {
    // Device y in [75,100] is the TOP of the image (v near 1) → pixel rows 0..1.
    const box = coveredPixelBox(CM, 4, 4, [0, 75, 100, 100]);
    expect(box).toEqual({ x0: 0, y0: 0, x1: 4, y1: 1 });
  });

  it('returns undefined when the rect misses the image', () => {
    expect(coveredPixelBox(CM, 4, 4, [200, 200, 300, 300])).toBeUndefined();
  });

  it('throws on a rotated CTM', () => {
    const rot: Matrix = [0, 100, -100, 0, 100, 0]; // 90° rotation
    expect(() => coveredPixelBox(rot, 4, 4, [0, 0, 50, 50])).toThrow(UnsupportedFeatureError);
  });
});

describe('blankPixels', () => {
  it('zeros RGB and sets alpha 255 inside the box only', () => {
    const img = solid(2, 2, [10, 20, 30, 40]);
    blankPixels(img, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // top-left pixel only
    expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);   // blanked
    expect([...img.data.subarray(4, 8)]).toEqual([10, 20, 30, 40]); // untouched
  });
});

describe('encodeRgbaXObject', () => {
  it('emits a DeviceRGB Flate image and no SMask when fully opaque', () => {
    const img = solid(2, 1, [1, 2, 3, 255]);
    const out = encodeRgbaXObject(img);
    expect(out.smask).toBeUndefined();
    const cs = out.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    expect(out.dict.get('Width')).toBe(2);
    expect([...inflateSync(Buffer.from(out.raw))]).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('emits an SMask when any pixel has alpha < 255', () => {
    const img = solid(1, 1, [9, 9, 9, 128]);
    const out = encodeRgbaXObject(img);
    expect(out.smask).toBeDefined();
    expect([...inflateSync(Buffer.from(out.smask!.raw))]).toEqual([128]);
    const scs = out.smask!.dict.get('ColorSpace');
    expect(isName(scs) && scs.name).toBe('DeviceGray');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/imageredact.test.ts`
Expected: FAIL — module `../src/imageredact.js` not found.

- [ ] **Step 4: Implement `src/imageredact.ts`**

```ts
// Pure core for partial image redaction: map a device rect to the covered pixel
// box of an axis-aligned image placement, blank those pixels, and re-encode the
// RGBA raster as a DeviceRGB FlateDecode image XObject (+ DeviceGray /SMask when
// the source had transparency). No Document mutation — redact.ts orchestrates.

import { deflateSync } from 'node:zlib';
import { Matrix, Rect, invert, apply } from './text.js';
import type { ImageRgba } from './raster.js';
import { PdfDict, PdfObject, name } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

/** Half-open pixel box: covers columns [x0,x1) and rows [y0,y1). */
export interface PixelBox { x0: number; y0: number; x1: number; y1: number; }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The pixel box of `rect` within an image of `w`×`h` placed by `ctm`. Returns
 *  undefined when the rect does not overlap the image. Throws for a rotated or
 *  skewed placement (nonzero off-diagonal terms). */
export function coveredPixelBox(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox | undefined {
  const EPS = 1e-6;
  if (Math.abs(ctm[1]) > EPS || Math.abs(ctm[2]) > EPS)
    throw new UnsupportedFeatureError('rotated/skewed image placement is not supported for partial redaction');

  const inv = invert(ctm);
  const [ua, va] = apply(inv, rect[0], rect[1]);
  const [ub, vb] = apply(inv, rect[2], rect[3]);
  const uLo = clamp01(Math.min(ua, ub)), uHi = clamp01(Math.max(ua, ub));
  const vLo = clamp01(Math.min(va, vb)), vHi = clamp01(Math.max(va, vb));
  if (uHi <= uLo || vHi <= vLo) return undefined; // no overlap after clamping

  const x0 = Math.floor(uLo * w), x1 = Math.ceil(uHi * w);
  // v=1 is the TOP of the image (pixel row 0), so rows flip.
  const y0 = Math.floor((1 - vHi) * h), y1 = Math.ceil((1 - vLo) * h);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(w, x1), y1: Math.min(h, y1) };
}

/** Blank every pixel inside each box: RGB→0, alpha→255 (opaque black). */
export function blankPixels(img: ImageRgba, boxes: PixelBox[]): void {
  const { w, data } = img;
  for (const b of boxes) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const p = (y * w + x) * 4;
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 255;
      }
    }
  }
}

function imageDict(w: number, h: number, cs: string): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', w], ['Height', h],
    ['ColorSpace', name(cs)], ['BitsPerComponent', 8],
    ['Filter', name('FlateDecode')],
  ]);
}

/** Re-encode straight-alpha RGBA as a DeviceRGB FlateDecode image, plus a
 *  DeviceGray /SMask when any pixel is non-opaque. */
export function encodeRgbaXObject(img: ImageRgba): {
  dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array };
} {
  const { w, h, data } = img;
  const rgb = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  let hasAlpha = false;
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
    alpha[i] = data[i * 4 + 3];
    if (alpha[i] !== 255) hasAlpha = true;
  }
  const raw = new Uint8Array(deflateSync(Buffer.from(rgb)));
  const out: { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } } = {
    dict: imageDict(w, h, 'DeviceRGB'), raw,
  };
  if (hasAlpha) {
    out.smask = { dict: imageDict(w, h, 'DeviceGray'), raw: new Uint8Array(deflateSync(Buffer.from(alpha))) };
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/imageredact.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/raster.ts src/imageredact.ts test/imageredact.test.ts
git commit -m "feat(gq8): pure image-redaction core (pixel box, blank, re-encode)"
```

---

## Task 3: Wire re-encode + copy-on-write into `redact.ts`

Replace the partial-image throw with the decode → blank → re-encode → COW path, in both `removeRegionContent` (the `redactPage` path) and the standalone `removeImagesUnder`.

**Files:**
- Modify: `src/redact.ts`
- Test: `test/helpers/build-image-pdf.ts` (add a placed-image fixture), `test/redact-image.test.ts` (extend)

**Interfaces:**
- Consumes: `decodeImageRgba` from `./raster.js`; `coveredPixelBox`, `blankPixels`, `encodeRgbaXObject`, `PixelBox` from `./imageredact.js`; `ImageEvent.ctm` (Task 1); `Matrix` from `./text.js`; `ensureOwnResources`, `ensureOwnSubdict` (already imported); `doc.allocObject`, `doc.resolve`; `name`, `isName`, `isStream`, `PdfStream` from `./types.js`.
- Produces: `removeRegionContent` / `removeImagesUnder` re-encode partially-covered image XObjects instead of throwing; each rewritten `Do` points at a fresh copy-on-write image.

- [ ] **Step 1: Add a placed multi-pixel image fixture**

Append to `test/helpers/build-image-pdf.ts`:

```ts
/** Build a 1-page PDF with a `width`×`height` DeviceRGB 8bpc Flate image `Im0`
 *  drawn once per entry in `placements` (each a `cm` operand string). */
export function buildPlacedImagePdf(opts: {
  width: number; height: number; samples: Uint8Array; // length width*height*3
  placements: string[]; mediaBox?: string;
}): Uint8Array {
  const { width, height, samples, placements, mediaBox = '0 0 100 100' } = opts;
  const rgbRaw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const stream = placements.map((cm) => `q ${cm} cm /Im0 Do Q`).join(' ');
  const content = enc(stream);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgbRaw.length} >>`, raw: rgbRaw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  const maxObj = 5;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else { push(enc(`${n} 0 obj\n${o.dict}\nstream\n`)); push(o.raw); push(enc(`\nendstream\nendobj\n`)); }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concat(parts);
}
```

- [ ] **Step 2: Write the failing end-to-end tests**

Append to `test/redact-image.test.ts` (add imports at the top of the file):

```ts
import { redactPage } from '../src/redact.js';
import { buildPlacedImagePdf } from './helpers/build-image-pdf.js';

// A 4×4 DeviceRGB image; each pixel a distinct non-black colour so blanking is
// detectable. Row 0 is the TOP row of the image.
function grid4(): Uint8Array {
  const s = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < 16; i++) { s[i * 3] = 10 + i; s[i * 3 + 1] = 100; s[i * 3 + 2] = 200; }
  return s;
}
// Image placed at device [0,0,100,100].
const PLACE = '100 0 0 100 0 0';

describe('partial image redaction (clip + re-encode)', () => {
  it('blacks only the covered pixel columns, leaving the rest', () => {
    const doc = Document.Open(buildPlacedImagePdf({ width: 4, height: 4, samples: grid4(), placements: [PLACE] }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 2 columns
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const w = imgs[0].Width, samples = imgs[0].Decode();
    const px = (x: number, y: number) => [samples[(y * w + x) * 3], samples[(y * w + x) * 3 + 1], samples[(y * w + x) * 3 + 2]];
    expect(px(0, 0)).toEqual([0, 0, 0]); // covered (left) → black
    expect(px(1, 2)).toEqual([0, 0, 0]);
    expect(px(2, 0)[1]).toBe(100);       // uncovered (right) → original green channel
    expect(px(3, 3)[2]).toBe(200);
  });

  it('still drops a fully-covered image', () => {
    const doc = Document.Open(buildPlacedImagePdf({ width: 4, height: 4, samples: grid4(), placements: [PLACE] }));
    redactPage(doc, doc.Pages[0], [[-5, -5, 105, 105]]); // fully contains the image
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Images).toHaveLength(0);
    expect(content(reopened)).not.toContain('Do');
  });

  it('leaves a second placement of a shared image untouched (copy-on-write)', () => {
    // Two draws of Im0: one at [0,0,100,100] (partially redacted), one off to the
    // side at [100,0,200,100] (untouched). MediaBox widened to hold both.
    const doc = Document.Open(buildPlacedImagePdf({
      width: 4, height: 4, samples: grid4(),
      placements: ['100 0 0 100 0 0', '100 0 0 100 100 0'], mediaBox: '0 0 200 100',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // covers left half of the FIRST placement only
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    // Two distinct images now: one redacted copy + the original still-drawn image.
    const decoded = imgs.map((im) => im.Decode());
    const original = grid4();
    const untouched = decoded.some((d) => d.length === original.length && d.every((v, i) => v === original[i]));
    expect(untouched).toBe(true); // the second placement's image survives byte-for-byte
  });

  it('throws for a rotated placement', () => {
    const doc = Document.Open(buildPlacedImagePdf({
      width: 4, height: 4, samples: grid4(), placements: ['0 100 -100 0 100 0'], mediaBox: '0 0 100 100',
    }));
    expect(() => redactPage(doc, doc.Pages[0], [[0, 0, 50, 50]])).toThrow(UnsupportedFeatureError);
  });

  it('throws for a partially-covered JPEG (DCTDecode) image', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // 1×1 image; wrap won't matter — use DCT fixture instead
    // Build a DCT image page inline:
    const dct = Document.Open(buildDctPagePdf());
    expect(() => redactPage(dct, dct.Pages[0], [[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
  });
});

// Minimal 4×4 DCTDecode image placed at [0,0,100,100]; bytes need not be valid
// JPEG — decodeImageRgba refuses DCT before decoding, so partial coverage throws.
function buildDctPagePdf(): Uint8Array {
  return buildSingleImagePdfWithCm({
    width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
    raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0', mediaBox: '0 0 100 100',
  });
}
```

Also append this small helper to `test/helpers/build-image-pdf.ts` (a `cm`/`mediaBox`-aware variant of `buildSingleImagePdf`) and import `buildSingleImagePdfWithCm` in the test:

```ts
/** Like buildSingleImagePdf but with an explicit placement `cm` and MediaBox. */
export function buildSingleImagePdfWithCm(opts: {
  width: number; height: number; colorSpace: string; bits: number;
  filter: string; raw: Uint8Array; extra?: string; cm: string; mediaBox?: string;
}): Uint8Array {
  const { width, height, colorSpace, bits, filter, raw, extra = '', cm, mediaBox = '0 0 100 100' } = opts;
  const content = enc(`q ${cm} cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent ${bits} /Filter /${filter} ${extra} /Length ${raw.length} >>`, raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  const maxObj = 5;
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else { push(enc(`${n} 0 obj\n${o.dict}\nstream\n`)); push(o.raw); push(enc(`\nendstream\nendobj\n`)); }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concat(parts);
}
```

Update the `test/redact-image.test.ts` import line for helpers to include the new names:

```ts
import { buildPlacedImagePdf, buildSingleImagePdfWithCm } from './helpers/build-image-pdf.js';
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/redact-image.test.ts -t "partial image redaction"`
Expected: FAIL — the partial cases currently throw `UnsupportedFeatureError` (or the fixtures/functions are undefined).

- [ ] **Step 4: Add imports and the re-encode helper to `redact.ts`**

At the top of `src/redact.ts`, extend imports:

```ts
import { PdfDict, PdfObject, PdfStream, isString, isArray, isName, isDict, isStream, name } from './types.js';
import { visitContent, Rect, Matrix } from './text.js';
import { decodeImageRgba } from './raster.js';
import { coveredPixelBox, blankPixels, encodeRgbaXObject, PixelBox } from './imageredact.js';
```

(Keep the existing imports; add `isStream`, `name`, `Matrix`, and the three new modules. `PdfStream` is added to the `./types.js` import.)

Add this helper near the bottom of `src/redact.ts`:

```ts
/** Re-encode `stream` with the pixels under `rects` (device space) blanked, and
 *  register the result as a fresh copy-on-write image XObject in `resources`,
 *  returning the new resource name. Throws UnsupportedFeatureError when the image
 *  cannot be decoded (JPEG/JPX/JBIG2) or the placement is rotated. */
function reencodeRedactedImage(
  doc: Document, resources: PdfDict, stream: PdfStream, ctm: Matrix, rects: Rect[],
): string {
  const img = decodeImageRgba(doc, stream, [0, 0, 0]);
  if (!img) throw new UnsupportedFeatureError('image codec cannot be decoded for partial redaction');
  const boxes: PixelBox[] = [];
  for (const r of rects) { const b = coveredPixelBox(ctm, img.w, img.h, r); if (b) boxes.push(b); }
  blankPixels(img, boxes);

  const enc = encodeRgbaXObject(img);
  if (enc.smask) {
    const smRef = doc.allocObject({ kind: 'stream', dict: enc.smask.dict, raw: enc.smask.raw });
    enc.dict.set('SMask', smRef);
  }
  const imgRef = doc.allocObject({ kind: 'stream', dict: enc.dict, raw: enc.raw });

  const xobj = ensureOwnSubdict(doc, resources, 'XObject');
  let n = 0;
  while (xobj.has(`RdImg${n}`)) n++;
  const newName = `RdImg${n}`;
  xobj.set(newName, imgRef);
  return newName;
}
```

- [ ] **Step 5: Extend `removeRegionContent` to take the partial-image path**

In `src/redact.ts`, update the `Scope` interface and the `image` visitor inside `removeRegionContent`:

```ts
  interface PartialImage { ctm: Matrix; rects: Rect[]; }
  interface Scope { addr: ContentAddr; glyphs: Map<number, GlyphRec[]>; images: Set<number>; partial: Map<number, PartialImage>; }
  const streams = new Map<string, Scope>();
  const scope = (addr: ContentAddr): Scope => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, glyphs: new Map(), images: new Set(), partial: new Map() }; streams.set(sk, s); }
    return s;
  };
```

Replace the `image` visitor:

```ts
    image: (e) => {
      const covering = rs.filter((r) => intersects(e.quad, r));
      if (covering.length === 0) return;
      if (covering.some((r) => contains(r, e.quad))) { scope(e.addr).images.add(e.addr.opIndex); return; }
      if (e.kind === 'inline')
        throw new UnsupportedFeatureError('partial inline image redaction is not supported');
      scope(e.addr).partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
    },
```

Replace the per-stream rebuild loop with one that handles partial images (note the added `page` usage — `removeRegionContent(doc, page, rects, ec)` already has `page`):

```ts
  for (const { addr, glyphs, images, partial } of streams.values()) {
    const hasGlyphEdit = [...glyphs.values()].some((recs) => recs.some((g) => g.removed));
    if (!hasGlyphEdit && images.size === 0 && partial.size === 0) continue;

    const resources = addr.path.length === 0
      ? ensureOwnResources(doc, page)
      : (ec.xobjectResources(addr.path) ?? ensureOwnResources(doc, page));
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const cut = imageCutSet(ops, images);
    const out: ContentOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (cut.has(i)) continue; // fully-covered image (and its placement group) removed
      const pi = partial.get(i);
      if (pi) {
        const op = ops[i];
        const nm = op.operands[0];
        const xobj = doc.resolve(resources.get('XObject'));
        const imgStream = isName(nm) && isDict(xobj) ? doc.resolve(xobj.get(nm.name)) : null;
        if (isStream(imgStream)) {
          const newName = reencodeRedactedImage(doc, resources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
      const recs = glyphs.get(i);
      if (recs && recs.some((g) => g.removed)) out.push(...rewriteShowOp(ops[i], recs));
      else out.push(ops[i]);
    }
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
```

- [ ] **Step 6: Apply the same partial path to `removeImagesUnder`**

In `src/redact.ts`, update the standalone `removeImagesUnder`: its `image` visitor records partial ops (throwing only for inline), and its rebuild loop re-encodes them. Replace the visitor and loop:

```ts
  const streams = new Map<string, { addr: ContentAddr; remove: Set<number>; partial: Map<number, { ctm: Matrix; rects: Rect[] }> }>();
  visitContent(doc, page, {
    image: (e) => {
      const covering = rs.filter((r) => intersects(e.quad, r));
      if (covering.length === 0) return;
      const sk = streamKey(e.addr);
      let s = streams.get(sk);
      if (!s) { s = { addr: e.addr, remove: new Set(), partial: new Map() }; streams.set(sk, s); }
      if (covering.some((r) => contains(r, e.quad))) { s.remove.add(e.addr.opIndex); return; }
      if (e.kind === 'inline')
        throw new UnsupportedFeatureError('partial inline image redaction is not supported');
      s.partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
    },
  });

  for (const { addr, remove, partial } of streams.values()) {
    const resources = addr.path.length === 0
      ? ensureOwnResources(doc, page)
      : (ec.xobjectResources(addr.path) ?? ensureOwnResources(doc, page));
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const cut = imageCutSet(ops, remove);
    const out: ContentOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (cut.has(i)) continue;
      const pi = partial.get(i);
      if (pi) {
        const nm = ops[i].operands[0];
        const xobj = doc.resolve(resources.get('XObject'));
        const imgStream = isName(nm) && isDict(xobj) ? doc.resolve(xobj.get(nm.name)) : null;
        if (isStream(imgStream)) {
          const newName = reencodeRedactedImage(doc, resources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
      out.push(ops[i]);
    }
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
```

Update `removeImagesUnder`'s doc comment to note that partial coverage now re-encodes (image XObjects) rather than always throwing.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/redact-image.test.ts`
Expected: PASS — new partial cases plus the existing full-removal / inline tests. The old "throws for a partially-covered image" test at ~line 30 used `buildImageOnlyPdf` (a 1×1 DeviceGray image with **no** Filter); confirm it still throws only if the image is undecodable — a raw (no-filter) 1×1 DeviceGray image **is** decodable, so this test now conflicts. Update that test to assert re-encode success instead, or point it at `buildDctPagePdf()`; the plan's intent is that a decodable partial image no longer throws.

Note for Step 7: the pre-existing test `removeImagesUnder — XObject images › throws UnsupportedFeatureError for a partially-covered image` must be revised — its image is decodable, so partial coverage now succeeds. Change it to use a DCTDecode image (undecodable) so the throw assertion remains valid:

```ts
  it('throws UnsupportedFeatureError for a partially-covered undecodable (JPEG) image', () => {
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
      raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0',
    }));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    expect(() => removeImagesUnder(doc, page, [[0, 0, 50, 100]], ec)).toThrow(UnsupportedFeatureError);
  });
```

- [ ] **Step 8: Typecheck, full redaction suite, commit**

```bash
npm run typecheck
npx vitest run test/redact-image.test.ts test/redact.test.ts test/redact-sanitize.test.ts test/redact-box.test.ts test/redact-text.test.ts test/redact-search.test.ts
git add src/redact.ts test/redact-image.test.ts test/helpers/build-image-pdf.ts
git commit -m "feat(gq8): partial image redaction — clip + re-encode with copy-on-write"
```

---

## Task 4: README, follow-up note, final gates, close

**Files:**
- Modify: `README.md`
- (Follow-up issues already filed: `-b3b` JPEG, `-66r` rotated, `-357` inline, `-njs` colorspace.)

- [ ] **Step 1: Update the README redaction section**

Find the redaction description (search for `Redact`), and update the image note. Where the current text says partially-covered images are unsupported, replace with:

```markdown
Images covered *entirely* by a redaction region are removed; images covered
*partially* are decoded, the covered pixels destroyed, and the image re-encoded
(as DeviceRGB) so only the covered area is lost. Partial redaction requires a
decodable codec (not JPEG/JPXDecode/JBIG2Decode) and an axis-aligned placement;
rotated/skewed placements and partial inline images throw
`UnsupportedFeatureError`.
```

If a Limitations bullet asserts "partially-covered images are not supported," update it to the axis-aligned / decodable-codec constraint above.

- [ ] **Step 2: Full quality gates**

```bash
npm run typecheck
npm test
```

Expected: all green, including `test/imagegeom.test.ts`, `test/imageredact.test.ts`, and `test/redact-image.test.ts`, with no regression in the other `redact-*`, `raster`/`render`, and `text` suites.

- [ ] **Step 3: Build sanity**

```bash
npm run build
```

Expected: emits without error (the new `src/imageredact.ts` compiles; `decodeImageRgba`/`ImageRgba` now exported).

- [ ] **Step 4: Commit docs and close the issue**

```bash
git add README.md
git commit -m "docs(gq8): README partial image redaction note"
bd close aspose-pdf-foss-for-ts-gq8
```

Then finish the branch (merge/PR/push) per the finishing-a-development-branch skill.

---

## Self-Review Notes (author)

- **Spec coverage:** device→pixel mapping + rotation throw (Task 2 `coveredPixelBox`) ↔ spec §Geometry; decode/blank/re-encode + SMask (Task 2) ↔ §Approach 1–3; COW register + Do rewrite (Task 3 `reencodeRedactedImage`, both `removeRegionContent` and `removeImagesUnder`) ↔ §Approach 4 and §`redact.ts`; `ImageEvent.ctm` (Task 1) ↔ §`text.ts`; `decodeImageRgba` export (Task 2) ↔ §`raster.ts`; undecodable/rotated/inline throws ↔ §Scope; tests ↔ §Testing; README ↔ §Documentation. All spec sections mapped.
- **Type consistency:** `coveredPixelBox`/`blankPixels`/`encodeRgbaXObject`/`PixelBox`/`ImageRgba`/`reencodeRedactedImage`/`invert` are used with identical signatures across defining and consuming tasks. `ImageEvent.ctm` is `Matrix` everywhere.
- **Pre-existing test conflict flagged:** the existing "throws for a partially-covered image" test in `redact-image.test.ts` uses a decodable image and must be repointed at a DCTDecode fixture (Task 3, Step 7) — called out explicitly rather than silently broken.
```
