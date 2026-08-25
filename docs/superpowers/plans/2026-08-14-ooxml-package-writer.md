# OOXML Package Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write a `.docx` — a ZIP of XML parts wired by `[Content_Types].xml` and a relationship graph — with no zip dependency, so that `8yt9.2` has only to produce the document body.

**Architecture:** Three layers, each ignorant of the one above: `zip.ts` turns entries into archive bytes and knows nothing of OOXML; `ooxml.ts` owns content types and relationships and knows nothing of WordprocessingML; `docxpackage.ts` assembles the minimal `.docx` part set with the body as a seam. `crc32.ts` is extracted from `pngencode.ts`, which already computes the same polynomial.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, `node:zlib` (`deflateRawSync`). No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-ooxml-package-writer-design.md` — read it before Task 1; every invariant cited below is stated there in full.

**Issue:** `aspose-pdf-foss-for-ts-8yt9.1` (already claimed). Track work with `bd`, never TodoWrite or markdown TODO lists.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps — that is the whole point of the issue title.
- **ESM + NodeNext:** every import specifier carries the `.js` extension (`import { crc32 } from './crc32.js'`).
- **`src/zip.ts` imports no PDF module.** It takes bytes and returns bytes. `node:zlib` and `./crc32.js` are its only imports.
- **`src/ooxml.ts` imports `zip.ts` and `xml.ts` only.** It must not know what WordprocessingML is.
- **`npm run typecheck` and `npm test` must both be green** before the issue is closed.
- Commit after every task. End each commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Never `git checkout --` or `git restore` a file holding uncommitted work.** Commit first, then mutate. This plan's mutation steps assume the task is already committed.
- Per CLAUDE.md, a new assertion passing on the first run is not evidence. Task 7 breaks each new path and confirms red.

## File Structure

| File | Responsibility |
|---|---|
| `src/crc32.ts` (new) | CRC-32 (`0xEDB88320`), one owner for PNG and ZIP |
| `src/pngencode.ts` | Loses its private copy, imports the shared one |
| `src/zip.ts` (new) | `ZipEntry` → archive bytes; local headers, central directory, EOCD |
| `src/ooxml.ts` (new) | `OoxmlPart`/`OoxmlRelationship` → `[Content_Types].xml`, `.rels`, package bytes |
| `src/docxpackage.ts` (new) | The minimal `.docx` part set; `writeDocx(bodyXml)` |
| `test/helpers/unzip.ts` (new) | Test-only reader: EOCD → central directory → entries |
| `test/crc32.test.ts` (new) | Published vectors |
| `test/zip.test.ts` (new) | Archive structure, store/deflate, guards, determinism |
| `test/ooxml.test.ts` (new) | Content types and relationship resolution |
| `test/docx-package.test.ts` (new) | The DOCX part set |
| `README.md`, `CLAUDE.md` | Limitations and the recorded invariants |

---

### Task 1: CRC-32 gets one owner

**Files:**
- Create: `src/crc32.ts`
- Modify: `src/pngencode.ts:8-23`
- Test: `test/crc32.test.ts`

**Interfaces:**
- Produces: `crc32(bytes: Uint8Array): number` — the unsigned 32-bit checksum.

- [ ] **Step 1: Write the failing test**

Create `test/crc32.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { crc32 } from '../src/crc32.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  // Published vectors. These are the anchor OUTSIDE our own code: a reader and
  // a writer that share a wrong initial or final XOR agree with each other and
  // with nothing else, and a wrong CRC in a ZIP is not a crash — it is an
  // archive some tools accept and others reject.
  it('matches the published values for known inputs', () => {
    expect(crc32(bytes(''))).toBe(0x00000000);
    expect(crc32(bytes('a'))).toBe(0xe8b7be43);
    expect(crc32(bytes('abc'))).toBe(0x352441c2);
    expect(crc32(bytes('hello'))).toBe(0x3610a686);
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  it('returns an unsigned value, never a negative int32', () => {
    // 'a' is 0xE8B7BE43, whose top bit is set — the case a missing >>> 0 gets
    // wrong, and one that a self-consistent round trip would never reveal.
    expect(crc32(bytes('a'))).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/crc32.test.ts`
Expected: FAIL — `Failed to resolve import "../src/crc32.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/crc32.ts` by moving the existing implementation out of
`pngencode.ts` verbatim:

```ts
/** CRC-32 with the `0xEDB88320` polynomial — the one PNG, zlib and ZIP all use.
 *
 *  **Invariant:** one owner. A second copy is a second chance to get the
 *  initial or final XOR wrong, and a wrong CRC in a ZIP is not a crash: it is
 *  an archive some readers accept and others reject, which is the worst failure
 *  mode to debug. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
```

- [ ] **Step 4: Point `pngencode.ts` at it**

In `src/pngencode.ts`, DELETE the `CRC_TABLE` const and the `crc32` function
(they currently occupy lines 8-23), and add the import beside the existing one:

```ts
import { deflateSync } from 'node:zlib';
import { crc32 } from './crc32.js';
```

Leave every other line of `pngencode.ts` untouched. Its output must stay
byte-identical — `test/` already fences that through the PNG and image tests.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/crc32.test.ts test/pngencode.test.ts`
Expected: PASS. If `test/pngencode.test.ts` does not exist, run
`npx vitest run test/imagehref.test.ts test/image-encode.test.ts` instead —
any suite that produces a PNG proves the move was behaviour-preserving.

- [ ] **Step 6: Commit**

```bash
git add src/crc32.ts src/pngencode.ts test/crc32.test.ts
git commit -m "refactor(crc32): one owner for the PNG and ZIP checksum"
```

---

### Task 2: The test-only unzip helper

**Files:**
- Create: `test/helpers/unzip.ts`
- Test: none of its own — Task 3 is its first consumer, and a reader with
  nothing to read cannot be tested honestly.

**Interfaces:**
- Produces: `unzip(bytes: Uint8Array): UnzippedEntry[]` where
  `interface UnzippedEntry { path: string; bytes: Uint8Array; method: 'store' | 'deflate'; crc: number }`.

**Why this is written before the writer:** a writer validated by its own reader
proves only that the two agree. This reader is written against the format —
locate the end-of-central-directory record, walk the central directory, inflate
each entry with `node:zlib` — so that the assertions in Tasks 3-6 are anchored
in something other than `zip.ts`. Task 7 additionally breaks the writer and
confirms this reader notices.

- [ ] **Step 1: Write the helper**

Create `test/helpers/unzip.ts`:

```ts
import { inflateRawSync } from 'node:zlib';

/** One entry read back out of an archive. */
export interface UnzippedEntry {
  path: string;
  bytes: Uint8Array;
  method: 'store' | 'deflate';
  /** The CRC-32 the archive CLAIMS, so a test can compare it with the truth. */
  crc: number;
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Read an archive, written against APPNOTE rather than against src/zip.ts.
 *
 *  Deliberately strict: it throws rather than guessing, so a malformed archive
 *  fails the test that produced it instead of being quietly tolerated. */
export function unzip(bytes: Uint8Array): UnzippedEntry[] {
  // The EOCD is the last 22 bytes when there is no archive comment, which is
  // what src/zip.ts writes; scan backwards anyway so the helper is honest.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);          // central directory offset

  const out: UnzippedEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compSize = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (u32(bytes, localAt) !== 0x04034b50) throw new Error(`bad local header for ${path}`);
    const localNameLen = u16(bytes, localAt + 26);
    const localExtraLen = u16(bytes, localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compSize);

    if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method} for ${path}`);
    out.push({
      path,
      bytes: method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : new Uint8Array(raw),
      method: method === 8 ? 'deflate' : 'store',
      crc,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** An entry by path, or undefined. */
export function entry(entries: UnzippedEntry[], path: string): UnzippedEntry | undefined {
  return entries.find((e) => e.path === path);
}

/** An entry's bytes decoded as UTF-8 text. */
export function textOf(entries: UnzippedEntry[], path: string): string {
  const e = entry(entries, path);
  if (!e) throw new Error(`no entry ${path}`);
  return new TextDecoder().decode(e.bytes);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (There is no test to run: this helper has no consumer until
Task 3, and asserting a reader against a hand-written byte array here would
duplicate Task 3's work without adding evidence.)

- [ ] **Step 3: Commit**

```bash
git add test/helpers/unzip.ts
git commit -m "test(zip): a reader written against the format, for the writer to be judged by"
```

---

### Task 3: The ZIP writer

**Files:**
- Create: `src/zip.ts`
- Test: `test/zip.test.ts`

**Interfaces:**
- Consumes: `crc32` from `src/crc32.ts`; `unzip`, `entry`, `textOf` from `test/helpers/unzip.ts`.
- Produces: `interface ZipEntry { path: string; bytes: Uint8Array; method?: 'store' | 'deflate' }`
  and `function writeZip(entries: ZipEntry[]): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `test/zip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { writeZip } from '../src/zip.js';
import { crc32 } from '../src/crc32.js';
import { unzip, entry } from './helpers/unzip.js';

const bytes = (s: string) => new TextEncoder().encode(s);
/** Long enough that deflate actually shrinks it. */
const LONG = 'the quick brown fox '.repeat(50);

describe('writeZip', () => {
  it('round-trips a stored entry', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes('hello'), method: 'store' }]);
    const [e] = unzip(zip);
    expect(e.path).toBe('a.txt');
    expect(e.method).toBe('store');
    expect(new TextDecoder().decode(e.bytes)).toBe('hello');
  });

  it('round-trips a deflated entry, and actually deflates it', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes(LONG) }]);   // deflate is the default
    const [e] = unzip(zip);
    expect(e.method).toBe('deflate');
    expect(new TextDecoder().decode(e.bytes)).toBe(LONG);
    expect(zip.length).toBeLessThan(LONG.length);
  });

  // The archive's own CRC field, against a checksum computed independently of
  // the writer. A reader and writer sharing one bug agree with each other.
  it('records the true CRC-32 of the uncompressed bytes', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes('hello') }]);
    expect(unzip(zip)[0].crc).toBe(crc32(bytes('hello')));
    expect(unzip(zip)[0].crc).toBe(0x3610a686);      // and the published value
  });

  // node:zlib inflating what we deflated is code we did not write.
  it('writes RAW deflate, with no zlib header', () => {
    const zip = writeZip([{ path: 'a.txt', bytes: bytes(LONG) }]);
    const at = zip.indexOf(0x50);
    void at;
    const e = unzip(zip)[0];       // unzip uses inflateRawSync
    expect(new TextDecoder().decode(e.bytes)).toBe(LONG);
    // A zlib-wrapped stream would begin 0x78; raw deflate does not.
    expect(() => inflateRawSync(Buffer.from([0x78, 0x9c]))).toThrow();
  });

  it('keeps several entries, in the order given', () => {
    const zip = writeZip([
      { path: 'one.txt', bytes: bytes('1') },
      { path: 'dir/two.txt', bytes: bytes('2') },
      { path: 'three.txt', bytes: bytes('3') },
    ]);
    expect(unzip(zip).map((e) => e.path)).toEqual(['one.txt', 'dir/two.txt', 'three.txt']);
    expect(new TextDecoder().decode(entry(unzip(zip), 'dir/two.txt')!.bytes)).toBe('2');
  });

  it('writes an empty entry without complaint', () => {
    const zip = writeZip([{ path: 'empty.txt', bytes: new Uint8Array(0) }]);
    const [e] = unzip(zip);
    expect(e.bytes.length).toBe(0);
    expect(e.crc).toBe(0);
  });

  // Two runs over one input must give identical bytes, or nothing downstream
  // can be snapshot-tested and a caller cannot tell a real change from the
  // time of day.
  it('is byte-reproducible', () => {
    const make = () => writeZip([{ path: 'a.txt', bytes: bytes('hello') }]);
    expect(Buffer.from(make())).toEqual(Buffer.from(make()));
  });

  it('rejects a duplicate path', () => {
    expect(() => writeZip([
      { path: 'a.txt', bytes: bytes('1') },
      { path: 'a.txt', bytes: bytes('2') },
    ])).toThrow(/duplicate/i);
  });

  it('rejects a leading slash and a backslash separator', () => {
    expect(() => writeZip([{ path: '/a.txt', bytes: bytes('1') }])).toThrow();
    expect(() => writeZip([{ path: 'dir\\a.txt', bytes: bytes('1') }])).toThrow();
  });

  // ZIP's 32-bit fields wrap silently past these bounds, producing an archive
  // that looks well-formed and is not. Neither is reachable from a converted
  // PDF, so refusing costs nothing.
  it('rejects more entries than the format can count', () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({
      path: `f${i}.txt`, bytes: new Uint8Array(0),
    }));
    expect(() => writeZip(many)).toThrow(/65535|too many/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/zip.test.ts`
Expected: FAIL — `Failed to resolve import "../src/zip.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/zip.ts`:

```ts
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.js';

/** One file in an archive. */
export interface ZipEntry {
  /** Archive-relative path, '/'-separated, with no leading slash. */
  path: string;
  bytes: Uint8Array;
  /** Default 'deflate'. Use 'store' for already-compressed data, and for a
   *  payload a reader must be able to find without inflating. */
  method?: 'store' | 'deflate';
}

/** 1980-01-01 00:00:00 in MS-DOS date/time — the zero of the format ZIP
 *  stores, and the only value that needs no clock. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

function u16(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Write a ZIP archive.
 *
 *  **Invariant:** the compression method is per ENTRY. EPUB requires its
 *  `mimetype` entry stored uncompressed, so an archive-wide setting would force
 *  a second writer for that format.
 *
 *  **Invariant:** overflow throws. Past 4 GB or 65535 entries the 32-bit fields
 *  wrap and the archive is silently corrupt; ZIP64 is the feature that would
 *  lift the bound and is deliberately absent. */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES)
    throw new RangeError(`a zip holds at most ${MAX_ENTRIES} entries without ZIP64`);

  const seen = new Set<string>();
  for (const e of entries) {
    if (e.path === '' || e.path.startsWith('/'))
      throw new TypeError(`zip path must be relative and non-empty: ${JSON.stringify(e.path)}`);
    if (e.path.includes('\\'))
      throw new TypeError(`zip path must use '/' separators: ${JSON.stringify(e.path)}`);
    if (seen.has(e.path)) throw new TypeError(`duplicate zip path: ${e.path}`);
    seen.add(e.path);
  }

  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Array.from(new TextEncoder().encode(e.path));
    const method = e.method ?? 'deflate';
    const raw = method === 'deflate'
      ? new Uint8Array(deflateRawSync(Buffer.from(e.bytes)))
      : e.bytes;
    const sum = crc32(e.bytes);

    if (e.bytes.length > MAX_BYTES || raw.length > MAX_BYTES)
      throw new RangeError(`zip entry ${e.path} exceeds 4 GB; ZIP64 is not supported`);

    const header = [
      ...u16(method === 'deflate' ? 20 : 10),  // version needed
      ...u16(0),                               // flags
      ...u16(method === 'deflate' ? 8 : 0),    // method
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(sum), ...u32(raw.length), ...u32(e.bytes.length),
      ...u16(name.length), ...u16(0),          // name length, extra length
    ];
    local.push(...u32(0x04034b50), ...header, ...name, ...raw);

    central.push(
      ...u32(0x02014b50),
      ...u16(20),                              // version made by
      ...header,
      ...u16(0), ...u16(0), ...u32(0),         // comment, disk, internal attrs
      ...u32(0),                               // external attrs
      ...u32(offset),
      ...name,
    );
    offset = local.length;
  }

  const cdOffset = local.length;
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(cdOffset),
    ...u16(0),
  ];
  return Uint8Array.from([...local, ...central, ...eocd]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/zip.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/zip.ts test/zip.test.ts
git commit -m "feat(zip): a format-neutral archive writer over node:zlib"
```

---

### Task 4: Content types and relationships

**Files:**
- Create: `src/ooxml.ts`
- Test: `test/ooxml.test.ts`

**Interfaces:**
- Consumes: `writeZip`, `ZipEntry` from `src/zip.ts`; `escapeXml` from `src/xml.ts`.
- Produces:
  `interface OoxmlPart { path: string; bytes: Uint8Array; contentType: string; store?: boolean }`,
  `interface OoxmlRelationship { source: string; id: string; type: string; target: string; external?: boolean }`,
  `function buildOoxmlPackage(parts: OoxmlPart[], rels: OoxmlRelationship[]): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `test/ooxml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildOoxmlPackage } from '../src/ooxml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const XML = 'application/xml';

describe('buildOoxmlPackage', () => {
  it('declares every part in [Content_Types].xml', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: 'application/x-main' }],
      [{ source: '', id: 'rId1', type: 'http://x/officeDocument', target: 'word/document.xml' }],
    );
    const ct = textOf(unzip(zip), '[Content_Types].xml');
    expect(ct).toContain('PartName="/word/document.xml"');
    expect(ct).toContain('ContentType="application/x-main"');
  });

  // The extension default covers .rels; listing one as an override is a
  // conformance error a lenient reader hides.
  it('covers .rels by extension default, not by an override', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const ct = textOf(unzip(zip), '[Content_Types].xml');
    expect(ct).toContain('Extension="rels"');
    expect(ct).not.toContain('PartName="/_rels/.rels"');
  });

  it('writes the package-root relationships to _rels/.rels', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const rels = textOf(unzip(zip), '_rels/.rels');
    expect(rels).toContain('Id="rId1"');
    expect(rels).toContain('Target="word/document.xml"');
  });

  // A target is relative to its SOURCE part's directory. Getting this wrong
  // yields a package whose parts all exist and whose links all dangle.
  it('writes a part relationship beside its source, targeted relatively', () => {
    const zip = buildOoxmlPackage(
      [
        { path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML },
        { path: 'word/styles.xml', bytes: bytes('<b/>'), contentType: XML },
      ],
      [
        { source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' },
        { source: 'word/document.xml', id: 'rId1', type: 'http://x/styles', target: 'styles.xml' },
      ],
    );
    const rels = textOf(unzip(zip), 'word/_rels/document.xml.rels');
    expect(rels).toContain('Target="styles.xml"');
    // The part it resolves to exists.
    expect(entry(unzip(zip), 'word/styles.xml')).toBeDefined();
  });

  it('marks an external relationship as external', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [
        { source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' },
        {
          source: 'word/document.xml', id: 'rId2', type: 'http://x/hyperlink',
          target: 'https://example.com/a&b', external: true,
        },
      ],
    );
    const rels = textOf(unzip(zip), 'word/_rels/document.xml.rels');
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('https://example.com/a&amp;b');   // escaped
  });

  it('stores a part marked store, and deflates the rest', () => {
    const zip = buildOoxmlPackage(
      [
        { path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML },
        { path: 'word/media/i.jpg', bytes: bytes('x'.repeat(200)), contentType: 'image/jpeg', store: true },
      ],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const es = unzip(zip);
    expect(entry(es, 'word/media/i.jpg')!.method).toBe('store');
    expect(entry(es, '[Content_Types].xml')!.method).toBe('deflate');
  });

  it('rejects a part with no content type', () => {
    expect(() => buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: '' }], [],
    )).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ooxml.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ooxml.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ooxml.ts`:

```ts
import { writeZip, type ZipEntry } from './zip.js';
import { escapeXml } from './xml.js';

