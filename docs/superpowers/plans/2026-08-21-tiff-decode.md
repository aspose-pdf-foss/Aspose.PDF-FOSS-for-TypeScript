# TIFF Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddImage(tiffBytes, rect)` embeds a TIFF, alongside the JPEG, PNG and BMP this library already accepts.

**Architecture:** A new leaf `src/rasterimage.ts` holds the `RasterImage` vocabulary that `src/bmp.ts` and the new `src/tiff.ts` both produce, and `imageembed.ts` maps in one place. `tiff.ts` is container work — byte order, the IFD chain, strip/tile assembly — feeding codecs that already exist and are already tested: `decodeCcitt`, `lzwDecode`, `runLengthDecode`, `applyPredictor`, `decodeJpeg` and `node:zlib`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-tiff-decode-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext, `strict` TypeScript.** Every import specifier carries `.js`.
- **`src/rasterimage.ts` imports NOTHING.** It is a type-only leaf; that is what lets both decoders depend on it without a cycle.
- **`src/tiff.ts` imports `./errors.js` and the codec modules only** — no `types.ts`, no `document.ts`, no PDF knowledge.
- **All TIFF integers are little-endian for `II` and big-endian for `MM`.** There is exactly one reader; nothing reads a multi-byte value directly.
- **Errors are the repo's public types**: `PdfParseError` for damage, `UnsupportedFeatureError` for declined shapes.
- **Both `npm run typecheck` and `npm test` must be green before the issue closes.**
- **`test/bmp.test.ts` and `test/bmp-embed.test.ts` must remain BYTE-IDENTICAL** through Task 1. Neither names `BmpImage` or `buildBmpXObject`, so the rename is invisible to them — if either has to change, the refactor altered behaviour and that is the finding, not a chore.
- **Update `CHANGELOG.md` under `## [Unreleased]`** in the same commit as the user-visible change (Task 10).
- **Issue id for commit messages:** `10u9.3`.

---

### Task 1: `rasterimage.ts`, and the BMP rename

A pure refactor. No behaviour changes, and the BMP tests prove it.

**Files:**
- Create: `src/rasterimage.ts`
- Modify: `src/bmp.ts`, `src/imageembed.ts`

**Interfaces:**
- Produces: `RasterImage` (five arms, below); `decodeBmp(data): RasterImage`; `buildRasterXObject(img: RasterImage): BuiltImage`.

- [ ] **Step 1: Create the leaf**

Create `src/rasterimage.ts`:

```ts
/**
 * A decoded raster, ready to become a PDF image XObject.
 *
 * Produced by every image-input decoder in this repo (`bmp.ts`, `tiff.ts`) and
 * consumed in exactly one place, `imageembed.ts`'s `buildRasterXObject`. It is
 * a type-only leaf and imports nothing, which is what lets both decoders
 * depend on it without a cycle and what keeps either of them free of PDF
 * knowledge.
 *
 * Rows are TOP-DOWN and padded to a byte boundary only -- never a format's own
 * row stride -- so `samples` can be handed to a PDF image stream unchanged.
 */
export type RasterImage =
  | {
      kind: 'indexed';
      width: number; height: number;
      /** 1, 2, 4 or 8. The samples stay packed at this depth. */
      bpc: 1 | 2 | 4 | 8;
      /** RGB triples, 8 bits each. */
      palette: Uint8Array;
      samples: Uint8Array;
    }
  | {
      kind: 'gray';
      width: number; height: number;
      bpc: 1 | 2 | 4 | 8;
      /** DeviceGray convention: 0 is BLACK. A format saying otherwise -- TIFF's
       *  WhiteIsZero, `decodeCcitt`'s documented 0-is-white output -- is
       *  normalized by its decoder, once, before building this. */
      samples: Uint8Array;
      /** One byte per pixel, straight (NOT premultiplied) alpha. */
      alpha?: Uint8Array;
    }
  | {
      kind: 'rgb';
      width: number; height: number;
      /** 8-bit RGB triples. */
      samples: Uint8Array;
      /** One byte per pixel, straight (NOT premultiplied) alpha. */
      alpha?: Uint8Array;
    }
  | {
      kind: 'cmyk';
      width: number; height: number;
      /** 8-bit CMYK quadruples. */
      samples: Uint8Array;
    }
  | { kind: 'embedded'; format: 'jpeg' | 'png'; payload: Uint8Array };
```

- [ ] **Step 2: Point `bmp.ts` at it**

In `src/bmp.ts`, delete the whole `export type BmpImage = ...` block and replace it with:

```ts
import type { RasterImage } from './rasterimage.js';
```

placed under the existing `errors.js` import. Then replace every occurrence of
`BmpImage` with `RasterImage` — the return types of `decode24`, `decodeIndexed`,
`decodePacked` and `decodeBmp`. There are no other uses.

- [ ] **Step 3: Rename the builder in `imageembed.ts`**

Change the import at line 15 to:

```ts
import { decodeBmp } from './bmp.js';
import type { RasterImage } from './rasterimage.js';
```

Rename `buildBmpXObject` to `buildRasterXObject`, change its parameter type to
`RasterImage`, and add the two new arms. The full function:

```ts
/** Map a decoded raster onto an Image XObject.
 *
 *  The single owner of "which PDF colour space is this" for every image INPUT
 *  format. Two copies of this switch is how a BMP and a TIFF holding the same
 *  picture come to embed differently. */
export function buildRasterXObject(img: RasterImage): BuiltImage {
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
  if (img.kind === 'cmyk')
    return { stream: imageStream(img.width, img.height, 8, name('DeviceCMYK'), flate(img.samples)) };

  const gray = img.kind === 'gray';
  const bpc = gray ? img.bpc : 8;
  const cs = name(gray ? 'DeviceGray' : 'DeviceRGB');
  const stream = imageStream(img.width, img.height, bpc, cs, flate(img.samples));
  if (!img.alpha) return { stream };
  const smask = imageStream(img.width, img.height, 8, name('DeviceGray'), flate(img.alpha));
  return { stream, smask };
}
```

Update the one call site (currently `buildBmpXObject(decodeBmp(data))`) to
`buildRasterXObject(decodeBmp(data))`.

- [ ] **Step 4: Run the BMP fence**

Run: `git diff --stat test/` — expected: **no output**. Neither BMP test file may change.
Run: `npx vitest run test/bmp.test.ts test/bmp-embed.test.ts && npm run typecheck`
Expected: PASS, 38 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/rasterimage.ts src/bmp.ts src/imageembed.ts
git commit -m "refactor(10u9.3): extract RasterImage into a leaf both decoders produce

10u9.2 defined BmpImage minimally and recorded that it would be generalized
when a second caller existed rather than before; TIFF is that caller. The type
moves to rasterimage.ts and grows a gray and a cmyk arm -- both TIFF-only,
since BMP's grayscale is a grey palette that /Indexed carries exactly, which
is precisely why the type had to move rather than be widened in a module that
cannot produce those colour models.

buildBmpXObject becomes buildRasterXObject: one owner for 'which PDF colour
space is this' across every image input format, because two copies is how a
BMP and a TIFF holding the same picture come to embed differently.

Behaviour-neutral, and the fence is exact: neither BMP test file names
BmpImage or buildBmpXObject, so both stay byte-identical and green."
```

---

### Task 2: The container — endian reader, IFD chain, `tiffPageCount`

**Files:**
- Create: `src/tiff.ts`, `test/helpers/build-tiff.ts`
- Test: `test/tiff.test.ts`

**Interfaces:**
- Produces: `decodeTiff(data, page?): RasterImage`, `tiffPageCount(data): number`, and internally `TiffReader`, `readIfd`, `ifdOffsets`, `tagNums`, `tag1`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-tiff.ts`:

```ts
/**
 * Synthesize TIFF files for the decoder tests, in EITHER byte order.
 *
 * Deliberately dumb: it lays bytes out from the caller's numbers and decodes
 * nothing, so it cannot "agree" with the decoder about a misreading. Building
 * the same image as `II` and as `MM` and asserting the two decode identically
 * is the one differential available for this format -- see the note in
 * test/tiff.test.ts about TIFF having no published hex dump to anchor on.
 */
export interface TiffTag {
  tag: number;
  /** 1 BYTE, 3 SHORT, 4 LONG. Other types are not needed by the decoder. */
  type: 1 | 3 | 4;
  values: number[];
}

export interface BuildTiffOptions {
  /** false writes "MM" (big-endian). Default true. */
  le?: boolean;
  /** One entry per image (IFD). Each is its tag list plus its pixel blocks. */
  pages: Array<{ tags: TiffTag[]; blocks: Uint8Array[] }>;
  /**
   * Tag receiving each page's block offsets. 273 = StripOffsets (default),
   * 324 = TileOffsets.
   */
  offsetsTag?: number;
  /** Tag receiving each page's block byte counts. 279 default, 325 for tiles. */
  countsTag?: number;
}

const SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4 };

export function buildTiff(o: BuildTiffOptions): Uint8Array {
  const le = o.le ?? true;
  const offsetsTag = o.offsetsTag ?? 273;
  const countsTag = o.countsTag ?? 279;

  const parts: number[] = [];
  const put8 = (v: number) => { parts.push(v & 0xff); };
  const put16 = (v: number) => {
    if (le) { put8(v); put8(v >> 8); } else { put8(v >> 8); put8(v); }
  };
  const put32 = (v: number) => {
    if (le) { put16(v & 0xffff); put16(v >>> 16); }
    else { put16(v >>> 16); put16(v & 0xffff); }
  };
  const patch32 = (at: number, v: number) => {
    const b = le
      ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    b.forEach((x, i) => { parts[at + i] = x; });
  };

  put8(le ? 0x49 : 0x4d); put8(le ? 0x49 : 0x4d);
  put16(42);
  const firstIfdAt = parts.length;
  put32(0);

  // Blocks first, so their offsets are known when the IFDs are written.
  const blockPos: number[][] = [];
  for (const p of o.pages) {
    const positions: number[] = [];
    for (const b of p.blocks) {
      positions.push(parts.length);
      for (const x of b) put8(x);
      if (parts.length & 1) put8(0);           // keep IFDs word-aligned
    }
    blockPos.push(positions);
  }

  let prevNextAt = firstIfdAt;
  o.pages.forEach((p, pi) => {
    const tags: TiffTag[] = [
      ...p.tags,
      { tag: offsetsTag, type: 4, values: blockPos[pi] },
      { tag: countsTag, type: 4, values: p.blocks.map((b) => b.length) },
    ].sort((a, b) => a.tag - b.tag);          // TIFF requires ascending tags

    // Out-of-line values are written after the IFD; reserve their patch sites.
    const ifdAt = parts.length;
    patch32(prevNextAt, ifdAt);
    put16(tags.length);
    const patchSites: Array<{ at: number; t: TiffTag }> = [];
    for (const t of tags) {
      put16(t.tag); put16(t.type); put32(t.values.length);
      const bytes = SIZE[t.type] * t.values.length;
      if (bytes <= 4) {
        // Inline and LEFT-justified: the value starts at the field's first byte.
        const before = parts.length;
        for (const v of t.values) {
          if (t.type === 1) put8(v); else if (t.type === 3) put16(v); else put32(v);
        }
        while (parts.length - before < 4) put8(0);
      } else {
        patchSites.push({ at: parts.length, t });
        put32(0);
      }
    }
    prevNextAt = parts.length;
    put32(0);
    for (const { at, t } of patchSites) {
      patch32(at, parts.length);
      for (const v of t.values) {
        if (t.type === 1) put8(v); else if (t.type === 3) put16(v); else put32(v);
      }
      if (parts.length & 1) put8(0);
    }
  });

  return Uint8Array.from(parts);
}

/** The tags every fixture needs. `photometric` has no default in TIFF. */
export function baseTags(
  width: number, height: number, photometric: number,
  extra: TiffTag[] = [],
): TiffTag[] {
  return [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 262, type: 3, values: [photometric] },
    ...extra,
  ];
}
```

