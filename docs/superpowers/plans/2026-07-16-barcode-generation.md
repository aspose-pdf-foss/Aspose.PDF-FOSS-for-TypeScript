# Barcode Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pure-TS, zero-dependency barcode generators (Code128, EAN-13/UPC-A/EAN-8, QR) plus a `Page.AddBarcode` placement API that renders them as vector graphics or a 1-bit `/ImageMask` stencil.

**Architecture:** Pure generators (`barcode.ts` for 1D, `qr.ts` for QR) emit a symbology-agnostic module model; a placement layer (`barcodeplace.ts`) turns that model into page content, mirroring how `imageembed.ts` feeds `Page.AddImage`. `Page.AddBarcode` is a thin wrapper.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime deps beyond `node:` built-ins (none needed here).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension (e.g. `import { makeQr } from './qr.js'`).
- **`strict` TypeScript** — `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) must pass.
- **TDD** — write the failing test first; fixtures/helpers live in `test/helpers/`.
- **Public error types** — throw `TypeError` for bad argument shapes; `PdfParseError` (from `./errors.js`) for malformed payloads (bad check digit, over-capacity QR).
- **Full test suite** command: `npm test` (`vitest run`). Single file: `npx vitest run test/barcode.test.ts`.
- **Commit** after each task's tests are green.

## File Structure

- **Create `src/barcode.ts`** — the module-model types (`LinearBarcode`, `MatrixBarcode`, `BarcodeModel`), the 1D generators (`makeCode128`, `makeEan13`, `makeUpcA`, `makeEan8`), the Code128 and EAN encoding tables, and a re-export of `makeQr`.
- **Create `src/qr.ts`** — QR encoder: GF(256) arithmetic, Reed–Solomon, data encoding, matrix layout + masking, `encodeQr`/`makeQr`.
- **Create `src/barcodeplace.ts`** — `addBarcode(doc, page, spec, rect, opts)`: vector + `/ImageMask` rendering, HRI text, `BarcodeSpec`/`AddBarcodeOptions` types.
- **Modify `src/page.ts`** — add the `Page.AddBarcode` method + imports.
- **Modify `src/index.ts`** — export the generators, model types, and spec/option types.
- **Create `test/barcode.test.ts`** — all barcode tests.
- **Create `test/helpers/decode-barcode.ts`** — `decode128`, `decodeEan` (1D round-trip readers) and `readQrCodewords` (QR layout inverse).
- **Modify `README.md`** — add a "Barcodes" subsection.

---

## Task 1: Module model + Code128 generator

**Files:**
- Create: `src/barcode.ts`
- Create: `test/barcode.test.ts`
- Create: `test/helpers/decode-barcode.ts`

**Interfaces:**
- Produces:
  - `interface LinearBarcode { kind: 'linear'; modules: number[]; quietLeft: number; quietRight: number; text?: string; }` — `modules` are run-length widths in unit modules; `modules[0]` is a **bar** (dark), runs alternate bar/space. `quietLeft`/`quietRight` are recommended quiet-zone widths in modules.
  - `interface MatrixBarcode { kind: 'matrix'; size: number; dark: boolean[]; }` — `dark` is row-major, length `size*size`.
  - `type BarcodeModel = LinearBarcode | MatrixBarcode;`
  - `function makeCode128(data: string): LinearBarcode` — full Code128 (auto A/B/C), modulo-103 checksum, `quietLeft = quietRight = 10`, `text = data`.
  - `const CODE128_PATTERNS: readonly (readonly number[])[]` — 107 rows (values 0..106), each a 6-element bar/space width pattern (values 0..102 = data, 103/104/105 = Start A/B/C, 106 = Stop, which is 7 elements). Exported for the round-trip helper.
- Consumes: nothing (first task).

**Reference data:** The Code128 pattern table is objective reference data (ISO/IEC 15417, "Code 128 Bar/Space patterns"). Transcribe all 107 rows from the canonical table (e.g. the Wikipedia "Code 128" article's Bar/space patterns column, or the Code 128 spec). Each data value 0..102 maps to a 6-digit pattern like `212222` (bar-width, space-width, ...); Stop (106) is the 7-element `2331112`. The round-trip test below will catch any transcription error.

Code-set B character values: value `v` (0..94) encodes ASCII `32 + v` (space..`~`). Code C: value `v` (0..99) encodes the two-digit string `String(v).padStart(2,'0')`. Start B = 104, Start C = 105, Stop = 106. Checksum = `(start + Σ (i+1)*value_i) % 103` over data symbols (1-indexed positions), appended as a symbol before Stop.

Auto code-set algorithm (minimal viable optimal switching):
- Start in Code C if the data begins with ≥4 digits (or ≥2 digits that are the entire payload); else Start B.
- In Code C, consume digit pairs; switch to B (code 100) when fewer than 2 digits remain or a non-digit appears.
- In Code B, switch to C (code 99) when ≥4 digits appear consecutively (or ≥2 trailing digits ending the payload).
- Code A (control chars) is out of the common path; if any char < 32 appears, throw `PdfParseError('Code128: control characters (Code A) not supported')` for v1 — **note:** this narrows the "full ASCII 0–127 / A/B/C" spec goal to A-as-error. If Code A is required, extend here.

- [ ] **Step 1: Write the round-trip helper** (`test/helpers/decode-barcode.ts`)

```ts
import { CODE128_PATTERNS } from '../../src/barcode.js';

