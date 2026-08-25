# WOFF / WOFF2 → sfnt Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `Document.AddFont` / `AddFontFile` accept `.woff` and `.woff2` font containers by unwrapping them to raw sfnt bytes in memory, feeding the existing parse → subset → embed pipeline unchanged.

**Architecture:** A new pure module `src/woff.ts` exports `sfntFromWoff(bytes)`. `parseSfnt` sniffs the first 4 bytes and, on WOFF/WOFF2 magic, routes through it before constructing `SfntFont`. WOFF = per-table zlib inflate. WOFF2 = brotli decompress + compact directory + glyf/loca (and optional hmtx) transform reconstruction. Both reassemble a standard sfnt with a shared writer.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), `node:zlib` (`inflateSync`, `brotliDecompressSync`), vitest.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. `node:zlib` provides `inflateSync` and `brotliDecompressSync`. Do NOT add npm deps.
- **ESM + NodeNext** — every relative import specifier ends in `.js` (e.g. `import { PdfParseError } from './errors.js'`).
- **strict TypeScript** — `npm run typecheck` must stay green.
- **Errors** — throw only the public types `PdfParseError` (malformed input, with byte offset) and `UnsupportedFeatureError` (unsupported transform) from `./errors.js`.
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Docs** — keep `README.md` in sync when the accepted font-input set changes.
- **Test fixtures** are built in code under `test/helpers/`; no binary blobs, no external tooling.

---

## File Structure

- **Create `src/woff.ts`** — the decoder. Exports `sfntFromWoff(bytes: Uint8Array): Uint8Array`. Internal units: `decodeWoff1`, `decodeWoff2`, `reconstructGlyf`, `reconstructHmtx`, shared `Reader` / `writeSfnt` / byte helpers, `KNOWN_TAGS`, `readUIntBase128`, `read255UShort`.
- **Modify `src/sfnt.ts`** — at the top of `parseSfnt`, unwrap WOFF/WOFF2 to sfnt via `sfntFromWoff` before `new SfntFont(...)`.
- **Create `test/helpers/build-woff.ts`** — WOFF/WOFF2 *encoders* for fixtures: `wrapWoff1`, `wrapWoff2Null`, `wrapWoff2Transformed`, plus `parseSfntTables`.
- **Create `test/woff.test.ts`** — all decode tests.
- **Modify `README.md`** — note `.woff` / `.woff2` accepted by `AddFont` / `AddFontFile`.

---

## Task 1: WOFF (v1) end-to-end

Delivers full WOFF support: module skeleton, shared `Reader` + `writeSfnt`, `decodeWoff1`, wiring into `parseSfnt`, and a WOFF encoder helper. WOFF2 magic throws a placeholder `UnsupportedFeatureError` (replaced in Task 2).

**Files:**
- Create: `src/woff.ts`
- Modify: `src/sfnt.ts` (top of `parseSfnt`, ~line 285; constructor throw at lines 180-181 stays)
- Create: `test/helpers/build-woff.ts`
- Create: `test/woff.test.ts`

**Interfaces:**
- Produces: `sfntFromWoff(bytes: Uint8Array): Uint8Array`; test helpers `parseSfntTables(sfnt: Uint8Array): { version: number; tables: { tag: string; data: Uint8Array }[] }` and `wrapWoff1(sfnt: Uint8Array): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `test/woff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { buildMinimalTtf, makeOttoWithCff } from './helpers/build-sfnt.js';
import { wrapWoff1 } from './helpers/build-woff.js';

/** Assert two fonts agree on glyph count, cmap, advances, and every outline. */
function expectSameFont(a: ReturnType<typeof parseSfnt>, b: ReturnType<typeof parseSfnt>) {
  expect(a.numGlyphs).toBe(b.numGlyphs);
  expect([...a.cmap.entries()].sort()).toEqual([...b.cmap.entries()].sort());
  for (let g = 0; g < b.numGlyphs; g++) {
    expect(a.advanceWidth(g)).toBe(b.advanceWidth(g));
    expect(a.glyphOutline(g)).toEqual(b.glyphOutline(g));
  }
}