- [ ] **Step 2: Write the failing test**

Create `test/tiff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';

/**
 * NOTE ON ANCHORING, recorded rather than papered over. Unlike BMP, which had
 * two published annotated hex dumps to transcribe (see test/bmp.test.ts), TIFF
 * has no equivalent, so this file's CONTAINER expectations are hand-computed
 * against our own builder -- encoder-versus-decoder inside one repo, which
 * proves less than it looks.
 *
 * Two things mitigate it. The payload codecs are all existing repo code with
 * their own suites and real-world fixtures (ccitt.ts, lzw.ts, flate, jpeg.ts,
 * PackBits); what is new here is only the container. And an `II` file and an
 * `MM` file encoding the same image must decode identically -- the two take
 * different paths through the reader, so a shared builder bug cannot make them
 * agree. Real-producer fixtures are filed as a follow-up.
 */

/** A 2x2 8-bit BlackIsZero gray image: one strip, four bytes. */
function grayTiff(le: boolean): Uint8Array {
  return buildTiff({
    le,
    pages: [{
      tags: baseTags(2, 2, 1, [
        { tag: 258, type: 3, values: [8] },     // BitsPerSample
        { tag: 277, type: 3, values: [1] },     // SamplesPerPixel
        { tag: 278, type: 4, values: [2] },     // RowsPerStrip
      ]),
      blocks: [Uint8Array.from([0x10, 0x20, 0x30, 0x40])],
    }],
  });
}

describe('tiff container', () => {
  it('decodes a little-endian file', () => {
    const img = decodeTiff(grayTiff(true));
    expect(img.kind).toBe('gray');
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(img.bpc).toBe(8);
    expect(Array.from(img.samples)).toEqual([0x10, 0x20, 0x30, 0x40]);
  });

  it('decodes a big-endian file to exactly the same raster', () => {
    // The differential: MM and II take different paths through the reader, so
    // a shared bug in the builder cannot make these agree.
    const a = decodeTiff(grayTiff(true));
    const b = decodeTiff(grayTiff(false));
    if (a.kind !== 'gray' || b.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(b.samples)).toEqual(Array.from(a.samples));
    expect([b.width, b.height, b.bpc]).toEqual([a.width, a.height, a.bpc]);
  });

  it('reads a value of four bytes or fewer inline, not as an offset', () => {
    // ImageWidth is one LONG = 4 bytes, so it is stored IN the entry. Reading
    // it as a file offset lands somewhere plausible and decodes garbage.
    const img = decodeTiff(grayTiff(true));
    expect(img.width).toBe(2);
  });

  it('reads a value of more than four bytes from its offset', () => {
    // Three SHORTs = 6 bytes, so BitsPerSample goes out of line.
    const bmp = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] },
          { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4, 5, 6])],
      }],
    });
    const img = decodeTiff(bmp);
    expect(img.kind).toBe('rgb');
  });

  it('counts the images in a multi-page file', () => {
    const two = buildTiff({
      pages: [
        {
          tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] },
          ]),
          blocks: [Uint8Array.from([1, 2, 3, 4])],
        },
        {
          tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] },
          ]),
          blocks: [Uint8Array.from([9, 8, 7, 6])],
        },
      ],
    });
    expect(tiffPageCount(two)).toBe(2);
    const p1 = decodeTiff(two, 1);
    if (p1.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(p1.samples)).toEqual([9, 8, 7, 6]);
  });

  it('refuses a page index past the end', () => {
    expect(() => decodeTiff(grayTiff(true), 1)).toThrow(UnsupportedFeatureError);
  });

  it('rejects a file that is not a TIFF', () => {
    expect(() => decodeTiff(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toThrow(PdfParseError);
  });

  it('rejects BigTIFF', () => {
    const t = grayTiff(true);
    t[2] = 43; t[3] = 0;
    expect(() => decodeTiff(t)).toThrow(/BigTIFF/);
  });

  it('rejects a cyclic IFD chain rather than hanging', () => {
    // Point the first IFD's next-IFD pointer back at itself.
    const t = grayTiff(true);
    const ifdAt = t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24);
    const count = t[ifdAt] | (t[ifdAt + 1] << 8);
    const nextAt = ifdAt + 2 + count * 12;
    t[nextAt] = ifdAt & 0xff; t[nextAt + 1] = (ifdAt >> 8) & 0xff;
    t[nextAt + 2] = (ifdAt >> 16) & 0xff; t[nextAt + 3] = (ifdAt >> 24) & 0xff;
    expect(() => tiffPageCount(t)).toThrow(PdfParseError);
  });

  it('rejects an IFD offset outside the file', () => {
    const t = grayTiff(true);
    t[4] = 0xff; t[5] = 0xff; t[6] = 0; t[7] = 0;
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });

  it('rejects a file with no PhotometricInterpretation', () => {
    const t = buildTiff({
      pages: [{
        tags: [
          { tag: 256, type: 4, values: [2] }, { tag: 257, type: 4, values: [2] },
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ],
        blocks: [Uint8Array.from([1, 2, 3, 4])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/PhotometricInterpretation/);
  });

  it('treats a missing RowsPerStrip as one strip covering the image', () => {
    // The default is 2^32-1, i.e. the whole image. Defaulting it to 0 or 1
    // breaks every single-strip file, which is most of them.
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x10, 0x20, 0x30, 0x40])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x10, 0x20, 0x30, 0x40]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tiff.js"`.

- [ ] **Step 4: Write the container**

Create `src/tiff.ts`:

```ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import type { RasterImage } from './rasterimage.js';

/** Tags this decoder reads. Numbers are TIFF 6.0's. */
const T_WIDTH = 256, T_HEIGHT = 257, T_BPS = 258, T_COMPRESSION = 259;
const T_PHOTOMETRIC = 262, T_FILLORDER = 266, T_STRIP_OFFSETS = 273;
const T_SAMPLES = 277, T_ROWS_PER_STRIP = 278, T_STRIP_COUNTS = 279;
const T_PLANAR = 284, T_T4OPTIONS = 292, T_PREDICTOR = 317, T_COLORMAP = 320;
const T_TILE_WIDTH = 322, T_TILE_LENGTH = 323;
const T_TILE_OFFSETS = 324, T_TILE_COUNTS = 325;
const T_EXTRA_SAMPLES = 338, T_JPEG_TABLES = 347;

/** Bytes per value for each TIFF field type. 0 marks one we do not read. */
const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

/** Refuse a raster whose pixel count cannot plausibly be allocated. */
const MAX_PIXELS = 1 << 28;
/** A file with more images than this is damage, not a document. */
const MAX_PAGES = 4096;

/**
 * Every multi-byte read in this module goes through one of these.
 *
 * TIFF is the first format here that is not fixed-endian: `II` files are
 * little-endian and `MM` big-endian, and a large share of real files are `MM`.
 * A second read site that assumes an order misreads such a file completely and
 * silently -- which is why the reader is an object threaded everywhere rather
 * than a pair of free functions.
 */
class TiffReader {
  constructor(readonly d: Uint8Array, readonly le: boolean) {}
  u16(o: number): number {
    if (o + 1 >= this.d.length) throw new PdfParseError('TIFF: read past end of file');
    return this.le ? this.d[o] | (this.d[o + 1] << 8) : (this.d[o] << 8) | this.d[o + 1];
  }
  u32(o: number): number {
    if (o + 3 >= this.d.length) throw new PdfParseError('TIFF: read past end of file');
    const [a, b, c, e] = [this.d[o], this.d[o + 1], this.d[o + 2], this.d[o + 3]];
    return (this.le ? a | (b << 8) | (c << 16) | (e << 24)
                    : (a << 24) | (b << 16) | (c << 8) | e) >>> 0;
  }
}

/** A parsed IFD: tag -> its values, flattened to numbers. */
export type Ifd = Map<number, number[]>;

function openTiff(data: Uint8Array): TiffReader {
  if (data.length < 8) throw new PdfParseError('TIFF: file is too short');
  const le = data[0] === 0x49 && data[1] === 0x49;
  const be = data[0] === 0x4d && data[1] === 0x4d;
  if (!le && !be) throw new PdfParseError('TIFF: missing "II" or "MM" byte-order mark');
  const r = new TiffReader(data, le);
  const magic = r.u16(2);
  if (magic === 43) throw new UnsupportedFeatureError('TIFF: BigTIFF is not supported');
  if (magic !== 42) throw new PdfParseError(`TIFF: bad magic ${magic}`);
  return r;
}

/** Walk the IFD chain, guarding against a file that points one at itself. */
function ifdOffsets(r: TiffReader): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  let at = r.u32(4);
  while (at !== 0) {
    if (at + 2 > r.d.length) throw new PdfParseError(`TIFF: IFD offset ${at} outside the file`);
    if (seen.has(at)) throw new PdfParseError('TIFF: cyclic IFD chain');
    if (out.length >= MAX_PAGES) throw new PdfParseError('TIFF: too many images');
    seen.add(at);
    out.push(at);
    const count = r.u16(at);
    at = r.u32(at + 2 + count * 12);
  }
  if (out.length === 0) throw new PdfParseError('TIFF: no images');
  return out;
}

function readIfd(r: TiffReader, at: number): Ifd {
  const count = r.u16(at);
  const ifd: Ifd = new Map();
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    const tag = r.u16(e), type = r.u16(e + 2), n = r.u32(e + 4);
    const size = TYPE_SIZE[type];
    if (!size) continue;                       // a type we never read
    const bytes = size * n;
    // A value of four bytes or fewer is stored INLINE in the entry, left-
    // justified. Read as an offset it lands somewhere plausible in the file and
    // the image decodes to garbage with no error raised anywhere.
    const base = bytes <= 4 ? e + 8 : r.u32(e + 8);
    if (bytes > 4 && base + bytes > r.d.length)
      throw new PdfParseError(`TIFF: tag ${tag} value at ${base} outside the file`);
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      const o = base + k * size;
      vals.push(size === 1 ? r.d[o] : size === 2 ? r.u16(o) : r.u32(o));
    }
    ifd.set(tag, vals);
  }
  return ifd;
}

/** All values of a tag, or `dflt` when it is absent. */
function tagNums(ifd: Ifd, tag: number, dflt: number[]): number[] {
  const v = ifd.get(tag);
  return v && v.length ? v : dflt;
}
/** The first value of a tag, or `dflt` when it is absent. */
function tag1(ifd: Ifd, tag: number, dflt: number): number {
  const v = ifd.get(tag);
  return v && v.length ? v[0] : dflt;
}

export function tiffPageCount(data: Uint8Array): number {
  return ifdOffsets(openTiff(data)).length;
}

export function decodeTiff(data: Uint8Array, page = 0): RasterImage {
  const r = openTiff(data);
  const offsets = ifdOffsets(r);
  if (!Number.isInteger(page) || page < 0 || page >= offsets.length)
    throw new UnsupportedFeatureError(
      `TIFF: page ${page} out of range (file has ${offsets.length})`);
  return decodeIfd(r, readIfd(r, offsets[page]));
}

function decodeIfd(r: TiffReader, ifd: Ifd): RasterImage {
  const width = tag1(ifd, T_WIDTH, 0);
  const height = tag1(ifd, T_HEIGHT, 0);
  if (width <= 0 || height <= 0)
    throw new PdfParseError(`TIFF: bad dimensions ${width}x${height}`);
  if (width * height > MAX_PIXELS)
    throw new PdfParseError(`TIFF: ${width}x${height} exceeds the pixel bound`);
  if (!ifd.has(T_PHOTOMETRIC))
    throw new PdfParseError('TIFF: no PhotometricInterpretation');
  const photometric = tag1(ifd, T_PHOTOMETRIC, 0);
  const spp = tag1(ifd, T_SAMPLES, 1);
  const bps = tagNums(ifd, T_BPS, [1])[0];
  if (tag1(ifd, T_PLANAR, 1) !== 1)
    throw new UnsupportedFeatureError('TIFF: PlanarConfiguration 2 is not supported');

  // Assembled below; Task 3 fills this in.
  return assemble(r, ifd, { width, height, photometric, spp, bps });
}

/** Geometry and tags the block loop and the photometric mapping both need. */
export interface TiffPlan {
  width: number; height: number; photometric: number; spp: number; bps: number;
}

function assemble(_r: TiffReader, _ifd: Ifd, p: TiffPlan): RasterImage {
  throw new UnsupportedFeatureError(
    `TIFF: photometric ${p.photometric} is not supported`);
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/tiff.test.ts`
Expected: the container cases about damage PASS; the six that decode an image
FAIL with `TIFF: photometric ... is not supported`. That is correct for this
task — Task 3 makes them pass.

- [ ] **Step 6: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts test/helpers/build-tiff.ts
git commit -m "feat(10u9.3): TIFF container -- byte order, IFD chain, page count

TIFF is the first image format here that is not fixed-endian, so every
multi-byte read goes through one TiffReader threaded everywhere rather than a
pair of free functions: a second read site assuming an order misreads every MM
file completely and silently, and a large share of real files are MM. The
builder writes both orders and the two must decode identically, which is the
one differential a shared builder bug cannot fake.

Three container rules are guarded because each decodes into something
plausible rather than failing: a value of four bytes or fewer is INLINE and
left-justified, and read as an offset it lands somewhere plausible in the
file; the IFD chain is cycle-guarded, since a file may point one at itself and
tiffPageCount would never return; and every out-of-line value offset is
bounds-checked.

The image cases fail with 'photometric not supported' until the next task."
```

---

### Task 3: Uncompressed strips, photometric mapping, palette

**Files:**
- Modify: `src/tiff.ts`, `test/tiff.test.ts`

**Interfaces:**
- Consumes: `TiffReader`, `Ifd`, `tagNums`, `tag1`, `TiffPlan` from Task 2.
- Produces: `blockList`, `assemble` filled in; `packedStride`.

- [ ] **Step 1: Write the failing test**

Append to `test/tiff.test.ts`:

```ts
describe('tiff photometric routes', () => {
  it('reads BlackIsZero gray as DeviceGray without inverting', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x00, 0x40]), Uint8Array.from([0x80, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x00, 0x40, 0x80, 0xff]);
  });

  it('inverts WhiteIsZero gray into DeviceGray', () => {
    // Photometric 0 says 0 is WHITE; DeviceGray says 0 is BLACK. Normalizing
    // in neither place, or in two, yields a photographic negative -- which
    // reads as a bad scan rather than as a decoder bug.
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 0, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([0x00, 0x40, 0x80, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0xbf, 0x7f, 0x00]);
  });

  it('reads RGB', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0xff, 0, 0, 0, 0xff, 0])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(img.alpha).toBeUndefined();
  });

  it('reads CMYK', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 5, [
          { tag: 258, type: 3, values: [8, 8, 8, 8] }, { tag: 277, type: 3, values: [4] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x11, 0x22, 0x33, 0x44])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'cmyk') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it('reads a palette image, de-planarizing and scaling the ColorMap', () => {
    // ColorMap is three CONSECUTIVE PLANES -- all reds, then all greens, then
    // all blues -- of 16-bit values, NOT interleaved RGB triples and NOT 0..255.
    // Read as triples it gives a plausible wrong palette; read as low bytes it
    // gives a nearly black one.
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 1, 3, [
          { tag: 258, type: 3, values: [2] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] },
          { tag: 320, type: 3, values: [
            0xffff, 0x0000, 0x0000, 0x0000,   // reds
            0x0000, 0xffff, 0x0000, 0x0000,   // greens
            0x0000, 0x0000, 0xffff, 0x0000,   // blues
          ] },
        ]),
        blocks: [Uint8Array.from([0b00011011])],   // indices 0,1,2,3
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(2);
    expect(Array.from(img.samples)).toEqual([0b00011011]);
    expect(Array.from(img.palette)).toEqual([
      0xff, 0, 0,  0, 0xff, 0,  0, 0, 0xff,  0, 0, 0,
    ]);
  });

  it('assembles multiple strips in order', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 4, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses RGB at a bit depth other than 8', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [4, 4, 4] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0, 0, 0])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });

  it('refuses PlanarConfiguration 2', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] }, { tag: 284, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4, 5, 6])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/PlanarConfiguration/);
  });

  it('rejects a strip shorter than its geometry needs', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3])],       // needs 8
      }],
    });
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — the new cases plus the six from Task 2, all with
`photometric ... is not supported` or similar.

- [ ] **Step 3: Implement**

In `src/tiff.ts`, replace the `TiffPlan` interface and the stub `assemble`
with the following, and add the imports at the top of the file.

