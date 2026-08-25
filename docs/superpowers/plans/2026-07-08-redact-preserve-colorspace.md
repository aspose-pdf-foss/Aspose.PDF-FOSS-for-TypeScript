# Preserve Colorspace/Bit-Depth in Partial Image Redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partially-redact CMYK/Indexed/16-bpc images by blanking covered samples in place, preserving the original `/ColorSpace` and `/BitsPerComponent` so uncovered pixels stay byte-identical.

**Architecture:** Add a pure sample-blanking core (`blankSamples`, `encodeSamplesXObject`) to `src/imageredact.ts`. In `src/redact.ts`, `reencodeRedactedImage` gains an eligibility check: eligible images (sample-returning filter, no mask/soft-mask, resolvable component count, integer bit-depth) take the new path; everything else falls back to the existing RGBA→DeviceRGB re-encode, unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import specifiers), vitest, `node:zlib` (`deflateSync`). Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- Blank value is **0** for every sample component (index 0 for Indexed, all-zero for CMYK/Gray/RGB).
- PDF image sample packing is **MSB-first** within each byte; each row is **byte-aligned**.
- All decode/rotation validation must run before any `doc.allocObject`/`getOwned` mutation, so a throw leaves the document untouched.
- Run `npm run typecheck` and `npm test` before closing the issue — both must be green.
- Spec: `docs/superpowers/specs/2026-07-08-redact-preserve-colorspace-design.md`.

---

### Task 1: `blankSamples` — in-place sample zeroing (pure)

**Files:**
- Modify: `src/imageredact.ts` (add exported function after `blankPixels`)
- Test: `test/imageredact.test.ts` (add a `describe('blankSamples', …)` block)

**Interfaces:**
- Consumes: `PixelBox` (already exported from `src/imageredact.ts`: `{ x0, y0, x1, y1 }`, half-open).
- Produces: `blankSamples(samples: Uint8Array, w: number, h: number, nc: number, bpc: number, boxes: PixelBox[]): void` — mutates `samples`, zeroing every component of every pixel inside each box. `nc` = components per pixel (Indexed → 1); `bpc` ∈ {1,2,4,8,16}.

- [ ] **Step 1: Write the failing tests**

Add to `test/imageredact.test.ts` (it already imports from `../src/imageredact.js`; add `blankSamples` to that import):

```ts
import { coveredPixelBox, blankPixels, encodeRgbaXObject, blankSamples } from '../src/imageredact.js';

describe('blankSamples', () => {
  it('zeros the nc components of covered 8-bpc pixels only', () => {
    // 2×1 RGB: [pixel0 rgb][pixel1 rgb]
    const s = Uint8Array.from([11, 22, 33, 44, 55, 66]);
    blankSamples(s, 2, 1, 3, 8, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0 only
    expect([...s]).toEqual([0, 0, 0, 44, 55, 66]);
  });

  it('clears only the covered nibble of a shared 4-bpc byte', () => {
    // 4×1 indexed, 4 bpc → 2 pixels/byte: byte0 = pixels(0,1), byte1 = pixels(2,3)
    const s = Uint8Array.from([0xab, 0xcd]);
    blankSamples(s, 4, 1, 1, 4, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0 = high nibble
    expect([...s]).toEqual([0x0b, 0xcd]); // low nibble (pixel1) preserved

    const s2 = Uint8Array.from([0xab, 0xcd]);
    blankSamples(s2, 4, 1, 1, 4, [{ x0: 1, y0: 0, x1: 2, y1: 1 }]); // pixel1 = low nibble
    expect([...s2]).toEqual([0xa0, 0xcd]); // high nibble (pixel0) preserved
  });

  it('zeros both bytes of a covered 16-bpc sample', () => {
    // 2×1 gray, 16 bpc → 2 bytes/pixel
    const s = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
    blankSamples(s, 2, 1, 1, 16, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0
    expect([...s]).toEqual([0, 0, 0x56, 0x78]);
  });

  it('respects row byte-alignment across rows (1 bpc)', () => {
    // 3×2, 1 bpc, nc 1 → rowBytes = ceil(3/8) = 1. Row0 = 0b111_00000, Row1 = 0b101_00000
    const s = Uint8Array.from([0b11100000, 0b10100000]);
    blankSamples(s, 3, 2, 1, 1, [{ x0: 0, y0: 1, x1: 1, y1: 2 }]); // row1, col0 only
    expect([...s]).toEqual([0b11100000, 0b00100000]); // row0 untouched; row1 bit0 cleared
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/imageredact.test.ts -t blankSamples`
Expected: FAIL — `blankSamples is not a function` / not exported.

