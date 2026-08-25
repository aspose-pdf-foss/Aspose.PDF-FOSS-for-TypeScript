# Page → SVG Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Page.ToSvg()` — a graphics-state interpreter that walks a page's content stream and returns a standalone `<svg>` string (paths, text, images, clipping, gradients), honoring `/Rotate` and `CropBox`.

**Architecture:** A dedicated interpreter in `src/svgrender.ts` threads a graphics-state machine over the content ops (reusing the matrix helpers and `TextFont`/`ImageInfo` from the existing code) and writes SVG elements directly — no shared display-list IR yet. Color and images lean on two new pure modules: `colorspace.ts` (component→RGB) and `pngencode.ts` (samples→PNG data URI), plus `pdffunction.ts` (PDF function evaluator) for tint transforms and shading stops.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, node built-ins only (`zlib` `deflateSync`, `Buffer` for base64).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension (e.g. `import { Matrix } from './text.js'`).
- **strict TypeScript** — `npm run typecheck` (tsc `--noEmit`) must pass with no errors.
- **TDD** — write the failing test first; fixtures are built programmatically in `test/helpers/` mirroring existing builder style.
- **Matrix convention** (`src/text.ts`): `Matrix = [a,b,c,d,e,f]`, row-vector; `apply(m,x,y) = [a*x+c*y+e, b*x+d*y+f]`; `mul(m,n)` = "m then n". This is identical to SVG's `matrix(a b c d e f)`, so a `Matrix` serializes straight into a `transform` with no conversion.
- **Never throw from `ToSvg()`** — degrade unsupported content (gray fill, solid gradient fallback, gray placeholder `<rect>` for undecodable images); always return a valid `<svg>` string.
- **Errors** (when a helper must signal): use `PdfParseError` / `UnsupportedFeatureError` from `src/errors.js` — but `ToSvg()` itself catches and degrades.
- Run `npm run typecheck` and `npm test` green before closing issue `aspose-pdf-foss-for-ts-3sh.1`.

## File Structure

- **Create `src/pngencode.ts`** — `encodePng(width, height, samples, kind): Uint8Array`. Minimal PNG encoder (IHDR + zlib IDAT + IEND). Reusable by the future rasterizer (3sh.2).
- **Create `src/pdffunction.ts`** — `parseFunction(obj, resolve, inflate): PdfFunction`; a `PdfFunction` maps `number[] → number[]`. Types 0 (sampled), 2 (exponential), 3 (stitching); type 4 falls back to a constant.
- **Create `src/colorspace.ts`** — `resolveColorSpace(cs, resolve, inflate): ColorConverter`; converts component arrays to `[r,g,b]` (0–255). Device*, CalGray/CalRGB, Lab, ICCBased (alternate), Indexed, Separation/DeviceN.
- **Create `src/svgrender.ts`** — `renderPageToSvg(doc, page, opts): string`. The interpreter + SVG builder. Grows across Tasks 4–10.
- **Modify `src/page.ts`** — add `ToSvg(options?: SvgOptions): string`.
- **Modify `src/index.ts`** — export `SvgOptions` (and `renderPageToSvg` is internal, not exported).
- **Create `test/helpers/build-svg-fixtures.ts`** — fixture builders (vector, text, embedded font, JPEG, Flate image, clip, rotate/cropbox, shading, nested form).
- **Create tests:** `test/pngencode.test.ts`, `test/pdffunction.test.ts`, `test/colorspace.test.ts`, `test/svgrender.test.ts`.

Tasks 4–10 all edit the single `src/svgrender.ts`; each adds concrete op handlers and ends with its own passing fixture test.

---

### Task 1: PNG encoder (`src/pngencode.ts`)

**Files:**
- Create: `src/pngencode.ts`
- Test: `test/pngencode.test.ts`

**Interfaces:**
- Produces: `type PngKind = 'gray' | 'rgb' | 'rgba'`; `export function encodePng(width: number, height: number, samples: Uint8Array, kind: PngKind): Uint8Array`. `samples` is row-major, `width*height*channels` bytes (channels: gray=1, rgb=3, rgba=4). Returns complete PNG file bytes.

- [ ] **Step 1: Write the failing test**

```typescript
// test/pngencode.test.ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../src/pngencode.js';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const out: { type: string; data: Uint8Array }[] = [];
  let p = 8;
  while (p < png.length) {
    const len = (png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3];
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    out.push({ type, data: png.slice(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

describe('encodePng', () => {
  it('emits a valid signature, IHDR, and round-trippable IDAT for RGB', () => {
    const samples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]); // 2x2 RGB
    const png = encodePng(2, 2, samples, 'rgb');
    expect([...png.slice(0, 8)]).toEqual(SIG);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = cs[0].data;
    expect((ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3]).toBe(2); // width
    expect(ihdr[8]).toBe(8);  // bit depth
    expect(ihdr[9]).toBe(2);  // color type 2 = RGB
    // IDAT inflates to per-row (filter byte 0 + row bytes)
    const raw = inflateSync(Buffer.from(cs[1].data));
    expect(raw[0]).toBe(0); // row 0 filter byte
    expect([...raw.slice(1, 7)]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('supports rgba and gray color types', () => {
    expect(chunks(encodePng(1, 1, Uint8Array.from([9, 9, 9, 128]), 'rgba')[0].data[9]).toString()).toBe('6');
    expect(chunks(encodePng(1, 1, Uint8Array.from([42]), 'gray')[0].data[9]).toString()).toBe('0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pngencode.test.ts`
Expected: FAIL — "Cannot find module '../src/pngencode.js'".

- [ ] **Step 3: Write the implementation**

```typescript
// src/pngencode.ts
import { deflateSync } from 'node:zlib';

export type PngKind = 'gray' | 'rgb' | 'rgba';

const CHANNELS: Record<PngKind, number> = { gray: 1, rgb: 3, rgba: 4 };
const COLOR_TYPE: Record<PngKind, number> = { gray: 0, rgb: 2, rgba: 6 };

/** CRC-32 (PNG/zlib polynomial), computed with a lazily-built table. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

/** Encode row-major 8-bit samples into a complete PNG file. */
export function encodePng(width: number, height: number, samples: Uint8Array, kind: PngKind): Uint8Array {
  const ch = CHANNELS[kind];
  const stride = width * ch;
  // Prefix each row with filter byte 0 (None).
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(samples.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = COLOR_TYPE[kind];  // color type
  // ihdr[10..12] = 0: deflate, no filter, no interlace

  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** A `data:` URI for the given PNG bytes. */
export function pngDataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pngencode.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/pngencode.ts test/pngencode.test.ts
git commit -m "feat(3sh.1): minimal PNG encoder for SVG image embedding"
```

---

### Task 2: PDF function evaluator (`src/pdffunction.ts`)

**Files:**
- Create: `src/pdffunction.ts`
- Test: `test/pdffunction.test.ts`

**Interfaces:**
- Consumes: `Resolve = (o: PdfObject | undefined) => PdfObject` and `Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array` (same shapes `TextFont` uses).
- Produces: `export type PdfFunction = (input: number[]) => number[]`; `export function parseFunction(obj: PdfObject, resolve: Resolve, inflate: Inflate): PdfFunction`. An array of functions is combined (each produces 1 output). Unknown/unsupported → returns the domain-clamped midpoint as a constant.

- [ ] **Step 1: Write the failing test**