```ts
/** Bytes per row for `width` pixels of `bits` total bits each, byte-padded. */
export function packedStride(width: number, bits: number): number {
  return Math.ceil((width * bits) / 8);
}

/** One independently compressed rectangle of the image. */
interface Block { off: number; len: number; x: number; y: number; w: number; h: number }

/** Geometry and tags the block loop and the photometric mapping both need. */
export interface TiffPlan {
  width: number; height: number; photometric: number; spp: number; bps: number;
  compression: number; predictor: number; fillOrder: number;
  blocks: Block[];
  /** The block's own width in pixels -- the TILE width, padded, when tiled. */
  blockW: number;
  tiled: boolean;
}

/**
 * Strips and tiles are one thing: a rectangular block of the image, separately
 * compressed. They differ only in where each block's geometry comes from.
 *
 * A partial edge TILE still contains a FULL tile of data -- TIFF pads to the
 * tile grid and the image is cropped out of it -- whereas a final STRIP is
 * genuinely short. Treating an edge tile as short reads the next tile's bytes
 * as this one's remainder and misaligns every block after it.
 */
function blockList(ifd: Ifd, width: number, height: number): {
  blocks: Block[]; blockW: number; blockH: number; tiled: boolean;
} {
  const tw = tag1(ifd, T_TILE_WIDTH, 0), th = tag1(ifd, T_TILE_LENGTH, 0);
  const tiled = tw > 0 && th > 0;
  const offs = tagNums(ifd, tiled ? T_TILE_OFFSETS : T_STRIP_OFFSETS, []);
  const lens = tagNums(ifd, tiled ? T_TILE_COUNTS : T_STRIP_COUNTS, []);
  if (offs.length === 0 || offs.length !== lens.length)
    throw new PdfParseError('TIFF: block offsets and byte counts disagree');

  const blocks: Block[] = [];
  if (tiled) {
    // TIFF 6.0 requires both tile dimensions to be a multiple of 16. That is
    // what makes a tile's left edge byte-aligned at ANY bit depth, which is
    // what lets a sub-byte tiled image be copied row-wise at all.
    if (tw % 16 !== 0 || th % 16 !== 0)
      throw new PdfParseError(`TIFF: tile ${tw}x${th} is not a multiple of 16`);
    const across = Math.ceil(width / tw);
    const down = Math.ceil(height / th);
    if (across * down !== offs.length)
      throw new PdfParseError(`TIFF: ${offs.length} tiles for a ${across}x${down} grid`);
    for (let i = 0; i < offs.length; i++) {
      const cx = (i % across) * tw, cy = Math.floor(i / across) * th;
      blocks.push({
        off: offs[i], len: lens[i], x: cx, y: cy,
        w: Math.min(tw, width - cx), h: Math.min(th, height - cy),
      });
    }
    return { blocks, blockW: tw, blockH: th, tiled };
  }

  // RowsPerStrip defaults to 2^32-1: the whole image is ONE strip. Defaulting
  // it to 0 or 1 breaks every single-strip file, which is most of them.
  const rps = Math.min(tag1(ifd, T_ROWS_PER_STRIP, 0xffffffff), height);
  if (rps <= 0) throw new PdfParseError('TIFF: RowsPerStrip is zero');
  const expected = Math.ceil(height / rps);
  if (expected !== offs.length)
    throw new PdfParseError(`TIFF: ${offs.length} strips, geometry needs ${expected}`);
  for (let i = 0; i < offs.length; i++) {
    const y = i * rps;
    blocks.push({ off: offs[i], len: lens[i], x: 0, y, w: width, h: Math.min(rps, height - y) });
  }
  return { blocks, blockW: width, blockH: rps, tiled };
}

/** The colour table: three consecutive PLANES of 16-bit values, scaled to 8. */
function readColorMap(ifd: Ifd, bps: number): Uint8Array {
  const cm = ifd.get(T_COLORMAP);
  if (!cm) throw new PdfParseError('TIFF: palette image with no ColorMap');
  const n = 1 << bps;
  if (cm.length < n * 3)
    throw new PdfParseError(`TIFF: ColorMap has ${cm.length} values, needs ${n * 3}`);
  const pal = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    pal[i * 3] = cm[i] >> 8;                 // reds plane
    pal[i * 3 + 1] = cm[n + i] >> 8;         // greens plane
    pal[i * 3 + 2] = cm[2 * n + i] >> 8;     // blues plane
  }
  return pal;
}

function assemble(r: TiffReader, ifd: Ifd, p: TiffPlan): RasterImage {
  const { width, height, spp, bps, photometric } = p;
  const imgStride = packedStride(width, bps * spp);
  const out = new Uint8Array(imgStride * height);

  for (const b of p.blocks) {
    if (b.off + b.len > r.d.length)
      throw new PdfParseError(`TIFF: block at ${b.off} runs past the file`);
    const srcStride = packedStride(p.blockW, bps * spp);
    const raw = decodeBlock(r.d.subarray(b.off, b.off + b.len), p, b, srcStride);
    if (raw.length < srcStride * b.h)
      throw new PdfParseError(
        `TIFF: block at ${b.off} decoded to ${raw.length} bytes, needs ${srcStride * b.h}`);
    const copy = packedStride(b.w, bps * spp);
    const xByte = (b.x * bps * spp) / 8;      // integral: tile widths are x16
    for (let j = 0; j < b.h; j++)
      out.set(raw.subarray(j * srcStride, j * srcStride + copy),
              (b.y + j) * imgStride + xByte);
  }

  if (photometric === 3) {
    if (spp !== 1) throw new UnsupportedFeatureError('TIFF: palette with several samples');
    return { kind: 'indexed', width, height, bpc: bps as 1 | 2 | 4 | 8,
             palette: readColorMap(ifd, bps), samples: out };
  }
  if (photometric === 0 || photometric === 1) {
    if (spp !== 1) throw new UnsupportedFeatureError('TIFF: gray with several samples');
    // Photometric 0 is WhiteIsZero; DeviceGray is 0-is-black. Normalized here,
    // once, and nowhere else.
    if (photometric === 0) for (let i = 0; i < out.length; i++) out[i] ^= 0xff;
    return { kind: 'gray', width, height, bpc: bps as 1 | 2 | 4 | 8, samples: out };
  }
  if (photometric === 2 || photometric === 5) {
    const need = photometric === 2 ? 3 : 4;
    if (bps !== 8)
      throw new UnsupportedFeatureError(`TIFF: ${need}-channel image at ${bps} bits`);
    if (spp !== need)
      throw new UnsupportedFeatureError(`TIFF: photometric ${photometric} with ${spp} samples`);
    return photometric === 2
      ? { kind: 'rgb', width, height, samples: out }
      : { kind: 'cmyk', width, height, samples: out };
  }
  throw new UnsupportedFeatureError(`TIFF: photometric ${photometric} is not supported`);
}

/** Turn one block's stored bytes into raw samples. Task 5 adds the codecs. */
function decodeBlock(
  src: Uint8Array, p: TiffPlan, _b: Block, _srcStride: number,
): Uint8Array {
  if (p.compression === 1) return src;
  throw new UnsupportedFeatureError(`TIFF: compression ${p.compression} is not supported`);
}
```

Then replace `decodeIfd`'s final lines so it builds the full plan:

```ts
  const { blocks, blockW, tiled } = blockList(ifd, width, height);
  return assemble(r, ifd, {
    width, height, photometric, spp, bps,
    compression: tag1(ifd, T_COMPRESSION, 1),
    predictor: tag1(ifd, T_PREDICTOR, 1),
    fillOrder: tag1(ifd, T_FILLORDER, 1),
    blocks, blockW, tiled,
  });
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/tiff.test.ts && npm run typecheck`
Expected: PASS, 22 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts
git commit -m "feat(10u9.3): TIFF strips, photometric routes and the ColorMap

Strips and tiles are one block loop; this task builds it and wires the strip
half. RowsPerStrip defaults to 2^32-1 -- the whole image is ONE strip -- and
defaulting it to 0 or 1 breaks most files, so the default is asserted directly.

Polarity is normalized in exactly one place, driven by the photometric tag:
TIFF's WhiteIsZero and DeviceGray's 0-is-black are opposites, and inverting in
neither place or in two yields a photographic negative, which reads as a bad
scan rather than as a decoder bug.

ColorMap is three CONSECUTIVE PLANES of 16-bit values, not interleaved RGB
triples and not 0..255. Read as triples it gives a palette that is wrong in a
colourful and entirely plausible way; read as low bytes it gives a nearly
black one. Both halves are pinned by asserting the whole palette."
```

---

### Task 4: Tiles

**Files:**
- Modify: `test/tiff.test.ts` (the code landed in Task 3; this task proves it)

- [ ] **Step 1: Write the failing test**

Append to `test/tiff.test.ts`:

```ts
describe('tiff tiles', () => {
  /** A 20x20 gray image in 16x16 tiles: a 2x2 grid whose right and bottom
   *  tiles are partial. The width is deliberately NOT a multiple of the tile
   *  width -- an exactly dividing grid cannot see the edge-padding rule at all. */
  function tiledTiff(): Uint8Array {
    const tile = (fill: number) => {
      const b = new Uint8Array(16 * 16);
      b.fill(fill);
      // Mark each tile's first row so a misplacement is visible in the samples.
      for (let x = 0; x < 16; x++) b[x] = fill + x;
      return b;
    };
    return buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] },
        ]),
        blocks: [tile(0), tile(64), tile(128), tile(192)],
      }],
    });
  }

  it('places tiles on the grid, cropping the partial edge ones', () => {
    const img = decodeTiff(tiledTiff());
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.width).toBe(20);
    expect(img.height).toBe(20);
    expect(img.samples.length).toBe(400);
    // Row 0, column 0 comes from tile 0; column 16 from tile 1. An edge tile
    // holds a FULL 16 bytes per row, so tile 1's row 0 starts at its own 0 --
    // treating it as 4 bytes wide would read tile 1's later rows here instead.
    expect(img.samples[0]).toBe(0);
    expect(img.samples[15]).toBe(15);
    expect(img.samples[16]).toBe(64);
    expect(img.samples[19]).toBe(67);
    // Row 16 is the first row of the bottom tile pair.
    expect(img.samples[16 * 20]).toBe(128);
    expect(img.samples[16 * 20 + 16]).toBe(192);
  });

  it('rejects a tile dimension that is not a multiple of 16', () => {
    const t = buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [20] }, { tag: 323, type: 4, values: [20] },
        ]),
        blocks: [new Uint8Array(400)],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/multiple of 16/);
  });

  it('rejects a tile count that does not match the grid', () => {
    const t = buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] },
        ]),
        blocks: [new Uint8Array(256)],          // 1 tile for a 2x2 grid
      }],
    });
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/tiff.test.ts`
Expected: PASS, 25 tests. The tile code landed in Task 3's `blockList`; this
task's job is to prove it, and specifically to prove the edge-padding rule with
a grid that does not divide the image.

If the first case FAILS, the likely cause is `copy` being computed from the
tile width rather than the visible width, or `srcStride` from `b.w` rather than
`p.blockW`. Both are the edge-tile trap.

- [ ] **Step 3: Commit**

```bash
git add test/tiff.test.ts
git commit -m "test(10u9.3): TIFF tile placement and the edge-padding rule

