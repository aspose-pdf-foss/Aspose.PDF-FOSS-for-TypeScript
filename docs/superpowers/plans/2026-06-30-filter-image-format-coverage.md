# Filter & Image-Format Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `LZWDecode`/`ASCII85Decode`/`ASCIIHexDecode`/`RunLengthDecode` stream decoding and a `CCITTFaxDecode` image decoder, and broaden `AddImage` to accept CMYK JPEG, interlaced PNG, and palette-`tRNS` PNG.

**Architecture:** Replace the single-filter `inflateStream` with a filter-chain decoder (`src/filters.ts`) that applies byte-filters in order and stops at the first image-codec (terminal) filter. `Image.Decode()` routes through that pipeline and dispatches on the terminal filter. `AddImage`'s JPEG/PNG builders gain the new colour/interlace/transparency paths.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, `node:zlib`, no runtime npm deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins (`zlib`, `crypto`, `fs`). Do NOT add npm runtime deps.
- **ESM + NodeNext** — all relative imports carry the `.js` extension (e.g. `import { x } from './lzw.js'`).
- **Strict TypeScript** — `npm run typecheck` (tsc `--noEmit`) must be green.
- **Errors** — throw `PdfParseError`, `UnsupportedFeatureError`, or `InvalidPasswordError` from `./errors.js`. No other error classes.
- **TDD** — failing test first; programmatic fixtures or `test/helpers/`; mirror existing builder/test style.
- **Quality gate before every commit** — `npm run typecheck` AND `npm test` both green.
- **`PdfDict` is `Map<string, PdfObject>`** keyed without the leading `/`. `name(s)` builds a `{ kind: 'name', name }` object; type guards are `isName`/`isDict`/`isArray`/`isStream` from `./types.js`.

---

## Phase A — Decode pipeline + image-read routing

### Task A1: ASCII filters (`ASCIIHexDecode`, `ASCII85Decode`, `RunLengthDecode`)

**Files:**
- Create: `src/ascii.ts`
- Test: `test/ascii.test.ts`

**Interfaces:**
- Consumes: `PdfParseError` from `./errors.js`.
- Produces:
  - `asciiHexDecode(input: Uint8Array): Uint8Array`
  - `ascii85Decode(input: Uint8Array): Uint8Array`
  - `runLengthDecode(input: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing tests**

Create `test/ascii.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { asciiHexDecode, ascii85Decode, runLengthDecode } from '../src/ascii.js';

const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const bytes = (s: string) => new TextEncoder().encode(s);

describe('asciiHexDecode', () => {
  it('decodes hex pairs, ignores whitespace, stops at >', () => {
    expect(dec(asciiHexDecode(bytes('48 65 6C 6C 6F>ignored')))).toBe('Hello');
  });
  it('pads an odd trailing nibble with 0', () => {
    expect(Array.from(asciiHexDecode(bytes('4>')))).toEqual([0x40]);
  });
});

describe('ascii85Decode', () => {
  it('round-trips a 4-byte group', () => {
    // "Hello" encodes; verify a known short group instead:
    expect(Array.from(ascii85Decode(bytes('z~>')))).toEqual([0, 0, 0, 0]); // z => four zero bytes
  });
  it('decodes a partial final group', () => {
    // 'A' (0x41) encodes to "5l" in a 1-byte final group ... verified by round-trip helper in test
    const src = new Uint8Array([1, 2, 3]);
    const enc = ascii85Encode(src);
    expect(Array.from(ascii85Decode(enc))).toEqual([1, 2, 3]);
  });
  it('skips optional <~ prefix', () => {
    const enc = bytes('<~' + new TextDecoder().decode(ascii85Encode(new Uint8Array([9, 8, 7, 6]))));
    expect(Array.from(ascii85Decode(enc))).toEqual([9, 8, 7, 6]);
  });
});

describe('runLengthDecode', () => {
  it('copies literals and expands runs, stops at 128', () => {
    // [2] => copy 3 literals (a,b,c); [254] => repeat next byte (X) 3 times; [128] EOD
    const input = new Uint8Array([2, 97, 98, 99, 257 - 3, 88, 128, 99]);
    expect(dec(runLengthDecode(input))).toBe('abcXXX');
  });
});

// Local encoder used only to generate ASCII85 fixtures for round-trip tests.
function ascii85Encode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n * 256 + (chunk[k] ?? 0)) >>> 0;
    const g = [0, 0, 0, 0, 0];
    let t = n;
    for (let k = 4; k >= 0; k--) { g[k] = t % 85; t = Math.floor(t / 85); }
    for (let k = 0; k < chunk.length + 1; k++) out.push(g[k] + 0x21);
  }
  out.push(0x7e, 0x3e); // ~>
  return Uint8Array.from(out);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ascii.test.ts`
Expected: FAIL — cannot find module `../src/ascii.js`.

- [ ] **Step 3: Implement `src/ascii.ts`**

```ts
import { PdfParseError } from './errors.js';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** ASCIIHexDecode: hex digit pairs, whitespace skipped, '>' ends data.
 *  An odd trailing nibble is treated as if followed by '0'. */
export function asciiHexDecode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3e) break; // '>'
    if (WS.has(c)) continue;
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else throw new PdfParseError(`ASCIIHexDecode: bad hex digit 0x${c.toString(16)}`);
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4); // odd trailing nibble padded with 0
  return Uint8Array.from(out);
}

/** ASCII85Decode: base-85, whitespace skipped, optional '<~' prefix, 'z' => four
 *  zero bytes, '~>' (or end) ends data. A partial final group of n chars yields
 *  n-1 bytes. */
export function ascii85Decode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  if (input.length >= 2 && input[0] === 0x3c && input[1] === 0x7e) i = 2; // <~
  const flush = () => {
    let n = 0;
    for (const g of group) n = (n * 85 + g) >>> 0;
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    group.length = 0;
  };
  for (; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break; // '~' (of '~>')
    if (WS.has(c)) continue;
    if (c === 0x7a) { // 'z'
      if (group.length !== 0) throw new PdfParseError('ASCII85Decode: z inside group');
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new PdfParseError(`ASCII85Decode: bad char 0x${c.toString(16)}`);
    group.push(c - 0x21);
    if (group.length === 5) flush();
  }
  if (group.length === 1) throw new PdfParseError('ASCII85Decode: dangling single char');
  if (group.length > 0) {
    const cnt = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = (n * 85 + g) >>> 0;
    const b = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    for (let k = 0; k < cnt - 1; k++) out.push(b[k]);
  }
  return Uint8Array.from(out);
}

