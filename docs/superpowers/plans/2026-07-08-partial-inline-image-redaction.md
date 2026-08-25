# Partial inline image redaction (BI…EI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partially redact inline images (`BI…ID…EI`) in place — blank only the covered pixels and re-encode the image within the content stream — instead of throwing `UnsupportedFeatureError`.

**Architecture:** Normalize an inline image into a synthetic full-key `PdfStream` so the existing image-XObject redaction primitives (`sampleRedactPlan`, `ImageInfo.Decode`, `coveredPixelBox`, `blankSamples`/`blankPixels`, `decodeImageRgba`) apply unchanged, then re-emit a fresh `BI` op. Inline images cannot carry `/SMask`, so a transparent re-encode result throws.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest, `node:zlib`. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins.
- ESM + NodeNext: import specifiers carry the `.js` extension.
- Errors are the public types in `src/errors.ts` — throw `UnsupportedFeatureError` for unsupported cases.
- TDD: land each behavior with a vitest test first. `npm run typecheck` and `npm test` must be green before closing.
- Redaction keeps the image inline — no `/Resources` mutation for inline images.
- Follow existing code/test style (see `src/redact.ts`, `src/imageredact.ts`, `test/redact-image.test.ts`).

Reference spec: `docs/superpowers/specs/2026-07-08-partial-inline-image-redaction-design.md`.

---

### Task 1: `inlineImageToStream` — normalize an inline image to a full-key stream

**Files:**
- Modify: `src/imageredact.ts` (add helper + imports)
- Test: `test/imageredact.test.ts` (add a describe block)

**Interfaces:**
- Produces: `inlineImageToStream(inline: { dict: PdfDict; data: Uint8Array }): PdfStream` — a synthetic `PdfStream { kind:'stream', dict, raw: inline.data }` with abbreviated keys and device/indexed colorspace names expanded to full form; `/L` and `/Length` dropped; filter names left as-is.

- [ ] **Step 1: Write the failing test**

Add to `test/imageredact.test.ts`. Check the existing imports at the top of that file and add `inlineImageToStream` to the `../src/imageredact.js` import, and `isName, isArray, PdfName` from `../src/types.js` if not already present.

```ts
describe('inlineImageToStream', () => {
  it('expands abbreviated keys and a device colorspace name', () => {
    const dict = new Map<string, any>([
      ['W', 4], ['H', 3], ['BPC', 8], ['CS', name('RGB')], ['F', name('Fl')], ['L', 12],
    ]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([1, 2, 3]) });
    expect(s.kind).toBe('stream');
    expect(s.dict.get('Width')).toBe(4);
    expect(s.dict.get('Height')).toBe(3);
    expect(s.dict.get('BitsPerComponent')).toBe(8);
    const cs = s.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    const f = s.dict.get('Filter');
    expect(isName(f) && f.name).toBe('Fl'); // filter abbreviations left as-is
    expect(s.dict.has('L')).toBe(false);    // length dropped
    expect(s.raw).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('expands an indexed colorspace array head and base', () => {
    const dict = new Map<string, any>([
      ['W', 2], ['H', 2], ['BPC', 8],
      ['CS', [name('I'), name('RGB'), 1, { kind: 'string', bytes: Uint8Array.from([0, 0, 0, 255, 255, 255]) }]],
    ]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([0, 1, 1, 0]) });
    const cs = s.dict.get('ColorSpace') as any[];
    expect(isName(cs[0]) && cs[0].name).toBe('Indexed');
    expect(isName(cs[1]) && cs[1].name).toBe('DeviceRGB');
    expect(cs[2]).toBe(1); // hival preserved
  });
});
```

If `name` is not already imported in the test file, add `name` to the `../src/types.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/imageredact.test.ts -t inlineImageToStream`
Expected: FAIL — `inlineImageToStream is not a function` (not exported yet).

- [ ] **Step 3: Add the helper and imports to `src/imageredact.ts`**