A partial edge tile still contains a FULL tile of data -- TIFF pads to the
grid and the image is cropped out of it -- whereas a final strip is genuinely
short. The fixture is 20x20 in 16x16 tiles precisely because a grid that
divides the image exactly cannot see this rule at all, and each tile's first
row is marked so a misplacement shows up in the samples rather than only in a
length."
```

---

### Task 5: LZW, Deflate, PackBits, predictor and FillOrder

**Files:**
- Modify: `src/tiff.ts`, `test/tiff.test.ts`

**Interfaces:**
- Consumes: `decodeBlock` from Task 3.

- [ ] **Step 1: Write the failing test**

Add these three imports to the existing import block at the TOP of
`test/tiff.test.ts` (this repo keeps imports together; ESM hoists them either
way, but a mid-file import reads as an accident):

```ts
import { deflateSync } from 'node:zlib';
import { lzwEncode } from '../src/lzw.js';
import { runLengthEncode } from '../src/ascii.js';
```

Then append the describe block:

```ts

describe('tiff compression', () => {
  const ROWS = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])];

  /** Two strips of a 4x2 gray image, each compressed independently. */
  function compressed(compression: number, enc: (b: Uint8Array) => Uint8Array): Uint8Array {
    return buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [compression] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: ROWS.map(enc),
      }],
    });
  }

  // TWO strips, not one: a single-block image cannot see the per-block codec
  // reset at all, and LZW especially decodes the first block correctly and
  // everything after it as garbage when the state is carried over.
  it('decodes LZW, resetting the codec per strip', () => {
    const img = decodeTiff(compressed(5, (b) => lzwEncode(b, 1)));
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('decodes Deflate (8) and Adobe Deflate (32946)', () => {
    for (const c of [8, 32946]) {
      const img = decodeTiff(compressed(c, (b) => new Uint8Array(deflateSync(Buffer.from(b)))));
      if (img.kind !== 'gray') throw new Error('unreachable');
      expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('decodes PackBits', () => {
    const img = decodeTiff(compressed(32773, (b) => runLengthEncode(b)));
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('applies horizontal differencing (predictor 2) per row', () => {
    // Deltas 10,+1,+1,+1 per row reconstruct to 10,11,12,13.
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] }, { tag: 317, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([10, 1, 1, 1, 20, 1, 1, 1])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
  });

  it('reverses the bits of every byte under FillOrder 2', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 1, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 266, type: 3, values: [2] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0b10110010])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0b01001101]);
  });

  it('refuses an unknown compression', () => {
    expect(() => decodeTiff(compressed(6, (b) => b))).toThrow(UnsupportedFeatureError);
  });

  it('refuses floating-point predictor 3', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 1, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] }, { tag: 317, type: 3, values: [3] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — seven new cases with `compression ... is not supported` or a
predictor mismatch.

- [ ] **Step 3: Implement**

Add these imports at the top of `src/tiff.ts`:

```ts
import { inflateSync } from 'node:zlib';
import { lzwDecode } from './lzw.js';
import { runLengthDecode } from './ascii.js';
import { applyPredictor } from './predictor.js';
```

Add the bit-reversal table and replace `decodeBlock`:

```ts
/** Bit-reversed bytes, for FillOrder 2. */
const REVERSE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 1 << (7 - b);
    t[i] = v;
  }
  return t;
})();

/**
 * Turn one block's stored bytes into raw samples.
 *
 * Every block is compressed INDEPENDENTLY and the codec state resets here, per
 * call. Concatenating blocks and decoding once produces garbage after the
 * first -- which is the structural reason this function takes one block rather
 * than the whole pixel area, and which no single-block fixture can observe.
 */
function decodeBlock(src: Uint8Array, p: TiffPlan, b: Block, srcStride: number): Uint8Array {
  let data = src;
  if (p.fillOrder === 2) {
    data = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) data[i] = REVERSE[src[i]];
  }

  let out: Uint8Array;
  switch (p.compression) {
    case 1: out = data; break;
    case 5: out = lzwDecode(data, 1); break;
    case 8: case 32946: out = new Uint8Array(inflateSync(Buffer.from(data))); break;
    // PDF's RunLengthDecode stops at byte 128, which TIFF PackBits reserves and
    // real encoders do not emit. The length check in `assemble` turns a silent
    // early stop into an error rather than a half-black strip.
    case 32773: out = runLengthDecode(data); break;
    default:
      throw new UnsupportedFeatureError(`TIFF: compression ${p.compression} is not supported`);
  }

  if (p.predictor === 2) {
    // Per BLOCK, per row: with tiles the block's width is not the image's, and
    // passing the image's decodes the first tile plausibly and the rest wrongly.
    out = applyPredictor(out.subarray(0, srcStride * b.h), {
      predictor: 2, colors: p.spp, bpc: p.bps, columns: p.blockW,
    });
  } else if (p.predictor !== 1) {
    throw new UnsupportedFeatureError(`TIFF: Predictor ${p.predictor} is not supported`);
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/tiff.test.ts && npm run typecheck`
Expected: PASS, 32 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts
git commit -m "feat(10u9.3): TIFF LZW, Deflate, PackBits, predictor and FillOrder

Four codecs, none of them new: lzwDecode, node:zlib, runLengthDecode (PDF's
RunLengthDecode is PackBits) and applyPredictor, whose TIFF predictor 2 was
already implemented. What this task adds is the per-block discipline around
them.

Every block is compressed independently and the codec state resets per call.
The LZW fixture therefore uses TWO strips, not one: a single-block image
cannot observe the reset at all, and LZW in particular decodes the first block
correctly and everything after it as garbage when state carries over.

Predictor 2 runs per block with the BLOCK's width, which with tiles is not the
image's -- passing the image's decodes the first tile plausibly and the rest
wrongly."
```

---

### Task 6: CCITT — compression 2, 3 and 4

**Files:**
- Modify: `src/tiff.ts`, `test/tiff.test.ts`

- [ ] **Step 1: Write the failing test**

Add `import { decodeCcitt } from '../src/ccitt.js';` to the import block at the
TOP of `test/tiff.test.ts`, then append:

```ts

describe('tiff CCITT', () => {
  /**
   * Encoding CCITT is not something this repo can do, so these fixtures assert
   * the ROUTING rather than the coding: a byte sequence is fed through
   * `decodeCcitt` directly with the parameters this decoder should choose, and
   * the TIFF path must produce the same bits. That makes the test sensitive to
   * a wrong `k`, a wrong `byteAlign` and a wrong `rows`, which is exactly the
   * part that is new here -- `ccitt.ts` itself is covered by its own suite and
   * by real-world PDF fixtures.
   */
  // A short G4 stream: two 8-pixel all-white rows. 0x26 0xB0 is V0 pass coding
  // for a blank line pair at this width under our own decoder.
  const G4 = Uint8Array.from([0x26, 0xb0, 0x00]);

  it('routes compression 4 to G4 (k = -1)', () => {
    const want = decodeCcitt(G4, {
      k: -1, columns: 8, rows: 2, blackIs1: false, byteAlign: false,
      endOfLine: false, endOfBlock: true,
    });
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 2, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [4] }, { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [G4],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    // Photometric 0 (WhiteIsZero) inverts on the way out, so compare inverted.
    const inverted = Uint8Array.from(want, (v) => v ^ 0xff);
    expect(Array.from(img.samples)).toEqual(Array.from(inverted));
  });

  it('routes compression 2 to 1D with byte alignment', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [2] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x35, 0x00])],   // white run of 8
      }],
    });
    const want = decodeCcitt(Uint8Array.from([0x35, 0x00]), {
      k: 0, columns: 8, rows: 1, blackIs1: false, byteAlign: true,
      endOfLine: false, endOfBlock: true,
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual(Array.from(want, (v) => v ^ 0xff));
  });

  it('reads T4Options bit 0 for 2D and bit 2 for byte alignment', () => {
    // Options 5 = bit 0 (2D) | bit 2 (EncodedByteAlign). The assertion is that
    // BOTH are read: a decoder ignoring bit 2 desynchronises after row 1.
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [3] }, { tag: 292, type: 4, values: [5] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x80, 0x35, 0x00])],
      }],
    });
    // Only the routing is asserted: it must not throw, and must produce one
    // byte-padded row of 8 pixels.
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.samples.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — three cases with `compression 4 is not supported` and friends.

- [ ] **Step 3: Implement**

Add the import to `src/tiff.ts`:

```ts
import { decodeCcitt } from './ccitt.js';
```

Add these cases to `decodeBlock`'s `switch`, before `default`:

```ts
    // CCITT. `rows` is the BLOCK's height, not the image's, and `decodeCcitt`
    // reads `k` only for its SIGN -- negative is pure 2D, 0 is pure 1D,
    // anything positive is mixed -- so 1 is passed rather than T.4's
    // conventional 4, which would imply a significance it does not have.
    case 2: case 3: case 4: {
      const t4 = tag1(ifdOf(p), T_T4OPTIONS, 0);
      const k = p.compression === 4 ? -1
        : p.compression === 2 ? 0
        : (t4 & 1) ? 1 : 0;
      const byteAlign = p.compression === 2 ? true : !!(t4 & 4);
      out = decodeCcitt(data, {
        k, columns: p.blockW, rows: b.h, blackIs1: false,
        byteAlign, endOfLine: false, endOfBlock: true,
      });
      break;
    }
```

