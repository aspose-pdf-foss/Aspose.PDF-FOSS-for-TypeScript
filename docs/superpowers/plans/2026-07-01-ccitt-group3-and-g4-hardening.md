# CCITT Group 3 Support + Group 4 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `src/ccitt.ts` to decode PDF CCITTFaxDecode Group 3 1D (`K==0`) and 2D (`K>0`) in addition to the existing Group 4 (`K<0`), and harden all paths against EOL/EOFB framing and malformed data.

**Architecture:** One `decodeCcitt` entry point drives a per-row loop. A framing step consumes optional EOL codes and detects EOFB. Per row, a dispatcher calls `decode1DRow` (modified-Huffman runs) or `decode2DRow` (the existing G4 P/H/V logic, extracted verbatim), selected by `K` (and, for `K>0`, a per-row tag bit). Row packing, `blackIs1`, and byte alignment stay shared in the outer loop.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies (`node:` built-ins only). Run-length/mode tables already exist in `src/ccitt-tables.ts`.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do NOT add npm runtime deps.
- ESM + NodeNext: all local import specifiers carry the `.js` extension.
- `strict` TypeScript. Run `npm run typecheck` and `npm test` green before closing.
- TDD: write the failing test first; land features with a fixture builder in `test/helpers/`.
- Do NOT modify `src/ccitt-tables.ts` — the tables are already complete.
- Bit strings are MSB-first. Output is packed 1-bpp rows, `rowBytes = (columns + 7) >> 3`, bit 0 = white unless `blackIs1`.
- Reference spec: `docs/superpowers/specs/2026-07-01-ccitt-group3-and-g4-hardening-design.md`.

---

## Task 1: Plumb EndOfLine / EndOfBlock params (no behavior change)

Add the two new params to the interface, the decoder call site, and the test helper. Keep the existing `K>=0` throw so the suite stays green.

**Files:**
- Modify: `src/ccitt.ts` (the `CcittParams` interface, ~lines 4-11)
- Modify: `src/image.ts` (the `decodeCcitt` call, ~lines 97-103)
- Modify: `test/ccitt.test.ts` (the `g4` helper, ~line 5)

**Interfaces:**
- Produces: `CcittParams` now has `endOfLine: boolean` and `endOfBlock: boolean` (both required).

- [ ] **Step 1: Add fields to `CcittParams`**

In `src/ccitt.ts`, replace the interface body:

```ts
export interface CcittParams {
  /** < 0: pure 2D (G4); 0: pure 1D (G3); > 0: mixed 1D/2D (G3 2D). */
  k: number;
  columns: number;
  rows: number;
  blackIs1: boolean;
  byteAlign: boolean;
  /** EOL codes present before lines (PDF EndOfLine; default false). Advisory:
   *  EOL codes are detected defensively whether or not this is set. */
  endOfLine: boolean;
  /** Honor EOFB (two EOLs) to stop decoding (PDF EndOfBlock; default true). */
  endOfBlock: boolean;
}
```

- [ ] **Step 2: Plumb params in `image.ts`**

In `src/image.ts`, update the `decodeCcitt` call to add the two fields:

```ts
      return decodeCcitt(bytes, {
        k: n('K', 0),
        columns: n('Columns', 1728),
        rows: n('Rows', this.Height),
        blackIs1: b('BlackIs1', false),
        byteAlign: b('EncodedByteAlign', false),
        endOfLine: b('EndOfLine', false),
        endOfBlock: b('EndOfBlock', true),
      });
```

- [ ] **Step 3: Update the `g4` test helper**

In `test/ccitt.test.ts`, update the helper so fixtures supply the new fields:

```ts
const g4 = (rows: number) =>
  ({ k: -1, columns: 8, rows, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true });
```

- [ ] **Step 4: Verify typecheck + existing tests pass**

