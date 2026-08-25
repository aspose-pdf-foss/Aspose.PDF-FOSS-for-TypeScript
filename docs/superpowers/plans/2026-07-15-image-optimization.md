# Image Optimization (`doc.Optimize({ images })`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth, opt-in, lossy concern to `doc.Optimize` that downsamples image XObjects to a target DPI and recompresses them as JPEG at a target quality.

**Architecture:** A content scan (`imageusage.ts`) tracks the CTM and resolves each `Do` to the image stream it paints, yielding a per-stream *max effective DPI* over all placements. A pure box filter (`resample.ts`) downsamples samples. An orchestrator (`imageopt.ts`) guards each image, decodes it, resamples, re-encodes via the existing `encodeJpeg`, and installs the result at the **same object number**. `optimize.ts` runs it first, so `dedup` can merge images the re-encode just made identical.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Existing in-tree modules only: `jpeg.ts` (`decodeJpeg`), `jpegencode.ts` (`encodeJpeg`), `image.ts` (`ImageInfo`), `content.ts`, `text.ts` (`Matrix`/`mul`/`IDENTITY`/`contentStreamBytes`).

**Spec:** `docs/superpowers/specs/2026-07-15-image-optimization-design.md` (commit `9efc03d`)
**Issue:** `aspose-pdf-foss-for-ts-kqy`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every relative import specifier carries the `.js` extension (e.g. `import { mul } from './text.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any commit.
- **TDD:** write the failing test first, watch it fail, then implement.
- **Errors:** throw only `PdfParseError`, `UnsupportedFeatureError`, or `InvalidPasswordError` (`errors.ts`). This feature **reports** rather than throws: an image it cannot handle goes into `skippedImages` with a reason.
- **Never inflate:** replace a stream only when the result is strictly smaller (matches `fontshrink`/`recompress`).
- **Never upsample:** `scale = min(1, targetDpi / maxDpi)`.
- **`test/helpers/build-image-pdf.ts` already exists** (used by `image.test.ts`). Do **not** overwrite it. This feature's fixture builder is `test/helpers/build-imageopt-pdf.ts`.
- Run `npm run typecheck` and `npm test` before closing the issue; both must be green.

## File Structure

| File | Responsibility |
|---|---|
| `src/resample.ts` (create) | Pure box-filter downsample of an interleaved 8-bit plane |
| `src/imageusage.ts` (create) | CTM-tracking content scan → per-stream max DPI + completeness |
| `src/imageopt.ts` (create) | Guard → decode → resample → encode → replace; concern orchestrator |
| `src/optimize.ts` (modify) | Add `images` to options/report; run it first |
| `src/index.ts` (modify) | Export the new public types |
| `README.md` (modify) | Document the lossy opt-in |
| `test/helpers/build-imageopt-pdf.ts` (create) | Fixture builder |
| `test/resample.test.ts`, `test/imageusage.test.ts`, `test/imageopt.test.ts` (create) | Per-module tests |
| `test/optimize.test.ts` (modify) | Integration + pass-order tests |

---

### Task 1: `resample.ts` — pure box-filter downsample

**Files:**
- Create: `src/resample.ts`
- Test: `test/resample.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resampleBox(src: Uint8Array, w: number, h: number, channels: number, dw: number, dh: number): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `test/resample.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resampleBox } from '../src/resample.js';

describe('resampleBox', () => {
  it('averages a 4x1 ramp down to 2x1', () => {
    // Each destination pixel box-averages exactly two source pixels.
    const src = Uint8Array.from([0, 10, 20, 30]);
    expect([...resampleBox(src, 4, 1, 1, 2, 1)]).toEqual([5, 25]);
  });

  it('keeps a flat plane flat', () => {
    const src = new Uint8Array(64).fill(200);
    const out = resampleBox(src, 8, 8, 1, 4, 4);
    expect([...out]).toEqual(new Array(16).fill(200));
  });

  it('preserves channel interleaving', () => {
    // 2x1 RGB: red then blue -> 1x1 averages each channel independently.
    const src = Uint8Array.from([255, 0, 0, 0, 0, 255]);
    expect([...resampleBox(src, 2, 1, 3, 1, 1)]).toEqual([128, 0, 128]);
  });

  it('collapses a full row to one pixel without dividing by zero', () => {
    const src = Uint8Array.from([0, 30, 60]);
    expect([...resampleBox(src, 3, 1, 1, 1, 1)]).toEqual([30]);
  });

  it('returns a copy, not the input, when dimensions are unchanged', () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleBox(src, 4, 1, 1, 4, 1);
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(src);
  });

  it('rejects a sample count that does not match the geometry', () => {
    expect(() => resampleBox(new Uint8Array(3), 2, 2, 1, 1, 1)).toThrow(TypeError);
  });

  it('rejects a destination smaller than one pixel', () => {
    expect(() => resampleBox(new Uint8Array(4), 4, 1, 1, 0, 1)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/resample.test.ts`
Expected: FAIL — cannot resolve `../src/resample.js`.

- [ ] **Step 3: Write the implementation**

Create `src/resample.ts`:

```ts
/**
 * Box-filter downsample of an interleaved 8-bit sample plane.
 *
 * Each destination pixel averages every source pixel its footprint covers. That
 * is the right filter for downscaling: nearest-neighbour aliases, and bilinear
 * ignores most source pixels once the scale drops below 1/2. It matches the
 * `box2x2` precedent already in jpegencode.ts, generalized to any ratio.
 *
 * Downsampling only — `dw`/`dh` are expected to be <= `w`/`h`; callers clamp the
 * scale to 1 so this is never asked to invent detail.
 */
export function resampleBox(
  src: Uint8Array, w: number, h: number, channels: number, dw: number, dh: number,
): Uint8Array {
  if (!Number.isInteger(dw) || !Number.isInteger(dh) || dw < 1 || dh < 1)
    throw new TypeError('resampleBox: destination must be at least 1x1');
  if (src.length !== w * h * channels)
    throw new TypeError(`resampleBox: expected ${w * h * channels} samples, got ${src.length}`);
  if (dw === w && dh === h) return src.slice();

  const out = new Uint8Array(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * h) / dh);
    // max(sy0 + 1, ...) keeps every box at least one pixel tall, so the divisor
    // is never zero even when the ratio rounds a box to nothing.
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * w) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / dw));
      const n = (sy1 - sy0) * (sx1 - sx0);
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++)
          for (let sx = sx0; sx < sx1; sx++)
            sum += src[(sy * w + sx) * channels + c];
        out[(y * dw + x) * channels + c] = Math.round(sum / n);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/resample.test.ts && npm run typecheck`
Expected: 7 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/resample.ts test/resample.test.ts
git commit -m "feat(resample): box-filter downsample of interleaved 8-bit planes"
```

---

### Task 2: `imageusage.ts` — CTM-tracking scan for max effective DPI

**Files:**
- Create: `src/imageusage.ts`
- Create: `test/helpers/build-imageopt-pdf.ts`
- Test: `test/imageusage.test.ts`

**Interfaces:**
- Consumes: `Matrix`, `mul`, `IDENTITY`, `contentStreamBytes` from `./text.js`; `parseContentStream`, `ContentOp` from `./content.js`; `decodeStream` from `./filters.js`.
- Produces:
  - `interface ImageUsage { maxDpi: number; complete: boolean; reason?: string; name?: string }`
  - `type ImageUsageMap = Map<PdfStream, ImageUsage>`
  - `collectImageUsage(doc: Document): ImageUsageMap`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-imageopt-pdf.ts`. It mints real JPEGs with the in-tree encoder so the fixtures decode for real:

```ts
import { deflateSync } from 'node:zlib';
import { encodeJpeg } from '../../src/jpegencode.js';

const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Assemble numbered objects into a classic-xref one-page PDF. */
function assemble(objs: Obj[]): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i];
    offsets[i] = pos;
    if (typeof o === 'string') {
      const b = enc(`${i} 0 obj\n${o}\nendobj\n`);
      parts.push(b); pos += b.length;
    } else {
      const head = enc(`${i} 0 obj\n${o.dict}\nstream\n`);
      const tail = enc('\nendstream\nendobj\n');
      parts.push(head, o.raw, tail);
      pos += head.length + o.raw.length + tail.length;
    }
  }
  const xref = pos;
  let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(enc(x));
  return concat(parts);
}

/** A deterministic RGB gradient — compresses like a photo, not a flat fill. */
export function gradient(w: number, h: number, channels = 3): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < channels; c++) {
      out[(y * w + x) * channels + c] = (x * 7 + y * 5 + c * 31) % 256;
    }
  }
  return out;
}

/** A 64x64 DCTDecode RGB image drawn on a 200x200 page inside a `w x h` box.
 *  At the default 16x16 box that is 64*72/16 = 288 DPI. */
export function buildSimpleImagePdf(
  opts: { boxW?: number; boxH?: number; imgW?: number; imgH?: number } = {},
): { bytes: Uint8Array; imgObjNum: number } {
  const { boxW = 16, boxH = 16, imgW = 64, imgH = 64 } = opts;
  const jpeg = encodeJpeg(imgW, imgH, gradient(imgW, imgH), 'rgb', { quality: 90 });
  const content = enc(`q ${boxW} 0 0 ${boxH} 10 10 cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** One image drawn twice at different scales: a 16pt box (288 DPI) and a 64pt
 *  box (72 DPI). The max rule must pick 288. */
export function buildTwoPlacementPdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q q 64 0 0 64 100 100 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image drawn only from inside a Form XObject that carries its own /Matrix
 *  (scale 2), nested under a `cm` of 8 -> effective box 16pt -> 288 DPI. */
export function buildFormImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const form = enc('/Im0 Do');
  const content = enc('q 8 0 0 8 10 10 cm /Fm0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [2 0 0 2 0 0] /Resources << /XObject << /Im0 4 0 R >> >> /Length ${form.length} >>`,
    raw: form,
  };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image drawn only from an annotation /AP /N stream whose /BBox [0 0 1 1]
 *  maps into /Rect [0 0 16 16] -> 288 DPI. */
export function buildAnnotImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const ap = enc('/Im0 Do');
  const content = enc('');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 5 0 R /Annots [6 0 R] >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = `<< /Type /Annot /Subtype /Stamp /Rect [0 0 16 16] /AP << /N 7 0 R >> >>`;
  objs[7] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im0 4 0 R >> >> /Length ${ap.length} >>`,
    raw: ap,
  };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** A 64x64 DeviceCMYK DCTDecode image in a 16pt box (288 DPI). No /Decode: the
 *  fixture's JPEG is written by encodeJpeg, which stores CMYK non-inverted and
 *  emits no APP14, so no inversion is in play on either side. */
export function buildCmykImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64, 4), 'cmyk', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image that is referenced as an /SMask but never drawn. The scan must not
 *  reach it, so the safety net marks it incomplete. */
export function buildSmaskPdf(): { bytes: Uint8Array; imgObjNum: number; smaskObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const alpha = new Uint8Array(deflateSync(Buffer.from(gradient(64, 64, 1))));
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 6 0 R /Length ${jpeg.length} >>`,
    raw: jpeg,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alpha.length} >>`,
    raw: alpha,
  };
  return { bytes: assemble(objs), imgObjNum: 4, smaskObjNum: 6 };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/imageusage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { collectImageUsage } from '../src/imageusage.js';
import { isStream, name, PdfObject, PdfStream } from '../src/types.js';
import {
  buildSimpleImagePdf, buildTwoPlacementPdf, buildFormImagePdf,
  buildAnnotImagePdf, buildSmaskPdf,
} from './helpers/build-imageopt-pdf.js';

/** The live image stream stored at `num`. */
function streamAt(doc: Document, num: number): PdfStream {
  const o = doc.getObject(num);
  if (!isStream(o)) throw new Error(`object ${num} is not a stream`);
  return o;
}

/** Replace page 0's /Contents. There is no Page.SetContent; this is the house
 *  pattern (see test/glyphusage.test.ts). */
function setContent(doc: Document, src: string): void {
  doc.Pages[0].Dict.set('Contents', doc.allocObject({
    kind: 'stream',
    dict: new Map<string, PdfObject>(),
    raw: new TextEncoder().encode(src),
  }));
}

describe('collectImageUsage', () => {
  it('measures a 64px image in a 16pt box as 288 DPI', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
    expect(u.name).toBe('Im0');
  });

  it('takes the MAX dpi across placements, not the last or the smallest', () => {
    const { bytes, imgObjNum } = buildTwoPlacementPdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5); // not the 72 DPI of the big box
  });

  it('composes a Form XObject /Matrix with the CTM', () => {
    const { bytes, imgObjNum } = buildFormImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5); // cm 8 x Matrix 2 = 16pt box
  });

  it('measures a rotated placement by its true device extent', () => {
    // A 90-degree rotation into a 16pt box: a and d are both 0, so a naive a/d
    // read would divide by zero. hypot(a,b) recovers the real 16pt extent.
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    setContent(doc, 'q 0 16 -16 0 30 10 cm /Im0 Do Q');
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
  });

  it('finds an image drawn only from an annotation /AP stream', () => {
    const { bytes, imgObjNum } = buildAnnotImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
  });

  it('marks an /SMask incomplete: referenced, never drawn', () => {
    const { bytes, imgObjNum, smaskObjNum } = buildSmaskPdf();
    const doc = Document.Open(bytes);
    const usage = collectImageUsage(doc);
    expect(usage.get(streamAt(doc, imgObjNum))!.complete).toBe(true);
    const sm = usage.get(streamAt(doc, smaskObjNum))!;
    expect(sm.complete).toBe(false);
    expect(sm.reason).toMatch(/not reached/);
  });

  it('marks every image in scope incomplete when a content stream will not decode', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    // Replace /Contents with an undecodable stream (bad Flate payload). Mirrors
    // test/glyphusage.test.ts — a proven trigger, unlike malformed syntax, which
    // the tokenizer may tolerate rather than throw on.
    doc.Pages[0].Dict.set('Contents', doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: Uint8Array.from([0, 1, 2, 3]),
    }));
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/failed to (parse|decode)/);
  });
});
```