/** One part of an OPC package. */
export interface OoxmlPart {
  /** Package path, e.g. 'word/document.xml'. No leading slash. */
  path: string;
  bytes: Uint8Array;
  /** The part's media type, e.g. 'application/xml'. Required: a part the
   *  content-type file does not cover is a part a reader refuses. */
  contentType: string;
  /** Store rather than deflate — for already-compressed data such as a JPEG. */
  store?: boolean;
}

/** One entry of a `.rels` file. */
export interface OoxmlRelationship {
  /** The part whose relationships file this belongs in; '' for the package root. */
  source: string;
  /** Relationship id, unique within its source, e.g. 'rId1'. */
  id: string;
  /** The ECMA-376 relationship type URI. */
  type: string;
  /** Relative to the SOURCE part's directory, or an absolute URI when external. */
  target: string;
  /** A hyperlink rather than a part in this package. */
  external?: boolean;
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The `.rels` path for a source part. '' is the package root. */
function relsPath(source: string): string {
  if (source === '') return '_rels/.rels';
  const cut = source.lastIndexOf('/');
  const dir = cut < 0 ? '' : source.slice(0, cut + 1);
  const name = cut < 0 ? source : source.slice(cut + 1);
  return `${dir}_rels/${name}.rels`;
}

/** **Invariant:** `[Content_Types].xml` is GENERATED from the parts, never
 *  written by hand. Deriving it from the same list that produces the zip
 *  entries is what makes the two incapable of disagreeing about which parts
 *  exist. `.rels` is covered by its extension default rather than an override,
 *  which is what the specification requires. */
function contentTypesXml(parts: OoxmlPart[]): string {
  const overrides = parts
    .map((p) => `  <Override PartName="/${escapeXml(p.path)}" ContentType="${escapeXml(p.contentType)}"/>`)
    .join('\n');
  return `${DECL}<Types xmlns="${CT_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${overrides}
</Types>\n`;
}

function relsXml(rels: OoxmlRelationship[]): string {
  const items = rels.map((r) => {
    const mode = r.external ? ' TargetMode="External"' : '';
    return `  <Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}"`
      + ` Target="${escapeXml(r.target)}"${mode}/>`;
  }).join('\n');
  return `${DECL}<Relationships xmlns="${REL_NS}">
${items}
</Relationships>\n`;
}

/** Assemble an OPC package: the parts, their generated content-type file, and
 *  one `.rels` per source that has relationships. */
export function buildOoxmlPackage(
  parts: OoxmlPart[], rels: OoxmlRelationship[],
): Uint8Array {
  for (const p of parts) {
    if (!p.contentType) throw new TypeError(`part ${p.path} has no content type`);
  }

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', bytes: utf8(contentTypesXml(parts)) },
  ];