```typescript
// test/pdffunction.test.ts
import { describe, it, expect } from 'vitest';
import { parseFunction } from '../src/pdffunction.js';
import { PdfDict, PdfObject } from '../src/types.js';

const id = (o: PdfObject | undefined): PdfObject => o ?? null;
const inflate = (s: { raw: Uint8Array }) => s.raw;

function dict(entries: Record<string, PdfObject>): PdfDict {
  return new Map(Object.entries(entries));
}

describe('parseFunction', () => {
  it('evaluates a type 2 exponential function', () => {
    const f = parseFunction(
      dict({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 0.5, 0], N: 1 }),
      id, inflate,
    );
    expect(f([0]).map((n) => +n.toFixed(3))).toEqual([0, 0, 0]);
    expect(f([1]).map((n) => +n.toFixed(3))).toEqual([1, 0.5, 0]);
    expect(f([0.5]).map((n) => +n.toFixed(3))).toEqual([0.5, 0.25, 0]);
  });

  it('evaluates a type 3 stitching function', () => {
    const seg = (c0: number, c1: number) =>
      dict({ FunctionType: 2, Domain: [0, 1], C0: [c0], C1: [c1], N: 1 });
    const f = parseFunction(
      dict({ FunctionType: 3, Domain: [0, 1], Functions: [seg(0, 1), seg(1, 0)],
             Bounds: [0.5], Encode: [0, 1, 0, 1] }),
      id, inflate,
    );
    expect(f([0.25])[0]).toBeCloseTo(0.5, 3);
    expect(f([0.75])[0]).toBeCloseTo(0.5, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdffunction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/pdffunction.ts
import { PdfDict, PdfObject, isDict, isArray, isStream } from './types.js';

export type PdfFunction = (input: number[]) => number[];

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

function nums(o: PdfObject | undefined, resolve: Resolve): number[] {
  const r = resolve(o);
  return isArray(r) ? r.map((x) => resolve(x)).filter((x): x is number => typeof x === 'number') : [];
}
function n(o: PdfObject | undefined, resolve: Resolve, dflt: number): number {
  const r = resolve(o);
  return typeof r === 'number' ? r : dflt;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function interp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/** Parse a PDF function (dict or stream) into a numeric map. Arrays of functions
 *  are each single-output and concatenated. */
export function parseFunction(obj: PdfObject, resolve: Resolve, inflate: Inflate): PdfFunction {
  const r = resolve(obj);
  if (isArray(r)) {
    const fns = r.map((e) => parseFunction(e, resolve, inflate));
    return (input) => fns.flatMap((f) => f(input));
  }
  const dict = isStream(r) ? r.dict : isDict(r) ? r : undefined;
  if (!dict) return () => [0];
  const type = n(dict.get('FunctionType'), resolve, -1);
  const domain = nums(dict.get('Domain'), resolve);
  const clampDomain = (input: number[]) =>
    input.map((v, i) => clamp(v, domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1));

  if (type === 2) {
    const c0 = nums(dict.get('C0'), resolve); const c1 = nums(dict.get('C1'), resolve);
    const exp = n(dict.get('N'), resolve, 1);
    const a = c0.length ? c0 : [0]; const b = c1.length ? c1 : [1];
    return (input) => {
      const x = clampDomain(input)[0] ?? 0;
      const t = Math.pow(x, exp);
      return a.map((v, i) => v + t * ((b[i] ?? 0) - v));
    };
  }

  if (type === 3) {
    const subDicts = resolve(dict.get('Functions'));
    const fns = isArray(subDicts) ? subDicts.map((f) => parseFunction(f, resolve, inflate)) : [];
    const bounds = nums(dict.get('Bounds'), resolve);
    const encode = nums(dict.get('Encode'), resolve);
    const d0 = domain[0] ?? 0; const d1 = domain[1] ?? 1;
    return (input) => {
      const x = clampDomain(input)[0] ?? 0;
      let k = 0;
      while (k < bounds.length && x >= bounds[k]) k++;
      const lo = k === 0 ? d0 : bounds[k - 1];
      const hi = k === bounds.length ? d1 : bounds[k];
      const e0 = encode[2 * k] ?? 0; const e1 = encode[2 * k + 1] ?? 1;
      const xe = interp(x, lo, hi, e0, e1);
      return fns[k] ? fns[k]([xe]) : [0];
    };
  }

  if (type === 0 && isStream(r)) {
    const size = nums(dict.get('Size'), resolve);
    const bps = n(dict.get('BitsPerSample'), resolve, 8);
    const range = nums(dict.get('Range'), resolve);
    const encode = nums(dict.get('Encode'), resolve);
    const decode = nums(dict.get('Decode'), resolve);
    const m = size.length; const nOut = range.length / 2;
    const samples = inflate(r);
    const maxIn = (1 << bps) - 1 || 1;
    // 1-D fast path (the common shading case); higher-D falls back to nearest.
    const read = (flatIndex: number, out: number): number => {
      const bitPos = (flatIndex * nOut + out) * bps;
      let val = 0;
      for (let b = 0; b < bps; b++) {
        const bit = bitPos + b;
        val = (val << 1) | ((samples[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      return val;
    };
    return (input) => {
      const clamped = clampDomain(input);
      const idx: number[] = [];
      for (let i = 0; i < m; i++) {
        const e0 = encode[2 * i] ?? 0; const e1 = encode[2 * i + 1] ?? (size[i] - 1);
        const enc = interp(clamped[i], domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1, e0, e1);
        idx[i] = Math.round(clamp(enc, 0, size[i] - 1));
      }
      let flat = 0; let mul = 1;
      for (let i = 0; i < m; i++) { flat += idx[i] * mul; mul *= size[i]; }
      const out: number[] = [];
      for (let o = 0; o < nOut; o++) {
        const raw = read(flat, o) / maxIn;
        const dl = decode[2 * o] ?? range[2 * o] ?? 0;
        const dh = decode[2 * o + 1] ?? range[2 * o + 1] ?? 1;
        out.push(dl + raw * (dh - dl));
      }
      return out;
    };
  }

  // type 4 (PostScript) and anything unsupported: constant midpoint of Range/[0,1].
  const range = nums(dict.get('Range'), resolve);
  const outN = range.length / 2 || 1;
  const constOut: number[] = [];
  for (let o = 0; o < outN; o++) constOut.push(((range[2 * o] ?? 0) + (range[2 * o + 1] ?? 1)) / 2);
  return () => constOut;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pdffunction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdffunction.ts test/pdffunction.test.ts
git commit -m "feat(3sh.1): PDF function evaluator (types 0/2/3) for tints and shadings"
```

---

### Task 3: Colorspace → RGB converter (`src/colorspace.ts`)

**Files:**
- Create: `src/colorspace.ts`
- Test: `test/colorspace.test.ts`

**Interfaces:**
- Consumes: `parseFunction` (Task 2); `Resolve`/`Inflate`.
- Produces:
  - `export type Rgb = [number, number, number]` (0–255 ints).
  - `export interface ColorConverter { components: number; toRgb(c: number[]): Rgb; initial(): Rgb; }` — `components` is the operand count for `sc`/`scn`; `initial()` is the default color for the space.
  - `export function resolveColorSpace(cs: PdfObject, resolve: Resolve, inflate: Inflate): ColorConverter`.
  - `export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb`.
  - `export function rgbHex(rgb: Rgb): string` → `#rrggbb`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/colorspace.test.ts
import { describe, it, expect } from 'vitest';
import { resolveColorSpace, cmykToRgb, rgbHex } from '../src/colorspace.js';
import { PdfObject, PdfDict, name } from '../src/types.js';

const id = (o: PdfObject | undefined): PdfObject => o ?? null;
const inflate = (s: { raw: Uint8Array }) => s.raw;

describe('resolveColorSpace', () => {
  it('DeviceRGB maps components straight through', () => {
    const cv = resolveColorSpace(name('DeviceRGB'), id, inflate);
    expect(cv.components).toBe(3);
    expect(cv.toRgb([1, 0, 0])).toEqual([255, 0, 0]);
  });

  it('DeviceGray expands to gray', () => {
    const cv = resolveColorSpace(name('DeviceGray'), id, inflate);
    expect(cv.components).toBe(1);
    expect(cv.toRgb([0.5])).toEqual([128, 128, 128]);
  });

  it('DeviceCMYK uses the naive conversion', () => {
    const cv = resolveColorSpace(name('DeviceCMYK'), id, inflate);
    expect(cv.toRgb([0, 0, 0, 0])).toEqual([255, 255, 255]);
    expect(cv.toRgb([0, 0, 0, 1])).toEqual([0, 0, 0]);
  });

  it('Indexed looks up a palette', () => {
    // [/Indexed /DeviceRGB 1 <hival lookup>] palette: index0=red index1=green
    const lookup: PdfObject = { kind: 'string', bytes: Uint8Array.from([255, 0, 0, 0, 255, 0]) };
    const cs: PdfObject = [name('Indexed'), name('DeviceRGB'), 1, lookup];
    const cv = resolveColorSpace(cs, id, inflate);
    expect(cv.components).toBe(1);
    expect(cv.toRgb([0])).toEqual([255, 0, 0]);
    expect(cv.toRgb([1])).toEqual([0, 255, 0]);
  });

  it('unknown colorspace falls back to gray-capable converter', () => {
    const cv = resolveColorSpace(name('Weird'), id, inflate);
    expect(cv.toRgb([0.5])).toEqual([128, 128, 128]);
  });
});