> **Verified accessors** (do not add public API for tests): `doc.getObject(num)` exists at `document.ts:1423`; `doc.allocObject`, `doc.objectEntries()`, and `doc.replaceObject` are `@internal` but available; `Page.Images` exists at `page.ts:305`. There is **no** `Page.SetContent` — set `page.Dict.set('Contents', ...)` as the `setContent` helper above does.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/imageusage.test.ts`
Expected: FAIL — cannot resolve `../src/imageusage.js`.

- [ ] **Step 4: Write the implementation**

Create `src/imageusage.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfStream, isDict, isName, isStream, isArray } from './types.js';
import { parseContentStream, ContentOp } from './content.js';
import { contentStreamBytes, Matrix, mul, IDENTITY } from './text.js';
import { decodeStream } from './filters.js';

/** How large an image is actually painted, and whether that is trustworthy. */
export interface ImageUsage {
  /** Highest effective DPI over every placement. 0 when never drawn. */
  maxDpi: number;
  /** False when a placement could not be measured — the image must be skipped. */
  complete: boolean;
  reason?: string;
  /** Resource key of the first placement seen; diagnostic only. */
  name?: string;
}

export type ImageUsageMap = Map<PdfStream, ImageUsage>;

const MAX_XOBJECT_DEPTH = 8;