describe('WOFF (v1) ingestion', () => {
  it('round-trips a glyf TrueType font', () => {
    const ttf = buildMinimalTtf();
    const src = parseSfnt(ttf);
    const back = parseSfnt(wrapWoff1(ttf));
    expect(back.outlines).toBe('glyf');
    expectSameFont(back, src);
  });

  it('round-trips a CFF (OTTO) font', () => {
    const otto = makeOttoWithCff();
    const back = parseSfnt(wrapWoff1(otto));
    expect(back.outlines).toBe('cff');
    expect(back.numGlyphs).toBe(parseSfnt(otto).numGlyphs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/woff.test.ts`
Expected: FAIL — `build-woff.js` / `wrapWoff1` does not exist.

- [ ] **Step 3: Create `src/woff.ts` with the shared core + `decodeWoff1`**

```ts
import { inflateSync, brotliDecompressSync } from 'node:zlib';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

const SIG_WOFF1 = 0x774f4646; // 'wOFF'
const SIG_WOFF2 = 0x774f4632; // 'wOF2'

/** Little forward byte reader (mirrors sfnt.ts). `pos`/`bytes` are public so
 *  sub-stream decoders can slice and seek. */
class Reader {
  private view: DataView;
  constructor(public bytes: Uint8Array, public pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new PdfParseError('unexpected end of WOFF data', this.pos);
  }
  u8(): number { this.need(1); return this.bytes[this.pos++]; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  tag(): string { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4)); this.pos += 4; return s; }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16be(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function i16be(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }

/** Assemble a standard sfnt from decoded tables: offset table + directory
 *  (tags ascending) + 4-byte-padded bodies. Checksums written 0 (the parser
 *  ignores them, matching test/helpers/build-sfnt.ts). */
function writeSfnt(version: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset;
    const pad = (4 - (t.data.length & 3)) & 3;
    offset += t.data.length + pad;
    return { tag: t.tag, at, len: t.data.length, data: t.data };
  });
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  dv.setUint32(0, version >>> 0);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, numTables * 16 - searchRange);
  let p = 12;
  for (const pl of placed) {
    for (let k = 0; k < 4; k++) out[p + k] = pl.tag.charCodeAt(k);
    dv.setUint32(p + 4, 0);
    dv.setUint32(p + 8, pl.at);
    dv.setUint32(p + 12, pl.len);
    p += 16;
    out.set(pl.data, pl.at);
  }
  return out;
}

/** Unwrap WOFF (per-table zlib) or WOFF2 (brotli + transforms) to raw sfnt. */
export function sfntFromWoff(bytes: Uint8Array): Uint8Array {
  const sig = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (sig === SIG_WOFF1) return decodeWoff1(bytes);
  if (sig === SIG_WOFF2) return decodeWoff2(bytes);
  throw new PdfParseError('not a WOFF/WOFF2 font', 0);
}

function decodeWoff1(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  r.u32();                       // signature
  const flavor = r.u32();
  r.u32();                       // length
  const numTables = r.u16();
  r.u16();                       // reserved
  r.u32();                       // totalSfntSize
  r.u16(); r.u16();              // major/minor version
  r.u32(); r.u32(); r.u32();     // meta offset/length/origLength
  r.u32(); r.u32();              // priv offset/length
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32();                     // origChecksum
    if (offset + compLength > bytes.length) throw new PdfParseError('WOFF table out of bounds', offset);
    const comp = bytes.subarray(offset, offset + compLength);
    let data: Uint8Array;
    if (compLength < origLength) {
      try { data = new Uint8Array(inflateSync(Buffer.from(comp))); }
      catch { throw new PdfParseError('WOFF table inflate failed', offset); }
      if (data.length !== origLength) throw new PdfParseError('WOFF table length mismatch', offset);
    } else {
      data = comp;               // stored uncompressed (compLength == origLength)
    }
    tables.push({ tag, data });
  }
  return writeSfnt(flavor, tables);
}

// --- WOFF2 (Tasks 2-4) ---
function decodeWoff2(_bytes: Uint8Array): Uint8Array {
  throw new UnsupportedFeatureError('WOFF2 not yet implemented');
}
```

- [ ] **Step 4: Wire `parseSfnt` in `src/sfnt.ts`**

Add the import near the top of `src/sfnt.ts`:

```ts
import { sfntFromWoff } from './woff.js';
```

Change `parseSfnt` (line 285) so its first statements unwrap WOFF magic:

```ts
export function parseSfnt(bytes: Uint8Array): SfntFont {
  const sig = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (sig === 0x774f4646 /* wOFF */ || sig === 0x774f4632 /* wOF2 */) bytes = sfntFromWoff(bytes);
  const f = new SfntFont(bytes);
  // ...existing body unchanged...
```

Leave the `SfntFont` constructor WOFF throw at lines 180-181 as-is (defensive; unreachable via `parseSfnt`).

- [ ] **Step 5: Create the WOFF encoder helper `test/helpers/build-woff.ts`**

```ts
import { deflateSync, brotliCompressSync } from 'node:zlib';

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function tagBytes(t: string): Uint8Array { return Uint8Array.from([t.charCodeAt(0), t.charCodeAt(1), t.charCodeAt(2), t.charCodeAt(3)]); }
function pad4(b: Uint8Array): Uint8Array { const r = b.length & 3; return r === 0 ? b : concat([b, new Uint8Array(4 - r)]); }

/** Parse an sfnt into its version + table list (tag/data), data unpadded. */
export function parseSfntTables(sfnt: Uint8Array): { version: number; tables: { tag: string; data: Uint8Array }[] } {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const version = v.getUint32(0);
  const numTables = v.getUint16(4);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(rec, rec + 4));
    const off = v.getUint32(rec + 8);
    const len = v.getUint32(rec + 12);
    tables.push({ tag, data: sfnt.subarray(off, off + len) });
  }
  return { version, tables };
}

/** Wrap an sfnt as WOFF (v1): each table zlib-deflated, or stored if that is
 *  not smaller. */
export function wrapWoff1(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const headerSize = 44;
  const dirSize = tables.length * 20;
  let offset = headerSize + dirSize;
  const dirRecs: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    const deflated = new Uint8Array(deflateSync(Buffer.from(t.data)));
    const useComp = deflated.length < t.data.length;
    const stored = useComp ? deflated : t.data;
    const compLength = stored.length;
    dirRecs.push(concat([tagBytes(t.tag), u32(offset), u32(compLength), u32(t.data.length), u32(0)]));
    const padded = pad4(stored);
    bodies.push(padded);
    offset += padded.length;
    totalSfntSize += pad4(t.data).length;
  }
  const totalLength = offset;
  const header = concat([
    tagBytes('wOFF'), u32(version), u32(totalLength), u16(tables.length), u16(0),
    u32(totalSfntSize), u16(0), u16(0),
    u32(0), u32(0), u32(0),   // meta
    u32(0), u32(0),           // priv
  ]);
  return concat([header, ...dirRecs, ...bodies]);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/woff.test.ts`
Expected: PASS (both WOFF v1 cases).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/woff.ts src/sfnt.ts test/helpers/build-woff.ts test/woff.test.ts
git commit -m "feat(6al): WOFF (v1) -> sfnt ingestion via parseSfnt"
```

---

## Task 2: WOFF2 container — null transform

Implements the WOFF2 header, compact table directory (255UShort / UIntBase128 / known tags), brotli decompress, and reassembly. glyf/loca use the **null** transform (version 3) → stored verbatim. Any *transformed* table throws `UnsupportedFeatureError` (glyf transform arrives in Task 3).

**Files:**
- Modify: `src/woff.ts` (replace the `decodeWoff2` placeholder; add helpers + `KNOWN_TAGS`)
- Modify: `test/helpers/build-woff.ts` (add `wrapWoff2Null`)
- Modify: `test/woff.test.ts`

**Interfaces:**
- Consumes: `writeSfnt`, `Reader`, `concat` (Task 1).
- Produces: `wrapWoff2Null(sfnt: Uint8Array): Uint8Array`; internal `readUIntBase128`, `read255UShort`, `KNOWN_TAGS`.

- [ ] **Step 1: Write the failing test**

Append to `test/woff.test.ts`:

```ts
import { wrapWoff2Null } from './helpers/build-woff.js';

describe('WOFF2 ingestion — null transform', () => {
  it('round-trips a glyf font (verbatim glyf/loca)', () => {
    const ttf = buildMinimalTtf();
    const src = parseSfnt(ttf);
    const back = parseSfnt(wrapWoff2Null(ttf));
    expect(back.outlines).toBe('glyf');
    expectSameFont(back, src);
  });

  it('round-trips a CFF (OTTO) font', () => {
    const otto = makeOttoWithCff();
    const back = parseSfnt(wrapWoff2Null(otto));
    expect(back.outlines).toBe('cff');
    expect(back.numGlyphs).toBe(parseSfnt(otto).numGlyphs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/woff.test.ts`
Expected: FAIL — `wrapWoff2Null` not exported.

- [ ] **Step 3: Add WOFF2 helpers + `decodeWoff2` (null-only) to `src/woff.ts`**

Add above `decodeWoff2`:

```ts
/** WOFF2 known-table tags, indexed 0..62 by the directory flags byte (spec
 *  Table 6). Index 63 (0x3f) means a 4-byte arbitrary tag follows. */
const KNOWN_TAGS: string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function readUIntBase128(r: Reader): number {
  let accum = 0;
  for (let i = 0; i < 5; i++) {
    const b = r.u8();
    if (i === 0 && b === 0x80) throw new PdfParseError('WOFF2 UIntBase128 leading zero', r.pos);
    if (accum & 0xfe000000) throw new PdfParseError('WOFF2 UIntBase128 overflow', r.pos);
    accum = ((accum << 7) | (b & 0x7f)) >>> 0;
    if ((b & 0x80) === 0) return accum;
  }
  throw new PdfParseError('WOFF2 UIntBase128 too long', r.pos);
}

function read255UShort(r: Reader): number {
  const code = r.u8();
  if (code === 253) return r.u16();
  if (code === 255) return r.u8() + 253;
  if (code === 254) return r.u8() + 506;
  return code;
}

interface Woff2Entry { tag: string; transformVersion: number; origLength: number; transformLength: number; transformed: boolean; }
```

Replace the placeholder `decodeWoff2` with:

```ts
function decodeWoff2(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  r.u32();                       // signature
  const flavor = r.u32();
  r.u32();                       // length
  const numTables = r.u16();
  r.u16();                       // reserved
  r.u32();                       // totalSfntSize
  const totalCompressedSize = r.u32();
  r.u16(); r.u16();              // major/minor version
  r.u32(); r.u32(); r.u32();     // meta offset/length/origLength
  r.u32(); r.u32();              // priv offset/length

  const dir: Woff2Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x3;
    const tag = tagIndex === 0x3f ? r.tag() : KNOWN_TAGS[tagIndex];
    if (!tag) throw new PdfParseError('WOFF2 unknown table tag index', r.pos);
    const origLength = readUIntBase128(r);
    const isGlyfLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfLoca ? transformVersion === 0 : transformVersion !== 0;
    const transformLength = transformed ? readUIntBase128(r) : origLength;
    dir.push({ tag, transformVersion, origLength, transformLength, transformed });
  }

  const compStart = r.pos;
  if (compStart + totalCompressedSize > bytes.length) throw new PdfParseError('WOFF2 compressed block out of bounds', compStart);
  let stream: Uint8Array;
  try { stream = new Uint8Array(brotliDecompressSync(Buffer.from(bytes.subarray(compStart, compStart + totalCompressedSize)))); }
  catch { throw new PdfParseError('WOFF2 brotli decompress failed', compStart); }

  const raw = new Map<string, Uint8Array>();
  let off = 0;
  for (const e of dir) {
    const len = e.transformed ? e.transformLength : e.origLength;
    if (off + len > stream.length) throw new PdfParseError('WOFF2 decompressed stream underrun', off);
    raw.set(e.tag, stream.subarray(off, off + len));
    off += len;
  }

  const out: { tag: string; data: Uint8Array }[] = [];
  for (const e of dir) {
    if (e.transformed) {
      // glyf transform → Task 3; hmtx transform → Task 4; loca handled with glyf.
      throw new UnsupportedFeatureError(`WOFF2 transform for '${e.tag}' not supported`);
    }
    out.push({ tag: e.tag, data: raw.get(e.tag)! });
  }
  return writeSfnt(flavor, out);
}
```

- [ ] **Step 4: Add `wrapWoff2Null` to `test/helpers/build-woff.ts`**

Add the shared WOFF2 tag/varint encoders and the null wrapper:

```ts
const KNOWN_TAGS: string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function base128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0;
  do { bytes.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return Uint8Array.from(bytes);
}
export function u255(n: number): Uint8Array {
  if (n < 253) return Uint8Array.from([n]);
  if (n < 253 + 256) return Uint8Array.from([255, n - 253]);
  if (n < 253 + 512) return Uint8Array.from([254, n - 506]);
  return concat([Uint8Array.from([253]), u16(n)]);
}
function u8(n: number): Uint8Array { return Uint8Array.from([n & 0xff]); }

/** Directory-entry bytes for a WOFF2 table with a given transform version and
 *  optional transformLength (present only when transformed). */
function woff2DirEntry(tag: string, transformVersion: number, origLength: number, transformLength?: number): Uint8Array {
  const idx = KNOWN_TAGS.indexOf(tag);
  const known = idx >= 0 && idx < 0x3f;
  const flags = ((transformVersion & 0x3) << 6) | (known ? idx : 0x3f);
  const parts = [u8(flags)];
  if (!known) parts.push(tagBytes(tag));
  parts.push(base128(origLength));
  if (transformLength !== undefined) parts.push(base128(transformLength));
  return concat(parts);
}

/** Assemble a WOFF2 from directory entries + the per-table stream bodies
 *  (concatenated, unpadded) that will be brotli-compressed. */
function assembleWoff2(version: number, numTables: number, dir: Uint8Array[], streamBodies: Uint8Array[], totalSfntSize: number): Uint8Array {
  const stream = concat(streamBodies);
  const compressed = new Uint8Array(brotliCompressSync(Buffer.from(stream)));
  const dirBytes = concat(dir);
  const header = concat([
    tagBytes('wOF2'), u32(version), u32(0), u16(numTables), u16(0),
    u32(totalSfntSize), u32(compressed.length), u16(0), u16(0),
    u32(0), u32(0), u32(0), u32(0), u32(0),
  ]);
  const total = header.length + dirBytes.length + compressed.length;
  new DataView(header.buffer).setUint32(8, total); // length field
  return concat([header, dirBytes, compressed]);
}

/** Wrap an sfnt as WOFF2 with all tables null-transformed (glyf/loca verbatim,
 *  transform version 3; others version 0). */
export function wrapWoff2Null(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const dir: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    const nullVersion = (t.tag === 'glyf' || t.tag === 'loca') ? 3 : 0;
    dir.push(woff2DirEntry(t.tag, nullVersion, t.data.length));
    bodies.push(t.data);
    totalSfntSize += pad4(t.data).length;
  }
  return assembleWoff2(version, tables.length, dir, bodies, totalSfntSize);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/woff.test.ts`
Expected: PASS (WOFF v1 + WOFF2 null cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/woff.ts test/helpers/build-woff.ts test/woff.test.ts
git commit -m "feat(6al): WOFF2 container + null-transform ingestion"
```

---

## Task 3: WOFF2 glyf/loca transform reconstruction

Adds `reconstructGlyf` (simple + composite + empty glyphs, triplet decoding, bbox bitmap, per-glyph instructions) and wires it into `decodeWoff2`. Two independent test anchors guard the reconstruction: (a) transformed decode must equal both the source font and its null-transform decode; (b) hand-built golden sub-streams must reconstruct to exact expected `glyf`/`loca` bytes.

**Files:**
- Modify: `src/woff.ts`
- Modify: `test/helpers/build-woff.ts` (add `wrapWoff2Transformed` + `encodeTransformedGlyf`)
- Modify: `test/woff.test.ts`

**Interfaces:**
- Consumes: `Reader`, `concat`, `u16be`, `i16be`, `read255UShort`, `KNOWN_TAGS`, `Woff2Entry`, `decodeWoff2` slicing (Tasks 1-2).
- Produces: internal `reconstructGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; indexFormat: number }`, exported `reconstructGlyfForTest` (@internal, for golden test); test helper `wrapWoff2Transformed(sfnt: Uint8Array): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Append to `test/woff.test.ts`:

```ts
import { wrapWoff2Transformed } from './helpers/build-woff.js';
import { reconstructGlyfForTest } from '../src/woff.js';

describe('WOFF2 ingestion — glyf transform', () => {
  it('reconstructs transformed glyf equal to source and to null decode', () => {
    const ttf = buildMinimalTtf();          // gid0 empty, gid1 simple, gid2 composite->1
    const src = parseSfnt(ttf);
    const viaTransform = parseSfnt(wrapWoff2Transformed(ttf));
    const viaNull = parseSfnt(wrapWoff2Null(ttf));
    expect(viaTransform.outlines).toBe('glyf');
    expectSameFont(viaTransform, src);
    for (let g = 0; g < src.numGlyphs; g++) {
      expect(viaTransform.glyphOutline(g)).toEqual(viaNull.glyphOutline(g));
    }
  });

  it('golden: reconstructs a hand-built simple + composite sub-stream to exact glyf bytes', () => {
    // numGlyphs=3: gid0 empty, gid1 simple 1-contour 1-point at (10,20) on-curve,
    // gid2 composite -> gid1 (flags ARG_WORDS|ARGS_XY|MORE_off, dx=0 dy=0).
    // Streams (indexFormat=0):
    const nContour = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0xff, 0xff]); // 0, 1, -1
    const nPoints = Uint8Array.from([0x01]);                                // gid1: 1 point in its single contour
    const flags = Uint8Array.from([125]);                                   // simple pt: base124|xSign(1)|ySign(1)=127? see below
    // Triplet 4-byte form: flag=124 | (dx>=0?1:0) | (dy>=0?2:0) = 124|1|2 = 127; on-curve (bit7 clear).
    // dx=10, dy=20 -> data 00 0A 00 14
    const flags2 = Uint8Array.from([127]);
    const glyphStream = Uint8Array.from([0x00, 0x0a, 0x00, 0x14, 0x00]);    // triplet + instrLen(255UShort)=0
    // composite component record: flags=0x0002 (ARGS_XY), glyphIndex=1, dx=0,dy=0 (bytes since ARG_WORDS unset)
    const composite = Uint8Array.from([0x00, 0x02, 0x00, 0x01, 0x00, 0x00]);
    // bbox bitmap: 3 glyphs -> 1 byte. Set bit for gid1 and gid2 (0x40|0x20 = 0x60). Values follow.
    const bboxBitmap = Uint8Array.from([0x60]);
    const bboxValues = Uint8Array.from([
      0x00, 0x0a, 0x00, 0x14, 0x00, 0x0a, 0x00, 0x14, // gid1 bbox 10,20,10,20
      0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x14, // gid2 bbox 0,0,10,20
    ]);
    const bbox = new Uint8Array(bboxBitmap.length + bboxValues.length);
    bbox.set(bboxBitmap); bbox.set(bboxValues, bboxBitmap.length);
    const instr = new Uint8Array(0);

    const header = new Uint8Array(36);
    const hv = new DataView(header.buffer);
    hv.setUint16(0, 0);   // reserved
    hv.setUint16(2, 0);   // optionFlags
    hv.setUint16(4, 3);   // numGlyphs
    hv.setUint16(6, 0);   // indexFormat (short)
    hv.setUint32(8, nContour.length);
    hv.setUint32(12, nPoints.length);
    hv.setUint32(16, flags2.length);
    hv.setUint32(20, glyphStream.length);
    hv.setUint32(24, composite.length);
    hv.setUint32(28, bbox.length);
    hv.setUint32(32, instr.length);
    const data = new Uint8Array(
      header.length + nContour.length + nPoints.length + flags2.length +
      glyphStream.length + composite.length + bbox.length + instr.length);
    let o = 0;
    for (const part of [header, nContour, nPoints, flags2, glyphStream, composite, bbox, instr]) { data.set(part, o); o += part.length; }

    const { glyf, loca, indexFormat } = reconstructGlyfForTest(data);
    expect(indexFormat).toBe(0);

    // Expected gid1 simple glyph (1 contour, 1 point (10,20) on-curve, no instr):
    //   numContours=1, bbox 10,20,10,20, endPts[0]=0, instrLen=0,
    //   flags[0]=0x01 (on-curve), x delta int16=10, y delta int16=20.
    const g1 = Uint8Array.from([
      0x00, 0x01, 0x00, 0x0a, 0x00, 0x14, 0x00, 0x0a, 0x00, 0x14,
      0x00, 0x00,             // endPts[0]=0
      0x00, 0x00,             // instrLen=0
      0x01,                   // flag
      0x00, 0x0a,             // x=+10
      0x00, 0x14,             // y=+20
    ]);
    // Expected gid2 composite: numContours=-1, bbox 0,0,10,20, then component verbatim.
    const g2 = Uint8Array.from([
      0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x14,
      0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // component (no MORE, no instructions)
    ]);
    const g1p = g1.length % 2 ? new Uint8Array(g1.length + 1) : g1; if (g1.length % 2) g1p.set(g1);
    const g2p = g2.length % 2 ? new Uint8Array(g2.length + 1) : g2; if (g2.length % 2) g2p.set(g2);
    const expectedGlyf = new Uint8Array(g1p.length + g2p.length);
    expectedGlyf.set(g1p, 0); expectedGlyf.set(g2p, g1p.length);
    expect([...glyf]).toEqual([...expectedGlyf]);

    // loca (short): [0, 0, len(g1p), len(g1p)+len(g2p)] / 2
    const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    expect(lv.getUint16(0)).toBe(0);
    expect(lv.getUint16(2)).toBe(0);
    expect(lv.getUint16(4)).toBe(g1p.length / 2);
    expect(lv.getUint16(6)).toBe((g1p.length + g2p.length) / 2);
  });
});
```

Note: the unused `flags` constant in the test above is a leftover — delete it; only `flags2` is used.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/woff.test.ts`
Expected: FAIL — `reconstructGlyfForTest` / `wrapWoff2Transformed` not exported.

- [ ] **Step 3: Implement `reconstructGlyf` in `src/woff.ts`**

Add these functions (and export the test hook):

```ts
/** @internal Test hook: reconstruct standard glyf/loca from a transformed glyf
 *  table (WOFF2 §5.1). */
export function reconstructGlyfForTest(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; indexFormat: number } {
  return reconstructGlyf(data);
}

const withSign = (flag: number, base: number): number => (flag & 1) ? base : -base;

function reconstructGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; indexFormat: number } {
  const h = new Reader(data);
  h.u16();                       // reserved
  const optionFlags = h.u16();
  const numGlyphs = h.u16();
  let indexFormat = h.u16();
  const nContourSize = h.u32();
  const nPointsSize = h.u32();
  const flagSize = h.u32();
  const glyphSize = h.u32();
  const compositeSize = h.u32();
  const bboxSize = h.u32();
  const instructionSize = h.u32();
  let p = h.pos;
  const nContourStream = new Reader(data, p); p += nContourSize;
  const nPointsStream = new Reader(data, p); p += nPointsSize;
  const flagStream = new Reader(data, p); p += flagSize;
  const glyphStream = new Reader(data, p); p += glyphSize;
  const compositeStream = new Reader(data, p); p += compositeSize;
  const bboxStart = p; p += bboxSize;
  const instructionStream = new Reader(data, p); p += instructionSize;
  let overlapBitmap: Uint8Array | undefined;
  if (optionFlags & 0x0001) { const n = Math.ceil(numGlyphs / 8); overlapBitmap = data.subarray(p, p + n); p += n; }

  const bitmapLen = Math.ceil(numGlyphs / 8);
  const bboxBitmap = data.subarray(bboxStart, bboxStart + bitmapLen);
  const bboxValues = new Reader(data, bboxStart + bitmapLen);
  const hasBbox = (i: number): boolean => (bboxBitmap[i >> 3] & (0x80 >> (i & 7))) !== 0;
  const overlaps = (i: number): boolean => !!overlapBitmap && (overlapBitmap[i >> 3] & (0x80 >> (i & 7))) !== 0;

  const glyphs: Uint8Array[] = [];
  for (let i = 0; i < numGlyphs; i++) {
    const nContours = nContourStream.i16();
    if (nContours === 0) { glyphs.push(new Uint8Array(0)); continue; }
    if (nContours < 0) {
      glyphs.push(reconstructComposite(compositeStream, glyphStream, instructionStream, bboxValues, i, hasBbox));
    } else {
      glyphs.push(reconstructSimple(nContours, nPointsStream, flagStream, glyphStream, instructionStream, bboxValues, i, hasBbox, overlaps(i)));
    }
  }

  const bodies: Uint8Array[] = [];
  const offsets = [0];
  let total = 0;
  for (const g of glyphs) {
    const padded = (g.length & 1) ? concat([g, new Uint8Array(1)]) : g;
    bodies.push(padded); total += padded.length; offsets.push(total);
  }
  if (indexFormat === 0 && total > 0x1fffe) indexFormat = 1; // short loca can't address it
  const glyf = concat(bodies);
  let loca: Uint8Array;
  if (indexFormat === 0) {
    loca = new Uint8Array((numGlyphs + 1) * 2);
    const dv = new DataView(loca.buffer);
    for (let i = 0; i <= numGlyphs; i++) dv.setUint16(i * 2, offsets[i] / 2);
  } else {
    loca = new Uint8Array((numGlyphs + 1) * 4);
    const dv = new DataView(loca.buffer);
    for (let i = 0; i <= numGlyphs; i++) dv.setUint32(i * 4, offsets[i]);
  }
  return { glyf, loca, indexFormat };
}