describe('helpers', () => {
  it('cmykToRgb and rgbHex', () => {
    expect(cmykToRgb(0, 0, 0, 0)).toEqual([255, 255, 255]);
    expect(rgbHex([255, 0, 16])).toBe('#ff0010');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/colorspace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/colorspace.ts
import { PdfDict, PdfObject, isName, isArray, isString, isStream, isDict } from './types.js';
import { parseFunction, PdfFunction } from './pdffunction.js';

export type Rgb = [number, number, number];
type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

export interface ColorConverter {
  components: number;
  toRgb(c: number[]): Rgb;
  initial(): Rgb;
}

const b = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  return [b((1 - c) * (1 - k)), b((1 - m) * (1 - k)), b((1 - y) * (1 - k))];
}

export function rgbHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}

const gray: ColorConverter = {
  components: 1,
  toRgb: (c) => [b(c[0] ?? 0), b(c[0] ?? 0), b(c[0] ?? 0)],
  initial: () => [0, 0, 0],
};
const rgb: ColorConverter = {
  components: 3,
  toRgb: (c) => [b(c[0] ?? 0), b(c[1] ?? 0), b(c[2] ?? 0)],
  initial: () => [0, 0, 0],
};
const cmyk: ColorConverter = {
  components: 4,
  toRgb: (c) => cmykToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0),
  initial: () => [0, 0, 0],
};

/** Resolve a /ColorSpace operand (name or array, possibly via /Resources) into a
 *  component→RGB converter. Never throws; unknown → gray. */
export function resolveColorSpace(cs: PdfObject, resolve: Resolve, inflate: Inflate): ColorConverter {
  const r = resolve(cs);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return gray;
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return rgb;
      case 'DeviceCMYK': case 'CMYK': return cmyk;
      case 'Pattern': return { ...gray, components: 1 };
      default: return gray;
    }
  }
  if (isArray(r) && r.length > 0) {
    const head = resolve(r[0]);
    const fam = isName(head) ? head.name : '';
    switch (fam) {
      case 'ICCBased': {
        const stream = resolve(r[1]);
        const n = isStream(stream) ? (resolve(stream.dict.get('N')) as number) : 3;
        const alt = isStream(stream) ? stream.dict.get('Alternate') : undefined;
        if (alt) return resolveColorSpace(alt, resolve, inflate);
        return n === 1 ? gray : n === 4 ? cmyk : rgb;
      }
      case 'CalGray': return gray;
      case 'CalRGB': case 'Lab': return fam === 'Lab' ? labConverter() : rgb;
      case 'Indexed': case 'I': return indexedConverter(r, resolve, inflate);
      case 'Separation': return separationConverter(r, 1, resolve, inflate);
      case 'DeviceN': {
        const names = resolve(r[1]);
        const cnt = isArray(names) ? names.length : 1;
        return separationConverter(r, cnt, resolve, inflate);
      }
      case 'Pattern':
        return r.length > 1 ? resolveColorSpace(r[1], resolve, inflate) : gray;
      default: return gray;
    }
  }
  return gray;
}

function indexedConverter(arr: PdfObject[], resolve: Resolve, inflate: Inflate): ColorConverter {
  const base = resolveColorSpace(arr[1], resolve, inflate);
  const lookupObj = resolve(arr[3]);
  let table: Uint8Array;
  if (isString(lookupObj)) table = lookupObj.bytes;
  else if (isStream(lookupObj)) table = inflate(lookupObj);
  else table = new Uint8Array(0);
  const nc = base.components;
  return {
    components: 1,
    toRgb: (c) => {
      const i = Math.max(0, Math.round(c[0] ?? 0));
      const comps: number[] = [];
      for (let k = 0; k < nc; k++) comps.push((table[i * nc + k] ?? 0) / 255);
      return base.toRgb(comps);
    },
    initial: () => base.toRgb(new Array(nc).fill(0)),
  };
}

function separationConverter(arr: PdfObject[], n: number, resolve: Resolve, inflate: Inflate): ColorConverter {
  // [/Separation name alt tint] or [/DeviceN names alt tint]
  const altIdx = 2;
  const alt = resolveColorSpace(arr[altIdx], resolve, inflate);
  let tint: PdfFunction = (x) => new Array(alt.components).fill(x[0] ?? 0);
  const fnObj = arr[altIdx + 1];
  if (fnObj !== undefined) tint = parseFunction(fnObj, resolve, inflate);
  return {
    components: n,
    toRgb: (c) => alt.toRgb(tint(c.length ? c : [1])),
    initial: () => alt.toRgb(tint(new Array(n).fill(1))),
  };
}

/** CIE L*a*b* → sRGB (D50 white). Approximate; adequate for preview. */
function labConverter(): ColorConverter {
  return {
    components: 3,
    toRgb: (c) => {
      const L = c[0] ?? 0, A = c[1] ?? 0, B = c[2] ?? 0;
      const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
      const g = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
      const xn = 0.9642, yn = 1.0, zn = 0.8249;
      const X = xn * g(fx), Y = yn * g(fy), Z = zn * g(fz);
      let R = 3.1338 * X - 1.6168 * Y - 0.4906 * Z;
      let G = -0.9787 * X + 1.9161 * Y + 0.0334 * Z;
      let Bl = 0.0719 * X - 0.2289 * Y + 1.4052 * Z;
      const gamma = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
      return [b(gamma(R)), b(gamma(G)), b(gamma(Bl))];
    },
    initial: () => [0, 0, 0],
  };
}
```

Note: confirm `name()` and `isString`/`isStream` are exported from `src/types.ts` (they are — see `object-parser.ts` usage). If `name()` is absent, construct `{ kind: 'name', name: 'DeviceRGB' }` in the test instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/colorspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/colorspace.ts test/colorspace.test.ts
git commit -m "feat(3sh.1): colorspace resolver (Device/Indexed/ICC/Separation/Lab) -> RGB"
```

---

### Task 4: SVG renderer skeleton — geometry, CropBox, Rotate, `Page.ToSvg()`

**Files:**
- Create: `src/svgrender.ts`
- Modify: `src/page.ts` (add `ToSvg`), `src/index.ts` (export `SvgOptions`)
- Create: `test/helpers/build-svg-fixtures.ts`
- Create: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `Document`, `Page`, matrix helpers `mul`/`apply`/`translate` and `Matrix`/`IDENTITY` from `src/text.js`.
- Produces:
  - `export interface SvgOptions { box?: 'crop' | 'media'; }`
  - `export function renderPageToSvg(doc: Document, page: Page, opts?: SvgOptions): string`
  - Internal (module-scoped, relied on by later tasks): a class `SvgWriter` accumulating body strings + a `<defs>` map + a running id counter; `escapeXml(s)`; `fmt(n)` (trims float noise to ≤4 dp); `baseMatrix(page, box)` returning `{ matrix: Matrix; width: number; height: number }`.

- [ ] **Step 1: Write the fixture builder and failing test**

Add to a new `test/helpers/build-svg-fixtures.ts`:

```typescript
// test/helpers/build-svg-fixtures.ts
import { deflateSync } from 'node:zlib';

const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

/** Assemble a 1-page classic-xref PDF from a page dict body + content bytes +
 *  extra objects. `pageExtra` is spliced into the page dict (e.g. Rotate). */
export function buildSvgPdf(opts: {
  mediaBox?: number[];
  cropBox?: number[];
  rotate?: number;
  resources?: string;
  content: string | Uint8Array;
  extra?: Record<number, Obj>; // object number -> body (numbers >= 5)
}): Uint8Array {
  const mb = opts.mediaBox ?? [0, 0, 200, 200];
  const cb = opts.cropBox ? ` /CropBox [${opts.cropBox.join(' ')}]` : '';
  const rot = opts.rotate !== undefined ? ` /Rotate ${opts.rotate}` : '';
  const res = opts.resources ?? '<< >>';
  const contentRaw = typeof opts.content === 'string' ? enc(opts.content) : opts.content;

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [${mb.join(' ')}]${cb}${rot} /Resources ${res} /Contents 4 0 R >>`;
  objs[4] = { dict: `<< /Length ${contentRaw.length} >>`, raw: contentRaw };
  if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) objs[Number(k)] = v;
  const maxObj = objs.length - 1;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);

  push(enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = length;
    const o = objs[n];
    if (o === undefined) continue;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else {
      push(enc(`${n} 0 obj\n${o.dict}\nstream\n`));
      push(o.raw);
      push(enc(`\nendstream\nendobj\n`));
    }
  }
  const xrefOff = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Flate-compress helper for image/content stream builders. */