Run: `npm run typecheck && npx vitest run test/ccitt.test.ts`
Expected: typecheck clean; all existing CCITT tests PASS (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/ccitt.ts src/image.ts test/ccitt.test.ts
git commit -m "feat(ccitt): plumb EndOfLine/EndOfBlock params (2qx)"
```

---

## Task 2: CCITT encoder test helper

Build a dependency-free encoder that mirrors the decoder, so round-trip tests can exercise makeup codes, all 2D modes, and framing. Anchor its correctness against the *existing* golden G4 byte vectors and a hand-computed 1D vector.

**Files:**
- Create: `test/helpers/ccitt-encode.ts`
- Test: `test/ccitt-encode.test.ts`

**Interfaces:**
- Consumes: `WHITE_CODES`, `BLACK_CODES`, `EXT_MAKEUP`, `MODE_CODES`, `findB1Index`-equivalent logic from `src/ccitt-tables.js`. (`findB1Index` is not exported; the encoder reimplements the same b1 rule locally.)
- Produces:
  - `type Bitmap = number[][]` — rows of 0 (white) / 1 (black) pixels, each row length === columns.
  - `encodeG4(bm: Bitmap, opts?: EncodeOpts): Uint8Array`
  - `encodeG3_1D(bm: Bitmap, opts?: EncodeOpts): Uint8Array`
  - `encodeG3_2D(bm: Bitmap, opts?: EncodeOpts): Uint8Array`
  - `interface EncodeOpts { byteAlign?: boolean; endOfLine?: boolean; eofb?: boolean }`

- [ ] **Step 1: Write the failing anchor tests**

Create `test/ccitt-encode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeG4, encodeG3_1D, type Bitmap } from './helpers/ccitt-encode.js';

const row = (bits: string): number[] => bits.split('').map((c) => (c === '1' ? 1 : 0));