- [ ] **Step 3: Implement `blankSamples`**

Add to `src/imageredact.ts` immediately after the `blankPixels` function:

```ts
/** Zero every component of each covered pixel, in place, within packed image
 *  samples. Rows are byte-aligned; `bpc` ∈ {1,2,4,8,16} is packed MSB-first.
 *  Blank value is 0 (index 0 / all-zero color). Sub-byte depths clear only the
 *  covered pixel's bit-field, so a byte shared with an uncovered pixel at a box
 *  edge stays bit-identical. */
export function blankSamples(
  samples: Uint8Array, w: number, h: number, nc: number, bpc: number, boxes: PixelBox[],
): void {
  const rowBytes = Math.ceil((w * nc * bpc) / 8);
  const bytesPerComp = bpc >> 3;              // 1 for 8-bpc, 2 for 16-bpc, 0 for sub-byte
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y++) {
      const rowOff = y * rowBytes;
      for (let x = box.x0; x < box.x1; x++) {
        for (let c = 0; c < nc; c++) {
          const bit = (x * nc + c) * bpc;
          const byte = rowOff + (bit >> 3);
          if (bpc >= 8) {
            for (let k = 0; k < bytesPerComp; k++) if (byte + k < samples.length) samples[byte + k] = 0;
          } else if (byte < samples.length) {
            const shift = 8 - (bit & 7) - bpc;  // MSB-first field position within the byte
            samples[byte] &= ~(((1 << bpc) - 1) << shift) & 0xff;
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/imageredact.test.ts -t blankSamples`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/imageredact.ts test/imageredact.test.ts
git commit -m "feat(njs): blankSamples — in-place packed-sample zeroing for redaction"
```

---

### Task 2: `encodeSamplesXObject` — re-encode preserving colorspace (pure)

**Files:**
- Modify: `src/imageredact.ts` (add exported function after `encodeRgbaXObject`)
- Test: `test/imageredact.test.ts` (add a `describe('encodeSamplesXObject', …)` block)

**Interfaces:**
- Consumes: `PdfDict`, `PdfObject`, `name` (already imported in `src/imageredact.ts`); `deflateSync` (already imported).
- Produces: `encodeSamplesXObject(srcDict: PdfDict, samples: Uint8Array): { dict: PdfDict; raw: Uint8Array }` — deflates `samples`; returns a fresh image dict cloning `Width/Height/ColorSpace/BitsPerComponent/Decode/Intent` from `srcDict` (by reference), with `Type/Subtype` set and `Filter = FlateDecode` (original `/Filter` and `/DecodeParms` dropped).

- [ ] **Step 1: Write the failing test**

Add to `test/imageredact.test.ts` (the file already imports `isName` from `../src/types.js` and `inflateSync` from `node:zlib`; add `encodeSamplesXObject` to the `imageredact.js` import):

```ts
import { PdfDict, PdfObject, name, isName, isArray } from '../src/types.js';