export function flate(bytes: Uint8Array | string): Uint8Array {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(deflateSync(Buffer.from(b)));
}
```

```typescript
// test/svgrender.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — geometry', () => {
  it('returns a standalone <svg> sized to the CropBox', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/width="300"/);
    expect(svg).toMatch(/height="400"/);
    expect(svg).toMatch(/viewBox="0 0 300 400"/);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('swaps width/height for /Rotate 90', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], rotate: 90, content: '' }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/width="400"/);
    expect(svg).toMatch(/height="300"/);
  });

  it('honors a non-zero-origin CropBox', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 300, 400], cropBox: [50, 60, 250, 360], content: '',
    }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/width="200"/);
    expect(svg).toMatch(/height="300"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts`
Expected: FAIL — `ToSvg` is not a function.

- [ ] **Step 3: Implement the skeleton**

```typescript
// src/svgrender.ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul } from './text.js';

export interface SvgOptions {
  /** Which page box defines the viewport. Default 'crop'. */
  box?: 'crop' | 'media';
}

/** Format a number for SVG output: fixed to ≤4 dp, trailing zeros stripped. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;');
}

export function matrixAttr(m: Matrix): string {
  return `matrix(${m.map(fmt).join(' ')})`;
}

/** Accumulates SVG body markup plus a <defs> section with unique ids. */
export class SvgWriter {
  private body: string[] = [];
  private defs: string[] = [];
  private idSeq = 0;
  nextId(prefix: string): string { return `${prefix}${this.idSeq++}`; }
  emit(s: string): void { this.body.push(s); }
  addDef(s: string): void { this.defs.push(s); }
  finish(width: number, height: number): string {
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" `
      + `viewBox="0 0 ${fmt(width)} ${fmt(height)}">${defs}${this.body.join('')}</svg>`;
  }
}

/** The PDF-user-space → SVG-pixel-space base matrix, plus the output size.
 *  Flips Y (PDF up → SVG down), offsets by the box origin, applies /Rotate. */
export function baseMatrix(page: Page, box: 'crop' | 'media'): { matrix: Matrix; width: number; height: number } {
  const b = box === 'media' ? page.MediaBox : page.CropBox;
  const [x0, y0, x1, y1] = b;
  const w0 = Math.abs(x1 - x0); const h0 = Math.abs(y1 - y0);
  const flip: Matrix = [1, 0, 0, -1, -Math.min(x0, x1), Math.max(y0, y1)];
  const rot = ((page.Rotate % 360) + 360) % 360;
  let r: Matrix;
  let width = w0; let height = h0;
  switch (rot) {
    case 90:  r = [0, 1, -1, 0, h0, 0];  width = h0; height = w0; break;
    case 180: r = [-1, 0, 0, -1, w0, h0]; break;
    case 270: r = [0, -1, 1, 0, 0, w0];  width = h0; height = w0; break;
    default:  r = [1, 0, 0, 1, 0, 0];
  }
  return { matrix: mul(flip, r), width, height };
}

/** Render one page to a standalone SVG string. Never throws. */
export function renderPageToSvg(doc: Document, page: Page, opts: SvgOptions = {}): string {
  const box = opts.box ?? 'crop';
  const { matrix, width, height } = baseMatrix(page, box);
  const w = new SvgWriter();
  try {
    interpret(doc, page, matrix, w);
  } catch {
    // Degrade: whatever was emitted before the failure still renders.
  }
  return w.finish(width, height);
}

/** Walk the page content under the base CTM, emitting SVG. Grows across tasks. */
function interpret(_doc: Document, _page: Page, _base: Matrix, _w: SvgWriter): void {
  // Filled in by Tasks 5–10.
}
```

Add to `src/page.ts` — import at top with the other imports:

```typescript
import { renderPageToSvg, SvgOptions } from './svgrender.js';
```

And a method on the `Page` class (place after `Graphics()`):

```typescript
  /** Render this page to a standalone SVG document string. Interprets the
   *  content stream (paths, text, images, clipping, gradients) under the page's
   *  /Rotate and CropBox. Text is emitted as positioned <text>. Unsupported
   *  content degrades (gray fallback / placeholder) rather than throwing. */
  ToSvg(options?: SvgOptions): string {
    return renderPageToSvg(this.doc, this, options);
  }
```

Add to `src/index.ts` (near the other page-related type exports):

```typescript
export type { SvgOptions } from './svgrender.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS (3 tests) and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts src/page.ts src/index.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): Page.ToSvg skeleton — viewport, CropBox, Rotate"
```

---

### Task 5: Paths — construction, painting, color, line style

**Files:**
- Modify: `src/svgrender.ts` (replace the `interpret` stub with the graphics-state loop; add path/color state)
- Modify: `test/helpers/build-svg-fixtures.ts` (add `vectorContent`)
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `parseContentStream`/`ContentOp` from `src/content.js`; `resolveColorSpace`/`rgbHex`/`Rgb` from `src/colorspace.js`; `inflateStream` from `src/flate.js`; matrix helpers from `src/text.js`.
- Produces (module-internal, relied on by Tasks 6–10): a `GState` interface and a `walk()` function that dispatches ops. Later tasks extend the same `switch`.

- [ ] **Step 1: Add fixture content + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
/** A page drawing: a red even-odd filled rect, a blue stroked dashed line. */
export const VECTOR_CONTENT =
  '1 0 0 rg 20 20 60 60 re f* ' +           // red fill, even-odd
  '0 0 1 RG 4 w [6 3] 0 d 100 100 m 180 180 l S';
```

Append to `test/svgrender.test.ts`:

```typescript
import { VECTOR_CONTENT } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — paths', () => {
  it('emits filled and stroked paths with fill-rule, color, dash', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: VECTOR_CONTENT }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<path[^>]*fill-rule="evenodd"/);
    expect(svg).toMatch(/<path[^>]*fill="#ff0000"/);
    expect(svg).toMatch(/<path[^>]*stroke="#0000ff"/);
    expect(svg).toMatch(/<path[^>]*stroke-width="4"/);
    expect(svg).toMatch(/<path[^>]*stroke-dasharray="6 3"/);
    // the fill path must not also carry a stroke
    expect(svg).toMatch(/<path[^>]*fill="#ff0000"[^>]*stroke="none"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t paths`
Expected: FAIL — no `<path>` emitted.

- [ ] **Step 3: Replace `interpret` with the graphics-state loop**

In `src/svgrender.ts` add imports:

```typescript
import { PdfDict, PdfObject, isName, isArray, isStream, isDict } from './types.js';
import { parseContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { apply, translate, IDENTITY, vscale } from './text.js';
import { resolveColorSpace, rgbHex, Rgb, ColorConverter } from './colorspace.js';
```

Replace the `interpret` stub with:

```typescript
interface GState {
  ctm: Matrix;
  fill: Rgb; stroke: Rgb;
  fillCs: ColorConverter; strokeCs: ColorConverter;
  lineWidth: number; dash: string; cap: number; join: number; miter: number;
  // text state (Task 6)
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
  fontSize: number; fontFamily: string; fontBold: boolean; fontItalic: boolean;
  fontRef?: PdfDict;
  tm: Matrix; tlm: Matrix;
}

function initialState(base: Matrix): GState {
  return {
    ctm: base, fill: [0, 0, 0], stroke: [0, 0, 0],
    fillCs: deviceGray(), strokeCs: deviceGray(),
    lineWidth: 1, dash: '', cap: 0, join: 0, miter: 10,
    charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0,
    fontSize: 0, fontFamily: 'sans-serif', fontBold: false, fontItalic: false,
    tm: IDENTITY, tlm: IDENTITY,
  };
}
function deviceGray(): ColorConverter {
  return { components: 1, toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; }, initial: () => [0, 0, 0] };
}
function clone(s: GState): GState { return { ...s }; }

function num(o: PdfObject | undefined): number { return typeof o === 'number' ? o : 0; }
function numbers(a: PdfObject[]): number[] { return a.filter((x): x is number => typeof x === 'number'); }

interface RenderCtx {
  doc: Document; w: SvgWriter;
  resources: PdfDict | undefined;
  depth: number; seen: Set<PdfDict>;
}

function interpret(doc: Document, page: Page, base: Matrix, w: SvgWriter): void {
  const ctx: RenderCtx = { doc, w, resources: page.Resources, depth: 0, seen: new Set() };
  const bytes = contentBytes(doc, page);
  walk(ctx, bytes, initialState(base));
}

function contentBytes(doc: Document, page: Page): Uint8Array {
  return page.Contents; // already inflated + joined by Page.Contents
}

/** Resolve a named resource sub-dict (Font, XObject, ColorSpace, Pattern, Shading). */
function resDict(ctx: RenderCtx, category: string): PdfDict | undefined {
  const r = ctx.doc.resolve(ctx.resources?.get(category));
  return isDict(r) ? r : undefined;
}

function walk(ctx: RenderCtx, bytes: Uint8Array, initial: GState): void {
  const ops = parseContentStream(bytes);
  const stack: GState[] = [];
  let gs = initial;

  // Path construction: subpaths of device-independent (user-space) points, but we
  // keep them in *user* space and emit under the CTM transform.
  let d = '';                      // current SVG path data (user space)
  let started = false;
  const resetPath = () => { d = ''; started = false; };
  const paint = (fill: boolean, stroke: boolean, evenOdd: boolean) => {
    if (!d) { resetPath(); return; }
    const attrs: string[] = [`d="${d.trim()}"`, `transform="${matrixAttr(gs.ctm)}"`];
    attrs.push(`fill="${fill ? rgbHex(gs.fill) : 'none'}"`);
    if (fill && evenOdd) attrs.push(`fill-rule="evenodd"`);
    attrs.push(`stroke="${stroke ? rgbHex(gs.stroke) : 'none'}"`);
    if (stroke) {
      attrs.push(`stroke-width="${fmt(gs.lineWidth)}"`);
      if (gs.dash) attrs.push(`stroke-dasharray="${gs.dash}"`);
      if (gs.cap) attrs.push(`stroke-linecap="${gs.cap === 1 ? 'round' : 'square'}"`);
      if (gs.join) attrs.push(`stroke-linejoin="${gs.join === 1 ? 'round' : 'bevel'}"`);
    }
    ctx.w.emit(`<path ${attrs.join(' ')}/>`);
    resetPath();
  };

  for (const op of ops) {
    const o = op.operands;
    switch (op.operator) {
      case 'q': stack.push(clone(gs)); break;
      case 'Q': gs = stack.pop() ?? gs; break;
      case 'cm': { const m = numbers(o); if (m.length === 6) gs.ctm = mul(m as Matrix, gs.ctm); break; }

      // path construction (user space)
      case 'm': { const [x, y] = numbers(o); d += `M${fmt(x)} ${fmt(y)}`; started = true; break; }
      case 'l': { const [x, y] = numbers(o); if (started) d += `L${fmt(x)} ${fmt(y)}`; break; }
      case 'c': { const n = numbers(o); if (n.length === 6) d += `C${n.map(fmt).join(' ')}`; break; }
      case 'v': { const n = numbers(o); if (n.length === 4) d += `S${n.map(fmt).join(' ')}`; break; }
      case 'y': { const n = numbers(o); if (n.length === 4) d += `C${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])} ${fmt(n[3])} ${fmt(n[2])} ${fmt(n[3])}`; break; }
      case 're': { const [x, y, ww, hh] = numbers(o); d += `M${fmt(x)} ${fmt(y)}h${fmt(ww)}v${fmt(hh)}h${fmt(-ww)}Z`; started = true; break; }
      case 'h': { if (started) d += 'Z'; break; }

      // painting
      case 'S': case 's': paint(false, true, false); break;
      case 'f': case 'F': paint(true, false, false); break;
      case 'f*': paint(true, false, true); break;
      case 'B': case 'b': paint(true, true, false); break;
      case 'B*': case 'b*': paint(true, true, true); break;
      case 'n': resetPath(); break;

      // line style
      case 'w': gs.lineWidth = num(o[0]); break;
      case 'J': gs.cap = num(o[0]); break;
      case 'j': gs.join = num(o[0]); break;
      case 'M': gs.miter = num(o[0]); break;
      case 'd': { const arr = isArray(o[0]) ? numbers(o[0]) : []; gs.dash = arr.map(fmt).join(' '); break; }

      // color
      case 'g': gs.fillCs = deviceGray(); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'G': gs.strokeCs = deviceGray(); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'rg': gs.fillCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'RG': gs.strokeCs = resolveColorSpace(nm('DeviceRGB'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'k': gs.fillCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'K': gs.strokeCs = resolveColorSpace(nm('DeviceCMYK'), r(ctx), inf(ctx)); gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      case 'cs': gs.fillCs = lookupCs(ctx, o[0]); gs.fill = gs.fillCs.initial(); break;
      case 'CS': gs.strokeCs = lookupCs(ctx, o[0]); gs.stroke = gs.strokeCs.initial(); break;
      case 'sc': case 'scn': gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      case 'SC': case 'SCN': gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;

      // text + images + clip + shading + forms added in later tasks
    }
  }
}

// small helpers to pass resolve/inflate closures to colorspace/pdffunction
function r(ctx: RenderCtx) { return (o: PdfObject | undefined) => ctx.doc.resolve(o); }
function inf(_ctx: RenderCtx) { return (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]); }
function nm(name: string): PdfObject { return { kind: 'name', name }; }

/** Resolve a `cs`/`CS` operand: a device name or a /ColorSpace resource entry. */
function lookupCs(ctx: RenderCtx, operand: PdfObject | undefined): ColorConverter {
  if (isName(operand)) {
    const direct = ['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK'];
    if (direct.includes(operand.name)) return resolveColorSpace(operand, r(ctx), inf(ctx));
    const csDict = resDict(ctx, 'ColorSpace');
    const entry = csDict?.get(operand.name);
    if (entry !== undefined) return resolveColorSpace(entry, r(ctx), inf(ctx));
  }
  return deviceGray();
}
```