/** Reverse-lookup a 6-element pattern to its Code128 value (exact integer match). */
function patternValue(p: number[]): number {
  for (let v = 0; v < CODE128_PATTERNS.length; v++) {
    const row = CODE128_PATTERNS[v];
    if (row.length === p.length && row.every((w, i) => w === p[i])) return v;
  }
  return -1;
}

/** Decode a Code128 LinearBarcode's `modules` back to its payload string.
 *  Inverse of makeCode128; used only to prove the encoder round-trips. */
export function decode128(modules: number[]): string {
  // Symbols: [Start][data...][checksum][Stop]. Each is 6 elements except Stop (7).
  const syms: number[] = [];
  let i = 0;
  while (i < modules.length) {
    const len = i + 7 === modules.length ? 7 : 6; // final symbol is Stop (7 elements)
    syms.push(patternValue(modules.slice(i, i + len)));
    i += len;
  }
  const start = syms[0];              // 104 (B) or 105 (C)
  const values = syms.slice(1, -2);   // drop Start, checksum, Stop
  let setC = start === 105;
  let out = '';
  for (const v of values) {
    if (v === 99) { setC = true; continue; }
    if (v === 100) { setC = false; continue; }
    out += setC ? String(v).padStart(2, '0') : String.fromCharCode(32 + v);
  }
  return out;
}
```

- [ ] **Step 2: Write the failing test** (`test/barcode.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { makeCode128 } from '../src/barcode.js';
import { decode128 } from './helpers/decode-barcode.js';