Change the existing type import line:

```ts
import { PdfDict, PdfObject, PdfStream, PdfName, name, isName, isArray } from './types.js';
```

Append at the end of `src/imageredact.ts`:

```ts
/** Inline-image abbreviated dict keys → full image-XObject keys (PDF §8.9.7). */
const INLINE_KEY: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms',
  F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width',
};
/** Abbreviated colorspace names usable in an inline image's /CS. */
const INLINE_CS: Record<string, string> = {
  G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed',
};

/** Expand an inline colorspace value: a device/indexed name to its full form,
 *  or an indexed array's head (and its base name) recursively. Anything else —
 *  including a bare non-device name (a /Resources colorspace reference) — passes
 *  through unchanged, so it stays unresolvable and the caller degrades. */
function expandInlineCs(v: PdfObject): PdfObject {
  if (isName(v)) return INLINE_CS[v.name] ? name(INLINE_CS[v.name]) : v;
  if (isArray(v) && v.length > 0 && isName(v[0]) && INLINE_CS[(v[0] as PdfName).name]) {
    const out = v.slice();
    out[0] = name(INLINE_CS[(v[0] as PdfName).name]);
    if (out.length > 1 && isName(out[1]) && INLINE_CS[(out[1] as PdfName).name])
      out[1] = name(INLINE_CS[(out[1] as PdfName).name]);
    return out;
  }
  return v;
}

/** Expand an inline image (abbreviated keys/colorspace names) into a synthetic
 *  full-key image XObject stream that the standard decoders accept. Filter names
 *  keep their abbreviations (applyDecodeFilters accepts both). /L and /Length are
 *  dropped (the synthetic stream's length is implicit). */
export function inlineImageToStream(inline: { dict: PdfDict; data: Uint8Array }): PdfStream {
  const dict = new Map<string, PdfObject>();
  for (const [k, v] of inline.dict) {
    if (k === 'L' || k === 'Length') continue;
    const full = INLINE_KEY[k] ?? k;
    dict.set(full, full === 'ColorSpace' ? expandInlineCs(v) : v);
  }
  return { kind: 'stream', dict, raw: inline.data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/imageredact.test.ts -t inlineImageToStream`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/imageredact.ts test/imageredact.test.ts
git commit -m "feat(njs): inlineImageToStream — normalize inline image to full-key stream

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `reencodeRedactedInline` + wire the live `Redact` path (sample-preserving)

**Files:**
- Modify: `src/redact.ts` (add `deflateSync` import; add two helpers; edit `removeRegionContent`)
- Test: `test/redact-image.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `inlineImageToStream` (Task 1); existing `sampleRedactPlan`, `coveredPixelBox`, `blankSamples`, `ImageInfo`, `PixelBox`.
- Produces:
  - `reencodeRedactedInline(doc: Document, op: ContentOp, ctm: Matrix, rects: Rect[]): ContentOp` — a fresh `BI` op with covered pixels blanked; throws `UnsupportedFeatureError` for rotated placement / undecodable codec (RGBA-fallback + transparency handling arrives in Task 3).
  - `reflatedInlineDict(src: PdfDict): PdfDict` — clone an inline dict as FlateDecode with no predictor.

- [ ] **Step 1: Write the failing test**

Add to `test/redact-image.test.ts`. At the top of the file add these imports:

```ts
import { parseContentStream } from '../src/content.js';
import { inlineImageToStream } from '../src/imageredact.js';
```

Add this helper and describe block near the other inline tests:

```ts
// hex-encode bytes for an ASCIIHexDecode (/AHx) inline image data segment.
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Decode the (single) inline image of a reopened page back to samples.
function inlineSamples(doc: Document): { w: number; h: number; s: Uint8Array } {
  const ops = parseContentStream(doc.Pages[0].Contents);
  const bi = ops.find((o) => o.operator === 'BI');
  if (!bi || !bi.inlineImage) throw new Error('no inline image found');
  const stream = inlineImageToStream(bi.inlineImage);
  const info = new ImageInfo(doc, '', stream);
  return { w: info.Width, h: info.Height, s: info.Decode() };
}

