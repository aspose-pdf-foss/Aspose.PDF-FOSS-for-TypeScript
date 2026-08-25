# Coefficient-domain JPEG greying Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grey a YCbCr JPEG by keeping component 0's quantized coefficients and its quantization table verbatim and dropping the chroma, so `ConvertToGrayscale` produces an exact, smaller, `lossy: false` result instead of decoding to RGB and re-encoding.

**Architecture:** `jpeg.ts` already decodes into quantized coefficient blocks, and `jpegencode.ts` already owns the entropy coder and marker assembly — but the former throws its `Frame` away and the latter's back half is trapped in closures. Extract both, then put a thin pure module between them.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies beyond `node:` built-ins.

**Spec:** `docs/superpowers/specs/2026-08-24-coefficient-domain-jpeg-greying-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `mozjpeg` in Task 6 is installed one-off, used, and removed — never a dev dependency.
- **ESM + NodeNext.** Every import specifier carries `.js` (`import { ZIGZAG } from './jpeg.js'`).
- **`jpegcoef.ts` and `jpegtranscode.ts` are pure.** No `Document`, no PDF object modules, no `types.js`. Raw bytes and plain numbers in and out.
- **Ordering, stated once and never re-derived:** coefficient blocks cross the `jpegcoef.ts` boundary in **zig-zag** order; quantization tables cross it in **natural** order. `parseDQT` stores **wire** (zig-zag) order; `scaleQuantTable` produces **natural**.
- **Errors:** `PdfParseError` / `UnsupportedFeatureError` from `errors.js`. `greyJpegFromCoefficients` throws neither — it declines.
- **Always run `npm run typecheck` and `npm test` before closing.** Both must be green.
- **CHANGELOG.md** under `## [Unreleased]` in the same commit as any user-visible change.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/jpegcoef.ts` (new) | The encoder's back half: zig-zag quantized blocks + natural quant tables + geometry → JPEG bytes. Entropy coding, Huffman table selection, marker assembly. Knows nothing of samples, colour or FDCT. |
| `src/jpegtranscode.ts` (new) | Eligibility test + the drop-chroma splice. The only place natural→zig-zag transposition happens. |
| `src/jpeg.ts` (modify) | Gains `decodeJpegFrame` and `jpegTransform`, both factored out of code that already exists. |
| `src/jpegencode.ts` (modify) | Keeps sample→plane→FDCT→quantize; delegates everything after that. |
| `src/grayimage.ts` (modify) | Tries the exact route before the sample route. |
| `src/grayconvert.ts` (modify) | `route` gains `'jpeg-exact'`. |
| `test/jpeg-encode-identity.test.ts` (new) | The byte-identity fence the extraction rests on. |
| `test/jpeg-transcode.test.ts` (new) | Exactness, structure, the padding trap, the transform trap, declines. |

---

## Task 1: The byte-identity fence

Written **first**, before anything moves. The existing JPEG tests assert decoded pixels, so a change in Huffman table selection or marker order that still decodes identically would slip past them.

**Files:**
- Create: `test/jpeg-encode-identity.test.ts`

**Interfaces:**
- Consumes: `encodeJpeg(width, height, samples, kind, opts)` from `src/jpegencode.js` — unchanged public signature.
- Produces: nothing consumed by later tasks. It is a gate.

- [ ] **Step 1: Write the fence with the hashes left as empty strings**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeJpeg, type JpegKind } from '../src/jpegencode.js';

/** A REGRESSION FENCE for 10u9.6's extraction of `encodeJpeg`'s back half into
 *  `jpegcoef.ts`, not a feature test. The entropy coder, the Huffman table
 *  selection and the marker assembly move out of `encodeJpeg` and are claimed
 *  byte-identical for every existing caller.
 *
 *  Nothing else in the suite checks that. test/jpeg.test.ts and
 *  test/jpeg-real.test.ts assert DECODED PIXELS, so a build that chose
 *  different Huffman tables, or wrote DQT after SOF, would still decode to the
 *  same image and stay green.
 *
 *  The hashes were recorded BEFORE the extraction. If one changes, the
 *  extraction moved a table, a marker or an allocation order: find out why
 *  rather than re-recording. */

/** A deterministic source: a diagonal ramp plus an 8px bar, so the DCT output
 *  is neither flat (which quantizes to nothing) nor noise (which defeats the
 *  Huffman optimizer). 61x37 makes both edges a partial MCU. */
function samples(w: number, h: number, nch: number): Uint8Array {
  const out = new Uint8Array(w * h * nch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < nch; c++) {
      out[(y * w + x) * nch + c] = (x * 3 + y * 5 + c * 61 + ((x >> 3) & 1) * 40) & 0xff;
    }
  }
  return out;
}

const W = 61, H = 37;
const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

interface Case { name: string; kind: JpegKind; opts: Parameters<typeof encodeJpeg>[4]; sha: string }

/** Every branch `encodeJpeg` has: the three channel counts, both subsampling
 *  modes, two qualities (which scale the quant tables differently), and the
 *  non-optimized path that emits the Annex K standard tables. */
const CASES: Case[] = [
  { name: 'gray q50', kind: 'gray', opts: { quality: 50 }, sha: '' },
  { name: 'gray q90', kind: 'gray', opts: { quality: 90 }, sha: '' },
  { name: 'rgb 4:4:4 q50', kind: 'rgb', opts: { quality: 50, subsampling: '4:4:4' }, sha: '' },
  { name: 'rgb 4:4:4 q90', kind: 'rgb', opts: { quality: 90, subsampling: '4:4:4' }, sha: '' },
  { name: 'rgb 4:2:0 q50', kind: 'rgb', opts: { quality: 50, subsampling: '4:2:0' }, sha: '' },
  { name: 'rgb 4:2:0 q90', kind: 'rgb', opts: { quality: 90, subsampling: '4:2:0' }, sha: '' },
  { name: 'rgb 4:2:0 q75 std tables', kind: 'rgb', opts: { optimizeHuffman: false }, sha: '' },
  { name: 'cmyk q50', kind: 'cmyk', opts: { quality: 50 }, sha: '' },
  { name: 'cmyk q90', kind: 'cmyk', opts: { quality: 90 }, sha: '' },
];

const encode = (c: Case): Uint8Array =>
  encodeJpeg(W, H, samples(W, H, CHANNELS[c.kind]), c.kind, c.opts);

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('encodeJpeg — byte-identity fence', () => {
  for (const c of CASES) {
    it(`is byte-identical for ${c.name}`, () => {
      expect(sha256(encode(c))).toBe(c.sha);
    });
  }

  it('is reproducible: two encodes of one input agree', () => {
    expect(sha256(encode(CASES[4]))).toBe(sha256(encode(CASES[4])));
  });
});
```

- [ ] **Step 2: Print the real hashes and paste them in**

Run:

```bash
npx vitest run test/jpeg-encode-identity.test.ts --reporter=basic 2>&1 | head -30
```

Expected: nine failures, each reading `expected '<64 hex chars>' to be ''`. Copy each actual hash into its case's `sha`. Then re-run:

```bash
npx vitest run test/jpeg-encode-identity.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 3: Prove the fence is load-bearing**

