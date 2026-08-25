# SVG `<image>` embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddSVGObject` embeds an `<image>` whose `href` is a `data:` URI carrying a PNG or JPEG, instead of reporting `image` in `skipped`.

**Architecture:** A new pure module `svgimage.ts` decodes the data URI (via `imageembed.ts`'s existing `buildImageXObject`) and computes the placement; `svgdraw.ts` gains an `image` case plus an `SvgImageSink` that `svgembed.ts` implements, because an Image XObject is a stream and only the embedder may allocate. The align/`meet`/`slice` core of `placementMatrix` is extracted as a pure `fitBox` so root placement and `<image>` share one implementation.

**Tech Stack:** TypeScript (strict, ESM, NodeNext — import specifiers carry `.js`), vitest. Zero runtime dependencies: `node:` built-ins only.

Design spec: `docs/superpowers/specs/2026-07-30-svg-image-design.md`.
Issue: `aspose-pdf-foss-for-ts-1gg0.9`.

## Global Constraints

- **Zero runtime deps.** Only `node:` built-ins. `Buffer.from(s, 'base64')` is the established base64 idiom here (`srgb.ts`, `std14fonts.ts`, `xfdfannot.ts`).
- **ESM + NodeNext:** every relative import ends in `.js` (e.g. `from './svgtransform.js'`).
- **`svgdraw.ts` allocates nothing.** It imports no `Document`. Anything needing an indirect object goes through a sink implemented in `svgembed.ts`. A `type`-only import of `BuiltImage` is fine (erased at runtime).
- **The walker is y-down.** Content is emitted in raw viewBox units with y pointing down; the single flip lives in `placementMatrix`. An image therefore carries a local `-h` in its own `cm`.
- **Failures are skips, never throws.** `addSvgObject`'s guarantee stands: validation before allocation, and a rejected call leaves the document byte-identical. Every image failure adds `'image'` to `skipped` and draws nothing.
- **Run before every commit:** `npm run typecheck` and the touched test file. Run the full `npm test` at the end of Task 4 onward.
- **Commit style:** conventional prefix + the issue id, e.g. `feat(svg): … (1gg0.9)`. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Extract `fitBox` from `placementMatrix`

Pure refactor plus a new export. No behaviour change: the existing SVG suite is the regression guard, and it must stay green with zero edits.

**Files:**
- Modify: `src/svgtransform.ts:89-121` (`placementMatrix`)
- Test: `test/svg-transform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface BoxFit { sx: number; sy: number; tx: number; ty: number }
  export function fitBox(
    src: { w: number; h: number }, dest: { w: number; h: number },
    par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
  ): BoxFit;
  ```
  `tx`/`ty` are offsets from the destination's top-left, with `ty` measured **downward** — the walker's frame, and already what `placementMatrix` computes internally.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-transform.test.ts`:

```ts
describe('fitBox', () => {
  const src = { w: 200, h: 100 };            // 2:1
  const dest = { w: 100, h: 100 };           // 1:1

  it('meet fits inside and centres on the short axis', () => {
    expect(fitBox(src, dest, undefined)).toEqual({ sx: 0.5, sy: 0.5, tx: 0, ty: 25 });
  });

  it('slice covers and centres the overflow', () => {
    expect(fitBox(src, dest, 'xMidYMid slice')).toEqual({ sx: 1, sy: 1, tx: -50, ty: 0 });
  });

  it('none stretches each axis independently with no offset', () => {
    expect(fitBox(src, dest, 'none')).toEqual({ sx: 0.5, sy: 1, tx: 0, ty: 0 });
  });

  it('aligns to the min and max edges', () => {
    expect(fitBox(src, dest, 'xMinYMin meet').ty).toBe(0);
    expect(fitBox(src, dest, 'xMinYMax meet').ty).toBe(50);
  });

  it('lets an explicit fit override the attribute', () => {
    expect(fitBox(src, dest, 'xMinYMin slice', 'meet'))
      .toEqual({ sx: 0.5, sy: 0.5, tx: 0, ty: 25 });
    expect(fitBox(src, dest, 'xMidYMid meet', 'fill'))
      .toEqual({ sx: 0.5, sy: 1, tx: 0, ty: 0 });
  });

  it('honours the defer keyword by reading the align that follows it', () => {
    expect(fitBox(src, dest, 'defer xMinYMax meet').ty).toBe(50);
  });
});
```

Add `fitBox` to that file's existing import from `../src/svgtransform.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-transform.test.ts`
Expected: FAIL — TypeScript/runtime error that `fitBox` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/svgtransform.ts`, insert before `placementMatrix` and rewrite that function's body:

```ts
/** How a source box maps onto a destination box under a preserveAspectRatio.
 *  `tx`/`ty` are offsets from the destination's top-left, `ty` measured DOWNWARD
 *  — the frame svgdraw.ts emits in, and the one placementMatrix composes its
 *  flip with. */
export interface BoxFit { sx: number; sy: number; tx: number; ty: number }

/** Fit `src` into `dest` under `par` (a preserveAspectRatio value) unless `fit`
 *  overrides it. Shared by the root placement below and <image> in svgimage.ts,
 *  so the two cannot drift; it carries no flip, which is placementMatrix's alone. */
export function fitBox(
  src: { w: number; h: number }, dest: { w: number; h: number },
  par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
): BoxFit {
  let align = 'xMidYMid';
  let slice = false;
  if (par) {
    const t = par.trim().split(/\s+/);
    const a = t[0] === 'defer' ? t[1] : t[0];
    if (a) align = a;
    slice = t[t.length - 1] === 'slice';
  }
  if (fit === 'fill') align = 'none';
  else if (fit === 'meet') { align = 'xMidYMid'; slice = false; }
  else if (fit === 'slice') { align = 'xMidYMid'; slice = true; }

  let sx = dest.w / src.w, sy = dest.h / src.h;
  if (align !== 'none') {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s; sy = s;
  }
  const tx = align === 'none' ? 0 : frac(align, 'x') * (dest.w - src.w * sx);
  const ty = align === 'none' ? 0 : frac(align, 'Y') * (dest.h - src.h * sy);
  return { sx, sy, tx, ty };
}

/** Map `vb` onto `rect` = [x, y, w, h], honouring `par` (a preserveAspectRatio
 *  value) unless `fit` overrides it, and flipping the y axis on the way.
 *
 *  Content is emitted in raw viewBox units with y pointing DOWN; this matrix is
 *  the only place that becomes PDF's y-up. */
export function placementMatrix(
  vb: ViewBox, rect: [number, number, number, number],
  par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
): Matrix {
  const [rx, ry, rw, rh] = rect;
  const { sx, sy, tx, ty } = fitBox({ w: vb.w, h: vb.h }, { w: rw, h: rh }, par, fit);
  // ty is measured DOWNWARD from the rect's top edge, which is what lets it
  // compose with the flip below.
  return [sx, 0, 0, -sy, rx + tx - vb.minX * sx, ry + rh - ty + vb.minY * sy];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-transform.test.ts test/svg-golden.test.ts test/svgrender.test.ts && npm run typecheck`
Expected: PASS, all of them. The golden and render suites are the proof the extraction changed no output.

- [ ] **Step 5: Commit**

```bash
git add src/svgtransform.ts test/svg-transform.test.ts
git commit -m "refactor(svg): extract fitBox from placementMatrix (1gg0.9)

<image> needs the same align/meet/slice math in the walker's y-down frame.
fitBox is that math with no flip; placementMatrix keeps sole ownership of
the flip, so the two placements cannot drift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `svgimage.ts` — decode a `data:` URI to an Image XObject

**Files:**
- Create: `src/svgimage.ts`
- Test: `test/svg-image.test.ts` (new)

**Interfaces:**
- Consumes: `buildImageXObject(data: Uint8Array, format?: 'jpeg' | 'png') => BuiltImage` and `interface BuiltImage { stream: PdfStream; smask?: PdfStream }` from `src/imageembed.ts` (already exported).
- Produces:
  ```ts
  export function dataUriBytes(href: string): Uint8Array | undefined;
  export function decodeImage(href: string): BuiltImage | undefined;
  export function imageSize(built: BuiltImage): { w: number; h: number };
  ```

- [ ] **Step 1: Write the failing test**

Create `test/svg-image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dataUriBytes, decodeImage, imageSize } from '../src/svgimage.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