/** RunLengthDecode (PackBits): length 0..127 => copy len+1 literals;
 *  129..255 => repeat next byte 257-len times; 128 => EOD. */
export function runLengthDecode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const len = input[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < input.length; k++) out.push(input[i++]);
    } else {
      const b = input[i++];
      for (let k = 0; k < 257 - len; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ascii.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ascii.ts test/ascii.test.ts
git commit -m "feat(filters): ASCIIHex/ASCII85/RunLength decoders"
```

---

### Task A2: LZW decoder

**Files:**
- Create: `src/lzw.ts`
- Test: `test/lzw.test.ts`

**Interfaces:**
- Consumes: `PdfParseError` from `./errors.js`.
- Produces: `lzwDecode(input: Uint8Array, earlyChange?: number): Uint8Array` (default `earlyChange = 1`).

- [ ] **Step 1: Write the failing test**

Create `test/lzw.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { lzwDecode } from '../src/lzw.js';

describe('lzwDecode', () => {
  // Worked example from the PDF spec (ISO 32000-1, 7.4.4.2):
  // input bytes 45 -- the spec's "-----A---B" example. Use the canonical
  // encoded stream and its decoded output.
  it('decodes the PDF-spec example stream', () => {
    // Encoded: 0x80 0x0B 0x60 0x50 0x22 0x0C 0x0C 0x85 0x01
    const enc = new Uint8Array([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    const out = lzwDecode(enc);
    expect(new TextDecoder().decode(out)).toBe('-----A---B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lzw.test.ts`
Expected: FAIL — cannot find module `../src/lzw.js`.

- [ ] **Step 3: Implement `src/lzw.ts`**

```ts
import { PdfParseError } from './errors.js';

const CLEAR = 256;
const EOD = 257;

/** Variable-width (9..12 bit) LZW decode as used by PDF LZWDecode.
 *  `earlyChange` (default 1) bumps the code width one step early. */
export function lzwDecode(input: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = new Array(258);
    for (let i = 0; i < 256; i++) table[i] = [i];
    table[CLEAR] = [];
    table[EOD] = [];
  };
  reset();
  let width = 9;
  let next = 258;
  let prev: number[] | null = null;

  let bitBuf = 0, bitCnt = 0, pos = 0;
  const read = (): number => {
    while (bitCnt < width) {
      if (pos >= input.length) return EOD;
      bitBuf = (bitBuf << 8) | input[pos++];
      bitCnt += 8;
    }
    bitCnt -= width;
    return (bitBuf >> bitCnt) & ((1 << width) - 1);
  };

  for (;;) {
    const code = read();
    if (code === EOD) break;
    if (code === CLEAR) { reset(); width = 9; next = 258; prev = null; continue; }

    let entry: number[];
    if (code < next && table[code]) entry = table[code];
    else if (code === next && prev) entry = [...prev, prev[0]];
    else throw new PdfParseError(`LZWDecode: bad code ${code} (next ${next})`);

    for (const b of entry) out.push(b);

    if (prev) {
      table[next++] = [...prev, entry[0]];
      if (next === (1 << width) - earlyChange && width < 12) width++;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lzw.test.ts`
Expected: PASS. (If the spec-example bytes mismatch, fix the table-width bump / earlyChange logic until the decode equals `-----A---B`; this is the correctness gate.)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lzw.ts test/lzw.test.ts
git commit -m "feat(filters): variable-width LZWDecode decoder"
```

---

### Task A3: Filter-chain orchestrator + `inflateStream` delegation

**Files:**
- Create: `src/filters.ts`
- Modify: `src/flate.ts` (replace body with a re-export)
- Test: `test/filters.test.ts`

**Interfaces:**
- Consumes: `lzwDecode` (Task A2), `ascii85Decode`/`asciiHexDecode`/`runLengthDecode` (Task A1), `applyPredictor` + `PredictorParams` from `./predictor.js`, `inflateSync` from `node:zlib`, types/guards from `./types.js`, `UnsupportedFeatureError` from `./errors.js`.
- Produces:
  - `interface TerminalFilter { name: string; parms: PdfDict | undefined }`
  - `applyDecodeFilters(raw: Uint8Array, names: string[], parms: (PdfDict | undefined)[]): { bytes: Uint8Array; terminal?: TerminalFilter }`
  - `decodeStream(s: PdfStream): Uint8Array`
  - `IMAGE_CODECS: ReadonlySet<string>`
- `flate.ts` continues to export `inflateStream(s: PdfStream): Uint8Array` (now delegating to `decodeStream`).

- [ ] **Step 1: Write the failing tests**

Create `test/filters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeStream, applyDecodeFilters } from '../src/filters.js';
import { inflateStream } from '../src/flate.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { name } from '../src/types.js';

const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe('decodeStream', () => {
  it('returns raw when there is no filter', () => {
    const dict: PdfDict = new Map();
    expect(decodeStream({ kind: 'stream', dict, raw: bytes('plain') })).toEqual(bytes('plain'));
  });

  it('decodes a single FlateDecode (via inflateStream delegation)', () => {
    const raw = new Uint8Array(deflateSync(Buffer.from('hello world')));
    const dict: PdfDict = new Map([['Filter', name('FlateDecode')]]);
    expect(new TextDecoder().decode(inflateStream({ kind: 'stream', dict, raw }))).toBe('hello world');
  });

  it('decodes a filter chain [ASCIIHexDecode, FlateDecode] in order', () => {
    const flated = new Uint8Array(deflateSync(Buffer.from('chained!')));
    const hex = Array.from(flated).map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Filter', [name('ASCIIHexDecode'), name('FlateDecode')]],
    ]);
    const out = decodeStream({ kind: 'stream', dict, raw: bytes(hex) });
    expect(new TextDecoder().decode(out)).toBe('chained!');
  });

  it('throws UnsupportedFeatureError when an image codec remains', () => {
    const dict: PdfDict = new Map([['Filter', name('DCTDecode')]]);
    expect(() => decodeStream({ kind: 'stream', dict, raw: bytes('jpegbytes') })).toThrow(/DCTDecode/);
  });
});

describe('applyDecodeFilters', () => {
  it('stops at the terminal image codec and returns leading-decoded bytes', () => {
    const r = applyDecodeFilters(bytes('rawjpeg'), ['DCTDecode'], [undefined]);
    expect(r.terminal?.name).toBe('DCTDecode');
    expect(new TextDecoder().decode(r.bytes)).toBe('rawjpeg');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/filters.test.ts`
Expected: FAIL — cannot find module `../src/filters.js`.

- [ ] **Step 3: Implement `src/filters.ts`**

```ts
import { inflateSync } from 'node:zlib';
import { PdfStream, PdfDict, PdfObject, isName, isDict, isArray } from './types.js';
import { applyPredictor } from './predictor.js';
import { lzwDecode } from './lzw.js';
import { ascii85Decode, asciiHexDecode, runLengthDecode } from './ascii.js';
import { UnsupportedFeatureError } from './errors.js';

/** Filters whose output is not raw samples — they terminate the byte-decode
 *  chain and are handled by the image layer (or rejected for non-image streams). */
export const IMAGE_CODECS: ReadonlySet<string> = new Set([
  'DCTDecode', 'DCT', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode', 'JPXDecode',
]);

export interface TerminalFilter { name: string; parms: PdfDict | undefined; }

function num(o: PdfObject | undefined, dflt: number): number {
  return typeof o === 'number' ? o : dflt;
}

function withPredictor(parms: PdfDict | undefined, data: Uint8Array): Uint8Array {
  if (!isDict(parms)) return data;
  return applyPredictor(data, {
    predictor: num(parms.get('Predictor'), 1),
    colors: num(parms.get('Colors'), 1),
    bpc: num(parms.get('BitsPerComponent'), 8),
    columns: num(parms.get('Columns'), 1),
  });
}

function decodeOne(filter: string, input: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl':
      return withPredictor(parms, new Uint8Array(inflateSync(Buffer.from(input))));
    case 'LZWDecode': case 'LZW':
      return withPredictor(parms, lzwDecode(input, num(parms?.get('EarlyChange'), 1)));
    case 'ASCII85Decode': case 'A85': return ascii85Decode(input);
    case 'ASCIIHexDecode': case 'AHx': return asciiHexDecode(input);
    case 'RunLengthDecode': case 'RL': return runLengthDecode(input);
    default:
      throw new UnsupportedFeatureError(`unsupported decode filter: ${filter}`);
  }
}

/** Apply the leading byte-filters in order; stop at the first image-codec
 *  (terminal) filter and return the partially-decoded bytes plus that filter. */
export function applyDecodeFilters(
  raw: Uint8Array, names: string[], parms: (PdfDict | undefined)[],
): { bytes: Uint8Array; terminal?: TerminalFilter } {
  let bytes = raw;
  for (let k = 0; k < names.length; k++) {
    const nm = names[k];
    if (IMAGE_CODECS.has(nm)) return { bytes, terminal: { name: nm, parms: parms[k] } };
    bytes = decodeOne(nm, bytes, parms[k]);
  }
  return { bytes };
}

function filterList(s: PdfStream): { names: string[]; parms: (PdfDict | undefined)[] } {
  const f = s.dict.get('Filter');
  const names = isName(f) ? [f.name]
    : isArray(f) ? f.filter(isName).map((n) => (n as { name: string }).name) : [];
  const p = s.dict.get('DecodeParms') ?? s.dict.get('DP');
  const parms = isArray(p)
    ? p.map((x) => (isDict(x) ? x : undefined))
    : names.map(() => (isDict(p) ? p : undefined));
  return { names, parms };
}

/** Fully decode a stream's byte-filters. Throws UnsupportedFeatureError if an
 *  image-codec filter remains (not valid for non-image streams). */
export function decodeStream(s: PdfStream): Uint8Array {
  const { names, parms } = filterList(s);
  if (names.length === 0) return s.raw;
  const { bytes, terminal } = applyDecodeFilters(s.raw, names, parms);
  if (terminal) throw new UnsupportedFeatureError(`unsupported filter for stream decode: ${terminal.name}`);
  return bytes;
}
```

- [ ] **Step 4: Replace `src/flate.ts` body with a delegation re-export**

Replace the entire contents of `src/flate.ts` with:

```ts
// FlateDecode + predictor now live in the generalized filter pipeline.
// Kept as a named re-export so existing callers (xref/objstm/XMP/content/
// embedded-file) transparently gain LZW + ASCII filter support.
export { decodeStream as inflateStream } from './filters.js';
```

- [ ] **Step 5: Run the new tests AND the full suite to verify nothing regressed**

Run: `npx vitest run test/filters.test.ts test/flate.test.ts`
Expected: PASS.
Run: `npm test`
Expected: PASS (the whole suite — xref/objstm/XMP/content/image decode paths now route through `decodeStream`).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/filters.ts src/flate.ts test/filters.test.ts
git commit -m "feat(filters): filter-chain decodeStream; delegate inflateStream"
```

---

### Task A4: Route `Image.Decode()` through the pipeline

**Files:**
- Modify: `src/image.ts` (the `Decode()` method, lines ~63-69; add a resolved-filter helper)
- Test: `test/image.test.ts` (add cases)

**Interfaces:**
- Consumes: `applyDecodeFilters`, `IMAGE_CODECS` from `./filters.js`; existing `doc.resolve`, `isName`, `isArray`, `isDict`.
- Produces: unchanged public `Decode(): Uint8Array`, now decoding LZW (and Flate/ASCII-chained) images and giving a clear error for CCITT (until Task B2), JBIG2, JPX.

- [ ] **Step 1: Write the failing test**

Add to `test/image.test.ts` (import what the file already imports; reuse its fixture builder). New cases:

```ts
import { applyDecodeFilters } from '../src/filters.js';

it('Decode() decodes an LZW-compressed image to samples', () => {
  // Build a 2x1 DeviceGray image whose data [0x10,0x20] is LZW-encoded.
  // (Use the helper below to LZW-encode the two bytes.)
  const lzw = lzwEncode(new Uint8Array([0x10, 0x20]));
  const dict = new Map<string, any>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 2], ['Height', 1], ['BitsPerComponent', 8],
    ['ColorSpace', name('DeviceGray')], ['Filter', name('LZWDecode')],
  ]);
  const doc = Document.Open(minimalPdfWithImage(dict, lzw)); // see helper note below
  const img = doc.Pages[0].Images[0];
  expect(Array.from(img.Decode())).toEqual([0x10, 0x20]);
});

it('Decode() throws UnsupportedFeatureError for JPXDecode', () => {
  const dict = new Map<string, any>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 1], ['Height', 1], ['BitsPerComponent', 8],
    ['ColorSpace', name('DeviceGray')], ['Filter', name('JPXDecode')],
  ]);
  const doc = Document.Open(minimalPdfWithImage(dict, new Uint8Array([0])));
  expect(() => doc.Pages[0].Images[0].Decode()).toThrow(/JPXDecode/);
});
```

Helper note: if `test/image.test.ts` lacks a `minimalPdfWithImage`/`lzwEncode`, add them to `test/helpers/build-image-pdf.ts` (mirror the existing image fixture builder there). `lzwEncode` is a minimal encoder sufficient for tiny inputs:

```ts
// test/helpers — minimal LZW encoder (9-bit only; fine for inputs < ~250 codes).
export function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0, width = 9, next = 258;
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  const emit = (code: number) => {
    bitBuf = (bitBuf << width) | code; bitCnt += width;
    while (bitCnt >= 8) { bitCnt -= 8; out.push((bitBuf >> bitCnt) & 0xff); }
  };
  emit(256); // clear
  let w = '';
  for (const b of data) {
    const c = String.fromCharCode(b);
    const wc = w + c;
    if (dict.has(wc)) { w = wc; }
    else { emit(dict.get(w)!); dict.set(wc, next++); w = c; if (next === (1 << width) - 1 && width < 12) width++; }
  }
  if (w !== '') emit(dict.get(w)!);
  emit(257); // EOD
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return Uint8Array.from(out);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/image.test.ts`
Expected: FAIL — LZW image returns wrong bytes / throws (current `Decode()` calls `inflateStream` which would now decode via the pipeline; the JPX case may already pass, the LZW case is the gate). If both already pass via the Task A3 delegation, still add the explicit routing in Step 3 for the terminal dispatch and clearer errors.

- [ ] **Step 3: Implement the routed `Decode()`**

In `src/image.ts`, add a resolved-filter helper and rewrite `Decode()`:

```ts
import { applyDecodeFilters } from './filters.js';

// inside ImageInfo:
private resolvedFilters(): { names: string[]; parms: (PdfDict | undefined)[] } {
  const f = this.doc.resolve(this.Dict.get('Filter'));
  const names = isName(f) ? [f.name]
    : isArray(f)
      ? f.map((x) => this.doc.resolve(x)).filter(isName).map((n) => (n as { name: string }).name)
      : [];
  const p = this.doc.resolve(this.Dict.get('DecodeParms') ?? this.Dict.get('DP'));
  const parms = isArray(p)
    ? p.map((x) => { const r = this.doc.resolve(x); return isDict(r) ? r : undefined; })
    : names.map(() => (isDict(p) ? p : undefined));
  return { names, parms };
}

/** Decoded bytes. JPEG passthrough for DCTDecode; decoded samples for
 *  Flate/LZW/ASCII chains. CCITTFaxDecode is handled in image-codec support;
 *  JBIG2Decode/JPXDecode throw UnsupportedFeatureError. */
Decode(): Uint8Array {
  const { names, parms } = this.resolvedFilters();
  const { bytes, terminal } = applyDecodeFilters(this.stream.raw, names, parms);
  if (!terminal) return bytes;
  if (terminal.name === 'DCTDecode' || terminal.name === 'DCT') return bytes;
  // CCITTFaxDecode wired in Task B2.
  throw new UnsupportedFeatureError(`Image.Decode: unsupported filter ${terminal.name}`);
}
```

Add `PdfDict` and `UnsupportedFeatureError` to the imports in `src/image.ts` if not already present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/image.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/image.ts test/image.test.ts test/helpers/build-image-pdf.ts
git commit -m "feat(image): route Decode() through filter pipeline (LZW images)"
```

---

**Phase A checkpoint:** `npm test` + `npm run typecheck` green. The library now parses LZW/ASCII85/ASCIIHex/RunLength streams everywhere and decodes LZW images. CCITT/JBIG2/JPX still throw a clear `UnsupportedFeatureError`.

---

## Phase B — CCITT decoder + image-embed formats

### Task B1: CCITT Group 3/4 decoder

**Files:**
- Create: `src/ccitt.ts`
- Create: `src/ccitt-tables.ts` (the ITU-T T.4 run-length Huffman tables)
- Test: `test/ccitt.test.ts`
- Test fixtures: `test/fixtures/ccitt/*.bin` (small golden encoded vectors)

**Interfaces:**
- Consumes: `PdfDict`, guards from `./types.js`; `PdfParseError` from `./errors.js`.
- Produces: `decodeCcitt(data: Uint8Array, params: CcittParams): Uint8Array` returning packed 1-bpp rows (MSB-first, 0 = white unless `blackIs1`), and `interface CcittParams { k: number; columns: number; rows: number; blackIs1: boolean; byteAlign: boolean }`.
- `src/ccitt-tables.ts` produces `WHITE_CODES` and `BLACK_CODES` as `{ bits: string; runLength: number }[]` (terminating 0..63 + makeup codes) and `MODE_CODES` for 2D modes.

- [ ] **Step 1: Write the failing tests (golden vectors)**

Create `test/ccitt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeCcitt } from '../src/ccitt.js';

describe('decodeCcitt', () => {
  it('decodes a uniform all-white G4 row to zero bits', () => {
    // 8x1 all-white image, G4 (k<0). Encoded fixture produced by the helper below.
    const enc = new Uint8Array(readFileSync('test/fixtures/ccitt/white-8x1-g4.bin'));
    const out = decodeCcitt(enc, { k: -1, columns: 8, rows: 1, blackIs1: false, byteAlign: false });
    expect(Array.from(out)).toEqual([0x00]); // 8 white pixels => one 0x00 byte
  });

  it('decodes a known mixed 8x2 G4 pattern (golden)', () => {
    const enc = new Uint8Array(readFileSync('test/fixtures/ccitt/pattern-8x2-g4.bin'));
    const out = decodeCcitt(enc, { k: -1, columns: 8, rows: 2, blackIs1: false, byteAlign: false });
    // golden expected packed bytes (one per row): see fixture README
    expect(Array.from(out)).toEqual([0b11110000, 0b00001111]);
  });

  it('honors blackIs1 (inverts output)', () => {
    const enc = new Uint8Array(readFileSync('test/fixtures/ccitt/white-8x1-g4.bin'));
    const out = decodeCcitt(enc, { k: -1, columns: 8, rows: 1, blackIs1: true, byteAlign: false });
    expect(Array.from(out)).toEqual([0xff]);
  });
});
```

Fixtures are generated once by a throwaway encoder script (committed under `test/fixtures/ccitt/` with a short `README.md` describing each vector's pixels). For the uniform white case the G4 encoding is a single `Pass`/`V0`-terminated EOL-free row; the mixed pattern is hand-encoded or produced by any reference CCITT encoder and checked in. The golden bytes in the test are the gate.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ccitt.test.ts`
Expected: FAIL — cannot find module `../src/ccitt.js`.

- [ ] **Step 3: Transcribe the T.4 tables into `src/ccitt-tables.ts`**

Create `src/ccitt-tables.ts`. Transcribe ITU-T Recommendation T.4 **Table 1** (white terminating codes, run lengths 0–63), **Table 2** (black terminating codes 0–63), and **Table 3** (white + black makeup codes 64–1728 and the shared extended makeup codes 1792–2560) into:

```ts
export interface RunCode { bits: string; run: number; } // bits MSB-first as '0'/'1'

export const WHITE_CODES: RunCode[] = [
  { bits: '00110101', run: 0 },
  { bits: '000111',   run: 1 },
  { bits: '0111',     run: 2 },
  // ... all white terminating codes 0..63 (T.4 Table 1) ...
  // ... white makeup codes 64,128,...,1728 (T.4 Table 3) ...
];

export const BLACK_CODES: RunCode[] = [
  { bits: '0000110111', run: 0 },
  { bits: '010',        run: 1 },
  { bits: '11',         run: 2 },
  // ... all black terminating codes 0..63 (T.4 Table 1) ...
  // ... black makeup codes 64,128,...,1728 (T.4 Table 3) ...
];

// Shared extended makeup codes (T.4) appended to BOTH tables 1792..2560.
export const EXT_MAKEUP: RunCode[] = [
  { bits: '00000001000', run: 1792 },
  // ... 1856,1920,1984,...,2560 ...
];

// 2D mode codes (T.6 / T.4 2D), MSB-first.
export const MODE_CODES = {
  P:   '0001',     // pass
  H:   '001',      // horizontal
  V0:  '1',
  VR1: '011', VR2: '000011', VR3: '0000011',
  VL1: '010', VL2: '000010', VL3: '0000010',
} as const;
```

The full code lists are reference data from ITU-T T.4 — transcribe every entry; the golden tests in Step 1 are the correctness gate. Build a prefix lookup (a trie or a `Map<bits,run>` keyed by the bit string read so far) from these arrays at module load.

- [ ] **Step 4: Implement `src/ccitt.ts`**

```ts
import { PdfParseError } from './errors.js';
import { WHITE_CODES, BLACK_CODES, EXT_MAKEUP, MODE_CODES, RunCode } from './ccitt-tables.js';

export interface CcittParams {
  k: number; columns: number; rows: number; blackIs1: boolean; byteAlign: boolean;
}

// Build per-colour prefix maps: bit-string -> run length (terminating + makeup).
function buildMap(codes: RunCode[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of [...codes, ...EXT_MAKEUP]) m.set(c.bits, c.run);
  return m;
}
const WHITE = buildMap(WHITE_CODES);
const BLACK = buildMap(BLACK_CODES);

class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) return -1;
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  alignToByte() { if (this.pos & 7) this.pos = (this.pos & ~7) + 8; }
  eof(): boolean { return (this.pos >> 3) >= this.data.length; }
}

/** Read one run length for the current colour (sum of makeup + terminating). */
function readRun(br: BitReader, map: Map<string, number>): number {
  let total = 0;
  for (;;) {
    let bits = '';
    let run = -1;
    while (bits.length <= 14) {
      const b = br.bit();
      if (b < 0) throw new PdfParseError('CCITT: unexpected end of data');
      bits += b ? '1' : '0';
      const r = map.get(bits);
      if (r !== undefined) { run = r; break; }
    }
    if (run < 0) throw new PdfParseError(`CCITT: bad run code "${bits}"`);
    total += run;
    if (run < 64) return total; // terminating code ends the run
    // makeup code (>=64): continue accumulating
  }
}

/** Decode CCITT G4 (k<0) and G3 1D/2D into packed 1-bpp rows.
 *  Output bit 0 = white unless blackIs1. */
export function decodeCcitt(data: Uint8Array, p: CcittParams): Uint8Array {
  const { columns, blackIs1, byteAlign, k } = p;
  const rowBytes = (columns + 7) >> 3;
  const rows: Uint8Array[] = [];
  const br = new BitReader(data);

  // Reference line changing elements; initial reference line is all white.
  let refChanges: number[] = [columns, columns];

  const maxRows = p.rows > 0 ? p.rows : Number.MAX_SAFE_INTEGER;
  for (let y = 0; y < maxRows && !br.eof(); y++) {
    const cur: number[] = []; // changing elements of the coding line
    let a0 = -1;
    let color = 0; // 0 = white, 1 = black

    if (k >= 0) throw new PdfParseError('CCITT: G3 (k>=0) not yet supported'); // see note

    // --- G4 (T.6) 2D decoding of one row ---
    while (a0 < columns) {
      // b1 = first changing element on ref line right of a0 with opposite colour of a0
      let b1 = columns, b2 = columns;
      {
        let i = 0;
        // find b1
        for (; i < refChanges.length; i++) if (refChanges[i] > (a0 < 0 ? -1 : a0)) break;
        // ensure opposite colour parity
        if (((i & 1) === 0) !== (color === 0)) i++;
        b1 = refChanges[i] ?? columns;
        b2 = refChanges[i + 1] ?? columns;
      }

      const mode = readMode(br);
      if (mode === 'P') {
        a0 = b2;
      } else if (mode === 'H') {
        const r1 = readRun(br, color === 0 ? WHITE : BLACK);
        const r2 = readRun(br, color === 0 ? BLACK : WHITE);
        const start = a0 < 0 ? 0 : a0;
        const a1 = Math.min(start + r1, columns);
        const a2 = Math.min(a1 + r2, columns);
        cur.push(a1, a2);
        a0 = a2;
      } else { // vertical mode VL3..VR3
        const delta = mode; // number offset from b1
        const a1 = Math.max(0, Math.min(b1 + delta, columns));
        cur.push(a1);
        a0 = a1;
        color ^= 1;
      }
    }

    // Render the changing elements `cur` into a packed row.
    const row = new Uint8Array(rowBytes);
    let pos = 0, col = 0;
    for (const change of [...cur, columns]) {
      if (col === 1) for (let x = pos; x < change && x < columns; x++) row[x >> 3] |= 0x80 >> (x & 7);
      pos = change; col ^= 1;
    }
    if (blackIs1) for (let i = 0; i < rowBytes; i++) row[i] ^= 0xff;
    rows.push(row);

    refChanges = [...cur, columns, columns];
    if (byteAlign) br.alignToByte();
  }

  const out = new Uint8Array(rows.length * rowBytes);
  rows.forEach((r, i) => out.set(r, i * rowBytes));
  return out;
}

function readMode(br: BitReader): 'P' | 'H' | number {
  let bits = '';
  while (bits.length <= 7) {
    const b = br.bit();
    if (b < 0) throw new PdfParseError('CCITT: unexpected end in mode code');
    bits += b ? '1' : '0';
    if (bits === MODE_CODES.P) return 'P';
    if (bits === MODE_CODES.H) return 'H';
    if (bits === MODE_CODES.V0) return 0;
    if (bits === MODE_CODES.VR1) return 1;
    if (bits === MODE_CODES.VR2) return 2;
    if (bits === MODE_CODES.VR3) return 3;
    if (bits === MODE_CODES.VL1) return -1;
    if (bits === MODE_CODES.VL2) return -2;
    if (bits === MODE_CODES.VL3) return -3;
  }
  throw new PdfParseError(`CCITT: bad mode code "${bits}"`);
}
```

Note: G3 (`k >= 0`) currently throws `PdfParseError`; the spec lists G3 1D/2D in scope, so if a G3 fixture is in the test set, implement the 1D path (each row is a plain white/black run sequence, no reference line) and the G3-2D per-row 1D/2D flag bit. Keep G4 correct first; let the golden tests drive the b1/parity details — the b1/b2 reference-line search is the subtle part and the mixed-pattern golden vector is its gate.

- [ ] **Step 5: Run the tests; iterate on the b1/parity logic until golden vectors pass**

Run: `npx vitest run test/ccitt.test.ts`
Expected: PASS for all three cases. The reference-changing-element search and the vertical-mode colour flip are the parts most likely to need adjustment against the golden vectors.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/ccitt.ts src/ccitt-tables.ts test/ccitt.test.ts test/fixtures/ccitt
git commit -m "feat(image): CCITT Group 4 fax decoder"
```

---

### Task B2: Wire CCITT into `Image.Decode()`

**Files:**
- Modify: `src/image.ts` (`Decode()` terminal dispatch)
- Test: `test/image.test.ts` (add a CCITT image case)

**Interfaces:**
- Consumes: `decodeCcitt`, `CcittParams` from `./ccitt.js`; `terminal.parms` from the pipeline.
- Produces: `Decode()` returns unpacked 1-bpp samples for `CCITTFaxDecode` images.

- [ ] **Step 1: Write the failing test**

Add to `test/image.test.ts`: build an image XObject with `Filter = CCITTFaxDecode`, `DecodeParms = << /K -1 /Columns 8 /Rows 1 >>`, and the `white-8x1-g4.bin` bytes as the stream. Assert `Decode()` returns `[0x00]`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image.test.ts`
Expected: FAIL with `Image.Decode: unsupported filter CCITTFaxDecode`.

- [ ] **Step 3: Implement the dispatch**

In `src/image.ts` `Decode()`, replace the throwing branch for CCITT:

```ts
import { decodeCcitt } from './ccitt.js';

// ... inside Decode(), after the DCTDecode check:
if (terminal.name === 'CCITTFaxDecode' || terminal.name === 'CCF') {
  const dp = terminal.parms;
  const n = (k: string, d: number) => {
    const v = dp ? this.doc.resolve(dp.get(k)) : undefined;
    return typeof v === 'number' ? v : d;
  };
  const b = (k: string, d: boolean) => {
    const v = dp ? this.doc.resolve(dp.get(k)) : undefined;
    return typeof v === 'boolean' ? v : d;
  };
  return decodeCcitt(bytes, {
    k: n('K', 0),
    columns: n('Columns', 1728),
    rows: n('Rows', this.Height),
    blackIs1: b('BlackIs1', false),
    byteAlign: b('EncodedByteAlign', false),
  });
}
throw new UnsupportedFeatureError(`Image.Decode: unsupported filter ${terminal.name}`);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add src/image.ts test/image.test.ts
git commit -m "feat(image): decode CCITTFaxDecode images in Image.Decode()"
```

---

### Task B3: CMYK JPEG embedding (`AddImage`)

**Files:**
- Modify: `src/imageembed.ts` (`buildJpegXObject`, lines ~39-75)
- Test: `test/image-embed.test.ts`
- Test fixtures: `test/fixtures/jpeg/cmyk-adobe.jpg`, `test/fixtures/jpeg/cmyk-plain.jpg` (tiny)

**Interfaces:**
- Consumes: existing JPEG marker scan.
- Produces: a `DeviceCMYK` Image XObject for 4-component JPEGs, with `/Decode [1 0 1 0 1 0 1 0]` when an Adobe APP14 marker is present.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { buildJpegXObject } from '../src/imageembed.js';
import { isName, isArray } from '../src/types.js';

it('embeds a CMYK JPEG as DeviceCMYK', () => {
  const data = new Uint8Array(readFileSync('test/fixtures/jpeg/cmyk-plain.jpg'));
  const { stream } = buildJpegXObject(data);
  const cs = stream.dict.get('ColorSpace');
  expect(isName(cs) && cs.name).toBe('DeviceCMYK');
  expect(stream.dict.get('Decode')).toBeUndefined();
});

it('adds inverting /Decode for an Adobe-APP14 CMYK JPEG', () => {
  const data = new Uint8Array(readFileSync('test/fixtures/jpeg/cmyk-adobe.jpg'));
  const { stream } = buildJpegXObject(data);
  expect(isArray(stream.dict.get('Decode'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — current `buildJpegXObject` throws `UnsupportedFeatureError` for 4-component JPEG.

- [ ] **Step 3: Implement CMYK support**

In `buildJpegXObject`, track an Adobe APP14 flag during the marker scan and extend the colour-space mapping:

```ts
let adobe = false;
// ... in the marker loop, before `i += segLen` for non-SOF segments:
if (marker === 0xee && segLen >= 7) { // APP14
  // identifier "Adobe" = 41 64 6F 62 65
  if (data[i + 2] === 0x41 && data[i + 3] === 0x64 && data[i + 4] === 0x6f &&
      data[i + 5] === 0x62 && data[i + 6] === 0x65) adobe = true;
}
```

And at the SOF:

```ts
const cs = nc === 1 ? 'DeviceGray' : nc === 3 ? 'DeviceRGB' : nc === 4 ? 'DeviceCMYK' : undefined;
if (cs === undefined)
  throw new UnsupportedFeatureError(`AddImage: unsupported JPEG with ${nc} components`);
const dict: PdfDict = new Map<string, PdfObject>([
  ['Type', name('XObject')], ['Subtype', name('Image')],
  ['Width', width], ['Height', height],
  ['BitsPerComponent', precision], ['ColorSpace', name(cs)],
  ['Filter', name('DCTDecode')],
]);
if (nc === 4 && adobe) dict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0]);
return { stream: { kind: 'stream', dict, raw: data } };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/imageembed.ts test/image-embed.test.ts test/fixtures/jpeg
git commit -m "feat(image): embed CMYK JPEG (DeviceCMYK + Adobe APP14 /Decode)"
```

---

### Task B4: Interlaced PNG (Adam7) embedding

**Files:**
- Modify: `src/imageembed.ts` (`buildPngXObject`, lines ~148-214)
- Test: `test/image-embed.test.ts`

**Interfaces:**
- Consumes: existing `pngChunks`, `applyPredictor`, `inflateSync`.
- Produces: interlaced PNGs (bit depth ≥ 8) embed identically to their non-interlaced twin. Interlaced bit depth < 8 throws `UnsupportedFeatureError`.

- [ ] **Step 1: Write the failing test**

Build the same small RGB image as both interlaced and non-interlaced PNGs (helper in `test/helpers/build-embed-images.ts`), embed both, and assert the resulting XObject `raw` (after `inflateSync`) samples are equal.

```ts
it('embeds an interlaced PNG identically to its non-interlaced twin', () => {
  const plain = makePng(rgbPixels, { interlace: 0 });
  const adam7 = makePng(rgbPixels, { interlace: 1 });
  const a = inflateSync(Buffer.from(buildImageXObject(plain).stream.raw));
  const b = inflateSync(Buffer.from(buildImageXObject(adam7).stream.raw));
  expect(Array.from(b)).toEqual(Array.from(a));
});
```

(`makePng` with an `interlace` option is added to `test/helpers/build-embed-images.ts`; for interlace 1 it lays out the 7 Adam7 passes.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `AddImage: interlaced PNG is not supported`.

- [ ] **Step 3: Implement Adam7 de-interlace**

In `buildPngXObject`, replace the interlace rejection with a branch that, when `interlace === 1`, reconstructs the full raster from the 7 passes. Add:

```ts
const PASSES: [number, number, number, number][] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function deinterlaceAdam7(
  inflated: Uint8Array, width: number, height: number, channels: number, bitDepth: number,
): Uint8Array {
  if (bitDepth < 8)
    throw new UnsupportedFeatureError('AddImage: interlaced PNG below 8-bit is not supported');
  const pxBytes = (channels * bitDepth) >> 3;
  const full = new Uint8Array(width * height * pxBytes);
  let off = 0;
  for (const [xs, ys, xstep, ystep] of PASSES) {
    const pw = xs >= width ? 0 : Math.ceil((width - xs) / xstep);
    const ph = ys >= height ? 0 : Math.ceil((height - ys) / ystep);
    if (pw === 0 || ph === 0) continue;
    const rowLen = pw * pxBytes;
    const passBytes = (rowLen + 1) * ph;
    const passSamples = applyPredictor(
      inflated.subarray(off, off + passBytes),
      { predictor: 15, colors: channels, bpc: bitDepth, columns: pw },
    );
    off += passBytes;
    for (let r = 0; r < ph; r++) {
      const y = ys + r * ystep;
      for (let c = 0; c < pw; c++) {
        const x = xs + c * xstep;
        const src = (r * pw + c) * pxBytes;
        const dst = (y * width + x) * pxBytes;
        for (let k = 0; k < pxBytes; k++) full[dst + k] = passSamples[src + k];
      }
    }
  }
  return full;
}
```

Then in `buildPngXObject`, after reading IHDR (remove the interlace `throw`; capture `interlace = cd[12]`), compute `samples`:

```ts
const samples = interlace === 1
  ? deinterlaceAdam7(inflated, width, height, channels, bitDepth)
  : applyPredictor(inflated, { predictor: 15, colors: channels, bpc: bitDepth, columns: width });
```

The existing alpha-split / palette / colour-space code below uses `samples` unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/imageembed.ts test/helpers/build-embed-images.ts test/image-embed.test.ts
git commit -m "feat(image): de-interlace Adam7 PNG in AddImage"
```

---

### Task B5: Palette `tRNS` → `/SMask`

**Files:**
- Modify: `src/imageembed.ts` (`buildPngXObject` palette branch + `pngChunks` consumption of `tRNS`)
- Test: `test/image-embed.test.ts`

**Interfaces:**
- Consumes: PNG `tRNS` chunk (palette branch); existing `imageStream`, `flate`.
- Produces: an indexed PNG with a `tRNS` chunk gains a `DeviceGray` `/SMask`; palette `tRNS` below 8-bit depth throws `UnsupportedFeatureError`.

- [ ] **Step 1: Write the failing test**

Build an indexed (colorType 3, 8-bit) PNG with a `PLTE` and a `tRNS` chunk (first palette entry transparent), embed it, and assert the XObject has an `/SMask` whose decoded alpha plane is `0` for transparent-index pixels and `255` elsewhere.

```ts
it('maps palette tRNS to an SMask', () => {
  const png = makeIndexedPng(indices, palette, { trns: [0] }); // index 0 fully transparent
  const built = buildImageXObject(png);
  expect(built.smask).toBeDefined();
  const alpha = inflateSync(Buffer.from(built.smask!.raw));
  expect(alpha[0]).toBe(0);   // pixel using index 0
  expect(alpha[alpha.length - 1]).toBe(255);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `built.smask` is `undefined` (tRNS ignored today).

- [ ] **Step 3: Implement palette `tRNS`**

In `buildPngXObject`, capture the `tRNS` chunk (`else if (type === 'tRNS') trns = cd;`) and extend the `colorType === 3` branch:

```ts
if (colorType === 3) {
  if (!palette) throw new PdfParseError('AddImage: palette PNG missing PLTE');
  const hival = Math.floor(palette.length / 3) - 1;
  const cs: PdfObject = [
    name('Indexed'), name('DeviceRGB'), hival,
    { kind: 'string', bytes: new Uint8Array(palette) } as PdfObject,
  ];
  const stream = imageStream(width, height, bitDepth, cs, flate(samples));
  if (trns && trns.length > 0) {
    if (bitDepth !== 8)
      throw new UnsupportedFeatureError('AddImage: palette tRNS below 8-bit is not supported');
    // samples holds one palette index per pixel (8-bit). Map index -> alpha.
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) {
      const idx = samples[i];
      alpha[i] = idx < trns.length ? trns[idx] : 255;
    }
    const smask = imageStream(width, height, 8, name('DeviceGray'), flate(alpha));
    return { stream, smask };
  }
  return { stream };
}
```

Declare `let trns: Uint8Array | undefined;` alongside `palette` at the top of `buildPngXObject`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/imageembed.ts test/helpers/build-embed-images.ts test/image-embed.test.ts
git commit -m "feat(image): map palette tRNS transparency to /SMask"
```

---

### Task B6: Documentation

**Files:**
- Modify: `README.md` (Features bullets for images/filters; Limitations lines ~674, ~675, ~680, and the `Image.Decode()` note ~557-559)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the Features section**

- Image insertion bullet (~line 17): note CMYK JPEG, interlaced PNG, and palette-`tRNS` PNG are now supported.
- Image extraction bullet (~line 22): note `Decode()` now also handles `LZWDecode` and `CCITTFaxDecode` (Group 3/4) images.

- [ ] **Step 2: Update the Limitations section**

- Replace the line "`FlateDecode` is the only supported stream filter for content decoding." with: stream decoding now supports `FlateDecode`, `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`, and `RunLengthDecode` (filter chains honored); encoding on `Save()` still emits `FlateDecode`/raw only.
- Update the `AddImage` limitation (~line 674): CMYK JPEG, interlaced PNG, and palette `tRNS` are now supported; still unsupported: 16-bit-with-alpha PNG, and grayscale/RGB `tRNS` color-key masks.
- Update the `Image.Decode()` note (~line 557-559): `JBIG2Decode`/`JPXDecode` still throw `UnsupportedFeatureError`; `CCITTFaxDecode` and `LZWDecode` now decode.

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run typecheck` (sanity — docs-only, but confirms nothing was touched).
Expected: PASS.

```bash
git add README.md
git commit -m "docs: filter & image-format coverage in README"
```

---

**Phase B checkpoint:** `npm test` + `npm run typecheck` green. CCITT Group 4 (and, if a G3 fixture was added, G3) images decode; `AddImage` accepts CMYK JPEG, interlaced PNG, and palette-`tRNS` PNG.

## Self-Review notes

- **Spec coverage:** decode filters (A1/A2/A3), image-read routing + LZW (A4), CCITT decode (B1/B2), CMYK JPEG (B3), interlaced PNG (B4), palette `tRNS` (B5), docs (B6). Encoding-on-Save and JBIG2/JPX/16-bit-alpha/RGB-tRNS are explicitly out of scope per the spec and asserted as `UnsupportedFeatureError` or documented.
- **Type consistency:** `applyDecodeFilters`/`decodeStream`/`TerminalFilter`/`IMAGE_CODECS` (A3) are consumed unchanged by A4 and B2; `decodeCcitt(data, CcittParams)` (B1) is consumed by B2 with matching field names (`k`/`columns`/`rows`/`blackIs1`/`byteAlign`); `buildJpegXObject`/`buildPngXObject`/`buildImageXObject` keep their existing signatures.
- **Known soft spots (gated by tests, not placeholders):** the LZW width-bump/earlyChange edge (A2 golden), the CCITT b1/parity reference-line search and the T.4 table transcription (B1 golden vectors). These are flagged so the implementer expects iteration there.
