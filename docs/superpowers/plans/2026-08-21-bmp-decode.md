# BMP Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddImage(bmpBytes, rect)` embeds a Windows BMP, alongside the JPEG and PNG this library already accepts.

**Architecture:** A new pure module `src/bmp.ts` decodes a BMP to a normalized raster (`BmpImage`) and knows nothing about PDF. `src/imageembed.ts` gains `buildBmpXObject`, a `switch` over that union whose arms reuse the `imageStream`/`flate` machinery the PNG path already built, plus a `sniff()` branch. Every existing consumer — `page.AddImage`, `flow.AddImage`, `cell.setImage`, floating boxes, signature appearance images — then accepts BMP with no change of its own.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, `node:zlib` via the existing `flate()` helper. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-bmp-decode-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Every import specifier carries the `.js` extension (`import { PdfParseError } from './errors.js'`).
- **`src/bmp.ts` imports `./errors.js` and nothing else from this repo.** No `types.ts`, no `document.ts`, no PDF knowledge. This is what makes the module testable from raw bytes.
- **Errors are the repo's public types**: `PdfParseError` for damage, `UnsupportedFeatureError` for shapes we decline. Both from `src/errors.ts`.
- **All integers in a BMP are little-endian.**
- **Both `npm run typecheck` and `npm test` must be green before the issue closes.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Update `CHANGELOG.md` under `## [Unreleased]`** in the same commit as the user-visible change (Task 7).
- **Issue id for commit messages:** `10u9.2`.

---

### Task 1: `bmp.ts` — the container and the 24-bit route, anchored on a published dump

The first thing that exists is validated against bytes we did not author. Error cases are built by slicing that same dump, so this task needs no fixture builder.

**Files:**
- Create: `src/bmp.ts`
- Test: `test/bmp.test.ts`

**Interfaces:**
- Produces: `BmpImage` (the union below) and `decodeBmp(data: Uint8Array): BmpImage`. Every later task extends the same two.

- [ ] **Step 1: Write the failing test**

Create `test/bmp.test.ts`. The `ANCHOR_24` bytes are Wikipedia's "Example 1" (2×2, 24-bit, `BITMAPINFOHEADER`, `BI_RGB`) transcribed verbatim. Do not regenerate them from a builder — the point is that they come from outside our code.

```ts
import { describe, it, expect } from 'vitest';
import { decodeBmp } from '../src/bmp.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';

/**
 * Wikipedia's "BMP file format" Example 1: a 2x2, 24-bit, BITMAPINFOHEADER,
 * BI_RGB file, transcribed byte for byte.
 *
 * Rows are stored bottom-up, so the FIRST row in the file is the bottom one:
 *   file row 0 (bottom): red, white
 *   file row 1 (top):    blue, green
 * Decoded top-down, the raster must therefore read blue, green, red, white.
 *
 * This fixture is non-grey (so an unswapped BGR decode turns red into blue and
 * is visible) and vertically asymmetric (so a missing row flip is visible). It
 * is SQUARE, so it cannot see a width/height transposition -- ANCHOR_32 in
 * Task 3 is 4x2 and covers that.
 */
const ANCHOR_24 = Uint8Array.from([
  0x42, 0x4d,                                     // "BM"
  0x46, 0x00, 0x00, 0x00,                         // bfSize = 70
  0x00, 0x00, 0x00, 0x00,                         // reserved
  0x36, 0x00, 0x00, 0x00,                         // bfOffBits = 54
  0x28, 0x00, 0x00, 0x00,                         // DIB size = 40
  0x02, 0x00, 0x00, 0x00,                         // width = 2
  0x02, 0x00, 0x00, 0x00,                         // height = 2 (bottom-up)
  0x01, 0x00,                                     // planes = 1
  0x18, 0x00,                                     // bpp = 24
  0x00, 0x00, 0x00, 0x00,                         // BI_RGB
  0x10, 0x00, 0x00, 0x00,                         // sizeImage = 16
  0x13, 0x0b, 0x00, 0x00,                         // 2835 px/m
  0x13, 0x0b, 0x00, 0x00,                         // 2835 px/m
  0x00, 0x00, 0x00, 0x00,                         // clrUsed = 0
  0x00, 0x00, 0x00, 0x00,                         // clrImportant = 0
  0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, // bottom row: red, white, pad
  0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, // top row: blue, green, pad
]);

describe('decodeBmp — 24-bit BI_RGB, anchored on the published dump', () => {
  it('decodes the published 2x2 file to top-down RGB', () => {
    const img = decodeBmp(ANCHOR_24);
    expect(img.kind).toBe('rgb');
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(img.alpha).toBeUndefined();      // 24-bit carries no alpha
    expect(Array.from(img.samples)).toEqual([
      0x00, 0x00, 0xff, /* blue  */ 0x00, 0xff, 0x00, /* green */
      0xff, 0x00, 0x00, /* red   */ 0xff, 0xff, 0xff, /* white */
    ]);
  });

  it('reads a top-down file (negative height) without flipping', () => {
    const td = Uint8Array.from(ANCHOR_24);
    // height = -2, little-endian two's complement, at offset 0x16.
    td.set([0xfe, 0xff, 0xff, 0xff], 0x16);
    const img = decodeBmp(td);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.height).toBe(2);
    // Same bytes, opposite order: the file's first row is now the TOP row.
    expect(Array.from(img.samples)).toEqual([
      0xff, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x00, 0x00, 0xff, 0x00, 0xff, 0x00,
    ]);
  });

  it('honours bfOffBits rather than computing it', () => {
    // Insert 4 gap bytes between the header and the pixels, and say so.
    const head = ANCHOR_24.subarray(0, 54);
    const pixels = ANCHOR_24.subarray(54);
    const gapped = new Uint8Array(head.length + 4 + pixels.length);
    gapped.set(head, 0);
    gapped.set([0xde, 0xad, 0xbe, 0xef], 54);
    gapped.set(pixels, 58);
    gapped.set([0x3a, 0x00, 0x00, 0x00], 0x0a);   // bfOffBits = 58
    gapped.set([0x4a, 0x00, 0x00, 0x00], 0x02);   // bfSize = 74
    const img = decodeBmp(gapped);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // Identical to the ungapped decode: the gap was skipped, not read as pixels.
    expect(Array.from(img.samples.subarray(0, 3))).toEqual([0x00, 0x00, 0xff]);
  });

  it('rejects a file that is not a BMP', () => {
    expect(() => decodeBmp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toThrow(PdfParseError);
  });

  it('rejects a truncated pixel array', () => {
    expect(() => decodeBmp(ANCHOR_24.subarray(0, 60))).toThrow(PdfParseError);
  });

  it('rejects bfOffBits pointing outside the file', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0xff, 0xff, 0x00, 0x00], 0x0a);
    expect(() => decodeBmp(bad)).toThrow(PdfParseError);
  });

  it('rejects an unknown DIB header size', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0x29, 0x00, 0x00, 0x00], 0x0e);   // 41: not one of the six
    expect(() => decodeBmp(bad)).toThrow(PdfParseError);
  });

  it('declines a bit depth it does not implement', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0x30, 0x00], 0x1c);               // 48 bpp
    expect(() => decodeBmp(bad)).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bmp.test.ts`
Expected: FAIL — `Failed to resolve import "../src/bmp.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/bmp.ts`. This task implements the container plus the 24-bit arm; later tasks fill the `switch`.

```ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

/**
 * A BMP decoded to a normalized raster. Rows are TOP-DOWN and padded to a byte
 * boundary only -- never BMP's own 4-byte row stride -- so a consumer can hand
 * `samples` to a PDF image stream unchanged.
 */
export type BmpImage =
  | {
      kind: 'indexed';
      width: number; height: number;
      /** 1, 2, 4 or 8. The samples stay packed at this depth. */
      bpc: 1 | 2 | 4 | 8;
      /** RGB triples, already swapped out of BMP's BGR order. */
      palette: Uint8Array;
      samples: Uint8Array;
    }
  | {
      kind: 'rgb';
      width: number; height: number;
      /** 8-bit RGB triples. */
      samples: Uint8Array;
      /** One byte per pixel. Present only when the header DECLARES alpha. */
      alpha?: Uint8Array;
    }
  | { kind: 'embedded'; format: 'jpeg' | 'png'; payload: Uint8Array };

/** Compression values from the BMP header (wingdi.h BI_* constants). */
const BI_RGB = 0, BI_RLE8 = 1, BI_RLE4 = 2, BI_BITFIELDS = 3;
const BI_JPEG = 4, BI_PNG = 5, BI_ALPHABITFIELDS = 6;

/** DIB header sizes we accept. 64 is OS/2 v2, read as an INFOHEADER. */
const DIB_CORE = 12, DIB_INFO = 40, DIB_V2 = 52, DIB_V3 = 56;
const DIB_OS22 = 64, DIB_V4 = 108, DIB_V5 = 124;
const KNOWN_DIB = new Set([DIB_CORE, DIB_INFO, DIB_V2, DIB_V3, DIB_OS22, DIB_V4, DIB_V5]);

/** Refuse a raster whose pixel count cannot plausibly be allocated. */
const MAX_PIXELS = 1 << 28;   // 268M pixels; 4 bytes each is already 1 GB

const u16 = (d: Uint8Array, o: number): number => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number): number =>
  (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const i32 = (d: Uint8Array, o: number): number =>
  d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);

/** Everything the two header generations agree on, plus where to find the rest. */
export interface BmpHeader {
  dibSize: number;
  width: number;
  /** Always positive; `topDown` carries the sign. */
  height: number;
  topDown: boolean;
  bpp: number;
  compression: number;
  /** Palette entry count, 0 when the image is not palettized. */
  clrUsed: number;
  /** Offset of the pixel array, as the file states it. */
  offBits: number;
  /** Offset just past the DIB header -- where a palette or INFO masks begin. */
  afterHeader: number;
}

export function parseBmpHeader(d: Uint8Array): BmpHeader {
  if (d.length < 26 || d[0] !== 0x42 || d[1] !== 0x4d)
    throw new PdfParseError('BMP: missing "BM" file header');
  const offBits = u32(d, 0x0a);
  const dibSize = u32(d, 0x0e);
  if (!KNOWN_DIB.has(dibSize))
    throw new PdfParseError(`BMP: unknown DIB header size ${dibSize}`);
  if (d.length < 14 + dibSize)
    throw new PdfParseError('BMP: truncated DIB header');

  let width: number, rawHeight: number, bpp: number;
  let compression = BI_RGB, clrUsed = 0;
  if (dibSize === DIB_CORE) {
    // BITMAPCOREHEADER: 16-bit dimensions, no compression field at all.
    width = u16(d, 0x12);
    rawHeight = u16(d, 0x14);
    bpp = u16(d, 0x18);
  } else {
    width = i32(d, 0x12);
    rawHeight = i32(d, 0x16);
    bpp = u16(d, 0x1c);
    compression = u32(d, 0x1e);
    clrUsed = u32(d, 0x2e);
  }
  if (width <= 0 || rawHeight === 0)
    throw new PdfParseError(`BMP: bad dimensions ${width}x${rawHeight}`);
  const height = Math.abs(rawHeight);
  if (width * height > MAX_PIXELS)
    throw new PdfParseError(`BMP: ${width}x${height} exceeds the pixel bound`);
  if (offBits < 14 + dibSize || offBits > d.length)
    throw new PdfParseError(`BMP: pixel offset ${offBits} outside the file`);

  return {
    dibSize, width, height, topDown: rawHeight < 0, bpp, compression,
    clrUsed, offBits, afterHeader: 14 + dibSize,
  };
}

/** Bytes per row in the FILE: packed to the bit depth, then padded to 4 bytes. */
export function fileStride(width: number, bpp: number): number {
  return (((width * bpp + 31) / 32) | 0) * 4;
}

/** Bytes per row in the OUTPUT: packed to the bit depth, padded to a byte. */
export function packedStride(width: number, bpp: number): number {
  return (width * bpp + 7) >> 3;
}

/**
 * Walk the file's rows in the order they should appear top-down, calling `row`
 * with each row's bytes. A positive height means the file stores the bottom row
 * first, so the walk runs backwards.
 *
 * The single owner of the row flip: every route reads its rows through this, so
 * none of them can disagree about which end of the file the top row lives at.
 */
export function eachRowTopDown(
  d: Uint8Array, h: BmpHeader, stride: number,
  row: (bytes: Uint8Array, y: number) => void,
): void {
  const need = h.offBits + stride * h.height;
  if (need > d.length)
    throw new PdfParseError(`BMP: pixel array needs ${need} bytes, file has ${d.length}`);
  for (let y = 0; y < h.height; y++) {
    const src = h.topDown ? y : h.height - 1 - y;
    row(d.subarray(h.offBits + src * stride, h.offBits + (src + 1) * stride), y);
  }
}

/** 24-bit BI_RGB: BGR triples, restrided and flipped. */
function decode24(d: Uint8Array, h: BmpHeader): BmpImage {
  const out = new Uint8Array(h.width * h.height * 3);
  eachRowTopDown(d, h, fileStride(h.width, 24), (src, y) => {
    let o = y * h.width * 3;
    for (let x = 0; x < h.width; x++) {
      const s = x * 3;
      out[o++] = src[s + 2];   // R
      out[o++] = src[s + 1];   // G
      out[o++] = src[s];       // B
    }
  });
  return { kind: 'rgb', width: h.width, height: h.height, samples: out };
}

export function decodeBmp(data: Uint8Array): BmpImage {
  const h = parseBmpHeader(data);
  if (h.compression === BI_RGB && h.bpp === 24) return decode24(data, h);
  throw new UnsupportedFeatureError(
    `BMP: unsupported ${h.bpp}bpp with compression ${h.compression}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bmp.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/bmp.ts test/bmp.test.ts
git commit -m "feat(10u9.2): BMP container parsing and the 24-bit route

Anchored on Wikipedia's published 2x2 BITMAPINFOHEADER hex dump rather than
on a fixture we generated: for a format we only ever read, our builder and our
decoder can otherwise agree on a misreading with nothing to contradict them.
The fixture is non-grey and vertically asymmetric, so an unswapped BGR decode
and a missing row flip are both visible in it.

eachRowTopDown is the single owner of the flip -- every route reads its rows
through it, so none can disagree about which end of the file the top row is
at -- and bfOffBits is respected rather than derived, since gap bytes between
the palette and the pixels are legal and a computed offset reads them as ink."
```

---

### Task 2: The fixture builder and the palette route

**Files:**
- Create: `test/helpers/build-bmp.ts`
- Modify: `src/bmp.ts` (add the indexed route)
- Modify: `test/bmp.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `BmpImage`, `parseBmpHeader`, `fileStride`, `packedStride`, `eachRowTopDown` from Task 1.
- Produces: `buildBmp(opts: BuildBmpOptions): Uint8Array` for every later task's fixtures.

- [ ] **Step 1: Write the builder**

Create `test/helpers/build-bmp.ts`:

```ts
/**
 * Synthesize BMP files for the decoder tests.
 *
 * Deliberately dumb: it lays bytes out from the caller's numbers and performs
 * no decoding of its own, so it cannot "agree" with the decoder about a
 * misreading the way a round-trip through a shared codec would. The published
 * hex dumps in test/bmp.test.ts are the anchor; this is the matrix sweep.
 */
export interface BuildBmpOptions {
  width: number;
  height: number;
  bpp: 1 | 2 | 4 | 8 | 16 | 24 | 32;
  /** DIB header size: 12, 40, 52, 56, 64, 108 or 124. Default 40. */
  dibSize?: number;
  /** BI_* value. Default 0 (BI_RGB). */
  compression?: number;
  /** true stores the top row first and writes a negative height. */
  topDown?: boolean;
  /** BGR(A) or index bytes, ONE ROW AT A TIME, top row first. Padding is added. */
  rows: number[][];
  /** BGR(x) palette entries as [b, g, r] triples. Entry size follows dibSize. */
  palette?: Array<[number, number, number]>;
  /** Written into biClrUsed. Defaults to palette.length. */
  clrUsed?: number;
  /** Channel masks for BI_BITFIELDS / V2+ headers: [r, g, b, a]. */
  masks?: [number, number, number, number];
  /** Extra bytes between the palette and the pixel array. */
  gap?: number;
  /** Replaces the pixel array outright (for RLE and embedded payloads). */
  rawPixels?: Uint8Array;
}

const put32 = (d: Uint8Array, o: number, v: number): void => {
  d[o] = v & 0xff; d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff; d[o + 3] = (v >>> 24) & 0xff;
};
const put16 = (d: Uint8Array, o: number, v: number): void => {
  d[o] = v & 0xff; d[o + 1] = (v >>> 8) & 0xff;
};

export function buildBmp(o: BuildBmpOptions): Uint8Array {
  const dibSize = o.dibSize ?? 40;
  const compression = o.compression ?? 0;
  const core = dibSize === 12;
  const entry = core ? 3 : 4;
  const palBytes = (o.palette?.length ?? 0) * entry;
  // A 40-byte header with bitfields keeps its masks where the palette would go.
  const inlineMasks = dibSize === 40 && (compression === 3 || compression === 6)
    ? (compression === 6 ? 16 : 12) : 0;
  const gap = o.gap ?? 0;

  const stride = (((o.width * o.bpp + 31) / 32) | 0) * 4;
  const pixels = o.rawPixels ?? (() => {
    const buf = new Uint8Array(stride * o.height);
    // `rows` is top-down; a bottom-up file stores them reversed.
    o.rows.forEach((r, y) => {
      const dst = (o.topDown ? y : o.height - 1 - y) * stride;
      buf.set(Uint8Array.from(r), dst);
    });
    return buf;
  })();

  const offBits = 14 + dibSize + inlineMasks + palBytes + gap;
  const out = new Uint8Array(offBits + pixels.length);
  out[0] = 0x42; out[1] = 0x4d;
  put32(out, 0x02, out.length);
  put32(out, 0x0a, offBits);
  put32(out, 0x0e, dibSize);

  if (core) {
    put16(out, 0x12, o.width);
    put16(out, 0x14, o.height);
    put16(out, 0x16, 1);
    put16(out, 0x18, o.bpp);
  } else {
    put32(out, 0x12, o.width);
    put32(out, 0x16, o.topDown ? -o.height : o.height);
    put16(out, 0x1a, 1);
    put16(out, 0x1c, o.bpp);
    put32(out, 0x1e, compression);
    put32(out, 0x22, pixels.length);
    put32(out, 0x26, 2835);
    put32(out, 0x2a, 2835);
    put32(out, 0x2e, o.clrUsed ?? o.palette?.length ?? 0);
    put32(out, 0x32, 0);
  }

  if (o.masks) {
    // V2+ headers hold the masks INSIDE themselves at 0x36; a 40-byte header
    // holds them immediately AFTER itself. Getting this backwards consumes the
    // first palette entries as masks.
    const at = dibSize >= 52 ? 0x36 : 14 + dibSize;
    put32(out, at, o.masks[0]);
    put32(out, at + 4, o.masks[1]);
    put32(out, at + 8, o.masks[2]);
    if (dibSize >= 56 || compression === 6) put32(out, at + 12, o.masks[3]);
  }
  if (dibSize >= 108) put32(out, 0x46, 0x57696e20);   // "Win " colour space

  if (o.palette) {
    let p = 14 + dibSize + inlineMasks;
    for (const [b, g, r] of o.palette) {
      out[p] = b; out[p + 1] = g; out[p + 2] = r;
      p += entry;
    }
  }
  out.set(pixels, offBits);
  return out;
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/bmp.test.ts`:

```ts
import { buildBmp } from './helpers/build-bmp.js';

describe('decodeBmp — palette images', () => {
  // Deliberately non-grey, non-square and vertically asymmetric: a grey palette
  // cannot see the BGR swap, a square raster cannot see a transposition, and a
  // symmetric one cannot see the row flip.
  const PAL: Array<[number, number, number]> = [
    [0x00, 0x00, 0xff],   // BGR: red
    [0x00, 0xff, 0x00],   // green
    [0xff, 0x00, 0x00],   // blue
    [0xff, 0xff, 0xff],   // white
  ];

  it('keeps 8-bit indices packed and swaps only the palette', () => {
    const bmp = buildBmp({
      width: 3, height: 2, bpp: 8, palette: PAL,
      rows: [[0, 1, 2], [3, 2, 1]],     // top row, then bottom row
    });
    const img = decodeBmp(bmp);
    expect(img.kind).toBe('indexed');
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(8);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    // Indices survive untouched, top-down.
    expect(Array.from(img.samples)).toEqual([0, 1, 2, 3, 2, 1]);
    // The palette is RGB now, not BGR.
    expect(Array.from(img.palette)).toEqual([
      0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it('keeps 4-bit indices packed two to a byte and strips the 4-byte stride', () => {
    // width 3 at 4bpp is 2 bytes packed, padded to 4 in the file.
    const bmp = buildBmp({
      width: 3, height: 2, bpp: 4, palette: PAL,
      rows: [[0x01, 0x20, 0x00, 0x00], [0x32, 0x10, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(4);
    // Two bytes per row out, not four: the file's padding is gone.
    expect(Array.from(img.samples)).toEqual([0x01, 0x20, 0x32, 0x10]);
  });

  it('keeps 1-bit indices packed', () => {
    const bmp = buildBmp({
      width: 9, height: 2, bpp: 1, palette: [PAL[0], PAL[1]],
      rows: [[0b10110010, 0b10000000, 0, 0], [0b01001101, 0b00000000, 0, 0]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    expect(Array.from(img.samples)).toEqual([0b10110010, 0b10000000, 0b01001101, 0b00000000]);
  });

  it('reads a BITMAPCOREHEADER palette at 3 bytes per entry', () => {
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 8, dibSize: 12, palette: PAL,
      rows: [[0, 1, 0, 0], [2, 3, 0, 0]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    // Reading 4-byte entries here would shift every colour after the first.
    expect(Array.from(img.palette.subarray(0, 6))).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(Array.from(img.samples)).toEqual([0, 1, 2, 3]);
  });

  it('defaults the palette length to 1 << bpp when biClrUsed is 0', () => {
    // The file must actually CONTAIN 16 entries -- biClrUsed 0 means "all of
    // them", not "none". Only the first four carry meaning here.
    const full: Array<[number, number, number]> = [
      ...PAL, ...Array.from({ length: 12 }, () => [0, 0, 0] as [number, number, number]),
    ];
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 4, palette: full, clrUsed: 0,
      rows: [[0x01, 0x00, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.palette.length).toBe(16 * 3);   // 1 << 4 entries, RGB each
  });

  it('rejects a palette running past the pixel data', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, palette: PAL, clrUsed: 200,
      rows: [[0, 1, 0, 0]],
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/bmp.test.ts`
Expected: FAIL — six failures, all `UnsupportedFeatureError: BMP: unsupported 8bpp with compression 0` and friends.

- [ ] **Step 4: Implement the palette route**

Add to `src/bmp.ts`, and extend the `decodeBmp` dispatch:

```ts
/**
 * Read the colour table into RGB triples.
 *
 * Entry size is the ONE thing the header generation changes downstream: a
 * BITMAPCOREHEADER stores RGBTRIPLE (3 bytes), everything later RGBQUAD (4).
 * Reading the wrong size shifts every colour after the first.
 */
function readPalette(d: Uint8Array, h: BmpHeader, inlineMasks: number): Uint8Array {
  const entry = h.dibSize === DIB_CORE ? 3 : 4;
  const count = h.clrUsed !== 0 ? h.clrUsed : 1 << h.bpp;
  const start = h.afterHeader + inlineMasks;
  if (start + count * entry > h.offBits)
    throw new PdfParseError(`BMP: ${count}-entry palette runs past the pixel data`);
  const pal = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = start + i * entry;
    pal[i * 3] = d[s + 2];       // R
    pal[i * 3 + 1] = d[s + 1];   // G
    pal[i * 3 + 2] = d[s];       // B
  }
  return pal;
}

/** 1/2/4/8-bit palette images: indices pass through, restrided and flipped. */
function decodeIndexed(d: Uint8Array, h: BmpHeader, samples?: Uint8Array): BmpImage {
  const palette = readPalette(d, h, 0);
  const outStride = packedStride(h.width, h.bpp);
  let out: Uint8Array;
  if (samples) {
    out = samples;                       // already unpacked by the RLE route
  } else {
    out = new Uint8Array(outStride * h.height);
    eachRowTopDown(d, h, fileStride(h.width, h.bpp), (src, y) => {
      out.set(src.subarray(0, outStride), y * outStride);
    });
  }
  return {
    kind: 'indexed', width: h.width, height: h.height,
    bpc: h.bpp as 1 | 2 | 4 | 8, palette, samples: out,
  };
}
```

Replace `decodeBmp`'s body with:

```ts
export function decodeBmp(data: Uint8Array): BmpImage {
  const h = parseBmpHeader(data);
  if (h.compression === BI_RGB) {
    if (h.bpp === 1 || h.bpp === 2 || h.bpp === 4 || h.bpp === 8)
      return decodeIndexed(data, h);
    if (h.bpp === 24) return decode24(data, h);
  }
  throw new UnsupportedFeatureError(
    `BMP: unsupported ${h.bpp}bpp with compression ${h.compression}`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/bmp.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/bmp.ts test/bmp.test.ts test/helpers/build-bmp.ts
git commit -m "feat(10u9.2): BMP palette route, indices preserved

A palette image keeps its indices: lossless, smaller by up to 24x, and the
only route that works at 1, 2 and 4 bits per component, where the samples are
still packed several pixels to a byte. The same rule 10u9.1 established for
greying an Indexed image by rewriting its palette alone.

Palette ENTRY SIZE is the one thing the header generation changes downstream
-- 3 bytes for a BITMAPCOREHEADER, 4 for everything later -- and reading the
wrong one shifts every colour after the first, so the core-header case is
asserted beside the ordinary one. The builder is deliberately dumb: it lays
bytes out from the caller's numbers and decodes nothing, so it cannot agree
with the decoder about a misreading."
```

---

### Task 3: 16- and 32-bit, bitfields, and the alpha-declaration rule

**Files:**
- Modify: `src/bmp.ts`
- Modify: `test/bmp.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: no new exports; `decodeBmp` gains arms.

- [ ] **Step 1: Write the failing test**

Append to `test/bmp.test.ts`. `ANCHOR_32` is Wikipedia's "Example 2", 4×2, 32-bit, `BITMAPV4HEADER`, `BI_BITFIELDS`, with alpha.

```ts
/**
 * Wikipedia's "BMP file format" Example 2: 4x2, 32-bit, BITMAPV4HEADER,
 * BI_BITFIELDS, alpha mask 0xFF000000, transcribed byte for byte.
 *
 * The V4 header runs 0x0E..0x79 and the pixel array starts at 0x7A, which is
 * exactly bfOffBits; total 122 + 32 = 154 = bfSize. (The article's own offset
 * column mislabels the three gamma fields as 0x86..0x91; they are at
 * 0x6E..0x79. The byte VALUES are all zero either way.)
 *
 * Bottom-up, so the file's first row is the bottom one. Non-square, so unlike
 * ANCHOR_24 this fixture also sees a width/height transposition.
 */