/** A 2x2 RGB PNG: red, green / blue, yellow. Four distinct hues, none of them
 *  white, so the render test in Task 5 can tell the image apart from the page. */
const PNG = () => buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0);

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

describe('dataUriBytes', () => {
  it('decodes a base64 payload', () => {
    const bytes = PNG();
    expect(dataUriBytes(`data:image/png;base64,${b64(bytes)}`)).toEqual(bytes);
  });

  it('ignores whitespace inside a base64 payload', () => {
    // Pretty-printers wrap long attribute values, so the newlines are real.
    const bytes = PNG();
    const wrapped = b64(bytes).replace(/(.{8})/g, '$1\n  ');
    expect(dataUriBytes(`data:image/png;base64,${wrapped}`)).toEqual(bytes);
  });

  it('decodes a percent-encoded payload byte-wise, not as UTF-8', () => {
    // %89 is not valid UTF-8; decodeURIComponent would throw on it.
    expect(dataUriBytes('data:image/png,%89PNG%0D%0A'))
      .toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  });

  it('accepts a URI with no media type', () => {
    expect(dataUriBytes('data:,AB')).toEqual(new Uint8Array([0x41, 0x42]));
  });

  it('rejects a non-data scheme', () => {
    expect(dataUriBytes('photo.png')).toBeUndefined();
    expect(dataUriBytes('https://example.com/a.png')).toBeUndefined();
  });

  it('rejects a data URI with no comma', () => {
    expect(dataUriBytes('data:image/png;base64')).toBeUndefined();
  });

  it('rejects a malformed percent escape', () => {
    expect(dataUriBytes('data:,%zz')).toBeUndefined();
  });
});