`decodeBlock` needs the IFD for `T4Options`, so carry it on the plan rather
than through a helper: add `t4Options: number` to `TiffPlan`, set it in
`decodeIfd` with `t4Options: tag1(ifd, T_T4OPTIONS, 0)`, and use `p.t4Options`
in place of the `ifdOf(p)` sketch above:

```ts
    case 2: case 3: case 4: {
      const k = p.compression === 4 ? -1
        : p.compression === 2 ? 0
        : (p.t4Options & 1) ? 1 : 0;
      const byteAlign = p.compression === 2 ? true : !!(p.t4Options & 4);
      out = decodeCcitt(data, {
        k, columns: p.blockW, rows: b.h, blackIs1: false,
        byteAlign, endOfLine: false, endOfBlock: true,
      });
      break;
    }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/tiff.test.ts && npm run typecheck`
Expected: PASS, 35 tests; typecheck clean.

If a CCITT expectation mismatches, do **not** adjust the expected bytes to
match the output — the whole point is that `decodeCcitt` is called with the
right parameters, and the comparison is against `decodeCcitt` itself. A
mismatch means the routing is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts
git commit -m "feat(10u9.3): TIFF CCITT routing for compression 2, 3 and 4

The coding is ccitt.ts's and is covered by its own suite and real-world PDF
fixtures; what is new is the routing, so these fixtures compare the TIFF path
against decodeCcitt called directly with the parameters this decoder should
choose. That makes them sensitive to a wrong k, a wrong byteAlign and a wrong
rows, which is the whole of what this task decides.

rows is the BLOCK's height, not the image's. decodeCcitt reads k only for its
sign, so 1 is passed for mixed mode rather than T.4's conventional 4, which
would imply a significance the parameter does not have."
```

---

### Task 7: JPEG — compression 7, with a passthrough

**Files:**
- Modify: `src/tiff.ts`, `test/tiff.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/tiff.test.ts`:

```ts
describe('tiff JPEG', () => {
  /** A minimal baseline JPEG: SOI, SOF0 declaring 1x1 grayscale, EOI. */
  const JPEG = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);

  it('passes a single-strip JPEG through as an embedded payload', () => {
    // One block covering the whole image and no JPEGTables: hand the bytes on
    // untouched, so the PDF gets a DCTDecode passthrough with no re-encode.
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [7] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [JPEG],
      }],
    });
    const img = decodeTiff(t);
    expect(img.kind).toBe('embedded');
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('jpeg');
    expect(Array.from(img.payload)).toEqual(Array.from(JPEG));
  });

  it('accepts YCbCr on the JPEG route although it refuses it elsewhere', () => {
    // A JPEG carries its own colour transform, so photometric 6 is fine here
    // and refused for raw samples. This reads as an inconsistency, so it is
    // asserted directly.
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 6, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [7] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [JPEG],
      }],
    });
    expect(decodeTiff(t).kind).toBe('embedded');
  });

  it('refuses YCbCr for a raw-sample route', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 6, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — the two JPEG cases (`compression 7 is not supported`). The
third already passes.

- [ ] **Step 3: Implement**

In `decodeIfd`, immediately before the `blockList` call, add the passthrough:

```ts
  // BI_JPEG's counterpart: one block covering the whole image, with no shared
  // tables, is a complete JPEG datastream. Hand it on untouched -- a DCTDecode
  // passthrough with no decode and no re-encode is the most faithful and the
  // cheapest route, and it is also what makes photometric 6 (YCbCr) work here
  // while the raw-sample routes refuse it, since a JPEG carries its own colour
  // transform.
  if (tag1(ifd, T_COMPRESSION, 1) === 7 && !ifd.has(T_JPEG_TABLES)) {
    const offs = tagNums(ifd, T_STRIP_OFFSETS, tagNums(ifd, T_TILE_OFFSETS, []));
    const lens = tagNums(ifd, T_STRIP_COUNTS, tagNums(ifd, T_TILE_COUNTS, []));
    if (offs.length === 1 && lens.length === 1) {
      if (offs[0] + lens[0] > r.d.length)
        throw new PdfParseError('TIFF: JPEG payload runs past the file');
      if (lens[0] === 0) throw new PdfParseError('TIFF: JPEG payload is empty');
      return { kind: 'embedded', format: 'jpeg',
               payload: r.d.subarray(offs[0], offs[0] + lens[0]) };
    }
  }
```

For the multi-block and `JPEGTables` cases, add to `decodeBlock`'s `switch`:

```ts
    case 7: {
      // The abbreviated form: shared tables live in JPEGTables and each block
      // carries only its scan. Splice them by dropping the tables' trailing EOI
      // and the block's leading SOI.
      const src2 = p.jpegTables
        ? spliceJpeg(p.jpegTables, data)
        : data;
      const j = decodeJpeg(src2);
      out = j.data;
      break;
    }
```

and the helper plus import:

```ts
import { decodeJpeg } from './jpeg.js';

/** JPEGTables minus its EOI, then the block minus its SOI. */
function spliceJpeg(tables: Uint8Array, block: Uint8Array): Uint8Array {
  const t = tables.length >= 2 && tables[tables.length - 2] === 0xff &&
            tables[tables.length - 1] === 0xd9
    ? tables.subarray(0, tables.length - 2) : tables;
  const b = block.length >= 2 && block[0] === 0xff && block[1] === 0xd8
    ? block.subarray(2) : block;
  const out = new Uint8Array(t.length + b.length);
  out.set(t, 0);
  out.set(b, t.length);
  return out;
}
```

Add `jpegTables?: Uint8Array` to `TiffPlan` and set it in `decodeIfd`:

```ts
    jpegTables: ifd.has(T_JPEG_TABLES)
      ? Uint8Array.from(tagNums(ifd, T_JPEG_TABLES, [])) : undefined,
```

Finally, allow photometric 6 to reach the passthrough by leaving the
photometric validation where it is — it runs in `assemble`, which the
passthrough returns before.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/tiff.test.ts && npm run typecheck`
Expected: PASS, 38 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts
git commit -m "feat(10u9.3): TIFF JPEG, with a single-strip passthrough

One block covering the whole image with no JPEGTables is a complete JPEG
datastream, so it is handed on untouched: a DCTDecode passthrough with no
decode and no re-encode, the same trick BMP's BI_JPEG uses and the most
faithful route available.

It is also what makes photometric 6 work here while the raw-sample routes
refuse it -- a JPEG carries its own colour transform. That reads as an
inconsistency, so both halves are asserted side by side."
```

---

### Task 8: Alpha and `ExtraSamples`

**Files:**
- Modify: `src/tiff.ts`, `test/tiff.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/tiff.test.ts`:

```ts
describe('tiff alpha', () => {
  /** A 2x1 RGBA image; `extra` is the ExtraSamples value. */
  function rgba(extra: number, px: number[]): Uint8Array {
    return buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8, 8] },
          { tag: 277, type: 3, values: [4] },
          { tag: 278, type: 4, values: [1] },
          { tag: 338, type: 3, values: [extra] },
        ]),
        blocks: [Uint8Array.from(px)],
      }],
    });
  }

  it('splits unassociated alpha straight out into an /SMask plane', () => {
    const img = decodeTiff(rgba(2, [0xff, 0x00, 0x00, 0x80, 0x00, 0xff, 0x00, 0xff]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(Array.from(img.alpha!)).toEqual([0x80, 0xff]);
  });

  it('divides out associated (premultiplied) alpha', () => {
    // ExtraSamples 1 is PREMULTIPLIED. PDF's /SMask composites colour x alpha,
    // so handing it premultiplied colour multiplies alpha in twice: the image
    // renders too dark, worst exactly where it is most transparent.
    // 0x80 at half alpha un-premultiplies to full 0xff.
    const img = decodeTiff(rgba(1, [0x80, 0x00, 0x00, 0x80, 0x40, 0x40, 0x40, 0x40]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.alpha!)).toEqual([0x80, 0x40]);
    expect(img.samples[0]).toBe(0xff);          // 0x80 / (0x80/0xff)
    expect(img.samples[3]).toBe(0xff);          // 0x40 / (0x40/0xff)
  });

  it('emits 0 where premultiplied alpha is 0 rather than dividing by zero', () => {
    const img = decodeTiff(rgba(1, [0x00, 0x00, 0x00, 0x00, 0x40, 0x40, 0x40, 0x40]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it('drops an unspecified extra sample and stays opaque', () => {
    // ExtraSamples 0 is "unspecified", which is NOT a claim of transparency.
    const img = decodeTiff(rgba(0, [0xff, 0x00, 0x00, 0x11, 0x00, 0xff, 0x00, 0x22]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
  });

  it('splits gray plus alpha too', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 1, [
          { tag: 258, type: 3, values: [8, 8] }, { tag: 277, type: 3, values: [2] },
          { tag: 278, type: 4, values: [1] }, { tag: 338, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([0x40, 0x80, 0xc0, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x40, 0xc0]);
    expect(Array.from(img.alpha!)).toEqual([0x80, 0xff]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff.test.ts`
Expected: FAIL — five cases, most with `photometric 2 with 4 samples`.

- [ ] **Step 3: Implement**

Add to `src/tiff.ts` a splitter, and call it from `assemble`:

```ts
/**
 * Split an interleaved colour+extra raster into colour and alpha planes.
 *
 * ExtraSamples 1 is ASSOCIATED alpha, meaning the colour is premultiplied, and
 * it must be divided out: PDF's /SMask composites colour x alpha, so premultiplied
 * colour multiplies alpha in twice and the image renders too dark, worst exactly
 * where it is most transparent. Value 2 is unassociated and passes through.
 * Value 0 is UNSPECIFIED, which is not a claim of transparency -- the channel
 * is dropped and the image stays opaque.
 */
function splitAlpha(
  samples: Uint8Array, px: number, colorCh: number, spp: number, extra: number,
): { color: Uint8Array; alpha?: Uint8Array } {
  const color = new Uint8Array(px * colorCh);
  for (let p = 0; p < px; p++)
    for (let c = 0; c < colorCh; c++) color[p * colorCh + c] = samples[p * spp + c];
  if (extra !== 1 && extra !== 2) return { color };

  const alpha = new Uint8Array(px);
  for (let p = 0; p < px; p++) alpha[p] = samples[p * spp + colorCh];
  if (extra === 2) return { color, alpha };
  for (let p = 0; p < px; p++) {
    const a = alpha[p];
    for (let c = 0; c < colorCh; c++) {
      const i = p * colorCh + c;
      color[i] = a === 0 ? 0 : Math.min(255, Math.round((color[i] * 255) / a));
    }
  }
  return { color, alpha };
}
```

In `assemble`, replace the gray and rgb/cmyk arms' sample-count checks so extras
are handled:

```ts
  const extra = tag1(ifd, T_EXTRA_SAMPLES, 0);

  if (photometric === 0 || photometric === 1) {
    if (spp !== 1 && spp !== 2)
      throw new UnsupportedFeatureError(`TIFF: gray with ${spp} samples`);
    let samples = out, alpha: Uint8Array | undefined;
    if (spp === 2) {
      if (bps !== 8) throw new UnsupportedFeatureError('TIFF: gray+alpha below 8 bits');
      const s = splitAlpha(out, width * height, 1, 2, extra);
      samples = s.color; alpha = s.alpha;
    }
    if (photometric === 0) for (let i = 0; i < samples.length; i++) samples[i] ^= 0xff;
    return { kind: 'gray', width, height, bpc: bps as 1 | 2 | 4 | 8, samples, alpha };
  }

  if (photometric === 2 || photometric === 5) {
    const colorCh = photometric === 2 ? 3 : 4;
    if (bps !== 8)
      throw new UnsupportedFeatureError(`TIFF: ${colorCh}-channel image at ${bps} bits`);
    if (spp !== colorCh && spp !== colorCh + 1)
      throw new UnsupportedFeatureError(`TIFF: photometric ${photometric} with ${spp} samples`);
    if (photometric === 5) {
      if (spp !== 4) throw new UnsupportedFeatureError('TIFF: CMYK with an extra sample');
      return { kind: 'cmyk', width, height, samples: out };
    }
    if (spp === 3) return { kind: 'rgb', width, height, samples: out };
    const s = splitAlpha(out, width * height, 3, 4, extra);
    return { kind: 'rgb', width, height, samples: s.color, alpha: s.alpha };
  }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/tiff.test.ts && npm run typecheck`
Expected: PASS, 43 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tiff.ts test/tiff.test.ts
git commit -m "feat(10u9.3): TIFF alpha, dividing out associated ExtraSamples

ExtraSamples 1 is ASSOCIATED alpha, meaning premultiplied colour, and it must
be divided out. PDF's /SMask composites colour x alpha, so handing it
premultiplied colour multiplies alpha in twice: the image renders too dark,
worst exactly where it is most transparent, which reads as a bad scan rather
than as a bug. Value 2 is unassociated and passes through, and value 0 is
UNSPECIFIED -- not a claim of transparency -- so the channel is dropped and
the image stays opaque. All three are asserted side by side, since only the
contrast between them shows the rule is being read at all."
```

---

### Task 9: Wire TIFF into `imageembed.ts`

**Files:**
- Modify: `src/imageembed.ts`, `src/flow.ts:891`, `src/floatbox.ts:41`, `src/tableauthor.ts:154`, `src/index.ts`
- Test: `test/tiff-embed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/tiff-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName, isStream, isDict } from '../src/types.js';
import { tiffPageCount } from '../src/tiff.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';

