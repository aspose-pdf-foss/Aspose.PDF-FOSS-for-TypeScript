# Save-time Filter Encoders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four missing byte-filter encoders (`ASCII85Decode`, `ASCIIHexDecode`, `LZWDecode`, `RunLengthDecode`) as exact inverses of the existing decoders, plus an `encodeStream` helper that builds a `PdfStream` carrying the chosen `/Filter`.

**Architecture:** Each encoder lives beside its decoder (`src/ascii.ts`, `src/lzw.ts`). A dispatch `encodeFilter(name, bytes)` and an `encodeStream(bytes, filter, extraDict?)` helper join the decode dispatch in `src/filters.ts`. Encoders and helper are exported from `src/index.ts`. The document-wide `Save({ streamFilter })` re-encode pass is deliberately out of scope (follow-up issue `aspose-pdf-foss-for-ts-3jf`).

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only — `node:zlib` `deflateSync` for Flate).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- Encoders are pure functions over `Uint8Array` and never throw on byte input (they encode arbitrary bytes, including empty input).
- Each encoder is the exact inverse of its decoder: `decode(encode(x))` deep-equals `x` for all `x`.
- `encodeFilter` throws `UnsupportedFeatureError` for unknown/unsupported filter names, matching `decodeOne`.
- Run `npm run typecheck` and `npm test` green before closing the issue.
- Keep `README.md` in sync with the public API changes.

---

### Task 1: RunLength + ASCIIHex encoders

**Files:**
- Modify: `src/ascii.ts` (append `runLengthEncode` and `asciiHexEncode`)
- Test: `test/filter-encode.test.ts` (create)

**Interfaces:**
- Consumes: nothing (pure functions). The existing `runLengthDecode` and `asciiHexDecode` in `src/ascii.ts` are used by the tests to prove round-trips.
- Produces:
  - `export function runLengthEncode(input: Uint8Array): Uint8Array`
  - `export function asciiHexEncode(input: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `test/filter-encode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ascii85Decode, asciiHexDecode, runLengthDecode,
  runLengthEncode, asciiHexEncode,
} from '../src/ascii.js';

/** Representative edge-case buffers reused across every round-trip test. */
function corpus(): Uint8Array[] {
  const ramp = new Uint8Array(256);
  for (let i = 0; i < 256; i++) ramp[i] = i;
  const zeros = new Uint8Array(64);
  const longRun = new Uint8Array(5000).fill(0x41);
  // Mixed runs and literals: "AAABCDDDD...".
  const mixed = Uint8Array.from([65, 65, 65, 66, 67, 68, 68, 68, 68, 69, 70, 71, 71]);
  // Deterministic pseudo-random binary.
  const rnd = new Uint8Array(1000);
  let s = 0x12345678;
  for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rnd[i] = s & 0xff; }
  return [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248]),
    zeros, ramp, longRun, mixed, rnd,
  ];
}

describe('runLengthEncode', () => {
  it('round-trips every corpus buffer through runLengthDecode', () => {
    for (const x of corpus()) {
      expect(runLengthDecode(runLengthEncode(x))).toEqual(x);
    }
  });

  it('compresses a long identical run and ends with the EOD byte 128', () => {
    const enc = runLengthEncode(new Uint8Array(1000).fill(0x7f));
    expect(enc.length).toBeLessThan(40);        // 1000 bytes -> a handful of run codes
    expect(enc[enc.length - 1]).toBe(128);      // EOD marker
  });
});