const ANCHOR_32 = Uint8Array.from([
  0x42, 0x4d,                                     // "BM"
  0x9a, 0x00, 0x00, 0x00,                         // bfSize = 154
  0x00, 0x00, 0x00, 0x00,                         // reserved
  0x7a, 0x00, 0x00, 0x00,                         // bfOffBits = 122
  0x6c, 0x00, 0x00, 0x00,                         // DIB size = 108 (V4)
  0x04, 0x00, 0x00, 0x00,                         // width = 4
  0x02, 0x00, 0x00, 0x00,                         // height = 2
  0x01, 0x00,                                     // planes
  0x20, 0x00,                                     // bpp = 32
  0x03, 0x00, 0x00, 0x00,                         // BI_BITFIELDS
  0x20, 0x00, 0x00, 0x00,                         // sizeImage = 32
  0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, // resolution
  0x00, 0x00, 0x00, 0x00,                         // clrUsed
  0x00, 0x00, 0x00, 0x00,                         // clrImportant
  0x00, 0x00, 0xff, 0x00,                         // red   mask 0x00FF0000
  0x00, 0xff, 0x00, 0x00,                         // green mask 0x0000FF00
  0xff, 0x00, 0x00, 0x00,                         // blue  mask 0x000000FF
  0x00, 0x00, 0x00, 0xff,                         // alpha mask 0xFF000000
  0x20, 0x6e, 0x69, 0x57,                         // "Win " colour space
  ...new Array<number>(36).fill(0),               // CIEXYZTRIPLE
  0x00, 0x00, 0x00, 0x00,                         // gamma red
  0x00, 0x00, 0x00, 0x00,                         // gamma green
  0x00, 0x00, 0x00, 0x00,                         // gamma blue
  // bottom row: blue, green, red, white at alpha 0x7F
  0xff, 0x00, 0x00, 0x7f, 0x00, 0xff, 0x00, 0x7f,
  0x00, 0x00, 0xff, 0x7f, 0xff, 0xff, 0xff, 0x7f,
  // top row: the same four, opaque
  0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff,
  0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

describe('decodeBmp — 16- and 32-bit', () => {
  it('decodes the published V4 bitfields file with its declared alpha', () => {
    expect(ANCHOR_32.length).toBe(154);   // the transcription is self-consistent
    const img = decodeBmp(ANCHOR_32);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.width).toBe(4);
    expect(img.height).toBe(2);
    expect(Array.from(img.samples.subarray(0, 12))).toEqual([
      0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff, 0xff,
    ]);                                    // top row: blue, green, red, white
    expect(img.alpha).toBeDefined();
    expect(Array.from(img.alpha!)).toEqual([
      0xff, 0xff, 0xff, 0xff,              // top row opaque
      0x7f, 0x7f, 0x7f, 0x7f,              // bottom row half
    ]);
  });

  it('treats a plain 32-bpp BI_RGB file as BGRX with no alpha', () => {
    // Every fourth byte is 0. Honouring it would render the image invisible.
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 32,
      rows: [[0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
    expect(Array.from(img.samples)).toEqual([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);
  });

  it('ignores a V4 alpha mask of zero', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 32, dibSize: 108, compression: 3,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
      rows: [[0xff, 0x00, 0x00, 0x11, 0x00, 0xff, 0x00, 0x22]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
  });

  it('reads a 40-byte header bitfields mask from AFTER the header', () => {
    // 565, the everyday 16-bit layout. A V2 header would hold these INSIDE
    // itself; reading the wrong place consumes the first pixels as masks.
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0xf8, 0xe0, 0x07]],   // pure red, pure green
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // round(v * 255 / max): 31 -> 255 and 63 -> 255 exactly.
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('reads a V2 header bitfields mask from INSIDE the header', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16, dibSize: 52, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0xf8, 0xe0, 0x07]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('defaults 16-bit BI_RGB to RGB555', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16,
      rows: [[0x00, 0x7c, 0xe0, 0x03]],   // 0x7C00 red, 0x03E0 green
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('expands a channel by rounding, not truncation or bit replication', () => {
    // The value has to be chosen to separate the three rules, and most do not:
    // 5-bit 3 of 31 is round(3 * 255 / 31) = round(24.677) = 25, while BOTH
    // truncation and high-bit replication ((3 << 3) | (3 >> 2)) give 24. A
    // full-scale value cannot see this at all -- all three map 31 to 255.
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0x18]],               // red = 3 << 11, green and blue 0
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([25, 0, 0]);
  });

  it('maps a full-scale channel to exactly 255 at every field width', () => {
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0xff, 0xff]],               // every channel at its maximum
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // The 6-bit green channel is the one that matters: a field width other than
    // 8 must still reach 255, or a white image comes out faintly off-white.
    expect(Array.from(img.samples)).toEqual([0xff, 0xff, 0xff]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bmp.test.ts`
Expected: FAIL — seven failures with `UnsupportedFeatureError`.

- [ ] **Step 3: Implement**

Add to `src/bmp.ts`:

```ts
/** A channel mask reduced to a shift and the width of its field. */
interface Channel { shift: number; max: number }

function channelOf(mask: number): Channel | undefined {
  if (mask === 0) return undefined;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let width = 0;
  while (((mask >>> (shift + width)) & 1) === 1) width++;
  return { shift, max: (1 << width) - 1 };
}

/**
 * Scale a channel to 8 bits by rounding, NOT by replicating high bits.
 * The two agree at 0 and at every ordinary 5- and 6-bit value, but only
 * rounding maps `max` to exactly 255 for every field width.
 */
const scale8 = (v: number, max: number): number =>
  max === 255 ? v : Math.round((v * 255) / max);

/**
 * Where a bitfields header keeps its masks, which differs by header size and is
 * the kind of thing that is silently wrong when wrong: a 40-byte INFOHEADER
 * stores them AFTER itself, in the bytes a palette would occupy, while a 52+
 * header stores them INSIDE itself at offset 0x36. Reading a V2 header's masks
 * from after it consumes the first palette entries as masks.
 */
function readMasks(d: Uint8Array, h: BmpHeader): [number, number, number, number] {
  const alphaField = h.dibSize >= DIB_V3 || h.compression === BI_ALPHABITFIELDS;
  if (h.compression === BI_BITFIELDS || h.compression === BI_ALPHABITFIELDS) {
    const at = h.dibSize >= DIB_V2 ? 0x36 : h.afterHeader;
    const need = at + (alphaField ? 16 : 12);
    if (need > d.length) throw new PdfParseError('BMP: truncated channel masks');
    return [u32(d, at), u32(d, at + 4), u32(d, at + 8),
            alphaField ? u32(d, at + 12) : 0];
  }
  // BI_RGB at 16 bpp is RGB555; at 32 bpp it is BGRX and the fourth byte is pad.
  if (h.bpp === 16) return [0x7c00, 0x03e0, 0x001f, 0];
  return [0x00ff0000, 0x0000ff00, 0x000000ff, 0];
}

/** 16- and 32-bit images, both mask-driven. */
function decodePacked(d: Uint8Array, h: BmpHeader): BmpImage {
  const [rm, gm, bm, am] = readMasks(d, h);
  const rc = channelOf(rm), gc = channelOf(gm), bc = channelOf(bm);
  if (!rc || !gc || !bc) throw new PdfParseError('BMP: a colour mask is empty');
  // The header must DECLARE alpha. A plain 32-bpp BI_RGB file's fourth byte is
  // padding, and it is very commonly zero across the whole image -- honouring it
  // yields a picture that is drawn, structurally correct and fully invisible.
  const ac = channelOf(am);

  const px = h.width * h.height;
  const out = new Uint8Array(px * 3);
  const alpha = ac ? new Uint8Array(px) : undefined;
  const bytes = h.bpp >> 3;
  eachRowTopDown(d, h, fileStride(h.width, h.bpp), (src, y) => {
    for (let x = 0; x < h.width; x++) {
      const s = x * bytes;
      const v = bytes === 2 ? (src[s] | (src[s + 1] << 8))
        : (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) >>> 0;
      const p = y * h.width + x;
      out[p * 3] = scale8((v >>> rc.shift) & rc.max, rc.max);
      out[p * 3 + 1] = scale8((v >>> gc.shift) & gc.max, gc.max);
      out[p * 3 + 2] = scale8((v >>> bc.shift) & bc.max, bc.max);
      if (alpha && ac) alpha[p] = scale8((v >>> ac.shift) & ac.max, ac.max);
    }
  });
  return { kind: 'rgb', width: h.width, height: h.height, samples: out, alpha };
}
```

Extend the dispatch in `decodeBmp`, before the throw:

```ts
  if (h.compression === BI_BITFIELDS || h.compression === BI_ALPHABITFIELDS) {
    if (h.bpp === 16 || h.bpp === 32) return decodePacked(data, h);
    throw new UnsupportedFeatureError(`BMP: bitfields at ${h.bpp}bpp`);
  }
  if (h.compression === BI_RGB && (h.bpp === 16 || h.bpp === 32))
    return decodePacked(data, h);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bmp.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bmp.ts test/bmp.test.ts
git commit -m "feat(10u9.2): BMP 16- and 32-bit, bitfields and declared alpha

Anchored on Wikipedia's published 4x2 BITMAPV4HEADER dump, which is non-square
and so, unlike the 24-bit anchor, also sees a width/height transposition.

The fourth byte of a 32-bpp pixel is alpha only when the header DECLARES it --
BI_ALPHABITFIELDS, or a 56/108/124 header whose alpha mask is non-zero. A
plain BITMAPINFOHEADER 32-bpp BI_RGB file is BGRX, and that padding is very
commonly zero across a whole image, so honouring it unconditionally yields a
picture that is drawn, correct in every structural assertion, and completely
invisible.

Where the masks live differs by header and is silently wrong when wrong: a
40-byte header stores them after itself where a palette would go, a 52+ header
inside itself at 0x36. Both are asserted side by side."
```

---

### Task 4: RLE4 and RLE8

**Files:**
- Modify: `src/bmp.ts`
- Modify: `test/bmp.test.ts`

**Interfaces:**
- Consumes: `decodeIndexed`'s optional `samples` parameter from Task 2.

- [ ] **Step 1: Write the failing test**

Append to `test/bmp.test.ts`:

```ts
describe('decodeBmp — RLE', () => {
  const PAL4: Array<[number, number, number]> = [
    [0x00, 0x00, 0xff], [0x00, 0xff, 0x00], [0xff, 0x00, 0x00], [0xff, 0xff, 0xff],
  ];

  it('decodes RLE8 encoded runs and absolute runs', () => {
    // Row 0: 3 x index 1, then absolute [2, 3], end of line.
    // Row 1: 5 x index 0, end of bitmap.
    // RLE is always bottom-up, so the FIRST row encoded is the bottom one.
    const rle = Uint8Array.from([
      0x05, 0x00,                   // bottom row: 5 x index 0
      0x00, 0x00,                   // end of line
      0x03, 0x01,                   // top row: 3 x index 1
      0x00, 0x02, 0x02, 0x03,       // absolute run of 2: indices 2, 3
      0x00, 0x01,                   // end of bitmap
    ]);
    const bmp = buildBmp({
      width: 5, height: 2, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(8);
    expect(Array.from(img.samples)).toEqual([
      1, 1, 1, 2, 3,        // top row
      0, 0, 0, 0, 0,        // bottom row
    ]);
  });

  it('leaves pixels a delta escape skipped at index 0', () => {
    // One row of 4: write index 3 twice, jump 2 right, write nothing more.
    const rle = Uint8Array.from([
      0x02, 0x03,                   // 2 x index 3
      0x00, 0x02, 0x02, 0x00,       // delta: dx = 2, dy = 0
      0x00, 0x01,                   // end of bitmap
    ]);
    const bmp = buildBmp({
      width: 4, height: 1, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([3, 3, 0, 0]);
  });

  it('decodes RLE4 alternating nibbles', () => {
    // 5 x the pair (1, 2) -> indices 1,2,1,2,1 across a 5-wide row.
    const rle = Uint8Array.from([0x05, 0x12, 0x00, 0x01]);
    const bmp = buildBmp({
      width: 5, height: 1, bpp: 4, compression: 2, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(4);
    // Packed two to a byte: 0x12, 0x12, 0x10 -- 3 bytes for width 5.
    expect(Array.from(img.samples)).toEqual([0x12, 0x12, 0x10]);
  });

  it('refuses a top-down RLE image, which the format forbids', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, compression: 1, topDown: true,
      palette: PAL4, rows: [], rawPixels: Uint8Array.from([0x02, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(UnsupportedFeatureError);
  });

  it('refuses RLE8 at a bit depth other than 8', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 4, compression: 1, palette: PAL4,
      rows: [], rawPixels: Uint8Array.from([0x02, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(UnsupportedFeatureError);
  });

  it('rejects a run overrunning its row', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: Uint8Array.from([0x40, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bmp.test.ts`
Expected: FAIL — six failures.

- [ ] **Step 3: Implement**

Add to `src/bmp.ts`:

```ts
/**
 * Decode an RLE4/RLE8 stream into a packed index raster, top-down.
 *
 * Pixels no run ever writes stay index 0 -- after a delta escape, or where a
 * row ends before its width. The format leaves them undefined; 0 is what
 * decoders in the wild produce and the only choice whose output cannot depend
 * on uninitialized memory.
 *
 * RLE is always bottom-up (the format forbids a negative height with it), so
 * the first row decoded is the BOTTOM one and rows are written from the end.
 */
function decodeRle(d: Uint8Array, h: BmpHeader): Uint8Array {
  const stride = packedStride(h.width, h.bpp);
  const out = new Uint8Array(stride * h.height);
  const nibble = h.bpp === 4;

  const put = (x: number, y: number, idx: number): void => {
    if (x >= h.width || y >= h.height) return;   // a delta may land off the edge
    const row = (h.height - 1 - y) * stride;     // bottom-up
    if (nibble) {
      const b = row + (x >> 1);
      out[b] |= (x & 1) === 0 ? (idx & 0x0f) << 4 : idx & 0x0f;
    } else {
      out[row + x] = idx & 0xff;
    }
  };

  let p = h.offBits, x = 0, y = 0;
  for (;;) {
    if (p + 1 >= d.length) throw new PdfParseError('BMP: RLE stream ends mid-code');
    const count = d[p++], value = d[p++];
    if (count > 0) {
      if (x + count > h.width)
        throw new PdfParseError(`BMP: RLE run of ${count} overruns row ${y}`);
      for (let i = 0; i < count; i++, x++)
        put(x, y, nibble ? ((i & 1) === 0 ? value >> 4 : value & 0x0f) : value);
      continue;
    }
    if (value === 0) { x = 0; y++; continue; }        // end of line
    if (value === 1) break;                           // end of bitmap
    if (value === 2) {                                // delta
      if (p + 1 >= d.length) throw new PdfParseError('BMP: RLE delta is truncated');
      x += d[p++]; y += d[p++];
      continue;
    }
    // Absolute mode: `value` literal pixels, the run padded to a 16-bit boundary.
    const n = value;
    if (x + n > h.width)
      throw new PdfParseError(`BMP: RLE absolute run of ${n} overruns row ${y}`);
    const bytes = nibble ? (n + 1) >> 1 : n;
    if (p + bytes > d.length) throw new PdfParseError('BMP: RLE absolute run is truncated');
    for (let i = 0; i < n; i++, x++) {
      const b = d[p + (nibble ? i >> 1 : i)];
      put(x, y, nibble ? ((i & 1) === 0 ? b >> 4 : b & 0x0f) : b);
    }
    p += bytes + (bytes & 1);   // word alignment
  }
  return out;
}
```

Extend the dispatch in `decodeBmp`, before the throw:

```ts
  if (h.compression === BI_RLE8 || h.compression === BI_RLE4) {
    const want = h.compression === BI_RLE8 ? 8 : 4;
    if (h.bpp !== want)
      throw new UnsupportedFeatureError(`BMP: RLE${want} at ${h.bpp}bpp`);
    if (h.topDown)
      throw new UnsupportedFeatureError('BMP: a top-down RLE image is not valid');
    return decodeIndexed(data, h, decodeRle(data, h));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bmp.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bmp.ts test/bmp.test.ts
git commit -m "feat(10u9.2): BMP RLE4 and RLE8

Pixels no run ever writes stay index 0 -- after a delta escape, or where a row
ends before its width. The format leaves them undefined, 0 is what decoders in
the wild produce, and it is the only choice whose output cannot depend on
uninitialized memory. Absolute-mode runs are padded to a 16-bit boundary, and
a run overrunning its row is damage rather than something to clamp.

RLE is always bottom-up -- the format forbids pairing it with a negative
height -- so a top-down RLE image is refused rather than given an invented
reading."
```

---

### Task 5: The embedded JPEG and PNG arm

**Files:**
- Modify: `src/bmp.ts`
- Modify: `test/bmp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/bmp.test.ts`:

```ts
describe('decodeBmp — embedded payloads', () => {
  it('returns a BI_JPEG payload without decoding it', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 4, rows: [], rawPixels: jpeg,
    });
    const img = decodeBmp(bmp);
    expect(img.kind).toBe('embedded');
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('jpeg');
    expect(Array.from(img.payload)).toEqual(Array.from(jpeg));
  });

  it('returns a BI_PNG payload without decoding it', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 5, rows: [], rawPixels: png,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('png');
    expect(Array.from(img.payload)).toEqual(Array.from(png));
  });

  it('rejects an embedded payload with no bytes', () => {
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 4,
      rows: [], rawPixels: new Uint8Array(0),
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bmp.test.ts`
Expected: FAIL — three failures.

- [ ] **Step 3: Implement**

Extend the dispatch in `decodeBmp`, before the throw:

```ts
  // BI_JPEG and BI_PNG wrap a COMPLETE file. Slice it and name it; decoding it
  // here would give this module a dependency on JPEG for a case that needs none.
  if (h.compression === BI_JPEG || h.compression === BI_PNG) {
    const payload = data.subarray(h.offBits);
    if (payload.length === 0)
      throw new PdfParseError('BMP: embedded payload is empty');
    return {
      kind: 'embedded',
      format: h.compression === BI_JPEG ? 'jpeg' : 'png',
      payload,
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bmp.test.ts`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bmp.ts test/bmp.test.ts
git commit -m "feat(10u9.2): BMP BI_JPEG and BI_PNG payloads

The container wraps a complete JPEG or PNG file, so bmp.ts slices the payload
and names its format while imageembed.ts hands it to the builders that already
exist. Decoding it here would give a pure module a dependency on JPEG decoding
for the one case that needs none."
```

---

### Task 6: Wire BMP into `imageembed.ts`

**Files:**
- Modify: `src/imageembed.ts`
- Modify: `src/flow.ts:891`, `src/floatbox.ts:41`, `src/tableauthor.ts:154`
- Test: `test/bmp-embed.test.ts`

**Interfaces:**
- Consumes: `decodeBmp`, `BmpImage` from Tasks 1–5.
- Produces: `buildBmpXObject(img: BmpImage): BuiltImage`; `sniff` returns `'jpeg' | 'png' | 'bmp'`.

- [ ] **Step 1: Write the failing test**

Create `test/bmp-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName, isStream, isArray } from '../src/types.js';
import { buildBmp } from './helpers/build-bmp.js';

/** The one image XObject on page 1 of a freshly built document. */
function soleImage(doc: Document) {
  const page = doc.Pages[0];
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!res || !(res instanceof Map)) throw new Error('no resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!xo || !(xo instanceof Map)) throw new Error('no xobjects');
  const first = doc.resolve([...xo.values()][0]);
  if (!isStream(first)) throw new Error('not a stream');
  return first;
}

describe('AddImage — BMP', () => {
  it('embeds a 24-bit BMP as DeviceRGB', () => {
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 24,
      rows: [[0, 0, 0xff, 0, 0xff, 0, 0, 0], [0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0]],
    });
    const doc = Document.New();
    doc.AddPage();
    doc.Pages[0].AddImage(bmp, [0, 0, 100, 100]);
    const img = soleImage(doc);
    expect(img.dict.get('Width')).toBe(2);
    expect(img.dict.get('Height')).toBe(2);
    expect(img.dict.get('BitsPerComponent')).toBe(8);
    const cs = img.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    expect(img.dict.get('SMask')).toBeUndefined();
  });

  it('embeds a palette BMP as /Indexed, keeping its 4-bit samples packed', () => {
    const bmp = buildBmp({
      width: 4, height: 2, bpp: 4,
      palette: [[0, 0, 0xff], [0, 0xff, 0], [0xff, 0, 0], [0xff, 0xff, 0xff]],
      rows: [[0x01, 0x23, 0, 0], [0x32, 0x10, 0, 0]],
    });
    const doc = Document.New();
    doc.AddPage();
    doc.Pages[0].AddImage(bmp, [0, 0, 100, 100]);
    const img = soleImage(doc);
    expect(img.dict.get('BitsPerComponent')).toBe(4);
    const cs = doc.resolve(img.dict.get('ColorSpace'));
    if (!isArray(cs)) throw new Error('expected an /Indexed array');
    expect(isName(cs[0]) && (cs[0] as { name: string }).name).toBe('Indexed');
    expect(cs[2]).toBe(3);   // hival: 4 palette entries
  });

  it('gives a declared-alpha BMP an /SMask and a BGRX one none', () => {
    const withAlpha = buildBmp({
      width: 2, height: 1, bpp: 32, dibSize: 108, compression: 3,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
      rows: [[0xff, 0, 0, 0x80, 0, 0xff, 0, 0xff]],
    });
    const bgrx = buildBmp({
      width: 2, height: 1, bpp: 32,
      rows: [[0xff, 0, 0, 0, 0, 0xff, 0, 0]],
    });
    for (const [bytes, wantMask] of [[withAlpha, true], [bgrx, false]] as const) {
      const doc = Document.New();
      doc.AddPage();
      doc.Pages[0].AddImage(bytes, [0, 0, 100, 100]);
      expect(soleImage(doc).dict.has('SMask')).toBe(wantMask);
    }
  });

  it('unwraps a BMP wrapping a JPEG into a DCTDecode passthrough', () => {
    // A minimal baseline JPEG: SOI, SOF0 declaring 1x1 grayscale, EOI.
    const jpeg = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 24, compression: 4, rows: [], rawPixels: jpeg,
    });
    const doc = Document.New();
    doc.AddPage();
    doc.Pages[0].AddImage(bmp, [0, 0, 100, 100]);
    const img = soleImage(doc);
    const f = img.dict.get('Filter');
    expect(isName(f) && f.name).toBe('DCTDecode');
    expect(Array.from(img.raw)).toEqual(Array.from(jpeg));
  });

  it('survives a Save round trip', () => {
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 24,
      rows: [[0, 0, 0xff, 0, 0xff, 0, 0, 0], [0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0]],
    });
    const doc = Document.New();
    doc.AddPage();
    doc.Pages[0].AddImage(bmp, [0, 0, 100, 100]);
    const reopened = Document.Open(doc.Save());
    expect(soleImage(reopened).dict.get('Width')).toBe(2);
  });

  it('still refuses a format it does not know', () => {
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(Uint8Array.from([1, 2, 3, 4]), [0, 0, 10, 10]))
      .toThrow(/JPEG, PNG or BMP/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bmp-embed.test.ts`
Expected: FAIL — `UnsupportedFeatureError: AddImage: unrecognized image format`.

- [ ] **Step 3: Implement in `src/imageembed.ts`**

Add the import at the top:

```ts
import { decodeBmp, type BmpImage } from './bmp.js';
```

Replace `sniff` (currently at line 34):

```ts
/** Detect 'jpeg', 'png' or 'bmp' from leading magic bytes. */
function sniff(data: Uint8Array): 'jpeg' | 'png' | 'bmp' {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 &&
      data[2] === 0x4e && data[3] === 0x47) return 'png';
  // "BM" is only two bytes, far weaker magic than PNG's eight, so a known DIB
  // header size is required beside it -- otherwise any file beginning with
  // those bytes is claimed by the BMP path and fails deep inside the decoder
  // rather than here.
  if (data.length >= 18 && data[0] === 0x42 && data[1] === 0x4d) {
    const dib = data[14] | (data[15] << 8) | (data[16] << 16) | (data[17] << 24);
    if (dib === 12 || dib === 40 || dib === 52 || dib === 56 ||
        dib === 64 || dib === 108 || dib === 124) return 'bmp';
  }
  throw new UnsupportedFeatureError('AddImage: unrecognized image format (expected JPEG, PNG or BMP)');
}
```

Add `buildBmpXObject` next to `buildPngXObject`:

```ts
/** Map a decoded BMP raster onto an Image XObject, reusing the PNG path's parts. */
export function buildBmpXObject(img: BmpImage): BuiltImage {
  if (img.kind === 'embedded')
    return img.format === 'jpeg' ? buildJpegXObject(img.payload) : buildPngXObject(img.payload);
  if (img.kind === 'indexed') {
    const hival = Math.floor(img.palette.length / 3) - 1;
    const cs: PdfObject = [
      name('Indexed'), name('DeviceRGB'), hival,
      { kind: 'string', bytes: img.palette } as PdfObject,
    ];
    return { stream: imageStream(img.width, img.height, img.bpc, cs, flate(img.samples)) };
  }
  const stream = imageStream(img.width, img.height, 8, name('DeviceRGB'), flate(img.samples));
  if (!img.alpha) return { stream };
  const smask = imageStream(img.width, img.height, 8, name('DeviceGray'), flate(img.alpha));
  return { stream, smask };
}
```

Widen `AddImageOptions.format` (line 20) and `buildImageXObject` (line 90):

```ts
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp';
```

```ts
export function buildImageXObject(data: Uint8Array, format?: 'jpeg' | 'png' | 'bmp'): BuiltImage {
  const fmt = format ?? sniff(data);
  if (fmt === 'bmp') return buildBmpXObject(decodeBmp(data));
  return fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);
}
```

- [ ] **Step 4: Widen the three other option bags**

In `src/flow.ts:891`, `src/floatbox.ts:41` and `src/tableauthor.ts:154`, change each
`format?: 'jpeg' | 'png';` to `format?: 'jpeg' | 'png' | 'bmp';`. Leave the
surrounding doc comments alone except to say "JPEG, PNG or BMP" where they
currently say "JPEG/PNG".

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/bmp-embed.test.ts && npm run typecheck`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: green. Nothing outside `src/bmp.ts`, `src/imageembed.ts` and the three
option bags should have moved — a red test elsewhere is information, not a chore.

- [ ] **Step 7: Commit**

```bash
git add src/bmp.ts src/imageembed.ts src/flow.ts src/floatbox.ts src/tableauthor.ts test/bmp-embed.test.ts
git commit -m "feat(10u9.2): accept BMP in AddImage and every consumer of it

buildBmpXObject is a switch whose every arm reuses what the PNG path already
built -- imageStream, flate, and the /SMask shape colour type 6 produces -- so
the mapping needed no new machinery. Widening AddImageOptions.format and the
three other bags carrying that union is what gives page.AddImage,
flow.AddImage, cell.setImage, floating boxes and signature appearance images
BMP with no change of their own.

sniff() requires a known DIB header size beside the 'BM' magic. Two bytes is
far weaker magic than PNG's eight, and without the second test any file
beginning with them is claimed by the BMP path and fails deep inside the
decoder with a message about a header field rather than at the front door."
```

---

### Task 7: Mutation verification, docs, and the follow-up

The task that proves the rest. A fixture usually passes on the first run, and CLAUDE.md is explicit that this is not evidence.

**Files:**
- Modify: `test/bmp.test.ts` (findings header)
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the mutations**

For each, apply the change to `src/bmp.ts`, run `npx vitest run test/bmp.test.ts test/bmp-embed.test.ts`, record whether it went red, then revert with `git checkout -- src/bmp.ts`.

| # | Mutation | Where |
|---|---|---|
| 1 | Never flip rows: `const src = y;` | `eachRowTopDown` |
| 2 | Don't swap BGR: `out[o++] = src[s]; … out[o++] = src[s + 2];` | `decode24` |
| 3 | Copy the whole file stride: `out.set(src, y * outStride)` | `decodeIndexed` |
| 4 | Honour alpha always: `const ac = channelOf(am) ?? { shift: 24, max: 255 };` | `decodePacked` |
| 5 | Compute the pixel offset: `h.offBits` → `h.afterHeader` | `eachRowTopDown` |
| 6 | Read V2 masks from after the header: drop the `h.dibSize >= DIB_V2` branch | `readMasks` |
| 7 | Palette entry always 4: `const entry = 4;` | `readPalette` |
| 8 | Truncate instead of rounding: `Math.floor((v * 255) / max)` | `scale8` |

- [ ] **Step 2: Write the findings into the test header**

Add at the top of `test/bmp.test.ts`, filling in the measured results. Name anything the suite does **not** catch rather than claiming coverage the measurement does not support — mutation 8 in particular may well stay green, since rounding and truncation agree at every 5- and 6-bit value and differ only where a mask width the fixtures do not use is involved.

```ts
/**
 * WHAT THESE FIXTURES COVER, measured by mutation rather than assumed. Each
 * change below was applied to src/bmp.ts in turn and both BMP test files
 * re-run:
 *
 *   1 no row flip                 <RED/GREEN, n cases>
 *   2 no BGR swap                 <...>
 *   3 file stride copied whole    <...>
 *   4 alpha honoured always       <...>
 *   5 pixel offset computed       <...>
 *   6 V2 masks read after header  <...>
 *   7 palette entry always 4      <...>
 *   8 truncate instead of round   <...>
 *
 * Fixture traps this file is built around, all three of which make an
 * assertion pass whatever the code does: a vertically symmetric image cannot
 * see the row flip, a grey image cannot see the BGR swap, and a square image
 * cannot see a width/height transposition. Every fixture here is asymmetric,
 * non-grey and -- from ANCHOR_32 onward -- non-square.
 */
```

- [ ] **Step 3: Commit the findings**

```bash
git add test/bmp.test.ts
git commit -m "test(10u9.2): mutation findings for the BMP decoder"
```

- [ ] **Step 4: Update the README**

Three edits.

Features list, the image-insertion bullet — after the PNG clause, add:

```markdown
or a BMP (`FlateDecode`; 1/2/4/8-bit palettes kept as `/Indexed`, 16/24/32-bit, `BI_BITFIELDS`, RLE4/RLE8, and a `BI_JPEG`/`BI_PNG` payload unwrapped to its own route)
```

API overview, the `page.AddImage` row — change "Embed and paint a JPEG/PNG raster" to "Embed and paint a JPEG, PNG or BMP raster". Do the same for the `flow.AddImage` row.

Limitations, the entry beginning "**Image insertion is JPEG/PNG only**" — replace it wholesale:

```markdown
- **Image insertion is JPEG, PNG and BMP** — `AddImage` accepts JPEG (`DCTDecode`, including CMYK), PNG (`FlateDecode`, including interlaced/Adam7 and palette `tRNS`) and BMP (decoded to samples and stored as `FlateDecode`; the saved file carries no trace of having been a BMP). Still unsupported: 16-bit-with-alpha PNG, grayscale/RGB `tRNS` color-key masks, interlaced PNG below 8-bit, and palette `tRNS` below 8-bit. For BMP, an embedded ICC profile in a V5 header is ignored and the image read as sRGB; and a V4/V5 file that *declares* an alpha mask and then writes zeros everywhere renders fully transparent — that is the producer contradicting itself, and honouring the declaration is the reading the format supports. Other raster formats remain out of scope.
```

- [ ] **Step 5: Update the CHANGELOG**

Add under `## [Unreleased]`, in **Added**, above the grayscale entry:

```markdown
- **`AddImage` accepts BMP** — Windows bitmaps alongside JPEG and PNG, everywhere an image goes in: `page.AddImage`, `flow.AddImage`, `cell.setImage`, a floating box, a signature appearance. BMP is not a PDF construct — there is no `BMPDecode` filter — so a bitmap is decoded to samples at embed time and stored as `FlateDecode`, and the saved file carries no trace of having been one. The decoder is a pure module whose only repo import is the error vocabulary, so every bit depth, mask rule and RLE escape is testable from raw bytes with no document in sight. A palette image keeps its indices as `/Indexed` rather than expanding to RGB: lossless, smaller by up to 24×, and the only route that works at 1, 2 and 4 bits per component, where the samples are still packed several pixels to a byte. Covered: `BITMAPCOREHEADER` through `BITMAPV5HEADER` including OS/2 v2, 1/2/4/8-bit palettes, 16-bit RGB555 and `BI_BITFIELDS`, 24-bit, 32-bit BGRX and BGRA, RLE4 and RLE8, both row orders, and a `BI_JPEG`/`BI_PNG` payload unwrapped and handed to the existing builders. The decision that will look like a bug and is not: the fourth byte of a 32-bpp pixel becomes an `/SMask` only when the header *declares* alpha, because that padding is very commonly zero across a whole image and honouring it unconditionally yields a picture that is drawn, structurally correct and completely invisible. (`10u9.2`)
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(10u9.2): README and changelog for BMP input"
```

- [ ] **Step 8: File the follow-up and close**

```bash
bd create "Real-producer BMP fixtures in test/fixtures/bmp/" \
  -p 3 --parent aspose-pdf-foss-for-ts-10u9 -l gap-vs-go \
  -d "The BMP decoder is anchored on the two published hex dumps transcribed into test/bmp.test.ts, because no image tooling was available when it was written (magick, python and ffmpeg all absent). Add a fixtures directory with BMPs from real producers -- Paint, GIMP, ImageMagick -- and a PROVENANCE.md recording producer, version, SHA-256 and what each covers, matching fixtures/jpeg and fixtures/pdfx. See docs/superpowers/specs/2026-08-21-bmp-decode-design.md."

bd close aspose-pdf-foss-for-ts-10u9.2
```

---

## Self-Review

**Spec coverage.** Module layout and the `BmpImage` union → Task 1. Container
rules, `bfOffBits`, row order, stride → Task 1. Palette route and entry size →
Task 2. The pixel matrix's 16/32-bit rows, mask location, channel expansion and
the alpha rule → Task 3. RLE → Task 4. Embedded payloads → Task 5. Detection,
the PDF mapping, the widened union → Task 6. Errors are spread across the tasks
that raise them, each with its own assertion. Testing strategy, both anchors,
the fixture traps and mutation verification → Tasks 1, 3 and 7. Documentation
and the non-goal that becomes an issue → Task 7. The pixel-count bound is in
Task 1's `parseBmpHeader`. Nothing in the spec is unimplemented.

**Type consistency.** `BmpImage`, `BmpHeader`, `decodeBmp`, `parseBmpHeader`,
`fileStride`, `packedStride`, `eachRowTopDown`, `readPalette`, `decodeIndexed`,
`readMasks`, `channelOf`, `scale8`, `decodePacked`, `decodeRle`,
`decode24`, `buildBmpXObject`, `buildBmp`, `BuildBmpOptions` are each defined
once and referenced under exactly that name throughout. `decodeIndexed`'s
optional second parameter is introduced in Task 2 and used by Task 4, which is
why Task 2 declares it rather than Task 4 adding it.

**Three defects found and fixed during this review, each of which would have
cost the implementer a debugging session:**

1. Task 2's "defaults the palette length to `1 << bpp`" fixture originally
   wrote four palette entries while claiming sixteen, so `readPalette`'s
   own bounds check would have thrown `PdfParseError` and the test would have
   failed for a reason unrelated to what it was testing. The fixture now
   contains all sixteen entries.
2. Task 3's channel-expansion fixture originally used a full-scale value,
   which rounding, truncation and bit replication all map to 255 — it could
   not distinguish the three rules it was named for. It now uses 5-bit 3,
   where rounding gives 25 and both other rules give 24, and a separate case
   keeps the full-scale assertion for its own sake.
3. Task 4 carried a stray `T.` in a doc comment plus a step to remove it.
   Both are gone.

**Every mutation in Task 7 is now expected to redden something**, mutation 8
included, because fix 2 gave it a fixture that separates the rules. Record what
actually happens rather than this prediction — if 8 comes back green, the
fixture is not doing what this review claims and that is worth knowing.