function reconstructSimple(
  nContours: number, nPointsStream: Reader, flagStream: Reader, glyphStream: Reader,
  instructionStream: Reader, bboxValues: Reader, gi: number, hasBbox: (i: number) => boolean, overlap: boolean,
): Uint8Array {
  const endPts: number[] = [];
  let nPoints = 0;
  for (let c = 0; c < nContours; c++) { nPoints += read255UShort(nPointsStream); endPts.push(nPoints - 1); }

  const xs = new Array<number>(nPoints), ys = new Array<number>(nPoints), on = new Array<boolean>(nPoints);
  let x = 0, y = 0;
  for (let i = 0; i < nPoints; i++) {
    const flag = flagStream.u8();
    const onCurve = (flag & 0x80) === 0;
    const f = flag & 0x7f;
    const nBytes = f < 84 ? 1 : f < 120 ? 2 : f < 124 ? 3 : 4;
    const d: number[] = [];
    for (let k = 0; k < nBytes; k++) d.push(glyphStream.u8());
    let dx: number, dy: number;
    if (f < 10) { dx = 0; dy = withSign(f, ((f & 14) << 7) + d[0]); }
    else if (f < 20) { dx = withSign(f, (((f - 10) & 14) << 7) + d[0]); dy = 0; }
    else if (f < 84) { const b0 = f - 20, b1 = d[0]; dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4)); dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)); }
    else if (f < 120) { const b0 = f - 84; dx = withSign(f, 1 + ((Math.floor(b0 / 12)) << 8) + d[0]); dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + d[1]); }
    else if (f < 124) { const b2 = d[1]; dx = withSign(f, (d[0] << 4) + (b2 >> 4)); dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + d[2]); }
    else { dx = withSign(f, (d[0] << 8) + d[1]); dy = withSign(f >> 1, (d[2] << 8) + d[3]); }
    x += dx; y += dy; xs[i] = x; ys[i] = y; on[i] = onCurve;
  }

  const instrLen = read255UShort(glyphStream);
  const instr: number[] = [];
  for (let k = 0; k < instrLen; k++) instr.push(instructionStream.u8());

  let xMin: number, yMin: number, xMax: number, yMax: number;
  if (hasBbox(gi)) { xMin = bboxValues.i16(); yMin = bboxValues.i16(); xMax = bboxValues.i16(); yMax = bboxValues.i16(); }
  else if (nPoints === 0) { xMin = yMin = xMax = yMax = 0; }
  else { xMin = Math.min(...xs); yMin = Math.min(...ys); xMax = Math.max(...xs); yMax = Math.max(...ys); }

  const head = new Uint8Array(10 + nContours * 2 + 2 + instr.length);
  const dv = new DataView(head.buffer);
  dv.setInt16(0, nContours);
  dv.setInt16(2, xMin); dv.setInt16(4, yMin); dv.setInt16(6, xMax); dv.setInt16(8, yMax);
  let o = 10;
  for (const e of endPts) { dv.setUint16(o, e); o += 2; }
  dv.setUint16(o, instr.length); o += 2;
  for (const b of instr) head[o++] = b;

  const flagBytes = new Uint8Array(nPoints);
  for (let i = 0; i < nPoints; i++) { let fb = on[i] ? 0x01 : 0x00; if (i === 0 && overlap) fb |= 0x40; flagBytes[i] = fb; }

  const xc: Uint8Array[] = []; let px = 0;
  for (const xv of xs) { xc.push(i16be(xv - px)); px = xv; }
  const yc: Uint8Array[] = []; let py = 0;
  for (const yv of ys) { yc.push(i16be(yv - py)); py = yv; }

  return concat([head, flagBytes, ...xc, ...yc]);
}