Note: this replaces the earlier stub `interpret` and the `contentBytes` call uses `Page.Contents`. Keep `RenderCtx.resources`/`depth`/`seen` for Tasks 7 & 10.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS (geometry + paths).

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret paths — construction, painting, color, line style"
```

---

### Task 6: Text — positioned `<text>` with the text-state machine

**Files:**
- Modify: `src/svgrender.ts` (add text ops to the `walk` switch + a `showText` helper)
- Modify: `test/helpers/build-svg-fixtures.ts`
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `TextFont` from `src/font.js`; `isString` from `src/types.js`.
- Produces: text handling inside `walk`. The text-space→pixel recipe: with `L = mul(mul(translate(0, rise), gs.tm), gs.ctm)`, the SVG `<text>` transform is `[L0, L1, -L2, -L3, L4, L5]` and `font-size = fontSize`, glyphs at x=0 y=0 (keeps glyphs upright under the base Y-flip).

- [ ] **Step 1: Add fixtures + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
/** A page showing "Hi" in Helvetica at (72,100), size 24. Requires a font resource. */
export const TEXT_CONTENT = 'BT /F1 24 Tf 72 100 Td (Hi) Tj ET';
export const HELV_RESOURCES = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >>';
```

Append to `test/svgrender.test.ts`:

```typescript
import { TEXT_CONTENT, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — text', () => {
  it('emits positioned <text> with font-size, family, and fill', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT,
    }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<text[^>]*font-size="24"/);
    expect(svg).toMatch(/<text[^>]*>Hi<\/text>/);
    expect(svg).toMatch(/font-family="sans-serif"/);
    expect(svg).toMatch(/font-weight="bold"/);
    // baseline at pixel y = 200 - 100 = 100 (identity page): transform ends with 72 100
    expect(svg).toMatch(/<text[^>]*transform="matrix\(1 0 0 1 72 100\)"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t text`
Expected: FAIL — no `<text>`.

- [ ] **Step 3: Add text handling**

Add imports to `src/svgrender.ts`:

```typescript
import { TextFont } from './font.js';
import { isString } from './types.js';
```

Add these cases to the `walk` switch (alongside the existing ones). First, a font cache on the loop — declare near the top of `walk`:

```typescript
  const fontCache = new Map<PdfDict, TextFont>();
```

Then the cases:

```typescript
      case 'BT': gs.tm = IDENTITY; gs.tlm = IDENTITY; break;
      case 'ET': break;
      case 'Tc': gs.charSp = num(o[0]); break;
      case 'Tw': gs.wordSp = num(o[0]); break;
      case 'Tz': gs.hscale = (num(o[0]) / 100) || 1; break;
      case 'TL': gs.leading = num(o[0]); break;
      case 'Ts': gs.rise = num(o[0]); break;
      case 'Td': { const [tx, ty] = numbers(o); textMove(gs, tx, ty); break; }
      case 'TD': { const [tx, ty] = numbers(o); gs.leading = -ty; textMove(gs, tx, ty); break; }
      case 'Tm': { const m = numbers(o); if (m.length === 6) { gs.tlm = m as Matrix; gs.tm = m as Matrix; } break; }
      case 'T*': textMove(gs, 0, -gs.leading); break;
      case 'Tf': {
        gs.fontSize = num(o[1]);
        const fn = o[0];
        const fonts = resDict(ctx, 'Font');
        if (isName(fn) && fonts) {
          const fd = ctx.doc.resolve(fonts.get(fn.name));
          if (isDict(fd)) {
            let tf = fontCache.get(fd);
            if (!tf) { tf = new TextFont(fd, r(ctx), inf(ctx)); fontCache.set(fd, tf); }
            gs.fontRef = fd;
            gs.font = tf;
            applyFontStyle(gs, tf.name);
          }
        }
        break;
      }
      case 'Tj': showText(ctx, gs, o[0]); break;
      case 'TJ': showArray(ctx, gs, o[0]); break;
      case "'": textMove(gs, 0, -gs.leading); showText(ctx, gs, o[0]); break;
      case '"': gs.wordSp = num(o[0]); gs.charSp = num(o[1]); textMove(gs, 0, -gs.leading); showText(ctx, gs, o[2]); break;
```

Add `font?: TextFont;` to the `GState` interface. Add these module functions:

```typescript
function textMove(gs: GState, tx: number, ty: number): void {
  gs.tlm = mul(translate(tx, ty), gs.tlm);
  gs.tm = gs.tlm;
}

function applyFontStyle(gs: GState, baseFont?: string): void {
  const nfont = (baseFont ?? '').toLowerCase();
  gs.fontBold = /bold|black|heavy|semibold/.test(nfont);
  gs.fontItalic = /italic|oblique/.test(nfont);
  gs.fontFamily = /courier|mono|consol/.test(nfont) ? 'monospace'
    : /times|serif|georgia|roman|minion/.test(nfont) ? 'serif' : 'sans-serif';
}

/** Emit one <text> for a show string and advance the text matrix. */
function showText(ctx: RenderCtx, gs: GState, strObj: PdfObject | undefined): void {
  if (!isString(strObj) || !gs.font) return;
  const run = gs.font.decodeRun(strObj.bytes);
  const text = run.text;
  // Placement matrix at the run origin (rise folded in).
  const L = mul(mul(translate(0, gs.rise), gs.tm), gs.ctm);
  if (text.length > 0) {
    const attrs = [
      `transform="matrix(${[L[0], L[1], -L[2], -L[3], L[4], L[5]].map(fmt).join(' ')})"`,
      `font-size="${fmt(gs.fontSize)}"`,
      `font-family="${gs.fontFamily}"`,
    ];
    if (gs.fontBold) attrs.push('font-weight="bold"');
    if (gs.fontItalic) attrs.push('font-style="italic"');
    attrs.push(`fill="${rgbHex(gs.fill)}"`);
    if (gs.hscale !== 1) attrs.push(`textLength="${fmt(run.width * gs.fontSize * gs.hscale)}" lengthAdjust="spacingAndGlyphs"`);
    ctx.w.emit(`<text ${attrs.join(' ')}>${escapeXml(text)}</text>`);
  }
  // Advance: sum of glyph widths + spacing, in text space.
  const adv = (run.width * gs.fontSize + run.ncodes * gs.charSp + run.nWordSpaces * gs.wordSp) * gs.hscale;
  gs.tm = mul(translate(adv, 0), gs.tm);
}

/** Handle a TJ array: strings show, numbers shift the text matrix. */
function showArray(ctx: RenderCtx, gs: GState, arrObj: PdfObject | undefined): void {
  if (!isArray(arrObj) || !gs.font) return;
  for (const el of arrObj) {
    if (isString(el)) showText(ctx, gs, el);
    else if (typeof el === 'number') gs.tm = mul(translate((-el / 1000) * gs.fontSize * gs.hscale, 0), gs.tm);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS. If the embedded-font case is needed, it is covered in Task 6b below via a second fixture — but a single Standard-14 test suffices to pass this task.

- [ ] **Step 5: Add embedded-font coverage, then commit**

Append to `test/svgrender.test.ts` an embedded-font assertion using the existing helper that builds a Type0/ToUnicode font — reuse `buildTextPdf`-style fonts if present, else a simple Type1 with `/Differences`. Concretely, add:

```typescript
it('decodes an embedded simple font with /Differences', () => {
  const res = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Custom '
    + '/Encoding << /Type /Encoding /Differences [65 /A /B] >> /FirstChar 65 /LastChar 66 '
    + '/Widths [500 500] >> >> >>';
  const doc = Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200], resources: res, content: 'BT /F1 12 Tf 10 10 Td (AB) Tj ET',
  }));
  const svg = doc.Pages[0].ToSvg();
  expect(svg).toMatch(/<text[^>]*>AB<\/text>/);
});
```

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret text — positioned <text> with text-state machine"
```

---

### Task 7: Images — `<image>` data URIs (JPEG passthrough, PNG encode, masks, placeholder)

**Files:**
- Modify: `src/svgrender.ts` (add `Do` image branch + inline `BI` + `drawImage` helper)
- Modify: `test/helpers/build-svg-fixtures.ts`
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `ImageInfo` from `src/image.js`; `encodePng`/`pngDataUri` from `src/pngencode.js`; `resolveColorSpace` from `src/colorspace.js`.
- Produces: `drawImage(ctx, gs, stream)` and inline-image handling. Images draw the unit square with a local Y-flip: `transform = mul([1,0,0,-1,0,1], gs.ctm)`.

- [ ] **Step 1: Add fixtures + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
import { encodePng } from '../../src/pngencode.js'; // not needed here; keep imports minimal

