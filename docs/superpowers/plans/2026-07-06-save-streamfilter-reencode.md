# Save({ streamFilter }) Re-encode Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Save({ streamFilter })` option that re-encodes eligible data streams document-wide with a chosen byte-filter — ASCII targets armor over existing compression, LZW/RunLength replace it — sequenced correctly with the encrypt pass.

**Architecture:** A new `src/streamfilter.ts` exposes `applyStreamFilter(objs, filter)`, which rewrites eligible `PdfStream` entries in the already-remapped `plan.objs` array. `serializeDocument` calls it after `planDocument` and before the writers, so the encrypt pass (which runs inside the writers over the same objects) naturally sees the re-encoded, still-plaintext bytes. Eligibility skips image codecs, XMP metadata, structural streams, and unknown filters via a byte-filter allowlist.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps — only `node:zlib`/`node:crypto` built-ins, reused through the existing `filters.ts` encoders from issue ox6.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension (e.g. `import { X } from './filters.js'`).
- Public errors are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `./errors.js`.
- Never mutate the caller's `objects`/`trailer`. The re-encode operates on `plan.objs` (remapped copies) and replaces array slots — it must not mutate a stream's shared `raw`.
- Run `npm run typecheck` and `npm test` green before considering any task done.
- `PdfDict` is a `Map<string, PdfObject>` keyed by name without a leading `/`. Names are tagged via `name('X')`; test with `isName`/`isStream`/`isDict`. `null` is a valid `PdfObject` (serializes to `null`).

---

### Task 1: `applyStreamFilter` — replace mode (LZW / RunLength) + eligibility + name validation

**Files:**
- Create: `src/streamfilter.ts`
- Modify: `src/filters.ts` (export the existing `filterList` reader)
- Test: `test/streamfilter.test.ts`

**Interfaces:**
- Consumes from `src/filters.ts`: `IMAGE_CODECS: ReadonlySet<string>`, `filterList(s: PdfStream): { names: string[]; parms: (PdfDict | undefined)[] }`, `encodeFilter(filter: string, input: Uint8Array): Uint8Array`, `decodeStream(s: PdfStream): Uint8Array`.
- Consumes from `src/types.ts`: `PdfObject`, `PdfDict`, `PdfStream`, `isStream`, `isName`, `name`.
- Produces: `type StreamFilterName = 'ASCII85Decode' | 'ASCIIHexDecode' | 'LZWDecode' | 'RunLengthDecode'` and `function applyStreamFilter(objs: PdfObject[], filter: StreamFilterName): void` (mutates `objs` in place, replacing eligible stream slots).

- [ ] **Step 1: Export `filterList` from `src/filters.ts`**

The reader already exists (currently un-exported around line 58). Add the `export` keyword:

```ts
export function filterList(s: PdfStream): { names: string[]; parms: (PdfDict | undefined)[] } {
```