describe('partial inline image redaction — sample-preserving', () => {
  it('blacks only the covered columns of a DeviceRGB inline image, in place', () => {
    // 4x4 DeviceRGB, one distinct colour per pixel; placed at device [0,0,100,100].
    const px = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) { px[i * 3] = 10 + i; px[i * 3 + 1] = 100; px[i * 3 + 2] = 200; }
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → columns 0..1

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // stayed inline
    expect(content(reopened)).not.toContain('/XObject');
    const { w, s } = inlineSamples(reopened);
    const at = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]); // covered → black
    expect(at(1, 2)).toEqual([0, 0, 0]);
    expect(at(2, 0)[1]).toBe(100);       // uncovered → original green channel
    expect(at(3, 3)[2]).toBe(200);
  });

  it('clears only the covered bits of a 1-bit DeviceGray inline image', () => {
    // 8x1 DeviceGray, all-white (0xff); redact left half → columns 0..3 cleared.
    const stream = `q 100 0 0 100 0 0 cm BI /W 8 /H 1 /CS /G /BPC 1 /F /AHx ID ff> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const { s } = inlineSamples(reopened);
    expect(s[0]).toBe(0x0f); // MSB-first: cols 0..3 → 0, cols 4..7 → 1
  });

  it('throws for a rotated inline placement', () => {
    const px = new Uint8Array(4 * 4 * 3).fill(120);
    const stream = `q 0 100 -100 0 100 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    expect(() => redactPage(doc, doc.Pages[0], [[0, 0, 50, 50]])).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/redact-image.test.ts -t "sample-preserving"`
Expected: FAIL — the first two cases fail because partial inline still throws `partial inline image redaction is not supported` (rotated case may already "pass" for the wrong reason; that's fine, it turns correct after wiring).

- [ ] **Step 3: Add the `deflateSync` import to `src/redact.ts`**

Add near the other `node:`/local imports at the top of `src/redact.ts`:

```ts
import { deflateSync } from 'node:zlib';
```

Add `inlineImageToStream` to the existing `./imageredact.js` import so that line reads:

```ts
import { coveredPixelBox, blankPixels, encodeRgbaXObject, blankSamples, encodeSamplesXObject, inlineImageToStream, PixelBox } from './imageredact.js';
```

- [ ] **Step 4: Add `reflatedInlineDict` and `reencodeRedactedInline` to `src/redact.ts`**

Add immediately after `reencodeRedactedImage` (before `imageStreamOf`). The RGBA-fallback branch is included now and exercised by Task 3.

```ts
/** Clone an inline image dict for re-encoding as raw FlateDecode: same geometry,
 *  colorspace, bit-depth and /Decode, but drop the original filter, DecodeParms
 *  and length (no predictor), and set /F to /Fl. */
function reflatedInlineDict(src: PdfDict): PdfDict {
  const out = new Map<string, PdfObject>();
  for (const [k, v] of src) {
    if (k === 'F' || k === 'Filter' || k === 'DP' || k === 'DecodeParms' || k === 'L' || k === 'Length') continue;
    out.set(k, v);
  }
  out.set('F', name('Fl'));
  return out;
}

/** Re-encode a partially-covered inline image (`BI…EI`) in place: blank the
 *  pixels under `rects` (device space) and return a fresh `BI` op. The image
 *  stays inline — nothing in /Resources is touched. Sample-preserving when the
 *  codec/colorspace allow; otherwise decodes to RGBA and re-emits DeviceRGB, but
 *  since inline images cannot carry /SMask a non-opaque result throws. Also
 *  throws for rotated placement, undecodable codecs, and image masks (which the
 *  RGBA path resolves to per-pixel alpha). All validation runs before the op is
 *  built, so a throw mutates nothing. */
function reencodeRedactedInline(doc: Document, op: ContentOp, ctm: Matrix, rects: Rect[]): ContentOp {
  const inline = op.inlineImage!;
  const stream = inlineImageToStream(inline);
  const plan = sampleRedactPlan(doc, stream);

  if (plan) {
    let samples: Uint8Array;
    try { samples = new ImageInfo(doc, '', stream).Decode(); }
    catch { throw new UnsupportedFeatureError('inline image codec cannot be decoded for partial redaction'); }
    const wv = doc.resolve(stream.dict.get('Width')), hv = doc.resolve(stream.dict.get('Height'));
    const w = typeof wv === 'number' ? wv : 0, h = typeof hv === 'number' ? hv : 0;
    const boxes: PixelBox[] = [];
    for (const r of rects) { const b = coveredPixelBox(ctm, w, h, r); if (b) boxes.push(b); } // validates rotation
    blankSamples(samples, w, h, plan.nc, plan.bpc, boxes);
    const data = new Uint8Array(deflateSync(Buffer.from(samples)));
    return { operator: 'BI', operands: [], inlineImage: { dict: reflatedInlineDict(inline.dict), data } };
  }

  // Fallback: decode to RGBA, blank, re-emit DeviceRGB. No /SMask allowed inline.
  const img = decodeImageRgba(doc, stream, [0, 0, 0]);
  if (!img) throw new UnsupportedFeatureError('inline image codec cannot be decoded for partial redaction');
  const boxes: PixelBox[] = [];
  for (const r of rects) { const b = coveredPixelBox(ctm, img.w, img.h, r); if (b) boxes.push(b); }
  blankPixels(img, boxes);
  const n = img.w * img.h;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] !== 255)
      throw new UnsupportedFeatureError('inline image with transparency cannot be partially redacted');
    rgb[i * 3] = img.data[i * 4]; rgb[i * 3 + 1] = img.data[i * 4 + 1]; rgb[i * 3 + 2] = img.data[i * 4 + 2];
  }
  const data = new Uint8Array(deflateSync(Buffer.from(rgb)));
  const dict = new Map<string, PdfObject>([
    ['W', img.w], ['H', img.h], ['CS', name('RGB')], ['BPC', 8], ['F', name('Fl')],
  ]);
  return { operator: 'BI', operands: [], inlineImage: { dict, data } };
}
```

- [ ] **Step 5: Wire `removeRegionContent` to route partial inline images**

In `removeRegionContent`, the `image:` visitor currently throws for inline. Replace this block:

```ts
      if (covering.some((r) => contains(r, e.quad))) { scope(e.addr).images.add(e.addr.opIndex); return; }
      if (e.kind === 'inline')
        throw new UnsupportedFeatureError('partial inline image redaction is not supported');
      scope(e.addr).partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
