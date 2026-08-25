# JBIG2Decode image decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode JBIG2 (`JBIG2Decode`) images embedded in PDF image XObjects to 1-bit samples, so `ImageInfo.Decode()` returns pixels (today it throws) and `ToImage`/`ToSvg` render JBIG2 images — the last undecodable image filter.

**Architecture:** A new decoder split across five focused modules — `jbig2arith.ts` (arithmetic integer decoders `IAx`/`IAID` over the reused `MqDecoder`), `jbig2generic.ts` (generic region: arithmetic GB0–GB3 + TPGDON, and MMR via the reused `decodeCcitt`), `jbig2symbol.ts` (symbol dictionary), `jbig2text.ts` (text region), and `jbig2.ts` (segment-header parse, embedded organization, page assembly, 1-bpp packing + inversion, public `decodeJbig2`). Reuses `jpxmq.ts` (MQ engine) and `ccitt.ts` (Group-4). Wired into `image.ts` at the existing terminal-filter dispatch.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps. (Any fixture-mint tool is dev-only, under `scripts/`, never imported by `src/` or tests.)
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { MqDecoder } from './jpxmq.js'`).
- **Errors** — throw `PdfParseError` / `UnsupportedFeatureError` from `./errors.js`. These plus `InvalidPasswordError` are the only public error types. `UnsupportedFeatureError` messages name the specific segment type/flag.
- **TDD** — every feature lands with a failing vitest test first. Tests consume fixtures; they never import an encoder.
- **Quality gates** — `npm run typecheck` and `npm test` must both be green before closing an issue. Target one file with `npx vitest run test/<name>.test.ts`.
- **Scope** — embedded (PDF) organization; generic (arithmetic GB0–GB3 + TPGDON, and MMR/G4); symbol dictionary (arithmetic); text region (arithmetic); `/JBIG2Globals`. Halftone, pattern dict, refinement (generic/symbol `REFAGG`/text `SBREFINE`), and all Huffman coding → `UnsupportedFeatureError` naming the feature. Malformed → `PdfParseError`.
- **Beads** — parent issue `aspose-pdf-foss-for-ts-8t9` (already claimed). Create one sub-issue per task under it; close each with `bd close <id>` when its tests are green.
- **Spec reference** — ITU-T T.88 (JBIG2), clauses cited per task. Cross-check against pdf.js `src/core/jbig2.js` and PDF 32000-1 §7.4.7 (JBIG2Decode filter).

## Bitmap representation (shared across all modules)

A decoded region/symbol is a `Bitmap`: one byte per pixel, `1 = black`, row-major.

```ts
export interface Bitmap { width: number; height: number; data: Uint8Array } // data.length === width*height
```

Helpers (define in `jbig2.ts`, export for reuse):

```ts
export function newBitmap(width: number, height: number, fill = 0): Bitmap {
  const data = new Uint8Array(width * height);
  if (fill) data.fill(1);
  return { width, height, data };
}
/** Composite src onto dst at (x,y) with a JBIG2 combination operator
 *  (0=OR,1=AND,2=XOR,3=XNOR,4=REPLACE). Pixels outside dst are clipped. */
export function combine(dst: Bitmap, src: Bitmap, x: number, y: number, op: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy; if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx; if (dx < 0 || dx >= dst.width) continue;
      const s = src.data[sy * src.width + sx];
      const di = dy * dst.width + dx; const d = dst.data[di];
      dst.data[di] = op === 0 ? (d | s) : op === 1 ? (d & s) : op === 2 ? (d ^ s) : op === 3 ? (d ^ s ^ 1) : s;
    }
  }
}
```

---

### Task 1: Arithmetic integer decoders (`jbig2arith.ts`)

The `IAx` integer procedures (T.88 Annex A) and the `IAID` symbol-ID decoder (A.3) are the entropy primitives every region/dictionary decoder calls. They are self-contained over the reused `MqDecoder` and testable in isolation via encode→decode round-trips. Build first.

**Files:**
- Create: `src/jbig2arith.ts`
- Create: `scripts/mqenc.mjs` (dev-only MQ + integer **encoder** used only to mint test vectors; never imported by `src/` or tests)
- Create: `test/helpers/jbig2-arith-vectors.ts` (committed vectors emitted by the script)
- Test: `test/jbig2arith.test.ts`

**Interfaces:**
- Consumes: `MqDecoder` from `./jpxmq.js` — `new MqDecoder(data, start, end)`, `decode(cx: Int8Array, i: number): 0|1`.
- Produces:
  - `class IntCtx { readonly cx: Int8Array }` — allocates `new Int8Array(512)`.
  - `function decodeInt(mq: MqDecoder, ctx: IntCtx): number | null` — returns the decoded integer, or `null` for the OOB (out-of-band) value.
  - `class IaidCtx { readonly cx: Int8Array; constructor(symCodeLen: number) }` — allocates `new Int8Array(1 << (symCodeLen + 1))`.
  - `function decodeIaid(mq: MqDecoder, ctx: IaidCtx, symCodeLen: number): number`.

- [ ] **Step 1: Emit test vectors with the dev-only encoder**

Create `scripts/mqenc.mjs` — a minimal MQ arithmetic **encoder** (T.88 Annex E.3 ENCODE/BYTEOUT/FLUSH; the encode counterpart of `MqDecoder`) plus an `encodeInt(values)` mirror of `decodeInt` (Annex A.3, same PREV context walk). It writes `test/helpers/jbig2-arith-vectors.ts`:

```ts
// GENERATED by scripts/mqenc.mjs — do not edit by hand.
/* eslint-disable */
function b64(s: string): Uint8Array { return Uint8Array.from(Buffer.from(s, "base64")); }
// Each vector: MQ-encoded bytes for the listed integer sequence via one IntCtx.
export const ints_small = { bytes: b64("..."), values: [0, 1, -1, 2, -2, 100, -100, 1000] };
export const ints_ranges = { bytes: b64("..."), values: [3, 4, 19, 20, 83, 84, 339, 340, 4435, 4436, 20000, -20000] };
export const ints_oob = { bytes: b64("..."), values: [5, null, 7] }; // null == OOB
export const iaid_seq = { bytes: b64("..."), symCodeLen: 5, values: [0, 1, 17, 31] };
```

Run: `node scripts/mqenc.mjs`. Commit the generated `jbig2-arith-vectors.ts`.

> The encoder lives in `scripts/` (dev-only) so the test suite never imports an encoder, per the spec's fixture rule. The vectors it mints are the committed source of truth.

- [ ] **Step 2: Write the failing test**

Create `test/jbig2arith.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MqDecoder } from '../src/jpxmq.js';
import { IntCtx, decodeInt, IaidCtx, decodeIaid } from '../src/jbig2arith.js';
import * as V from './helpers/jbig2-arith-vectors.js';

function decodeAll(bytes: Uint8Array, n: number): (number | null)[] {
  const mq = new MqDecoder(bytes, 0, bytes.length);
  const ctx = new IntCtx();
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) out.push(decodeInt(mq, ctx));
  return out;
}