interface Ctx { doc: Document; usage: ImageUsageMap }

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** Resolve an array-valued key to plain numbers (indirect elements included). */
function numsOf(doc: Document, o: PdfObject | undefined): number[] {
  const r = doc.resolve(o);
  if (!isArray(r)) return [];
  const out: number[] = [];
  for (const e of r) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out;
}

const operandNums = (ops: readonly PdfObject[]): number[] =>
  ops.filter((x): x is number => typeof x === 'number');

function numKey(doc: Document, d: PdfDict, k: string): number {
  const v = doc.resolve(d.get(k));
  return typeof v === 'number' ? v : 0;
}

/**
 * Effective DPI of an image painted into the unit square by `ctm`.
 *
 * The unit square's edges map to the vectors (a,b) and (c,d), so their lengths
 * are the device extents — hypot, not `a`/`d` alone, so rotated and skewed
 * placements measure their true size rather than reading 0.
 *
 * Returns the max of the two axes, which is conservative: it keeps more pixels
 * than the average would, and the caller scales both axes uniformly to preserve
 * aspect ratio. undefined for a degenerate (zero-extent) placement.
 */
function dpiOf(ctm: Matrix, w: number, h: number): number | undefined {
  const ex = Math.hypot(ctm[0], ctm[1]);
  const ey = Math.hypot(ctm[2], ctm[3]);
  if (!(ex > 1e-9) || !(ey > 1e-9)) return undefined;
  return Math.max((w * 72) / ex, (h * 72) / ey);
}

function entry(ctx: Ctx, s: PdfStream, key?: string): ImageUsage {
  let u = ctx.usage.get(s);
  if (!u) { u = { maxDpi: 0, complete: true, name: key }; ctx.usage.set(s, u); }
  return u;
}

function record(ctx: Ctx, s: PdfStream, key: string, ctm: Matrix): void {
  const u = entry(ctx, s, key);
  const w = numKey(ctx.doc, s.dict, 'Width');
  const h = numKey(ctx.doc, s.dict, 'Height');
  const dpi = w > 0 && h > 0 ? dpiOf(ctm, w, h) : undefined;
  if (dpi === undefined) {
    u.complete = false;
    u.reason = 'placement could not be measured';
    return;
  }
  u.maxDpi = Math.max(u.maxDpi, dpi);
}

function markIncomplete(ctx: Ctx, s: PdfStream, key: string | undefined, reason: string): void {
  const u = entry(ctx, s, key);
  u.complete = false;
  u.reason = reason;
}

/** Mark every image in `resources` unusable — a broken stream could have drawn
 *  any of them, so none of their placements are accounted for. */
function markScopeIncomplete(ctx: Ctx, resources: PdfDict | undefined, reason: string): void {
  const xo = resolveDict(ctx.doc, resources?.get('XObject'));
  if (!xo) return;
  for (const [k, v] of xo) {
    const s = ctx.doc.resolve(v);
    if (isStream(s) && nameOf(ctx.doc, s.dict.get('Subtype')) === 'Image') {
      markIncomplete(ctx, s, k, reason);
    }
  }
}

/**
 * Walk one graphics-state scope.
 *
 * `measurable` is false for scopes whose device CTM this scan does not model
 * (Type3 glyph procedures, where the real CTM is the font matrix times the text
 * matrix times the CTM at show time). Images drawn there are marked incomplete
 * rather than measured: the alternative is measuring an image from its *page*
 * placement while a Type3 glyph shows it larger, and downsampling below what
 * that glyph needs.
 */
function walkOps(
  ctx: Ctx, ops: ContentOp[], resources: PdfDict | undefined,
  baseCtm: Matrix, depth: number, seen: Set<PdfDict>, measurable: boolean,
): void {
  const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
  let ctm = baseCtm;
  const stack: Matrix[] = [];

  for (const op of ops) {
    switch (op.operator) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? baseCtm; break;
      case 'cm': {
        const m = operandNums(op.operands);
        if (m.length === 6) ctm = mul(m as Matrix, ctm);
        break;
      }
      case 'Do': {
        const key = op.operands[0];
        if (!isName(key) || !xobjects) break;
        const xo = ctx.doc.resolve(xobjects.get(key.name));
        if (!isStream(xo)) break;
        const sub = nameOf(ctx.doc, xo.dict.get('Subtype'));
        if (sub === 'Image') {
          if (measurable) record(ctx, xo, key.name, ctm);
          else markIncomplete(ctx, xo, key.name, 'drawn from a scope whose CTM the scan does not model');
          break;
        }
        if (sub === 'Form') {
          const m = numsOf(ctx.doc, xo.dict.get('Matrix'));
          const childCtm = m.length === 6 ? mul(m as Matrix, ctm) : ctm;
          walkStream(
            ctx, xo, resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources,
            childCtm, depth + 1, seen, measurable,
          );
        }
        break;
      }
      default: break;
    }
  }
}