function soleImage(doc: Document) {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('no xobjects');
  const first = doc.resolve([...xo.values()][0]);
  if (!isStream(first)) throw new Error('not a stream');
  return first;
}

function withImage(bytes: Uint8Array, opts?: { page?: number }): Document {
  const doc = Document.New();
  doc.AddPage();
  doc.Pages[0].AddImage(bytes, [0, 0, 100, 100], opts);
  return doc;
}

/** A 2x2 8-bit gray TIFF whose samples are `px`. */
function grayTiff(px: number[], le = true): Uint8Array {
  return buildTiff({
    le,
    pages: [{
      tags: baseTags(2, 2, 1, [
        { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
        { tag: 278, type: 4, values: [2] },
      ]),
      blocks: [Uint8Array.from(px)],
    }],
  });
}

describe('AddImage — TIFF', () => {
  it('embeds a gray TIFF as DeviceGray', () => {
    const img = soleImage(withImage(grayTiff([1, 2, 3, 4])));
    expect(img.dict.get('Width')).toBe(2);
    expect(img.dict.get('Height')).toBe(2);
    expect(img.dict.get('BitsPerComponent')).toBe(8);
    const cs = img.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceGray');
  });

  it('sniffs both byte orders', () => {
    for (const le of [true, false])
      expect(soleImage(withImage(grayTiff([1, 2, 3, 4], le))).dict.get('Width')).toBe(2);
  });

  it('embeds the page named by AddImageOptions.page', () => {
    const two = buildTiff({
      pages: [
        { tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] }]),
          blocks: [Uint8Array.from([1, 2, 3, 4])] },
        { tags: baseTags(4, 1, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [1] }]),
          blocks: [Uint8Array.from([5, 6, 7, 8])] },
      ],
    });
    expect(tiffPageCount(two)).toBe(2);
    expect(soleImage(withImage(two)).dict.get('Width')).toBe(2);
    expect(soleImage(withImage(two, { page: 1 })).dict.get('Width')).toBe(4);
  });

  it('throws rather than silently ignoring page on a format with no pages', () => {
    // Accepting an option and ignoring it is the trap textedit.ts's `region` is
    // documented against: a caller who thinks they selected page 3 and got page
    // 1 has no way to tell.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(png, [0, 0, 10, 10], { page: 1 }))
      .toThrow(/page/);
  });

  it('survives a Save round trip', () => {
    const reopened = Document.Open(withImage(grayTiff([1, 2, 3, 4])).Save());
    expect(soleImage(reopened).dict.get('Height')).toBe(2);
  });

  it('still refuses a format it does not know', () => {
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(Uint8Array.from([1, 2, 3, 4]), [0, 0, 10, 10]))
      .toThrow(/JPEG, PNG, BMP or TIFF/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiff-embed.test.ts`
Expected: FAIL — `AddImage: unrecognized image format`.

- [ ] **Step 3: Implement in `src/imageembed.ts`**

Add the import:

```ts
import { decodeTiff } from './tiff.js';
```

Extend `sniff` — TIFF's magic is four bytes of structure, so unlike BMP it
needs no secondary check:

```ts
  // "II" 42 or "MM" 42, each read in its own byte order. Four bytes of
  // structure, so unlike BMP's two-byte "BM" this needs no secondary check.
  if (data.length >= 8) {
    if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 42 && data[3] === 0) return 'tiff';
    if (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 42) return 'tiff';
  }
```

placed before the throw, whose message becomes
`'AddImage: unrecognized image format (expected JPEG, PNG, BMP or TIFF)'`, and
whose return type becomes `'jpeg' | 'png' | 'bmp' | 'tiff'`.

Add `page` to the options and thread it:

```ts
export interface AddImageOptions {
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Which image of a multi-image file to embed, 0-based. TIFF only; a
   *  non-zero value THROWS for a format with no pages rather than being
   *  silently ignored. Default 0. */
  page?: number;
  ...
}
```

```ts
export function buildImageXObject(
  data: Uint8Array, format?: 'jpeg' | 'png' | 'bmp' | 'tiff', page = 0,
): BuiltImage {
  const fmt = format ?? sniff(data);
  if (fmt === 'tiff') return buildRasterXObject(decodeTiff(data, page));
  if (page !== 0)
    throw new UnsupportedFeatureError(`AddImage: ${fmt} has no pages, so page ${page} is invalid`);
  if (fmt === 'bmp') return buildRasterXObject(decodeBmp(data));
  return fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);
}
```

and in `addImage`, change the call to
`buildImageXObject(data, opts.format, opts.page ?? 0)`.

- [ ] **Step 4: Widen the three other option bags and export `tiffPageCount`**

In `src/flow.ts:891`, `src/floatbox.ts:41` and `src/tableauthor.ts:154`, change
each `format?: 'jpeg' | 'png' | 'bmp';` to
`format?: 'jpeg' | 'png' | 'bmp' | 'tiff';`.

In `src/index.ts`, beside `export { ImageInfo } from './image.js';`, add:

```ts
export { tiffPageCount } from './tiff.js';
```

- [ ] **Step 5: Run the tests, typecheck and the full suite**

Run: `npx vitest run test/tiff-embed.test.ts test/tiff.test.ts && npm run typecheck && npm test`
Expected: all green. Nothing outside `src/tiff.ts`, `src/rasterimage.ts`,
`src/bmp.ts`, `src/imageembed.ts`, `src/index.ts` and the three option bags
should have moved — a red test elsewhere is information, not a chore.

- [ ] **Step 6: Commit**

```bash
git add src/imageembed.ts src/flow.ts src/floatbox.ts src/tableauthor.ts src/index.ts test/tiff-embed.test.ts
git commit -m "feat(10u9.3): accept TIFF in AddImage, with a page option

TIFF's magic is four bytes of structure, so unlike BMP's two-byte 'BM' the
sniff needs no secondary check -- but it must read the magic in the file's own
byte order, which is why there are two branches rather than one.

AddImageOptions.page is 0-based and THROWS when non-zero for a format with no
pages, rather than being silently accepted: accepting an option and ignoring
it is the trap textedit.ts's region is already documented against, and a
caller who thinks they selected page 3 and got page 1 has no way to tell.
tiffPageCount is exported from index.ts because the option is useless without
a way to learn the bound; decodeTiff stays internal, as every other decoder
in this repo does."
```

---

### Task 10: Mutation verification, docs, follow-up

**Files:**
- Modify: `test/tiff.test.ts` (findings header), `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Run the mutations**