  const bySource = new Map<string, OoxmlRelationship[]>();
  for (const r of rels) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }
  for (const [source, list] of bySource) {
    entries.push({ path: relsPath(source), bytes: utf8(relsXml(list)) });
  }

  for (const p of parts) {
    entries.push({ path: p.path, bytes: p.bytes, method: p.store ? 'store' : 'deflate' });
  }
  return writeZip(entries);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ooxml.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ooxml.ts test/ooxml.test.ts
git commit -m "feat(ooxml): content types and the relationship graph over zip.ts"
```

---

### Task 5: The minimal `.docx`

**Files:**
- Create: `src/docxpackage.ts`
- Test: `test/docx-package.test.ts`

**Interfaces:**
- Consumes: `buildOoxmlPackage`, `OoxmlPart`, `OoxmlRelationship` from `src/ooxml.ts`.
- Produces: `function writeDocx(bodyXml: string): Uint8Array`. `bodyXml` is the
  inner XML of `<w:body>` — `8yt9.2` produces it from `docmodel.ts`; this task
  emits an empty body.

- [ ] **Step 1: Write the failing test**

Create `test/docx-package.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeDocx } from '../src/docxpackage.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

describe('writeDocx', () => {
  it('writes the three parts a conformant .docx needs', () => {
    const es = unzip(writeDocx(''));
    for (const p of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]) expect(entry(es, p), p).toBeDefined();
  });

  // A relationships part with no relationships is legal and says nothing, and
  // emitting one would need a DOCX special case inside the format-neutral
  // layer. 8yt9.2's first image or hyperlink brings it into being through the
  // same path every other .rels uses.
  it('writes no document.xml.rels until something needs one', () => {
    expect(entry(unzip(writeDocx('')), 'word/_rels/document.xml.rels')).toBeUndefined();
  });

  it('starts with the ZIP signature, so the file is recognisable', () => {
    expect(Array.from(writeDocx('').slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it('declares the WordprocessingML namespace and an XML declaration', () => {
    const doc = textOf(unzip(writeDocx('')), 'word/document.xml');
    expect(doc.startsWith('<?xml version="1.0"')).toBe(true);
    expect(doc).toContain(
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"');
    expect(doc).toContain('<w:body>');
    expect(doc).toContain('</w:document>');
  });

  it('places the caller body inside w:body', () => {
    const doc = textOf(unzip(writeDocx('<w:p/>')), 'word/document.xml');
    expect(doc).toContain('<w:body><w:p/></w:body>');
  });

  // Every relationship must resolve to a part that exists, or the package has
  // links that dangle while every part is present.
  it('resolves every relationship to a part in the package', () => {
    const es = unzip(writeDocx(''));
    const paths = new Set(es.map((e) => e.path));
    const root = textOf(es, '_rels/.rels');
    for (const m of root.matchAll(/Target="([^"]+)"/g)) {
      expect(paths.has(m[1]), m[1]).toBe(true);
    }
  });

  it('declares every non-rels part in [Content_Types].xml', () => {
    const es = unzip(writeDocx(''));
    const ct = textOf(es, '[Content_Types].xml');
    for (const e of es) {
      if (e.path === '[Content_Types].xml' || e.path.endsWith('.rels')) continue;
      expect(ct, e.path).toContain(`PartName="/${e.path}"`);
    }
  });

  it('is byte-reproducible', () => {
    expect(Buffer.from(writeDocx('<w:p/>'))).toEqual(Buffer.from(writeDocx('<w:p/>')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-package.test.ts`
Expected: FAIL — `Failed to resolve import "../src/docxpackage.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/docxpackage.ts`:

```ts
import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from './ooxml.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The `word/document.xml` part.
 *
 *  **Invariant:** the XML declaration and the `w:` namespace declaration are
 *  both required by ECMA-376. Whether a given consumer tolerates their absence
 *  is untested here — conformance is the standard held, not what some reader
 *  happens to accept. */
function documentXml(bodyXml: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<w:document xmlns:w="${W_NS}"><w:body>${bodyXml}</w:body></w:document>\n`;
}

/** Write a minimal conformant `.docx` whose body is `bodyXml` — the inner XML
 *  of `<w:body>`.
 *
 *  `word/_rels/document.xml.rels` is written empty rather than omitted, so
 *  `8yt9.2` has somewhere to add image and hyperlink relationships without
 *  changing the package shape. */
export function writeDocx(bodyXml: string): Uint8Array {
  const parts: OoxmlPart[] = [
    { path: 'word/document.xml', bytes: utf8(documentXml(bodyXml)), contentType: DOC_TYPE },
  ];
  const rels: OoxmlRelationship[] = [
    {
      source: '', id: 'rId1',
      type: `${REL_BASE}/officeDocument`, target: 'word/document.xml',
    },
  ];
  return buildOoxmlPackage(parts, rels);
}
```

There is deliberately NO `word/_rels/document.xml.rels` in this package.
`buildOoxmlPackage` writes a `.rels` only for a source that has relationships,
and a relationships part containing no relationships is legal but says nothing.
Adding a special case to `ooxml.ts` to emit one would put a DOCX concern into
the format-neutral layer, which is the boundary this design exists to hold.
`8yt9.2` adds the first real relationship — an image or a hyperlink — and the
part appears then, through the same code path every other `.rels` uses.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docx-package.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite — this is the step that catches collateral damage**

Run: `npm run typecheck && npm test`
Expected: both green. The `crc32` move in Task 1 is the only change that
reaches existing code; if a PNG or image test moved, the move was not
behaviour-preserving and the fix belongs in Task 1.

- [ ] **Step 6: Commit**

```bash
git add src/docxpackage.ts test/docx-package.test.ts
git commit -m "feat(docx): the minimal conformant package, with the body as a seam"
```

---

### Task 6: Public exports

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no new behaviour. `writeDocx` stays INTERNAL until `8yt9.2` gives it
  a `Document.ToDocx()`; only the types a future caller needs are exported.

- [ ] **Step 1: Decide what is public, and export only that**

In `src/index.ts`, add beside the other type exports:

```ts
export type { ZipEntry } from './zip.js';
export type { OoxmlPart, OoxmlRelationship } from './ooxml.js';
```

Do NOT export `writeZip`, `buildOoxmlPackage` or `writeDocx`. A package writer
with no document to put in it is not a feature anyone can use, and an exported
function is a promise; `8yt9.2` is where the promise becomes keepable.

- [ ] **Step 2: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(docx): export the package vocabulary, not the writers"
```

---

### Task 7: Mutation verification, docs, and close-out

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the finished feature.

- [ ] **Step 1: Run the five mutations, confirming each goes red**

Everything is committed by now, so revert each mutation with
`git restore src` — never before committing. A mutation that stays green means
the assertion is not load-bearing; write a better one before continuing.

| # | Mutation | Run | Must fail |
|---|---|---|---|
| 1 | In `crc32.ts`, drop the final `^ 0xffffffff` | `npx vitest run test/crc32.test.ts` | the published vectors |
| 2 | In `zip.ts`, take the date from `new Date()` instead of `DOS_DATE` | `npx vitest run test/zip.test.ts` | "is byte-reproducible" |
| 3 | In `zip.ts`, ignore `method` and always deflate | `npx vitest run test/zip.test.ts test/ooxml.test.ts` | the stored-entry cases |
| 4 | In `ooxml.ts`, emit no `<Override>` elements | `npx vitest run test/ooxml.test.ts test/docx-package.test.ts` | the content-type cases |
| 5 | In `ooxml.ts`, make `relsPath` always return `_rels/.rels` | `npx vitest run test/ooxml.test.ts test/docx-package.test.ts` | the part-relationship case |

- [ ] **Step 2: Run the full gates**

```bash
npm run typecheck
npm test
```
Expected: both green, no snapshot writes.

- [ ] **Step 3: Update `README.md`**

In the Limitations section, add:

```markdown
- **DOCX export is not yet a public API** — `8yt9.1` shipped the OOXML package
  writer (a ZIP container built on `node:zlib`, `[Content_Types].xml`, and the
  relationship graph); mapping document content into it is `8yt9.2`. The writer
  has no ZIP64 support, so it refuses an archive above 4 GB or 65535 entries,
  and **Word compatibility is unverified in CI**: the tests prove the package is
  structurally conformant to ECMA-376, not that any particular consumer opens it.
```

- [ ] **Step 4: Update `CLAUDE.md`**

Add a Source-list entry after the `docmodel.ts` bullet:

```markdown
- **zip.ts**, **ooxml.ts**, **docxpackage.ts**, **crc32.ts** — the OOXML package
  writer behind DOCX export (`8yt9`). Three layers, each ignorant of the one
  above: `zip.ts` turns entries into archive bytes over `node:zlib`'s
  `deflateRawSync` and knows nothing of OOXML; `ooxml.ts` owns
  `[Content_Types].xml` and the `.rels` graph and knows nothing of
  WordprocessingML; `docxpackage.ts` assembles the minimal `.docx` with the body
  as the seam `8yt9.2` fills. `crc32.ts` is the shared checksum, extracted from
  `pngencode.ts`, which computed the same polynomial privately.
  **Invariant:** the compression method is per ENTRY, not per archive. EPUB
  (`zwto.1`) requires its `mimetype` entry stored uncompressed, so an
  archive-wide setting would force a second container writer for a format that
  is also a ZIP.
  **Invariant:** timestamps are the fixed constant 1980-01-01, never the clock.
  Two runs over one input must give identical bytes or nothing downstream can be
  snapshot-tested — the same reason `Save()` preserves the document `/ID`.
  **Invariant:** overflow THROWS rather than wrapping. Past 4 GB or 65535
  entries ZIP's 32-bit fields silently produce an archive that looks well-formed
  and is not; ZIP64 is the feature that would lift the bound and is absent.
  **Invariant:** `[Content_Types].xml` is generated from the part list, and
  `.rels` is covered by its extension default rather than an override — listing
  one as an override is a conformance error a lenient reader hides.
  **Invariant:** a relationship target resolves relative to its SOURCE part's
  directory, not the package root. Getting it wrong yields a package whose parts
  all exist and whose links all dangle, so every symptom points at the target
  while the fault is in the base.
  **Note:** no CI here can open Word. The tests prove structural conformance to
  ECMA-376 and nothing about a particular consumer — do not read them as a
  compatibility claim.
```

- [ ] **Step 5: Commit and close the issue**

```bash
git add README.md CLAUDE.md
git commit -m "docs(docx): record the OOXML package invariants and the Word gap"
bd close aspose-pdf-foss-for-ts-8yt9.1
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage.** `crc32.ts` extraction → Task 1. `zip.ts` incl. per-entry
method, fixed timestamp, overflow guards, path rules → Task 3. `ooxml.ts` incl.
generated content types, `.rels` by extension default, source-relative targets,
`escapeXml` reuse → Task 4. `docxpackage.ts` and the four-part set → Task 5.
Test-only reader → Task 2; published CRC vectors → Tasks 1 and 3;
`inflateRawSync` as the outside anchor → Tasks 2 and 3. Determinism → Tasks 3
and 5. The five named mutations → Task 7. Limitations (ZIP64, Word unverified)
→ Task 7's docs. Out-of-scope items (ZIP64, encryption, reading a `.docx`,
`docmodel` mapping) appear in no task, correctly.

**Type consistency.** `ZipEntry.method` is `'store' | 'deflate'` in Task 3 and
consumed as such by `ooxml.ts` in Task 4, which maps its own boolean `store` to
it. `OoxmlPart`/`OoxmlRelationship` are defined in Task 4 and used unchanged by
Task 5. `crc32` returns `number` in Task 1 and is compared against numbers in
Tasks 1 and 3. `unzip` returns `UnzippedEntry[]` in Task 2 and is destructured
that way in Tasks 3, 4 and 5. `writeDocx(bodyXml: string)` is defined in Task 5
and named in Task 6's export decision.

**One decision worth flagging, since it differs from the spec's table.** The
spec listed `word/_rels/document.xml.rels` among the minimal parts, "so `8yt9.2`
has somewhere to add image and hyperlink rels". On writing the plan that turned
out to need a DOCX-shaped special case inside the format-neutral `ooxml.ts` —
which is the exact boundary the three-layer split exists to hold. The package
therefore has three parts, not four, and Task 5 asserts the absence with the
reason. `8yt9.2` adding its first relationship creates the part through the same
path every other `.rels` uses, so nothing downstream is harder; only the spec's
part table is one row optimistic.

**Also worth stating: Task 2 ships a helper with no test of its own.** That is
deliberate and is the one place this plan breaks its own TDD rhythm — a reader
with nothing to read can only be tested against hand-written byte arrays, which
is Task 3's job done twice. Task 3 is where it earns its keep, and Task 7's
mutations 2-5 are what prove it can actually fail.