describe('ccitt-encode helper', () => {
  it('encodeG4 reproduces the all-white 8x1 golden vector', () => {
    const bm: Bitmap = [row('00000000')];
    expect(Array.from(encodeG4(bm))).toEqual([0x80]);
  });

  it('encodeG4 reproduces the horizontal-mode 8x2 golden vector', () => {
    const bm: Bitmap = [row('11110000'), row('00001111')];
    expect(Array.from(encodeG4(bm))).toEqual([0x26, 0xae, 0x6d, 0x80]);
  });

  it('encodeG4 reproduces the V0+VR1 8x2 golden vector', () => {
    const bm: Bitmap = [row('11110000'), row('11111000')];
    expect(Array.from(encodeG4(bm))).toEqual([0x26, 0xaf, 0x70]);
  });

  it('encodeG3_1D encodes a uniform 8-white row as a single white-8 code (0x98)', () => {
    // white run 8 = terminating code '10011' -> padded '10011000' = 0x98
    const bm: Bitmap = [row('00000000')];
    expect(Array.from(encodeG3_1D(bm))).toEqual([0x98]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ccitt-encode.test.ts`
Expected: FAIL — cannot find module `./helpers/ccitt-encode.js`.

- [ ] **Step 3: Implement the encoder helper**

Create `test/helpers/ccitt-encode.ts`:

```ts
import { WHITE_CODES, BLACK_CODES, EXT_MAKEUP, MODE_CODES, type RunCode } from '../../src/ccitt-tables.js';

export type Bitmap = number[][];
export interface EncodeOpts { byteAlign?: boolean; endOfLine?: boolean; eofb?: boolean }

const EOL = '000000000001';

// run -> bits, split into terminating (<64) and makeup (>=64, incl. extended).
function buildEnc(codes: RunCode[]): { term: Map<number, string>; makeup: Map<number, string> } {
  const term = new Map<number, string>();
  const makeup = new Map<number, string>();
  for (const c of codes) (c.run < 64 ? term : makeup).set(c.run, c.bits);
  for (const c of EXT_MAKEUP) makeup.set(c.run, c.bits);
  return { term, makeup };
}
const WHITE_ENC = buildEnc(WHITE_CODES);
const BLACK_ENC = buildEnc(BLACK_CODES);

/** Encode one run length (>=0) for `color` (0=white,1=black) as makeup* + terminating. */
function encRun(len: number, color: number): string {
  const enc = color === 0 ? WHITE_ENC : BLACK_ENC;
  let n = len, bits = '';
  while (n >= 64) {
    const m = Math.min(Math.floor(n / 64) * 64, 2560); // largest multiple of 64 <= n, capped
    const code = enc.makeup.get(m);
    if (code === undefined) throw new Error(`ccitt-encode: no makeup code for ${m}`);
    bits += code;
    n -= m;
  }
  const t = enc.term.get(n);
  if (t === undefined) throw new Error(`ccitt-encode: no terminating code for ${n}`);
  return bits + t;
}

/** Changing elements of a pixel row: positions where colour flips, starting white. */
function changes(rowPixels: number[]): number[] {
  const out: number[] = [];
  let color = 0;
  for (let x = 0; x < rowPixels.length; x++) {
    if (rowPixels[x] !== color) { out.push(x); color = rowPixels[x]; }
  }
  return out;
}

/** First changing element strictly greater than x, or `columns` if none. */
function firstGt(list: number[], x: number, columns: number): number {
  for (const v of list) if (v > x) return v;
  return columns;
}

/** b1 index: first ref change strictly right of a0 with colour opposite to `color`. */
function b1Index(ref: number[], a0: number, color: number): number {
  let i = 0;
  while (i < ref.length && ref[i] <= a0) i++;
  const wantEven = color === 0;
  if (((i % 2) === 0) !== wantEven) i++;
  return i;
}

const V_CODE: Record<number, string> = {
  0: MODE_CODES.V0,
  1: MODE_CODES.VR1, 2: MODE_CODES.VR2, 3: MODE_CODES.VR3,
  [-1]: MODE_CODES.VL1, [-2]: MODE_CODES.VL2, [-3]: MODE_CODES.VL3,
};

/** Encode one 1D (modified-Huffman) row. */
function enc1DRow(rowPixels: number[], columns: number): string {
  const ch = changes(rowPixels);
  let bits = '', pos = 0, color = 0;
  for (const c of ch) { bits += encRun(c - pos, color); pos = c; color ^= 1; }
  bits += encRun(columns - pos, color); // final run to the row edge
  return bits;
}

/** Encode one 2D row against reference changing-elements `ref` (mirrors decode2DRow). */
function enc2DRow(rowPixels: number[], ref: number[], columns: number): string {
  const cur = changes(rowPixels);
  let bits = '', a0 = -1, color = 0;
  while (a0 < columns) {
    const a1 = firstGt(cur, a0, columns);
    const i = b1Index(ref, a0, color);
    const b1 = ref[i] ?? columns;
    const b2 = ref[i + 1] ?? columns;
    if (b2 < a1) { bits += MODE_CODES.P; a0 = b2; }               // pass
    else if (Math.abs(a1 - b1) <= 3) {                            // vertical
      bits += V_CODE[a1 - b1]; a0 = a1; color ^= 1;
    } else {                                                      // horizontal
      const a2 = firstGt(cur, a1, columns);
      const start = a0 < 0 ? 0 : a0;
      bits += MODE_CODES.H + encRun(a1 - start, color) + encRun(a2 - a1, color ^ 1);
      a0 = a2;
    }
  }
  return bits;
}

function bitsToBytes(bits: string): Uint8Array {
  const pad = (8 - (bits.length % 8)) % 8;
  const padded = bits + '0'.repeat(pad);
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
}

type RowEncoder = (rowPixels: number[], ref: number[], columns: number) => { bits: string; tag?: string };

function assemble(bm: Bitmap, rowEnc: RowEncoder, opts: EncodeOpts): Uint8Array {
  const columns = bm.length ? bm[0].length : 0;
  let bits = '';
  let ref: number[] = [];
  for (const rowPixels of bm) {
    if (opts.endOfLine) bits += EOL;
    const { bits: rowBits, tag } = rowEnc(rowPixels, ref, columns);
    if (tag !== undefined) bits += tag;
    bits += rowBits;
    ref = changes(rowPixels);
    if (opts.byteAlign && bits.length % 8) bits += '0'.repeat(8 - (bits.length % 8));
  }
  if (opts.eofb) bits += EOL + EOL;
  return bitsToBytes(bits);
}

export function encodeG4(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  return assemble(bm, (r, ref, cols) => ({ bits: enc2DRow(r, ref, cols) }), opts);
}

export function encodeG3_1D(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  return assemble(bm, (r, _ref, cols) => ({ bits: enc1DRow(r, cols) }), opts);
}

/** G3 2D: first row 1D (tag 1), remaining rows 2D (tag 0). */
export function encodeG3_2D(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  let first = true;
  return assemble(bm, (r, ref, cols) => {
    if (first) { first = false; return { bits: enc1DRow(r, cols), tag: '1' }; }
    return { bits: enc2DRow(r, ref, cols), tag: '0' };
  }, opts);
}
```

- [ ] **Step 4: Run to verify anchor tests pass**

Run: `npx vitest run test/ccitt-encode.test.ts`
Expected: PASS — all four anchor vectors match. (If G4 vectors mismatch, the encoder's mode-decision order is wrong; fix `enc2DRow` before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add test/helpers/ccitt-encode.ts test/ccitt-encode.test.ts
git commit -m "test(ccitt): dependency-free CCITT encoder helper (2qx)"
```

---

## Task 3: Extract `decode2DRow`, add framing, harden G4 (EOFB tolerance)

Refactor the existing G4 inner loop into `decode2DRow`, add `BitReader.tell/seek` + a `tryEol` framing helper, and route the outer loop through framing. Keep the `K>=0` throw for now. This delivers G4 EOFB/RTC tolerance.

**Files:**
- Modify: `src/ccitt.ts`
- Test: `test/ccitt.test.ts`

**Interfaces:**
- Produces (module-internal):
  - `decode2DRow(br: BitReader, ref: number[], columns: number): number[]`
  - `tryEol(br: BitReader): boolean`
  - `BitReader.tell(): number`, `BitReader.seek(p: number): void`

- [ ] **Step 1: Write the failing G4-with-EOFB test**

Add to `test/ccitt.test.ts`:

```ts
import { encodeG4 } from './helpers/ccitt-encode.js';

describe('decodeCcitt (Group 4) hardening', () => {
  it('tolerates a trailing EOFB when rows is unknown (rows<=0)', () => {
    const bm = [[1,1,1,1,0,0,0,0], [0,0,0,0,1,1,1,1]];
    const data = encodeG4(bm, { eofb: true });
    const out = decodeCcitt(data, { k: -1, columns: 8, rows: 0, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true });
    expect(Array.from(out)).toEqual([0b11110000, 0b00001111]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ccitt.test.ts -t "trailing EOFB"`
Expected: FAIL — with `rows: 0` the current loop runs until a bad code and throws `PdfParseError` on the EOFB bits.

- [ ] **Step 3: Add BitReader tell/seek**

In `src/ccitt.ts`, add to the `BitReader` class (after `eof()`):

```ts
  tell(): number { return this.pos; }
  seek(p: number): void { this.pos = p; }
```

- [ ] **Step 4: Add `tryEol` and extract `decode2DRow`**

In `src/ccitt.ts`, add after `findB1Index`:

```ts
/** Consume an EOL code (>=11 zero fill bits then a 1) if present; otherwise
 *  restore position and return false. Any real run/mode code has <11 leading
 *  zeros, so >=11 zeros followed by 1 is unambiguously an EOL. */
function tryEol(br: BitReader): boolean {
  const start = br.tell();
  let zeros = 0;
  for (;;) {
    const b = br.bit();
    if (b < 0) { br.seek(start); return false; }
    if (b === 0) { zeros++; continue; }
    if (zeros >= 11) return true;
    br.seek(start);
    return false;
  }
}

/** Decode one 2D row (T.6 / G3-2D) against reference changing-elements `ref`
 *  into current-line changing-element positions. */
function decode2DRow(br: BitReader, ref: number[], columns: number): number[] {
  const cur: number[] = [];
  let a0 = -1;
  let color = 0; // 0 = white, 1 = black
  while (a0 < columns) {
    const i = findB1Index(ref, a0, color);
    const b1 = ref[i] ?? columns;
    const b2 = ref[i + 1] ?? columns;
    const mode = readMode(br);
    if (mode === 'P') {
      a0 = b2;
    } else if (mode === 'H') {
      const start = a0 < 0 ? 0 : a0;
      const r1 = readRun(br, color === 0 ? WHITE : BLACK);
      const r2 = readRun(br, color === 0 ? BLACK : WHITE);
      const a1 = Math.min(start + r1, columns);
      const a2 = Math.min(a1 + r2, columns);
      cur.push(a1, a2);
      a0 = a2;
    } else {
      const a1 = Math.max(0, Math.min(b1 + mode, columns));
      cur.push(a1);
      a0 = a1;
      color ^= 1;
    }
  }
  return cur;
}
```

- [ ] **Step 5: Rewrite `decodeCcitt` to use framing + `decode2DRow`**

Replace the body of `decodeCcitt` (keep the `K>=0` guard for now):

```ts
export function decodeCcitt(data: Uint8Array, p: CcittParams): Uint8Array {
  if (p.k >= 0) throw new UnsupportedFeatureError('CCITT: only Group 4 (K<0) is supported');
  const { columns, blackIs1, byteAlign, endOfBlock } = p;
  const rowBytes = (columns + 7) >> 3;
  const out: Uint8Array[] = [];
  const br = new BitReader(data);

  let ref: number[] = []; // reference line changing elements (initial line: all white)
  const maxRows = p.rows > 0 ? p.rows : Number.MAX_SAFE_INTEGER;

  for (let y = 0; y < maxRows; y++) {
    if (br.eof()) break;
    const eol = tryEol(br);
    if (eol && endOfBlock && tryEol(br)) break; // EOFB / RTC -> end of block
    if (br.eof()) break;

    const cur = decode2DRow(br, ref, columns);

    const row = new Uint8Array(rowBytes);
    let pos = 0, col = 0;
    for (const change of [...cur, columns]) {
      if (col === 1) {
        for (let x = pos; x < change && x < columns; x++) row[x >> 3] |= 0x80 >> (x & 7);
      }
      pos = change;
      col ^= 1;
    }
    if (blackIs1) for (let b = 0; b < rowBytes; b++) row[b] ^= 0xff;
    out.push(row);

    ref = cur;
    if (byteAlign) br.alignToByte();
  }

  const merged = new Uint8Array(out.length * rowBytes);
  out.forEach((r, idx) => merged.set(r, idx * rowBytes));
  return merged;
}
```

- [ ] **Step 6: Run the full CCITT suite**

Run: `npx vitest run test/ccitt.test.ts && npm run typecheck`
Expected: PASS — existing golden vectors still decode, new EOFB test passes, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/ccitt.ts test/ccitt.test.ts
git commit -m "feat(ccitt): extract decode2DRow, add EOL/EOFB framing, harden G4 (2qx)"
```

---

## Task 4: Group 3 1D decode (K==0)

Add `decode1DRow`, dispatch on `K`, and remove the `K>=0` throw. Cover makeup/extended-makeup runs, byte alignment, EOL codes, EOFB, and `blackIs1`.

**Files:**
- Modify: `src/ccitt.ts`
- Test: `test/ccitt.test.ts`

**Interfaces:**
- Consumes: `decode2DRow`, `tryEol` (Task 3).
- Produces (module-internal): `decode1DRow(br: BitReader, columns: number): number[]`.

- [ ] **Step 1: Write the failing G3-1D tests**

Add to `test/ccitt.test.ts`:

```ts
import { encodeG3_1D } from './helpers/ccitt-encode.js';

const params = (over: Partial<Parameters<typeof decodeCcitt>[1]> & { columns: number; rows: number }) =>
  ({ k: 0, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true, ...over });

// Build a bitmap from row strings of '0'/'1'.
const bm = (...rows: string[]): number[][] =>
  rows.map((r) => r.split('').map((c) => (c === '1' ? 1 : 0)));

// Pack the same bitmap directly to compare against the decoder output.
const packed = (rows: string[]): number[] => {
  const cols = rows[0].length, rb = (cols + 7) >> 3, out: number[] = [];
  for (const r of rows) {
    const bytes = new Array(rb).fill(0);
    for (let x = 0; x < cols; x++) if (r[x] === '1') bytes[x >> 3] |= 0x80 >> (x & 7);
    out.push(...bytes);
  }
  return out;
};

describe('decodeCcitt (Group 3 1D, K=0)', () => {
  it('decodes a mixed 8-wide row', () => {
    const rows = ['11110000'];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 8, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes runs >= 64 (makeup codes) across a 200-wide row', () => {
    const rows = ['0'.repeat(100) + '1'.repeat(100)];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 200, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes extended makeup (runs >= 1792) across a 2000-wide row', () => {
    const rows = ['1'.repeat(2000)];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 2000, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors EncodedByteAlign across rows', () => {
    const rows = ['11110000', '10101010', '00001111'];
    const data = encodeG3_1D(bm(...rows), { byteAlign: true });
    const out = decodeCcitt(data, params({ columns: 8, rows: 3, byteAlign: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes with EndOfLine codes and a trailing EOFB', () => {
    const rows = ['11110000', '00110011'];
    const data = encodeG3_1D(bm(...rows), { endOfLine: true, eofb: true });
    const out = decodeCcitt(data, params({ columns: 8, rows: 0, endOfLine: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors blackIs1 (inverts output)', () => {
    const rows = ['11110000'];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 8, rows: 1, blackIs1: true }));
    const inv = packed(rows).map((byte) => byte ^ 0xff);
    expect(Array.from(out)).toEqual(inv);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/ccitt.test.ts -t "Group 3 1D"`
Expected: FAIL — `decodeCcitt` throws `UnsupportedFeatureError` for `k: 0`.

- [ ] **Step 3: Add `decode1DRow`**

In `src/ccitt.ts`, add after `decode2DRow`:

```ts
/** Decode one Group 3 1D (modified-Huffman) row into changing-element positions.
 *  Runs alternate white, black, ... starting white, until the row fills `columns`. */
function decode1DRow(br: BitReader, columns: number): number[] {
  const cur: number[] = [];
  let pos = 0;
  let color = 0; // 0 = white
  while (pos < columns) {
    const run = readRun(br, color === 0 ? WHITE : BLACK);
    pos = Math.min(pos + run, columns);
    cur.push(pos);
    color ^= 1;
    if (cur.length > columns + 2) throw new PdfParseError('CCITT: 1D row overrun');
  }
  return cur;
}
```

- [ ] **Step 4: Dispatch on K and drop the throw**

In `src/ccitt.ts`, remove the first line of `decodeCcitt`:

```ts
  if (p.k >= 0) throw new UnsupportedFeatureError('CCITT: only Group 4 (K<0) is supported');
```

Change the destructure to include `k`:

```ts
  const { k, columns, blackIs1, byteAlign, endOfBlock } = p;
```

Replace the row-decode line `const cur = decode2DRow(br, ref, columns);` with:

```ts
    const cur = k < 0 ? decode2DRow(br, ref, columns) : decode1DRow(br, columns);
```

Then remove the now-unused `UnsupportedFeatureError` from the import on line 1:

```ts
import { PdfParseError } from './errors.js';
```

- [ ] **Step 5: Fix the stale "throws for G3" test**

In `test/ccitt.test.ts`, delete the `it('throws for G3 (k >= 0)', ...)` test and the now-unused `import { UnsupportedFeatureError } from '../src/errors.js';` line.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/ccitt.test.ts && npm run typecheck`
Expected: PASS — all G3-1D tests pass, G4 tests still pass, typecheck clean (no unused import).

- [ ] **Step 7: Commit**

```bash
git add src/ccitt.ts test/ccitt.test.ts
git commit -m "feat(ccitt): Group 3 1D (K=0) decode (2qx)"
```

---

## Task 5: Group 3 2D (K>0), mode coverage, termination guard, docs

Add the per-row tag-bit dispatch for `K>0`, add round-trip tests that exercise pass/VR2/VR3/VL2/VL3, add a malformed-data termination-guard test, update the README, and close the issue.

**Files:**
- Modify: `src/ccitt.ts`
- Test: `test/ccitt.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `decode1DRow`, `decode2DRow`, `tryEol` (Tasks 3-4).

- [ ] **Step 1: Write the failing G3-2D + mode-coverage + guard tests**

Add to `test/ccitt.test.ts`:

```ts
import { encodeG3_2D } from './helpers/ccitt-encode.js';

describe('decodeCcitt (Group 3 2D, K>0)', () => {
  it('decodes mixed 1D/2D lines (first row 1D, rest 2D)', () => {
    const rows = ['11110000', '11100000', '00011111'];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 8, rows: 3 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('round-trips a pattern that forces pass mode (region vanishes between rows)', () => {
    // row0 has an isolated black block; row1 is all white -> b2 < a1 => pass.
    const rows = ['00111100', '00000000'];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 8, rows: 2 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('round-trips edges shifted by 2 and 3 px (VR2/VR3/VL2/VL3) over a 16-wide image', () => {
    const rows = [
      '0000111111110000',
      '0000001111000000', // both edges pulled in by 2 -> VR2 / VL2
      '0000000110000000', // pulled in by 3 more -> VR3 / VL3 region
    ];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 16, rows: 3 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors byteAlign, EndOfLine and EOFB together for K>0', () => {
    const rows = ['1100110011001100', '0011001100110011'];
    const data = encodeG3_2D(bm(...rows), { byteAlign: true, endOfLine: true, eofb: true });
    const out = decodeCcitt(data, params({ k: 2, columns: 16, rows: 0, byteAlign: true, endOfLine: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });
});

describe('decodeCcitt termination guard', () => {
  it('throws PdfParseError on a truncated 1D row rather than looping forever', () => {
    // A single white-8 code then EOF, but we ask for a 64-wide row: run cannot complete.
    const data = encodeG3_1D(bm('00000000')); // only 8 px of a claimed 64-wide row
    expect(() => decodeCcitt(data, params({ columns: 64, rows: 1 })))
      .toThrow(/CCITT/);
  });
});
```

- [ ] **Step 2: Run to verify the G3-2D tests fail**

Run: `npx vitest run test/ccitt.test.ts -t "Group 3 2D"`
Expected: FAIL — `K>0` currently routes to `decode1DRow` for every row (from Task 4), so 2D lines misdecode / throw.

- [ ] **Step 3: Add the K>0 tag-bit dispatch**

In `src/ccitt.ts`, replace the row-decode line:

```ts
    const cur = k < 0 ? decode2DRow(br, ref, columns) : decode1DRow(br, columns);
```

with:

```ts
    let cur: number[];
    if (k < 0) {
      cur = decode2DRow(br, ref, columns);
    } else if (k === 0) {
      cur = decode1DRow(br, columns);
    } else {
      // G3 2D: a 1-bit tag selects 1D (1) or 2D (0) coding for this line.
      cur = br.bit() === 1 ? decode1DRow(br, columns) : decode2DRow(br, ref, columns);
    }
```

(The `const cur = ...` is now a `let cur: number[]`; the later `ref = cur;` is unchanged.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/ccitt.test.ts && npm run typecheck`
Expected: PASS — G3-2D, mode-coverage, guard, and all prior tests pass; typecheck clean.

- [ ] **Step 5: Run the FULL suite**

Run: `npm test`
Expected: PASS — the whole vitest suite is green (confirms no regression in `image.ts` consumers).

- [ ] **Step 6: Update README**

In `README.md`, find the CCITT / image-decoding mention (search for `CCITT`). Update the limitation/feature wording so it states that CCITTFaxDecode Group 3 (1D and 2D) and Group 4 are supported, with `BlackIs1`, `EncodedByteAlign`, `EndOfLine`, and `EndOfBlock`; JBIG2 and JPX remain unsupported. If no CCITT line exists in the Limitations/Features sections, add one consistent with the surrounding bullet style.

- [ ] **Step 7: Commit**

```bash
git add src/ccitt.ts test/ccitt.test.ts README.md
git commit -m "feat(ccitt): Group 3 2D (K>0) decode + mode/guard coverage + docs (2qx)"
```

- [ ] **Step 8: Close the issue**

Run: `bd close aspose-pdf-foss-for-ts-2qx`

---

## Self-Review Notes

- **Spec coverage:** G3-1D (Task 4), G3-2D (Task 5), G4 hardening/EOFB (Task 3), EndOfLine/EndOfBlock plumb (Task 1), encoder-based corpus incl. makeup/pass/VL-VR2-3/EOL/EOFB (Tasks 2/4/5). All spec sections mapped.
- **Type consistency:** `decode1DRow(br, columns)`, `decode2DRow(br, ref, columns)`, `tryEol(br)`, `BitReader.tell/seek`, and encoder exports `encodeG4/encodeG3_1D/encodeG3_2D` + `Bitmap`/`EncodeOpts` are named identically wherever referenced.
- **EndOfLine note:** By design it is advisory — the decoder detects EOL defensively via `tryEol` whether or not the flag is set (matches the approved spec). It is still plumbed through `image.ts` and carried on `CcittParams`.