describe('decodeImage', () => {
  it('builds an Image XObject from a PNG data URI', () => {
    const built = decodeImage(`data:image/png;base64,${b64(PNG())}`)!;
    expect(built).toBeDefined();
    expect(imageSize(built)).toEqual({ w: 2, h: 2 });
  });

  it('sniffs the bytes and ignores a contradicting media type', () => {
    // Data URIs in the wild carry wrong types; the bytes win.
    const built = decodeImage(`data:image/gif;base64,${b64(PNG())}`)!;
    expect(imageSize(built)).toEqual({ w: 2, h: 2 });
  });

  it('returns undefined for an SVG payload rather than recursing', () => {
    const svg = b64(new TextEncoder().encode('<svg><rect width="1" height="1"/></svg>'));
    expect(decodeImage(`data:image/svg+xml;base64,${svg}`)).toBeUndefined();
  });

  it('returns undefined for corrupt bytes instead of throwing', () => {
    // buildImageXObject throws UnsupportedFeatureError here; one bad icon must
    // not abort a whole placement.
    expect(decodeImage('data:image/png;base64,AAAAAAAA')).toBeUndefined();
    expect(decodeImage('data:,')).toBeUndefined();
  });

  it('returns undefined for a truncated PNG that parses no further', () => {
    const bytes = PNG().subarray(0, 20);
    expect(decodeImage(`data:image/png;base64,${b64(bytes)}`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-image.test.ts`
Expected: FAIL — cannot resolve `../src/svgimage.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/svgimage.ts`:

```ts
// SVG <image> -> PDF Image XObject (issue 1gg0.9). Pure: decodes the data: URI
// and computes the placement, allocating nothing. The XObject is a stream, so
// svgdraw.ts hands the built image to a sink svgembed.ts implements — the same
// division of labour tiling patterns and fonts already use.
import { buildImageXObject, type BuiltImage } from './imageembed.js';

/** The payload of a `data:` URI, or undefined for anything else — another
 *  scheme, or a URI with no comma. Both base64 and percent-encoded bodies are
 *  handled; the media type is never consulted, since data URIs in the wild carry
 *  wrong ones and buildImageXObject sniffs the bytes anyway. */
export function dataUriBytes(href: string): Uint8Array | undefined {
  const s = href.trim();
  if (!/^data:/i.test(s)) return undefined;
  const comma = s.indexOf(',');
  if (comma < 0) return undefined;
  const meta = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  // Buffer ignores whitespace, which a pretty-printer will have wrapped into a
  // long attribute value.
  if (/;\s*base64\s*$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));

  // Percent-decoded BYTE-wise. decodeURIComponent would treat the escapes as
  // UTF-8 and throw on the very first high byte of a PNG signature.
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c !== '%') { out.push(c.charCodeAt(0) & 0xff); continue; }
    const hex = payload.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
    out.push(parseInt(hex, 16));
    i += 2;
  }
  return new Uint8Array(out);
}

/** Decode an `<image>` href into an Image XObject, or undefined when it cannot
 *  be embedded: a non-data scheme, a malformed URI, or bytes that are not PNG or
 *  JPEG (which is also how an image/svg+xml payload is declined — nesting an SVG
 *  is a separate feature).
 *
 *  buildImageXObject THROWS on unrecognized or corrupt bytes, which is right for
 *  page.AddImage and wrong here: one bad icon in a 200-element illustration must
 *  not abort the whole placement. The catch is deliberately broad — the only
 *  distinction a caller can act on is "this image did not render". */
export function decodeImage(href: string): BuiltImage | undefined {
  const bytes = dataUriBytes(href);
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    return buildImageXObject(bytes);
  } catch {
    return undefined;
  }
}

/** The image's intrinsic pixel size, off the XObject dict the build produced. */
export function imageSize(built: BuiltImage): { w: number; h: number } {
  const w = built.stream.dict.get('Width');
  const h = built.stream.dict.get('Height');
  return {
    w: typeof w === 'number' ? w : 0,
    h: typeof h === 'number' ? h : 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-image.test.ts && npm run typecheck`
Expected: PASS (16 assertions across 11 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/svgimage.ts test/svg-image.test.ts
git commit -m "feat(svg): decode an <image> data: URI to an Image XObject (1gg0.9)

Pure module, no allocation. buildImageXObject throws on bad bytes, which is
right for AddImage and wrong inside an SVG walk, so decodeImage converts every
failure to undefined for the walker to report. Percent decoding is byte-wise:
decodeURIComponent reads escapes as UTF-8 and throws on a PNG signature.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `svgimage.ts` — the placement geometry

**Files:**
- Modify: `src/svgimage.ts`
- Test: `test/svg-image.test.ts`

**Interfaces:**
- Consumes: `fitBox` / `BoxFit` from Task 1; `imageSize` from Task 2; `Matrix` from `src/text.js`; `SegBBox` from `src/svgpath.js` (`{ x, y, w, h }`).
- Produces:
  ```ts
  export interface ImagePlacement {
    /** The `cm` for the image's unit square, in the walker's y-down space. */
    cm: Matrix;
    /** The fitted box in that space, for the pattern-overflow ink union. */
    box: SegBBox;
    /** The element rect to clip to, present only when the fit overflows it. */
    clip?: [number, number, number, number];
  }
  export function imagePlacement(
    attrs: Map<string, string>, iw: number, ih: number,
  ): ImagePlacement | null;
  ```
  `null` means "draw nothing, report nothing" — a zero or negative `width`/`height`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-image.test.ts` (and add `imagePlacement` to the import from `../src/svgimage.js`):

```ts
describe('imagePlacement', () => {
  const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

  it('flips the unit square so the image lands upright in y-down space', () => {
    // A 10x10 box at (2, 3): the unit square's bottom edge goes to y = 13 and
    // its top edge to y = 3, which is the second flip cancelling the placement
    // one. Emit +h and the image renders mirrored.
    const p = imagePlacement(attrs({ x: '2', y: '3', width: '10', height: '10' }), 20, 20)!;
    expect(p.cm).toEqual([10, 0, 0, -10, 2, 13]);
    expect(p.box).toEqual({ x: 2, y: 3, w: 10, h: 10 });
    expect(p.clip).toBeUndefined();
  });

  it('defaults x and y to 0', () => {
    const p = imagePlacement(attrs({ width: '4', height: '4' }), 4, 4)!;
    expect(p.cm).toEqual([4, 0, 0, -4, 0, 4]);
  });

  it('letterboxes under the default meet fit', () => {
    // A 2:1 image in a 1:1 box: scaled to 10 wide, 5 tall, centred vertically.
    const p = imagePlacement(attrs({ width: '10', height: '10' }), 20, 10)!;
    expect(p.cm).toEqual([10, 0, 0, -5, 0, 7.5]);
    expect(p.box).toEqual({ x: 0, y: 2.5, w: 10, h: 5 });
    expect(p.clip).toBeUndefined();
  });

  it('stretches under preserveAspectRatio none', () => {
    const p = imagePlacement(
      attrs({ width: '10', height: '10', preserveAspectRatio: 'none' }), 20, 10)!;
    expect(p.cm).toEqual([10, 0, 0, -10, 0, 10]);
  });

  it('clips to the element rect under slice', () => {
    // slice covers the box, so the fitted image overflows it and must be clipped.
    const p = imagePlacement(
      attrs({ x: '1', y: '1', width: '10', height: '10',
              preserveAspectRatio: 'xMidYMid slice' }), 20, 10)!;
    expect(p.box.w).toBeCloseTo(20);
    expect(p.box.h).toBeCloseTo(10);
    expect(p.clip).toEqual([1, 1, 10, 10]);
  });

  it('clips under a slice that aligns to the min edge, where both offsets are 0', () => {
    // The overflow test must be a size comparison: xMinYMin leaves tx = ty = 0
    // while the image still spills off the right edge.
    const p = imagePlacement(
      attrs({ width: '10', height: '10', preserveAspectRatio: 'xMinYMin slice' }), 20, 10)!;
    expect(p.clip).toEqual([0, 0, 10, 10]);
  });

  it('uses the intrinsic pixel size when both dimensions are absent', () => {
    const p = imagePlacement(attrs({ x: '5', y: '5' }), 8, 4)!;
    expect(p.cm).toEqual([8, 0, 0, -4, 5, 9]);
  });

  it('derives the missing dimension from the intrinsic aspect ratio', () => {
    expect(imagePlacement(attrs({ width: '40' }), 20, 10)!.cm).toEqual([40, 0, 0, -20, 0, 20]);
    expect(imagePlacement(attrs({ height: '20' }), 20, 10)!.cm).toEqual([40, 0, 0, -20, 0, 20]);
  });

  it('draws nothing for a zero or negative dimension', () => {
    expect(imagePlacement(attrs({ width: '0', height: '10' }), 4, 4)).toBeNull();
    expect(imagePlacement(attrs({ width: '10', height: '-1' }), 4, 4)).toBeNull();
  });

  it('draws nothing for a degenerate intrinsic size', () => {
    expect(imagePlacement(attrs({ width: '10', height: '10' }), 0, 0)).toBeNull();
  });

  it('reads a percentage as its bare number, as every length in this stack does', () => {
    const p = imagePlacement(attrs({ width: '50%', height: '50%' }), 50, 50)!;
    expect(p.cm).toEqual([50, 0, 0, -50, 0, 50]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-image.test.ts`
Expected: FAIL — `imagePlacement` is not exported from `svgimage.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/svgimage.ts`, and extend its imports:

```ts
import type { SegBBox } from './svgpath.js';
import { fitBox } from './svgtransform.js';
import type { Matrix } from './text.js';
```

```ts
/** Where one <image> lands, in the walker's y-down space. */
export interface ImagePlacement {
  /** The `cm` for the image's unit square. */
  cm: Matrix;
  /** The fitted box, for the pattern-overflow ink union. */
  box: SegBBox;
  /** The element rect to clip to. Present only when the fit overflows it, which
   *  only a `slice` can do. */
  clip?: [number, number, number, number];
}

/** One length attribute, or NaN when absent or unparseable. A percentage is read
 *  as its bare number, consistent with every other length in this stack. */
function len(attrs: Map<string, string>, k: string): number {
  const v = attrs.get(k);
  if (v === undefined) return NaN;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

/** Resolve an <image>'s rect and fit against an intrinsic size of `iw` x `ih`.
 *  Returns null when nothing should be drawn: SVG 1.1 §5.6 makes a zero
 *  `width`/`height` a deliberate no-render, so it is not a reported loss.
 *
 *  An absent dimension takes the intrinsic size (SVG 2 / browser behaviour);
 *  when only one is absent the other supplies it through the intrinsic aspect
 *  ratio, which is what keeps a one-dimension author from distorting the image. */
export function imagePlacement(
  attrs: Map<string, string>, iw: number, ih: number,
): ImagePlacement | null {
  if (!(iw > 0) || !(ih > 0)) return null;
  const x = Number.isNaN(len(attrs, 'x')) ? 0 : len(attrs, 'x');
  const y = Number.isNaN(len(attrs, 'y')) ? 0 : len(attrs, 'y');
  let w = len(attrs, 'width');
  let h = len(attrs, 'height');
  if (Number.isNaN(w) && Number.isNaN(h)) { w = iw; h = ih; }
  else if (Number.isNaN(w)) w = (h * iw) / ih;
  else if (Number.isNaN(h)) h = (w * ih) / iw;
  if (!(w > 0) || !(h > 0)) return null;

  const f = fitBox({ w: iw, h: ih }, { w, h }, attrs.get('preserveAspectRatio'));
  const bw = iw * f.sx, bh = ih * f.sy;
  const bx = x + f.tx, by = y + f.ty;
  // A PDF image fills the unit square with its first row at v = 1, and this
  // space is y-DOWN, so the local -bh is the flip that cancels the one in
  // placementMatrix. Emitting +bh mirrors the image vertically.
  const cm: Matrix = [bw, 0, 0, -bh, bx, by + bh];
  const box: SegBBox = { x: bx, y: by, w: bw, h: bh };
  // A size comparison, not an offset one: xMinYMin slice leaves tx = ty = 0 and
  // still spills off the far edges.
  const overflows = bw - w > 1e-9 || bh - h > 1e-9;
  return overflows ? { cm, box, clip: [x, y, w, h] } : { cm, box };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-image.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/svgimage.ts test/svg-image.test.ts
git commit -m "feat(svg): resolve <image> geometry and preserveAspectRatio (1gg0.9)

Intrinsic sizing (both dimensions absent, or one derived from the other's
aspect ratio), the nine align keywords via fitBox, and the local -h flip that
cancels placementMatrix's. The slice clip is decided by comparing sizes, not
offsets: xMinYMin slice leaves both offsets at 0 and still overflows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire `<image>` into the walker and the embedder

**Files:**
- Modify: `src/svgdraw.ts` — `STRUCTURAL` (line ~56), `Emitter` (lines ~142-249), `buildResources` (~572), `walk` (~500-550), `drawSvg` + `__ctmProbe` signatures (~590, ~610)
- Modify: `src/svgembed.ts:141` (the `drawSvg` call) plus a new `imageSink`
- Modify: `test/svg-draw.test.ts:9-15, 278, 650` (the three `drawSvg`/`__ctmProbe` call sites)
- Test: `test/svg-embed-image.test.ts` (new)

**Interfaces:**
- Consumes: `decodeImage`, `imageSize`, `imagePlacement` (Tasks 2-3); `BuiltImage` from `src/imageembed.js`.
- Produces:
  ```ts
  // src/svgdraw.ts
  export interface SvgImageSink { image(built: BuiltImage): PdfObject }
  export function drawSvg(
    root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
    tiles: SvgTileSink, images: SvgImageSink,
  ): DrawResult;
  export function __ctmProbe(
    root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
    tiles: SvgTileSink, images: SvgImageSink,
  ): Matrix[];
  ```
  The new parameter is **required**, not optional: an optional sink would give the walker two behaviours and let a test silently exercise the wrong one. There are only four call sites.

- [ ] **Step 1: Write the failing test**

Create `test/svg-embed-image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { isDict, isStream, isRef, type PdfDict } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A 2x2 RGB PNG (red, green / blue, yellow) as a base64 data URI. */
const DATA_URI = `data:image/png;base64,${Buffer.from(buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0)).toString('base64')}`;

/** Place `src` on a 200x200 page and return the form XObject plus the result. */
function place(src: string) {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
  const page = doc.Pages[0];
  const skipped = page.AddSVGObject(enc(src), [0, 0, 200, 200], { fit: 'fill' }).skipped;
  // The form is the single /Fm* entry the placement just registered.
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no page resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('no page /XObject');
  const formRef = [...xo].find(([k]) => k.startsWith('Fm'))![1];
  const form = doc.resolve(formRef);
  if (!isStream(form)) throw new Error('form is not a stream');
  const formRes = doc.resolve(form.dict.get('Resources')) as PdfDict;
  return {
    doc, skipped, formRes,
    content: new TextDecoder('latin1').decode(form.raw),
    // NB: doc.resolve(undefined) returns null, so an absent /XObject reads as
    // null rather than undefined.
    xobjects: doc.resolve(formRes.get('XObject')),
  };
}

const IMG = (attrs: string) =>
  `<svg viewBox="0 0 200 200"><image ${attrs} href="${DATA_URI}"/></svg>`;

describe('AddSVGObject — <image>', () => {
  it('embeds a data: URI as an Image XObject and draws it', () => {
    const { skipped, content, xobjects } = place(IMG('x="10" y="20" width="40" height="40"'));
    expect(skipped).toEqual([]);
    expect(isDict(xobjects)).toBe(true);
    const entries = [...(xobjects as PdfDict)];
    expect(entries).toHaveLength(1);
    const [key, val] = entries[0];
    expect(key).toBe('Im0');
    expect(isRef(val)).toBe(true);
    expect(content).toContain('/Im0 Do');
    // A 2x2 image in a 40x40 box: scale 40, and the y-down flip puts the unit
    // square's origin at the box bottom (20 + 40).
    expect(content).toContain('40 0 0 -40 10 60 cm');
  });

  it('names image in skipped for an href it cannot embed, drawing nothing', () => {
    for (const href of ['photo.png', 'https://example.com/a.png', '']) {
      const { skipped, content, xobjects } =
        place(`<svg viewBox="0 0 200 200"><image width="10" height="10" href="${href}"/></svg>`);
      expect(skipped).toEqual(['image']);
      expect(content).not.toContain(' Do');
      expect(xobjects).toBeNull();
    }
  });

  it('embeds one XObject for two elements sharing an href', () => {
    const { content, xobjects } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="10" height="10" href="${DATA_URI}"/>` +
      `<image x="20" width="10" height="10" href="${DATA_URI}"/></svg>`);
    const entries = [...(xobjects as PdfDict)];
    expect(entries).toHaveLength(1);
    // Both draws must name the SAME key: a per-element key that happened to
    // collide would satisfy a length check alone.
    expect(content.match(/\/Im0 Do/g)).toHaveLength(2);
  });

  it('clips to the element rect under slice', () => {
    const { content } = place(
      IMG('width="40" height="20" preserveAspectRatio="xMidYMid slice"'));
    expect(content).toContain('0 0 40 20 re');
    expect(content).toContain('W n');
  });

  it('applies group opacity through /ExtGState', () => {
    const { content } = place(
      `<svg viewBox="0 0 200 200"><g opacity="0.5">` +
      `<image width="10" height="10" href="${DATA_URI}"/></g></svg>`);
    expect(content).toMatch(/\/GS\d+ gs/);
  });

  it('draws nothing and allocates nothing for an image inside defs', () => {
    const { content, xobjects } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<image width="10" height="10" href="${DATA_URI}"/></defs></svg>`);
    expect(content).not.toContain(' Do');
    expect(xobjects).toBeNull();
  });

  it('registers an image used only in a pattern tile in the TILE resources', () => {
    // A tile's content stream cannot see the form's /Resources, so the image
    // must land in the tile's own dictionary and NOT in the form's.
    const { doc, formRes, xobjects } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">` +
      `<image width="20" height="20" href="${DATA_URI}"/></pattern></defs>` +
      `<rect width="200" height="200" fill="url(#p)"/></svg>`);
    expect(xobjects).toBeNull();                    // not in the form
    const patterns = doc.resolve(formRes.get('Pattern'));
    if (!isDict(patterns)) throw new Error('no /Pattern in the form resources');
    const tile = doc.resolve([...patterns][0][1]);
    if (!isStream(tile)) throw new Error('a tiling pattern must be a stream');
    const tileRes = doc.resolve(tile.dict.get('Resources'));
    if (!isDict(tileRes)) throw new Error('no tile /Resources');
    const tileXo = doc.resolve(tileRes.get('XObject'));
    if (!isDict(tileXo)) throw new Error('no tile /XObject');
    expect([...tileXo].map(([k]) => k)).toEqual(['Im0']);
    expect(new TextDecoder('latin1').decode(tile.raw)).toContain('/Im0 Do');
  });

  it('survives a Save/Open round trip', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
    doc.Pages[0].AddSVGObject(enc(IMG('width="50" height="50"')), [0, 0, 200, 200]);
    const rt = Document.Open(doc.Save());
    expect(rt.Pages.length).toBe(1);
  });
});
```

`isStream` comes from `../src/types.js` alongside `isDict`/`isRef` — add it to
that import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: FAIL — `skipped` is `['image']` where `[]` is expected, and no `/Im0 Do` in the content.

- [ ] **Step 3: Write minimal implementation**

**3a.** `src/svgdraw.ts` — imports and the sink:

```ts
import type { BuiltImage } from './imageembed.js';
import { decodeImage, imagePlacement, imageSize } from './svgimage.js';
```

```ts
/** Allocates an Image XObject (and its /SMask) and returns its reference.
 *  svgembed.ts implements it, because an Image XObject IS a stream and streams
 *  must be indirect objects. Mirrors SvgTileSink, for the same reason. */
export interface SvgImageSink {
  image(built: BuiltImage): PdfObject;
}
```

**3b.** Add `'image'` to `STRUCTURAL` — it is handled here, so the
`!STRUCTURAL.has(...)` guard at the top of `walk` must not report it:

```ts
const STRUCTURAL = new Set([
  'svg', 'g', 'defs', 'use', 'symbol', 'text', 'image', ...DEFINITION,
]);
```

**3c.** `Emitter` — three members, one method, and `child()`:

```ts
  /** Image XObjects THIS stream referenced: key -> ref. Per-stream, like `pat`. */
  readonly xobj: PdfDict = new Map<string, PdfObject>();
  /** href -> the ref and intrinsic size, walk-wide so a repeated data: URI is
   *  embedded once. Shared with every child: /Resources are per-stream but refs
   *  are document-wide. Keyed by href text, so two spellings of identical bytes
   *  still embed twice — Optimize's dedup pass is what collapses those. */
  images = new Map<string, { ref: PdfObject; w: number; h: number }>();
  /** Supplied by svgembed.ts: only it may allocate an image stream. */
  imageSink!: SvgImageSink;
```

```ts
  /** Register `r` in THIS stream's /XObject; returns its resource key. Identity
   *  comparison is exact because `images` hands back the same ref object. */
  xobjKey(r: PdfObject): string {
    for (const [k, v] of this.xobj) if (v === r) return k;
    const key = `Im${this.xobj.size}`;
    this.xobj.set(key, r);
    return key;
  }
```

In `child()`, share the sink and the cache (next to `c.tiles = this.tiles;`):

```ts
    c.imageSink = this.imageSink;
    c.images = this.images;
```

**3d.** `buildResources` — add, after the `Pattern` line:

```ts
  if (e.xobj.size > 0) res.set('XObject', e.xobj);
```

**3e.** The emitter for one `<image>`, above `walk`:

```ts
/** Emit one <image>. Reports `image` only when ink that should exist does not:
 *  an href we cannot embed. A zero-area rect draws nothing and is NOT reported —
 *  SVG 1.1 §5.6 makes that the author's choice. */
function drawImage(e: Emitter, n: XmlNode, p: Paint, ctm: Matrix): void {
  const href = (n.attrs.get('href') ?? n.attrs.get('xlink:href') ?? '').trim();
  let hit = href === '' ? undefined : e.images.get(href);
  if (hit === undefined) {
    const built = href === '' ? undefined : decodeImage(href);
    if (built === undefined) { e.skipped.add('image'); return; }
    const { w, h } = imageSize(built);
    hit = { ref: e.imageSink.image(built), w, h };
    e.images.set(href, hit);
  }
  const pl = imagePlacement(n.attrs, hit.w, hit.h);
  if (pl === null) return;
  const key = e.xobjKey(hit.ref);
  e.out.push('q');
  if (pl.clip) {
    const [cx, cy, cw, ch] = pl.clip;
    e.out.push(`${num(cx)} ${num(cy)} ${num(cw)} ${num(ch)} re`);
    e.out.push('W n');
  }
  // Group opacity reaches us already folded into fillOpacity by svgstyle.ts,
  // which also folds in fill-opacity — a property SVG says does not apply to an
  // image. The two cannot be separated after the fold; see the design spec.
  if (p.fillOpacity < 1) e.out.push(`/${e.gsKey(p.fillOpacity, 1)} gs`);
  e.out.push(`${pl.cm.map(num).join(' ')} cm`);
  e.out.push(`/${key} Do`);
  e.out.push('Q');
  e.addInk(pl.box, ctm);
  if (e.ctms) e.ctms.push(ctm);
}
```

**3f.** `walk` — a branch before the `SHAPES` one, inside the same else-if chain:

```ts
  } else if (n.name === 'image') {
    // Only from the painting branch: a <defs> image must allocate no XObject
    // that nothing references.
    if (!inDefs) drawImage(e, n, paint, here);
  } else if (SHAPES.has(n.name)) {
```

**3g.** `drawSvg` and `__ctmProbe` — the new parameter, set on the emitter:

```ts
export function drawSvg(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
  tiles: SvgTileSink, images: SvgImageSink,
): DrawResult {
  const e = new Emitter();
  e.viewport = viewport;
  e.fonts = provider;
  e.tiles = tiles;
  e.imageSink = images;
  …unchanged…
```

Do the same in `__ctmProbe` (same two lines: the parameter and `e.imageSink = images;`).

**3h.** `src/svgembed.ts` — the sink, beside `tileSink`:

```ts
/** Allocates the Image XObject for an `<image>`, and its soft mask. The only
 *  place a stream may be created; mirrors tileSink, and the /SMask handling
 *  mirrors imageembed.ts's addImage. */
function imageSink(doc: Document): SvgImageSink {
  return {
    image: (built) => {
      if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
      return doc.allocObject(built.stream);
    },
  };
}
```

Import `type SvgImageSink` alongside `drawSvg, type SvgTileSink`, and pass it:

```ts
  const { content, resources, skipped } =
    drawSvg(root, vb, provider, tileSink(doc), imageSink(doc));
```

**3i.** `test/svg-draw.test.ts` — the three call sites. Add beside `noTiles`:

```ts
/** A sink that hands back a distinct reference per image, so xobjKey can tell
 *  them apart without a Document. */
const noImages = () => {
  let n = 100;
  return { image: () => ref(++n) };
};
```

and pass `noImages()` as the fifth argument at lines ~15 (the `draw` helper),
~278 (`__ctmProbe`) and ~650 (`tileDict`'s inline sink object).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-embed-image.test.ts test/svg-draw.test.ts test/svg-image.test.ts && npm run typecheck && npm test`
Expected: all PASS. The full suite matters here: `drawSvg`'s signature changed, and `buildResources` now emits a key no golden previously contained.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts src/svgembed.ts test/svg-draw.test.ts test/svg-embed-image.test.ts
git commit -m "feat(svg): embed <image> through an SvgImageSink (1gg0.9)

An Image XObject is a stream, so the walker cannot build one: it hands the
BuiltImage to a sink svgembed.ts implements, exactly as tiling patterns and
fonts already do. /XObject joins the per-stream resources, so an image used
only inside a pattern tile lands in the tile's dictionary; the href cache is
shared walk-wide, so a repeated data: URI is embedded once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Prove orientation against a reader we did not write

An operator assertion cannot catch a mirrored image — I would be writing both
sides of it. `raster.ts` decodes an Image XObject and inverse-maps device pixels
to image UV with its own local Y-flip, written separately from this writer, so
this is the differential check CLAUDE.md's rule asks for.

**This task inverts the red-green order deliberately.** It is a verification test
over code Task 4 already made work, so it passes on the first run — which
CLAUDE.md says is not evidence. Step 3 is where it earns its place: three
mutations, each of which must turn it red. Do not skip Step 3; a green run alone
proves nothing here.

**Files:**
- Test: `test/svg-image-render.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 2-4; `decodePng` / `DecodedPng` from `test/helpers/decode-png.js`; `buildPngRgbWith` from `test/helpers/build-embed-images.js`; `buildSvgPdf` from `test/helpers/build-svg-fixtures.js`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/svg-image-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** A 2x2 RGB PNG: red top-left, green top-right, blue bottom-left, yellow
 *  bottom-right. Every quadrant differs, so orientation is pinned in both axes at
 *  once — a horizontally symmetric image would hide a mirror — and none of them
 *  is white, so "white" always means the page showing through. */
const QUADRANTS = `data:image/png;base64,${Buffer.from(buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0)).toString('base64')}`;

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Which of the four sample colours pixel (x, y) is closest to. */
function hue(png: DecodedPng, x: number, y: number): string {
  const [r, g, b] = png.at(x, y);
  if (r > 200 && g < 80 && b < 80) return 'red';
  if (g > 200 && r < 80 && b < 80) return 'green';
  if (b > 200 && r < 80 && g < 80) return 'blue';
  if (r > 200 && g > 200 && b < 80) return 'yellow';
  if (r > 200 && g > 200 && b > 200) return 'white';   // the page, never the image
  return `other(${r},${g},${b})`;
}

describe('AddSVGObject — <image> through Save/Open/ToImage', () => {
  it('draws the image upright and in place', () => {
    // The image fills the top-left 100x100 of a 200x200 viewBox, so in device
    // space its quadrants are 50x50 blocks at (0,0), (50,0), (0,50), (50,50).
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200"><image width="100" height="100" ` +
      `preserveAspectRatio="none" href="${QUADRANTS}"/></svg>`);
    expect(skipped).toEqual([]);
    expect(hue(png, 25, 25)).toBe('red');      // top-left stays top-left
    expect(hue(png, 75, 25)).toBe('green');    // no horizontal mirror
    expect(hue(png, 25, 75)).toBe('blue');     // no vertical mirror
    expect(hue(png, 75, 75)).toBe('yellow');
    // Nothing painted outside the element rect.
    expect(hue(png, 150, 150)).toBe('white');
  });

  it('honours x and y', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200"><image x="100" y="100" width="100" height="100" ` +
      `preserveAspectRatio="none" href="${QUADRANTS}"/></svg>`);
    expect(hue(png, 125, 125)).toBe('red');
    expect(hue(png, 175, 125)).toBe('green');
    expect(hue(png, 125, 175)).toBe('blue');
  });

  it('letterboxes under the default meet fit', () => {
    // A square image in a 200x100 box: fitted to 100x100 and centred, so the
    // left and right thirds stay page-white.
    const { png } = render(
      `<svg viewBox="0 0 200 200"><image width="200" height="100" href="${QUADRANTS}"/></svg>`);
    expect(hue(png, 75, 25)).toBe('red');
    expect(hue(png, 125, 25)).toBe('green');
    expect(hue(png, 10, 50)).toBe('white');    // letterbox margin
  });

  it('applies a transform from an enclosing group', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200"><g transform="translate(100,0)">` +
      `<image width="100" height="100" preserveAspectRatio="none" ` +
      `href="${QUADRANTS}"/></g></svg>`);
    expect(hue(png, 125, 25)).toBe('red');
    expect(hue(png, 25, 25)).toBe('white');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/svg-image-render.test.ts`
Expected: PASS. (Unlike the earlier tasks this test is written against code that
already works — its value is the mutation check in the next step, which is what
proves it can fail.)

- [ ] **Step 3: Prove the assertions are load-bearing**

Per CLAUDE.md: a fixture that passes first time is not evidence. Break the code
path and confirm red, restoring after each:

1. In `src/svgimage.ts`, change the `cm` to `[bw, 0, 0, bh, bx, by + bh]` (drop the
   flip). Run: `npx vitest run test/svg-image-render.test.ts` → expect the
   `blue`/`red` assertions to fail. Restore.
2. In `src/svgimage.ts`, make `overflows` always `false`. Run:
   `npx vitest run test/svg-embed-image.test.ts` → expect the `slice` clip test to
   fail. Restore.
3. In `src/svgdraw.ts`, make `drawImage` skip the `e.images` cache lookup (always
   decode and allocate). Run: `npx vitest run test/svg-embed-image.test.ts` →
   expect the dedup test to fail with two entries. Restore.

Record the three observed failures in the commit message.

- [ ] **Step 4: Re-run everything clean**

Run: `npm run typecheck && npm test`
Expected: all green, no mutants left in the tree (`git diff src/` shows only the
intended changes).

- [ ] **Step 5: Commit**

```bash
git add test/svg-image-render.test.ts
git commit -m "test(svg): check <image> orientation against the rasterizer (1gg0.9)