function reconstructComposite(
  compositeStream: Reader, glyphStream: Reader, instructionStream: Reader,
  bboxValues: Reader, gi: number, hasBbox: (i: number) => boolean,
): Uint8Array {
  if (!hasBbox(gi)) throw new PdfParseError('WOFF2 composite glyph missing bbox', compositeStream.pos);
  const xMin = bboxValues.i16(), yMin = bboxValues.i16(), xMax = bboxValues.i16(), yMax = bboxValues.i16();

  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
    X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080, WE_HAVE_INSTR = 0x0100;
  const comps: Uint8Array[] = [];
  let haveInstructions = false;
  for (;;) {
    const start = compositeStream.pos;
    const flags = compositeStream.u16();
    compositeStream.u16();                       // glyphIndex
    if (flags & WE_HAVE_INSTR) haveInstructions = true;
    compositeStream.pos += (flags & ARG_WORDS) ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) compositeStream.pos += 2;
    else if (flags & X_AND_Y_SCALE) compositeStream.pos += 4;
    else if (flags & TWO_BY_TWO) compositeStream.pos += 8;
    comps.push(compositeStream.bytes.subarray(start, compositeStream.pos));
    if (!(flags & MORE)) break;
  }

  const head = new Uint8Array(10);
  const dv = new DataView(head.buffer);
  dv.setInt16(0, -1);
  dv.setInt16(2, xMin); dv.setInt16(4, yMin); dv.setInt16(6, xMax); dv.setInt16(8, yMax);
  const parts = [head, ...comps];
  if (haveInstructions) {
    const instrLen = read255UShort(glyphStream);
    const instr: number[] = [];
    for (let k = 0; k < instrLen; k++) instr.push(instructionStream.u8());
    parts.push(u16be(instrLen), Uint8Array.from(instr));
  }
  return concat(parts);
}
```

- [ ] **Step 4: Wire `reconstructGlyf` into `decodeWoff2`**

Replace the `out` assembly loop in `decodeWoff2` (from Task 2) with glyf-aware handling:

```ts
  const out: { tag: string; data: Uint8Array }[] = [];
  const glyfEntry = dir.find((e) => e.tag === 'glyf');
  let reconIndexFormat: number | undefined;
  if (glyfEntry && glyfEntry.transformed) {
    const { glyf, loca, indexFormat } = reconstructGlyf(raw.get('glyf')!);
    reconIndexFormat = indexFormat;
    out.push({ tag: 'glyf', data: glyf }, { tag: 'loca', data: loca });
  }
  for (const e of dir) {
    if (e.tag === 'glyf' || e.tag === 'loca') {
      if (e.transformed) continue;               // reconstructed above (transformed) ...
      out.push({ tag: e.tag, data: raw.get(e.tag)! }); // ... or verbatim (null transform)
      continue;
    }
    if (e.transformed) throw new UnsupportedFeatureError(`WOFF2 transform for '${e.tag}' not supported`);
    out.push({ tag: e.tag, data: raw.get(e.tag)! });
  }
  if (reconIndexFormat !== undefined) {
    const head = out.find((t) => t.tag === 'head');
    if (head) new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength).setInt16(50, reconIndexFormat);
  }
  return writeSfnt(flavor, out);