describe('asciiHexEncode', () => {
  it('round-trips every corpus buffer through asciiHexDecode', () => {
    for (const x of corpus()) {
      expect(asciiHexDecode(asciiHexEncode(x))).toEqual(x);
    }
  });

  it('emits uppercase hex pairs terminated by >', () => {
    const enc = asciiHexEncode(Uint8Array.from([0x0a, 0xff]));
    expect(new TextDecoder().decode(enc)).toBe('0AFF>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/filter-encode.test.ts`
Expected: FAIL — `runLengthEncode` / `asciiHexEncode` are not exported.

- [ ] **Step 3: Implement the encoders**

Append to `src/ascii.ts`:

```ts
const HEX = '0123456789ABCDEF';

/** ASCIIHexEncode: each byte -> two uppercase hex digits, terminated by '>'. */
export function asciiHexEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length * 2 + 1);
  let j = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    out[j++] = HEX.charCodeAt(b >> 4);
    out[j++] = HEX.charCodeAt(b & 0x0f);
  }
  out[j] = 0x3e; // '>'
  return out;
}

/** RunLengthEncode (PackBits): the inverse of runLengthDecode. A run of 2..128
 *  identical bytes -> (257-n, byte); a literal span of 1..128 bytes ->
 *  (n-1, bytes...); terminated by the EOD byte 128. Runs of length 2 are encoded
 *  as runs. */
export function runLengthEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    // Length of the identical-byte run starting at i, capped at 128.
    let runLen = 1;
    while (i + runLen < n && input[i + runLen] === input[i] && runLen < 128) runLen++;
    if (runLen >= 2) {
      out.push(257 - runLen, input[i]);
      i += runLen;
    } else {
      // Accumulate literals until a >=2 run begins or 128 is reached.
      const start = i;
      let litLen = 0;
      while (i < n && litLen < 128) {
        if (i + 1 < n && input[i + 1] === input[i]) break; // defer to run encoding
        i++; litLen++;
      }
      out.push(litLen - 1);
      for (let k = start; k < start + litLen; k++) out.push(input[k]);
    }
  }
  out.push(128); // EOD
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/filter-encode.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/ascii.ts test/filter-encode.test.ts
git commit -m "feat(ox6): RunLength + ASCIIHex encoders"
```

---

### Task 2: ASCII85 encoder

**Files:**
- Modify: `src/ascii.ts` (append `ascii85Encode`)
- Test: `test/filter-encode.test.ts` (add a describe block; `ascii85Decode` is already imported)

**Interfaces:**
- Consumes: `ascii85Decode` (existing, `src/ascii.ts`) in the test.
- Produces: `export function ascii85Encode(input: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing test**

Add to `test/filter-encode.test.ts` (extend the import from `../src/ascii.js` with `ascii85Encode`):

```ts
describe('ascii85Encode', () => {
  it('round-trips every corpus buffer through ascii85Decode', () => {
    for (const x of corpus()) {
      expect(ascii85Decode(ascii85Encode(x))).toEqual(x);
    }
  });

  it('uses the z shorthand for an all-zero group and ends with ~>', () => {
    const enc = new TextDecoder().decode(ascii85Encode(new Uint8Array(4)));
    expect(enc).toBe('z~>');
  });

  it('emits n+1 chars for an n-byte partial final group', () => {
    // One trailing byte -> a 2-char group before ~>.
    const enc = new TextDecoder().decode(ascii85Encode(Uint8Array.from([0x00])));
    expect(enc.endsWith('~>')).toBe(true);
    expect(enc.length - 2).toBe(2); // 2 chars for the 1-byte group
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/filter-encode.test.ts -t ascii85Encode`
Expected: FAIL — `ascii85Encode` is not exported.

- [ ] **Step 3: Implement the encoder**

Append to `src/ascii.ts`:

```ts
/** ASCII85Encode: 4 bytes -> 5 base-85 chars in 0x21..0x75; an all-zero 4-byte
 *  group emits 'z'; a partial final group of k bytes (1..3) emits k+1 chars
 *  (pad the group with zero bytes, drop the trailing chars). Terminated by '~>'.
 *  No '<~' prefix and no line wrapping. Inverse of ascii85Decode. */
export function ascii85Encode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = input.length;
  const group = (b0: number, b1: number, b2: number, b3: number, count: number) => {
    let val = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    const c = [0, 0, 0, 0, 0];
    for (let k = 4; k >= 0; k--) { c[k] = val % 85; val = Math.floor(val / 85); }
    for (let k = 0; k < count; k++) out.push(c[k] + 0x21);
  };
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    if (input[i] === 0 && input[i + 1] === 0 && input[i + 2] === 0 && input[i + 3] === 0) {
      out.push(0x7a); // 'z'
    } else {
      group(input[i], input[i + 1], input[i + 2], input[i + 3], 5);
    }
  }
  const rem = n - i;
  if (rem > 0) {
    // Partial final group: pad missing bytes with 0, emit rem+1 chars (never 'z').
    group(input[i], rem > 1 ? input[i + 1] : 0, rem > 2 ? input[i + 2] : 0, 0, rem + 1);
  }
  out.push(0x7e, 0x3e); // '~>'
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/filter-encode.test.ts -t ascii85Encode`
Expected: PASS (all three `it` blocks). Then run the whole file: `npx vitest run test/filter-encode.test.ts` — still green.

- [ ] **Step 5: Commit**

```bash
git add src/ascii.ts test/filter-encode.test.ts
git commit -m "feat(ox6): ASCII85 encoder"
```

---

### Task 3: LZW encoder

**Files:**
- Modify: `src/lzw.ts` (append `lzwEncode`)
- Test: `test/filter-encode.test.ts` (add a describe block; import `lzwDecode`/`lzwEncode` from `../src/lzw.js`)

**Interfaces:**
- Consumes: `lzwDecode` (existing, `src/lzw.ts`) in the test.
- Produces: `export function lzwEncode(input: Uint8Array, earlyChange?: number): Uint8Array`

**Notes for the implementer:** LZW is the fiddly one. The width-bump and table-full points must mirror `lzwDecode` exactly, and `earlyChange = 1` (the PDF default and the value the decoder uses) is what makes encoder and decoder agree on code widths across the 9→10→11→12-bit boundaries. The round-trip test with buffers that cross those boundaries is the correctness gate — if it fails on a specific size, the bug is almost certainly the width-bump condition (`next === (1 << width) - earlyChange`) or the table-full reset point (`next === 4096`); adjust and re-run. Use `systematic-debugging` if a boundary case fails.

- [ ] **Step 1: Write the failing test**

Add to `test/filter-encode.test.ts` (add `import { lzwDecode, lzwEncode } from '../src/lzw.js';` at the top):

```ts
describe('lzwEncode', () => {
  it('round-trips every corpus buffer through lzwDecode', () => {
    for (const x of corpus()) {
      expect(lzwDecode(lzwEncode(x))).toEqual(x);
    }
  });

  it('round-trips buffers large enough to cross the 9->12-bit width boundaries', () => {
    // ~20 KB of low-entropy data forces the table past 512/1024/2048/4096 codes.
    const big = new Uint8Array(20000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 3)) & 0x0f;
    expect(lzwDecode(lzwEncode(big))).toEqual(big);

    // A run long enough to fill and reset the dictionary at least once.
    const run = new Uint8Array(60000).fill(0x2a);
    expect(lzwDecode(lzwEncode(run))).toEqual(run);
  });

  it('begins with the packed CLEAR code (256 at 9 bits => 0x80 0x..)', () => {
    const enc = lzwEncode(Uint8Array.from([0x00]));
    // CLEAR=256 packed MSB-first at width 9: bits 100000000 -> first byte 0x80.
    expect(enc[0]).toBe(0x80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/filter-encode.test.ts -t lzwEncode`
Expected: FAIL — `lzwEncode` is not exported.

- [ ] **Step 3: Implement the encoder**

Append to `src/lzw.ts`:

```ts
/** Variable-width (9..12-bit) LZW encode, the inverse of lzwDecode. Emits a
 *  leading CLEAR (256), grows the string table one entry per emitted data code,
 *  bumps the code width when `next === (1 << width) - earlyChange` (mirroring the
 *  decoder), resets the table with a CLEAR when it fills (`next === 4096`), and
 *  ends with EOD (257). Codes are packed MSB-first. */
export function lzwEncode(input: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0;
  const emit = (code: number, width: number) => {
    bitBuf = (bitBuf << width) | code;
    bitCnt += width;
    while (bitCnt >= 8) { bitCnt -= 8; out.push((bitBuf >>> bitCnt) & 0xff); }
    bitBuf &= (1 << bitCnt) - 1; // drop already-drained high bits
  };

  let dict = new Map<string, number>();
  let width = 9, next = 258;
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    width = 9; next = 258;
  };
  reset();

  emit(CLEAR, width);

  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const combined = cur + String.fromCharCode(input[i]);
    if (dict.has(combined)) {
      cur = combined;
      continue;
    }
    emit(dict.get(cur)!, width);        // cur is a known entry (singleton or longer)
    dict.set(combined, next++);         // add cur+byte
    if (next === (1 << width) - earlyChange && width < 12) width++;
    if (next === 4096) { emit(CLEAR, width); reset(); }
    cur = String.fromCharCode(input[i]);
  }
  if (cur !== '') emit(dict.get(cur)!, width);
  emit(EOD, width);
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff); // flush final partial byte
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/filter-encode.test.ts -t lzwEncode`
Expected: PASS (all three `it` blocks). If a boundary round-trip fails, see the implementer note above.

- [ ] **Step 5: Commit**

```bash
git add src/lzw.ts test/filter-encode.test.ts
git commit -m "feat(ox6): LZW encoder"
```

---

### Task 4: `encodeFilter` dispatch + `encodeStream` helper + public exports

**Files:**
- Modify: `src/filters.ts` (add `encodeFilter` and `encodeStream`)
- Modify: `src/index.ts` (export the four encoders + `encodeStream`)
- Test: `test/filter-encode.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `ascii85Encode`, `asciiHexEncode`, `runLengthEncode` (Task 1/2, `src/ascii.js`), `lzwEncode` (Task 3, `src/lzw.js`), `decodeStream` (existing, `src/filters.js`), `PdfDict`/`PdfStream`/`name` (`src/types.js`), `UnsupportedFeatureError` (`src/errors.js`).
- Produces:
  - `export function encodeFilter(filter: string, input: Uint8Array): Uint8Array`
  - `export function encodeStream(bytes: Uint8Array, filter: string, extraDict?: PdfDict): PdfStream`

- [ ] **Step 1: Write the failing test**

Add to `test/filter-encode.test.ts` (add these imports:
`import { encodeFilter, encodeStream, decodeStream } from '../src/filters.js';`
`import { isName, name } from '../src/types.js';`):

```ts
describe('encodeStream / encodeFilter', () => {
  const sample = Uint8Array.from([1, 2, 2, 2, 3, 0, 0, 0, 0, 255]);

  it('decodeStream(encodeStream(x, filter)) round-trips and sets /Filter', () => {
    for (const filter of ['ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode', 'FlateDecode']) {
      const s = encodeStream(sample, filter);
      const f = s.dict.get('Filter');
      expect(isName(f) && f.name).toBe(filter);
      expect(s.dict.get('Length')).toBe(s.raw.length);
      expect(decodeStream(s)).toEqual(sample);
    }
  });

  it('merges extraDict entries into the stream dict', () => {
    const s = encodeStream(sample, 'ASCII85Decode', new Map([['Type', name('XObject')]]));
    const t = s.dict.get('Type');
    expect(isName(t) && t.name).toBe('XObject');
  });

  it('throws UnsupportedFeatureError for an unknown filter', () => {
    expect(() => encodeFilter('DCTDecode', sample)).toThrow(/unsupported encode filter/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/filter-encode.test.ts -t "encodeStream"`
Expected: FAIL — `encodeFilter` / `encodeStream` are not exported from `src/filters.ts`.

- [ ] **Step 3: Implement the dispatch + helper**

In `src/filters.ts`, add `deflateSync` to the `node:zlib` import (it currently imports only `inflateSync`):

```ts
import { inflateSync, deflateSync } from 'node:zlib';
```

Extend the types import to include `PdfStream` and `name` (the line currently imports `PdfStream, PdfDict, PdfObject, isName, isDict, isArray` — add `name`; `PdfStream` is already imported):

```ts
import { PdfStream, PdfDict, PdfObject, isName, isDict, isArray, name } from './types.js';
```

Add the encoder imports near the existing decoder imports:

```ts
import { ascii85Encode, asciiHexEncode, runLengthEncode } from './ascii.js';
import { lzwEncode } from './lzw.js';
```

Then append at the end of `src/filters.ts`:

```ts
/** Encode `input` with a single byte-filter, the inverse of decodeOne. Predictors
 *  are not applied on encode. Throws for unknown/unsupported (incl. image-codec)
 *  filters. */
export function encodeFilter(filter: string, input: Uint8Array): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl': return new Uint8Array(deflateSync(Buffer.from(input)));
    case 'LZWDecode': case 'LZW': return lzwEncode(input);
    case 'ASCII85Decode': case 'A85': return ascii85Encode(input);
    case 'ASCIIHexDecode': case 'AHx': return asciiHexEncode(input);
    case 'RunLengthDecode': case 'RL': return runLengthEncode(input);
    default:
      throw new UnsupportedFeatureError(`unsupported encode filter: ${filter}`);
  }
}

/** Build a PdfStream whose /Filter is `filter` and whose raw payload is `bytes`
 *  encoded with that filter (merging any `extraDict` entries). Guarantees
 *  decodeStream(encodeStream(x, f)) deep-equals x. */
export function encodeStream(bytes: Uint8Array, filter: string, extraDict?: PdfDict): PdfStream {
  const dict: PdfDict = new Map(extraDict ?? []);
  dict.set('Filter', name(filter));
  const raw = encodeFilter(filter, bytes);
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}
```

- [ ] **Step 4: Add the public exports**

In `src/index.ts`, append:

```ts
export { encodeFilter, encodeStream } from './filters.js';
export { ascii85Encode, asciiHexEncode, runLengthEncode } from './ascii.js';
export { lzwEncode } from './lzw.js';
```

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run test/filter-encode.test.ts && npm run typecheck`
Expected: PASS (whole file), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/filters.ts src/index.ts test/filter-encode.test.ts
git commit -m "feat(ox6): encodeFilter dispatch + encodeStream helper + exports"
```

---

### Task 5: README docs + full-suite verification + close issue

**Files:**
- Modify: `README.md` (Features codec line + Limitations bullet)

**Interfaces:**
- Consumes: the public API from Tasks 1–4. Produces: documentation only.

- [ ] **Step 1: Update the Features codec line**

In `README.md`, find the Features "Parsing" bullet (~line 9) that lists the decode filters. Append a sentence to it:

```md
Matching stream **encoders** — `ascii85Encode`, `asciiHexEncode`, `lzwEncode`, `runLengthEncode`, plus `encodeStream(bytes, filter)` — build streams in any of these filters (`FlateDecode` too).
```

- [ ] **Step 2: Update the Limitations bullet**

In `README.md`, find the Limitations bullet beginning "**Stream decoding covers the byte filters; encoding on `Save()` does not**" (~line 752). Replace its second half so it reads:

```md
- **Stream decoding covers the byte filters; encoders exist but `Save()` does not yet re-filter** — decoding supports `FlateDecode`, `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`, and `RunLengthDecode` (with predictors and multi-filter chains), plus `DCTDecode`/`CCITTFaxDecode` (Group 3 1D/2D and Group 4) at the image layer. `JBIG2Decode` and `JPXDecode` are not decoded. Matching **encoders** (`ascii85Encode`, `asciiHexEncode`, `lzwEncode`, `runLengthEncode`) and an `encodeStream(bytes, filter)` helper build streams in those filters, but `Save()` still emits `FlateDecode` or raw for the streams it writes — a document-wide `Save({ streamFilter })` re-encode pass is pending.
```

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no type errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(ox6): document filter encoders + encodeStream"
```

- [ ] **Step 5: Close the issue**

Run: `bd close aspose-pdf-foss-for-ts-ox6`
(The follow-up `Save({ streamFilter })` pass remains open as `aspose-pdf-foss-for-ts-3jf`.)

---

## Notes for the implementer

- The four encoders are pure and independent; only Task 4 wires them together, so Tasks 1–3 can be reviewed in isolation.
- The `corpus()` helper in the test file is defined once (Task 1) and reused by every later round-trip block — do not redefine it.
- Do not apply predictors on encode (they belong to the decode path and to the future image-encode work); `encodeFilter` is byte-filter only.
- `Buffer.from(input)` is required for `deflateSync` (it takes a Node `Buffer`/`Uint8Array`); wrap the result back in `new Uint8Array(...)` to keep the public type `Uint8Array`, matching `decodeOne`.
- If the LZW boundary round-trip fails for a specific buffer size, the fault is the width-bump/reset timing versus `lzwDecode`; that is the one place these encoders can desync from their decoder.
```
