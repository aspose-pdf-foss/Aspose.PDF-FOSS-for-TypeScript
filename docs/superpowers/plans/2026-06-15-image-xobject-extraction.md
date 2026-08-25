# Image (XObject) extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enumerate and extract embedded image XObjects from a page via `Page.Images: ImageInfo[]`, exposing dimensions/colorspace/bits, raw encoded bytes, and decoded bytes (Flate samples; JPEG passthrough).

**Architecture:** A new `ImageInfo` live-handle class (mirroring `Page`/`Field`) wraps an image XObject stream and resolves indirect refs through the owning `Document`. A `collectImages` helper walks `Resources/XObject`, emitting an `ImageInfo` per `/Subtype /Image` and recursing into `/Subtype /Form` XObjects (cycle-guarded). `Decode()` reuses the existing `inflateStream` for Flate and passes JPEG bytes through.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, `node:zlib`.

---

### Task 1: Test fixture helper

**Files:**
- Create: `test/helpers/build-image-pdf.ts`
- Test: `test/image.test.ts`

- [ ] **Step 1: Write the helper**

Create `test/helpers/build-image-pdf.ts`:

```ts
import { deflateSync } from 'node:zlib';

const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Build a 1-page classic-xref PDF carrying several image XObjects:
 *  Im0 (2x2 DeviceRGB Flate), Dct0 (DCTDecode + SMask), Fm0 (Form containing
 *  ImF, a 2x2 DeviceGray Flate image), Msk0 (/ImageMask Flate), Cc0
 *  (CCITTFaxDecode, unsupported). Object 10 is Dct0's SMask (only reachable
 *  via the image dict, so it must NOT be enumerated). */
export function buildImagePdf(): {
  bytes: Uint8Array;
  rgbSamples: Uint8Array; // expected Im0 decoded samples
  jpegBytes: Uint8Array;  // Dct0 raw == decode (passthrough)
} {
  const rgbSamples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const rgbRaw = new Uint8Array(deflateSync(Buffer.from(rgbSamples)));
  const graySamples = Uint8Array.from([0, 128, 255, 64]);
  const grayRaw = new Uint8Array(deflateSync(Buffer.from(graySamples)));
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const maskRaw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([0b10000000, 0b01000000]))));
  const smaskRaw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([10, 20, 30, 40]))));
  const ccittRaw = Uint8Array.from([0x26, 0x00, 0x10, 0x01]);
  const contentRaw = enc('q 1 0 0 1 0 0 cm /Im0 Do Q');

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R /Dct0 5 0 R /Fm0 6 0 R /Msk0 8 0 R /Cc0 9 0 R >> >> /Contents 11 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgbRaw.length} >>`, raw: rgbRaw };
  objs[5] = { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 10 0 R /Length ${jpegBytes.length} >>`, raw: jpegBytes };
  objs[6] = { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /ImF 7 0 R >> >> /Length 0 >>`, raw: new Uint8Array(0) };
  objs[7] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${grayRaw.length} >>`, raw: grayRaw };
  objs[8] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /Filter /FlateDecode /Length ${maskRaw.length} >>`, raw: maskRaw };
  objs[9] = { dict: `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /Length ${ccittRaw.length} >>`, raw: ccittRaw };
  objs[10] = { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smaskRaw.length} >>`, raw: smaskRaw };
  objs[11] = { dict: `<< /Length ${contentRaw.length} >>`, raw: contentRaw };
  const maxObj = 11;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') {
      push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    } else {
      push(enc(`${n} 0 obj\n${o.dict}\nstream\n`));
      push(o.raw);
      push(enc(`\nendstream\nendobj\n`));
    }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  return { bytes: concat(parts), rgbSamples, jpegBytes };
}
```

- [ ] **Step 2: Write a sanity test**