```

- [ ] **Step 5: Add `wrapWoff2Transformed` + `encodeTransformedGlyf` to `test/helpers/build-woff.ts`**

```ts
function i16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }

/** Parse a standard simple glyph into raw points (design units). */
function parseSimpleGlyph(g: Uint8Array): { endPts: number[]; xs: number[]; ys: number[]; on: boolean[]; instrLen: number; instr: Uint8Array } {
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const nContours = v.getInt16(0);
  let p = 10;
  const endPts: number[] = [];
  for (let i = 0; i < nContours; i++) { endPts.push(v.getUint16(p)); p += 2; }
  const nPoints = nContours === 0 ? 0 : endPts[nContours - 1] + 1;
  const instrLen = v.getUint16(p); p += 2;
  const instr = g.subarray(p, p + instrLen); p += instrLen;
  const flags: number[] = [];
  while (flags.length < nPoints) { const f = g[p++]; flags.push(f); if (f & 0x08) { let r = g[p++]; while (r-- > 0) flags.push(f); } }
  const xs: number[] = []; let x = 0;
  for (const f of flags) { if (f & 0x02) { const dx = g[p++]; x += (f & 0x10) ? dx : -dx; } else if (!(f & 0x10)) { x += v.getInt16(p); p += 2; } xs.push(x); }
  const ys: number[] = []; let y = 0;
  for (const f of flags) { if (f & 0x04) { const dy = g[p++]; y += (f & 0x20) ? dy : -dy; } else if (!(f & 0x20)) { y += v.getInt16(p); p += 2; } ys.push(y); }
  const on = flags.map((f) => (f & 0x01) !== 0);
  return { endPts, xs, ys, on, instrLen, instr };
}