Temporarily change the DQT emission in `src/jpegencode.ts` — find `for (let k = 0; k < 64; k++) out.push(quant[t][ZIGZAG[k]]);` and make it `out.push(Math.max(1, quant[t][ZIGZAG[k]] - 1));`.

Run: `npx vitest run test/jpeg-encode-identity.test.ts`
Expected: **FAIL** on all nine hash cases.

Revert the change exactly (`git checkout -- src/jpegencode.ts`) and re-run.
Expected: PASS, 10 tests.

- [ ] **Step 4: Commit**

```bash
git add test/jpeg-encode-identity.test.ts
git commit -m "test(10u9.6): byte-identity fence for encodeJpeg before the extraction

The existing JPEG tests assert decoded pixels, so a change in Huffman
table selection or in marker order that still decodes identically would
pass unnoticed. Recorded before jpegcoef.ts exists; confirmed red on a
one-LSB nudge to a quantization table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Extract the encoder's back half into `jpegcoef.ts`

**Files:**
- Create: `src/jpegcoef.ts`
- Modify: `src/jpegencode.ts` (lines 105-279 — everything from `const quant: Int32Array[] = ...` onward moves or delegates)
- Test: `test/jpeg-encode-identity.test.ts` (must stay green, unchanged)

**Interfaces:**
- Consumes: `BitWriter`, `HuffTable`, `buildOptimalHuffTable`, `STD_DC_LUMA`, `STD_AC_LUMA`, `STD_DC_CHROMA`, `STD_AC_CHROMA` from `./jpeghuffenc.js`; `ZIGZAG` from `./jpeg.js`.
- Produces: `encodeJpegFromBlocks(frame: CoefFrame): Uint8Array`, plus the exported types `CoefFrame` and `CoefComponent`. Task 4 builds a one-component `CoefFrame` and calls it.

- [ ] **Step 1: Create `src/jpegcoef.ts`**

```ts
/**
 * The JPEG encoder's back half: quantized coefficients to bytes.
 *
 * Two producers share it -- `jpegencode.ts`, which arrives here after FDCT and
 * quantization, and `jpegtranscode.ts`, which arrives here with coefficients it
 * took from an existing file and never touched. A second copy of the entropy
 * coder is how the two would come to disagree about a Huffman table or a marker
 * order, which is invisible to any test that asserts decoded pixels.
 *
 * Pure: no PDF objects, no colour, no FDCT. Raw numbers in, bytes out.
 */
import { ZIGZAG } from './jpeg.js';
import {
  BitWriter, HuffTable, buildOptimalHuffTable,
  STD_DC_LUMA, STD_AC_LUMA, STD_DC_CHROMA, STD_AC_CHROMA,
} from './jpeghuffenc.js';

export interface CoefComponent {
  /**
   * One 64-entry block per element, in ZIG-ZAG order, raster over the
   * MCU-PADDED grid: `mcusPerLine * h` wide by `mcusPerColumn * v` tall.
   *
   * Zig-zag rather than the decoder's natural order because JPEG entropy coding
   * is DEFINED over the zig-zag sequence -- a run length counts zeros along it
   * -- so this is the order the module actually speaks, and `quantizeBlock`
   * already writes it. The one transposition in the system therefore lives in
   * `jpegtranscode.ts`, on the new path, rather than in every ordinary encode.
   */
  blocks: Int32Array[];
  /** Sampling factors, relative to the frame. */
  h: number;
  v: number;
  /** Quantization table slot, indexing `CoefFrame.quant`. */
  tq: number;
  /** DC/AC Huffman table slot. Both tables of a slot share its number. */
  td: number;
}

export interface CoefFrame {
  width: number;
  height: number;
  comps: CoefComponent[];
  /**
   * Quantization tables in NATURAL order, indexed by `tq`.
   *
   * Natural, where the blocks are zig-zag, and the asymmetry is the easy thing
   * to get backwards: `scaleQuantTable` produces natural and the DQT writer
   * below re-zigzags on the way out, while `parseDQT` stores the WIRE order it
   * read, which is zig-zag. A caller handing wire order straight through emits a
   * doubly-permuted table -- a file that decodes, with the wrong frequencies
   * scaled.
   */
  quant: Int32Array[];
  /** Emit an APP0 JFIF header. False for CMYK, which carries none. */
  jfif: boolean;
  /** Build per-image Huffman tables rather than using the Annex K standard set. */
  optimizeHuffman: boolean;
}

const category = (v: number): number => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const valueBits = (v: number, n: number): number => (v < 0 ? v + (1 << n) - 1 : v);

/** Encode quantized coefficient blocks as a baseline JPEG. */
export function encodeJpegFromBlocks(frame: CoefFrame): Uint8Array {
  const { width, height, comps, quant } = frame;
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerCol = Math.ceil(height / (8 * maxV));
  const blocksPerLine = comps.map((c) => mcusPerLine * c.h);

  // Walk MCUs, handing each block to `onBlock` in scan order.
  const traverse = (onBlock: (pi: number, zz: Int32Array) => void): void => {
    for (let my = 0; my < mcusPerCol; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let pi = 0; pi < comps.length; pi++) {
        const c = comps[pi];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          onBlock(pi, c.blocks[(my * c.v + by) * blocksPerLine[pi] + (mx * c.h + bx)]);
      }
  };

  /** Feed one block's symbols to `dc`/`ac` sinks; `emit` also writes the bits. */
  const codeBlock = (
    zz: Int32Array, pred: number,
    dc: (sym: number) => void, ac: (sym: number) => void,
    emit?: { bw: BitWriter; dcT: HuffTable; acT: HuffTable },
  ): number => {
    const diff = zz[0] - pred;
    const dcat = category(diff);
    dc(dcat);
    if (emit) {
      const c = emit.dcT.enc.get(dcat)!;
      emit.bw.put(c.code, c.len);
      if (dcat) emit.bw.put(valueBits(diff, dcat), dcat);
    }
    let k = 1;
    while (k < 64) {
      let run = 0;
      while (k < 64 && zz[k] === 0) { run++; k++; }
      if (k === 64) {
        ac(0x00); // EOB
        if (emit) { const c = emit.acT.enc.get(0x00)!; emit.bw.put(c.code, c.len); }
        break;
      }
      while (run > 15) {
        ac(0xf0); // ZRL
        if (emit) { const c = emit.acT.enc.get(0xf0)!; emit.bw.put(c.code, c.len); }
        run -= 16;
      }
      const acat = category(zz[k]);
      const sym = (run << 4) | acat;
      ac(sym);
      if (emit) {
        const c = emit.acT.enc.get(sym)!;
        emit.bw.put(c.code, c.len);
        emit.bw.put(valueBits(zz[k], acat), acat);
      }
      k++;
    }
    return zz[0];
  };

  // ---- Table selection ----
  // One DC and one AC table per distinct `td`. This is `usesChroma ? 2 : 1` for
  // every shape `encodeJpeg` builds, and generalizes for a caller with its own.
  const nSlots = Math.max(...comps.map((c) => c.td)) + 1;
  let dcTables: HuffTable[], acTables: HuffTable[];
  if (frame.optimizeHuffman) {
    const dcFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const acFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const pred = new Array(comps.length).fill(0);
    traverse((pi, zz) => {
      const slot = comps[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], (s) => dcFreq[slot][s]++, (s) => acFreq[slot][s]++);
    });
    dcTables = dcFreq.map((f) => buildOptimalHuffTable(f));
    acTables = acFreq.map((f) => buildOptimalHuffTable(f));
  } else {
    dcTables = nSlots > 1 ? [STD_DC_LUMA, STD_DC_CHROMA] : [STD_DC_LUMA];
    acTables = nSlots > 1 ? [STD_AC_LUMA, STD_AC_CHROMA] : [STD_AC_LUMA];
  }

  // ---- Entropy pass ----
  const bw = new BitWriter();
  {
    const pred = new Array(comps.length).fill(0);
    const noop = () => {};
    traverse((pi, zz) => {
      const slot = comps[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], noop, noop, {
        bw, dcT: dcTables[slot], acT: acTables[slot],
      });
    });
    bw.flush();
  }

  // ---- Assemble ----
  const out: number[] = [];
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);

  out.push(0xff, 0xd8); // SOI

  if (frame.jfif) { // APP0/JFIF
    out.push(0xff, 0xe0); u16(16);
    out.push(0x4a, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
    out.push(1, 1, 0); // version 1.1, no density units
    u16(1); u16(1); // X/Y density
    out.push(0, 0); // no thumbnail
  }

  // DQT — written in zig-zag order; parseDQT (jpeg.ts:92) stores wire order and
  // jpeg.ts:299 de-zigzags with qn[ZIGZAG[k]] = q[k].
  for (let t = 0; t < quant.length; t++) {
    out.push(0xff, 0xdb); u16(2 + 1 + 64);
    out.push(t); // 8-bit precision (Pq=0), table id t
    for (let k = 0; k < 64; k++) out.push(quant[t][ZIGZAG[k]]);
  }

  out.push(0xff, 0xc0); u16(8 + comps.length * 3); // SOF0
  out.push(8); u16(height); u16(width); out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].h << 4) | comps[i].v, comps[i].tq);

  const writeDHT = (tc: number, th: number, t: HuffTable) => {
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length);
    out.push((tc << 4) | th);
    for (const b of t.bits) out.push(b);
    for (const v of t.vals) out.push(v);
  };
  for (let t = 0; t < dcTables.length; t++) writeDHT(0, t, dcTables[t]);
  for (let t = 0; t < acTables.length; t++) writeDHT(1, t, acTables[t]);

  out.push(0xff, 0xda); u16(6 + comps.length * 2); // SOS
  out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].td << 4) | comps[i].td);
  out.push(0, 63, 0); // Ss, Se, Ah/Al

  for (const b of bw.bytes) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 2: Cut the moved code out of `src/jpegencode.ts`**