```

with (drop the inline throw — partial inline joins the same `partial` map):

```ts
      if (covering.some((r) => contains(r, e.quad))) { scope(e.addr).images.add(e.addr.opIndex); return; }
      scope(e.addr).partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
```

Then in the rebuild loop of `removeRegionContent`, replace this block:

```ts
      const pi = partial.get(i);
      if (pi) {
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
```

with (branch on inline vs XObject):

```ts
      const pi = partial.get(i);
      if (pi) {
        if (ops[i].inlineImage) { out.push(reencodeRedactedInline(doc, ops[i], pi.ctm, pi.rects)); continue; }
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/redact-image.test.ts -t "sample-preserving"`
Expected: PASS (all three cases).

Run the full redaction suite to confirm no regression:
Run: `npx vitest run test/redact-image.test.ts test/redact.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`UnsupportedFeatureError` may now be unused in `removeRegionContent`'s scope but is still used elsewhere in the file — leave the import.)

- [ ] **Step 8: Commit**

```bash
git add src/redact.ts test/redact-image.test.ts
git commit -m "feat(njs): partial inline image redaction — sample-preserving path

Wire reencodeRedactedInline into the live Redact path (removeRegionContent).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: RGBA fallback + transparency/undecodable scope (behavioral coverage)

**Files:**
- Test: `test/redact-image.test.ts` (add a describe block) — no source changes; exercises the fallback branch already written in Task 2.

**Interfaces:**
- Consumes: `reencodeRedactedInline` (Task 2), `encodeBaselineJpeg` (already imported in the test), `toHex`/`inlineSamples` (Task 2 helpers).

- [ ] **Step 1: Write the failing test**

Add to `test/redact-image.test.ts`:

```ts
describe('partial inline image redaction — RGBA fallback and scope', () => {
  it('blacks covered columns of an opaque DCT inline image via the RGBA fallback', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    // /F [/AHx /DCT]: hex-armour the JPEG so the fixture stays ASCII.
    const stream = `q 100 0 0 100 0 0 cm BI /W ${w} /H ${h} /CS /RGB /BPC 8 /F [/AHx /DCT] ID ${toHex(jpg)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → columns 0..3

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // still inline
    const { w: iw, s } = inlineSamples(reopened); // re-encoded as /Fl /RGB
    const at = (x: number, y: number) => [s[(y * iw + x) * 3], s[(y * iw + x) * 3 + 1], s[(y * iw + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]);                 // covered → black
    expect(at(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(at(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered → preserved (± JPEG)
    expect(Math.abs(at(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('throws for a partially-covered inline image mask (cannot represent inline)', () => {
    // 8x8 /ImageMask, all-ones (every pixel transparent under default /Decode).
    const stream = `q 100 0 0 100 0 0 cm BI /W 8 /H 8 /IM true /BPC 1 /F /AHx ID ${'ff'.repeat(8)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    expect(() => redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
  });

  it('throws for a partially-covered undecodable (truncated DCT) inline image', () => {
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // SOI+EOI only
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F [/AHx /DCT] ID ${toHex(jpg)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    expect(() => redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run tests to verify results**

Run: `npx vitest run test/redact-image.test.ts -t "RGBA fallback and scope"`
Expected: PASS. If the DCT case fails on colour tolerance, widen to `<= 8` (fixture JPEG quantization), not a code change. The two `throws` cases must pass unchanged.

- [ ] **Step 3: Typecheck + full redaction suite**

Run: `npm run typecheck && npx vitest run test/redact-image.test.ts test/redact.test.ts test/imageredact.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/redact-image.test.ts
git commit -m "test(njs): inline redaction RGBA fallback, image-mask/undecodable throws

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Route partial inline images in the standalone `removeImagesUnder`

**Files:**
- Modify: `src/redact.ts` (edit `removeImagesUnder`)
- Test: `test/redact-image.test.ts` (extend the `removeImagesUnder — inline images` describe)

**Interfaces:**
- Consumes: `reencodeRedactedInline` (Task 2), `inlineSamples`/`toHex` (Task 2 helpers).

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('removeImagesUnder — inline images', ...)` block in `test/redact-image.test.ts`:

```ts
  it('partially redacts an inline image, keeping the rest and staying inline', () => {
    const px = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) { px[i * 3] = 10 + i; px[i * 3 + 1] = 100; px[i * 3 + 2] = 200; }
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[0, 0, 50, 100]], ec); // left half
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // still inline
    const { w, s } = inlineSamples(reopened);
    const at = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]); // covered → black
    expect(at(3, 3)[2]).toBe(200);       // uncovered → preserved
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/redact-image.test.ts -t "partially redacts an inline image"`
Expected: FAIL — `removeImagesUnder` still throws `partial inline image redaction is not supported`.

- [ ] **Step 3: Wire `removeImagesUnder`**

In `removeImagesUnder`, replace this block in the `image:` visitor:

```ts
      if (covering.some((r) => contains(r, e.quad))) { s.remove.add(e.addr.opIndex); return; }
      if (e.kind === 'inline')
        throw new UnsupportedFeatureError('partial inline image redaction is not supported');
      s.partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
```

with:

```ts
      if (covering.some((r) => contains(r, e.quad))) { s.remove.add(e.addr.opIndex); return; }
      s.partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
```

Then in the rebuild loop of `removeImagesUnder`, replace:

```ts
      const pi = partial.get(i);
      if (pi) {
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
```

with:

```ts
      const pi = partial.get(i);
      if (pi) {
        if (ops[i].inlineImage) { out.push(reencodeRedactedInline(doc, ops[i], pi.ctm, pi.rects)); continue; }
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/redact-image.test.ts -t "partially redacts an inline image"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/redact.ts test/redact-image.test.ts
git commit -m "feat(njs): route partial inline images in removeImagesUnder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs + follow-up bead + close

**Files:**
- Modify: `README.md` (redaction section)

- [ ] **Step 1: Update the README redaction note**

Find the redaction paragraph in `README.md` (search for "partial" / "redact" — the note that says partial image redaction re-encodes image XObjects). Extend it to state that partial redaction also covers **inline images** (`BI…EI`), re-encoded in place with the same colorspace/codec support and limits as image XObjects, except that transparency and image masks cannot be represented inline and therefore throw `UnsupportedFeatureError`. Match the surrounding wording/format.

- [ ] **Step 2: Verify the README claim against behavior**

Run: `npm test`
Expected: all green — the README's stated limits match the tests in Tasks 2–4.

- [ ] **Step 3: Commit the docs**

```bash
git add README.md
git commit -m "docs(njs): note partial inline image redaction support

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: File the ImageMask follow-up bead**

```bash
bd create "Partial image redaction: inline image masks (BI /IM true)" \
  -t feature -p 3 \
  -d "Partial redaction of an inline /ImageMask stencil throws (it decodes to per-pixel alpha, which cannot be represented inline as /SMask). Blank the covered stencil bits in place and re-emit the mask as an inline ImageMask (FlateDecode), so only the covered pixels are cleared." \
  --discovered-from aspose-pdf-foss-for-ts-357
```

- [ ] **Step 5: Close 357**

```bash
bd close aspose-pdf-foss-for-ts-357
```

---

## Self-Review

**Spec coverage:**
- `inlineImageToStream` normalization (keys + device/indexed colorspace, drop /L) → Task 1.
- `reencodeRedactedInline` sample-preserving path + original-dict clone (`reflatedInlineDict`) → Task 2.
- RGBA fallback + `/SMask`-illegal transparency throw → Task 2 (code) / Task 3 (coverage).
- Wire-up in both `removeRegionContent` and `removeImagesUnder` → Task 2 / Task 4.
- Rotated / undecodable / image-mask / transparency throws → Tasks 2–3.
- Full-coverage drop unchanged → covered by existing suite re-run in Tasks 2/4.
- Tests for sample RGB, 1-bit gray, DCT fallback, throws, and `inlineImageToStream` unit → Tasks 1–4.
- README redaction note → Task 5. Follow-up ImageMask bead → Task 5.

**Placeholder scan:** none — every code/test step shows full content; the only prose-only step (README) points at an exact section and states the exact claim.

**Type consistency:** `reencodeRedactedInline(doc, op, ctm, rects)` and `reflatedInlineDict(src)` and `inlineImageToStream(inline)` signatures are used identically across Tasks 1, 2, and 4. `sampleRedactPlan` returns `{ nc, bpc }` (existing), consumed via `plan.nc`/`plan.bpc`. `ImageInfo`/`coveredPixelBox`/`blankSamples`/`blankPixels`/`decodeImageRgba` used with their existing signatures.