Create `test/image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildImagePdf } from './helpers/build-image-pdf.js';

describe('Image extraction', () => {
  it('opens the fixture with one page', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    expect(doc.Pages).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the sanity test**

Run: `npx vitest run test/image.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-image-pdf.ts test/image.test.ts
git commit -m "test: image-extraction fixture builder (5ua)"
```

---

### Task 2: ImageInfo, collectImages, Page.Images

**Files:**
- Create: `src/image.ts`
- Modify: `src/page.ts` (add `Images` getter + import)
- Modify: `src/index.ts` (export `ImageInfo`)
- Test: `test/image.test.ts`

- [ ] **Step 1: Write failing tests (enumeration + properties)**

Append to the `describe('Image extraction', ...)` block in `test/image.test.ts`:

```ts
  it('enumerates page images, recursing into Form XObjects', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const names = doc.Pages[0].Images.map((i) => i.Name);
    expect(names).toEqual(['Im0', 'Dct0', 'ImF', 'Msk0', 'Cc0']);
  });

  it('reads dimensions, colorspace and bits', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const im0 = doc.Pages[0].Images.find((i) => i.Name === 'Im0')!;
    expect([im0.Width, im0.Height]).toEqual([2, 2]);
    expect(im0.ColorSpace).toBe('DeviceRGB');
    expect(im0.Bits).toBe(8);
    expect(im0.Filter).toBe('FlateDecode');
  });

  it('handles image masks gracefully (1 bit, no colorspace)', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const msk = doc.Pages[0].Images.find((i) => i.Name === 'Msk0')!;
    expect(msk.Bits).toBe(1);
    expect(msk.ColorSpace).toBe('');
  });

  it('decodes Flate samples and passes JPEG bytes through', () => {
    const { bytes, rgbSamples, jpegBytes } = buildImagePdf();
    const doc = Document.Open(bytes);
    const imgs = doc.Pages[0].Images;
    const im0 = imgs.find((i) => i.Name === 'Im0')!;
    expect(im0.Decode()).toEqual(rgbSamples);
    const dct = imgs.find((i) => i.Name === 'Dct0')!;
    expect(dct.Filter).toBe('DCTDecode');
    expect(dct.RawData).toEqual(jpegBytes);
    expect(dct.Decode()).toEqual(jpegBytes);
  });

  it('lists unsupported-filter images but throws on Decode', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const cc = doc.Pages[0].Images.find((i) => i.Name === 'Cc0')!;
    expect(cc.RawData.length).toBeGreaterThan(0); // raw access never throws
    expect(() => cc.Decode()).toThrow(UnsupportedFeatureError);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/image.test.ts`
Expected: FAIL — `doc.Pages[0].Images` is not a function / property does not exist.

- [ ] **Step 3: Create `src/image.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfStream, PdfObject, isDict, isStream, isName, isArray } from './types.js';
import { inflateStream } from './flate.js';

function numOf(doc: Document, dict: PdfDict, key: string, dflt: number): number {
  const v = doc.resolve(dict.get(key));
  return typeof v === 'number' ? v : dflt;
}

/** Effective single codec filter name (last in a chain), or undefined when none. */
function filterName(doc: Document, dict: PdfDict): string | undefined {
  const f = doc.resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) {
    const last = doc.resolve(f[f.length - 1]);
    if (isName(last)) return last.name;
  }
  return undefined;
}

/** A single embedded image XObject: a live, read-only handle over its stream. */
export class ImageInfo {
  constructor(
    private readonly doc: Document,
    /** Resource key under which the image was found (e.g. 'Im0'). */
    readonly Name: string,
    /** The live image XObject stream. */
    private readonly stream: PdfStream,
  ) {}

  /** The live image XObject dict. */
  get Dict(): PdfDict { return this.stream.dict; }

  /** /Width (0 when absent/invalid). */
  get Width(): number { return numOf(this.doc, this.Dict, 'Width', 0); }

  /** /Height (0 when absent/invalid). */
  get Height(): number { return numOf(this.doc, this.Dict, 'Height', 0); }