describe('encodeSamplesXObject', () => {
  it('clones colorspace/bit-depth/decode and re-deflates the samples', () => {
    const src: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 4], ['Height', 1],
      ['ColorSpace', name('DeviceCMYK')], ['BitsPerComponent', 8],
      ['Decode', [1, 0, 1, 0, 1, 0, 1, 0] as unknown as PdfObject],
      ['Filter', name('LZWDecode')], // must NOT be carried over
    ]);
    const samples = Uint8Array.from([0, 0, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1]);
    const out = encodeSamplesXObject(src, samples);

    expect(isName(out.dict.get('ColorSpace')) && (out.dict.get('ColorSpace') as { name: string }).name).toBe('DeviceCMYK');
    expect(out.dict.get('BitsPerComponent')).toBe(8);
    expect(isArray(out.dict.get('Decode'))).toBe(true);
    expect(isName(out.dict.get('Filter')) && (out.dict.get('Filter') as { name: string }).name).toBe('FlateDecode');
    expect([...inflateSync(Buffer.from(out.raw))]).toEqual([...samples]); // uncovered bytes round-trip
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/imageredact.test.ts -t encodeSamplesXObject`
Expected: FAIL — `encodeSamplesXObject is not a function`.

- [ ] **Step 3: Implement `encodeSamplesXObject`**

Add to `src/imageredact.ts` immediately after `encodeRgbaXObject`:

```ts
/** Re-encode blanked packed samples as a FlateDecode image, cloning the source
 *  image's colorspace and bit-depth so uncovered pixels stay byte-identical. The
 *  original `/Filter` and `/DecodeParms` are dropped (output is raw deflate, no
 *  predictor); `/ColorSpace` and `/Decode` are carried over by reference. */
export function encodeSamplesXObject(srcDict: PdfDict, samples: Uint8Array): {
  dict: PdfDict; raw: Uint8Array;
} {
  const raw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const dict = new Map<string, PdfObject>();
  dict.set('Type', name('XObject'));
  dict.set('Subtype', name('Image'));
  for (const k of ['Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Decode', 'Intent']) {
    const v = srcDict.get(k);
    if (v !== undefined) dict.set(k, v);
  }
  dict.set('Filter', name('FlateDecode'));
  return { dict, raw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/imageredact.test.ts -t encodeSamplesXObject`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/imageredact.ts test/imageredact.test.ts
git commit -m "feat(njs): encodeSamplesXObject — colorspace-preserving image re-encode"
```

---

### Task 3: Wire the sample-preserving path into redaction (end-to-end)

**Files:**
- Modify: `src/redact.ts` (imports + `reencodeRedactedImage`, add `sampleRedactPlan` helper)
- Modify: `test/helpers/build-image-pdf.ts` (add `buildPlacedRawImagePdf`)
- Test: `test/redact-image.test.ts` (new cases)

**Interfaces:**
- Consumes: `blankSamples`, `encodeSamplesXObject`, `coveredPixelBox`, `PixelBox` (from `src/imageredact.js`); `decodeImageRgba`, `blankPixels`, `encodeRgbaXObject` (existing); `ImageInfo` (from `src/image.js`); `resolveColorSpace` (from `src/colorspace.js`); `inflateStream` (from `src/flate.js`); `isArray`, `isName` (from `src/types.js`).
- Produces: `buildPlacedRawImagePdf(opts)` fixture (see Step 1); no new public API — `reencodeRedactedImage` keeps its signature.

- [ ] **Step 1: Add the raw-colorspace fixture builder**

Add to `test/helpers/build-image-pdf.ts` after `buildSingleImagePdfWithCm` (it already imports `deflateSync`, `enc`, `Obj`, `emitObjs`):

```ts
/** Build a 1-page PDF placing a single image `Im0` whose `/ColorSpace` is an
 *  arbitrary verbatim token (name WITH leading slash, e.g. `/DeviceCMYK`, or an
 *  array literal, e.g. `[/Indexed /DeviceRGB 2 <000000ff000000ff00>]`). `raw` is
 *  the pre-deflated sample stream; the builder wraps it in FlateDecode. */
export function buildPlacedRawImagePdf(opts: {
  width: number; height: number; colorSpace: string; bits: number;
  samples: Uint8Array; cm: string; mediaBox?: string; extra?: string;
}): Uint8Array {
  const { width, height, colorSpace, bits, samples, cm, mediaBox = '0 0 100 100', extra = '' } = opts;
  const raw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const content = enc(`q ${cm} cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent ${bits} /Filter /FlateDecode ${extra} /Length ${raw.length} >>`, raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}
```

- [ ] **Step 2: Write the failing end-to-end tests**

Add to `test/redact-image.test.ts`. Extend the existing imports:
```ts
import {
  buildPlacedImagePdf, buildSingleImagePdfWithCm, buildPlacedImageWithSMaskPdf, buildPlacedRawImagePdf,
} from './helpers/build-image-pdf.js';
```
Then add this block after the existing `describe('partial image redaction (clip + re-encode)', …)`:

```ts
describe('partial image redaction — colorspace/bit-depth preservation', () => {
  const CM = '100 0 0 100 0 0'; // image at device [0,0,100,100]

  it('keeps DeviceCMYK 8-bpc: uncovered samples identical, covered zeroed', () => {
    // 4×1 CMYK, distinct per-pixel samples.
    const s = new Uint8Array(4 * 4);
    for (let i = 0; i < 16; i++) s[i] = 10 + i;
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1, colorSpace: '/DeviceCMYK', bits: 8, samples: s, cm: CM, mediaBox: '0 0 100 100',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // leftmost column (pixel 0)

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceCMYK');
    expect(img.Bits).toBe(8);
    const d = img.Decode();
    expect([...d.subarray(0, 4)]).toEqual([0, 0, 0, 0]);        // covered pixel 0 → zero
    expect([...d.subarray(4, 16)]).toEqual([...s.subarray(4, 16)]); // pixels 1..3 byte-identical
  });

  it('keeps an Indexed 8-bpc palette: uncovered indices identical, covered → index 0', () => {
    // 4×1 indexed, palette of 3 RGB entries; indices 3,2,1,2 across the row.
    const idx = Uint8Array.from([1, 2, 1, 2]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1,
      colorSpace: '[/Indexed /DeviceRGB 2 <000000 ff0000 00ff00>]',
      bits: 8, samples: idx, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.ColorSpace).toBe('Indexed');
    const d = img.Decode();
    expect(d[0]).toBe(0);                 // covered index → 0
    expect([...d.subarray(1, 4)]).toEqual([2, 1, 2]); // uncovered indices unchanged
  });

  it('keeps sub-byte 4-bpc packing: box-edge byte shares an uncovered nibble', () => {
    // 4×1, 4 bpc indexed → 2 bytes: byte0 = pixels(0,1), byte1 = pixels(2,3).
    const packed = Uint8Array.from([0xab, 0xcd]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1,
      colorSpace: '[/Indexed /DeviceGray 15 <000102030405060708090a0b0c0d0e0f>]',
      bits: 4, samples: packed, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0 = high nibble of byte0

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.Bits).toBe(4);
    const d = img.Decode();
    expect([...d]).toEqual([0x0b, 0xcd]); // pixel0 nibble cleared, pixel1 nibble (0x0b) kept
  });

  it('keeps DeviceGray 16-bpc: uncovered 16-bit samples identical, covered zeroed', () => {
    // 2×1 gray, 16 bpc → 4 bytes.
    const s = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 2, height: 1, colorSpace: '/DeviceGray', bits: 16, samples: s, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0 (left half of width-2 image)

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.Bits).toBe(16);
    const d = img.Decode();
    expect([...d.subarray(0, 2)]).toEqual([0, 0]);            // covered pixel 0
    expect([...d.subarray(2, 4)]).toEqual([0x56, 0x78]);      // pixel 1 unchanged
  });

  it('falls back to RGBA (DeviceRGB + SMask) for a soft-masked image', () => {
    // A base image carrying an /SMask is ineligible for the sample path, so it
    // re-encodes via the RGBA path — which always emits DeviceRGB and keeps an SMask.
    const smAlpha = new Uint8Array(4 * 4).fill(200);
    const doc = Document.Open(buildPlacedImageWithSMaskPdf({
      width: 4, height: 4, samples: grid4(),
      smask: { width: 4, height: 4, filter: 'FlateDecode', raw: new Uint8Array(require('node:zlib').deflateSync(Buffer.from(smAlpha))) },
      placements: [CM],
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);

    const reopened = Document.Open(doc.Save());
    const img = reopened.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceRGB');                 // RGBA fallback ran
    expect(isStream(reopened.resolve(img.Dict.get('SMask')))).toBe(true); // SMask kept, not dropped
  });
});
```

Note: the SMask-fallback test needs a Flate deflate for the mask. Replace the `require(...)` with a top-of-file import already present? The file imports from `node:zlib` is NOT present — add `import { deflateSync } from 'node:zlib';` at the top of `test/redact-image.test.ts` and use `deflateSync(Buffer.from(smAlpha))` instead of the inline `require`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/redact-image.test.ts -t "colorspace/bit-depth preservation"`
Expected: FAIL — CMYK/Indexed/16-bpc images currently re-encode to DeviceRGB 8-bpc (`img.ColorSpace` is `DeviceRGB`, samples differ).

- [ ] **Step 4: Add the eligibility helper and wire the sample path**

In `src/redact.ts`, extend the imports:

```ts
import { decodeImageRgba } from './raster.js';
import { coveredPixelBox, blankPixels, encodeRgbaXObject, blankSamples, encodeSamplesXObject, PixelBox } from './imageredact.js';
import { ImageInfo } from './image.js';
import { resolveColorSpace } from './colorspace.js';
import { inflateStream } from './flate.js';
```
and add `isArray` (already imported) — confirm `isName`, `isArray`, `isStream`, `isDict`, `name` remain imported from `./types.js` (they are).

Add this helper above `reencodeRedactedImage`:

```ts
/** Number of sample components per pixel for a colorspace we can lay out from the
 *  image dict alone, or undefined when it can't be determined reliably (a bare
 *  non-device name — e.g. a `/Resources` colorspace reference — is ambiguous
 *  here, so such images fall back to the RGBA path rather than risk a wrong
 *  stride). Indexed → 1; CMYK/ICC-CMYK/DeviceN → their colorant count. */
function sampleComponents(doc: Document, csObj: PdfObject | undefined): number | undefined {
  const r = doc.resolve(csObj);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return 1;
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return 3;
      case 'DeviceCMYK': case 'CMYK': return 4;
      default: return undefined;
    }
  }
  if (isArray(r)) {
    return resolveColorSpace(r, (o) => doc.resolve(o), (s) => inflateStream(s as Parameters<typeof inflateStream>[0])).components;
  }
  return undefined;
}

/** If `stream` is eligible for sample-level blanking (its filter decodes to
 *  samples in the original colorspace, it has no mask/soft-mask, and its
 *  colorspace + bit-depth are laid-out-able), return `{ nc, bpc }`; else undefined
 *  (caller uses the RGBA fallback). */
function sampleRedactPlan(doc: Document, stream: PdfStream): { nc: number; bpc: number } | undefined {
  const dict = stream.dict;
  const filt = new ImageInfo(doc, '', stream).Filter ?? '';
  if (filt === 'DCTDecode' || filt === 'DCT' || filt === 'JPXDecode' || filt === 'JBIG2Decode') return undefined;
  if (doc.resolve(dict.get('ImageMask')) === true) return undefined;
  if (dict.get('SMask') !== undefined || dict.get('Mask') !== undefined) return undefined;
  const bpcV = doc.resolve(dict.get('BitsPerComponent'));
  const bpc = typeof bpcV === 'number' ? bpcV : 0;
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8 && bpc !== 16) return undefined;
  const nc = sampleComponents(doc, dict.get('ColorSpace'));
  if (nc === undefined) return undefined;
  return { nc, bpc };
}
```

Then replace the body of `reencodeRedactedImage` (currently the RGBA-only version) with the branching version:

```ts
function reencodeRedactedImage(
  doc: Document, getOwned: () => PdfDict, stream: PdfStream, ctm: Matrix, rects: Rect[],
): string {
  const plan = sampleRedactPlan(doc, stream);
  let enc: { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } };

  if (plan) {
    // Sample-preserving path: blank covered samples, keep colorspace/bit-depth.
    let samples: Uint8Array;
    try { samples = new ImageInfo(doc, '', stream).Decode(); }
    catch { throw new UnsupportedFeatureError('image codec cannot be decoded for partial redaction'); }
    const wv = doc.resolve(stream.dict.get('Width')), hv = doc.resolve(stream.dict.get('Height'));
    const w = typeof wv === 'number' ? wv : 0, h = typeof hv === 'number' ? hv : 0;
    const boxes: PixelBox[] = [];
    for (const r of rects) { const b = coveredPixelBox(ctm, w, h, r); if (b) boxes.push(b); } // validates rotation
    blankSamples(samples, w, h, plan.nc, plan.bpc, boxes);
    enc = encodeSamplesXObject(stream.dict, samples); // validated above — mutation below
  } else {
    // Fallback: decode to RGBA and re-encode as DeviceRGB (+ SMask when non-opaque).
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    if (!img) throw new UnsupportedFeatureError('image codec cannot be decoded for partial redaction');
    const boxes: PixelBox[] = [];
    for (const r of rects) { const b = coveredPixelBox(ctm, img.w, img.h, r); if (b) boxes.push(b); }
    blankPixels(img, boxes);
    enc = encodeRgbaXObject(img);
  }

  if (enc.smask) {
    const smRef = doc.allocObject({ kind: 'stream', dict: enc.smask.dict, raw: enc.smask.raw });
    enc.dict.set('SMask', smRef);
  }
  const imgRef = doc.allocObject({ kind: 'stream', dict: enc.dict, raw: enc.raw });

  const xobj = ensureOwnSubdict(doc, getOwned(), 'XObject');
  let n = 0;
  while (xobj.has(`RdImg${n}`)) n++;
  const newName = `RdImg${n}`;
  xobj.set(newName, imgRef);
  return newName;
}
```

(`PdfStream` is already imported in `src/redact.ts`; confirm it appears in the `./types.js` import list — add it if missing.)

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run test/redact-image.test.ts -t "colorspace/bit-depth preservation"`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full redaction + image suites for regressions**