/** A page drawing one 2x2 DeviceRGB Flate image (Im0) scaled to fill. */
export function flateImagePdf(buildSvgPdf: (o: any) => Uint8Array, flate: (b: Uint8Array | string) => Uint8Array): Uint8Array {
  const samples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const raw = flate(samples);
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /XObject << /Im0 5 0 R >> >>',
    content: 'q 100 0 0 100 0 0 cm /Im0 Do Q',
    extra: { 5: { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length} >>`, raw } },
  });
}

/** A page drawing a DCTDecode (JPEG) image. */
export function jpegImagePdf(buildSvgPdf: (o: any) => Uint8Array): Uint8Array {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /XObject << /Jp 5 0 R >> >>',
    content: 'q 100 0 0 100 0 0 cm /Jp Do Q',
    extra: { 5: { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, raw: jpeg } },
  });
}
```

Append to `test/svgrender.test.ts`:

```typescript
import { buildSvgPdf, flate, flateImagePdf, jpegImagePdf } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — images', () => {
  it('embeds a DCTDecode image as a JPEG data URI', () => {
    const doc = Document.Open(jpegImagePdf(buildSvgPdf));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<image[^>]*href="data:image\/jpeg;base64,/);
    expect(svg).toMatch(/<image[^>]*transform="matrix\(/);
  });

  it('re-encodes a Flate image as a PNG data URI', () => {
    const doc = Document.Open(flateImagePdf(buildSvgPdf, flate));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<image[^>]*href="data:image\/png;base64,/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t images`
Expected: FAIL — no `<image>`.

- [ ] **Step 3: Add image handling**

Add imports:

```typescript
import { ImageInfo } from './image.js';
import { encodePng, pngDataUri, PngKind } from './pngencode.js';
```

Add to the `walk` switch:

```typescript
      case 'BI':
        if (op.inlineImage) drawInlineImage(ctx, gs, op.inlineImage);
        break;
      case 'Do': {
        const xn = o[0];
        const xobjs = resDict(ctx, 'XObject');
        if (!isName(xn) || !xobjs) break;
        const xo = ctx.doc.resolve(xobjs.get(xn.name));
        if (!isStream(xo)) break;
        const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
        if (isName(sub) && sub.name === 'Image') { drawImage(ctx, gs, xo); break; }
        // Form XObject: handled in Task 10 (falls through to no-op until then).
        drawForm(ctx, gs, xo);
        break;
      }
```

Add helpers:

```typescript
/** The unit-square placement transform for an image under the current CTM,
 *  with a local Y-flip (PDF image row 0 is the top of the unit square). */
function imageTransform(ctm: Matrix): string {
  return matrixAttr(mul([1, 0, 0, -1, 0, 1], ctm));
}

function drawImage(ctx: RenderCtx, gs: GState, stream: { dict: PdfDict; raw: Uint8Array }): void {
  const info = new ImageInfo(ctx.doc, '', stream as Parameters<typeof ImageInfo>[2] extends never ? any : any);
  const href = imageHref(ctx, gs, stream);
  if (href) {
    ctx.w.emit(`<image x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="${imageTransform(gs.ctm)}" href="${href}"/>`);
  } else {
    // undecodable → gray placeholder at the unit square
    ctx.w.emit(`<rect x="0" y="0" width="1" height="1" transform="${imageTransform(gs.ctm)}" fill="#cccccc"/>`);
  }
}

/** Build a data: URI for an image stream. JPEG passthrough; else decode + PNG. */
function imageHref(ctx: RenderCtx, gs: GState, stream: { dict: PdfDict; raw: Uint8Array }): string | undefined {
  const info = new ImageInfo(ctx.doc, '', stream as any);
  const filter = info.Filter;
  if (filter === 'DCTDecode' || filter === 'DCT') {
    return `data:image/jpeg;base64,${Buffer.from(info.RawData).toString('base64')}`;
  }
  try {
    const width = info.Width, height = info.Height;
    if (!width || !height) return undefined;
    const samples = info.Decode();
    const dict = stream.dict;
    if (ctx.doc.resolve(dict.get('ImageMask')) === true) {
      return maskHref(samples, width, height, gs.fill);
    }
    const png = samplesToPng(ctx, dict, samples, width, height);
    return png ? pngDataUri(png) : undefined;
  } catch {
    return undefined;
  }
}

/** Convert decoded samples to an RGB(A) PNG using the image's colorspace. */
function samplesToPng(ctx: RenderCtx, dict: PdfDict, samples: Uint8Array, width: number, height: number): Uint8Array | undefined {
  const bpc = num(ctx.doc.resolve(dict.get('BitsPerComponent'))) || 8;
  if (bpc !== 8) return undefined; // v1: 8-bit only (else placeholder)
  const csObj = dict.get('ColorSpace');
  const cs = csObj !== undefined ? resolveColorSpace(csObj, r(ctx), inf(ctx)) : deviceGrayCs();
  const nc = cs.components;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const comps: number[] = [];
    for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / (cs === indexedMarker ? 1 : 255));
    const [rr, gg, bb] = cs.toRgb(nc === 1 && isIndexed(dict, ctx) ? [samples[i] ?? 0] : comps);
    rgb[i * 3] = rr; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = bb;
  }
  return encodePng(width, height, rgb, 'rgb');
}
```

Simplify `samplesToPng` per the note below — the indexed handling above is over-complicated. Use this cleaner version instead:

```typescript
function deviceGrayCs(): ColorConverter { return deviceGray(); }

function samplesToPng(ctx: RenderCtx, dict: PdfDict, samples: Uint8Array, width: number, height: number): Uint8Array | undefined {
  const bpc = num(ctx.doc.resolve(dict.get('BitsPerComponent'))) || 8;
  if (bpc !== 8) return undefined;
  const csObj = dict.get('ColorSpace');
  const isIndexedCs = isIndexedColorSpace(ctx, csObj);
  const cs = csObj !== undefined ? resolveColorSpace(csObj, r(ctx), inf(ctx)) : deviceGray();
  const nc = cs.components;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let out: Rgb;
    if (isIndexedCs) out = cs.toRgb([samples[i] ?? 0]);           // palette index, raw
    else {
      const comps: number[] = [];
      for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / 255);
      out = cs.toRgb(comps);
    }
    rgb[i * 3] = out[0]; rgb[i * 3 + 1] = out[1]; rgb[i * 3 + 2] = out[2];
  }
  return encodePng(width, height, rgb, 'rgb');
}

function isIndexedColorSpace(ctx: RenderCtx, csObj: PdfObject | undefined): boolean {
  const r0 = ctx.doc.resolve(csObj);
  if (isArray(r0) && r0.length) {
    const h = ctx.doc.resolve(r0[0]);
    return isName(h) && (h.name === 'Indexed' || h.name === 'I');
  }
  return false;
}

/** 1-bit stencil mask → RGBA PNG painted in the fill color (opaque where bit=0). */
function maskHref(bits: Uint8Array, width: number, height: number, fill: Rgb): string {
  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const i = (y * width + x) * 4;
      // Per PDF: sample 0 paints, 1 masks out (default /Decode [0 1]).
      const paint = bit === 0;
      rgba[i] = fill[0]; rgba[i + 1] = fill[1]; rgba[i + 2] = fill[2];
      rgba[i + 3] = paint ? 255 : 0;
    }
  }
  return pngDataUri(encodePng(width, height, rgba, 'rgba'));
}

function drawInlineImage(ctx: RenderCtx, gs: GState, img: { dict: PdfDict; data: Uint8Array }): void {
  // Wrap the inline dict + data as a stream-like and reuse drawImage.
  drawImage(ctx, gs, { dict: img.dict, raw: img.data });
}
```

Remove the first draft `drawImage`/`samplesToPng`/`imageHref` that referenced `indexedMarker`/`isIndexed`; keep only the cleaned versions. Also delete the unused `import { encodePng } from ...` line accidentally added to the fixtures file.

Note on `ImageInfo` construction: its constructor is `new ImageInfo(doc, name, stream)` where `stream` is a `PdfStream` (`{ dict, raw }` plus a `.raw` getter). A content-stream inline image and an XObject both expose `{ dict, raw }`; cast via `as unknown as PdfStream` and verify `Decode()`/`Filter`/`Width` work in the test. If `ImageInfo` requires more of the `PdfStream` shape, add a thin local `imageFilterName(dict)` + direct `applyDecodeFilters` call instead — check `src/image.ts` and `src/filters.ts` before choosing.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS (JPEG + PNG image tests).

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret images — JPEG passthrough, PNG re-encode, masks"
```

---

### Task 8: Clipping — `W`/`W*` via `<clipPath>` and nested groups

**Files:**
- Modify: `src/svgrender.ts` (pending-clip state; open/close `<g clip-path>` on paint and q/Q)
- Modify: `test/helpers/build-svg-fixtures.ts`
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Produces: clip state on `GState` (`clipDepth: number`) plus a `pendingClip` flag on the loop. On `W`/`W*` the current path is remembered; when the next painting op runs, register a `<clipPath>` in defs and emit `<g clip-path="url(#id)">`, incrementing the active group count. `q` snapshots the group depth; `Q` closes any groups opened since the matching `q`.

- [ ] **Step 1: Add fixture + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
/** Clip to a rectangle, then fill a larger rect that should be clipped. */
export const CLIP_CONTENT = '20 20 60 60 re W n 1 0 0 rg 0 0 200 200 re f';
```

Append to `test/svgrender.test.ts`:

```typescript
import { CLIP_CONTENT } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — clipping', () => {
  it('registers a clipPath and wraps subsequent content in a clip group', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: CLIP_CONTENT }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<defs>.*<clipPath id="clip\d+">.*<\/clipPath>.*<\/defs>/s);
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)">/);
    // the group closes before </svg>
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t clipping`
Expected: FAIL — no `<clipPath>`/`<g>`.

- [ ] **Step 3: Add clip handling**

In `walk`, add a group-depth tracker and pending-clip state near the top:

```typescript
  let groupDepth = 0;                 // open <g> count
  const groupStack: number[] = [];    // groupDepth snapshot per q
  let pendingClip: { d: string; evenOdd: boolean } | undefined;
```

Change `q`/`Q`:

```typescript
      case 'q': stack.push(clone(gs)); groupStack.push(groupDepth); break;
      case 'Q': {
        gs = stack.pop() ?? gs;
        const target = groupStack.pop() ?? 0;
        while (groupDepth > target) { ctx.w.emit('</g>'); groupDepth--; }
        break;
      }
```

Add clip operators (they set the pending clip using the *current* path, which stays intact until the path-painting op):

```typescript
      case 'W': pendingClip = { d: d.trim(), evenOdd: false }; break;
      case 'W*': pendingClip = { d: d.trim(), evenOdd: true }; break;
```

At the very start of `paint(...)` and of `resetPath` usage for `n`, apply any pending clip before painting/clearing. Replace the `paint` body's start and the `case 'n'` with a shared clip-applier:

```typescript
  const applyPendingClip = () => {
    if (!pendingClip || !pendingClip.d) { pendingClip = undefined; return; }
    const id = ctx.w.nextId('clip');
    const rule = pendingClip.evenOdd ? ' clip-rule="evenodd"' : '';
    ctx.w.addDef(`<clipPath id="${id}"><path d="${pendingClip.d}" transform="${matrixAttr(gs.ctm)}"${rule}/></clipPath>`);
    ctx.w.emit(`<g clip-path="url(#${id})">`);
    groupDepth++;
    pendingClip = undefined;
  };
```

Call `applyPendingClip()` at the top of both `paint(...)` (before emitting the `<path>`) and the `case 'n':` handler:

```typescript
      case 'n': applyPendingClip(); resetPath(); break;
```

And in `paint`, first line: `applyPendingClip();` — note the clip path is captured from `d` *before* `resetPath()` clears it, so capture happens in `W`/`W*` (already done). After the loop ends, close any still-open groups:

```typescript
  // after the for-loop:
  while (groupDepth > 0) { ctx.w.emit('</g>'); groupDepth--; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret clipping — clipPath + nested clip groups"
```

---

### Task 9: Shadings — axial/radial gradients

**Files:**
- Modify: `src/svgrender.ts` (add `sh` op + shading-pattern fill; a `buildGradient` helper)
- Modify: `test/helpers/build-svg-fixtures.ts`
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `parseFunction` from `src/pdffunction.js`; `resolveColorSpace` from `src/colorspace.js`.
- Produces: `sh` handling — resolve the named shading from `/Shading` resources, build a `<linearGradient>` (type 2) or `<radialGradient>` (type 3) in defs with N sampled stops, and fill the current clip region (or full viewport) with a rect referencing it under the CTM. Unsupported types → mid-gray rect.

- [ ] **Step 1: Add fixture + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
/** A page with an axial (type 2) shading painted via the `sh` operator. */
export function axialShadingPdf(buildSvgPdf: (o: any) => Uint8Array): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function ${fn} /Extend [true true] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}
```

Append to `test/svgrender.test.ts`:

```typescript
import { axialShadingPdf } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — shadings', () => {
  it('emits a linearGradient for an axial shading', () => {
    const doc = Document.Open(axialShadingPdf(buildSvgPdf));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    expect(svg).toMatch(/<stop /);
    expect(svg).toMatch(/fill="url\(#grad\d+\)"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t shadings`
Expected: FAIL — no gradient.

- [ ] **Step 3: Add shading handling**

Add import:

```typescript
import { parseFunction } from './pdffunction.js';
```

Add to the `walk` switch:

```typescript
      case 'sh': {
        const shDict = resDict(ctx, 'Shading');
        const sn = o[0];
        if (isName(sn) && shDict) {
          const sh = ctx.doc.resolve(shDict.get(sn.name));
          const dict = isStream(sh) ? sh.dict : isDict(sh) ? sh : undefined;
          if (dict) paintShading(ctx, gs, dict);
        }
        break;
      }
```

Add helpers:

```typescript
function paintShading(ctx: RenderCtx, gs: GState, dict: PdfDict): void {
  const type = num(ctx.doc.resolve(dict.get('ShadingType')));
  const csObj = dict.get('ColorSpace');
  const cs = csObj !== undefined ? resolveColorSpace(csObj, r(ctx), inf(ctx)) : deviceGray();
  const coords = arrNums(ctx, dict.get('Coords'));
  const fnObj = dict.get('Function');
  const fn = fnObj !== undefined ? parseFunction(fnObj, r(ctx), inf(ctx)) : (x: number[]) => x;
  const stops = sampleStops(fn, cs, 8);

  if (type === 2 && coords.length >= 4) {
    const id = ctx.w.nextId('grad');
    ctx.w.addDef(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" `
      + `x1="${fmt(coords[0])}" y1="${fmt(coords[1])}" x2="${fmt(coords[2])}" y2="${fmt(coords[3])}">`
      + stops + `</linearGradient>`);
    fillViewportRect(ctx, gs, `url(#${id})`);
  } else if (type === 3 && coords.length >= 6) {
    const id = ctx.w.nextId('grad');
    ctx.w.addDef(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" `
      + `fx="${fmt(coords[0])}" fy="${fmt(coords[1])}" cx="${fmt(coords[3])}" cy="${fmt(coords[4])}" r="${fmt(coords[5])}">`
      + stops + `</radialGradient>`);
    fillViewportRect(ctx, gs, `url(#${id})`);
  } else {
    fillViewportRect(ctx, gs, '#808080'); // unsupported shading type → gray
  }
}

function sampleStops(fn: (x: number[]) => number[], cs: ColorConverter, n: number): string {
  let s = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rgb = cs.toRgb(fn([t]));
    s += `<stop offset="${fmt(t)}" stop-color="${rgbHex(rgb)}"/>`;
  }
  return s;
}

/** Fill a large rect under the CTM with the given paint (clipped by any active
 *  clip group). Covers the shading's target region for `sh`. */
function fillViewportRect(ctx: RenderCtx, gs: GState, paint: string): void {
  ctx.w.emit(`<rect x="-100000" y="-100000" width="200000" height="200000" transform="${matrixAttr(gs.ctm)}" fill="${paint}"/>`);
}

function arrNums(ctx: RenderCtx, o: PdfObject | undefined): number[] {
  const a = ctx.doc.resolve(o);
  return isArray(a) ? a.map((x) => ctx.doc.resolve(x)).filter((x): x is number => typeof x === 'number') : [];
}
```

Also wire shading-pattern fills: in `sc/scn`/`SC/SCN`, when the last operand is a name and the fill colorspace is `Pattern`, look up `/Pattern`, and if it is a shading pattern (`PatternType 2`) fill subsequent paths with the gradient. For v1 keep this minimal: detect a pattern-name operand and set `gs.fill` to a mid-gray so it never crashes; full pattern-fill fidelity is out of scope (documented). Update:

```typescript
      case 'scn': {
        if (isName(o[o.length - 1])) { gs.fill = [128, 128, 128]; break; } // pattern fallback
        gs.fill = gs.fillCs.toRgb(numbers(o)); break;
      }
      case 'SCN': {
        if (isName(o[o.length - 1])) { gs.stroke = [128, 128, 128]; break; }
        gs.stroke = gs.strokeCs.toRgb(numbers(o)); break;
      }
```

(Leave `sc`/`SC` as pure-numeric from Task 5.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/svgrender.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret shadings — axial/radial SVG gradients"
```

---

### Task 10: Form XObjects — recursion with `/Matrix`, `/BBox` clip, guards

**Files:**
- Modify: `src/svgrender.ts` (`drawForm` real body)
- Modify: `test/helpers/build-svg-fixtures.ts`
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Produces: `drawForm(ctx, gs, stream)` — inflate the form, recurse `walk` with `ctm' = mul(formMatrix, gs.ctm)`, a `<g>` clip to `/BBox`, the form's own `/Resources` (falling back to parent), and depth/cycle guards mirroring `text.ts` (`MAX_XOBJECT_DEPTH = 8`, `seen` set of dicts).

- [ ] **Step 1: Add fixture + failing test**

Append to `test/helpers/build-svg-fixtures.ts`:

```typescript
/** A page invoking a Form XObject that fills a green rect. */
export function formXObjectPdf(buildSvgPdf: (o: any) => Uint8Array, flate: (b: Uint8Array | string) => Uint8Array): Uint8Array {
  const formContent = flate('0 1 0 rg 0 0 50 50 re f');
  const form = { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [1 0 0 1 10 10] /Resources << >> /Filter /FlateDecode /Length ${formContent.length} >>`, raw: formContent };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: 'q /Fm0 Do Q',
    extra: { 5: form },
  });
}
```

Append to `test/svgrender.test.ts`:

```typescript
import { formXObjectPdf } from './helpers/build-svg-fixtures.js';