- [ ] **Step 2: Write the failing test** (`test/streamfilter.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { applyStreamFilter } from '../src/streamfilter.js';
import { decodeStream, filterList } from '../src/filters.js';
import { PdfObject, PdfStream, PdfDict, isStream, name, isName } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const bytes = (s: string) => new TextEncoder().encode(s);

/** A FlateDecode stream whose decoded payload is `text`. */
function flateStream(text: string, extra: [string, PdfObject][] = []): PdfStream {
  const raw = new Uint8Array(deflateSync(Buffer.from(bytes(text))));
  const dict: PdfDict = new Map<string, PdfObject>([
    ...extra, ['Filter', name('FlateDecode')], ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}
function dctStream(): PdfStream {
  const raw = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // fake JPEG bytes
  return { kind: 'stream', dict: new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Filter', name('DCTDecode')], ['Length', raw.length],
  ]), raw };
}
function metadataStream(): PdfStream {
  const raw = bytes('<x:xmpmeta>meta</x:xmpmeta>');
  return { kind: 'stream', dict: new Map<string, PdfObject>([
    ['Type', name('Metadata')], ['Subtype', name('XML')], ['Length', raw.length],
  ]), raw };
}

describe('applyStreamFilter — replace mode', () => {
  it('throws on an unsupported filter name', () => {
    expect(() => applyStreamFilter([], 'FlateDecode' as any))
      .toThrow(UnsupportedFeatureError);
  });

  it('replaces a Flate stream filter with LZWDecode and round-trips', () => {
    const s = flateStream('replace me with LZW');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'LZWDecode');
    const out = objs[0] as PdfStream;
    expect(isStream(out)).toBe(true);
    const f = out.dict.get('Filter');
    expect(isName(f) && f.name).toBe('LZWDecode');
    expect(out.dict.has('DecodeParms')).toBe(false);
    expect(decodeStream(out)).toEqual(bytes('replace me with LZW'));
    expect(s.raw).not.toBe(out.raw); // original stream object untouched
  });

  it('skips image-codec, metadata, and structural streams', () => {
    const dct = dctStream();
    const meta = metadataStream();
    const xref: PdfStream = { kind: 'stream', dict: new Map<string, PdfObject>([
      ['Type', name('XRef')], ['Length', 1]]), raw: Uint8Array.from([0]) };
    const objs: PdfObject[] = [dct, meta, xref];
    applyStreamFilter(objs, 'RunLengthDecode');
    expect(objs[0]).toBe(dct);   // same object reference => untouched
    expect(objs[1]).toBe(meta);
    expect(objs[2]).toBe(xref);
  });

  it('skips a stream already in the exact target filter', () => {
    const raw = Uint8Array.from([0x81, 0x00, 0x80]); // 2x 0x00 run + EOD (RunLength)
    const s: PdfStream = { kind: 'stream', dict: new Map<string, PdfObject>([
      ['Filter', name('RunLengthDecode')], ['Length', raw.length]]), raw };
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'RunLengthDecode');
    expect(objs[0]).toBe(s);
  });

  it('leaves non-stream objects alone', () => {
    const dict: PdfDict = new Map([['Type', name('Catalog')]]);
    const objs: PdfObject[] = [dict, 42, name('X')];
    applyStreamFilter(objs, 'LZWDecode');
    expect(objs).toEqual([dict, 42, name('X')]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/streamfilter.test.ts`
Expected: FAIL — `applyStreamFilter` / `src/streamfilter.js` not found.

- [ ] **Step 4: Implement `src/streamfilter.ts` (replace mode + eligibility + validation)**

```ts
import {
  PdfObject, PdfDict, PdfStream, isStream, isName, name,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { filterList, encodeFilter, decodeStream } from './filters.js';

/** Byte-filters this pass can re-encode a stream into. */
export type StreamFilterName =
  | 'ASCII85Decode' | 'ASCIIHexDecode' | 'LZWDecode' | 'RunLengthDecode';

const VALID: ReadonlySet<string> = new Set<StreamFilterName>([
  'ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode',
]);
/** Targets that armor (wrap) rather than replace the existing chain. */
const ARMOR: ReadonlySet<string> = new Set(['ASCII85Decode', 'ASCIIHexDecode']);
/** Known byte-filters (canonical + abbreviations) — a stream is eligible only
 *  if every existing filter is one of these (image codecs / unknowns excluded). */
const BYTE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW',
  'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'RunLengthDecode', 'RL',
]);
/** /Type values that must never be re-encoded (structural + XMP metadata). */
const EXEMPT_TYPES: ReadonlySet<string> = new Set(['XRef', 'ObjStm', 'Metadata']);

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

/** Eligible = not a structural/metadata stream, and every existing filter is a
 *  known byte-filter (empty chain = uncompressed = eligible). */
function isEligible(s: PdfStream, names: string[]): boolean {
  const t = typeName(s.dict);
  if (t !== undefined && EXEMPT_TYPES.has(t)) return false;
  return names.every((n) => BYTE_FILTERS.has(n));
}

/** Replace the whole byte-filter chain with `filter` (decode fully, re-encode). */
function replace(s: PdfStream, names: string[], filter: string): PdfStream | undefined {
  if (names.length === 1 && names[0] === filter) return undefined; // already exactly this
  const raw = encodeFilter(filter, decodeStream(s));
  const dict: PdfDict = new Map(s.dict);
  dict.set('Filter', name(filter));
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Re-encode every eligible stream in `objs` (remapped write-plan copies) with
 *  `filter`, replacing the array slot. Never mutates a stream's shared `raw`. */
export function applyStreamFilter(objs: PdfObject[], filter: StreamFilterName): void {
  if (!VALID.has(filter)) throw new UnsupportedFeatureError(`unsupported streamFilter: ${filter}`);
  for (let i = 0; i < objs.length; i++) {
    const s = objs[i];
    if (!isStream(s)) continue;
    const { names } = filterList(s);
    if (!isEligible(s, names)) continue;
    if (ARMOR.has(filter)) continue; // armor mode added in Task 2
    const out = replace(s, names, filter);
    if (out) objs[i] = out;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/streamfilter.test.ts`
Expected: PASS (all replace-mode cases). Then `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/streamfilter.ts src/filters.ts test/streamfilter.test.ts
git commit -m "feat(3jf): applyStreamFilter replace mode + eligibility"
```

---

### Task 2: Armor mode (ASCII85 / ASCIIHex) with DecodeParms alignment

**Files:**
- Modify: `src/streamfilter.ts`
- Test: `test/streamfilter.test.ts` (add a describe block)

**Interfaces:**
- Consumes: everything from Task 1, plus `filterList`'s `parms` array (aligned to `names`).
- Produces: no new exports — extends `applyStreamFilter` so ASCII targets armor.

- [ ] **Step 1: Write the failing test** (append to `test/streamfilter.test.ts`)

```ts
/** A FlateDecode stream carrying a PNG-predictor DecodeParms whose decoded
 *  payload is the 8 bytes 10..80 (row filter tag 0 = None = identity). */
function flatePredictorStream(): { stream: PdfStream; data: Uint8Array } {
  const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const row = Uint8Array.from([0, ...data]); // leading PNG filter-type byte 0
  const raw = new Uint8Array(deflateSync(Buffer.from(row)));
  const parms: PdfDict = new Map<string, PdfObject>([
    ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 8],
  ]);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('FlateDecode')], ['DecodeParms', parms], ['Length', raw.length],
  ]);
  return { stream: { kind: 'stream', dict, raw }, data };
}
function rawStream(text: string): PdfStream { // uncompressed, no /Filter
  const raw = bytes(text);
  return { kind: 'stream', dict: new Map<string, PdfObject>([['Length', raw.length]]), raw };
}

describe('applyStreamFilter — armor mode', () => {
  it('armors a Flate stream: ASCII85 outer, Flate inner, 7-bit-clean, round-trips', () => {
    const s = flateStream('armor keeps compression');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCII85Decode');
    const out = objs[0] as PdfStream;
    const { names } = filterList(out);
    expect(names).toEqual(['ASCII85Decode', 'FlateDecode']);
    expect([...out.raw].every((b) => b < 0x80)).toBe(true); // 7-bit clean
    expect(decodeStream(out)).toEqual(bytes('armor keeps compression'));
  });

  it('armors an uncompressed stream with a single ASCII85 filter', () => {
    const s = rawStream('plain uncompressed body');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCIIHexDecode');
    const out = objs[0] as PdfStream;
    const f = out.dict.get('Filter');
    expect(isName(f) && f.name).toBe('ASCIIHexDecode'); // single name, not an array
    expect(out.dict.has('DecodeParms')).toBe(false);
    expect(decodeStream(out)).toEqual(bytes('plain uncompressed body'));
  });

  it('prepends null to DecodeParms so the inner predictor still applies', () => {
    const { stream, data } = flatePredictorStream();
    const objs: PdfObject[] = [stream];
    applyStreamFilter(objs, 'ASCII85Decode');
    const out = objs[0] as PdfStream;
    const dp = out.dict.get('DecodeParms') as PdfObject[];
    expect(Array.isArray(dp)).toBe(true);
    expect(dp[0]).toBe(null);            // parm-less ASCII85 slot
    expect(dp[1]).toBeInstanceOf(Map);   // preserved predictor parms
    expect(decodeStream(out)).toEqual(data);
  });

  it('skips a stream already armored on top with the target', () => {
    const s = flateStream('x');
    const objs: PdfObject[] = [s];
    applyStreamFilter(objs, 'ASCII85Decode');
    const first = objs[0];
    applyStreamFilter(objs, 'ASCII85Decode'); // second pass is a no-op
    expect(objs[0]).toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/streamfilter.test.ts -t armor`
Expected: FAIL — armor targets currently `continue` (skipped), so filters/params are unchanged.

- [ ] **Step 3: Implement armor mode in `src/streamfilter.ts`**

Add the `armor` helper and replace the `if (ARMOR.has(filter)) continue;` line so armor targets transform:

```ts
/** Wrap the existing raw payload in `filter` (an ASCII armor), preserving any
 *  inner byte-filters and their DecodeParms. */
function armor(
  s: PdfStream, names: string[], parms: (PdfDict | undefined)[], filter: string,
): PdfStream | undefined {
  if (names[0] === filter) return undefined; // already armored on top
  const raw = encodeFilter(filter, s.raw);
  const dict: PdfDict = new Map(s.dict);
  const newNames = [filter, ...names];
  dict.set('Filter', newNames.length === 1
    ? name(filter)
    : newNames.map((n) => name(n)));
  if (parms.some((p) => p !== undefined)) {
    // Prepend a null for the parm-less ASCII filter; keep the rest aligned.
    const arr: PdfObject[] = [null, ...parms.map((p) => (p === undefined ? null : p))];
    dict.set('DecodeParms', arr);
    dict.delete('DP');
  } else {
    dict.delete('DecodeParms');
    dict.delete('DP');
  }
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}
```

Then in `applyStreamFilter`, change the loop body's transform dispatch:

```ts
    const { names, parms } = filterList(s);
    if (!isEligible(s, names)) continue;
    const out = ARMOR.has(filter)
      ? armor(s, names, parms, filter)
      : replace(s, names, filter);
    if (out) objs[i] = out;
```

(Remove the old `if (ARMOR.has(filter)) continue;` and the `const { names } = filterList(s);` line it replaces.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/streamfilter.test.ts`
Expected: PASS (replace + armor). Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/streamfilter.ts test/streamfilter.test.ts
git commit -m "feat(3jf): applyStreamFilter armor mode (ASCII85/ASCIIHex)"
```

---

### Task 3: Wire `streamFilter` into the serializer + guards + end-to-end tests

**Files:**
- Modify: `src/serializer.ts` (add option, hook, linearized + sign guards)
- Create: `test/helpers/build-streamfilter-pdf.ts` (fixture)
- Test: `test/streamfilter-save.test.ts`

**Interfaces:**
- Consumes: `applyStreamFilter`, `StreamFilterName` from `./streamfilter.js`; existing `planDocument`, `serializeDocument`, `serializeSignedDocument`.
- Produces: `SerializeOptions.streamFilter?: StreamFilterName`; `serializeDocument(objects, trailer, { streamFilter })` re-encodes eligible streams; `buildStreamFilterDoc(): { objects: Map<number, PdfObject>; trailer: PdfDict }`.

- [ ] **Step 1: Add the option + hook + guards in `src/serializer.ts`**

Add the import near the top:

```ts
import { applyStreamFilter, StreamFilterName } from './streamfilter.js';
```

Add the field to `SerializeOptions`:

```ts
  /** Re-encode eligible data streams with this byte-filter on Save. ASCII
   *  targets armor over existing compression (7-bit-clean output); LZW /
   *  RunLength replace it. Image-codec, XMP-metadata, and structural streams
   *  are left untouched. Not supported with `linearized`. */
  streamFilter?: StreamFilterName;
```

In `serializeDocument`, add the linearized guard at the very top of the body (before the `if (options.linearized)` block) and the hook right after `const plan = planDocument(...)`:

```ts
export function serializeDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict, options: SerializeOptions = {},
): Uint8Array {
  if (options.streamFilter && options.linearized)
    throw new UnsupportedFeatureError('streamFilter is not supported with linearized output');
  if (options.linearized) {
    // ...unchanged...
  }
  const plan = planDocument(objects, trailer);
  if (options.streamFilter) applyStreamFilter(plan.objs, options.streamFilter);
  const ver = headerVersion(objects, trailer);
  // ...unchanged...
}
```

In `serializeSignedDocument`, add a guard alongside the existing `compressed`/`encrypt` guards:

```ts
  if (options.streamFilter)
    throw new UnsupportedFeatureError('sign-on-save does not support streamFilter');
```

- [ ] **Step 2: Create the fixture builder** (`test/helpers/build-streamfilter-pdf.ts`)

```ts
import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, PdfStream, name, ref } from '../../src/types.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function stream(dict: [string, PdfObject][], raw: Uint8Array): PdfStream {
  const d: PdfDict = new Map<string, PdfObject>(dict);
  d.set('Length', raw.length);
  return { kind: 'stream', dict: d, raw };
}
function flate(text: string, extra: [string, PdfObject][] = []): PdfStream {
  return stream([...extra, ['Filter', name('FlateDecode')]],
    new Uint8Array(deflateSync(Buffer.from(bytes(text)))));
}

/** A one-page doc reachable from /Root carrying, as page-resource XObjects:
 *  a Flate content stream, an uncompressed stream, a Flate+predictor stream,
 *  a DCTDecode image, plus an XMP /Metadata stream on the catalog. */
export function buildStreamFilterDoc(): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const objects = new Map<number, PdfObject>();

  // 6 = Flate content stream (page /Contents)
  objects.set(6, flate('BT /F1 12 Tf 10 10 Td (FLATE-CONTENT-STREAM) Tj ET'));
  // 7 = uncompressed Form XObject
  objects.set(7, stream(
    [['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 10, 10]]],
    bytes('UNCOMPRESSED-XOBJECT-BODY')));
  // 8 = Flate + PNG-predictor Form XObject (payload = 8 bytes 10..80)
  {
    const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const raw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([0, ...data]))));
    const parms: PdfDict = new Map<string, PdfObject>([
      ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 8]]);
    objects.set(8, {
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 8, 1]],
        ['Filter', name('FlateDecode')], ['DecodeParms', parms], ['Length', raw.length]]),
      raw,
    });
  }
  // 9 = DCTDecode image (never decoded; must stay binary/untouched)
  objects.set(9, stream(
    [['Type', name('XObject')], ['Subtype', name('Image')], ['Width', 1], ['Height', 1],
     ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', name('DCTDecode')]],
    Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
  // 10 = XMP /Metadata stream (exempt)
  objects.set(10, stream(
    [['Type', name('Metadata')], ['Subtype', name('XML')]],
    bytes('<?xpacket?><x:xmpmeta>title</x:xmpmeta>')));

  const resources: PdfDict = new Map<string, PdfObject>([
    ['XObject', new Map<string, PdfObject>([
      ['Fx1', ref(7)], ['Fx2', ref(8)], ['Im0', ref(9)]])],
  ]);
  objects.set(5, resources);
  objects.set(3, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 200, 200]],
    ['Resources', ref(5)], ['Contents', ref(6)]]));
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]]]));
  objects.set(1, new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)], ['Metadata', ref(10)]]));

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}
```

- [ ] **Step 3: Write the failing end-to-end test** (`test/streamfilter-save.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { serializeDocument } from '../src/serializer.js';
import { Document } from '../src/document.js';
import { decodeStream, filterList } from '../src/filters.js';
import { PdfObject, PdfStream, isStream, isName } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildStreamFilterDoc } from './helpers/build-streamfilter-pdf.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** All streams in a reopened document's object map. */
function streamsOf(doc: Document): PdfStream[] {
  const objs = (doc as any).objects as Map<number, PdfObject>;
  return [...objs.values()].filter(isStream) as PdfStream[];
}
/** typeName helper mirroring the source. */
function typeName(s: PdfStream): string | undefined {
  const t = s.dict.get('Type');
  return isName(t) ? t.name : undefined;
}

const TARGETS = ['ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode'] as const;
const ARMOR = new Set(['ASCII85Decode', 'ASCIIHexDecode']);

describe('Save({ streamFilter })', () => {
  // Expected decoded payloads of the three ELIGIBLE streams (content, Fx1, Fx2).
  const expected = new Set([
    hex(new TextEncoder().encode('BT /F1 12 Tf 10 10 Td (FLATE-CONTENT-STREAM) Tj ET')),
    hex(new TextEncoder().encode('UNCOMPRESSED-XOBJECT-BODY')),
    hex(Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80])),
  ]);

  for (const target of TARGETS) {
    it(`re-encodes eligible streams to ${target} and re-opens byte-identical`, () => {
      const { objects, trailer } = buildStreamFilterDoc();
      const re = Document.Open(serializeDocument(objects, trailer, { streamFilter: target }));
      const streams = streamsOf(re);

      // Eligible streams: DCT + Metadata are excluded; the other three re-encoded.
      const eligible = streams.filter((s) => {
        const { names } = filterList(s);
        return typeName(s) !== 'Metadata' && !names.includes('DCTDecode');
      });
      const actual = new Set(eligible.map((s) => hex(decodeStream(s))));
      expect(actual).toEqual(expected);

      for (const s of eligible) {
        const { names } = filterList(s);
        if (ARMOR.has(target)) {
          expect(names[0]).toBe(target);                 // armored on top
          expect([...s.raw].every((b) => b < 0x80)).toBe(true); // 7-bit clean
        } else {
          expect(names).toEqual([target]);               // replaced
        }
      }

      // DCT image untouched.
      const dct = streams.find((s) => filterList(s).names.includes('DCTDecode'))!;
      expect(hex(dct.raw)).toBe(hex(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
      // Metadata untouched (no filter, original bytes).
      const meta = streams.find((s) => typeName(s) === 'Metadata')!;
      expect(filterList(meta).names).toEqual([]);
      expect(decodeStream(meta)).toEqual(
        new TextEncoder().encode('<?xpacket?><x:xmpmeta>title</x:xmpmeta>'));
    });
  }

  it('sequences filter-then-encrypt: ASCII85 + encrypt re-opens byte-identical', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    const bytes = serializeDocument(objects, trailer, {
      streamFilter: 'ASCII85Decode', encrypt: { userPassword: 'u' },
    });
    const re = Document.Open(bytes, { password: 'u' });
    const eligible = streamsOf(re).filter((s) => {
      const { names } = filterList(s);
      return typeName(s) !== 'Metadata' && !names.includes('DCTDecode');
    });
    expect(new Set(eligible.map((s) => hex(decodeStream(s))))).toEqual(expected);
  });

  it('throws when combined with linearized output', () => {
    const { objects, trailer } = buildStreamFilterDoc();
    expect(() => serializeDocument(objects, trailer, {
      streamFilter: 'ASCII85Decode', linearized: true,
    })).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `npx vitest run test/streamfilter-save.test.ts`
Expected first: FAIL if the serializer wiring in Step 1 was not applied (streams unchanged / no throw). After Step 1 is in place: PASS.
Then run the whole suite: `npm test` and `npm run typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/serializer.ts test/helpers/build-streamfilter-pdf.ts test/streamfilter-save.test.ts
git commit -m "feat(3jf): wire streamFilter into serializeDocument + guards"
```

---

### Task 4: Public export + README

**Files:**
- Modify: `src/index.ts` (export `StreamFilterName`)
- Modify: `README.md`
- Test: `test/streamfilter-save.test.ts` (add an export smoke check)

**Interfaces:**
- Consumes: `StreamFilterName` from `./streamfilter.js`.
- Produces: `StreamFilterName` on the public surface; README documents `Save({ streamFilter })`.

- [ ] **Step 1: Export the type from `src/index.ts`**

Add beside the existing encoder exports (near the `export { encodeFilter, encodeStream } from './filters.js';` line):

```ts
export type { StreamFilterName } from './streamfilter.js';
```

- [ ] **Step 2: Add an export smoke test** (append to `test/streamfilter-save.test.ts`)

```ts
import * as pkg from '../src/index.js';

describe('public surface', () => {
  it('accepts a StreamFilterName-typed option through the barrel export', () => {
    const target: import('../src/index.js').StreamFilterName = 'ASCII85Decode';
    const { objects, trailer } = buildStreamFilterDoc();
    // Uses the same serializer the package re-exports; asserts the type compiles.
    expect(pkg.serializeDocument(objects, trailer, { streamFilter: target }).length)
      .toBeGreaterThan(0);
  });
});
```

(If `serializeDocument` is not on the barrel, import it from `../src/serializer.js` as elsewhere and keep only the `StreamFilterName` type reference for the compile check.)

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/streamfilter-save.test.ts` and `npm run typecheck`
Expected: PASS / clean. If `pkg.serializeDocument` is undefined, switch that call to the direct `serializeDocument` import (the type reference is what proves the export).

- [ ] **Step 4: Update `README.md`**

In the API overview (near the `Save`/`Save({ compressed })` documentation), add:

```markdown
- `Save({ streamFilter })` — re-encode eligible data streams with a chosen
  byte-filter (`'ASCII85Decode' | 'ASCIIHexDecode' | 'LZWDecode' | 'RunLengthDecode'`).
  ASCII targets *armor* over any existing compression (e.g. `FlateDecode` becomes
  `[/ASCII85Decode /FlateDecode]`), producing 7-bit-clean stream contents while
  keeping compression; `LZWDecode`/`RunLengthDecode` fully re-encode. Image-codec
  streams (`DCTDecode`/`CCITTFaxDecode`/`JPXDecode`/`JBIG2Decode`), XMP `/Metadata`,
  and structural streams are left untouched. Full 7-bit output is a classic
  (non-`compressed`) property, since compressed output keeps a binary XRef stream.
  Not supported with `linearized`.
```

In the Limitations / codec bullet, change the ox6 note that a document-wide re-encode pass "is still pending" to state it now ships as `Save({ streamFilter })`, noting image-codec and metadata streams are left as-is.

- [ ] **Step 5: Full verification + commit**

Run: `npm run typecheck && npm test`
Expected: all green.

```bash
git add src/index.ts README.md test/streamfilter-save.test.ts
git commit -m "feat(3jf): export StreamFilterName + document Save({ streamFilter })"
```

---

## Self-Review Notes

**Spec coverage:**
- API (`streamFilter` option, `StreamFilterName`) → Tasks 3, 4.
- Hook after `planDocument`, filter-then-encrypt ordering → Task 3 (+ encrypt test).
- Eligibility (byte-filter allowlist; skip image codecs, XRef/ObjStm/Metadata, unknown filters; redundant skip) → Tasks 1, 2.
- Armor mode + DecodeParms alignment; replace mode + drop parms → Tasks 2, 1.
- Round-trip / byte-identical re-open → Tasks 1–3 tests.
- Guards: linearized, sign-on-save, invalid name → Tasks 1, 3.
- compressed + encrypt supported → Task 3 encrypt test (compressed shares the same hook; covered by construction).
- README + public export → Task 4.

**Type consistency:** `StreamFilterName`, `applyStreamFilter(objs, filter)`, `filterList(s) -> { names, parms }`, `encodeFilter`, `decodeStream` are used identically across tasks. `plan.objs` is `PdfObject[]`; slot replacement matches `applyStreamFilter`'s in-place contract.

**Placeholders:** none — every code and test step is complete.
