# ZIP Reader Under LoadLimits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lazy ZIP reader in `src/zipread.ts` that lists a central directory on open and decodes one entry per `read()`, bounded by `LoadLimits` and refusing what it does not support per entry.

**Architecture:** `openZip(bytes, limits)` finds the end record, walks the central directory (counting records against `maxContainerItems` as produced) and returns a `ZipArchive`. `read(path)` validates the local header, decodes through ONE `InputDecoder` per archive (new `inflateRaw` and `stored` methods), then checks size and CRC-32. A leaf over `inflatebound.js`, `crc32.js`, `loadlimits.js` and `errors.js`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), `node:zlib` (`inflateRawSync`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-zip-reader-design.md`

**On TDD here:** Task 3 writes the whole module, because the rules interlock (a read cannot be tested without an open). Tasks 4–6 then add the rule tests, and each one's RED phase is a MUTATION: delete or weaken the guard named in the step, run the test, confirm it fails, restore. That is this repo's standing practice for proving a test load-bearing, and it is stronger than a test written against missing code, which can only ever fail one way.

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins. `src/zipread.ts` must not import `node:fs` or `fs`.
- ESM with `.js` import specifiers; `strict` TypeScript. `npm run typecheck` and `npm test` both green before closing.
- Errors: only `PdfParseError` (damage), `UnsupportedFeatureError` (unsupported feature), `ResourceLimitError` (a bound), and `RangeError` for an unknown path. No zlib `Error` escapes.
- Every `catch` in `src/` calls `rethrowLimit(e)` as its FIRST statement (`test/limits-catch.test.ts` enforces it); a bindingless `catch {` is not allowed.
- `src/zipread.ts` is NOT exported from `src/index.ts`.
- `test/helpers/unzip.ts` stays independent of `src/` — never import `src/zipread.ts` from it.
- No CHANGELOG entry (nothing public changes until `m2fp.5`).
- Mutation work: after any mutation that HANGS, kill orphaned vitest workers before trusting a later run; confirm each mutation actually applied (a no-op mutation reports green).

## Review Focus

Inputs the spec implies but its test list does not name, most likely first. Each has a test added to the task that owns the code:

1. **A buffer shorter than an end record (0–21 bytes)** — expect `PdfParseError`, never a `RangeError` from reading past the end. → Task 4.
2. **An empty archive (an end record and nothing else)** — expect it to open with zero entries. → Task 3.
3. **A local-header offset pointing past the end of the buffer** — expect `PdfParseError` at `read()`, not a crash. → Task 5.
4. **An absolute or drive-letter name (`/etc/passwd`, `C:\x`)** — expect it returned verbatim and readable only through `read()`. → Task 3.
5. **An archive with bytes PREPENDED (a stub before the first local header)** — the spec puts this out of scope; expect `PdfParseError`, never wrong bytes. → Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/zip.ts` (modify) | Set general-purpose flag bit 11 for a non-ASCII entry name. |
| `src/inflatebound.ts` (modify) | Add `inflateRaw` (RFC 1951) and `stored` to `InputDecoder`. |
| `src/zipread.ts` (create) | `openZip`, `ZipArchive`, `ZipArchiveEntry`: directory walk and lazy read. |
| `test/helpers/zip-bytes.ts` (create) | Byte-level helpers for patching `writeZip` output in tests. |
| `test/zip-writer-utf8.test.ts` (create) | Bit 11 in the writer. |
| `test/inflatebound-raw.test.ts` (create) | `inflateRaw` and `stored`. |
| `test/zipread.test.ts` (create) | Round trip, names, open-time and read-time rules. |
| `test/zipread-limits.test.ts` (create) | Bombs, totals, entry count. |
| `scripts/gen-zip-fixtures.mjs` (create) | Builds the third-party fixtures and their manifest. |
| `test/fixtures/zip/*` (create) | `tar.zip`, `net.zip`, `git.zip`, `manifest.json`, `PROVENANCE.md`. |
| `test/zipread-real.test.ts` (create) | Third-party fixtures against the manifest. |
| `package.json` (modify) | `gen:zip` script. |
| `CLAUDE.md`, the spec (modify) | Source-list entry, fixture-table row, spec amendments. |

---

### Task 1: `writeZip` sets flag bit 11 for a non-ASCII name

The writer encodes names as UTF-8 but never sets bit 11, so by APPNOTE 4.4.4 a conforming reader decodes them as CP437. ASCII names keep flags 0, which keeps every DOCX and EPUB we write byte-identical.

**Files:**
- Modify: `src/zip.ts:58-78`
- Test: `test/zip-writer-utf8.test.ts`

**Interfaces:**
- Consumes: `writeZip(entries: ZipEntry[]): Uint8Array`
- Produces: archives whose local and central headers carry `0x0800` in the flags field iff the name has a code point above U+007F.

- [ ] **Step 1: Write the failing test**

```ts
// test/zip-writer-utf8.test.ts
import { describe, it, expect } from 'vitest';
import { writeZip } from '../src/zip.js';

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The flags of the one entry, from its local header and its central record. */
function flagsOf(zip: Uint8Array): { local: number; central: number } {
  const cd = u32(zip, zip.length - 22 + 16);
  return { local: u16(zip, 6), central: u16(zip, cd + 8) };
}

describe('writeZip marks a UTF-8 name with general-purpose bit 11', () => {
  it('sets bit 11 in both headers for a non-ASCII name', () => {
    const zip = writeZip([{ path: 'café.txt', bytes: new Uint8Array([1]) }]);
    expect(flagsOf(zip)).toEqual({ local: 0x0800, central: 0x0800 });
  });

  it('leaves the flags 0 for an ASCII name, so existing output is byte-identical', () => {
    const zip = writeZip([{ path: 'word/document.xml', bytes: new Uint8Array([1]) }]);
    expect(flagsOf(zip)).toEqual({ local: 0, central: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/zip-writer-utf8.test.ts`
Expected: FAIL — the first case reports `{ local: 0, central: 0 }`.

- [ ] **Step 3: Implement**

In `src/zip.ts`, inside the `for (const e of entries)` loop, after `const sum = crc32(e.bytes);` add:

```ts
    // APPNOTE 4.4.4: without bit 11 a reader must decode the name as CP437, so
    // a UTF-8 name needs it. Only a non-ASCII name sets it, which keeps every
    // archive of ASCII paths — every DOCX and EPUB we write — byte-identical.
    const flags = /[^\x00-\x7f]/.test(e.path) ? 0x0800 : 0;
```

and in the shared `header` array replace the line `...u16(0),                               // flags` with:

```ts
      ...u16(flags),                           // flags
```

- [ ] **Step 4: Run tests to verify they pass, and that the identity fences did not move**

Run: `npx vitest run test/zip-writer-utf8.test.ts test/docx-flow-identity.test.ts test/zip.test.ts test/epub`
Expected: all PASS. (If `test/zip.test.ts` does not exist, drop it from the command; `ls test/zip*` to check.)

- [ ] **Step 5: Commit**

```bash
git add src/zip.ts test/zip-writer-utf8.test.ts
git commit -m "fix(m2fp.1): writeZip sets flag bit 11 for a UTF-8 entry name"
```

---

### Task 2: `InputDecoder.inflateRaw` and `InputDecoder.stored`

**Files:**
- Modify: `src/inflatebound.ts:26` (import) and after `brotli` (new methods)
- Test: `test/inflatebound-raw.test.ts`

**Interfaces:**
- Consumes: `InputDecoder(limits?: LoadLimits, what?: string)`, private `run(input, declared, decode)`
- Produces:
  - `inflateRaw(input: Uint8Array, declared?: number): Uint8Array` — raw DEFLATE; a declaration past the bounds is `ResourceLimitError` BEFORE inflating; output past a smaller declaration is `PdfParseError`; corrupt data rethrows zlib's own `Error` (the caller wraps it).
  - `stored(input: Uint8Array): Uint8Array` — returns a COPY; bounded and charged like any decode.

- [ ] **Step 1: Write the failing test**

```ts
// test/inflatebound-raw.test.ts
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { InputDecoder } from '../src/inflatebound.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';

const raw = (b: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(Buffer.from(b)));

describe('InputDecoder.inflateRaw', () => {
  it('decodes raw DEFLATE, which the zlib-wrapped inflate cannot', () => {
    const src = new TextEncoder().encode('hello raw deflate '.repeat(20));
    expect(new InputDecoder().inflateRaw(raw(src), src.length)).toEqual(src);
  });

  it('refuses a declaration past the bounds before inflating anything', () => {
    // Garbage input: if it inflated first, this would be a zlib error instead.
    const d = new InputDecoder(LoadLimits.defaults.with({ maxDecodedStreamBytes: 1000 }));
    expect(() => d.inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 5000))
      .toThrow(ResourceLimitError);
  });

  it('reads output past a smaller declaration as damage', () => {
    const src = new Uint8Array(10_000);
    expect(() => new InputDecoder().inflateRaw(raw(src), 100)).toThrow(PdfParseError);
  });

  it('lets corrupt data surface as an ordinary error for the caller to wrap', () => {
    let caught: unknown;
    try { new InputDecoder().inflateRaw(new Uint8Array([0xff, 0x00, 0x00]), 10); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ResourceLimitError);
    expect(caught).not.toBeInstanceOf(PdfParseError);
  });
});

describe('InputDecoder.stored', () => {
  it('returns a copy, not a view of the caller buffer', () => {
    const src = new Uint8Array([1, 2, 3]);
    const out = new InputDecoder().stored(src);
    src[0] = 9;
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('charges the running total like a decode', () => {
    const d = new InputDecoder(LoadLimits.defaults.with({ maxTotalDecodedBytes: 5 }));
    d.stored(new Uint8Array(3));
    expect(() => d.stored(new Uint8Array(3))).toThrow(ResourceLimitError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inflatebound-raw.test.ts`
Expected: FAIL — `d.inflateRaw is not a function`.

- [ ] **Step 3: Implement**

In `src/inflatebound.ts` change the import line to:

```ts
import { inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
```

and add after the `brotli` method:

```ts
  /** Raw DEFLATE (RFC 1951), as a ZIP entry uses — no zlib header or trailer. */
  inflateRaw(input: Uint8Array, declared?: number): Uint8Array {
    return this.run(input, declared, (cap) => new Uint8Array(
      inflateRawSync(view(input), Number.isFinite(cap) ? { maxOutputLength: Math.max(1, cap + 1) } : {})));
  }

  /** Bytes stored uncompressed. Nothing to decode, but still bounded and
   *  charged, so a stored ZIP entry cannot escape the total a deflated one is
   *  held to. A COPY, so the caller cannot mutate the archive through it. */
  stored(input: Uint8Array): Uint8Array {
    return this.run(input, undefined, () => input.slice());
  }
```

Also extend the module doc comment's first line to read `/** Decompression for input files that are NOT PDF — PNG, TIFF, WOFF, WOFF2, ZIP —`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inflatebound-raw.test.ts test/limits-inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inflatebound.ts test/inflatebound-raw.test.ts
git commit -m "feat(m2fp.1): InputDecoder.inflateRaw and stored for ZIP entries"
```

---

### Task 3: `src/zipread.ts` — the module, the round trip, and names

**Files:**
- Create: `src/zipread.ts`
- Create: `test/helpers/zip-bytes.ts`
- Test: `test/zipread.test.ts`

**Interfaces:**
- Consumes: `InputDecoder.inflateRaw`, `InputDecoder.stored` (Task 2); `crc32(bytes: Uint8Array): number`; `LoadLimits.enforce(field, reached, detail?)`; `writeZip` with bit 11 (Task 1).
- Produces (later tasks rely on these exact names):
  - `export interface ZipArchiveEntry { readonly path: string; readonly method: number; readonly compressedSize: number; readonly size: number; readonly encrypted: boolean }`
  - `export interface ZipArchive { readonly entries: readonly ZipArchiveEntry[]; has(path: string): boolean; read(path: string): Uint8Array }`
  - `export function openZip(bytes: Uint8Array, limits?: LoadLimits): ZipArchive`
  - test helpers: `u16`, `u32`, `put16`, `put32`, `layout(zip): { eocd: number; central: number[]; local: number[] }`, `enc`, `dec`.

- [ ] **Step 1: Write the test helpers**

```ts
// test/helpers/zip-bytes.ts
/** Byte-level access to a `writeZip` archive, for tests that patch one field.
 *  `writeZip` writes no archive comment, so its end record is the last 22 bytes. */
export const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
export const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
export function put16(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
}
export function put32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff;
}
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Where the end record, each central record and each local header sit. */
export function layout(zip: Uint8Array): { eocd: number; central: number[]; local: number[] } {
  const eocd = zip.length - 22;
  const central: number[] = [];
  let at = u32(zip, eocd + 16);
  for (let i = 0; i < u16(zip, eocd + 10); i++) {
    central.push(at);
    at += 46 + u16(zip, at + 28) + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return { eocd, central, local: central.map((c) => u32(zip, c + 42)) };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/zipread.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openZip } from '../src/zipread.js';
import { writeZip } from '../src/zip.js';
import { enc, dec, layout } from './helpers/zip-bytes.js';

describe('openZip reads what writeZip writes', () => {
  const zip = writeZip([
    { path: 'a.txt', bytes: enc('alpha '.repeat(100)) },
    { path: 'raw.bin', bytes: new Uint8Array([0, 1, 2, 255]), method: 'store' },
    { path: 'empty.txt', bytes: new Uint8Array(0) },
    { path: 'dir/', bytes: new Uint8Array(0), method: 'store' },
    { path: 'dir/café.txt', bytes: enc('ünïcode') },
  ]);

  it('lists every entry in central-directory order', () => {
    const z = openZip(zip);
    expect(z.entries.map((e) => e.path))
      .toEqual(['a.txt', 'raw.bin', 'empty.txt', 'dir/', 'dir/café.txt']);
    expect(z.entries[0]).toMatchObject({ method: 8, size: 600, encrypted: false });
    expect(z.entries[1]).toMatchObject({ method: 0, size: 4, compressedSize: 4 });
  });

  it('reads deflated, stored, empty and UTF-8-named entries back', () => {
    const z = openZip(zip);
    expect(dec(z.read('a.txt'))).toBe('alpha '.repeat(100));
    expect(Array.from(z.read('raw.bin'))).toEqual([0, 1, 2, 255]);
    expect(z.read('empty.txt').length).toBe(0);
    expect(dec(z.read('dir/café.txt'))).toBe('ünïcode');
  });

  it('reads a directory entry as empty bytes', () => {
    expect(openZip(zip).read('dir/').length).toBe(0);
  });

  it('answers has() and refuses an unknown path as a caller error', () => {
    const z = openZip(zip);
    expect(z.has('a.txt')).toBe(true);
    expect(z.has('nope')).toBe(false);
    expect(() => z.read('nope')).toThrow(RangeError);
  });

  it('opens an archive holding no entries at all', () => {
    expect(openZip(writeZip([])).entries).toEqual([]);
  });
});

describe('entry names', () => {
  it('decodes a name without bit 11 as CP437', () => {
    const zip = writeZip([{ path: 'x.txt', bytes: enc('1') }]);
    const { central, local } = layout(zip);
    // 0x82 is é and 0xE1 is ß in CP437 (APPNOTE Appendix D); patch both headers,
    // since the local name must equal the central one byte for byte.
    for (const at of [central[0] + 46, local[0] + 30]) zip[at] = 0x82;
    const z = openZip(zip);
    expect(z.entries[0].path).toBe('é.txt');
    expect(dec(z.read('é.txt'))).toBe('1');
    zip[central[0] + 46] = 0xe1; zip[local[0] + 30] = 0xe1;
    expect(openZip(zip).entries[0].path).toBe('ß.txt');
  });

  it('maps all 128 high CP437 bytes to 128 distinct single characters', () => {
    const zip = writeZip([{ path: 'x', bytes: enc('1') }]);
    const { central, local } = layout(zip);
    const seen = new Set<string>();
    for (let b = 0x80; b <= 0xff; b++) {
      zip[central[0] + 46] = b; zip[local[0] + 30] = b;
      const name = openZip(zip).entries[0].path;
      expect(name.length).toBe(1);
      seen.add(name);
    }
    expect(seen.size).toBe(128);
  });

  it('returns traversal, absolute and drive-letter names verbatim', () => {
    const paths = ['../../evil.txt', '/etc/passwd', 'C:\\x.txt'];
    // writeZip refuses these, so write safe names of the same length and patch.
    const zip = writeZip(paths.map((p, i) => ({ path: `n${i}`.padEnd(p.length, '_'), bytes: enc(p) })));
    const { central, local } = layout(zip);
    paths.forEach((p, i) => {
      const bytes = enc(p);
      zip.set(bytes, central[i] + 46);
      zip.set(bytes, local[i] + 30);
    });
    const z = openZip(zip);
    expect(z.entries.map((e) => e.path)).toEqual(paths);
    paths.forEach((p) => expect(dec(z.read(p))).toBe(p));
  });

  it('touches no filesystem: the module imports no fs', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'zipread.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"](node:)?fs(\/promises)?['"]/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/zipread.test.ts`
Expected: FAIL — cannot resolve `../src/zipread.js`.

- [ ] **Step 4: Write the module**

```ts
// src/zipread.ts
/** Reading a ZIP archive (`m2fp.1`), for the DOCX importer's package layer.
 *  Note the direction: `zip.ts` WRITES archives and shares no code with this.
 *
 *  **Invariant:** LAZY. `openZip` reads the central directory and nothing
 *  else; an entry is decoded, charged and CRC-checked when it is READ. A DOCX
 *  pays for the parts its importer opens, and a bomb in an entry nobody reads
 *  costs nothing.
 *
 *  **Invariant:** ONE `InputDecoder` per archive, so every read is charged to
 *  one `maxTotalDecodedBytes` total — an archive cannot do in many entries what
 *  it may not in one. There is no result cache: reading an entry twice decodes
 *  and charges it twice, and what to keep is the caller's decision.
 *
 *  **Invariant:** the entry count is enforced against `maxContainerItems` as
 *  records are PRODUCED from the directory, never from the count the end record
 *  DECLARES. A declaration that disagrees with the directory is damage.
 *
 *  **Invariant:** sizes, CRC and flags come from the CENTRAL directory, never
 *  the local header — which is what makes a data descriptor (flag bit 3) work,
 *  whose local header carries zeros. The local header's OWN name and extra
 *  lengths locate the data, since its extra field legitimately differs from
 *  the central one (libarchive writes 32 bytes locally and 24 centrally).
 *
 *  **Invariant:** two ZIP-confusion shapes are refused as damage, because two
 *  readers would pick different bytes: a DUPLICATE name, and a local header
 *  naming a different file from its central record.
 *
 *  **Invariant:** an unsupported feature refuses the ENTRY at `read()` —
 *  encryption, a method other than stored or deflate, a ZIP64 size — so the
 *  rest of the archive stays readable. Only what hides the directory itself,
 *  a ZIP64 end record or a multi-disk archive, refuses at open.
 *
 *  **Invariant:** names are returned VERBATIM. Nothing here touches a
 *  filesystem, so `../x` is only a string.
 *
 *  A leaf over `inflatebound.js`, `crc32.js`, `loadlimits.js` and `errors.js`. */
import { InputDecoder } from './inflatebound.js';
import { crc32 } from './crc32.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError, UnsupportedFeatureError, rethrowLimit } from './errors.js';

/** One entry as the central directory describes it. */
export interface ZipArchiveEntry {
  readonly path: string;
  /** The raw APPNOTE method number: 0 stored, 8 deflate, anything else refused at read. */
  readonly method: number;
  readonly compressedSize: number;
  /** The DECLARED uncompressed size; a read that disagrees is damage. */
  readonly size: number;
  readonly encrypted: boolean;
}

export interface ZipArchive {
  /** In central-directory order. */
  readonly entries: readonly ZipArchiveEntry[];
  has(path: string): boolean;
  /** Decode one entry. `RangeError` for a path the archive does not hold. */
  read(path: string): Uint8Array;
}

interface Entry extends ZipArchiveEntry {
  readonly crc: number;
  readonly local: number;
  readonly nameBytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_LEN = 22;
const CEN_LEN = 46;
const LOC_LEN = 30;
const MAX_COMMENT = 0xffff;
const U32_SENTINEL = 0xffffffff;

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** CP437's upper half, 0x80..0xFF (APPNOTE Appendix D) — the encoding a name
 *  without flag bit 11 is in. The lower half is ASCII. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' + 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' + 'áíóúñÑªº¿⌐¬½¼¡«»' + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' + 'αßΓπΣσµτΦΘΩδ∞φε∩' + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function decodeName(b: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(b);
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The end record: prefer one whose comment ends EXACTLY at the end of the
 *  buffer, so a signature inside a comment cannot win; else the one nearest
 *  the end, so trailing junk costs the junk. -1 when there is none. */
function findEocd(b: Uint8Array): number {
  const lowest = Math.max(0, b.length - EOCD_LEN - MAX_COMMENT);
  let nearest = -1;
  for (let i = b.length - EOCD_LEN; i >= lowest; i--) {
    if (u32(b, i) !== EOCD_SIG) continue;
    if (i + EOCD_LEN + u16(b, i + 20) === b.length) return i;
    if (nearest < 0) nearest = i;
  }
  return nearest;
}

function notZip(b: Uint8Array): PdfParseError {
  const ole = b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  return new PdfParseError(ole
    ? 'not a ZIP archive: this is an OLE compound file, which is how Office stores an ENCRYPTED or a legacy (.doc) document'
    : 'not a ZIP archive: no end-of-central-directory record');
}

export function openZip(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): ZipArchive {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw notZip(bytes);

  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  // A count of 0xFFFF alone is NOT treated as ZIP64: `writeZip` writes exactly
  // that for 65,535 entries. The locator, or a 32-bit sentinel, is the signal.
  if ((eocd >= 20 && u32(bytes, eocd - 20) === ZIP64_LOCATOR_SIG)
      || cdSize === U32_SENTINEL || cdOffset === U32_SENTINEL)
    throw new UnsupportedFeatureError('ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw new UnsupportedFeatureError('multi-disk ZIP archives are not supported');
  if (cdOffset + cdSize > eocd)
    throw new PdfParseError('ZIP central directory runs past the end record', cdOffset);

  const entries: Entry[] = [];
  const index = new Map<string, Entry>();
  const end = cdOffset + cdSize;
  let at = cdOffset;
  while (at < end) {
    if (at + CEN_LEN > end || u32(bytes, at) !== CEN_SIG)
      throw new PdfParseError('bad ZIP central directory record', at);
    limits.enforce('maxContainerItems', entries.length + 1, 'ZIP central directory');
    const flags = u16(bytes, at + 8);
    const nameLen = u16(bytes, at + 28);
    const next = at + CEN_LEN + nameLen + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (next > end) throw new PdfParseError('ZIP central directory record runs past the directory', at);
    const nameBytes = bytes.slice(at + CEN_LEN, at + CEN_LEN + nameLen);
    const path = decodeName(nameBytes, (flags & 0x0800) !== 0);
    if (index.has(path)) throw new PdfParseError(`duplicate ZIP entry name ${JSON.stringify(path)}`, at);
    const e: Entry = {
      path,
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      size: u32(bytes, at + 24),
      encrypted: (flags & 0x0001) !== 0,
      crc: u32(bytes, at + 16),
      local: u32(bytes, at + 42),
      nameBytes,
    };
    entries.push(e);
    index.set(path, e);
    at = next;
  }
  if (entries.length !== total)
    throw new PdfParseError(`ZIP end record declares ${total} entries and the directory holds ${entries.length}`);

  const decoder = new InputDecoder(limits, 'ZIP entry');
  const read = (path: string): Uint8Array => {
    const e = index.get(path);
    if (e === undefined) throw new RangeError(`no ZIP entry ${JSON.stringify(path)}`);
    if (e.encrypted) throw new UnsupportedFeatureError(`ZIP entry ${path} is encrypted`);
    if (e.method !== 0 && e.method !== 8)
      throw new UnsupportedFeatureError(
        `ZIP entry ${path} uses compression method ${e.method}; only stored (0) and deflate (8) are supported`);
    if (e.compressedSize === U32_SENTINEL || e.size === U32_SENTINEL || e.local === U32_SENTINEL)
      throw new UnsupportedFeatureError(`ZIP entry ${path} needs ZIP64`);

    const lo = e.local;
    if (lo + LOC_LEN > bytes.length || u32(bytes, lo) !== LOC_SIG)
      throw new PdfParseError(`ZIP entry ${path}: no local header where the directory points`, lo);
    const nameLen = u16(bytes, lo + 26);
    const extraLen = u16(bytes, lo + 28);
    if (!sameBytes(bytes.subarray(lo + LOC_LEN, lo + LOC_LEN + nameLen), e.nameBytes))
      throw new PdfParseError(`ZIP entry ${path}: local header names a different file`, lo);
    const dataAt = lo + LOC_LEN + nameLen + extraLen;
    if (dataAt + e.compressedSize > bytes.length)
      throw new PdfParseError(`ZIP entry ${path}: data runs past the end of the archive`, dataAt);
    const data = bytes.subarray(dataAt, dataAt + e.compressedSize);

    let out: Uint8Array;
    try {
      out = e.method === 8 ? decoder.inflateRaw(data, e.size) : decoder.stored(data);
    } catch (err) {
      rethrowLimit(err);
      if (err instanceof PdfParseError) throw err;
      throw new PdfParseError(`ZIP entry ${path}: corrupt deflate data (${(err as Error).message})`, dataAt);
    }
    if (out.length !== e.size)
      throw new PdfParseError(`ZIP entry ${path}: decodes to ${out.length} bytes and declares ${e.size}`, dataAt);
    if (crc32(out) !== e.crc) throw new PdfParseError(`ZIP entry ${path}: CRC-32 mismatch`, dataAt);
    return out;
  };

  const publicEntries: readonly ZipArchiveEntry[] = entries.map(
    ({ path, method, compressedSize, size, encrypted }) => ({ path, method, compressedSize, size, encrypted }));
  return { entries: publicEntries, has: (path) => index.has(path), read };
}
```

- [ ] **Step 5: Run the tests and the catch scan**

Run: `npx vitest run test/zipread.test.ts test/limits-catch.test.ts test/import-cycles.test.ts`
Expected: PASS. If the CP437 distinct-count case fails, count `CP437_HIGH` (`node -e "console.log([...'<paste>'].length)"`) — it must be exactly 128 UTF-16 units, one per byte.

- [ ] **Step 6: Commit**

```bash
git add src/zipread.ts test/helpers/zip-bytes.ts test/zipread.test.ts
git commit -m "feat(m2fp.1): lazy ZIP reader over the central directory"
```

---

### Task 4: open-time rules — end record, ZIP64, damage, duplicates

**Files:**
- Test: `test/zipread.test.ts` (append)

**Interfaces:**
- Consumes: `openZip`, test helpers from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Append the tests**

```ts
// test/zipread.test.ts — append; add to the imports:
//   import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
//   import { put16, put32 } from './helpers/zip-bytes.js';

const two = (): Uint8Array => writeZip([
  { path: 'a.txt', bytes: enc('alpha') },
  { path: 'b.txt', bytes: enc('bravo') },
]);

/** Append an archive comment of `text` and fix the end record to own it. */
function withComment(zip: Uint8Array, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip.length + comment.length);
  out.set(zip); out.set(comment, zip.length);
  put16(out, zip.length - 22 + 20, comment.length);
  return out;
}

describe('finding the end record', () => {
  it('refuses a buffer too short to hold one, as damage', () => {
    for (let n = 0; n < 22; n++) expect(() => openZip(new Uint8Array(n))).toThrow(PdfParseError);
  });

  it('names an OLE compound file, which is what an encrypted .docx is', () => {
    const ole = new Uint8Array(600);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => openZip(ole)).toThrow(/OLE compound file/);
  });

  it('prefers the record whose comment ends exactly at the end, over a fake inside the comment', () => {
    const fake = new Uint8Array(22);
    put32(fake, 0, 0x06054b50);
    put16(fake, 8, 1); put16(fake, 10, 1);
    put32(fake, 12, 46); put32(fake, 16, 0xdead);
    put16(fake, 20, 5);                         // its own comment would overrun
    const z = openZip(withComment(two(), fake));
    expect(dec(z.read('b.txt'))).toBe('bravo');
  });

  it('reads past trailing junk the end record does not own', () => {
    const zip = two();
    const junk = new Uint8Array(zip.length + 10);
    junk.set(zip);
    expect(dec(openZip(junk).read('a.txt'))).toBe('alpha');
  });

  it('refuses an archive with a stub prepended, as damage rather than wrong bytes', () => {
    const zip = two();
    const stubbed = new Uint8Array(zip.length + 64);
    stubbed.set(zip, 64);                       // offsets in it now point 64 bytes early
    expect(() => {
      const z = openZip(stubbed);
      z.entries.forEach((e) => z.read(e.path));
    }).toThrow(PdfParseError);
  });
});

describe('what refuses the whole archive', () => {
  it('refuses a ZIP64 locator before the end record', () => {
    const zip = two();
    put32(zip, layout(zip).eocd - 20, 0x07064b50);
    expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
  });

  it('refuses a 32-bit sentinel for the directory offset or size', () => {
    for (const field of [12, 16]) {
      const zip = two();
      put32(zip, layout(zip).eocd + field, 0xffffffff);
      expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
    }
  });

  it('refuses a multi-disk archive', () => {
    const zip = two();
    put16(zip, layout(zip).eocd + 4, 1);
    expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
  });

  it('reads a declared count that disagrees with the directory as damage', () => {
    for (const n of [1, 3]) {
      const zip = two();
      const { eocd } = layout(zip);
      put16(zip, eocd + 8, n); put16(zip, eocd + 10, n);
      expect(() => openZip(zip)).toThrow(/declares/);
    }
  });

  it('refuses a directory size that runs past the end record', () => {
    const zip = two();
    const { eocd } = layout(zip);
    put32(zip, eocd + 12, zip.length);
    expect(() => openZip(zip)).toThrow(PdfParseError);
  });

  it('refuses a directory record whose name runs past the directory', () => {
    const zip = two();
    const { central } = layout(zip);
    put16(zip, central[1] + 28, 500);
    expect(() => openZip(zip)).toThrow(PdfParseError);
  });

  it('refuses a duplicate name, the shape in which two readers pick different bytes', () => {
    const zip = two();
    const { central, local } = layout(zip);
    zip[central[1] + 46] = 0x61; zip[local[1] + 30] = 0x61;   // b.txt -> a.txt
    expect(() => openZip(zip)).toThrow(/duplicate/);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/zipread.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation-check each rule (RED phase)**

For each row, apply the mutation to `src/zipread.ts`, confirm the mutation applied (`git diff src/zipread.ts` non-empty), run `npx vitest run test/zipread.test.ts`, confirm the named case FAILS, then `git checkout src/zipread.ts`.

| Mutation | Must fail |
|---|---|
| In `findEocd`, delete the line `if (i + EOCD_LEN + u16(b, i + 20) === b.length) return i;` | "prefers the record whose comment ends exactly…" |
| In `findEocd`, change `if (nearest < 0) nearest = i;` to `if (nearest < 0) { nearest = i; break; }` | none expected to change the trailing-junk case; record the result |
| Replace the `notZip` OLE test with `const ole = false;` | "names an OLE compound file…" |
| Delete the `ZIP64_LOCATOR_SIG` half of the ZIP64 condition | "refuses a ZIP64 locator…" |
| Delete the `disk !== 0 \|\| cdDisk !== 0 \|\| onDisk !== total` check | "refuses a multi-disk archive" |
| Delete the `entries.length !== total` check | "reads a declared count that disagrees…" |
| Delete the `if (next > end)` check | "refuses a directory record whose name runs past…" |
| Delete the `index.has(path)` duplicate check | "refuses a duplicate name…" |

Record in the commit message any mutation that stays GREEN (the second row may — it only changes which non-exact candidate wins when there are two).

- [ ] **Step 4: Commit**

```bash
git add test/zipread.test.ts
git commit -m "test(m2fp.1): open-time rules for the ZIP reader, mutation-checked"
```

---

### Task 5: read-time rules — per-entry refusals and damage

**Files:**
- Test: `test/zipread.test.ts` (append)

**Interfaces:**
- Consumes: `openZip`, helpers, the `two()` builder from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Append the tests**

```ts
// test/zipread.test.ts — append

/** Apply `patch` to b.txt, then assert its read throws `err` and a.txt still reads. */
function refusesOnlyB(patch: (zip: Uint8Array, l: ReturnType<typeof layout>) => void,
  err: typeof PdfParseError | typeof UnsupportedFeatureError, msg?: RegExp): void {
  const zip = two();
  patch(zip, layout(zip));
  const z = openZip(zip);
  expect(() => z.read('b.txt')).toThrow(err);
  if (msg) expect(() => z.read('b.txt')).toThrow(msg);
  expect(dec(z.read('a.txt'))).toBe('alpha');
}

describe('what refuses one entry and leaves the rest readable', () => {
  it('an encrypted entry', () =>
    refusesOnlyB((z, l) => put16(z, l.central[1] + 8, 1), UnsupportedFeatureError, /encrypted/));

  it('a compression method other than stored or deflate', () =>
    refusesOnlyB((z, l) => put16(z, l.central[1] + 10, 12), UnsupportedFeatureError, /method 12/));

  it('a per-entry ZIP64 sentinel', () =>
    refusesOnlyB((z, l) => put32(z, l.central[1] + 20, 0xffffffff), UnsupportedFeatureError, /ZIP64/));

  it('a missing local header', () =>
    refusesOnlyB((z, l) => put32(z, l.local[1], 0), PdfParseError, /local header/));

  it('a local-header offset past the end of the buffer', () =>
    refusesOnlyB((z, l) => put32(z, l.central[1] + 42, z.length + 100), PdfParseError));

  it('a local header naming a different file', () =>
    refusesOnlyB((z, l) => { z[l.local[1] + 30] = 0x7a; }, PdfParseError, /different file/));

  it('a CRC-32 that does not match', () =>
    refusesOnlyB((z, l) => put32(z, l.central[1] + 16, 0x12345678), PdfParseError, /CRC/));

  it('corrupt deflate data, wrapped as damage rather than a zlib error', () =>
    refusesOnlyB((z, l) => { z[l.local[1] + 30 + 5] = 0xff; }, PdfParseError, /corrupt deflate|CRC|decodes to/));

  it('a stored entry whose declared size disagrees with its bytes', () => {
    const zip = writeZip([
      { path: 'a.txt', bytes: enc('alpha') },
      { path: 'b.txt', bytes: enc('bravo'), method: 'store' },
    ]);
    const l = layout(zip);
    put32(zip, l.central[1] + 24, 6);
    const z = openZip(zip);
    expect(() => z.read('b.txt')).toThrow(/declares 6/);
    expect(dec(z.read('a.txt'))).toBe('alpha');
  });
});

describe('the central directory is the authority for sizes', () => {
  it('reads a data-descriptor entry whose local header carries zeros', () => {
    const zip = two();
    const { central, local } = layout(zip);
    put16(zip, central[1] + 8, 0x0008); put16(zip, local[1] + 6, 0x0008);
    put32(zip, local[1] + 14, 0); put32(zip, local[1] + 18, 0); put32(zip, local[1] + 22, 0);
    expect(dec(openZip(zip).read('b.txt'))).toBe('bravo');
  });
});
```

Note on `corrupt deflate data`: byte 5 of the local header region past offset 30 is inside the name for `b.txt` (5 bytes), so `local[1] + 30 + 5` is the FIRST data byte. `0xff` sets BFINAL and block type 3, which DEFLATE reserves, so zlib raises a data error. The regex also admits CRC and size failures in case a zlib build tolerates it; the assertion that matters is that it is a `PdfParseError`.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/zipread.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation-check each rule (RED phase)**

Same procedure as Task 4 Step 3.

| Mutation | Must fail |
|---|---|
| Delete the `if (e.encrypted)` line | "an encrypted entry" |
| Change `e.method !== 0 && e.method !== 8` to `false` | "a compression method other than…" |
| Delete the per-entry `U32_SENTINEL` check | "a per-entry ZIP64 sentinel" |
| Delete the `sameBytes` name check | "a local header naming a different file" |
| Delete the `crc32(out) !== e.crc` check | "a CRC-32 that does not match" |
| Replace `throw new PdfParseError(\`ZIP entry ${path}: corrupt deflate…\`)` with `throw err;` | "corrupt deflate data…" |
| Delete the `out.length !== e.size` check | "a stored entry whose declared size disagrees…" |
| Read sizes from the local header: change `e.compressedSize` in the `data` subarray to `u32(bytes, lo + 18)` | "reads a data-descriptor entry…" |
| Delete `lo + LOC_LEN > bytes.length \|\|` from the local-header check | "a local-header offset past the end…" (record if it stays green — `u32` past the end reads `undefined` bits as 0, so the signature test may still reject it: a REDUNDANT DEFENCE) |

- [ ] **Step 4: Commit**

```bash
git add test/zipread.test.ts
git commit -m "test(m2fp.1): read-time refusals leave sibling entries readable"
```

---

### Task 6: limits — entry count, bombs, the per-archive total

**Files:**
- Test: `test/zipread-limits.test.ts`

**Interfaces:**
- Consumes: `openZip`, `LoadLimits.defaults.with(patch)`, `ResourceLimitError.limit`.
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

```ts
// test/zipread-limits.test.ts
import { describe, it, expect } from 'vitest';
import { openZip } from '../src/zipread.js';
import { writeZip } from '../src/zip.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';
import { enc, layout, put16, put32 } from './helpers/zip-bytes.js';

const limitOf = (f: () => unknown): string | undefined => {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e.limit; throw e; }
  return undefined;
};

const five = (): Uint8Array =>
  writeZip([0, 1, 2, 3, 4].map((i) => ({ path: `f${i}`, bytes: enc(String(i)) })));

describe('entry count against maxContainerItems', () => {
  it('admits exactly the limit and refuses one more', () => {
    expect(openZip(five(), LoadLimits.defaults.with({ maxContainerItems: 5 })).entries.length).toBe(5);
    expect(limitOf(() => openZip(five(), LoadLimits.defaults.with({ maxContainerItems: 4 }))))
      .toBe('maxContainerItems');
  });

  it('counts records as produced, never the declared count', () => {
    const zip = five();
    const { eocd } = layout(zip);
    put16(zip, eocd + 8, 60_000); put16(zip, eocd + 10, 60_000);
    // Declared 60,000 against a limit of 10: a declaration-based check would
    // refuse on the limit; counting as produced finds five and calls it damage.
    expect(() => openZip(zip, LoadLimits.defaults.with({ maxContainerItems: 10 })))
      .toThrow(PdfParseError);
  });
});

describe('bombs', () => {
  const bomb = (declared?: number): Uint8Array => {
    const zip = writeZip([{ path: 'bomb', bytes: new Uint8Array(4 * 1024 * 1024) }]);
    if (declared !== undefined) put32(zip, layout(zip).central[0] + 24, declared);
    return zip;
  };

  it('refuses an honestly declared bomb from its declaration', () => {
    const z = openZip(bomb(), LoadLimits.defaults.with({ maxDecodedStreamBytes: 1024 * 1024 }));
    expect(limitOf(() => z.read('bomb'))).toBe('maxDecodedStreamBytes');
  });

  it('reads a bomb declaring SMALL as damage at the declared length', () => {
    expect(() => openZip(bomb(1000)).read('bomb')).toThrow(PdfParseError);
  });

  it('refuses a declaration past the bounds before inflating corrupt data behind it', () => {
    const zip = writeZip([{ path: 'x', bytes: enc('abc') }]);
    const { central, local } = layout(zip);
    put32(zip, central[0] + 24, 50_000);
    zip[local[0] + 30 + 1] = 0xff;              // corrupt the data too
    const z = openZip(zip, LoadLimits.defaults.with({ maxDecodedStreamBytes: 10_000 }));
    expect(limitOf(() => z.read('x'))).toBe('maxDecodedStreamBytes');
  });
});

describe('one running total per archive', () => {
  const three = (): Uint8Array => writeZip([
    { path: 'a', bytes: new Uint8Array(600) },
    { path: 'b', bytes: new Uint8Array(600), method: 'store' },
    { path: 'c', bytes: new Uint8Array(600) },
  ]);
  const small = LoadLimits.defaults.with({ maxTotalDecodedBytes: 1500 });

  it('charges deflated and stored entries alike to one total', () => {
    const z = openZip(three(), small);
    z.read('a'); z.read('b');
    expect(limitOf(() => z.read('c'))).toBe('maxTotalDecodedBytes');
  });

  it('charges a second read of one entry again', () => {
    const z = openZip(three(), small);
    z.read('a'); z.read('a');
    expect(limitOf(() => z.read('b'))).toBe('maxTotalDecodedBytes');
  });

  it('gives each opened archive its own total', () => {
    openZip(three(), small).read('a');
    const z = openZip(three(), small);
    z.read('a'); z.read('b');
    expect(limitOf(() => z.read('c'))).toBe('maxTotalDecodedBytes');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/zipread-limits.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation-check each rule (RED phase)**

| Mutation | Must fail |
|---|---|
| Delete the `limits.enforce('maxContainerItems', …)` line | "admits exactly the limit and refuses one more" |
| Replace it with `limits.enforce('maxContainerItems', total, …)` placed before the loop | "counts records as produced…" |
| In `read`, create the decoder per call: move `const decoder = new InputDecoder(limits, 'ZIP entry');` inside `read` | "charges deflated and stored entries alike…" |
| In `read`, pass no declaration: `decoder.inflateRaw(data)` | "refuses a declaration past the bounds before inflating…" and "reads a bomb declaring SMALL…" (record which) |
| Make `stored` return `input` without going through `run` (in `inflatebound.ts`) | "charges deflated and stored entries alike…" |

- [ ] **Step 4: Commit**

```bash
git add test/zipread-limits.test.ts
git commit -m "test(m2fp.1): ZIP entry count, bombs and one total per archive"
```

---

### Task 7: third-party fixtures with a manifest from their inputs

The probe run while planning (2026-09-29) found what each producer contributes, and it corrects the spec's table:

| Producer | Observed | Pins |
|---|---|---|
| libarchive via `tar.exe -a -cf` | flag bit 3 on deflated entries; local sizes 0; local extra 32 bytes vs central 24; transliterates `é` to `e` | central-over-local sizes; local extra length locates data |
| .NET Framework `ZipFile.CreateFromDirectory` | NO data descriptor; UTF-8 names WITH bit 11; `\` as separator (`sub\b.txt`) | UTF-8 names on real bytes; a backslash name returned verbatim |
| `git archive --format=zip <commit>` | 40-byte archive comment (the commit id); 9-byte extended-timestamp extras; stored directory entries | the comment-length search on real bytes |

**Files:**
- Create: `scripts/gen-zip-fixtures.mjs`
- Create (generated): `test/fixtures/zip/tar.zip`, `net.zip`, `git.zip`, `manifest.json`
- Create: `test/fixtures/zip/PROVENANCE.md`
- Modify: `package.json` (scripts)
- Test: `test/zipread-real.test.ts`

**Interfaces:**
- Consumes: `openZip`; `unzip` from `test/helpers/unzip.ts`.
- Produces: `manifest.json` shaped `{ producers: Record<string,string>, archives: Record<string, { comment: number, entries: Record<string, { size: number, sha256: string }> }> }`.

- [ ] **Step 1: Write the generator**

```js
// scripts/gen-zip-fixtures.mjs
// Builds test/fixtures/zip/ from three ZIP writers that are not ours, and a
// manifest whose hashes come from the INPUT files — never from reading the
// archives — so the test's oracle is outside the reader it checks.
// Needs Windows (tar.exe, PowerShell) and git. Not run by `npm test`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'zip');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

const INPUTS = {
  'a.txt': Buffer.from('hello zip '.repeat(200) + '\n'),
  'sub/b.txt': Buffer.from('x\n'),
  'bin.dat': Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  'café.txt': Buffer.from('café\n'),
};
const src = mkdtempSync(join(tmpdir(), 'zipfx-'));
for (const [p, b] of Object.entries(INPUTS)) {
  mkdirSync(join(src, p, '..'), { recursive: true });
  writeFileSync(join(src, p), b);
}
mkdirSync(OUT, { recursive: true });
// .NET's CreateFromDirectory refuses to overwrite, so a re-run starts clean.
for (const n of ['tar.zip', 'net.zip', 'git.zip']) rmSync(join(OUT, n), { force: true });

/** Flags of every central record, and the comment length — a guard that each
 *  fixture still has the property it is vendored for. */
function survey(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const flags = [];
  let at = u32(zip, eocd + 16);
  for (let i = 0; i < u16(zip, eocd + 10); i++) {
    flags.push(u16(zip, at + 8));
    at += 46 + u16(zip, at + 28) + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return { flags, comment: u16(zip, eocd + 20) };
}
const hashes = (map) => Object.fromEntries(
  Object.entries(map).map(([p, b]) => [p, { size: b.length, sha256: sha(b) }]));

const archives = {};

// libarchive: é is transliterated, so café.txt is left out.
const tarList = ['a.txt', 'sub/b.txt', 'bin.dat'];
run('tar', ['-a', '-cf', join(OUT, 'tar.zip'), ...tarList], src);
archives['tar.zip'] = { entries: hashes(Object.fromEntries(tarList.map((p) => [p, INPUTS[p]]))) };

// .NET Framework writes '\' separators; the manifest records the name it writes.
run('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${join(OUT, 'net.zip')}')`]);
archives['net.zip'] = { entries: hashes(Object.fromEntries(
  Object.entries(INPUTS).map(([p, b]) => [p.replaceAll('/', '\\'), b]))) };

// git: two committed files at a pinned commit; hashes from `git show`, not the zip.
const commit = run('git', ['rev-parse', 'HEAD']);
const gitPaths = ['src/crc32.ts', 'src/zip.ts'];
run('git', ['archive', '--format=zip', '-o', join(OUT, 'git.zip'), commit, '--', ...gitPaths]);
archives['git.zip'] = { entries: hashes(Object.fromEntries(gitPaths.map((p) => [p,
  execFileSync('git', ['show', `${commit}:${p}`])]))) };

for (const name of Object.keys(archives)) {
  const s = survey(readFileSync(join(OUT, name)));
  archives[name].comment = s.comment;
  archives[name].flags = s.flags;
}
const need = (ok, why) => { if (!ok) throw new Error(`fixture lost its reason to exist: ${why}`); };
need(archives['tar.zip'].flags.some((f) => f & 8), 'tar.zip has no data descriptor');
need(archives['net.zip'].flags.some((f) => f & 0x800), 'net.zip has no bit-11 name');
need(archives['git.zip'].comment > 0, 'git.zip has no archive comment');

const producers = {
  tar: run('tar', ['--version']).split('\n')[0],
  dotnet: run('powershell', ['-NoProfile', '-Command', '[System.Environment]::Version.ToString()']),
  git: run('git', ['--version']),
  commit,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ producers, archives }, null, 2) + '\n');
rmSync(src, { recursive: true, force: true });
console.log(JSON.stringify(producers, null, 2));
for (const n of Object.keys(archives)) console.log(n, sha(readFileSync(join(OUT, n))));
```

Add to `package.json` `scripts`, beside the other `gen:*` entries:

```json
"gen:zip": "node scripts/gen-zip-fixtures.mjs",
```

- [ ] **Step 2: Generate**

Run: `npm run gen:zip`
Expected: prints the three producer versions, the commit id, and a SHA-256 per archive; `test/fixtures/zip/` holds `tar.zip`, `net.zip`, `git.zip`, `manifest.json`. If a `need(...)` guard throws, STOP and report — the producer on this machine does not write what the probe saw, and the fixture table above is wrong for it.

- [ ] **Step 3: Write the failing test**

```ts
// test/zipread-real.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openZip } from '../src/zipread.js';
import { unzip } from './helpers/unzip.js';

const DIR = join(__dirname, 'fixtures', 'zip');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  archives: Record<string, { comment: number; entries: Record<string, { size: number; sha256: string }> }>;
};
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.each(Object.keys(manifest.archives))('%s, written by a third party', (name) => {
  const bytes = new Uint8Array(readFileSync(join(DIR, name)));
  const want = manifest.archives[name].entries;

  it('holds exactly the files its inputs had, byte for byte', () => {
    const z = openZip(bytes);
    const files = z.entries.filter((e) => !e.path.endsWith('/') && !e.path.endsWith('\\'));
    expect(files.map((e) => e.path).sort()).toEqual(Object.keys(want).sort());
    for (const e of files) {
      const out = z.read(e.path);
      expect(out.length).toBe(want[e.path].size);
      expect(sha(out)).toBe(want[e.path].sha256);
    }
  });

  it('agrees with the independent APPNOTE test reader', () => {
    const z = openZip(bytes);
    for (const e of unzip(bytes)) expect(sha(z.read(e.path))).toBe(sha(e.bytes));
  });
});

describe('the properties each fixture is vendored for', () => {
  it('git.zip carries an archive comment, read from its raw end record', () => {
    expect(manifest.archives['git.zip'].comment).toBeGreaterThan(0);
  });

  it('net.zip names a file with a backslash and a UTF-8 é', () => {
    const paths = openZip(new Uint8Array(readFileSync(join(DIR, 'net.zip')))).entries.map((e) => e.path);
    expect(paths).toContain('sub\\b.txt');
    expect(paths).toContain('café.txt');
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/zipread-real.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check against the real bytes**

| Mutation (in `src/zipread.ts`) | Must fail |
|---|---|
| Use the CENTRAL extra length for the data: change `u16(bytes, lo + 28)` to the central record's extra length (store it on `Entry` as `centralExtra` and use it) | `tar.zip` byte-for-byte case (local 32 vs central 24) |
| Read the compressed size from the local header, `u32(bytes, lo + 18)` | `tar.zip` byte-for-byte case (local size 0) |
| In `decodeName`, ignore bit 11 (always CP437) | `net.zip` UTF-8 case |
| In `findEocd`, delete the exact-comment preference line | expected GREEN on `git.zip` (no signature inside its comment) — record it; the builder case in Task 4 holds the rule |

- [ ] **Step 6: Write `test/fixtures/zip/PROVENANCE.md`**

Record, from the Step 2 output: each producer and version, the exact command, the commit id, the SHA-256 of each archive, and the input contents (copy the `INPUTS` table). Then state the ceiling, verbatim in substance:

- No producer here writes a CP437 name, so the CP437 table is covered by hand-built archives only.
- No producer writes an encrypted entry, a method other than 0/8, ZIP64, or a multi-disk set; every refusal is builder-covered only.
- `tar.exe` transliterates non-ASCII names, so libarchive's own UTF-8 behaviour is not captured.
- The fixtures are small; nothing here exercises a limit on real bytes.
- This is ZIP-container evidence, not DOCX evidence — the DOCX corpus is `m2fp.4`.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-zip-fixtures.mjs package.json test/fixtures/zip test/zipread-real.test.ts
git commit -m "test(m2fp.1): third-party ZIP fixtures from libarchive, .NET and git"
```

---

### Task 8: docs, spec amendments, gates

**Files:**
- Modify: `CLAUDE.md` (Source list, fixture table, Build & Test generator list)
- Modify: `docs/superpowers/specs/2026-09-29-zip-reader-design.md`

- [ ] **Step 1: Amend the spec** to match what planning measured:
  - The fixture table: replace with the three-row table from Task 7 (libarchive = data descriptors and a differing local extra; .NET = bit-11 UTF-8 and a backslash name; git = comment).
  - ZIP64 detection: "the locator, or a 32-bit sentinel in the directory size or offset. A count of 0xFFFF alone is a real count — `writeZip` writes exactly that for 65,535 entries."
  - Traversal: "asserted by a static check that `zipread.ts` imports no `fs`" (replacing the spy).
  - Add: "`writeZip` sets flag bit 11 for a non-ASCII name (fixed here); without it this reader, conforming to APPNOTE, decodes the name as CP437."

- [ ] **Step 2: Add the CLAUDE.md Source-list entry**, after the `zip.ts`/`ooxml.ts`/`docxpackage.ts`/`crc32.ts` entry:

```markdown
- **zipread.ts** — reading a ZIP archive (`m2fp.1`), for the DOCX importer's
  package layer: `openZip(bytes, limits)` lists the central directory and
  `read(path)` decodes one entry. Note the direction: `zip.ts` WRITES and the
  two share no code; `test/helpers/unzip.ts` is the independent test reader
  and must stay independent.
  **Invariant:** LAZY — an entry is decoded, charged and CRC-checked when it
  is READ, so a bomb in an entry nobody reads costs nothing — and ONE
  `InputDecoder` per archive, so every read is charged to one
  `maxTotalDecodedBytes`. No cache: a second read decodes and charges again.
  **Invariant:** the entry count is enforced against `maxContainerItems` as
  records are PRODUCED; a declared count that disagrees is damage.
  **Invariant:** sizes, CRC and flags come from the CENTRAL directory; the
  local header's OWN name and extra lengths locate the data. Both halves are
  pinned by `test/fixtures/zip/tar.zip`, where libarchive writes a data
  descriptor (local sizes 0) and a 32-byte local extra against a 24-byte
  central one — no builder fixture has either.
  **Invariant:** a duplicate name and a local/central name mismatch are
  damage — the two ZIP-confusion shapes. An unsupported feature refuses the
  ENTRY at `read()`; only ZIP64 and multi-disk, which hide the directory,
  refuse at open.
  **Note:** a count of 0xFFFF alone is not read as ZIP64, because `writeZip`
  writes exactly that for 65,535 entries. And `writeZip` sets flag bit 11 for
  a non-ASCII name since `m2fp.1`; before, this reader — conforming to APPNOTE
  — would have decoded such a name as CP437.
```

Then add a row to the real-world fixture table under "Tests live in `test/`":

```markdown
| `fixtures/zip/` | `PROVENANCE.md` | ZIP **input** from three writers that are not ours — libarchive (`tar.exe`), .NET Framework and `git archive`. Pins the two rules no builder fixture reaches: sizes from the central directory (libarchive's data descriptors) and data located by the LOCAL extra length (libarchive's 32-vs-24). Also UTF-8 bit-11 and backslash names (.NET) and an archive comment (git). The manifest's hashes come from the INPUTS, not the archives (`test/zipread-real.test.ts`) |
```

And in "Build & Test", in the sentence listing the fixture generators, add `gen:zip`'s libarchive/.NET/git ZIP fixtures to the list of things they regenerate, and add "Windows `tar.exe` and PowerShell" to the "Each needs something that is NOT a dependency" list.

- [ ] **Step 3: Run the module-doc sweep and the quality gates**

Run (Bash):

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

Expected: empty output.

Run: `npm run typecheck` then `npm test`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-29-zip-reader-design.md
git commit -m "docs(m2fp.1): zipread.ts entry, ZIP fixture row, spec amendments"
```