/** Byte length of one composite component record (mirrors sfnt.ts). */
function componentLen(g: Uint8Array, at: number): { len: number; more: boolean; instr: boolean } {
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020, X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080, WE_HAVE_INSTR = 0x0100;
  const flags = v.getUint16(at);
  let n = 4;
  n += (flags & ARG_WORDS) ? 4 : 2;
  if (flags & WE_HAVE_A_SCALE) n += 2;
  else if (flags & X_AND_Y_SCALE) n += 4;
  else if (flags & TWO_BY_TWO) n += 8;
  return { len: n, more: (flags & MORE) !== 0, instr: (flags & WE_HAVE_INSTR) !== 0 };
}

/** Encode a standard glyf+loca into a transformed WOFF2 glyf sub-stream
 *  (always-4-byte triplets; bbox bit set for every non-empty glyph). */
export function encodeTransformedGlyf(glyf: Uint8Array, loca: number[], numGlyphs: number, indexFormat: number): Uint8Array {
  const nContour: Uint8Array[] = [], nPoints: Uint8Array[] = [], flagS: Uint8Array[] = [];
  const glyphS: Uint8Array[] = [], compS: Uint8Array[] = [], instrS: Uint8Array[] = [];
  const bboxVals: Uint8Array[] = [];
  const bitmap = new Uint8Array(Math.ceil(numGlyphs / 8));

  for (let gid = 0; gid < numGlyphs; gid++) {
    const g = glyf.subarray(loca[gid], loca[gid + 1]);
    if (g.length < 10) { nContour.push(i16(0)); continue; } // empty
    const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const nc = v.getInt16(0);
    nContour.push(i16(nc));
    const setBbox = () => { bitmap[gid >> 3] |= 0x80 >> (gid & 7); bboxVals.push(g.subarray(2, 10)); };
    if (nc > 0) {
      const s = parseSimpleGlyph(g);
      for (let c = 0; c < nc; c++) { const start = c === 0 ? 0 : s.endPts[c - 1] + 1; nPoints.push(u255(s.endPts[c] - start + 1)); }
      let px = 0, py = 0;
      for (let i = 0; i < s.xs.length; i++) {
        const dx = s.xs[i] - px, dy = s.ys[i] - py; px = s.xs[i]; py = s.ys[i];
        let flag = 124 | (dx >= 0 ? 1 : 0) | (dy >= 0 ? 2 : 0);
        if (!s.on[i]) flag |= 0x80;
        flagS.push(Uint8Array.from([flag]));
        glyphS.push(u16(Math.abs(dx)), u16(Math.abs(dy)));
      }
      glyphS.push(u255(s.instrLen));
      if (s.instrLen) instrS.push(s.instr);
      setBbox();
    } else {
      // composite: copy component records verbatim, gather instructions.
      let at = 10, haveInstr = false;
      for (;;) { const c = componentLen(g, at); compS.push(g.subarray(at, at + c.len)); haveInstr = haveInstr || c.instr; at += c.len; if (!c.more) break; }
      if (haveInstr) {
        const iv = new DataView(g.buffer, g.byteOffset, g.byteLength);
        const instrLen = iv.getUint16(at);
        glyphS.push(u255(instrLen));
        instrS.push(g.subarray(at + 2, at + 2 + instrLen));
      }
      setBbox();
    }
  }

  const nContourB = concat(nContour), nPointsB = concat(nPoints), flagB = concat(flagS);
  const glyphB = concat(glyphS), compB = concat(compS), instrB = concat(instrS);
  const bboxB = concat([bitmap, ...bboxVals]);
  const header = new Uint8Array(36);
  const hv = new DataView(header.buffer);
  hv.setUint16(4, numGlyphs);
  hv.setUint16(6, indexFormat);
  hv.setUint32(8, nContourB.length);
  hv.setUint32(12, nPointsB.length);
  hv.setUint32(16, flagB.length);
  hv.setUint32(20, glyphB.length);
  hv.setUint32(24, compB.length);
  hv.setUint32(28, bboxB.length);
  hv.setUint32(32, instrB.length);
  return concat([header, nContourB, nPointsB, flagB, glyphB, compB, bboxB, instrB]);
}