describe('Page.ToSvg — form xobjects', () => {
  it('recurses into a Form XObject and applies its Matrix', () => {
    const doc = Document.Open(formXObjectPdf(buildSvgPdf, flate));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<path[^>]*fill="#00ff00"/);      // the form's green rect
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)">/); // BBox clip group
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgrender.test.ts -t "form xobjects"`
Expected: FAIL — no green path.

- [ ] **Step 3: Implement `drawForm`**

Add a module constant and replace the placeholder `drawForm`:

```typescript
const MAX_XOBJECT_DEPTH = 8;

function drawForm(ctx: RenderCtx, gs: GState, stream: { dict: PdfDict; raw: Uint8Array }): void {
  if (ctx.depth >= MAX_XOBJECT_DEPTH || ctx.seen.has(stream.dict)) return;
  const bytes = inflateStream(stream as Parameters<typeof inflateStream>[0]);
  const mat = arrNums(ctx, stream.dict.get('Matrix'));
  const childCtm = mat.length === 6 ? mul(mat as Matrix, gs.ctm) : gs.ctm;

  // Clip to /BBox (a rectangle in form space, under childCtm).
  const bbox = arrNums(ctx, stream.dict.get('BBox'));
  let clipId: string | undefined;
  if (bbox.length === 4) {
    const [x0, y0, x1, y1] = bbox;
    clipId = ctx.w.nextId('clip');
    const d = `M${fmt(x0)} ${fmt(y0)}L${fmt(x1)} ${fmt(y0)}L${fmt(x1)} ${fmt(y1)}L${fmt(x0)} ${fmt(y1)}Z`;
    ctx.w.addDef(`<clipPath id="${clipId}"><path d="${d}" transform="${matrixAttr(childCtm)}"/></clipPath>`);
    ctx.w.emit(`<g clip-path="url(#${clipId})">`);
  }

  const childRes = ((): PdfDict | undefined => {
    const rr = ctx.doc.resolve(stream.dict.get('Resources'));
    return isDict(rr) ? rr : ctx.resources;
  })();

  ctx.seen.add(stream.dict);
  const childCtx: RenderCtx = { ...ctx, resources: childRes, depth: ctx.depth + 1 };
  const childState = clone(gs);
  childState.ctm = childCtm;
  walk(childCtx, bytes, childState);
  ctx.seen.delete(stream.dict);

  if (clipId) ctx.w.emit('</g>');
}
```

Note: `walk` currently takes `(ctx, bytes, initial)` and manages its own group stack, so the child's groups all close inside the recursive `walk` — the enclosing BBox `<g>` we open/close here is balanced separately. Verify `<g>` open/close counts stay balanced in the test (the existing `opens===closes` assertion in the clipping test guards this globally; add the same assertion here if useful).

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — all `svgrender` tests plus the whole existing suite green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts test/helpers/build-svg-fixtures.ts test/svgrender.test.ts
git commit -m "feat(3sh.1): interpret Form XObjects — Matrix, BBox clip, depth guard"
```

---

### Task 11: Documentation + issue close

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In `README.md`:
- Remove/soften the "no rendering" notes in **Limitations** (search for "render").
- Add to **Features** and **API overview**: `Page.ToSvg(options?)` — "Render a page to a standalone SVG string: paths (fill/stroke/dash), positioned `<text>`, images as data URIs (JPEG passthrough + PNG re-encode), clipping, and axial/radial gradients. Honors `/Rotate` and `CropBox`."
- Note current bounds: text is emitted as positioned `<text>` (glyph-outline mode is future work); tiling patterns, blend modes, and transparency groups are approximated; JBIG2/JPX images render as a gray placeholder.

Add a short usage snippet:

```typescript
import { Document } from 'aspose-pdf-foss-for-ts';
const doc = Document.OpenFile('in.pdf');
const svg = doc.Pages[0].ToSvg();          // standalone <svg> string
// fs.writeFileSync('page1.svg', svg);
```

- [ ] **Step 2: Verify build + full gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/` builds.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(3sh.1): document Page.ToSvg() rendering"
```

- [ ] **Step 4: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-3sh.1
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review Notes (author)

- **Spec coverage:** paths/fill-rule/stroke/dash/cap/join (T5); CTM/text/clip transforms (T4/T5/T6/T8); images from decoders (T7); text as `<text>` (T6); `/Rotate`+CropBox (T4); vitest fixtures (T4–T10); README (T11); full paint model incl. gradients (T3/T9); Separation/DeviceN + ICC + Indexed + Lab (T3); Form XObject recursion (T10). All acceptance bullets map to a task.
- **Known integration risks to verify during execution** (adjust code to the real APIs, do not invent):
  1. `ImageInfo` constructor/`PdfStream` shape — confirm `new ImageInfo(doc, '', stream)` works with a cast, else call `applyDecodeFilters` directly (Task 7 note).
  2. `name()` / `isString` / `isStream` / `isName` / `isArray` / `isDict` exports in `src/types.ts` — **confirmed present** (`src/types.ts:16-23`). `PdfStream = { kind: 'stream'; dict; raw }` — resolved XObjects are real streams `ImageInfo` accepts; only inline images need the `{ dict, raw }` cast.
  3. `TextFont` constructor signature `(dict, resolve, inflate)` matches `text.ts` usage — confirmed from `src/text.ts:298`.
  4. `Page.Contents` already inflates + joins content streams — confirmed from `src/page.ts:168`.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code (Task 7 explicitly instructs deleting the first-draft helpers in favor of the cleaned versions — implement only the cleaned ones).
- **Type consistency:** `GState.font?: TextFont` (added T6); `Rgb`/`ColorConverter` names consistent across T3/T5/T7/T9; `matrixAttr`/`fmt`/`escapeXml`/`SvgWriter` defined in T4 and reused throughout.