/**
 * Parse and walk one content stream.
 *
 * `seen` is added to on entry and **removed on exit** — unlike glyphusage.ts,
 * which adds permanently. That difference is load-bearing: glyphusage only needs
 * to know *whether* a font is used, so visiting a Form XObject once suffices,
 * but a Form drawn twice at different scales yields two different DPIs and both
 * must be measured. Add/remove still breaks cycles (a stream cannot contain
 * itself), which is all the guard is for.
 */
function walkStream(
  ctx: Ctx, stream: PdfStream, resources: PdfDict | undefined,
  baseCtm: Matrix, depth: number, seen: Set<PdfDict>, measurable: boolean,
): void {
  if (depth > MAX_XOBJECT_DEPTH) {
    markScopeIncomplete(ctx, resources, 'XObject nesting too deep');
    return;
  }
  if (seen.has(stream.dict)) return;
  seen.add(stream.dict);
  try {
    let ops: ContentOp[];
    try { ops = parseContentStream(decodeStream(stream)); }
    catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); return; }
    walkOps(ctx, ops, resources, baseCtm, depth, seen, measurable);
  } finally {
    seen.delete(stream.dict);
  }
}

function walkPage(ctx: Ctx, page: Page): void {
  const resources = page.Resources;
  const seen = new Set<PdfDict>();
  let streams: Uint8Array[];
  try { streams = contentStreamBytes(ctx.doc, page); }
  catch { markScopeIncomplete(ctx, resources, 'page contents failed to decode'); return; }

  // PDF 32000 7.8.2: a /Contents array is *one* stream divided at token
  // boundaries. Concatenating before parsing is what the spec describes, and it
  // keeps a `q` in one part paired with its `Q` in the next.
  const joined = new Uint8Array(streams.reduce((n, s) => n + s.length + 1, 0));
  let off = 0;
  for (const s of streams) { joined.set(s, off); off += s.length; joined[off++] = 0x0a; }

  let ops: ContentOp[];
  try { ops = parseContentStream(joined); }
  catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); return; }
  walkOps(ctx, ops, resources, IDENTITY, 0, seen, true);

  walkAnnotations(ctx, page, seen);
  walkPatterns(ctx, resources, seen);
  walkType3(ctx, resolveDict(ctx.doc, resources?.get('Font')), seen);
}

/**
 * The CTM mapping an annotation's /AP stream into its /Rect (PDF 32000 12.5.5):
 * the /BBox corners are transformed by /Matrix, and the transformed bounding box
 * is scaled and translated to fit /Rect.
 */
function apCtm(doc: Document, annot: PdfDict, ap: PdfStream): Matrix {
  const rect = numsOf(doc, annot.get('Rect'));
  const bbox = numsOf(doc, ap.dict.get('BBox'));
  const m = numsOf(doc, ap.dict.get('Matrix'));
  const matrix: Matrix = m.length === 6 ? (m as Matrix) : IDENTITY;
  if (rect.length !== 4 || bbox.length !== 4) return matrix;

  const rx0 = Math.min(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]);
  const rx1 = Math.max(rect[0], rect[2]), ry1 = Math.max(rect[1], rect[3]);
  const corners: [number, number][] = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]],
  ];
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of corners) {
    xs.push(matrix[0] * x + matrix[2] * y + matrix[4]);
    ys.push(matrix[1] * x + matrix[3] * y + matrix[5]);
  }
  const bx0 = Math.min(...xs), by0 = Math.min(...ys);
  const bw = Math.max(...xs) - bx0, bh = Math.max(...ys) - by0;
  const sx = bw > 1e-9 ? (rx1 - rx0) / bw : 1;
  const sy = bh > 1e-9 ? (ry1 - ry0) / bh : 1;
  const fit: Matrix = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
  return mul(matrix, fit);
}

/** Every /AP appearance stream on a page's annotations: /N, /D, /R, including
 *  the sub-dictionary form (/N << /On 5 0 R /Off 6 0 R >>). */
function walkAnnotations(ctx: Ctx, page: Page, seen: Set<PdfDict>): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const annot = resolveDict(ctx.doc, a);
    const ap = annot ? resolveDict(ctx.doc, annot.get('AP')) : undefined;
    if (!annot || !ap) continue;
    for (const key of ['N', 'D', 'R']) {
      const e = ctx.doc.resolve(ap.get(key));
      const streams = isStream(e) ? [e]
        : isDict(e) ? [...e.values()].map((v) => ctx.doc.resolve(v)).filter(isStream)
        : [];
      for (const s of streams) {
        walkStream(ctx, s, resolveDict(ctx.doc, s.dict.get('Resources')),
          apCtm(ctx.doc, annot, s), 0, seen, true);
      }
    }
  }
}

/** Every tiling pattern (PatternType 1). PDF 32000 8.7.3.1: a pattern's /Matrix
 *  maps pattern space to the *default* space of its parent content stream, not
 *  to the CTM at fill time — so /Matrix alone is the base CTM and the placement
 *  is fully measurable. */
function walkPatterns(ctx: Ctx, resources: PdfDict | undefined, seen: Set<PdfDict>): void {
  const patterns = resolveDict(ctx.doc, resources?.get('Pattern'));
  if (!patterns) return;
  for (const v of patterns.values()) {
    const p = ctx.doc.resolve(v);
    if (!isStream(p)) continue; // shading patterns are dicts, and draw no images
    if (ctx.doc.resolve(p.dict.get('PatternType')) !== 1) continue;
    const m = numsOf(ctx.doc, p.dict.get('Matrix'));
    walkStream(ctx, p, resolveDict(ctx.doc, p.dict.get('Resources')),
      m.length === 6 ? (m as Matrix) : IDENTITY, 0, seen, true);
  }
}

/** Type3 /CharProcs. Walked with measurable=false: the CTM at a glyph draw is
 *  the font matrix times the text matrix times the CTM at show time, none of
 *  which this scan tracks. Any image drawn here is marked incomplete. */
function walkType3(ctx: Ctx, fonts: PdfDict | undefined, seen: Set<PdfDict>): void {
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (!f || nameOf(ctx.doc, f.get('Subtype')) !== 'Type3') continue;
    const procs = resolveDict(ctx.doc, f.get('CharProcs'));
    if (!procs) continue;
    const res = resolveDict(ctx.doc, f.get('Resources'));
    for (const pv of procs.values()) {
      const s = ctx.doc.resolve(pv);
      if (isStream(s)) walkStream(ctx, s, res, IDENTITY, 0, seen, false);
    }
  }
}

/**
 * Per-image-stream max effective DPI across every placement in the document.
 *
 * An image the scan never reached is reported incomplete rather than omitted:
 * callers must skip it. That is the safety net that makes the policy real rather
 * than aspirational — it catches usage sites this scan does not model, and it is
 * also what (correctly) protects an /SMask, which is referenced by its parent
 * image and never drawn by a `Do`.
 */