Run: `npx vitest run test/redact-image.test.ts test/imageredact.test.ts test/redact.test.ts`
Expected: PASS (all — existing DCT/rotation/full-cover cases still green).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/redact.ts test/helpers/build-image-pdf.ts test/redact-image.test.ts
git commit -m "feat(njs): preserve colorspace/bit-depth in partial image redaction"
```

---

### Task 4: Documentation + issue close

**Files:**
- Modify: `README.md` (redaction limitations paragraph, near line 402–410)

**Interfaces:** none.

- [ ] **Step 1: Update the README redaction paragraph**

In `README.md`, find the sentence in the redaction section (around line 402) that reads:

```
An image
only *partially* covered by a region is decoded, the covered pixels destroyed,
and the image re-encoded (as DeviceRGB) under a fresh copy-on-write XObject, so
only the covered area is lost.
```

Replace it with:

```
An image
only *partially* covered by a region is decoded, the covered pixels destroyed,
and the image re-encoded under a fresh copy-on-write XObject, so only the covered
area is lost. Images whose samples decode in their own colorspace
(Flate/LZW/CCITT — any of DeviceGray/RGB/CMYK, ICC, Indexed, or DeviceN, at
1/2/4/8/16 bpc) are blanked at sample level and keep their original colorspace
and bit-depth, leaving uncovered pixels byte-identical; DCT (JPEG) images and
images carrying an `/SMask`/`/Mask` re-encode as DeviceRGB via the raster path.
```

- [ ] **Step 2: Run the full suite + typecheck (final gate)**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(njs): document colorspace-preserving partial image redaction"
```