Delete everything in `encodeJpeg` from the line

```ts
  const blocksPerLine = planes.map((p) => mcusPerLine * p.hs);
```

through the final `return Uint8Array.from(out);` — that is, `traverse`, `codeBlock`, the table selection block, the entropy pass and the whole assemble block. Replace it with:

```ts
  return encodeJpegFromBlocks({
    width, height,
    comps: planes.map((p, pi) => ({
      blocks: coefs[pi], h: p.hs, v: p.vs, tq: p.tq, td: p.td,
    })),
    quant,
    jfif: kind !== 'cmyk',
    optimizeHuffman: optimize,
  });
}
```

Then delete the now-unused module-level helpers `category` and `valueBits` (they moved), and fix the imports at the top of the file:

```ts
import {
  QUANT_LUMA, QUANT_CHROMA, scaleQuantTable, fdct8x8, quantizeBlock,
} from './jpegfdct.js';
import { encodeJpegFromBlocks } from './jpegcoef.js';
```

`ZIGZAG`, `BitWriter`, `HuffTable`, `buildOptimalHuffTable` and the four `STD_*` tables are no longer referenced in `jpegencode.ts` — remove those two import statements entirely. `mcusPerLine` and `mcusPerCol` are still needed (the FDCT loop sizes `bpl`/`bpc` from them), so leave them.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. A residual-import error here means a leftover reference — remove it rather than re-adding the import.

- [ ] **Step 4: Run the fence and the existing JPEG suite**

Run:

```bash
npx vitest run test/jpeg-encode-identity.test.ts test/jpeg.test.ts test/jpeg-real.test.ts test/grayimage.test.ts
```

Expected: PASS, all of them. If a hash moved, the extraction changed a table, a marker or an allocation order — find out which. Do **not** re-record.

- [ ] **Step 5: Commit**

```bash
git add src/jpegcoef.ts src/jpegencode.ts
git commit -m "refactor(10u9.6): extract encodeJpeg's back half into jpegcoef.ts

The entropy coder, the Huffman table selection and the marker assembly
were closures inside encodeJpeg, reachable only by handing it 8-bit
samples. They are now their own pure module over quantized blocks, so a
second producer needs no copy of them.

Blocks cross the boundary in zig-zag order, which is what quantizeBlock
already writes and what JPEG entropy coding is defined over; quant tables
cross in natural order, which is what scaleQuantTable produces. Byte-
identical for every existing caller, fenced by test/jpeg-encode-identity.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `decodeJpegFrame` and `jpegTransform`

**Files:**
- Modify: `src/jpeg.ts` (`decodeJpeg` at line 131; `combinePlanes` at line 318)
- Test: `test/jpeg-transcode.test.ts` (created here with the `jpegTransform` cases; extended in Task 4)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `decodeJpegFrame(data: Uint8Array): { frame: Frame; qt: (Int32Array | undefined)[]; adobe: number | undefined }`
  - `jpegTransform(frame: Frame, adobe: number | undefined): number`

  Task 4 calls both.

- [ ] **Step 1: Write the failing test**

Create `test/jpeg-transcode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJpegFrame, jpegTransform } from '../src/jpeg.js';
import { encodeJpeg } from '../src/jpegencode.js';

const rgbBytes = (w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { out[i * 3] = 200; out[i * 3 + 1] = 60; out[i * 3 + 2] = 30; }
  return out;
};

/** Rewrite the three SOF component ids of a baseline JPEG in place. SOF0 is
 *  0xffc0; its payload is precision(1) height(2) width(2) nc(1), then one
 *  3-byte component spec each, whose first byte is the id. */
function setComponentIds(jpeg: Uint8Array, ids: number[]): Uint8Array {
  const out = jpeg.slice();
  for (let p = 2; p + 1 < out.length; ) {
    if (out[p] !== 0xff) { p++; continue; }
    const marker = out[p + 1];
    const len = (out[p + 2] << 8) | out[p + 3];
    if (marker === 0xc0) {
      const base = p + 4 + 6;
      for (let i = 0; i < ids.length; i++) out[base + i * 3] = ids[i];
      return out;
    }
    p += 2 + len;
  }
  throw new Error('no SOF0 in the fixture');
}

describe('decodeJpegFrame', () => {
  it('returns the decoded frame with its quantized blocks, not samples', () => {
    const jpeg = encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 });

    const { frame, qt, adobe } = decodeJpegFrame(jpeg);

    expect(frame.comps).toHaveLength(3);
    expect(frame.width).toBe(16);
    expect(frame.precision).toBe(8);
    expect(adobe).toBeUndefined();
    expect(qt[0]).toBeDefined();
    // A flat colour still has a non-zero DC in every block.
    expect(frame.comps[0].blocks[0]).not.toBe(0);
  });
});