export function collectImageUsage(doc: Document): ImageUsageMap {
  const ctx: Ctx = { doc, usage: new Map() };
  for (const page of doc.Pages) walkPage(ctx, page);

  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    if (nameOf(doc, obj.dict.get('Subtype')) !== 'Image') continue;
    if (!ctx.usage.has(obj)) {
      ctx.usage.set(obj, { maxDpi: 0, complete: false, reason: 'image not reached by the content scan' });
    }
  }
  return ctx.usage;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/imageusage.test.ts && npm run typecheck`
Expected: 7 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/imageusage.ts test/imageusage.test.ts test/helpers/build-imageopt-pdf.ts
git commit -m "feat(imageusage): CTM-tracking scan for per-image max effective DPI"
```

---

### Task 3: `imageopt.ts` — guard, decode, resample, encode, replace

**Files:**
- Create: `src/imageopt.ts`
- Test: `test/imageopt.test.ts`

**Interfaces:**
- Consumes: `resampleBox` (Task 1); `collectImageUsage`, `ImageUsageMap` (Task 2); `ImageInfo` from `./image.js`; `decodeJpeg` from `./jpeg.js`; `encodeJpeg`, `JpegKind` from `./jpegencode.js`; `doc.replaceObject(num, obj)` from `./document.js`.
- Produces:
  - `interface ImageOptions { dpi?: number; quality?: number }`
  - `interface ImageOptimization { objNum: number; name?: string; width: number; height: number; originalWidth: number; originalHeight: number; bytesSaved: number }`
  - `interface SkippedImage { objNum: number; name?: string; reason: string }`
  - `optimizeImages(doc: Document, opts: ImageOptions): { images: ImageOptimization[]; skippedImages: SkippedImage[] }`

- [ ] **Step 1: Write the failing test**

Create `test/imageopt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { optimizeImages } from '../src/imageopt.js';
import { isStream, isName, isArray, PdfStream } from '../src/types.js';
import { decodeJpeg } from '../src/jpeg.js';
import {
  buildSimpleImagePdf, buildSmaskPdf, buildCmykImagePdf,
} from './helpers/build-imageopt-pdf.js';

function streamAt(doc: Document, num: number): PdfStream {
  const o = doc.getObject(num);
  if (!isStream(o)) throw new Error(`object ${num} is not a stream`);
  return o;
}

describe('optimizeImages', () => {
  it('halves a 288-DPI image at a 144-DPI target', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf(); // 64px in a 16pt box
    const doc = Document.Open(bytes);
    const r = optimizeImages(doc, { dpi: 144 });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toMatchObject({
      objNum: imgObjNum, originalWidth: 64, originalHeight: 64, width: 32, height: 32,
    });
    const s = streamAt(doc, imgObjNum);
    expect(doc.resolve(s.dict.get('Width'))).toBe(32);
    expect(doc.resolve(s.dict.get('Height'))).toBe(32);
  });

  it('does not upsample when the target exceeds the actual DPI', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 600, quality: 20 });
    const s = streamAt(doc, imgObjNum);
    expect(doc.resolve(s.dict.get('Width'))).toBe(64);
    expect(doc.resolve(s.dict.get('Height'))).toBe(64);
  });

  it('replaces the stream in place so existing refs stay valid', () => {
    const { bytes } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 72 });
    // The page's /XObject /Im0 must still resolve to the (new) image.
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const xo = doc.resolve((res as Map<string, any>).get('XObject'));
    const im = doc.resolve((xo as Map<string, any>).get('Im0'));
    expect(isStream(im)).toBe(true);
    expect(doc.resolve((im as PdfStream).dict.get('Width'))).toBe(16);
  });

  it('keeps /SMask attached to the rewritten image, and never touches the mask', () => {
    const { bytes, imgObjNum, smaskObjNum } = buildSmaskPdf();
    const doc = Document.Open(bytes);
    const maskRawBefore = streamAt(doc, smaskObjNum).raw.slice();
    const r = optimizeImages(doc, { dpi: 72 });

    const s = streamAt(doc, imgObjNum);
    const sm = s.dict.get('SMask');
    expect(sm).toBeDefined();                       // survived the rewrite
    expect([...streamAt(doc, smaskObjNum).raw]).toEqual([...maskRawBefore]); // untouched
    expect(r.skippedImages.some((x) => x.objNum === smaskObjNum)).toBe(true);
  });

  it('carries /OC and /Metadata through the rewrite', () => {
    // The denylist rebuild must preserve keys it knows nothing about.
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const ocRef = doc.allocObject(new Map<string, any>([['Type', { kind: 'name', name: 'OCG' }]]));
    const mdRef = doc.allocObject({ kind: 'stream' as const, dict: new Map<string, any>(), raw: new Uint8Array([60, 63]) });
    const d = streamAt(doc, imgObjNum).dict as Map<string, any>;
    d.set('OC', ocRef);
    d.set('Metadata', mdRef);

    optimizeImages(doc, { dpi: 144 });

    const after = streamAt(doc, imgObjNum).dict;
    expect(after.get('OC')).toEqual(ocRef);
    expect(after.get('Metadata')).toEqual(mdRef);
  });

  it('round-trips a CMYK image without adding a /Decode', () => {
    // encodeJpeg writes non-inverted CMYK with no APP14, so the output must
    // carry no /Decode inversion — and the colorspace stays DeviceCMYK.
    const { bytes, imgObjNum } = buildCmykImagePdf();
    const doc = Document.Open(bytes);
    const r = optimizeImages(doc, { dpi: 144 });

    expect(r.skippedImages).toEqual([]);
    const d = streamAt(doc, imgObjNum).dict;
    expect(d.has('Decode')).toBe(false);
    expect(isName(d.get('ColorSpace')) && (d.get('ColorSpace') as any).name).toBe('DeviceCMYK');
    expect(decodeJpeg(streamAt(doc, imgObjNum).raw).comps).toBe(4);
  });

  it('carries an ICCBased /ColorSpace by reference instead of flattening it', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    // Point the image at an ICCBased colorspace: [/ICCBased <stream /N 3>].
    const iccStream = { kind: 'stream' as const, dict: new Map<string, any>([['N', 3]]), raw: new Uint8Array([1, 2, 3]) };
    const iccRef = doc.allocObject(iccStream);
    const csRef = doc.allocObject([{ kind: 'name' as const, name: 'ICCBased' }, iccRef]);
    streamAt(doc, imgObjNum).dict.set('ColorSpace', csRef);

    optimizeImages(doc, { dpi: 144 });

    const cs = doc.resolve(streamAt(doc, imgObjNum).dict.get('ColorSpace'));
    expect(isArray(cs)).toBe(true);
    const head = doc.resolve((cs as any[])[0]);
    expect(isName(head) && head.name).toBe('ICCBased'); // NOT flattened to /DeviceRGB
  });

  it('emits a decodable JPEG at the new dimensions', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 144 });
    const img = decodeJpeg(streamAt(doc, imgObjNum).raw);
    expect(img.width).toBe(32);
    expect(img.height).toBe(32);
    expect(img.comps).toBe(3);
  });

  it('adds no /Decode and drops stale /DecodeParms', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    streamAt(doc, imgObjNum).dict.set('DecodeParms', new Map([['Predictor', 15]]));
    optimizeImages(doc, { dpi: 144 });
    const d = streamAt(doc, imgObjNum).dict;
    expect(d.has('Decode')).toBe(false);
    expect(d.has('DecodeParms')).toBe(false);
    expect(isName(d.get('Filter')) && (d.get('Filter') as any).name).toBe('DCTDecode');
  });

  it('leaves an image byte-identical when the re-encode would not be smaller', () => {
    // Already tiny and heavily compressed: a re-encode at q95 cannot win.
    const { bytes, imgObjNum } = buildSimpleImagePdf({ imgW: 8, imgH: 8, boxW: 8, boxH: 8 });
    const doc = Document.Open(bytes);
    const before = streamAt(doc, imgObjNum).raw.slice();
    const r = optimizeImages(doc, { quality: 95 });
    expect([...streamAt(doc, imgObjNum).raw]).toEqual([...before]);
    expect(r.images).toHaveLength(0);
    expect(r.skippedImages[0].reason).toMatch(/not be smaller/);
  });

  it.each([
    ['ImageMask', (d: Map<string, any>) => d.set('ImageMask', true), /image mask/],
    ['1-bpp', (d: Map<string, any>) => d.set('BitsPerComponent', 1), /BitsPerComponent/],
    ['/Decode', (d: Map<string, any>) => d.set('Decode', [1, 0, 1, 0, 1, 0]), /Decode/],
    ['/Mask', (d: Map<string, any>) => d.set('Mask', [0, 0]), /Mask/],
    ['Indexed', (d: Map<string, any>) =>
      d.set('ColorSpace', [{ kind: 'name', name: 'Indexed' }, { kind: 'name', name: 'DeviceRGB' }, 1, { kind: 'string', bytes: new Uint8Array(6) }]), /[Ii]ndexed/],
    ['Separation', (d: Map<string, any>) =>
      d.set('ColorSpace', [{ kind: 'name', name: 'Separation' }]), /[Ss]eparation|colorspace/],
  ])('skips %s with a reason', (_label, mutate, pattern) => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const before = streamAt(doc, imgObjNum).raw.slice();
    mutate(streamAt(doc, imgObjNum).dict as Map<string, any>);

    const r = optimizeImages(doc, { dpi: 72 });

    expect(r.images).toHaveLength(0);
    const skip = r.skippedImages.find((x) => x.objNum === imgObjNum);
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(pattern);
    expect([...streamAt(doc, imgObjNum).raw]).toEqual([...before]);
  });

  it('re-opens after Save with the image intact', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 144 });
    const out = Document.Open(doc.Save());
    const imgs = out.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    expect(imgs[0].Width).toBe(32);
    expect(imgs[0].Filter).toBe('DCTDecode');
  });
});
```