- [ ] **Step 4: Close the issue**

Run:
```bash
bd close aspose-pdf-foss-for-ts-njs --reason "Sample-level blanking preserves original colorspace/bit-depth (Device*/ICC/Indexed/DeviceN, 1-16 bpc) for Flate/LZW/CCITT images; DCT and /SMask|/Mask images fall back to the RGBA->DeviceRGB path. blankSamples + encodeSamplesXObject in imageredact.ts; eligibility + wiring in redact.ts. vitest: CMYK/Indexed/4bpc/16bpc preservation + SMask fallback. typecheck + full suite green."
```

---

## Self-Review

**Spec coverage:**
- Sample-preserving decode/blank/re-encode → Tasks 1, 2, 3. ✓
- Eligibility (filter, ImageMask, SMask/Mask, colorspace, bpc) → Task 3 `sampleRedactPlan`. ✓
- Blank value 0, MSB-first sub-byte, row byte-alignment → Task 1 `blankSamples` + tests. ✓
- Preserve `/ColorSpace`/`/BitsPerComponent`/`/Decode`, drop filter/predictor → Task 2 `encodeSamplesXObject` + test. ✓
- Validation before mutation → Task 3 `reencodeRedactedImage` (Decode + coveredPixelBox before allocObject). ✓
- Tests: Indexed-8, CMYK-8, sub-byte-4, 16-bpc, SMask fallback → Task 3 Step 2. ✓ (DCT/rotation/full-cover fallbacks already covered by existing tests, re-run in Step 6.)
- README update → Task 4. ✓
- Reliable `nc` (bare non-device name ⇒ ineligible) — refinement beyond the spec's prose, prevents stride corruption; captured in Task 3 `sampleComponents`. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `blankSamples(samples,w,h,nc,bpc,boxes)`, `encodeSamplesXObject(srcDict,samples)`, `sampleRedactPlan(doc,stream)→{nc,bpc}|undefined`, `sampleComponents(doc,csObj)→number|undefined`, `PixelBox` — names/signatures match across Tasks 1→3. The re-encode result variable `enc` shadows the module-level `enc` TextEncoder only inside test helpers, not in `redact.ts` (no such binding there). ✓