describe('jpegTransform', () => {
  it('reports 1 for a three-component JPEG with ordinary numeric ids', () => {
    const jpeg = encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 });
    const { frame, adobe } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, adobe)).toBe(1);
  });

  it("reports 0 for SOF ids 'R','G','B', whose component 0 is red and not luma", () => {
    // libtiff writes exactly this for a JPEG-compressed RGB TIFF. Mistaking it
    // for YCbCr means greying an image to its red channel, which renders as a
    // plausible photograph with nothing to flag it.
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    const { frame, adobe } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, adobe)).toBe(0);
  });

  it('lets an Adobe marker outrank the id test, since it states intent', () => {
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    const { frame } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/jpeg-transcode.test.ts`
Expected: FAIL — `decodeJpegFrame is not a function` (an import error, so every case fails).

- [ ] **Step 3: Split `decodeJpeg` in `src/jpeg.ts`**

Replace the `export function decodeJpeg(...)` signature line and its first three lines so the marker walk becomes its own export. Concretely, change:

```ts
export function decodeJpeg(data: Uint8Array): JpegImage {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  if (isHierarchical(data)) return decodeHierarchical(data);
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
```

to:

```ts
export interface JpegFrameResult {
  frame: Frame;
  /** Quantization tables in WIRE (zig-zag) order, indexed by table id. */
  qt: (Int32Array | undefined)[];
  /** The Adobe APP14 transform byte, if the file carried one. */
  adobe: number | undefined;
}

/**
 * Parse and entropy-decode a JPEG, stopping at its quantized coefficients.
 *
 * `decodeJpeg` is this plus dequantization, the IDCT and the colour transform.
 * Split out for `jpegtranscode.ts`, which greys a YCbCr JPEG by keeping those
 * coefficients and needs none of the three.
 *
 * Hierarchical JPEGs are NOT handled here -- they have no single frame -- so a
 * caller that may see one tests `isHierarchical` first, as `decodeJpeg` does.
 */
export function decodeJpegFrame(data: Uint8Array): JpegFrameResult {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
```

Then replace the tail of that function — the two lines

```ts
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return frame.lossless ? assembleLossless(frame, adobe) : assemble(frame, adobe, qt);
}
```

with:

```ts
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return { frame, qt, adobe };
}

export function decodeJpeg(data: Uint8Array): JpegImage {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  if (isHierarchical(data)) return decodeHierarchical(data);
  const { frame, qt, adobe } = decodeJpegFrame(data);
  return frame.lossless ? assembleLossless(frame, adobe) : assemble(frame, adobe, qt);
}
```

Nothing between those two edits changes: the marker loop, the `let frame`, `let adobe`, `let restartInterval` and `let pos` declarations all stay exactly where they are.

- [ ] **Step 4: Extract `jpegTransform` from `combinePlanes`**

In `combinePlanes`, replace the `rgbIds` / `transform` block:

```ts
  const rgbIds = nc === 3 && frame.comps[0].id === 0x52
    && frame.comps[1].id === 0x47 && frame.comps[2].id === 0x42;
  const transform = adobeTransform !== undefined ? adobeTransform
    : rgbIds ? 0 : nc === 3 ? 1 : 0;
```

with:

```ts
  const transform = jpegTransform(frame, adobeTransform);
```

and add, immediately above `combinePlanes`, keeping the existing explanatory comment with it:

```ts
/**
 * The JPEG→output colour transform in force: 0 = none, 1 = YCbCr, 2 = YCCK.
 *
 * Three components with SOF ids 'R','G','B' are ALREADY RGB and must not be
 * inverse-transformed. libjpeg's jpeg_default_colorspace makes the same test,
 * and it is the only signal such a file carries: it has no Adobe APP14 marker
 * (whose transform byte would otherwise decide) and no JFIF marker either.
 * libtiff writes exactly this shape for a JPEG-compressed TIFF whose
 * photometric is 2 (RGB), so without the test every such file decodes to
 * garbage -- R and B pinned near zero. An Adobe marker still outranks it,
 * since that states the producer's intent explicitly.
 *
 * ONE owner, because `jpegtranscode.ts` asks the same question for a different
 * reason: transform 0 means component 0 is RED, and greying by keeping it would
 * emit the red channel as luma -- a plausible-looking picture that is entirely
 * wrong, with nothing anywhere to flag it.
 */
export function jpegTransform(frame: Frame, adobeTransform: number | undefined): number {
  const nc = frame.comps.length;
  const rgbIds = nc === 3 && frame.comps[0].id === 0x52
    && frame.comps[1].id === 0x47 && frame.comps[2].id === 0x42;
  return adobeTransform !== undefined ? adobeTransform : rgbIds ? 0 : nc === 3 ? 1 : 0;
}
```

Delete the old comment block from inside `combinePlanes` — it moved.

Note `combinePlanes` computed `nc` from `planes.length` while `jpegTransform` uses `frame.comps.length`. They are equal by construction: `assemble` maps one plane per component, and `assembleLossless` does the same.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/jpeg-transcode.test.ts test/jpeg.test.ts test/jpeg-real.test.ts test/tiff-real.test.ts`
Expected: PASS. `tiff-real` is in the list on purpose — it holds the `'R','G','B'`-id case that `jpegTransform` now answers.

- [ ] **Step 6: Commit**

```bash
git add src/jpeg.ts test/jpeg-transcode.test.ts
git commit -m "refactor(10u9.6): decodeJpegFrame and jpegTransform in jpeg.ts

decodeJpeg built a Frame full of quantized coefficients and threw it
away. decodeJpegFrame hands it back, so a caller that wants the
coefficients pays for neither the dequantization nor the IDCT.

jpegTransform moves out of combinePlanes because a second consumer is
about to ask the same question: transform 0 means component 0 is RED, and
a transcoder that mistook it for luma would grey an image to its red
channel with nothing to flag it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `jpegtranscode.ts` — eligibility and the splice

**Files:**
- Create: `src/jpegtranscode.ts`
- Test: `test/jpeg-transcode.test.ts` (extend)

**Interfaces:**
- Consumes: `decodeJpegFrame`, `jpegTransform`, `ZIGZAG` from `./jpeg.js`; `isHierarchical` from `./jpeghier.js`; `encodeJpegFromBlocks`, `CoefFrame` from `./jpegcoef.js`.
- Produces: `greyJpegFromCoefficients(data: Uint8Array): TranscodeResult`, where

  ```ts
  type TranscodeResult =
    | { kind: 'ok'; data: Uint8Array; width: number; height: number }
    | { kind: 'decline'; reason: string };
  ```

  Task 5 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpeg-transcode.test.ts`, and extend its import line to
`import { decodeJpegFrame, jpegTransform, decodeJpeg, idct, ZIGZAG } from '../src/jpeg.js';`
plus `import { greyJpegFromCoefficients } from '../src/jpegtranscode.js';`
and `import { readFileSync } from 'node:fs';`.

```ts
const FIXTURES = new URL('./fixtures/jpeg/', import.meta.url);
const fixture = (n: string): Uint8Array => new Uint8Array(readFileSync(new URL(n, FIXTURES)));

/** Component 0's decoded plane, which for a YCbCr JPEG is its Y channel. */
function yPlane(jpeg: Uint8Array): Uint8Array {
  const { frame, qt } = decodeJpegFrame(jpeg);
  const c = frame.comps[0];
  const q = qt[c.tq]!;
  const qn = new Int32Array(64);
  for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k];
  const pw = c.blocksPerLine * 8, ph = c.blocksPerColumn * 8;
  const out = new Uint8Array(pw * ph);
  // Deliberately re-implemented here rather than reached through `assemble`:
  // the point is to compare against the INPUT file's own luma, not against
  // anything the transcoder produced.
  const dq = new Int32Array(64); const px = new Array(64);
  for (let br = 0; br < c.blocksPerColumn; br++) for (let bc = 0; bc < c.blocksPerLine; bc++) {
    const off = (br * c.bpl + bc) * 64;
    for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
    idct(dq, 0, px, 128, 255);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      out[(br * 8 + y) * pw + (bc * 8 + x)] = px[y * 8 + x];
  }
  return out;
}

describe('greyJpegFromCoefficients — exactness', () => {
  it('reproduces the input JPEG’s own Y plane byte for byte', () => {
    const src = fixture('testorig.jpg');            // libjpeg baseline, 227x149, 4:2:0
    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.width).toBe(227);
    expect(r.height).toBe(149);

    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    expect(got.width).toBe(227);
    expect(got.height).toBe(149);

    // The anchor is the ORIGINAL file's luma, not our encoder. Same
    // coefficients through the same quant table and the same IDCT, so this is
    // equality rather than a tolerance -- which is the whole claim.
    const y = yPlane(src);
    const pw = Math.ceil(227 / 8) * 8;
    for (let row = 0; row < 149; row++) for (let col = 0; col < 227; col++) {
      expect(got.data[row * 227 + col]).toBe(y[row * pw + col]);
    }
  });

  it('does the same for an arithmetic-coded JPEG, emitting baseline Huffman', () => {
    const src = fixture('testimgari.jpg');
    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    const y = yPlane(src);
    const pw = Math.ceil(got.width / 8) * 8;
    expect(got.data[0]).toBe(y[0]);
    expect(got.data[100 * got.width + 100]).toBe(y[100 * pw + 100]);
    // SOF0, not SOF9: the output is always baseline whatever went in.
    expect([...r.data].some((_, i) => r.data[i] === 0xff && r.data[i + 1] === 0xc0)).toBe(true);
    expect([...r.data].some((_, i) => r.data[i] === 0xff && r.data[i + 1] === 0xc9)).toBe(false);
  });
});

describe('greyJpegFromCoefficients — structure', () => {
  it('carries component 0’s coefficients and quant table through unchanged', () => {
    const src = fixture('testorig.jpg');
    const r = greyJpegFromCoefficients(src);
    if (r.kind !== 'ok') throw new Error(r.reason);

    const a = decodeJpegFrame(src);
    const b = decodeJpegFrame(r.data);

    // Quant table: the input's, verbatim. A doubly-permuted table would still
    // decode, with the wrong frequencies scaled -- invisible to a pixel test on
    // smooth content.
    expect([...b.qt[b.frame.comps[0].tq]!]).toEqual([...a.qt[a.frame.comps[0].tq]!]);

    // Coefficients: every block of the un-padded grid, natural order both sides.
    const ca = a.frame.comps[0], cb = b.frame.comps[0];
    expect(cb.blocksPerLine).toBe(ca.blocksPerLine);
    expect(cb.blocksPerColumn).toBe(ca.blocksPerColumn);
    for (let by = 0; by < ca.blocksPerColumn; by++) for (let bx = 0; bx < ca.blocksPerLine; bx++) {
      const oa = (by * ca.bpl + bx) * 64, ob = (by * cb.bpl + bx) * 64;
      expect([...cb.blocks.slice(ob, ob + 64)]).toEqual([...ca.blocks.slice(oa, oa + 64)]);
    }
  });
});

describe('greyJpegFromCoefficients — the MCU padding trap', () => {
  // At 4:2:0 the Y plane's grid is ceil(w/16)*2 blocks wide, while a
  // one-component frame needs ceil(w/8). Those differ by one whenever w mod 16
  // falls in 1..8 -- 20 mod 16 = 4 -- so a build that re-emits the padding
  // produces a file that still decodes, just wider than its own SOF claims.
  it('drops the padding column and row rather than re-emitting them', () => {
    const w = 20, h = 20;
    const src = encodeJpeg(w, h, rgbBytes(w, h), 'rgb', { quality: 90, subsampling: '4:2:0' });

    const a = decodeJpegFrame(src);
    expect(a.frame.comps[0].bpl).toBe(4);            // ceil(20/16) * 2, padded
    expect(a.frame.comps[0].blocksPerLine).toBe(3);  // ceil(20/8), real

    const r = greyJpegFromCoefficients(src);
    if (r.kind !== 'ok') throw new Error(r.reason);
    const b = decodeJpegFrame(r.data);
    expect(b.frame.width).toBe(w);
    expect(b.frame.comps[0].bpl).toBe(3);
    expect(b.frame.comps[0].blocksPerColumn).toBe(3);
  });
});

describe('greyJpegFromCoefficients — what it declines', () => {
  const decline = (jpeg: Uint8Array): string => {
    const r = greyJpegFromCoefficients(jpeg);
    if (r.kind !== 'decline') throw new Error('expected a decline');
    return r.reason;
  };

  it("declines SOF ids 'R','G','B', whose component 0 is red rather than luma", () => {
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    expect(decline(jpeg)).toMatch(/luma|transform/i);
  });

  it('declines a CMYK JPEG, whose component 0 is cyan', () => {
    const cmyk = new Uint8Array(16 * 16 * 4).fill(80);
    expect(decline(encodeJpeg(16, 16, cmyk, 'cmyk', { quality: 90 }))).toMatch(/component/i);
  });

  it('declines a one-component JPEG, which is already grey', () => {
    expect(decline(fixture('synth-gray-baseline.jpg'))).toMatch(/component/i);
  });

  it('declines rather than throwing on bytes that are not a JPEG', () => {
    expect(decline(new Uint8Array([1, 2, 3, 4]))).toMatch(/parse/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/jpeg-transcode.test.ts`
Expected: FAIL — cannot resolve `../src/jpegtranscode.js`.

- [ ] **Step 3: Create `src/jpegtranscode.ts`**

```ts
/**
 * Grey a JPEG in the coefficient domain.
 *
 * A YCbCr JPEG's Y channel IS Rec. 601 luma, so greying one by decoding to RGB
 * and re-encoding re-derives, lossily, a number the file already holds exactly.
 * Keeping component 0's quantized coefficients and its quantization table
 * verbatim and dropping the chroma is exact, generation-free, and smaller.
 *
 * Pure: bytes in, bytes out, no PDF objects. Declines rather than throwing, so
 * a caller falls back to the sample route with nothing to catch.
 */
import { ZIGZAG, decodeJpegFrame, jpegTransform } from './jpeg.js';
import { isHierarchical } from './jpeghier.js';
import { encodeJpegFromBlocks } from './jpegcoef.js';

export type TranscodeResult =
  | { kind: 'ok'; data: Uint8Array; width: number; height: number }
  | { kind: 'decline'; reason: string };

export function greyJpegFromCoefficients(data: Uint8Array): TranscodeResult {
  const no = (reason: string): TranscodeResult => ({ kind: 'decline', reason });

  // A hierarchical JPEG has no single frame to take coefficients from, and
  // decodeJpegFrame does not handle one.
  if (isHierarchical(data)) return no('hierarchical JPEG has no single DCT frame');

  let parsed;
  try { parsed = decodeJpegFrame(data); }
  catch (e) { return no(`parse failed: ${(e as Error).message}`); }
  const { frame, adobe } = parsed;

  if (frame.lossless) return no('lossless JPEG carries no DCT coefficients');
  if (frame.precision !== 8) {
    return no(`precision ${frame.precision} is not 8, which the baseline writer emits`);
  }
  if (frame.comps.length !== 3) {
    return no(`${frame.comps.length} components, and only a 3-component YCbCr JPEG has luma in component 0`);
  }
  // The decisive test. Transform 0 means component 0 is RED, and keeping it
  // would emit the red channel as grey -- see jpegTransform's own comment.
  if (jpegTransform(frame, adobe) === 0) {
    return no('colour transform 0: component 0 is not luma');
  }

  const c = frame.comps[0];
  if (c.h !== frame.maxH || c.v !== frame.maxV) {
    return no('component 0 is subsampled relative to the frame');
  }
  const wire = c.quant;
  if (!wire) return no('component 0 has no quantization table');

  // parseDQT stores WIRE order, which is zig-zag; CoefFrame.quant is natural.
  const quant = new Int32Array(64);
  for (let k = 0; k < 64; k++) quant[ZIGZAG[k]] = wire[k];

  // The blocks of the REAL grid, dropping the MCU padding: at 4:2:0 the Y
  // plane is ceil(w/16)*2 blocks wide where a one-component frame needs
  // ceil(w/8), and re-emitting the difference yields a file wider than its own
  // SOF. `blocksPerLine`/`blocksPerColumn` are already those real counts, and
  // equal the output's because component 0 carries the frame's max sampling.
  const blocks: Int32Array[] = [];
  for (let by = 0; by < c.blocksPerColumn; by++) {
    for (let bx = 0; bx < c.blocksPerLine; bx++) {
      const off = (by * c.bpl + bx) * 64;
      // The one natural→zig-zag transposition in the system.
      const zz = new Int32Array(64);
      for (let k = 0; k < 64; k++) zz[k] = c.blocks[off + ZIGZAG[k]];
      blocks.push(zz);
    }
  }

  const out = encodeJpegFromBlocks({
    width: frame.width,
    height: frame.height,
    // One component at 1x1: the chroma is gone, so there is nothing to
    // subsample against and the MCU grid is the block grid.
    comps: [{ blocks, h: 1, v: 1, tq: 0, td: 0 }],
    quant: [quant],
    jfif: true,
    // Rebuilt: the input's tables were tuned for three interleaved components,
    // and a progressive or arithmetic input carries no baseline tables at all.
    optimizeHuffman: true,
  });
  return { kind: 'ok', data: out, width: frame.width, height: frame.height };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/jpeg-transcode.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the padding and ordering rules are load-bearing**

Three mutations, each run against `npx vitest run test/jpeg-transcode.test.ts`, each reverted before the next:

1. In the block loop, change `c.blocksPerLine` to `c.bpl` and `c.blocksPerColumn` to `c.bpc`.
   Expected: **FAIL** on the padding-trap case (and on `testorig.jpg`, which is 227×149 and lands in the trap on both axes).
2. Change `zz[k] = c.blocks[off + ZIGZAG[k]]` to `zz[k] = c.blocks[off + k]`.
   Expected: **FAIL** on exactness and on structure.
3. Change `quant[ZIGZAG[k]] = wire[k]` to `quant[k] = wire[k]`.
   Expected: **FAIL** on structure (and on exactness).

If any mutation leaves the suite green, the corresponding test is not pinning what it claims — fix the test, not the mutation.

- [ ] **Step 6: Commit**

```bash
git add src/jpegtranscode.ts test/jpeg-transcode.test.ts
git commit -m "feat(10u9.6): greyJpegFromCoefficients, the coefficient-domain splice

Keeps component 0's quantized coefficients and its quantization table
verbatim, drops the chroma, and re-emits a one-component baseline JPEG.
Declines rather than throwing, so a caller falls back with nothing to
catch.

Three rules measured load-bearing by mutation: the MCU padding is dropped
(at 4:2:0 the Y grid is ceil(w/16)*2 blocks wide where the output needs
ceil(w/8)), blocks transpose natural to zig-zag, and the quant table
transposes wire to natural -- the two orders running opposite ways in one
function.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Wire the exact route into `ConvertToGrayscale`

**Files:**
- Modify: `src/grayimage.ts:30` (the `route` union) and the body of `grayscaleImage`
- Modify: `src/grayconvert.ts:40` (the `route` union)
- Test: `test/grayimage.test.ts:158`, `test/grayscale-convert.test.ts:85,88` (existing assertions move), plus new cases

**Interfaces:**
- Consumes: `greyJpegFromCoefficients` from `./jpegtranscode.js`.
- Produces: `GrayImageResult.route` and `GrayImageOutcome`'s `route` both gain `'jpeg-exact'`.

- [ ] **Step 1: Write the failing tests**

In `test/grayimage.test.ts`, change line 158 from `expect(r.route).toBe('jpeg');` to `expect(r.route).toBe('jpeg-exact');`, and tighten the tolerance assertion below it — the exact route reproduces the input's own Y, so the slack is no longer needed:

```ts
    // Pure red -> Y = clamp8(0.299 * 255) = 76. The exact route reproduces the
    // input's own Y plane, so this is DCT round-trip loss on a flat block only.
    expect(Math.abs(out.data[0] - 76)).toBeLessThanOrEqual(1);
```

Then append a new describe to the same file:

```ts
describe('grayscaleImage — the exact DCT route declines', () => {
  it('falls back to the sample route for a CMYK JPEG, whose component 0 is cyan', () => {
    const w = 8, h = 8;
    const cmyk = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      cmyk[i * 4] = 0; cmyk[i * 4 + 1] = 255; cmyk[i * 4 + 2] = 255; cmyk[i * 4 + 3] = 0;
    }
    const jpeg = encodeJpeg(w, h, cmyk, 'cmyk', { quality: 90 });

    const s = img([
      ['Width', w], ['Height', h], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceCMYK')], ['Filter', name('DCTDecode')],
    ], jpeg);

    const r = grayscaleImage(s, resolve, inflate, { quality: 90 });
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('jpeg');
    expect(r.from).toBe('DeviceCMYK');
  });
});
```

In `test/grayscale-convert.test.ts`, change line 85 to
`expect(report.images.map((i) => i.route).sort()).toEqual(['flate', 'jpeg-exact']);`
and line 88's block to:

```ts
    // The JPEG took the coefficient route, so nothing was re-encoded and the
    // whole conversion is lossless. Before 10u9.6 this asserted `true`.
    expect(report.lossy).toBe(false);
    expect(report.skipped).toEqual([]);
```

Delete the now-stale comment above it (`// A JPEG re-encode happened, so the output is no longer a lossless greying.`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/grayimage.test.ts test/grayscale-convert.test.ts`
Expected: FAIL — three cases, each reporting `'jpeg'` where `'jpeg-exact'`/`false` was wanted. The new CMYK case passes already (it is the unchanged route), which is the point: it is there to pin that the fallback still works after the next step.

- [ ] **Step 3: Widen the two route unions**

`src/grayimage.ts:30`:

```ts
  | { kind: 'converted'; stream: PdfStream; from: string; route: 'palette' | 'jpeg' | 'jpeg-exact' | 'flate' }
```

`src/grayconvert.ts:40`:

```ts
  route: 'palette' | 'jpeg' | 'jpeg-exact' | 'flate';
```

`grayconvert.ts:321` needs no change: it reads `if (r.route === 'jpeg') report.lossy = true;`, and `'jpeg-exact'` correctly does not match.

- [ ] **Step 4: Add the exact attempt to `grayscaleImage`**

In `src/grayimage.ts`, immediately after the `const filter = terminalFilter(...)` / `isDct` / unsupported-filter guard block and *before* `let src: Uint8Array;`, insert:

```ts
  // The exact route, tried first. A YCbCr JPEG's Y channel IS Rec. 601 luma,
  // so keeping its quantized coefficients greys it with no decode, no
  // requantization and no generation loss -- and `opts.quality` has nothing to
  // govern. Anything it will not take (CMYK, 12-bit, lossless, an 'R','G','B'
  // -id file whose component 0 is red) declines and falls through to the
  // sample route below, which is a route choice and not a failure: it is
  // deliberately NOT reported in `skipped`.
  //
  // A decline costs a second parse of these bytes. Sharing the frame would mean
  // moving JPEG internals into this module; one extra entropy decode on the
  // uncommon path is the cheaper price.
  if (isDct && CHANNELS[kind] === 3) {
    try {
      const t = greyJpegFromCoefficients(inflate(stream));
      if (t.kind === 'ok' && t.width === w && t.height === h) {
        return { kind: 'converted', stream: rebuild(stream, t.data, 'DCTDecode'),
          from: head, route: 'jpeg-exact' };
      }
    } catch { /* fall through; the sample route reports the failure properly */ }
  }
```

A geometry disagreement falls through on purpose, so the existing code below produces its `JPEG geometry … disagrees with the dict …` skip rather than a second message saying the same thing.

Add the import at the top of the file:

```ts
import { greyJpegFromCoefficients } from './jpegtranscode.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/grayimage.test.ts test/grayscale-convert.test.ts test/grayscale-render.test.ts`
Expected: PASS. `grayscale-render` is in the list because it is the global oracle — it renders converted pages and sweeps for any pixel whose channels disagree, so it is what catches an exact route that emitted something that is not grey at all.

- [ ] **Step 6: Prove the wiring is load-bearing**

Temporarily change `route: 'jpeg-exact'` to `route: 'jpeg'` in the block just added.
Run: `npx vitest run test/grayscale-convert.test.ts`
Expected: **FAIL** on both the route and the `lossy` assertion.
Revert.

- [ ] **Step 7: Full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. Any other file asserting `route === 'jpeg'` or `lossy === true` for a 3-component JPEG surfaces here — update it the same way, and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git add src/grayimage.ts src/grayconvert.ts test/grayimage.test.ts test/grayscale-convert.test.ts
git commit -m "feat(10u9.6): ConvertToGrayscale greys a YCbCr JPEG exactly

The DCT branch tries the coefficient route first and reports it as
route: 'jpeg-exact', which does not set report.lossy. Anything the
transcoder declines falls through to the unchanged sample route -- a
route choice, not a failure, so it is not reported in skipped.

Two existing assertions move rather than break: the RGB JPEG fixture in
grayscale-convert now reports 'jpeg-exact' and lossy false, because our
own encoder writes ids 1/2/3 with no Adobe marker and is therefore
eligible.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: A real progressive fixture

`testimgint.jpg` is a second **baseline** encoder config, not progressive, so the vendored set covers progressive nowhere. Building one with our own encoder would measure our encoder against our decoder — the trap `PROVENANCE.md` names.

**Files:**
- Create: `test/fixtures/jpeg/testorig-prog.jpg`
- Modify: `test/fixtures/jpeg/PROVENANCE.md`
- Modify: `test/jpeg-transcode.test.ts`

**Interfaces:**
- Consumes: `greyJpegFromCoefficients` from Task 4.
- Produces: nothing consumed later.

- [ ] **Step 1: Produce the fixture with a one-off mozjpeg install**

This follows the recipe `test/fixtures/jpeg/PROVENANCE.md` already documents under "Generated — mozjpeg `cjpeg` over a source we designed": installed once at authoring time, output committed, package removed. It is **not** a dev dependency.

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install mozjpeg@8.0.0
```

Then, from the repo root, with `$CJPEG` set to the path the package printed:

```bash
"$CJPEG" -revert -progressive -quality 90 \
  -outfile test/fixtures/jpeg/testorig-prog.jpg \
  test/fixtures/jpeg/testorig.ppm
```

`-revert` restores stock libjpeg defaults so the output is canonical libjpeg-lineage rather than mozjpeg-flavoured, exactly as the two existing synthetics were made. The source is the same `testorig.ppm` the vendored files came from, which keeps both the lineage and the 227×149 geometry that lands in the MCU-padding trap on both axes.

Verify and record the hash:

```bash
node -e "const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');console.log(createHash('sha256').update(readFileSync('test/fixtures/jpeg/testorig-prog.jpg')).digest('hex'))"
```

Then remove the temporary install (delete the temp directory). Nothing in `package.json` changes.

**If `npm install mozjpeg@8.0.0` cannot run on this box**, do not fake it with a hand-built stream. Skip to Step 4, and instead record the gap in `test/jpeg-transcode.test.ts` as a comment naming what is unverified: that a progressive input's successive-approximation refinements land in `blocks` in a form the splice reproduces. Then skip Steps 2 and 3, and commit only that comment.

- [ ] **Step 2: Record it in `PROVENANCE.md`**

In the "Generated — mozjpeg `cjpeg`" file table, add a row (using the hash printed above):

```
| `testorig-prog.jpg` | `<sha256>` | JFIF APP0, **SOF2 progressive**, 227×149, 4:2:0, IDs 1/2/3 — the same `testorig.ppm` source as the vendored set |
```

and in the "Command lines" block, add:

```
cjpeg -revert -progressive -quality 90 -outfile testorig-prog.jpg testorig.ppm
```

with a sentence beneath it:

> `-progressive` is mozjpeg's default and is stated explicitly here only because
> the two synthetics above pass `-baseline` to suppress it. This is the one file
> in the directory covering SOF2, which `10u9.6` needs: a progressive scan
> reaches `Comp.blocks` through successive approximation rather than in one
> pass, and nothing else in the suite reads a progressive file we did not write.

Also add a row to the coverage table near the end of the file:

```
| RGB 4:2:0 progressive (SOF2) | `testorig-prog.jpg` |
```

- [ ] **Step 3: Assert it in the transcode test**

Append to the `greyJpegFromCoefficients — exactness` describe in `test/jpeg-transcode.test.ts`:

```ts
  it('reproduces a progressive JPEG’s Y plane, emitting baseline output', () => {
    // The one input shape whose coefficients arrive through successive
    // approximation rather than in a single pass. It is also today's worst
    // case: before 10u9.6 a progressive JPEG was decoded and re-encoded.
    const src = fixture('testorig-prog.jpg');
    const { frame } = decodeJpegFrame(src);
    expect(frame.progressive).toBe(true);

    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    const y = yPlane(src);
    const pw = Math.ceil(227 / 8) * 8;
    for (let row = 0; row < 149; row++) for (let col = 0; col < 227; col++) {
      expect(got.data[row * 227 + col]).toBe(y[row * pw + col]);
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/jpeg-transcode.test.ts test/jpeg-real.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/jpeg/testorig-prog.jpg test/fixtures/jpeg/PROVENANCE.md test/jpeg-transcode.test.ts
git commit -m "test(10u9.6): a real progressive JPEG fixture from mozjpeg

testimgint.jpg is a second baseline config, not progressive, so the
vendored set covered SOF2 nowhere and a hand-built one would only prove
our encoder agrees with our decoder. Produced by the same one-off mozjpeg
recipe PROVENANCE.md already documents, over the same testorig.ppm, so
the lineage and the 227x149 padding-trap geometry both carry over.

Progressive is today's worst case: its coefficients arrive through
successive approximation, and before this it was decoded and re-encoded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Documentation and close-out

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, `### Added`)
- Modify: `README.md` (the Grayscale conversion Features bullet, and the grayscale prose section)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the CHANGELOG entry**

Insert as the first bullet under `### Added` in `## [Unreleased]`:

```markdown
- **`ConvertToGrayscale` greys a YCbCr JPEG exactly, in the coefficient domain** — a baseline JPEG's Y channel *is* Rec. 601 luma, so decoding one to RGB, computing luma per pixel and re-encoding was re-deriving, lossily, a number the file already held exactly. The new route keeps component 0's quantized coefficients and its quantization table verbatim, drops the two chroma components, and re-emits a one-component baseline JPEG: no IDCT, no FDCT, no requantization, no generation loss, and a smaller file. It reports as `route: 'jpeg-exact'` and does **not** set `report.lossy`, so a document whose images are all ordinary photographs now converts losslessly where it previously could not. Progressive and arithmetic inputs take it too — they normalize into the same coefficient array — which turns the shapes that suffered most from the old route into the ones that gain most, and normalizes them to baseline on the way out. What it declines falls through to the unchanged sample route rather than being reported in `skipped`, because the image converts either way and `route` is what says how: CMYK and YCCK (component 0 is cyan, not luma), 12-bit precision, lossless and hierarchical JPEGs (no DCT coefficients at all), and — the sharp one — any three-component file whose colour transform is 0. That last case is a JPEG whose SOF component ids are `'R'`, `'G'`, `'B'`, which libtiff writes for a JPEG-compressed RGB TIFF: its component 0 is **red**, and greying by keeping it would emit the red channel as luma, a plausible-looking photograph that is entirely wrong with nothing anywhere to flag it. The rule deciding that has one owner, shared with the decoder, rather than a second copy that could drift. `opts.quality` still governs the fallback and has no meaning on the exact route. Note the exact route's output is not byte-identical to the old one for the same image: `YCbCr → RGB → luma` round-trips through two clampings and lands within about ±1 of the Y plane, and the coefficient path is the more faithful of the two. (`10u9.6`)
```

- [ ] **Step 2: Update the README Features bullet**

In the `- **Grayscale conversion** —` bullet, replace

```
a **JPEG** re-encodes as a grey JPEG (`quality`, default 90) and sets `lossy`
```

(the phrasing to match is `a JPEG re-encodes as a grey JPEG (\`quality\`, default 90) and sets \`lossy\``) with:

```
a **YCbCr JPEG** greys in the coefficient domain — component 0's quantized coefficients and its quantization table are kept verbatim and the chroma dropped, which is exact, smaller and does not set `lossy` — while a JPEG that route declines (CMYK, 12-bit, lossless, or an `'R','G','B'`-id file whose component 0 is red rather than luma) re-encodes as a grey JPEG (`quality`, default 90) and sets `lossy`
```

- [ ] **Step 3: Update the README grayscale section**

Find the paragraph reading:

```
An **image** takes the cheapest faithful route... a **JPEG** re-encodes as a grey
JPEG, which is lossy...
```

and add a paragraph after it:

```markdown
A **YCbCr JPEG** — which is nearly every photographic JPEG — takes a shorter
route still. Its Y channel already *is* Rec. 601 luma, so greying it needs no
decode at all: component 0's quantized coefficients and its quantization table
are carried over untouched and the two chroma components dropped, giving an
exact, generation-free greying that is smaller than the original and reports
`route: 'jpeg-exact'` without setting `lossy`. Progressive and arithmetic
JPEGs take it too, and come out baseline. A JPEG this route declines — CMYK or
YCCK, 12-bit, lossless, hierarchical, or a three-component file whose colour
transform is 0, where component 0 is red rather than luma — falls back to the
decode-and-re-encode route above and reports `route: 'jpeg'`. A decline is not
a `skipped` entry: the image converts either way, and `route` is what says how.
```

- [ ] **Step 4: Final gates**

Run: `npm run typecheck && npm test`
Expected: both green, 464+ test files.

- [ ] **Step 5: Commit, close the issue, push**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(10u9.6): coefficient-domain JPEG greying in CHANGELOG and README

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

bd close aspose-pdf-foss-for-ts-10u9.6 --reason "..."
bd export
git add .beads/interactions.jsonl && git commit -m "chore(10u9.6): sync beads export"

git pull --rebase && git push && git status -sb
bd dolt push && git ls-remote origin 'refs/dolt/*'
```

`bd dolt push` is not optional — tracker state does not reach the remote via `git push` in this repo.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: module layout → Tasks 2–5; eligibility and the transform trap → Tasks 3–4; the splice and MCU padding → Task 4; data flow and error handling → Task 5; the exactness/structural/padding/transform/decline tests → Tasks 4–5; the progressive fixture → Task 6; documentation → Task 7. The spec's "out of scope" list adds no tasks by construction.

**Type consistency.** `CoefFrame`/`CoefComponent` are defined in Task 2 and consumed in Task 4 with the same field names (`blocks`, `h`, `v`, `tq`, `td`, `quant`, `jfif`, `optimizeHuffman`). `TranscodeResult` is defined in Task 4 and destructured in Task 5 as `t.kind`/`t.data`/`t.width`/`t.height`. `decodeJpegFrame`'s return is `{ frame, qt, adobe }` in Task 3 and destructured that way in Tasks 4 and 6. `jpegTransform(frame, adobe)` takes two arguments everywhere.

**Two traps this plan deliberately puts a mutation step behind**, because each produces a file that still decodes: re-emitting the MCU padding (Task 4 Step 6.1) and confusing the two coefficient orderings (6.2, 6.3). A green suite after either mutation means the test is not pinning what it claims.