> **Note:** `Page.Images` is used only if that accessor exists (`collectImages` in `image.ts` backs it). If the property is named differently, use `collectImages(out, out.Pages[0].Resources)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/imageopt.test.ts`
Expected: FAIL — cannot resolve `../src/imageopt.js`.

- [ ] **Step 3: Write the implementation**

Create `src/imageopt.ts`:

```ts
import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isName, isArray, isStream, name,
} from './types.js';
import { ImageInfo } from './image.js';
import { decodeJpeg } from './jpeg.js';
import { encodeJpeg, JpegKind } from './jpegencode.js';
import { resampleBox } from './resample.js';
import { collectImageUsage } from './imageusage.js';

/** Target for the lossy image pass. Presence in OptimizeOptions is the opt-in. */
export interface ImageOptions {
  /** Target DPI. Omit to recompress without downsampling. Never upsamples. */
  dpi?: number;
  /** IJG scale 1..100. Default 75. */
  quality?: number;
}

export interface ImageOptimization {
  /** Object number of the image stream — the one stable identifier. */
  objNum: number;
  /** Resource key of a placement (e.g. 'Im0'); diagnostic only. */
  name?: string;
  width: number; height: number;
  originalWidth: number; originalHeight: number;
  bytesSaved: number;
}

export interface SkippedImage { objNum: number; name?: string; reason: string }

const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

/** Terminal (codec) filter of a chain: the last entry, or the single name. */
function terminalFilter(doc: Document, dict: PdfDict): string | undefined {
  const f = doc.resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) {
    const last = doc.resolve(f[f.length - 1]);
    if (isName(last)) return last.name;
  }
  return undefined;
}

/** Filters whose output ImageInfo.Decode() delivers as plain 8-bit samples. */
const SAMPLE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
]);
const DCT_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'DCT']);

function csHead(doc: Document, cs: PdfObject | undefined): string | undefined {
  const r = doc.resolve(cs);
  if (isName(r)) return r.name;
  if (isArray(r) && r.length > 0) {
    const h = doc.resolve(r[0]);
    if (isName(h)) return h.name;
  }
  return undefined;
}

/**
 * The JpegKind for a colorspace, or a reason it cannot be encoded.
 *
 * This picks how many components the samples carry and whether the encoder
 * applies the YCbCr transform. It says nothing about the output dict: the
 * original /ColorSpace is carried through untouched (see `rebuild`).
 */
function kindOf(doc: Document, cs: PdfObject | undefined): JpegKind | { reason: string } {
  const head = csHead(doc, cs);
  switch (head) {
    case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
    case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
    case 'DeviceCMYK': case 'CMYK': return 'cmyk';
    case 'Indexed': case 'I': return { reason: 'indexed (palette) colorspace' };
    case 'ICCBased': {
      const arr = doc.resolve(cs);
      const s = isArray(arr) ? doc.resolve(arr[1]) : undefined;
      const n = isStream(s) ? doc.resolve(s.dict.get('N')) : undefined;
      if (n === 1) return 'gray';
      if (n === 3) return 'rgb';
      if (n === 4) return 'cmyk';
      return { reason: `ICCBased with unsupported /N ${String(n)}` };
    }
    case undefined: return { reason: 'missing colorspace' };
    default: return { reason: `unsupported colorspace: ${head}` };
  }
}

/** A reason this image must not be recompressed, or undefined when it may be. */
function guard(doc: Document, dict: PdfDict): string | undefined {
  if (doc.resolve(dict.get('ImageMask')) === true) return 'image mask (bilevel stencil)';
  const bpc = doc.resolve(dict.get('BitsPerComponent'));
  if (bpc !== 8) return `BitsPerComponent ${String(bpc ?? '(absent)')} is not 8`;
  if (dict.has('Mask')) return 'has /Mask (stencil or colour-key masking)';
  if (dict.has('Decode')) return 'has /Decode (sample inversion the re-encode would not reproduce)';
  const f = terminalFilter(doc, dict);
  if (f !== undefined && !DCT_FILTERS.has(f) && !SAMPLE_FILTERS.has(f))
    return `unsupported filter ${f}`;
  return undefined;
}

/** Decoded interleaved 8-bit samples, or a reason they are unavailable. */
function samplesOf(
  doc: Document, img: ImageInfo, kind: JpegKind, w: number, h: number,
): Uint8Array | { reason: string } {
  const want = w * h * CHANNELS[kind];
  const f = terminalFilter(doc, img.Dict);
  try {
    if (f !== undefined && DCT_FILTERS.has(f)) {
      // Decode() is a *passthrough* for DCT: it unwraps any preceding filters
      // (e.g. [ASCII85Decode, DCTDecode]) and hands back the JPEG bytes, which
      // is exactly what decodeJpeg wants.
      const j = decodeJpeg(img.Decode());
      if (j.width !== w || j.height !== h)
        return { reason: `JPEG geometry ${j.width}x${j.height} disagrees with the dict ${w}x${h}` };
      if (j.comps !== CHANNELS[kind])
        return { reason: `JPEG has ${j.comps} components, colorspace implies ${CHANNELS[kind]}` };
      return j.data;
    }
    const bytes = img.Decode();
    if (bytes.length !== want)
      return { reason: `decoded ${bytes.length} bytes, expected ${want}` };
    return bytes;
  } catch (e) {
    return { reason: `decode failed: ${(e as Error).message}` };
  }
}

/**
 * The replacement dict: copy the original, then override only what changed.
 *
 * A denylist, not an allowlist. buildJpegXObject() synthesizes a dict from SOF
 * markers and knows only seven keys, so routing through it would silently drop
 * /SMask, /OC, /Intent and /Metadata — an image losing its /SMask renders its
 * transparent background black, with no error anywhere. Copy-then-override lets
 * an unanticipated key survive instead of vanishing.
 *
 * /ColorSpace and /BitsPerComponent are deliberately NOT rewritten: the
 * re-encode preserves the component count and emits 8-bit samples, so the
 * original colorspace object stays exactly as valid as it was. Replacing an
 * ICCBased colorspace with its device equivalent would discard the embedded
 * profile and shift every colour in the image.
 */
function rebuild(original: PdfStream, jpeg: Uint8Array, w: number, h: number): PdfStream {
  const dict: PdfDict = new Map(original.dict);
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.delete('Decode'); // the guard means the source had none
  dict.set('Width', w);
  dict.set('Height', h);
  dict.set('Filter', name('DCTDecode'));
  dict.set('Length', jpeg.length);
  return { kind: 'stream', dict, raw: jpeg };
}

/**
 * Recompress image XObjects to JPEG, downsampling to `opts.dpi`.
 *
 * LOSSY. Only reached when the caller passes `images` to Optimize.
 */
export function optimizeImages(
  doc: Document, opts: ImageOptions,
): { images: ImageOptimization[]; skippedImages: SkippedImage[] } {
  const images: ImageOptimization[] = [];
  const skippedImages: SkippedImage[] = [];
  const quality = opts.quality ?? 75;

  const usage = collectImageUsage(doc);
  const objNums = new Map<PdfStream, number>();
  for (const [r, obj] of doc.objectEntries()) if (isStream(obj)) objNums.set(obj, r.num);

  for (const [stream, u] of usage) {
    const objNum = objNums.get(stream);
    if (objNum === undefined) continue; // a direct stream cannot be referenced; nothing to do
    const skip = (reason: string) => skippedImages.push({ objNum, name: u.name, reason });

    if (!u.complete) { skip(u.reason ?? 'usage could not be determined'); continue; }

    const g = guard(doc, stream.dict);
    if (g) { skip(g); continue; }

    const kind = kindOf(doc, stream.dict.get('ColorSpace'));
    if (typeof kind !== 'string') { skip(kind.reason); continue; }

    const w = doc.resolve(stream.dict.get('Width'));
    const h = doc.resolve(stream.dict.get('Height'));
    if (typeof w !== 'number' || typeof h !== 'number' || w < 1 || h < 1) {
      skip('missing or invalid /Width or /Height'); continue;
    }

    const src = samplesOf(doc, new ImageInfo(doc, u.name ?? '', stream), kind, w, h);
    if (!(src instanceof Uint8Array)) { skip(src.reason); continue; }

    // min(1, ...) is what makes "never upsample" true: an image already coarser
    // than the target is recompressed at quality but not resized.
    const scale = opts.dpi !== undefined && u.maxDpi > 0
      ? Math.min(1, opts.dpi / u.maxDpi) : 1;
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));

    let jpeg: Uint8Array;
    try {
      const resized = resampleBox(src, w, h, CHANNELS[kind], dw, dh);
      jpeg = encodeJpeg(dw, dh, resized, kind, { quality });
    } catch (e) {
      skip(`re-encode failed: ${(e as Error).message}`); continue;
    }

    const bytesSaved = stream.raw.length - jpeg.length;
    if (bytesSaved <= 0) { skip('re-encoded image would not be smaller'); continue; }

    // Install at the SAME object number: every /XObject resource dict points at
    // the image by ref, and PdfStream.raw is readonly, so this is the only way
    // to rewrite a shared stream without repointing each referrer.
    doc.replaceObject(objNum, rebuild(stream, jpeg, dw, dh));
    images.push({
      objNum, name: u.name,
      width: dw, height: dh, originalWidth: w, originalHeight: h,
      bytesSaved,
    });
  }
  return { images, skippedImages };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/imageopt.test.ts && npm run typecheck`