raster.ts decodes an Image XObject with its own local Y-flip, written
separately from this writer, so a Save/Open/ToImage round trip of a
four-quadrant PNG is a real cross-implementation check -- and the only one
that can catch a mirrored image.

Mutation-proved: dropping the cm flip reddens the corner assertions, forcing
overflows to false drops the slice clip, and bypassing the href cache embeds
two XObjects.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and close-out

**Files:**
- Modify: `README.md:19` (the SVG feature bullet), `README.md:1376` (the API table row), and the Limitations section
- Modify: `src/svgembed.ts` (the `AddSVGResult.skipped` doc comment, if it enumerates unsupported elements)

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing.

- [ ] **Step 1: Update the feature bullet**

In `README.md:19`, find:

```
`<textPath>`, `<image>`, masks, filters and markers are **not** rendered
```

Replace with `` `<textPath>`, masks, filters and markers are **not** rendered ``,
and add an `<image>` sentence to the same bullet, after the Patterns one:

```
**Images** — `<image>` embeds a `data:` URI carrying a PNG or JPEG as an Image
XObject: `x`/`y`/`width`/`height` (an absent dimension takes the image's intrinsic
pixel size, or is derived from the other through its aspect ratio) and
`preserveAspectRatio` (all nine align keywords with `meet`/`slice`/`none`, the
`slice` overflow clipped to the element rect). The declared media type is ignored
in favour of the bytes' own magic numbers, since data URIs in the wild carry wrong
ones. Two elements sharing an href embed one XObject. An href that is **not** a
`data:` URI — a relative path, `http:` — embeds nothing and names `image` in
`result.skipped`: the library performs no I/O, so the bytes have to arrive in the
document. A payload that is not PNG/JPEG, including `image/svg+xml`, is reported
the same way; a zero or negative `width`/`height` draws nothing and is *not*
reported, as SVG mandates. `fill-opacity` is folded into the image's constant
alpha along with group `opacity` — SVG applies only the latter to an image, and
PDF cannot separate them short of a transparency group.
```