  /** /BitsPerComponent; defaults to 1 for an image mask, else 8. */
  get Bits(): number {
    const im = this.doc.resolve(this.Dict.get('ImageMask'));
    return numOf(this.doc, this.Dict, 'BitsPerComponent', im === true ? 1 : 8);
  }

  /** Colorspace label: a name as-is, an array's first element name, or ''. */
  get ColorSpace(): string {
    const cs = this.doc.resolve(this.Dict.get('ColorSpace'));
    if (isName(cs)) return cs.name;
    if (isArray(cs) && cs.length > 0) {
      const head = this.doc.resolve(cs[0]);
      if (isName(head)) return head.name;
    }
    return '';
  }

  /** Effective codec filter name (last in a filter chain), or undefined. */
  get Filter(): string | undefined { return filterName(this.doc, this.Dict); }

  /** Raw encoded stream bytes (still Flate/DCT-encoded). Never throws. */
  get RawData(): Uint8Array { return this.stream.raw; }

  /** Decoded bytes: JPEG passthrough for DCTDecode; decoded samples for
   *  FlateDecode (+ predictor). Throws UnsupportedFeatureError otherwise. */
  Decode(): Uint8Array {
    const f = this.Filter;
    if (f === 'DCTDecode' || f === 'DCT') return this.stream.raw;
    return inflateStream(this.stream);
  }
}

/** Enumerate image XObjects reachable from a resource dict, descending into
 *  Form XObjects. Cycle-guarded by visited /XObject dicts. */
export function collectImages(doc: Document, resources: PdfDict | undefined): ImageInfo[] {
  const out: ImageInfo[] = [];
  const seen = new Set<PdfDict>();
  const walk = (res: PdfObject) => {
    const r = doc.resolve(res);
    if (!isDict(r)) return;
    const xobj = doc.resolve(r.get('XObject'));
    if (!isDict(xobj) || seen.has(xobj)) return;
    seen.add(xobj);
    for (const [key, val] of xobj) {
      const obj = doc.resolve(val);
      if (!isStream(obj)) continue;
      const sub = doc.resolve(obj.dict.get('Subtype'));
      const subName = isName(sub) ? sub.name : undefined;
      if (subName === 'Image') {
        out.push(new ImageInfo(doc, key, obj));
      } else if (subName === 'Form') {
        walk(obj.dict.get('Resources'));
      }
    }
  };
  walk(resources ?? null);
  return out;
}
```

- [ ] **Step 4: Add `Images` getter to `src/page.ts`**

Add the import near the top of `src/page.ts` (after the existing `inflateStream` import):

```ts
import { ImageInfo, collectImages } from './image.js';
```

Add this getter inside the `Page` class, after the `Annotations` getter (end of class):

```ts
  /** Embedded images reachable from this page's resources, descending into
   *  Form XObjects; [] when none. */
  get Images(): ImageInfo[] {
    return collectImages(this.doc, this.Resources);
  }
```

- [ ] **Step 5: Export `ImageInfo` from `src/index.ts`**

Add after the `export { Page } from './page.js';` line:

```ts
export { ImageInfo } from './image.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/image.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/image.ts src/page.ts src/index.ts test/image.test.ts
git commit -m "feat: enumerate and extract image XObjects via Page.Images (5ua)"
```

---

## Notes for the implementer

- Import specifiers use the `.js` extension even for `.ts` files (ESM + bundler-less TS) — match the existing files.
- `doc.resolve(undefined)` and `doc.resolve(null)` both return `null`, so the `walk(resources ?? null)` entry and missing-key lookups are safe.
- `inflateStream` already reads `DecodeParms`/`DP` and applies PNG/TIFF predictors, and throws `UnsupportedFeatureError` for non-Flate filters and filter chains — `Decode()` deliberately reuses it rather than re-implementing filter handling.
- The SMask (object 10) is reachable only via Dct0's `/SMask`, never from a `/XObject` dict, so it is correctly absent from the enumerated list — that is what the `toEqual([...5 names])` assertion guards.