/** Wrap an sfnt as WOFF2 with glyf/loca transformed (version 0). */
export function wrapWoff2Transformed(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const head = tables.find((t) => t.tag === 'head')!;
  const maxp = tables.find((t) => t.tag === 'maxp')!;
  const numGlyphs = new DataView(maxp.data.buffer, maxp.data.byteOffset, maxp.data.byteLength).getUint16(4);
  const indexFormat = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength).getInt16(50);
  const glyfT = tables.find((t) => t.tag === 'glyf');
  const locaT = tables.find((t) => t.tag === 'loca');

  let transformedGlyf: Uint8Array | undefined;
  if (glyfT && locaT) {
    const lv = new DataView(locaT.data.buffer, locaT.data.byteOffset, locaT.data.byteLength);
    const loca: number[] = [];
    for (let i = 0; i <= numGlyphs; i++) loca.push(indexFormat === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4));
    transformedGlyf = encodeTransformedGlyf(glyfT.data, loca, numGlyphs, indexFormat);
  }

  const dir: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    if (t.tag === 'glyf' && transformedGlyf) {
      dir.push(woff2DirEntry('glyf', 0, t.data.length, transformedGlyf.length));
      bodies.push(transformedGlyf);
    } else if (t.tag === 'loca' && transformedGlyf) {
      dir.push(woff2DirEntry('loca', 0, t.data.length, 0)); // reconstructed → 0 bytes
      // no body
    } else {
      dir.push(woff2DirEntry(t.tag, 0, t.data.length));
      bodies.push(t.data);
    }
    totalSfntSize += pad4(t.data).length;
  }
  return assembleWoff2(version, tables.length, dir, bodies, totalSfntSize);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/woff.test.ts`
Expected: PASS (all cases including golden bytes). If the golden test's `flags` leftover const triggers a lint/type "unused" error, delete that line.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/woff.ts test/helpers/build-woff.ts test/woff.test.ts
git commit -m "feat(6al): WOFF2 glyf/loca transform reconstruction"
```

---

## Task 4: hmtx transform, error paths, docs

Adds the optional `hmtx` transform (version 1) reconstruction, tests the typed error paths, and updates the README.

**Files:**
- Modify: `src/woff.ts`
- Modify: `test/woff.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `reconstructGlyf` output (glyf bytes → per-glyph xMin), `raw` table map, `dir` (Tasks 2-3).
- Produces: internal `reconstructHmtx`, exported `reconstructHmtxForTest` (@internal, golden test).

- [ ] **Step 1: Write the failing tests**

Append to `test/woff.test.ts`:

```ts
import { reconstructHmtxForTest } from '../src/woff.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';