Expected: all passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/imageopt.ts test/imageopt.test.ts
git commit -m "feat(imageopt): downsample and recompress image XObjects to JPEG"
```

---

### Task 4: Wire the concern into `Optimize`, export, document

**Files:**
- Modify: `src/optimize.ts` (options at :13-18, report at :32-42, orchestrator at :164-186)
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `test/optimize.test.ts`

**Interfaces:**
- Consumes: `optimizeImages`, `ImageOptions`, `ImageOptimization`, `SkippedImage` (Task 3).
- Produces: `OptimizeOptions.images?: ImageOptions`; `OptimizeReport.images`, `.skippedImages`, `.lossy`.

- [ ] **Step 1: Write the failing tests**

Append to `test/optimize.test.ts`:

```ts
describe('Optimize({ images })', () => {
  it('touches no image and reports lossy: false with no args', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const before = (doc.getObject(imgObjNum) as PdfStream).raw.slice();
    const r = doc.Optimize();
    expect(r.lossy).toBe(false);
    expect(r.images).toEqual([]);
    expect([...(doc.getObject(imgObjNum) as PdfStream).raw]).toEqual([...before]);
  });

  it('reports lossy: true and shrinks the image when opted in', () => {
    const { bytes } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const r = doc.Optimize({ images: { dpi: 72 } });
    expect(r.lossy).toBe(true);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].bytesSaved).toBeGreaterThan(0);
    expect(r.bytesSaved).toBeGreaterThanOrEqual(r.images[0].bytesSaved);
  });

  it('dedups two identical images that recompression made identical', () => {
    // Guards the pass order: images must run BEFORE dedup.
    const { bytes } = buildTwinImagePdf();
    const doc = Document.Open(bytes);
    const r = doc.Optimize({ images: { dpi: 72 } });
    expect(r.images).toHaveLength(2);
    expect(r.dedup.merged).toBeGreaterThanOrEqual(1);
  });
});
```

Add to `test/helpers/build-imageopt-pdf.ts` the twin fixture:

```ts
/** Two byte-identical DCT images drawn in identical boxes under different
 *  resource keys. After recompression both re-encode to the same bytes, so
 *  dedup must merge them — which only happens if images runs first. */