For each, apply to `src/tiff.ts`, run
`npx vitest run test/tiff.test.ts test/tiff-embed.test.ts`, record whether it
went red, then `git checkout -- src/tiff.ts`.

| # | Mutation | Where |
|---|---|---|
| 1 | Force little-endian: `const le = true;` | `openTiff` |
| 2 | Always read the value as an offset: drop the `bytes <= 4` branch | `readIfd` |
| 3 | `RowsPerStrip` defaults to 1: `tag1(ifd, T_ROWS_PER_STRIP, 1)` | `blockList` |
| 4 | Never invert: delete the `photometric === 0` XOR loop | `assemble` |
| 5 | ColorMap as interleaved triples: `cm[i*3]`, `cm[i*3+1]`, `cm[i*3+2]` | `readColorMap` |
| 6 | ColorMap low byte: `cm[i] & 0xff` | `readColorMap` |
| 7 | Edge tile treated as short: `srcStride` from `b.w` not `p.blockW` | `assemble` |
| 8 | Predictor uses the image width: `columns: p.width` | `decodeBlock` |
| 9 | Never divide out premultiplied alpha: `return { color, alpha }` before the loop | `splitAlpha` |
| 10 | Drop the cycle guard: delete the `seen.has(at)` throw | `ifdOffsets` |

Mutation 10 may hang rather than fail. Run it last, and if the run does not
terminate within a minute, kill it and record it as "hangs — which is the
failure the guard prevents".

- [ ] **Step 2: Write the findings into the test header**

Add to the note already at the top of `test/tiff.test.ts`, filling in the
measured results:

```ts
/**
 * WHAT THESE FIXTURES COVER, measured by mutation rather than assumed. Each
 * change below was applied to src/tiff.ts in turn and both TIFF test files
 * re-run:
 *
 *    1 byte order forced little-endian   <RED/GREEN, n cases>
 *    2 inline value read as an offset    <...>
 *    3 RowsPerStrip defaults to 1        <...>
 *    4 WhiteIsZero never inverted        <...>
 *    5 ColorMap read as triples          <...>
 *    6 ColorMap read as low bytes        <...>
 *    7 edge tile treated as short        <...>
 *    8 predictor uses the image width    <...>
 *    9 premultiplied alpha not divided   <...>
 *   10 IFD cycle guard removed           <...>
 *
 * Name anything that stays GREEN rather than claiming coverage the
 * measurement does not support.
 */
```

- [ ] **Step 3: Commit the findings**

```bash
git add test/tiff.test.ts
git commit -m "test(10u9.3): mutation findings for the TIFF decoder"
```

- [ ] **Step 4: Update the README**

Features list, the image-insertion bullet — after the BMP clause, add:

```markdown
or a TIFF (`FlateDecode`; both byte orders, strips and tiles, 1/2/4/8-bit gray and palette, 8-bit RGB and CMYK, CCITT G3/G4 through the same decoder the `CCITTFaxDecode` filter uses, LZW, Deflate, PackBits, horizontal differencing, associated and unassociated alpha, and multi-image files through `opts.page`)
```

API overview — change the `page.AddImage` row to "Embed and paint a JPEG, PNG,
BMP or TIFF raster at `[x, y, w, h]` (`opts.page` selects an image of a
multi-image TIFF)", and add a row:

```markdown
| `tiffPageCount(bytes)` | How many images a multi-image TIFF holds, for `AddImage`'s `page` option |
```

Limitations — replace the image-insertion entry's opening and add TIFF's
declined shapes:

```markdown
- **Image insertion is JPEG, PNG, BMP and TIFF** — `AddImage` accepts JPEG (`DCTDecode`, including CMYK), PNG (`FlateDecode`, including interlaced/Adam7 and palette `tRNS`), BMP and TIFF (both decoded to samples and stored as `FlateDecode`; the saved file carries no trace of the original container). Still unsupported in PNG: 16-bit-with-alpha, grayscale/RGB `tRNS` color-key masks, interlaced below 8-bit, and palette `tRNS` below 8-bit. For BMP, an embedded ICC profile in a `BITMAPV5HEADER` is ignored and the image read as sRGB; and a V4/V5 file that *declares* an alpha mask and then writes zeros everywhere renders fully transparent — that is the producer contradicting itself, and honouring the declaration is the reading the format supports, but it will look like a defect here. For TIFF, declined with a named reason: BigTIFF, `PlanarConfiguration` 2, photometric YCbCr/CIELab/transparency-mask outside the JPEG route, old-style JPEG (compression 6), 16- and 32-bit samples, and floating-point `Predictor` 3. Other raster formats remain out of scope.
```

- [ ] **Step 5: Update the CHANGELOG**

Add under `## [Unreleased]`, in **Added**, above the BMP entry:

```markdown
- **`AddImage` accepts TIFF** — everywhere an image goes in, as BMP is. Nearly every codec TIFF needs was already here and separately tested — `decodeCcitt` for G3/G4, `lzwDecode`, `applyPredictor` (whose TIFF predictor 2 was already implemented), `runLengthDecode` (PDF's RunLengthDecode *is* PackBits), `decodeJpeg` and `node:zlib` — so what this adds is the container: byte order, the IFD chain, and strip/tile assembly. Covered: both byte orders, strips and tiles, compression 1/2/3/4/5/7/8/32946/32773, photometric WhiteIsZero, BlackIsZero, RGB, Palette and CMYK, `FillOrder` 1 and 2, predictor 1 and 2, associated and unassociated alpha, and multi-image files through `opts.page` with `tiffPageCount` exported to give the bound. A single-strip JPEG with no shared tables is passed through as `DCTDecode` with no re-encode, which is also why YCbCr works on that route while the raw-sample routes refuse it — a JPEG carries its own colour transform. This is also where `10u9.2`'s `BmpImage` became `RasterImage` in its own leaf, the generalization that issue deliberately deferred until a second caller existed: `buildRasterXObject` is now the one owner of "which PDF colour space is this" for every image input format. Three rules are implemented against their failure modes, each of which decodes into something plausible rather than failing: `RowsPerStrip` defaults to 2³²−1 (the whole image is one strip), a partial edge *tile* still holds a full tile of data where a final *strip* is genuinely short, and associated alpha is premultiplied and must be divided out or `/SMask` multiplies it in twice. Recorded honestly: unlike BMP, TIFF has no published hex dump to anchor against, so the container is builder-anchored, mitigated by an `II`-versus-`MM` differential that a shared builder bug cannot fake. (`10u9.3`)
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(10u9.3): README and changelog for TIFF input"
```

- [ ] **Step 8: File the follow-up and close**

```bash
bd create "Real-producer TIFF fixtures in test/fixtures/tiff/" \
  -p 3 --parent aspose-pdf-foss-for-ts-10u9 -l gap-vs-go \
  -d "Unlike BMP, TIFF has no published hex dump to transcribe, so test/tiff.test.ts anchors the container on our own builder -- encoder-versus-decoder inside one repo. The payload codecs carry their own real-world fixtures and an II/MM differential guards the reader, but real files from libtiff, ImageMagick and a scanner would be the real anchor. Add them with a PROVENANCE.md as fixtures/jpeg and fixtures/pdfx have. See docs/superpowers/specs/2026-08-21-tiff-decode-design.md."

bd close aspose-pdf-foss-for-ts-10u9.3
```

---

## Self-Review

**Spec coverage.** `RasterImage` and the BMP rename → Task 1. Container, byte
order, IFD chain, inline values, cycle guard, tag defaults → Task 2. Blocks,
photometric routes, polarity, ColorMap → Task 3. Tiles and edge padding →
Task 4. LZW/Deflate/PackBits/predictor/FillOrder → Task 5. CCITT 2/3/4 →
Task 6. JPEG and the passthrough, plus the YCbCr asymmetry → Task 7.
`ExtraSamples` → Task 8. Detection, the widened union, `page`, `tiffPageCount`
→ Task 9. Mutation verification, docs, the follow-up → Task 10. Errors are
spread across the tasks that raise them. The pixel bound is in Task 2's
`decodeIfd`.

**One spec gap found and closed here.** The spec said tiles and sub-byte depths
are both supported without saying whether they combine — a tile's left edge
must be byte-aligned for a row-wise copy to work at 1, 2 or 4 bits. It does,
because TIFF 6.0 requires both tile dimensions to be a multiple of 16, which
makes `x * bps * spp` a whole number of bytes at every depth this decoder
accepts. Task 3's `blockList` enforces that multiple-of-16 rule and Task 4
asserts it, which turns an unstated assumption into a checked one.

**Type consistency.** `RasterImage`, `TiffReader`, `Ifd`, `TiffPlan`, `Block`,
`openTiff`, `ifdOffsets`, `readIfd`, `tagNums`, `tag1`, `blockList`,
`readColorMap`, `assemble`, `decodeBlock`, `splitAlpha`, `spliceJpeg`,
`packedStride`, `decodeTiff`, `tiffPageCount`, `buildRasterXObject`,
`buildTiff`, `baseTags`, `TiffTag`, `BuildTiffOptions` are each defined once
and used under exactly those names. `TiffPlan` grows two fields after its first
definition — `t4Options` in Task 6 and `jpegTables` in Task 7 — and each task
says so explicitly rather than silently redefining the interface.

**Two things the implementer should expect to be fiddly, flagged rather than
hidden.** Task 6's CCITT byte fixtures are hand-written streams; if one does
not decode to a plausible raster, the fix is to compare against `decodeCcitt`
called directly rather than to adjust the expected bytes, and the task says so.
And Task 10's mutation 10 removes a loop guard, so it may hang instead of
failing — the task says to run it last and record the hang as the finding.