describe('WOFF2 ingestion — errors and hmtx', () => {
  it('throws UnsupportedFeatureError for a transformed non-glyf table', () => {
    // Hand-forge a minimal WOFF2 whose single table is a transformed 'cmap'
    // (transformVersion 1 on a non-glyf/loca table => transformed => unsupported).
    const stream = Uint8Array.from([1, 2, 3, 4]);
    const { brotliCompressSync } = require('node:zlib');
    const comp = new Uint8Array(brotliCompressSync(Buffer.from(stream)));
    const header = new Uint8Array(48);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x774f4632); // 'wOF2'
    hv.setUint32(4, 0x00010000); // flavor
    hv.setUint16(12, 1);         // numTables
    hv.setUint32(24, comp.length); // totalCompressedSize
    // directory: flags = (1<<6)|0 (cmap index 0, transformVersion 1), origLen=4, transformLen=4
    const dir = Uint8Array.from([(1 << 6) | 0, 4, 4]);
    const woff2 = new Uint8Array(header.length + dir.length + comp.length);
    woff2.set(header); woff2.set(dir, header.length); woff2.set(comp, header.length + dir.length);
    expect(() => parseSfnt(woff2)).toThrow(UnsupportedFeatureError);
  });

  it('throws PdfParseError on a truncated WOFF2 stream', () => {
    const good = wrapWoff2Null(buildMinimalTtf());
    const truncated = good.subarray(0, good.length - 5); // chop the brotli tail
    expect(() => parseSfnt(truncated)).toThrow(PdfParseError);
  });

  it('golden: reconstructs hmtx (lsb absent) from glyph xMins', () => {
    // numGlyphs=3, numHMetrics=3, flags bit0 set (lsb absent) -> lsb = xMin.
    // advances 500,600,700; xMins from glyf: 10, 0, -5.
    const transformed = Uint8Array.from([
      0x01,                   // flags: bit0 lsb absent
      0x01, 0xf4,             // advance 500
      0x02, 0x58,             // advance 600
      0x02, 0xbc,             // advance 700
    ]);
    const hmtx = reconstructHmtxForTest(transformed, 3, 3, [10, 0, -5]);
    const v = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
    expect(v.getUint16(0)).toBe(500); expect(v.getInt16(2)).toBe(10);
    expect(v.getUint16(4)).toBe(600); expect(v.getInt16(6)).toBe(0);
    expect(v.getUint16(8)).toBe(700); expect(v.getInt16(10)).toBe(-5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/woff.test.ts`
Expected: the hmtx golden test FAILS (`reconstructHmtxForTest` undefined). The error-path tests may already pass from Task 2/3 wiring — that's fine.

- [ ] **Step 3: Implement `reconstructHmtx` and wire it into `decodeWoff2`**

Add to `src/woff.ts`:

```ts
/** @internal Test hook for the WOFF2 hmtx transform (version 1). */
export function reconstructHmtxForTest(data: Uint8Array, numGlyphs: number, numHMetrics: number, xMins: number[]): Uint8Array {
  return reconstructHmtx(data, numGlyphs, numHMetrics, xMins);
}

/** Reconstruct a standard hmtx from the WOFF2 hmtx transform (version 1):
 *  advances are always present; lsb / trailing-lsb arrays may be omitted and
 *  reconstructed from each glyph's xMin. */
function reconstructHmtx(data: Uint8Array, numGlyphs: number, numHMetrics: number, xMins: number[]): Uint8Array {
  const r = new Reader(data);
  const flags = r.u8();
  const lsbAbsent = (flags & 0x01) !== 0;
  const trailingAbsent = (flags & 0x02) !== 0;
  const advances: number[] = [];
  for (let i = 0; i < numHMetrics; i++) advances.push(r.u16());
  const lsbs: number[] = [];
  for (let i = 0; i < numHMetrics; i++) lsbs.push(lsbAbsent ? (xMins[i] ?? 0) : r.i16());
  const trailing: number[] = [];
  for (let i = numHMetrics; i < numGlyphs; i++) trailing.push(trailingAbsent ? (xMins[i] ?? 0) : r.i16());

  const out = new Uint8Array(numHMetrics * 4 + trailing.length * 2);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < numHMetrics; i++) { dv.setUint16(o, advances[i]); dv.setInt16(o + 2, lsbs[i]); o += 4; }
  for (const t of trailing) { dv.setInt16(o, t); o += 2; }
  return out;
}
```

Wire into `decodeWoff2`: after the glyf reconstruction block and before/within the table loop, handle a transformed `hmtx`. Replace the `if (e.transformed) throw ...` branch for non-glyf tables with an hmtx special case. Compute `xMins` from the reconstructed (or verbatim) glyf, and read `numHMetrics` from the (verbatim) hhea:

```ts
  // Compute per-glyph xMin (for hmtx transform), from the assembled glyf/loca.
  const glyfTable = out.find((t) => t.tag === 'glyf')?.data;
  const locaTable = out.find((t) => t.tag === 'loca')?.data;
  const xMinsFor = (numGlyphs: number, idxFmt: number): number[] => {
    const xs: number[] = [];
    if (!glyfTable || !locaTable) return new Array(numGlyphs).fill(0);
    const lv = new DataView(locaTable.buffer, locaTable.byteOffset, locaTable.byteLength);
    for (let i = 0; i < numGlyphs; i++) {
      const a = idxFmt === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4);
      const b = idxFmt === 0 ? lv.getUint16((i + 1) * 2) * 2 : lv.getUint32((i + 1) * 4);
      xs.push(b - a >= 10 ? new DataView(glyfTable.buffer, glyfTable.byteOffset + a, 10).getInt16(2) : 0);
    }
    return xs;
  };

  const hmtxEntry = dir.find((e) => e.tag === 'hmtx');
  if (hmtxEntry && hmtxEntry.transformed) {
    if (hmtxEntry.transformVersion !== 1) throw new UnsupportedFeatureError(`WOFF2 hmtx transform version ${hmtxEntry.transformVersion} not supported`);
    const hhea = out.find((t) => t.tag === 'hhea')?.data ?? raw.get('hhea');
    if (!hhea) throw new PdfParseError('WOFF2 hmtx transform without hhea', 0);
    const numHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
    const maxp = out.find((t) => t.tag === 'maxp')?.data ?? raw.get('maxp')!;
    const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
    const idxFmt = reconIndexFormat ?? new DataView(
      (out.find((t) => t.tag === 'head')!.data).buffer,
      (out.find((t) => t.tag === 'head')!.data).byteOffset, 54).getInt16(50);
    const hmtx = reconstructHmtx(raw.get('hmtx')!, numGlyphs, numHMetrics, xMinsFor(numGlyphs, idxFmt));
    out.push({ tag: 'hmtx', data: hmtx });
  }
```

And in the main table loop, skip a transformed `hmtx` (handled above) instead of throwing:

```ts
    if (e.tag === 'hmtx' && e.transformed) continue; // reconstructed above
    if (e.transformed) throw new UnsupportedFeatureError(`WOFF2 transform for '${e.tag}' not supported`);
```

(Place the hmtx block after the loop populates `out` with glyf/loca/head/hhea/maxp. Since `writeSfnt` sorts by tag, ordering of `out` is irrelevant; ensure the hmtx block runs after the loop so `out` has hhea/maxp/head, and the loop's `hmtx && transformed → continue` prevents a duplicate.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/woff.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Update the README**

In `README.md`, find the font-embedding section describing `AddFont` / `AddFontFile` and add a note. Example insertion after the existing font-input description:

```markdown
`AddFontFile` / `AddFont` accept raw sfnt fonts (`.ttf`, `.otf`) as well as
**WOFF** and **WOFF2** web fonts — WOFF2's Brotli stream and glyf/loca (and
optional hmtx) transforms are reconstructed to sfnt in memory, then subset and
embedded through the normal pipeline.
```

- [ ] **Step 6: Full quality gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full vitest suite green (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/woff.ts test/woff.test.ts README.md
git commit -m "feat(6al): WOFF2 hmtx transform, error paths, README"
```

---

## Post-implementation

- [ ] `bd close aspose-pdf-foss-for-ts-6al`
- [ ] File a follow-up issue: "Add a real-world .woff2 regression fixture from a trusted encoder once woff2 tooling is available on the build host" (validates interop beyond self-encoded fixtures).
- [ ] Session close: `git pull --rebase && git push && git status`.

---

## Self-Review Notes

- **Spec coverage:** entry point (Task 1) ✓; WOFF v1 (Task 1) ✓; WOFF2 header/compact directory/255UShort/UIntBase128/known-tags/brotli (Task 2) ✓; glyf/loca transform + null pass-through (Tasks 2-3) ✓; hmtx v1 (Task 4) ✓; CFF/OTTO pass-through (Task 2 test) ✓; error handling — unsupported transform + truncated + typed errors (Task 4) ✓; self-encoded fixtures + null anchor + golden anchor (Tasks 2-3) ✓; README (Task 4) ✓; follow-up interop fixture issue (Post-implementation) ✓.
- **Type consistency:** `reconstructGlyf` returns `{ glyf, loca, indexFormat }` (Task 3) consumed identically in `decodeWoff2` and `reconstructGlyfForTest`. `Woff2Entry` fields (`transformed`, `transformLength`, `transformVersion`) consistent across Tasks 2-4. `withSign(flag, base)` matches the fontTools reference triplet decode. Encoder always emits the 4-byte triplet form (flag base 124), which decodes via the `f >= 124` branch.
- **Known limitation (documented):** short `loca` auto-upgrades to long when the reconstructed glyf exceeds 0x1FFFE bytes; `head.indexToLocFormat` is rewritten to match.