export function buildTwinImagePdf(): { bytes: Uint8Array; imgObjNums: [number, number] } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q q 16 0 0 16 100 10 cm /Im1 Do Q');
  const dict = (len: number) =>
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${len} >>`;
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R /Im1 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: dict(jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = { dict: dict(jpeg.length), raw: jpeg };
  return { bytes: assemble(objs), imgObjNums: [4, 6] };
}
```

Import the builders at the top of `test/optimize.test.ts`:

```ts
import { buildSimpleImagePdf, buildTwinImagePdf } from './helpers/build-imageopt-pdf.js';
import { PdfStream } from '../src/types.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/optimize.test.ts`
Expected: FAIL — `r.lossy` is undefined; `images` is not a known option.

- [ ] **Step 3: Update `src/optimize.ts`**

Add the import beside the existing concern imports (after line 9):

```ts
import { optimizeImages, ImageOptions, ImageOptimization, SkippedImage } from './imageopt.js';
```

Replace `OptimizeOptions` (lines 13-18):

```ts
/** Which concerns to run. fonts/dedup/compress are lossless and default to true;
 *  `images` is LOSSY and runs only when supplied. */
export interface OptimizeOptions {
  fonts?: boolean;
  dedup?: boolean;
  compress?: boolean;
  /** LOSSY: recompress images to JPEG. Off unless set. There is deliberately no
   *  `true` shorthand — it would mean "degrade my images at settings I did not
   *  choose". */
  images?: ImageOptions;
}
```

Re-export the image types so consumers get them from one place:

```ts
export type { ImageOptions, ImageOptimization, SkippedImage };
```

Add to `OptimizeReport` (inside the interface at lines 32-42):

```ts
  /** Images recompressed. Empty unless `images` was supplied. */
  images: ImageOptimization[];
  /** Images left untouched, and why. */
  skippedImages: SkippedImage[];
  /** True when the images concern ran: output is no longer visually identical. */
  lossy: boolean;
```

Update `optimizeDocument` (lines 164-186) — initializer, pass order, and total:

```ts
  const report: OptimizeReport = {
    fonts: [], skipped: [],
    images: [], skippedImages: [],
    lossy: false,
    dedup: { merged: 0, bytesSaved: 0 },
    compress: { streams: 0, bytesSaved: 0 },
    bytesSaved: 0,
  };

  // Images run first for the same reason fonts precede dedup: a pass that
  // rewrites stream payloads must run before dedup, so dedup can merge the
  // payloads it just made byte-identical (a photo repeated once per page
  // recompresses to N identical streams). compress then skips the DCT streams
  // this wrote, since re-wrapping an image codec only grows it.
  if (opts.images) {
    const r = optimizeImages(doc, opts.images);
    report.images = r.images;
    report.skippedImages = r.skippedImages;
    report.lossy = true;
  }
  if (opts.fonts ?? true) optimizeFonts(doc, report);
  if (opts.dedup ?? true) report.dedup = dedupStreams(doc);
  if (opts.compress ?? true) report.compress = recompressStreams(doc);

  report.bytesSaved =
    report.fonts.reduce((n, f) => n + f.bytesSaved, 0) +
    report.images.reduce((n, i) => n + i.bytesSaved, 0) +
    report.dedup.bytesSaved + report.compress.bytesSaved;
```

Also update the `optimizeDocument` doc comment (lines 159-163) to name the new order:

```ts
/**
 * Shrink the live model. Passes run images -> fonts -> dedup -> compress: images
 * and fonts rewrite stream payloads, dedup then merges payloads those passes just
 * made identical, and compress re-deflates the rest.
 *
 * Lossless unless `opts.images` is supplied, which enables a lossy JPEG
 * recompression pass; `report.lossy` records whether it ran.
 */
```

- [ ] **Step 4: Export the public types from `src/index.ts`**

Find the existing `OptimizeOptions`/`OptimizeReport` export and extend it:

```ts
export type {
  OptimizeOptions, OptimizeReport, ImageOptions, ImageOptimization, SkippedImage,
} from './optimize.js';
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 6: Update `README.md`**

In the Features list, extend the optimization entry to mention images. In the API overview, add:

````markdown
### Optimization

```ts
doc.Optimize();                          // lossless: fonts + dedup + compress
doc.Optimize({ fonts: false });          // opt out per concern
doc.Optimize({ images: { dpi: 150 } });  // LOSSY: also downsample + recompress images
```

`fonts`, `dedup`, and `compress` are lossless and default on. `images` is **lossy
and off unless supplied**: it re-encodes photographic images as JPEG, downsampling
so no placement exceeds `dpi` (never upsampling), at `quality` (IJG 1..100,
default 75). `report.lossy` records whether it ran.

Images are skipped — and reported in `report.skippedImages` with a reason —
when they are image masks, non-8-bit, indexed, bilevel (JBIG2/CCITT), carry a
`/Mask` or `/Decode`, use a colorspace with no JPEG equivalent, or are never
drawn by the content scan (which is what leaves an `/SMask` untouched). An image
is replaced only when the re-encode is strictly smaller.
````

In Limitations, note: *inline images (`BI`) are not recompressed; `Optimize` throws on signed documents.*

- [ ] **Step 7: Commit**

```bash
git add src/optimize.ts src/index.ts README.md test/optimize.test.ts test/helpers/build-imageopt-pdf.ts
git commit -m "feat(optimize): add the lossy images concern

doc.Optimize({ images: { dpi, quality } }) downsamples and recompresses
image XObjects. Opt-in via an options object; the no-arg contract stays
lossless. Runs before dedup so recompressed duplicates still merge.

Closes: aspose-pdf-foss-for-ts-kqy"
```

---

## Final Verification

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — full suite green
- [ ] `bd close aspose-pdf-foss-for-ts-kqy`
- [ ] `git pull --rebase && git push && git status` — must show "up to date with origin"