describe('Code128', () => {
  it('round-trips an alphanumeric payload', () => {
    const bc = makeCode128('CODE128');
    expect(bc.kind).toBe('linear');
    expect(bc.modules[0]).toBeGreaterThan(0);   // starts with a bar
    expect(decode128(bc.modules)).toBe('CODE128');
  });

  it('round-trips a payload with a long digit run (auto Code C)', () => {
    expect(decode128(makeCode128('AB123456CD').modules)).toBe('AB123456CD');
  });

  it('round-trips a pure-digit payload', () => {
    expect(decode128(makeCode128('0123456789').modules)).toBe('0123456789');
  });

  it('rejects Code A control characters', () => {
    expect(() => makeCode128('A\tB')).toThrow(/Code A/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/barcode.test.ts`
Expected: FAIL — `makeCode128`/`CODE128_PATTERNS` not exported (module not found).

- [ ] **Step 4: Implement `src/barcode.ts`**

Write the model types, `CODE128_PATTERNS` (all 107 rows), the auto code-set encoder, checksum, and module assembly. Assembly: for each chosen symbol value push its pattern's element widths onto `modules` in order (they concatenate cleanly because every symbol starts with a bar and ends with a space, except Stop which ends with a bar). Set `quietLeft = quietRight = 10`, `text = data`. Include `PdfParseError` import from `./errors.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/barcode.test.ts`
Expected: PASS (4 tests). Also run `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/barcode.ts test/barcode.test.ts test/helpers/decode-barcode.ts
git commit -m "feat(66f): Code128 generator + module model"
```

---

## Task 2: EAN-13 / UPC-A / EAN-8 generators

**Files:**
- Modify: `src/barcode.ts`
- Modify: `test/barcode.test.ts`
- Modify: `test/helpers/decode-barcode.ts`

**Interfaces:**
- Consumes: `LinearBarcode` (Task 1).
- Produces:
  - `function makeEan13(digits: string): LinearBarcode` — accepts 12 or 13 digits; validates/computes the check digit; `quietLeft = 11`, `quietRight = 7`, `text` = full 13 digits.
  - `function makeUpcA(digits: string): LinearBarcode` — accepts 11 or 12 digits; encoded as EAN-13 with a leading `0`; `text` = 12 digits.
  - `function makeEan8(digits: string): LinearBarcode` — accepts 7 or 8 digits; `quietLeft = quietRight = 7`; `text` = 8 digits.
  - `const EAN_L: readonly string[]`, `EAN_G: readonly string[]`, `EAN_R: readonly string[]` — 10 entries each, 7-char `'0'/'1'` module strings per digit (exported for the helper). `EAN_PARITY: readonly string[]` — 10 entries, 6-char `'L'/'G'` patterns selecting left-half encoding by first digit.

**Reference data (ISO/IEC 15420):**
- L-code digit patterns (`EAN_L`), by digit 0..9: `0001101 0011001 0010011 0111101 0100011 0110001 0101111 0111011 0110111 0001011`.
- G-code (`EAN_G`) is the L-code reversed bit order: derive `EAN_G[d] = EAN_L[d].split('').reverse().join('')`.
- R-code (`EAN_R`) is the bitwise complement of L: `EAN_R[d] = EAN_L[d].replace(/./g, c => c === '0' ? '1' : '0')`.
- Left-half parity by first digit (`EAN_PARITY`), 0..9: `LLLLLL LLGLGG LLGGLG LLGGGL LGLLGG LGGLLG LGGGLL LGLGLG LGLGGL LGGLGL`.
- EAN-13 structure (95 modules): start guard `101`, six left digits (7 modules each, encoded L/G per `EAN_PARITY[firstDigit]`), center guard `01010`, six right digits (R-code), end guard `101`. The first of the 13 digits is *not* drawn as bars — it is encoded via the parity pattern.
- EAN-8 structure (67 modules): start `101`, four left digits (all L-code), center `01010`, four right digits (R-code), end `101`.
- Check digit: sum digits from the right with weights 3,1,3,1,...; check = `(10 - (sum % 10)) % 10`. For EAN-13 the weight-3 positions are the even indices counting from the right (excluding the check digit).

Convert the assembled `'0'/'1'` module string to `modules` run-lengths: the string always starts with `1` (bar), so group consecutive equal chars; push each run length. `modules[0]` is a bar. ✓

- [ ] **Step 1: Add the EAN decoder to the helper** (`test/helpers/decode-barcode.ts`)

```ts
import { EAN_L, EAN_G, EAN_R, EAN_PARITY } from '../../src/barcode.js';

/** Convert run-length `modules` (starting with a bar) back to a '0'/'1' string. */
function modulesToBits(modules: number[]): string {
  let s = '', bar = true;
  for (const w of modules) { s += (bar ? '1' : '0').repeat(w); bar = !bar; }
  return s;
}

const lFromBits = (b: string, table: readonly string[]) =>
  table.indexOf(b);

/** Decode an EAN-13 / EAN-8 modules array back to its digit string. */
export function decodeEan(modules: number[], kind: 'ean13' | 'ean8'): string {
  const bits = modulesToBits(modules);
  if (kind === 'ean8') {
    // 3 + 4*7 + 5 + 4*7 + 3
    let p = 3, out = '';
    for (let i = 0; i < 4; i++, p += 7) out += lFromBits(bits.slice(p, p + 7), EAN_L);
    p += 5;
    for (let i = 0; i < 4; i++, p += 7) out += lFromBits(bits.slice(p, p + 7), EAN_R);
    return out;
  }
  // EAN-13: recover parity pattern of the 6 left digits to get the first digit.
  let p = 3, parity = '', left = '';
  for (let i = 0; i < 6; i++, p += 7) {
    const chunk = bits.slice(p, p + 7);
    const l = EAN_L.indexOf(chunk);
    if (l >= 0) { parity += 'L'; left += l; }
    else { parity += 'G'; left += EAN_G.indexOf(chunk); }
  }
  const first = EAN_PARITY.indexOf(parity);
  p += 5;
  let right = '';
  for (let i = 0; i < 6; i++, p += 7) right += EAN_R.indexOf(bits.slice(p, p + 7));
  return `${first}${left}${right}`;
}
```

- [ ] **Step 2: Write the failing tests** (append to `test/barcode.test.ts`)

```ts
import { makeEan13, makeUpcA, makeEan8 } from '../src/barcode.js';
import { decodeEan } from './helpers/decode-barcode.js';

describe('EAN/UPC', () => {
  it('EAN-13 computes the check digit and round-trips', () => {
    const bc = makeEan13('590123412345');       // 12 digits -> check digit appended
    expect(bc.text).toBe('5901234123457');       // known check digit = 7
    expect(decodeEan(bc.modules, 'ean13')).toBe('5901234123457');
  });

  it('EAN-13 validates a supplied check digit', () => {
    expect(() => makeEan13('5901234123450')).toThrow(/check digit/i);
    expect(makeEan13('5901234123457').text).toBe('5901234123457');
  });

  it('UPC-A round-trips as zero-prefixed EAN-13', () => {
    const bc = makeUpcA('03600029145');          // 11 digits -> check appended
    expect(bc.text).toBe('036000291452');
    expect(decodeEan(bc.modules, 'ean13')).toBe('0036000291452');
  });

  it('EAN-8 round-trips', () => {
    const bc = makeEan8('9638507');
    expect(decodeEan(bc.modules, 'ean8')).toBe(bc.text);
  });

  it('rejects non-digit and wrong-length payloads', () => {
    expect(() => makeEan13('12345')).toThrow();
    expect(() => makeEan13('abcdefghijklm')).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/barcode.test.ts`
Expected: FAIL — `makeEan13` etc. not exported.

- [ ] **Step 4: Implement the EAN family in `src/barcode.ts`**

Add `EAN_L/EAN_G/EAN_R/EAN_PARITY`, the check-digit function, the three generators, and string→run-length conversion. Validate input with a `/^\d+$/` test and exact length checks; throw `PdfParseError` on bad check digit, `TypeError`/`PdfParseError` on bad length/charset (tests only require *some* throw).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/barcode.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/barcode.ts test/barcode.test.ts test/helpers/decode-barcode.ts
git commit -m "feat(66f): EAN-13/UPC-A/EAN-8 generators"
```

---

## Task 3: QR — GF(256) arithmetic + Reed–Solomon

**Files:**
- Create: `src/qr.ts`
- Modify: `test/barcode.test.ts`

**Interfaces:**
- Produces (all exported from `src/qr.ts`):
  - `function gfExp(e: number): number` — antilog in GF(256), primitive poly `0x11d`, generator 2; `e` taken mod 255.
  - `function gfMul(a: number, b: number): number` — GF multiply (`0` if either operand is 0).
  - `function rsGeneratorPoly(degree: number): number[]` — generator polynomial coefficients (GF values, length `degree+1`, leading coeff first).
  - `function rsEncode(data: number[], ecLen: number): number[]` — the `ecLen` Reed–Solomon EC codewords for `data` (polynomial division remainder).
- Consumes: nothing.

Build 256-entry `EXP`/`LOG` tables once at module load: `x = 1; for e in 0..255 { EXP[e] = x; LOG[x] = e; x <<= 1; if (x & 0x100) x ^= 0x11d; }`.

- [ ] **Step 1: Write the failing test** (append to `test/barcode.test.ts`)

```ts
import { gfExp, gfMul, rsGeneratorPoly, rsEncode } from '../src/qr.js';

describe('QR: GF(256) + Reed-Solomon', () => {
  it('field arithmetic basics', () => {
    expect(gfExp(0)).toBe(1);
    expect(gfExp(255)).toBe(1);            // wraps (order 255)
    expect(gfMul(0, 5)).toBe(0);
    expect(gfMul(1, 7)).toBe(7);
    expect(gfMul(gfExp(1), gfExp(1))).toBe(gfExp(2)); // 2*2 = 4
  });

  it('degree-10 generator polynomial matches the QR spec', () => {
    // Canonical alpha-exponents for the n=10 generator (ISO 18004 / Thonky table).
    const exps = [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
    expect(rsGeneratorPoly(10)).toEqual(exps.map((e) => gfExp(e)));
  });

  it('all-zero data yields all-zero EC', () => {
    expect(rsEncode(new Array(16).fill(0), 10)).toEqual(new Array(10).fill(0));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/barcode.test.ts`
Expected: FAIL — `src/qr.js` exports missing.

- [ ] **Step 3: Implement GF + RS in `src/qr.ts`**

Build `EXP`/`LOG`. `gfMul(a,b) = a && b ? EXP[(LOG[a]+LOG[b])%255] : 0`. `rsGeneratorPoly(n)`: start `[1]`, for `i in 0..n-1` multiply the polynomial by `(x - α^i)` i.e. `(x + gfExp(i))` in GF. `rsEncode(data, ecLen)`: polynomial division of `data` (followed by `ecLen` zeros) by `rsGeneratorPoly(ecLen)`, returning the length-`ecLen` remainder.

- [ ] **Step 4: Run tests** → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/qr.ts test/barcode.test.ts
git commit -m "feat(66f): QR GF(256) arithmetic + Reed-Solomon"
```

---

## Task 4: QR — data encoding (mode, version sizing, codewords)

**Files:**
- Modify: `src/qr.ts`
- Modify: `test/barcode.test.ts`

**Interfaces:**
- Consumes: `rsEncode` (Task 3).
- Produces (exported from `src/qr.ts`):
  - `type QrEcc = 'L' | 'M' | 'Q' | 'H';`
  - `interface QrOptions { ecc?: QrEcc; version?: number; }`
  - `function encodeQrData(data: string, version: number, ecc: QrEcc): number[]` — the **data codewords** (before EC), padded to the version+ecc data capacity with `0xEC, 0x11` alternating pad bytes.
  - `function chooseQrVersion(data: string, ecc: QrEcc): number` — smallest version (1..40) whose data capacity fits `data` in the auto-selected mode; throws `PdfParseError('QR: data too large')` if none.
  - `function qrMode(data: string): 'numeric' | 'alphanumeric' | 'byte'` — numeric if `/^\d+$/`, alphanumeric if every char is in the 45-char set `0-9 A-Z space $%*+-./:`, else byte.

Encoding details:
- Mode indicator: numeric `0001`, alphanumeric `0010`, byte `0100`.
- Character-count indicator bit widths (versions 1–9): numeric 10, alphanumeric 9, byte 8. (10–26: 12/11/16; 27–40: 14/13/16.)
- Numeric: groups of 3 digits → 10 bits (2 digits → 7, 1 digit → 4). Alphanumeric: pairs → value `45*a+b` in 11 bits (last lone char → 6 bits). Byte: UTF-8 bytes, 8 bits each.
- Data capacity (total codewords − EC codewords) per version/ECC comes from the ISO 18004 capacity table. For v1: total 26 codewords; EC-per-block = L:7, M:10, Q:13, H:17 → data codewords L:19, M:16, Q:13, H:9. Include the full 40×4 table (data-codeword counts and EC-codewords-per-block and block structure) transcribed from the spec — it is also needed in Task 5.
- After the bitstream: add up to 4 terminator `0` bits (fewer if capacity is reached), pad to a byte boundary with `0`s, then append `0xEC, 0x11` alternately to fill the data-codeword capacity.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { encodeQrData, qrMode, chooseQrVersion } from '../src/qr.js';

describe('QR: data encoding', () => {
  it('classifies modes', () => {
    expect(qrMode('01234567')).toBe('numeric');
    expect(qrMode('HELLO WORLD')).toBe('alphanumeric');
    expect(qrMode('https://a.co')).toBe('byte');
  });

  it('encodes the ISO example "01234567" (v1-M) to the known data codewords', () => {
    // ISO/IEC 18004 Annex worked example.
    expect(encodeQrData('01234567', 1, 'M')).toEqual(
      [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11],
    );
  });

  it('auto-sizes the version', () => {
    expect(chooseQrVersion('01234567', 'M')).toBe(1);
    expect(chooseQrVersion('x'.repeat(3000), 'H')).toBeGreaterThan(20);
    expect(() => chooseQrVersion('x'.repeat(100000), 'H')).toThrow(/too large/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (exports missing).

- [ ] **Step 3: Implement encoding in `src/qr.ts`**

Add the capacity/block table, `qrMode`, `chooseQrVersion`, and `encodeQrData` (bit accumulator → codeword bytes with terminator + pad). The `0x10,0x20,0x0c,...` fixture pins the whole bit-packing path.

- [ ] **Step 4: Run tests** → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/qr.ts test/barcode.test.ts
git commit -m "feat(66f): QR data encoding + version sizing"
```

---

## Task 5: QR — matrix layout, masking, `encodeQr`/`makeQr`

**Files:**
- Modify: `src/qr.ts`
- Modify: `test/barcode.test.ts`
- Modify: `test/helpers/decode-barcode.ts`

**Interfaces:**
- Consumes: `encodeQrData`, `rsEncode`, `chooseQrVersion` (Tasks 3–4); `MatrixBarcode` (Task 1, type-only import `import type { MatrixBarcode } from './barcode.js'`).
- Produces (exported from `src/qr.ts`):
  - `interface QrEncodeResult { matrix: MatrixBarcode; version: number; ecc: QrEcc; mask: number; codewords: number[]; reserved: boolean[]; }` — `codewords` is the final data+EC stream in placement order; `reserved[i]` is `true` where module `i` is a function/format/timing module (not data).
  - `function encodeQr(data: string, opts?: QrOptions): QrEncodeResult`.
  - `function makeQr(data: string, opts?: QrOptions): MatrixBarcode` — `= encodeQr(data, opts).matrix`.
  - `function qrMaskBit(mask: number, row: number, col: number): boolean` — the 8 standard mask predicates (exported for the read-back helper).

Layout steps (single-block for v1; general block interleave for v ≥ some threshold — implement full interleave per the block table so all versions work):
1. `size = 17 + 4*version`. Allocate `dark: boolean[]` and `reserved: boolean[]`.
2. Place function patterns (mark `reserved`): three 7×7 finder patterns + separators at top-left/top-right/bottom-left; alignment patterns per the version's center table (none for v1); timing patterns on row 6 and column 6; the dark module at `(row=4*version+9, col=8)`; reserve the format-info area (and version-info area for v ≥ 7).
3. Build codewords: split data codewords into blocks per the table, compute each block's EC via `rsEncode`, then interleave data codewords across blocks followed by interleaved EC codewords → `codewords`.
4. Place codeword bits in the zigzag (two columns at a time from the right, skipping column 6; upward then downward), into non-`reserved` modules, MSB first.
5. Try all 8 masks: apply mask to non-`reserved` modules, compute the penalty (four standard rules), keep the lowest; record `mask`.
6. Place format information (ECC level + mask) with its BCH(15,5) code into the reserved format area, for the chosen mask.

- [ ] **Step 1: Add the QR read-back helper** (`test/helpers/decode-barcode.ts`)

```ts
import { qrMaskBit } from '../../src/qr.js';
import type { MatrixBarcode } from '../../src/barcode.js';

/** Reverse mask + zigzag to recover the placed codeword stream.
 *  Inverse of encodeQr's placement — NOT a full decoder (no RS/format decode). */
export function readQrCodewords(
  matrix: MatrixBarcode, mask: number, reserved: boolean[],
): number[] {
  const n = matrix.size;
  const bits: number[] = [];
  let col = n - 1, upward = true;
  while (col > 0) {
    if (col === 6) col--;                        // skip vertical timing column
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        const idx = row * n + x;
        if (reserved[idx]) continue;
        let v = matrix.dark[idx] ? 1 : 0;
        if (qrMaskBit(mask, row, x)) v ^= 1;     // undo mask
        bits.push(v);
      }
    }
    col -= 2; upward = !upward;
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    out.push(b);
  }
  return out;
}
```

- [ ] **Step 2: Write the failing tests** (append to `test/barcode.test.ts`)

```ts
import { encodeQr, makeQr } from '../src/qr.js';
import { readQrCodewords } from './helpers/decode-barcode.js';

describe('QR: matrix', () => {
  it('builds a 21x21 v1 matrix with correct function patterns', () => {
    const r = encodeQr('01234567', { ecc: 'M' });
    expect(r.version).toBe(1);
    expect(r.matrix.size).toBe(21);
    const dark = (x: number, y: number) => r.matrix.dark[y * 21 + x];
    // top-left finder: dark border, dark 3x3 center, light ring
    expect(dark(0, 0)).toBe(true);
    expect(dark(1, 1)).toBe(false);
    expect(dark(3, 3)).toBe(true);
    // timing pattern alternates on row 6 / col 6
    for (let x = 8; x < 13; x++) expect(dark(x, 6)).toBe(x % 2 === 0);
    // dark module at (col 8, row 4*1+9 = 13)
    expect(dark(8, 13)).toBe(true);
  });

  it('placed codewords read back to data + EC (layout & mask inverse)', () => {
    const r = encodeQr('01234567', { ecc: 'M' });
    expect(readQrCodewords(r.matrix, r.mask, r.reserved)).toEqual(r.codewords);
    expect(r.codewords.length).toBe(26);          // v1: 16 data + 10 EC
  });

  it('makeQr auto-sizes larger payloads and stays square', () => {
    const m = makeQr('https://example.com/some/longer/path?q=1', { ecc: 'Q' });
    expect(m.kind).toBe('matrix');
    expect(m.dark.length).toBe(m.size * m.size);
    expect(m.size).toBeGreaterThanOrEqual(21);
  });
});
```

- [ ] **Step 3: Run to verify failure** → FAIL (`encodeQr`/`qrMaskBit` missing).

- [ ] **Step 4: Implement layout + masking in `src/qr.ts`**

Implement steps 1–6 above, `qrMaskBit`, penalty scoring, and format-info BCH. The read-back test deterministically validates zigzag placement + mask undo without any external golden.

- [ ] **Step 5: Run tests** → PASS. `npm run typecheck` → clean. Also run the whole suite `npm test` to confirm no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/qr.ts test/barcode.test.ts test/helpers/decode-barcode.ts
git commit -m "feat(66f): QR matrix layout, masking, makeQr"
```

---

## Task 6: Placement — `barcodeplace.ts` + `Page.AddBarcode`

**Files:**
- Create: `src/barcodeplace.ts`
- Modify: `src/page.ts`
- Modify: `src/index.ts`
- Modify: `test/barcode.test.ts`

**Interfaces:**
- Consumes: `makeCode128/makeEan13/makeUpcA/makeEan8` and `LinearBarcode`/`MatrixBarcode` (Tasks 1–2); `makeQr`, `QrEcc` (Tasks 4–5); from `./pagecontent.js`: `ensureOwnResources`, `ensureOwnSubdict`, `freshKey`, `appendContent`, `num`; from `./serialize.js`: `enc`; `Document`, `Page`, `name` (`./types.js`); `Layer` (`./ocg.js`); `StructElement` (`./struct.js`).
- Produces (exported from `src/barcodeplace.ts`):
  - `type BarcodeSpec = { type: 'code128'; data: string } | { type: 'ean13' | 'upca' | 'ean8'; data: string } | { type: 'qr'; data: string; ecc?: QrEcc; version?: number };`
  - `interface AddBarcodeOptions { render?: 'vector' | 'raster'; color?: [number, number, number]; quietZone?: boolean; text?: boolean; layer?: Layer; tag?: StructElement; }`
  - `function addBarcode(doc: Document, page: Page, spec: BarcodeSpec, rect: [number, number, number, number], opts?: AddBarcodeOptions): void`
- Produces (`src/page.ts`): `Page.AddBarcode(spec, rect, opts?)`.

Implementation notes:
- Resolve `spec` → `BarcodeModel` via the matching generator (`qr` passes `{ ecc, version }`).
- `color` default `[0, 0, 0]`; validate rect is 4 finite numbers (throw `TypeError`), like `addImage`.
- **Layout.** For a `LinearBarcode`: total width in modules `W = quietLeft + Σmodules + quietRight` (quiet zones included only when `quietZone !== false`, else 0). `textStrip = (text-enabled && model.text) ? 0.15*h : 0`. Bars occupy `[x, y+textStrip, w, h-textStrip]`. Module width `u = w / W`. Walk `modules`, tracking a cursor; for each **bar** run emit a filled rect of width `run*u` at the cursor; advance cursor by `run*u` for every run. Start cursor at `x + quietLeft*u`.
  For a `MatrixBarcode`: `Wq = size + (quietZone !== false ? 8 : 0)` (4-module quiet zone each side). `u = min(w, h) / Wq`; center the `Wq*u` square in `rect`. A module at `(mx, my)` (origin top-left) maps to PDF rect `x0 + (quiet+mx)*u, yTop - (quiet+my+1)*u` where `yTop` is the square's top edge; emit a rect for each dark module.
- **Vector render (default).** Build one content body: `q`, set fill color `r g b rg`, one `x y w h re` per dark rect, a single `f`, `Q`. Append via `appendContent(doc, page, enc(body))`.
- **Raster render.** Build a 1-bit `/ImageMask` XObject at module resolution:
  - Linear: image is `W` px wide, 1 px tall — each column dark per the module runs (include quiet columns as light).
  - Matrix: `Wq × Wq` px, dark modules set.
  - Pack rows MSB-first, each row padded to a byte boundary. Stream dict: `Type/XObject`, `Subtype/Image`, `Width`, `Height`, `BitsPerComponent 1`, `ImageMask true`, `Decode [1 0]` (so a set bit paints). Register under own `/Resources /XObject` with `freshKey(xobjs, 'Bc')` via `doc.allocObject`. Content: `q`, `r g b rg`, `cm` mapping the unit square to the bars/matrix rect (same rect math as vector, minus the quiet handling already baked into the pixel grid), `/<key> Do`, `Q`.
- **HRI text.** When `text` resolves on (default: on for `ean13/upca/ean8`, off for `code128`, ignored for `qr`) and `model.text` is set, call `page.AddText(model.text, x + 1, y + 2, { font: 'Helvetica', fontSize: Math.min(textStrip, 10), color })` centered under the bars (compute x via `page.MeasureText`). Keep it simple: left-aligned at `x` is acceptable for v1 if centering is awkward — but prefer centered using `MeasureText`.
- `opts.layer` → set `/OC` on the XObject (raster) or wrap the vector body in `/OC /<key> BDC … EMC` via `registerOcProperty`. `opts.tag` → wrap the drawing in a marked-content sequence via `allocContentMcid`/`wrapMarkedContent` (mirror `addImage`). For v1, wiring `layer`/`tag` through is optional polish — implement `layer` for parity with `AddImage`; `tag` may be deferred if time-boxed (note it in the issue if deferred).

`src/index.ts`: export `makeCode128, makeEan13, makeUpcA, makeEan8, makeQr`, types `LinearBarcode, MatrixBarcode, BarcodeModel, QrOptions, QrEcc, BarcodeSpec, AddBarcodeOptions`.

- [ ] **Step 1: Write the failing tests** (append to `test/barcode.test.ts`)

```ts
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js'; // existing single-page fixture

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('Page.AddBarcode', () => {
  it('places a vector Code128 and saves', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 700, 200, 60]);
    const content = decoded(page);
    expect(content).toContain(' re');            // rectangle ops emitted
    expect(content).toContain(' f');             // fill
    expect(Document.Open(doc.Save()).Pages.length).toBe(1); // re-opens cleanly
  });

  it('places a raster QR (ImageMask XObject)', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddBarcode({ type: 'qr', data: 'https://example.com', ecc: 'M' },
                    [50, 500, 120, 120], { render: 'raster' });
    const content = decoded(page);
    expect(content).toMatch(/\/Bc\d+ Do/);       // XObject draw op
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0]).toBeDefined();      // re-opens cleanly
  });

  it('validates rect and payload', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    expect(() => page.AddBarcode({ type: 'code128', data: 'X' }, [1, 2, 3] as any)).toThrow(TypeError);
    expect(() => page.AddBarcode({ type: 'ean13', data: 'nope' }, [0, 0, 10, 10])).toThrow();
  });
});
```

> `buildStampTarget` is the same single-page fixture the `AddText`/stamp tests use; `page.Contents` returns the concatenated content bytes. The raster assertion relies on the XObject `freshKey` prefix `Bc` from the implementation — keep them in sync.

- [ ] **Step 2: Run to verify failure** → FAIL (`AddBarcode` missing).

- [ ] **Step 3: Implement `src/barcodeplace.ts`**, add `Page.AddBarcode` + imports to `src/page.ts`, add exports to `src/index.ts`.

- [ ] **Step 4: Run tests** → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Run the full suite** — `npm test` → all green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/barcodeplace.ts src/page.ts src/index.ts test/barcode.test.ts
git commit -m "feat(66f): Page.AddBarcode vector + raster placement"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Barcodes" subsection** to the API overview covering: `page.AddBarcode(spec, rect, opts)`, the `BarcodeSpec` union (`code128`/`ean13`/`upca`/`ean8`/`qr`), `AddBarcodeOptions` (`render`, `color`, `quietZone`, `text`, `layer`), and the low-level exports `makeCode128`/`makeEan13`/`makeUpcA`/`makeEan8`/`makeQr` returning a `BarcodeModel`. Note limitations: generation only (no decoding), Code128 A/B/C with control-char (Code A) restriction if that narrowing was kept, QR versions 1–40 all ECC levels.

```markdown
### Barcodes

Generate 1D (Code128, EAN-13, UPC-A, EAN-8) and 2D (QR) barcodes and place them
on a page as crisp vector graphics (default) or a 1-bit image stencil:

    page.AddBarcode({ type: 'qr', data: 'https://example.com', ecc: 'M' },
                    [x, y, 120, 120]);
    page.AddBarcode({ type: 'ean13', data: '5901234123457' }, [x, y, 160, 70]);

Options: `render: 'vector' | 'raster'`, `color`, `quietZone`, `text` (human-readable
digits under 1D codes), `layer`. Low-level generators (`makeCode128`, `makeEan13`,
`makeUpcA`, `makeEan8`, `makeQr`) return a module model for custom placement.
Decoding/recognition is out of scope.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(66f): document Page.AddBarcode and barcode generators"
```

---

## Task 8: Close-out

- [ ] **Step 1:** Run `npm run typecheck` and `npm test` — both green.
- [ ] **Step 2:** `bd update aspose-pdf-foss-for-ts-66f --status closed` (or `bd close`) with a note summarizing the shipped API and the Code A narrowing (if kept).
- [ ] **Step 3:** Session-completion workflow (per CLAUDE.md): `git pull --rebase && git push`, confirm `git status` shows up-to-date.

---

## Self-Review Notes

- **Spec coverage:** Code128 (T1), EAN-13/UPC-A/EAN-8 (T2), QR byte+numeric+alnum all-ECC (T3–T5), `Page.AddBarcode` vector+raster placement at a rect (T6), HRI text (T6), known-vector fixtures — Code128/EAN via round-trip, QR data codewords + codeword read-back (T1/T2/T4/T5), README (T7). All spec sections mapped.
- **Known narrowing:** Code A (control chars) is treated as an error in v1 rather than fully encoded — flagged in T1 and README (T7). Raise with the user if full Code A is required.
- **Type consistency:** `LinearBarcode`/`MatrixBarcode`/`BarcodeModel` defined in T1 and reused throughout; `QrEcc`/`QrOptions` in T4; `QrEncodeResult.reserved`/`.mask`/`.codewords` consumed by the T5 read-back helper; `BarcodeSpec`/`AddBarcodeOptions` in T6 match the design spec.