- [ ] **Step 2: Update the API table row**

In `README.md:1376`, add `<image>` to the list of what `AddSVGObject` covers:
after the `<pattern>` clause, insert
`` , `<image>` (`data:` URI PNG/JPEG → Image XObjects) ``.

- [ ] **Step 3: Add the Limitations entry**

In the Limitations section, beside the other SVG entries:

```
- **SVG `<image>` needs the bytes in the document** — `page.AddSVGObject` embeds
  an `<image>` only from a `data:` URI (PNG or JPEG). A relative path or an
  `http:` href is not fetched: the library does no I/O and takes no dependency,
  so such an image is skipped and named in `result.skipped`. A nested
  `image/svg+xml` payload is likewise skipped rather than recursed into.
```

- [ ] **Step 4: Verify the docs claims against the code**

Run: `npm run typecheck && npm test`
Expected: green. Then re-read each README claim against `svgimage.ts` — every
sentence above must be a behaviour a test in Tasks 2-5 pins. Fix the prose, not
the tests, on any mismatch.

- [ ] **Step 5: Commit and close the issue**

```bash
git add README.md src/svgembed.ts
git commit -m "docs(svg): document <image> embedding (1gg0.9)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Then:

```bash
bd close 1gg0.9 -r @'
<image> embeds a data: URI carrying PNG or JPEG. Shipped:

- svgimage.ts (new, pure): data URI decode (base64 + byte-wise percent), the
  magic-byte sniff via imageembed.ts buildImageXObject, and the placement --
  intrinsic sizing, the nine preserveAspectRatio align keywords, meet/slice/none,
  and the local -h flip that cancels placementMatrix.
- svgtransform.ts: the align/scale core extracted as fitBox, so root placement
  and <image> share one implementation and cannot drift.
- svgdraw.ts/svgembed.ts: SvgImageSink, mirroring SvgTileSink -- an Image XObject
  is a stream, so only the embedder may allocate. /XObject joins the per-stream
  resources (an image used only in a pattern tile lands in the tile dict), and an
  href cache shared walk-wide embeds a repeated URI once.

Two approximations, both documented in the README: fill-opacity is folded into
the constant alpha along with group opacity (svgstyle.ts folds them and PDF
cannot separate them short of a transparency group), and a percentage width or
height is read as its bare number, as every length in this stack is.

Out of scope, each reported in skipped: a non-data: href (the library does no
I/O) and an image/svg+xml payload (recursion is its own feature). Follow-ups
filed for both.

Verified by a Save/Open/ToImage round trip of a four-quadrant PNG through
raster.ts -- a reader written separately from this writer, and the only check
that catches a mirrored image. Mutation-proved: dropping the cm flip, forcing
the slice overflow test to false, and bypassing the href cache each go red.
'@
git add .beads/interactions.jsonl
git commit -m "chore(bd): session bookkeeping for 1gg0.9

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase && git push && git status -sb
```

- [ ] **Step 6: File the two follow-ups from the spec**

```bash
bd create "SVG <image>: caller-supplied href resolver" -t feature -p 4 --parent 1gg0 \
  -d "AddSVGOptions gains image?: (href: string) => Uint8Array | undefined so a caller can supply bytes for relative-path and http: hrefs without the library doing I/O. Deferred from 1gg0.9; today such an href is skipped and reported."
bd create "SVG <image>: nested image/svg+xml payloads" -t feature -p 4 --parent 1gg0 \
  -d "Recurse through drawSvg into a nested form XObject for an <image> whose data: URI carries image/svg+xml, behind a depth guard. Deferred from 1gg0.9; today the payload fails the magic-byte sniff and is reported in skipped."
```

---

## Verification checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` — full suite green (271+ files)
- [ ] Every new test was watched failing first, except Task 5's, which was proved by mutation instead
- [ ] The three mutations in Task 5 Step 3 each produced a red run, and none remain in the tree
- [ ] `git status` clean, `main` up to date with `origin`