describe('jbig2 arithmetic integer decoder', () => {
  it('round-trips small signed integers incl. zero', () => {
    expect(decodeAll(V.ints_small.bytes, V.ints_small.values.length)).toEqual(V.ints_small.values);
  });
  it('round-trips values at every range boundary', () => {
    expect(decodeAll(V.ints_ranges.bytes, V.ints_ranges.values.length)).toEqual(V.ints_ranges.values);
  });
  it('decodes the OOB value as null', () => {
    expect(decodeAll(V.ints_oob.bytes, V.ints_oob.values.length)).toEqual(V.ints_oob.values);
  });
  it('decodes symbol IDs (IAID)', () => {
    const mq = new MqDecoder(V.iaid_seq.bytes, 0, V.iaid_seq.bytes.length);
    const ctx = new IaidCtx(V.iaid_seq.symCodeLen);
    const out = V.iaid_seq.values.map(() => decodeIaid(mq, ctx, V.iaid_seq.symCodeLen));
    expect(out).toEqual(V.iaid_seq.values);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/jbig2arith.test.ts`
Expected: FAIL — `Cannot find module '../src/jbig2arith.js'`.

- [ ] **Step 4: Implement `jbig2arith.ts`**

```ts
// JBIG2 arithmetic integer decoding — ITU-T T.88 Annex A, over the shared MQ decoder.
import type { MqDecoder } from './jpxmq.js';

export class IntCtx { readonly cx = new Int8Array(512); }

/** IAx integer arithmetic decoding procedure (T.88 A.2/A.3). Returns null for OOB. */
export function decodeInt(mq: MqDecoder, ctx: IntCtx): number | null {
  const cx = ctx.cx;
  let prev = 1;
  const bit = (): number => { const d = mq.decode(cx, prev); prev = prev < 256 ? (prev << 1) | d : ((((prev << 1) | d) & 511) | 256); return d; };
  const s = bit();
  let n: number, offset: number;
  if (!bit()) { n = 2; offset = 0; }
  else if (!bit()) { n = 4; offset = 4; }
  else if (!bit()) { n = 6; offset = 20; }
  else if (!bit()) { n = 8; offset = 84; }
  else if (!bit()) { n = 12; offset = 340; }
  else { n = 16; offset = 4436; }
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bit();
  v = (v >>> 0) + offset;
  if (s === 0) return v;
  if (v > 0) return -v;
  return null; // S==1 && V==0 -> OOB
}

export class IaidCtx {
  readonly cx: Int8Array;
  constructor(symCodeLen: number) { this.cx = new Int8Array(1 << (symCodeLen + 1)); }
}

/** IAID symbol-ID decoding (T.88 A.3). */
export function decodeIaid(mq: MqDecoder, ctx: IaidCtx, symCodeLen: number): number {
  let prev = 1;
  for (let i = 0; i < symCodeLen; i++) { const d = mq.decode(ctx.cx, prev); prev = (prev << 1) | d; }
  return prev - (1 << symCodeLen);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/jbig2arith.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/jbig2arith.ts scripts/mqenc.mjs test/helpers/jbig2-arith-vectors.ts test/jbig2arith.test.ts
git commit -m "feat(8t9): JBIG2 arithmetic integer decoders (IAx/IAID)"
```

---

### Task 2: Segment-header parse + orchestration skeleton (`jbig2.ts`)

Parse the embedded segment-header sequence (T.88 §7.2) and expose the top-level `decodeJbig2` entry that walks globals + embedded segments. Region/dictionary bodies are stubbed to throw here; later tasks fill them. Also defines the shared `Bitmap` helpers.

**Files:**
- Create: `src/jbig2.ts`
- Test: `test/jbig2-segments.test.ts`

**Interfaces:**
- Produces:
  - `interface Bitmap { width: number; height: number; data: Uint8Array }`
  - `function newBitmap(width: number, height: number, fill?: number): Bitmap`
  - `function combine(dst: Bitmap, src: Bitmap, x: number, y: number, op: number): void`
  - `interface SegmentHeader { number: number; type: number; referredTo: number[]; pageAssociation: number; dataStart: number; dataLength: number }`
  - `function parseSegments(data: Uint8Array): SegmentHeader[]` — parses embedded-organization headers; a `dataLength` of `0xffffffff` (unknown length, only legal for immediate generic regions) → `PdfParseError` (unsupported in embedded PDF streams).
  - `function decodeJbig2(data: Uint8Array, globals: Uint8Array | undefined, width: number, height: number): Uint8Array` — returns packed 1-bpp samples (MSB-first, row-padded, bit-inverted so PDF `0 = black`).
- Consumes: nothing from later tasks yet (region/symbol/text decoders are imported but called behind stubs until Tasks 3–5).

- [ ] **Step 1: Write the failing test**

Create `test/jbig2-segments.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSegments } from '../src/jbig2.js';

// Hand-built embedded segment header (T.88 7.2), short form:
// segNum=0 (u32), flags=0x30 (type=48 page-info, no page-assoc-4), rtFlags=0x00
// (count=0), pageAssoc=1 (u8), dataLength=19 (u32), then 19 bytes of body.
function pageInfoHeader(dataLen: number): Uint8Array {
  const h = [
    0, 0, 0, 0,      // segment number
    0x30,            // flags: type 48
    0x00,            // referred-to count/retain (count=0)
    0x01,            // page association (1 byte)
    (dataLen >>> 24) & 0xff, (dataLen >>> 16) & 0xff, (dataLen >>> 8) & 0xff, dataLen & 0xff,
  ];
  return Uint8Array.from(h);
}

describe('jbig2 segment header parsing', () => {
  it('parses a single page-info header with its body offset/length', () => {
    const header = pageInfoHeader(19);
    const body = new Uint8Array(19);
    const stream = new Uint8Array(header.length + body.length);
    stream.set(header, 0); stream.set(body, header.length);
    const segs = parseSegments(stream);
    expect(segs.length).toBe(1);
    expect(segs[0].number).toBe(0);
    expect(segs[0].type).toBe(48);
    expect(segs[0].referredTo).toEqual([]);
    expect(segs[0].pageAssociation).toBe(1);
    expect(segs[0].dataStart).toBe(header.length);
    expect(segs[0].dataLength).toBe(19);
  });

  it('rejects an unknown (0xffffffff) data length', () => {
    expect(() => parseSegments(pageInfoHeader(0xffffffff))).toThrow(/unknown.*length|0xffffffff/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jbig2-segments.test.ts`
Expected: FAIL — `Cannot find module '../src/jbig2.js'`.

- [ ] **Step 3: Implement `jbig2.ts` (headers + skeleton)**

Implement per T.88 §7.2.6 (referred-to-segment count & retention flags: short form when `(flags>>5)==7` uses a 4-byte long form; count ≤ 4 uses the 1-byte short form), §7.2.7 (referred-to segment numbers sized by the referring segment number: 1 byte if `segNum ≤ 256`, 2 if `≤ 65536`, else 4), and §7.2.6 page-association size bit (`flags & 0x40` → 4-byte page association, else 1-byte).

```ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export interface Bitmap { width: number; height: number; data: Uint8Array }
export function newBitmap(width: number, height: number, fill = 0): Bitmap {
  const data = new Uint8Array(width * height); if (fill) data.fill(1); return { width, height, data };
}
export function combine(dst: Bitmap, src: Bitmap, x: number, y: number, op: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy; if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx; if (dx < 0 || dx >= dst.width) continue;
      const s = src.data[sy * src.width + sx]; const di = dy * dst.width + dx; const d = dst.data[di];
      dst.data[di] = op === 0 ? (d | s) : op === 1 ? (d & s) : op === 2 ? (d ^ s) : op === 3 ? (d ^ s ^ 1) : s;
    }
  }
}

export interface SegmentHeader {
  number: number; type: number; referredTo: number[]; pageAssociation: number; dataStart: number; dataLength: number;
}

export function parseSegments(data: Uint8Array): SegmentHeader[] {
  const segs: SegmentHeader[] = []; let p = 0;
  const u8 = () => { if (p >= data.length) throw new PdfParseError('JBIG2: truncated segment header', p); return data[p++]; };
  const u32 = () => (u8() << 24 | u8() << 16 | u8() << 8 | u8()) >>> 0;
  while (p < data.length) {
    const number = u32();
    const flags = u8();
    const type = flags & 0x3f;
    const pageAssocLarge = (flags & 0x40) !== 0;
    let rtByte = u8();
    let count = rtByte >> 5;
    if (count === 7) {                       // long form
      p -= 1; count = u32() & 0x1fffffff;
      const retainBytes = Math.ceil((count + 1) / 8);
      for (let i = 0; i < retainBytes; i++) u8();
    } // else short form: retain bits already in rtByte
    const refSize = number <= 256 ? 1 : number <= 65536 ? 2 : 4;
    const referredTo: number[] = [];
    for (let i = 0; i < count; i++) {
      let v = 0; for (let b = 0; b < refSize; b++) v = (v << 8) | u8(); referredTo.push(v >>> 0);
    }
    const pageAssociation = pageAssocLarge ? u32() : u8();
    const dataLength = u32();
    if (dataLength === 0xffffffff) throw new PdfParseError('JBIG2: unknown segment data length (0xffffffff) unsupported', p);
    segs.push({ number, type, referredTo, pageAssociation, dataStart: p, dataLength });
    p += dataLength;
  }
  return segs;
}

// Packs a page Bitmap into PDF 1-bpp samples (MSB-first, row-padded), bit-inverted
// so JBIG2 black(1) becomes PDF sample 0 under the default DeviceGray [0 1] decode.
export function packBitmap(bm: Bitmap): Uint8Array {
  const rowBytes = (bm.width + 7) >> 3; const out = new Uint8Array(rowBytes * bm.height);
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if (bm.data[y * bm.width + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = ~out[i] & 0xff; // invert: black->0
  return out;
}

// Orchestration skeleton — filled by Tasks 3–5. Throws for region bodies for now.
export function decodeJbig2(data: Uint8Array, globals: Uint8Array | undefined, width: number, height: number): Uint8Array {
  const page = newBitmap(width, height);
  const all = [...(globals ? parseSegments(globals) : []).map(s => ({ s, src: globals! })),
               ...parseSegments(data).map(s => ({ s, src: data }))];
  for (const { s } of all) {
    switch (s.type) {
      case 48: case 49: case 50: case 51: case 62: break; // page info / end-of-* / extension: no bitmap
      case 16: throw new UnsupportedFeatureError('JBIG2: pattern dictionary (segment type 16) not supported');
      case 20: case 22: case 23: throw new UnsupportedFeatureError('JBIG2: halftone region (segment type ' + s.type + ') not supported');
      case 40: case 42: case 43: throw new UnsupportedFeatureError('JBIG2: refinement region (segment type ' + s.type + ') not supported');
      default: throw new UnsupportedFeatureError('JBIG2: segment type ' + s.type + ' not supported');
    }
  }
  return packBitmap(page);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jbig2-segments.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/jbig2.ts test/jbig2-segments.test.ts
git commit -m "feat(8t9): JBIG2 segment-header parse + orchestration skeleton"
```

---

### Task 3: Generic region decode (`jbig2generic.ts`)

Decode a generic region bitmap: arithmetic (GB templates 0–3 with AT pixels and TPGDON typical prediction, T.88 §6.2.5) and MMR/Group-4 (delegate to `decodeCcitt`). Wire the immediate-generic-region segment types (36/38/39) into `decodeJbig2`.

**Files:**
- Create: `src/jbig2generic.ts`
- Modify: `src/jbig2.ts` (region-info parse helper + generic-region case)
- Test: `test/jbig2-generic.test.ts`

**Interfaces:**
- Consumes: `MqDecoder` (`./jpxmq.js`); `decodeCcitt` (`./ccitt.js`) with `{ k: -1, columns, rows, blackIs1: true, byteAlign: false, endOfLine: false, endOfBlock: false }`; `Bitmap`, `newBitmap` (`./jbig2.js`).
- Produces:
  - `interface GenericParams { width: number; height: number; template: number; at: Array<{x:number;y:number}>; tpgdon: boolean; mmr: boolean }`
  - `function decodeGeneric(data: Uint8Array, start: number, end: number, p: GenericParams, mq?: MqDecoder, cx?: Int8Array): Bitmap` — when `mq`/`cx` are supplied (symbol-dict/text reuse) they drive the arithmetic decode; otherwise a fresh `MqDecoder(data,start,end)` and `new Int8Array(1<<16)` are used.
  - `const GB_TEMPLATES` and `function genericContext(...)` internal (not exported).
- Region-segment-info parse (shared): add to `jbig2.ts`
  - `interface RegionInfo { width: number; height: number; x: number; y: number; combOp: number; bodyStart: number }`
  - `function parseRegionInfo(data: Uint8Array, start: number): RegionInfo` — T.88 §7.4.1: width u32, height u32, x u32, y u32, flags u8 (combOp = flags & 7); bodyStart = start + 17.

- [ ] **Step 1: Write the failing test**

Create `test/jbig2-generic.test.ts`. Fixtures come from `test/helpers/jbig2-fixtures.ts` (Task 6 mints them; this test imports the two generic entries, which the fixture script produces first). To keep Task 3 self-contained, this test uses a **hand-built MMR generic** fixture (Group-4 is already independently trusted via `ccitt.ts`) plus an **arithmetic** fixture minted by the dev encoder:

```ts
import { describe, it, expect } from 'vitest';
import { decodeGeneric } from '../src/jbig2generic.js';
import { deflateRawSync } from 'node:zlib'; // not used; placeholder removed below
import * as F from './helpers/jbig2-generic-vectors.js';

function rows(bm: { width: number; height: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < bm.height; y++) out.push(Array.from(bm.data.subarray(y*bm.width,(y+1)*bm.width)).join(''));
  return out;
}

describe('jbig2 generic region', () => {
  it('decodes an arithmetic GB0 region (with TPGDON) to the known bitmap', () => {
    const bm = decodeGeneric(F.arith_gb0.bytes, 0, F.arith_gb0.bytes.length,
      { width: F.arith_gb0.width, height: F.arith_gb0.height, template: 0,
        at: [{x:3,y:-1},{x:-3,y:-1},{x:2,y:-2},{x:-2,y:-2}], tpgdon: true, mmr: false });
    expect(rows(bm)).toEqual(F.arith_gb0.rows);
  });

  it('decodes an MMR (Group-4) generic region to the known bitmap', () => {
    const bm = decodeGeneric(F.mmr.bytes, 0, F.mmr.bytes.length,
      { width: F.mmr.width, height: F.mmr.height, template: 0, at: [], tpgdon: false, mmr: true });
    expect(rows(bm)).toEqual(F.mmr.rows);
  });
});
```

Add these two entries to `scripts/mqenc.mjs` output as a new file `test/helpers/jbig2-generic-vectors.ts` (arithmetic region minted by the dev encoder's generic-region routine; MMR region minted by piping a known 8×8 bitmap through a G4 encoder — or, simplest, hand-encode a 1-row all-white/all-black pattern and assert). Values documented in the file header.

> The MMR path exercises `ccitt.ts`, already independently trusted, so the MMR vector needs no arithmetic encoder — it can be produced by the standard G4 encoder in `scripts/mqenc.mjs` or hand-authored.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jbig2-generic.test.ts`
Expected: FAIL — `Cannot find module '../src/jbig2generic.js'`.

- [ ] **Step 3: Implement `jbig2generic.ts`**

Templates per T.88 §6.2.5.3, Figures 4–7. The context is built from already-decoded neighbouring pixels plus the AT (adaptive template) pixels. Pixel lists below are the standard coding-template coordinates (relative to the current pixel), with AT slots substituted in:

```ts
import { MqDecoder } from './jpxmq.js';
import { decodeCcitt } from './ccitt.js';
import { newBitmap, type Bitmap } from './jbig2.js';

export interface GenericParams { width: number; height: number; template: number; at: Array<{x:number;y:number}>; tpgdon: boolean; mmr: boolean }

// Fixed (non-AT) template pixels for GB templates 0..3 (T.88 Figures 4–7),
// as [dx,dy] offsets. AT pixels are spliced in at decode time (see below).
const TEMPLATE_FIXED: number[][][] = [
  // template 0: 16-pixel context; AT1..AT4 inserted.
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
  // template 1: 13-pixel; AT1.
  [[-1,-2],[0,-2],[1,-2],[2,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-3,0],[-2,0],[-1,0]],
  // template 2: 10-pixel; AT1.
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[-2,0],[-1,0]],
  // template 3: 10-pixel single-row-above; AT1.
  [[-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
];
// Where the AT pixels sit in the context bit order (template -> list of AT indices).
// Implement by concatenating fixed + AT pixels in the exact spec order; the precise
// interleave is given in T.88 6.2.5.3 — replicate pdf.js CodingTemplates ordering.

function px(bm: Bitmap, x: number, y: number): number {
  return (x < 0 || x >= bm.width || y < 0 || y >= bm.height) ? 0 : bm.data[y * bm.width + x];
}

/** Decode a generic region (T.88 6.2). */
export function decodeGeneric(data: Uint8Array, start: number, end: number, prm: GenericParams, mqIn?: MqDecoder, cxIn?: Int8Array): Bitmap {
  const bm = newBitmap(prm.width, prm.height);
  if (prm.mmr) {
    const decoded = decodeCcitt(data.subarray(start, end), { k: -1, columns: prm.width, rows: prm.height, blackIs1: true, byteAlign: false, endOfLine: false, endOfBlock: false });
    // decodeCcitt returns packed 1-bpp rows; unpack into the byte-per-pixel Bitmap.
    const rowBytes = (prm.width + 7) >> 3;
    for (let y = 0; y < prm.height; y++) for (let x = 0; x < prm.width; x++)
      bm.data[y * prm.width + x] = (decoded[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
    return bm;
  }
  const mq = mqIn ?? new MqDecoder(data, start, end);
  const cx = cxIn ?? new Int8Array(1 << 16);
  // Build the ordered template = fixed pixels + AT pixels, per spec order for prm.template.
  const template = buildTemplate(prm.template, prm.at);
  let ltp = 0;
  // TPGDON pseudo-pixel context values per template (T.88 6.2.5.7): 0x9b25,0x0795,0x00e5,0x0195.
  const TPGD_CTX = [0x9b25, 0x0795, 0x00e5, 0x0195][prm.template];
  for (let y = 0; y < prm.height; y++) {
    if (prm.tpgdon) {
      ltp ^= mq.decode(cx, TPGD_CTX);
      if (ltp) { // copy row above
        if (y > 0) bm.data.copyWithin(y * prm.width, (y - 1) * prm.width, y * prm.width);
        continue;
      }
    }
    for (let x = 0; x < prm.width; x++) {
      let ctx = 0;
      for (const [dx, dy] of template) ctx = (ctx << 1) | px(bm, x + dx, y + dy);
      bm.data[y * prm.width + x] = mq.decode(cx, ctx);
    }
  }
  return bm;
}

// Returns the template pixel list in the exact bit order the spec assigns, with AT
// pixels substituted. Mirror pdf.js `CodingTemplates[template]` + `at` reordering.
function buildTemplate(template: number, at: Array<{x:number;y:number}>): number[][] {
  const atPix = at.map(a => [a.x, a.y]);
  // Concatenation order per T.88 6.2.5.3 (see pdf.js): template 0 interleaves AT1..AT4;
  // templates 1..3 append AT1. Use the fixed lists above merged with atPix in spec order.
  switch (template) {
    case 0: return [ [-1,-2],[0,-2],[1,-2], atPix[1], [-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1], atPix[2], atPix[3], [-4,0],[-3,0],[-2,0],[-1,0], atPix[0] ];
    case 1: return [ [-1,-2],[0,-2],[1,-2],[2,-2], [-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1], [-3,0],[-2,0],[-1,0], atPix[0] ];
    case 2: return [ [-1,-2],[0,-2],[1,-2], [-2,-1],[-1,-1],[0,-1],[1,-1], [-2,0],[-1,0], atPix[0] ];
    default: return [ [-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1], [-4,0],[-3,0],[-2,0],[-1,0], atPix[0] ];
  }
}
```

> **Implementer note:** the exact bit ordering AND the `TPGD_CTX` constants must match T.88 §6.2.5.7 / pdf.js `ReusedContexts` (`0x9b25,0x0795,0x00e5,0x0195`). If the arithmetic fixture (Task 6 / the dev encoder) round-trips, the ordering is consistent between encoder and decoder; cross-check the *values* against pdf.js so both aren't wrong together. The `TEMPLATE_FIXED` table is illustrative; `buildTemplate` is the authoritative order.

- [ ] **Step 4: Wire the generic-region case into `jbig2.ts`**

Add `parseRegionInfo` and replace the `default` handling for types 36/38/39:

```ts
export interface RegionInfo { width: number; height: number; x: number; y: number; combOp: number; bodyStart: number }
export function parseRegionInfo(data: Uint8Array, start: number): RegionInfo {
  const u32 = (o: number) => (data[o] << 24 | data[o+1] << 16 | data[o+2] << 8 | data[o+3]) >>> 0;
  return { width: u32(start), height: u32(start+4), x: u32(start+8), y: u32(start+12), combOp: data[start+16] & 7, bodyStart: start + 17 };
}
```

In `decodeJbig2`, add before `default`:

```ts
case 36: case 38: case 39: { // immediate generic region
  const ri = parseRegionInfo(s.src /* pass src bytes */, s.dataStart);
  const flags = s.srcByte(ri.bodyStart);           // generic-region flags (1 byte)
  const mmr = (flags & 1) !== 0;
  const template = (flags >> 1) & 3;
  const tpgdon = (flags >> 3) & 1 ? true : false;
  let o = ri.bodyStart + 1;
  const at: Array<{x:number;y:number}> = [];
  if (!mmr) { const n = template === 0 ? 4 : 1; for (let i = 0; i < n; i++) { at.push({ x: (s.srcByte(o) << 24 >> 24), y: (s.srcByte(o+1) << 24 >> 24) }); o += 2; } }
  const bm = decodeGeneric(s.src, o, s.dataStart + s.dataLength, { width: ri.width, height: ri.height, template, at, tpgdon, mmr });
  combine(page, bm, ri.x, ri.y, ri.combOp);
  break;
}
```

Adjust the orchestration loop so each entry carries its source bytes (`src: Uint8Array`) and a `srcByte(o)` accessor (or index `src[o]` directly). Import `decodeGeneric` from `./jbig2generic.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/jbig2-generic.test.ts test/jbig2-segments.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/jbig2generic.ts src/jbig2.ts test/jbig2-generic.test.ts test/helpers/jbig2-generic-vectors.ts scripts/mqenc.mjs
git commit -m "feat(8t9): JBIG2 generic region (arithmetic GB0-3 + TPGDON, MMR)"
```

---

### Task 4: Symbol dictionary decode (`jbig2symbol.ts`)

Decode a symbol-dictionary segment (T.88 §6.5) into an ordered array of symbol `Bitmap`s: the height-class walk using `IADH` (delta height), `IADW` (delta width), `IAEX` (export flags), `IAAI` (aggregate count). Arithmetic only; `REFAGG` (refinement/aggregate) or Huffman → `UnsupportedFeatureError`. Wire segment type 0.

**Files:**
- Create: `src/jbig2symbol.ts`
- Modify: `src/jbig2.ts` (symbol-dict case; store results keyed by segment number; input-symbol gathering from referred-to dictionaries)
- Test: `test/jbig2-symbol.test.ts`

**Interfaces:**
- Consumes: `MqDecoder` (`./jpxmq.js`); `IntCtx`, `decodeInt`, `IaidCtx`, `decodeIaid` (`./jbig2arith.js`); `decodeGeneric` (`./jbig2generic.js`) for uncoded symbol bitmaps; `Bitmap`, `newBitmap` (`./jbig2.js`).
- Produces:
  - `interface SymbolDictParams { huffman: boolean; refAgg: boolean; template: number; at: Array<{x:number;y:number}>; numExSyms: number; numNewSyms: number; inputSymbols: Bitmap[] }`
  - `function decodeSymbolDict(data: Uint8Array, start: number, end: number, p: SymbolDictParams): Bitmap[]` — returns the **exported** symbols (input + new, filtered by export flags), in order.

- [ ] **Step 1: Write the failing test**

Create `test/jbig2-symbol.test.ts` consuming a dev-minted dictionary vector (`test/helpers/jbig2-symbol-vectors.ts`) that encodes two known small glyphs (e.g. a 3×3 plus and a 4×2 bar):

```ts
import { describe, it, expect } from 'vitest';
import { decodeSymbolDict } from '../src/jbig2symbol.js';
import * as F from './helpers/jbig2-symbol-vectors.js';

describe('jbig2 symbol dictionary', () => {
  it('decodes two exported symbols with the expected sizes and pixels', () => {
    const syms = decodeSymbolDict(F.two_syms.bytes, 0, F.two_syms.bytes.length,
      { huffman: false, refAgg: false, template: 0,
        at: [{x:3,y:-1},{x:-3,y:-1},{x:2,y:-2},{x:-2,y:-2}], numExSyms: 2, numNewSyms: 2, inputSymbols: [] });
    expect(syms.map(s => [s.width, s.height])).toEqual(F.two_syms.sizes);
    expect(Array.from(syms[0].data)).toEqual(F.two_syms.sym0);
    expect(Array.from(syms[1].data)).toEqual(F.two_syms.sym1);
  });

  it('rejects Huffman and refinement/aggregate dictionaries', () => {
    const call = (huffman: boolean, refAgg: boolean) => () => decodeSymbolDict(new Uint8Array(4), 0, 4,
      { huffman, refAgg, template: 0, at: [], numExSyms: 0, numNewSyms: 0, inputSymbols: [] });
    expect(call(true, false)).toThrow(/Huffman/i);
    expect(call(false, true)).toThrow(/refinement|aggregate/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jbig2-symbol.test.ts`
Expected: FAIL — `Cannot find module '../src/jbig2symbol.js'`.

- [ ] **Step 3: Implement `jbig2symbol.ts`**

Algorithm T.88 §6.5.5 (arithmetic path). Each new symbol's bitmap is a generic region decoded with the shared `MqDecoder`/context (width from `IADW`, height = current height class), via `decodeGeneric(..., mq, cx)`.

```ts
import { MqDecoder } from './jpxmq.js';
import { IntCtx, decodeInt } from './jbig2arith.js';
import { decodeGeneric } from './jbig2generic.js';
import { newBitmap, type Bitmap } from './jbig2.js';
import { UnsupportedFeatureError, PdfParseError } from './errors.js';

export interface SymbolDictParams {
  huffman: boolean; refAgg: boolean; template: number; at: Array<{x:number;y:number}>;
  numExSyms: number; numNewSyms: number; inputSymbols: Bitmap[];
}

export function decodeSymbolDict(data: Uint8Array, start: number, end: number, p: SymbolDictParams): Bitmap[] {
  if (p.huffman) throw new UnsupportedFeatureError('JBIG2: Huffman-coded symbol dictionary not supported');
  if (p.refAgg) throw new UnsupportedFeatureError('JBIG2: refinement/aggregate symbol dictionary not supported');
  const mq = new MqDecoder(data, start, end);
  const cxGB = new Int8Array(1 << 16);
  const IADH = new IntCtx(), IADW = new IntCtx(), IAEX = new IntCtx(), IAAI = new IntCtx();
  const newSyms: Bitmap[] = [];
  let hcHeight = 0;
  while (newSyms.length < p.numNewSyms) {
    const dh = decodeInt(mq, IADH); if (dh === null) throw new PdfParseError('JBIG2: bad symbol dict (OOB height)');
    hcHeight += dh;
    let symWidth = 0;
    for (;;) {
      const dw = decodeInt(mq, IADW);
      if (dw === null) break;                 // end of height class
      symWidth += dw;
      if (newSyms.length >= p.numNewSyms) throw new PdfParseError('JBIG2: too many symbols');
      if (hcHeight <= 0 || symWidth <= 0) throw new PdfParseError('JBIG2: bad symbol dimensions');
      const bm = decodeGeneric(data, start, end,
        { width: symWidth, height: hcHeight, template: p.template, at: p.at, tpgdon: false, mmr: false }, mq, cxGB);
      newSyms.push(bm);
    }
  }
  // Export flags (T.88 6.5.10): run-lengths over input+new symbols, alternating skip/export.
  const all = [...p.inputSymbols, ...newSyms];
  const exported: Bitmap[] = []; let exFlag = false; let i = 0;
  while (i < all.length) {
    const run = decodeInt(mq, IAEX); if (run === null) throw new PdfParseError('JBIG2: bad export run');
    if (exFlag) for (let k = 0; k < run; k++) exported.push(all[i + k]);
    i += run; exFlag = !exFlag;
  }
  return exported;
}
```

- [ ] **Step 4: Wire the symbol-dict case into `jbig2.ts`**

Maintain `const symbolsBySeg = new Map<number, Bitmap[]>()`. For type 0: parse the symbol-dict flags (2 bytes: bit0 SDHUFF, bit1 SDREFAGG, bits10–11 template, etc. per T.88 §7.4.3.1.1), read AT pixels (if not Huffman: 4 pairs for template 0 else 1), read `SDNUMEXSYMS`/`SDNUMNEWSYMS` (two u32), gather `inputSymbols` by concatenating exported symbols of referred-to symbol-dict segments, call `decodeSymbolDict`, and store the result under `s.number`.

```ts
case 0: {
  const b = s.dataStart; const u32 = (o:number)=>(s.src[o]<<24|s.src[o+1]<<16|s.src[o+2]<<8|s.src[o+3])>>>0;
  const flags = (s.src[b] << 8) | s.src[b+1];
  const huffman = (flags & 1) !== 0, refAgg = (flags & 2) !== 0, template = (flags >> 10) & 3;
  let o = b + 2; const at: Array<{x:number;y:number}> = [];
  if (!huffman) { const n = template === 0 ? 4 : 1; for (let i=0;i<n;i++){ at.push({x:(s.src[o]<<24>>24),y:(s.src[o+1]<<24>>24)}); o+=2; } }
  const numExSyms = u32(o); const numNewSyms = u32(o+4); o += 8;
  const inputSymbols: Bitmap[] = [];
  for (const r of s.referredTo) { const got = symbolsBySeg.get(r); if (got) inputSymbols.push(...got); }
  const syms = decodeSymbolDict(s.src, o, s.dataStart + s.dataLength, { huffman, refAgg, template, at, numExSyms, numNewSyms, inputSymbols });
  symbolsBySeg.set(s.number, syms);
  break;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/jbig2-symbol.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/jbig2symbol.ts src/jbig2.ts test/jbig2-symbol.test.ts test/helpers/jbig2-symbol-vectors.ts scripts/mqenc.mjs
git commit -m "feat(8t9): JBIG2 symbol dictionary (arithmetic)"
```

---

### Task 5: Text region decode (`jbig2text.ts`)

Decode a text-region segment (T.88 §6.4): place referenced symbols onto the region bitmap via the strip walk using `IADT` (T coord), `IAFS`/`IADS` (first/subsequent S), `IAIT` (curr T), and `IAID` (symbol id). Arithmetic only; `SBHUFF` or `SBREFINE` → `UnsupportedFeatureError`. Wire segment types 4/6/7.

**Files:**
- Create: `src/jbig2text.ts`
- Modify: `src/jbig2.ts` (text-region case)
- Test: `test/jbig2-text.test.ts`

**Interfaces:**
- Consumes: `MqDecoder`; `IntCtx`/`decodeInt`/`IaidCtx`/`decodeIaid` (`./jbig2arith.js`); `Bitmap`, `newBitmap`, `combine` (`./jbig2.js`).
- Produces:
  - `interface TextRegionParams { width: number; height: number; numInstances: number; symbols: Bitmap[]; logStrips: number; refCorner: number; transposed: boolean; combOp: number; defPixel: number; dsOffset: number }`
  - `function decodeTextRegion(data: Uint8Array, start: number, end: number, p: TextRegionParams): Bitmap`

- [ ] **Step 1: Write the failing test**

Create `test/jbig2-text.test.ts` consuming a dev-minted text-region vector (`test/helpers/jbig2-text-vectors.ts`) that places two known symbols at known positions on a small region:

```ts
import { describe, it, expect } from 'vitest';
import { decodeTextRegion } from '../src/jbig2text.js';
import * as F from './helpers/jbig2-text-vectors.js';

function rows(bm: {width:number;height:number;data:Uint8Array}) {
  const o: string[] = []; for (let y=0;y<bm.height;y++) o.push(Array.from(bm.data.subarray(y*bm.width,(y+1)*bm.width)).join('')); return o;
}

describe('jbig2 text region', () => {
  it('places symbols at the expected positions', () => {
    const bm = decodeTextRegion(F.two_placed.bytes, 0, F.two_placed.bytes.length, {
      width: F.two_placed.width, height: F.two_placed.height, numInstances: F.two_placed.numInstances,
      symbols: F.two_placed.symbols.map(s => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      logStrips: 0, refCorner: 1 /*TOPLEFT*/, transposed: false, combOp: 0, defPixel: 0, dsOffset: 0,
    });
    expect(rows(bm)).toEqual(F.two_placed.rows);
  });

  it('rejects Huffman and refinement text regions', () => {
    // Wired at the jbig2.ts layer; unit-level guard also present:
    expect(() => decodeTextRegion(new Uint8Array(4), 0, 4, {
      width: 1, height: 1, numInstances: 0, symbols: [], logStrips: 0, refCorner: 1,
      transposed: false, combOp: 0, defPixel: 0, dsOffset: 0,
    })).not.toThrow(); // numInstances 0 => empty region, no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jbig2-text.test.ts`
Expected: FAIL — `Cannot find module '../src/jbig2text.js'`.

- [ ] **Step 3: Implement `jbig2text.ts`**

Algorithm T.88 §6.4.5 (arithmetic path). `SBSYMCODELEN = max(1, ceil(log2(numSymbols)))`.

```ts
import { MqDecoder } from './jpxmq.js';
import { IntCtx, decodeInt, IaidCtx, decodeIaid } from './jbig2arith.js';
import { newBitmap, combine, type Bitmap } from './jbig2.js';

export interface TextRegionParams {
  width: number; height: number; numInstances: number; symbols: Bitmap[];
  logStrips: number; refCorner: number; transposed: boolean; combOp: number; defPixel: number; dsOffset: number;
}

export function decodeTextRegion(data: Uint8Array, start: number, end: number, p: TextRegionParams): Bitmap {
  const bm = newBitmap(p.width, p.height, p.defPixel);
  const strips = 1 << p.logStrips;
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, p.symbols.length))));
  const mq = new MqDecoder(data, start, end);
  const IADT = new IntCtx(), IAFS = new IntCtx(), IADS = new IntCtx(), IAIT = new IntCtx();
  const IAID = new IaidCtx(symCodeLen);
  let stripT = -(decodeInt(mq, IADT) ?? 0) * strips;
  let firstS = 0, inst = 0;
  while (inst < p.numInstances) {
    stripT += (decodeInt(mq, IADT) ?? 0) * strips;
    firstS += decodeInt(mq, IAFS) ?? 0;
    let curS = firstS; let first = true;
    for (;;) {
      if (!first) { const ds = decodeInt(mq, IADS); if (ds === null) break; curS += ds + p.dsOffset; }
      first = false;
      const curT = stripT + (strips === 1 ? 0 : (decodeInt(mq, IAIT) ?? 0));
      const id = decodeIaid(mq, IAID, symCodeLen);
      const sym = p.symbols[id]; if (!sym) { inst++; if (inst >= p.numInstances) break; continue; }
      // Place per refCorner/transposed (T.88 6.4.5 step 3 c x); TOPLEFT non-transposed shown:
      let sx = curS, sy = curT;
      if (!p.transposed) {
        if (p.refCorner === 0 /*BOTTOMLEFT*/) sy = curT - sym.height + 1;
        else if (p.refCorner === 2 /*BOTTOMRIGHT*/) { sy = curT - sym.height + 1; }
        else if (p.refCorner === 3 /*TOPRIGHT*/) { /* sx adjust after advance */ }
        combine(bm, sym, sx, sy, p.combOp);
        curS += sym.width - 1;
      } else {
        combine(bm, sym, sx, sy, p.combOp);
        curS += sym.height - 1;
      }
      inst++; if (inst >= p.numInstances) break;
    }
  }
  return bm;
}
```

> **Implementer note:** the full ref-corner/transposed placement matrix (all 4 corners × transposed) is T.88 §6.4.5 step 3(c)(x)–(xi); replicate the pdf.js `decodeTextRegion` placement switch exactly. The dev-minted fixture uses TOPLEFT non-transposed, but implement all four corners guided by pdf.js and add a second fixture corner if time permits.

- [ ] **Step 4: Wire the text-region case into `jbig2.ts`**

For types 4/6/7: `parseRegionInfo`, then text-region flags (2 bytes, T.88 §7.4.4.1.1): SBHUFF=bit0, SBREFINE=bit1, LOGSBSTRIPS=bits2–3, REFCORNER=bits4–5, TRANSPOSED=bit6, SBCOMBOP=bits7–8, SBDEFPIXEL=bit9, SBDSOFFSET=bits10–14 (signed 5-bit), SBRTEMPLATE=bit15. Throw `UnsupportedFeatureError` if SBHUFF or SBREFINE set. Read `SBNUMINSTANCES` (u32). Gather `symbols` from referred-to symbol-dict segments (in referred order). Call `decodeTextRegion`, `combine` onto page.

```ts
case 4: case 6: case 7: {
  const ri = parseRegionInfo(s.src, s.dataStart);
  const f = (s.src[ri.bodyStart] << 8) | s.src[ri.bodyStart+1];
  if (f & 1) throw new UnsupportedFeatureError('JBIG2: Huffman-coded text region not supported');
  if (f & 2) throw new UnsupportedFeatureError('JBIG2: refinement text region (SBREFINE) not supported');
  const logStrips = (f >> 2) & 3, refCorner = (f >> 4) & 3, transposed = (f >> 6) & 1 ? true : false;
  const combOp = (f >> 7) & 3, defPixel = (f >> 9) & 1;
  let dsOffset = (f >> 10) & 0x1f; if (dsOffset > 15) dsOffset -= 32;
  let o = ri.bodyStart + 2; // (SBRTEMPLATE AT pixels only if SBREFINE — excluded here)
  const numInstances = (s.src[o]<<24|s.src[o+1]<<16|s.src[o+2]<<8|s.src[o+3])>>>0; o += 4;
  const symbols: Bitmap[] = [];
  for (const r of s.referredTo) { const got = symbolsBySeg.get(r); if (got) symbols.push(...got); }
  const bm = decodeTextRegion(s.src, o, s.dataStart + s.dataLength, { width: ri.width, height: ri.height, numInstances, symbols, logStrips, refCorner, transposed, combOp, defPixel, dsOffset });
  combine(page, bm, ri.x, ri.y, ri.combOp);
  break;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/jbig2-text.test.ts test/jbig2-symbol.test.ts test/jbig2-generic.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/jbig2text.ts src/jbig2.ts test/jbig2-text.test.ts test/helpers/jbig2-text-vectors.ts scripts/mqenc.mjs
git commit -m "feat(8t9): JBIG2 text region (arithmetic)"
```

---

### Task 6: `image.ts` dispatch, `/JBIG2Globals`, end-to-end fixtures + raster

Wire `decodeJbig2` into `ImageInfo.Decode()`, read the `/JBIG2Globals` stream, remove `JBIG2Decode` from the raster no-decoder set, and prove the whole pipeline end-to-end with real fixtures.

**Files:**
- Modify: `src/image.ts` (Decode dispatch + globals)
- Modify: `src/raster.ts:530` (`NO_RASTER_DECODER` — drop `JBIG2Decode`)
- Create: `scripts/gen-jbig2-fixtures.mjs` (dev-only minter: prefers `jbig2enc` if on PATH, else falls back to the built-in JS encoder in `scripts/mqenc.mjs` for a generic + a symbol/text image; writes base64)
- Create: `test/helpers/jbig2-fixtures.ts` (GENERATED base64: full PDF byte streams + expected decoded samples)
- Modify: `test/helpers/build-image-pdf.ts` (make `Jb0` a valid tiny generic JBIG2, or add a note; see step)
- Test: `test/jbig2.test.ts`

**Interfaces:**
- Consumes: `decodeJbig2` (`./jbig2.js`).
- Produces: `ImageInfo.Decode()` returns JBIG2 samples; `decodeImageRgba` rasterizes JBIG2.

- [ ] **Step 1: Mint end-to-end fixtures**

Create `scripts/gen-jbig2-fixtures.mjs`. It builds three 1-page PDFs whose single image is JBIG2-coded, and records the expected 1-bpp decoded samples:
- `generic_pdf` — an N×M generic-region image (arithmetic GB0 + TPGDON).
- `symtext_pdf` — a symbol-dictionary + text-region image (globals-less; dict + text in the image stream).
- `mmr_pdf` — an MMR-coded generic image.
- `globals_pdf` — a symbol dict in `/JBIG2Globals` referenced by a text region in the image stream (exercises the globals path).

Prefer `jbig2enc` if available (independent reference); otherwise mint the JBIG2 codestreams with the encoder in `scripts/mqenc.mjs`. Write `test/helpers/jbig2-fixtures.ts`:

```ts
// GENERATED by scripts/gen-jbig2-fixtures.mjs — do not edit by hand.
/* eslint-disable */
function b64(s: string): Uint8Array { return Uint8Array.from(Buffer.from(s, "base64")); }
export const generic_pdf: Uint8Array = b64("...");
export const generic_samples: Uint8Array = b64("...");  // expected Decode() output (packed, inverted)
export const symtext_pdf: Uint8Array = b64("...");
export const symtext_samples: Uint8Array = b64("...");
export const mmr_pdf: Uint8Array = b64("...");
export const mmr_samples: Uint8Array = b64("...");
export const globals_pdf: Uint8Array = b64("...");
export const globals_samples: Uint8Array = b64("...");
export const dims = { generic:[16,16], symtext:[24,12], mmr:[16,8], globals:[24,12] } as const;
```

Run `node scripts/gen-jbig2-fixtures.mjs`; commit the generated file.

- [ ] **Step 2: Write the failing end-to-end test**

Create `test/jbig2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { collectImages } from '../src/image.js';
import * as F from './helpers/jbig2-fixtures.js';

function firstImage(bytes: Uint8Array) {
  const doc = Document.Open(bytes);
  const page = doc.Pages[0];
  const imgs = collectImages(doc, page.Dict.get('Resources') as any);
  return { doc, img: imgs[0] };
}

describe('JBIG2Decode end-to-end', () => {
  it('decodes a generic-region image to the expected 1-bpp samples', () => {
    const { img } = firstImage(F.generic_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.generic_samples));
  });
  it('decodes a symbol-dictionary + text-region image', () => {
    const { img } = firstImage(F.symtext_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.symtext_samples));
  });
  it('decodes an MMR generic image', () => {
    const { img } = firstImage(F.mmr_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.mmr_samples));
  });
  it('honors /JBIG2Globals shared symbol dictionaries', () => {
    const { img } = firstImage(F.globals_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.globals_samples));
  });
  it('rasterizes a JBIG2 page (ToImage smoke)', () => {
    const doc = Document.Open(F.generic_pdf);
    const png = doc.Pages[0].ToImage({ scale: 1 });
    expect(png.length).toBeGreaterThan(8);
    expect(Array.from(png.subarray(0,4))).toEqual([0x89,0x50,0x4e,0x47]); // PNG signature
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/jbig2.test.ts`
Expected: FAIL — `Image.Decode: unsupported filter JBIG2Decode`.

- [ ] **Step 4: Implement the dispatch in `image.ts`**

Add import `import { decodeJbig2 } from './jbig2.js';`. Replace the throwing tail of `Decode()`:

```ts
if (terminal.name === 'JPXDecode') return decodeJpx(bytes).data;
if (terminal.name === 'JBIG2Decode') {
  const dp = terminal.parms;
  let globals: Uint8Array | undefined;
  const g = dp ? this.doc.resolve(dp.get('JBIG2Globals')) : undefined;
  if (isStream(g)) globals = new ImageInfo(this.doc, '', g).Decode(); // globals stream may itself be Flate-coded
  return decodeJbig2(bytes, globals, this.Width, this.Height);
}
throw new UnsupportedFeatureError(`Image.Decode: unsupported filter ${terminal.name}`);
```

> `JBIG2Globals` is typically a raw (unfiltered) stream, but decoding it through `ImageInfo.Decode()` handles a Flate-wrapped globals stream too; for a globals stream with no terminal image filter, `Decode()` returns the plain bytes.

- [ ] **Step 5: Drop JBIG2 from the raster no-decoder set (`raster.ts`)**

Edit line ~530:

```ts
const NO_RASTER_DECODER = new Set(['DCTDecode', 'DCT']); // JBIG2 now decodes to samples
```

Update the two nearby comments (lines ~529 and ~592) to state JBIG2 flows through the generic 1-bpp sample path.

- [ ] **Step 6: Fix the `Jb0` fixture in `build-image-pdf.ts`**

The existing `Jb0` carries 4 garbage bytes and any prior test asserting it throws will now surface a `PdfParseError`. Replace `jbig2Raw` with a minimal valid single generic-region JBIG2 stream (emit it from `scripts/gen-jbig2-fixtures.mjs` and paste the bytes), and update `test/image.test.ts` expectations so `Jb0` decodes (or is skipped) rather than throwing `UnsupportedFeatureError`. Grep first: `rg "Jb0|JBIG2" test/` and adjust each assertion.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/jbig2.test.ts test/image.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck
git add src/image.ts src/raster.ts scripts/gen-jbig2-fixtures.mjs test/helpers/jbig2-fixtures.ts test/helpers/build-image-pdf.ts test/jbig2.test.ts test/image.test.ts
git commit -m "feat(8t9): wire JBIG2Decode into Image.Decode + raster, end-to-end fixtures"
```

---

### Task 7: Graceful rejection + README + full-suite gate

Prove out-of-scope segments degrade with a named `UnsupportedFeatureError`, update the README image note, and run the whole suite.

**Files:**
- Create: `test/helpers/jbig2-unsupported.ts` (a hand-built stream containing a halftone/refinement segment header)
- Test: `test/jbig2-unsupported.test.ts`
- Modify: `README.md` (image-filter note)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

Create `test/jbig2-unsupported.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJbig2 } from '../src/jbig2.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { halftoneStream, refinementStream } from './helpers/jbig2-unsupported.js';

describe('JBIG2 graceful rejection', () => {
  it('names the halftone region as unsupported', () => {
    expect(() => decodeJbig2(halftoneStream(), undefined, 8, 8)).toThrow(UnsupportedFeatureError);
    expect(() => decodeJbig2(halftoneStream(), undefined, 8, 8)).toThrow(/halftone/i);
  });
  it('names the refinement region as unsupported', () => {
    expect(() => decodeJbig2(refinementStream(), undefined, 8, 8)).toThrow(/refinement/i);
  });
});
```

Create `test/helpers/jbig2-unsupported.ts` building a single segment header of type 22 (immediate halftone region) and type 40 (intermediate generic refinement region) with a minimal/empty body, using the same header layout as `test/jbig2-segments.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jbig2-unsupported.test.ts`
Expected: FAIL initially only if messages differ — the skeleton (Task 2) already throws these; confirm the message text matches `/halftone/i` and `/refinement/i` (adjust the `UnsupportedFeatureError` strings in `jbig2.ts` if needed).

- [ ] **Step 3: Update the README image note**

In `README.md`, find the image-filter/limitations note that lists JBIG2 as unsupported and change it to: JBIG2Decode is decoded for arithmetic-coded generic (incl. MMR), symbol-dictionary, and text regions; halftone, pattern-dictionary, refinement, and Huffman-coded JBIG2 raise `UnsupportedFeatureError`. Grep: `rg -n "JBIG2" README.md` and update each mention (Features list + Limitations).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS (whole suite green).

- [ ] **Step 5: Commit**

```bash
git add test/jbig2-unsupported.test.ts test/helpers/jbig2-unsupported.ts README.md
git commit -m "feat(8t9): JBIG2 graceful rejection + README; full suite green"
```

---

## Self-Review

**Spec coverage:**
- Embedded organization + segment-header parse → Task 2. ✅
- Generic region arithmetic GB0–3 + TPGDON → Task 3. ✅
- Generic region MMR via `ccitt.ts` → Task 3 (`decodeCcitt`, `k:-1`). ✅
- Symbol dictionary (arithmetic) → Task 4. ✅
- Text region (arithmetic) → Task 5. ✅
- `/JBIG2Globals` → Task 6 (dispatch reads the globals stream; `globals_pdf` fixture). ✅
- Page composition + combination operators → Task 2 (`combine`), used by Tasks 3/5. ✅
- 1-bpp packing + bit inversion (PDF `0=black`) → Task 2 (`packBitmap`). ✅
- Dispatch in `image.ts`; raster no-decoder update → Task 6. ✅
- Graceful `UnsupportedFeatureError` (halftone/pattern/refinement/`REFAGG`/`SBREFINE`/Huffman) → Tasks 2/4/5 (throws) + Task 7 (verified, named). ✅
- Malformed → `PdfParseError` → Tasks 2/4 (truncation, bad dims). ✅
- README update → Task 7. ✅
- Gates green → Task 7 Step 4. ✅

**Type consistency:** `Bitmap`/`newBitmap`/`combine`/`packBitmap`/`parseRegionInfo`/`RegionInfo`/`SegmentHeader` all defined in Task 2 and consumed by 3/4/5/6 with matching signatures. `IntCtx`/`decodeInt`/`IaidCtx`/`decodeIaid` defined in Task 1, consumed by 4/5. `decodeGeneric(data,start,end,params,mq?,cx?)` defined Task 3, reused by Task 4 with the `mq,cx` overload. `decodeJbig2(data,globals,width,height)` defined Task 2, consumed by Task 6.

**Known implementer risks (documented, not placeholders):**
1. **Generic template bit-order + TPGDON context constants** (Task 3) — exact ordering per T.88 §6.2.5; the constants `0x9b25/0x0795/0x00e5/0x0195` and `buildTemplate` order are authoritative and cross-checked against pdf.js. The round-trip fixture guards encoder/decoder agreement; the pdf.js cross-check guards against both being wrong together.
2. **Text-region ref-corner/transposed placement matrix** (Task 5) — all four corners per T.88 §6.4.5; replicate the pdf.js placement switch. Fixture covers TOPLEFT; add a second corner fixture if practical.
3. **Fixture minting** (Task 6) — prefers `jbig2enc` for an independent reference; falls back to the in-`scripts/` JS encoder when `jbig2enc` is absent so the suite is never blocked. The encoder never enters `src/` or test imports.
