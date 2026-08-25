# PDF → HTML `@font-face` embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `fonts: 'embed' | 'embed-all'` mode to fixed-mode HTML export that re-emits each PDF's embedded font programs as base64 WOFF `@font-face` rules, so text renders in the document's own faces.

**Architecture:** Reuse the raster backend's `gidForCode` (code→GID) so the browser selects exactly the glyph the rasterizer draws. For each distinct embedded program build a fresh Unicode cmap (hybrid real-Unicode / PUA per glyph), re-wrap the program as a browser sfnt (replace `cmap` for existing sfnts; wrap bare CFF into an OTF), WOFF-compress it, and emit one `@font-face`. New pure byte-builders `sfntwrite.ts` and `woffwrite.ts`; orchestration in `htmlfontembed.ts`; wiring in `htmlfixed.ts`/`html.ts`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), `node:zlib` for WOFF deflate, vitest. Spec: `docs/superpowers/specs/2026-07-16-html-font-embedding-design.md`.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins (`zlib`). No npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (`import { x } from './sfnt.js'`).
- **strict TypeScript** — `npm run typecheck` (`tsc --noEmit`) must pass.
- **TDD** — write the failing test first; fixtures live in `test/helpers/` in the existing builder style.
- **Public error types only** — `PdfParseError` / `UnsupportedFeatureError` from `errors.ts`. Byte-builders throw `PdfParseError` on malformed input.
- **`ToHtml` never throws** — every embed step is guarded; a font that fails to build degrades to map mode per font.
- **Default output byte-identical** — `mode:'fixed'` with no `fonts` (or `fonts:'map'`) must produce exactly today's bytes.
- Run `npm run typecheck` and `npm test` before considering any task done.

---

## File structure

New files:
- `src/sfntwrite.ts` — sfnt writer primitives: `buildCmap`, `assembleSfnt`, `replaceTable`, `otfFromCff`. No PDF knowledge; pure `Uint8Array` in/out.
- `src/woffwrite.ts` — `sfntToWoff`: WOFF 1.0 container (per-table `zlib.deflateSync`).
- `src/htmlfontembed.ts` — `EmbeddedFontRegistry`: embeddability probe + `fsType` policy, hybrid codepoint assignment, per-run class/string, final CSS emission.
- `test/helpers/build-embed-fonts.ts` — small helpers wrapping existing builders for the embed tests (a restricted-`fsType` variant, a ligature-ToUnicode PDF).

Modified files:
- `src/raster.ts` — add `export` to `buildGlyphSource`, `gidForCode`, and the `GlyphSource` interface (export only; no behavior change).
- `src/htmlfixed.ts` — `HtmlSink` routes runs to the embed registry when `fonts !== 'map'`; `fixedBody` concatenates the embed CSS.
- `src/html.ts` — widen `HtmlOptions.fonts`; thread it into `fixedBody`.
- `README.md` — document `fonts` option and its limits.

Test files:
- `test/sfntwrite.test.ts`, `test/woffwrite.test.ts`, `test/html.test.ts` (additions).

---

## Task 1: `sfntwrite.ts` — cmap builder, sfnt assembler, table replacement

**Files:**
- Create: `src/sfntwrite.ts`
- Test: `test/sfntwrite.test.ts`

**Interfaces:**
- Consumes: `parseSfnt` from `src/sfnt.ts` (test only); `cmapFormat4`, `buildMinimalTtf` from `test/helpers/build-sfnt.js` (test only).
- Produces:
  - `buildCmap(map: Map<number, number>): Uint8Array` — a full `cmap` table (version 0 header + one (3,1) format-4 subtable when every key ≤ 0xFFFF, plus a (3,10) format-12 subtable when any key > 0xFFFF). Keys are Unicode scalar values, values are GIDs.
  - `assembleSfnt(flavor: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array` — offset table + directory (tags ascending) + 4-byte-padded bodies, with correct per-table checksums and `head.checksumAdjustment`.
  - `replaceTable(sfnt: Uint8Array, tag: string, data: Uint8Array): Uint8Array` — parse the directory of `sfnt`, swap/insert one table, re-`assembleSfnt`.

- [ ] **Step 1: Write the failing test**

Create `test/sfntwrite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCmap, assembleSfnt, replaceTable } from '../src/sfntwrite.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';

describe('buildCmap', () => {
  it('round-trips a BMP map through parseSfnt via replaceTable', () => {
    const ttf = buildMinimalTtf();                    // glyphs 0=.notdef,1='A',2='B'
    const cmap = buildCmap(new Map([[0x48, 1], [0x49, 2]])); // H->1, I->2
    const out = replaceTable(ttf, 'cmap', cmap);
    const f = parseSfnt(out);
    expect(f.cmap.get(0x48)).toBe(1);
    expect(f.cmap.get(0x49)).toBe(2);
  });

  it('emits a format-12 subtable for an astral codepoint', () => {
    const ttf = buildMinimalTtf();
    const cmap = buildCmap(new Map([[0x1f600, 1]]));   // emoji -> gid 1
    const out = replaceTable(ttf, 'cmap', cmap);
    const f = parseSfnt(out);
    expect(f.cmap.get(0x1f600)).toBe(1);
  });
});

describe('assembleSfnt', () => {
  it('writes a valid head.checksumAdjustment', () => {
    const ttf = buildMinimalTtf();
    const rebuilt = replaceTable(ttf, 'cmap', buildCmap(new Map([[0x41, 1]])));
    // Whole-font checksum with checksumAdjustment zeroed must equal 0xB1B0AFBA - adj.
    const f = parseSfnt(rebuilt);
    expect(f.cmap.get(0x41)).toBe(1);                  // parses cleanly => directory valid
    expect(f.numGlyphs).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sfntwrite.test.ts`
Expected: FAIL — `Cannot find module '../src/sfntwrite.js'`.

- [ ] **Step 3: Implement `src/sfntwrite.ts`**

```ts
import { PdfParseError } from './errors.js';

function pad4(len: number): number { return (4 - (len & 3)) & 3; }

/** Big-endian uint32 sum over `data` padded to a 4-byte boundary (sfnt checksum). */
function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Assemble an sfnt: offset table + directory (tags ascending) + padded bodies,
 *  with per-table checksums and a correct `head.checksumAdjustment`. */
export function assembleSfnt(flavor: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset;
    offset += t.data.length + pad4(t.data.length);
    return { tag: t.tag, at, len: t.data.length, data: t.data };
  });
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  dv.setUint32(0, flavor >>> 0);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, numTables * 16 - searchRange);
  let p = 12;
  let headOffset = -1;
  for (const pl of placed) {
    for (let k = 0; k < 4; k++) out[p + k] = pl.tag.charCodeAt(k);
    dv.setUint32(p + 4, tableChecksum(pl.data));
    dv.setUint32(p + 8, pl.at);
    dv.setUint32(p + 12, pl.len);
    out.set(pl.data, pl.at);
    if (pl.tag === 'head') headOffset = pl.at;
    p += 16;
  }
  // head.checksumAdjustment = 0xB1B0AFBA - checksum(whole font with adjustment=0)
  if (headOffset >= 0) {
    dv.setUint32(headOffset + 8, 0);                    // zero the field first
    const whole = tableChecksum(out);
    dv.setUint32(headOffset + 8, (0xb1b0afba - whole) >>> 0);
  }
  return out;
}

/** Parse an sfnt directory into a tag→bytes map. */
function readTables(sfnt: Uint8Array): Map<string, Uint8Array> {
  if (sfnt.length < 12) throw new PdfParseError('sfnt too short');
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = dv.getUint16(4);
  const out = new Map<string, Uint8Array>();
  let p = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(sfnt[p], sfnt[p + 1], sfnt[p + 2], sfnt[p + 3]);
    const off = dv.getUint32(p + 8);
    const len = dv.getUint32(p + 12);
    if (off + len > sfnt.length) throw new PdfParseError(`'${tag}' table out of bounds`);
    out.set(tag, sfnt.subarray(off, off + len));
    p += 16;
  }
  return out;
}

/** Return the sfnt with table `tag` replaced (or inserted), re-assembled. */
export function replaceTable(sfnt: Uint8Array, tag: string, data: Uint8Array): Uint8Array {
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = dv.getUint32(0);
  const tables = readTables(sfnt);
  tables.set(tag, data);
  return assembleSfnt(flavor, [...tables].map(([t, d]) => ({ tag: t, data: d })));
}

/** Build a `cmap` table. A (3,1) format-4 subtable covers BMP keys; a (3,10)
 *  format-12 subtable is added when any key exceeds 0xFFFF. */
export function buildCmap(map: Map<number, number>): Uint8Array {
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const bmp = entries.filter(([cp]) => cp <= 0xffff);
  const hasAstral = entries.some(([cp]) => cp > 0xffff);
  const sub4 = buildFormat4(bmp);
  const subs: { plat: number; enc: number; data: Uint8Array }[] = [{ plat: 3, enc: 1, data: sub4 }];
  if (hasAstral) subs.push({ plat: 3, enc: 10, data: buildFormat12(entries) });
  // cmap header: version(0) numTables, then a record per subtable, then bodies.
  const headerLen = 4 + subs.length * 8;
  let off = headerLen;
  const placedSubs = subs.map((s) => { const at = off; off += s.data.length; return { ...s, at }; });
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0);
  dv.setUint16(2, subs.length);
  let p = 4;
  for (const s of placedSubs) {
    dv.setUint16(p, s.plat); dv.setUint16(p + 2, s.enc); dv.setUint32(p + 4, s.at);
    out.set(s.data, s.at);
    p += 8;
  }
  return out;
}

/** cmap format 4 over BMP (cp,gid) pairs. Contiguous runs become segments with
 *  idDelta; a required 0xFFFF→0 terminator segment closes the table. */
function buildFormat4(pairs: [number, number][]): Uint8Array {
  // Group into contiguous cp runs where gid also increments by 1.
  const segs: { start: number; end: number; delta: number }[] = [];
  for (let i = 0; i < pairs.length; ) {
    const [c0, g0] = pairs[i];
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[j][0] + 1 && pairs[j + 1][1] === pairs[j][1] + 1) j++;
    segs.push({ start: c0, end: pairs[j][0], delta: (g0 - c0) & 0xffff });
    i = j + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });   // terminator: 0xFFFF -> 0
  const segCount = segs.length;
  const segX2 = segCount * 2;
  let sel = 0; while ((1 << (sel + 1)) <= segCount) sel++;
  const searchRange = 2 * (1 << sel);
  const len = 16 + segCount * 8;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 4);
  dv.setUint16(2, len);
  dv.setUint16(4, 0);                                    // language
  dv.setUint16(6, segX2);
  dv.setUint16(8, searchRange);
  dv.setUint16(10, sel);
  dv.setUint16(12, segX2 - searchRange);
  let p = 14;
  for (const s of segs) { dv.setUint16(p, s.end); p += 2; }
  dv.setUint16(p, 0); p += 2;                            // reservedPad
  for (const s of segs) { dv.setUint16(p, s.start); p += 2; }
  for (const s of segs) { dv.setUint16(p, s.delta); p += 2; }
  for (let i = 0; i < segCount; i++) { dv.setUint16(p, 0); p += 2; } // idRangeOffset all 0
  return out;
}

/** cmap format 12 over all (cp,gid) pairs as one group each (simple, valid). */
function buildFormat12(pairs: [number, number][]): Uint8Array {
  const groups: { start: number; end: number; gid: number }[] = [];
  for (let i = 0; i < pairs.length; ) {
    const [c0, g0] = pairs[i];
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[j][0] + 1 && pairs[j + 1][1] === pairs[j][1] + 1) j++;
    groups.push({ start: c0, end: pairs[j][0], gid: g0 });
    i = j + 1;
  }
  const len = 16 + groups.length * 12;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 12);
  dv.setUint32(4, len);
  dv.setUint32(12, groups.length);
  let p = 16;
  for (const g of groups) { dv.setUint32(p, g.start); dv.setUint32(p + 4, g.end); dv.setUint32(p + 8, g.gid); p += 12; }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sfntwrite.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sfntwrite.ts test/sfntwrite.test.ts
git commit -m "feat(kkh): sfnt writer primitives — buildCmap, assembleSfnt, replaceTable"
```

---

## Task 2: `sfntwrite.ts` — `otfFromCff` (wrap bare CFF into an OTF)

**Files:**
- Modify: `src/sfntwrite.ts`
- Test: `test/sfntwrite.test.ts`

**Interfaces:**
- Consumes: `buildCmap`, `assembleSfnt` from Task 1.
- Produces:
  - `interface OtfMetrics { numGlyphs: number; unitsPerEm: number; advances: number[]; bbox: [number, number, number, number]; ascent: number; descent: number; }`
  - `otfFromCff(cff: Uint8Array, cmap: Uint8Array, m: OtfMetrics): Uint8Array` — assembles an `OTTO`-flavored sfnt: `CFF `(verbatim) + `cmap` + `head` + `hhea` + `hmtx` + `maxp`(v0.5) + `name`(minimal) + `OS/2`(v4) + `post`(v3). `advances[gid]` is the font-unit advance; missing entries use `unitsPerEm/2`.

- [ ] **Step 1: Write the failing test**

Append to `test/sfntwrite.test.ts`:

```ts
import { otfFromCff } from '../src/sfntwrite.js';
import { buildMinimalCff } from './helpers/build-cff.js';

describe('otfFromCff', () => {
  it('wraps a bare CFF into a parseable OTTO sfnt', () => {
    const cff = buildMinimalCff();                      // small CFF with a few glyphs
    const cmap = buildCmap(new Map([[0x41, 1]]));
    const otf = otfFromCff(cff, cmap, {
      numGlyphs: 3, unitsPerEm: 1000, advances: [0, 500, 500],
      bbox: [0, -200, 700, 800], ascent: 800, descent: -200,
    });
    const f = parseSfnt(otf);
    expect(f.outlines).toBe('cff');
    expect(f.numGlyphs).toBe(3);
    expect(f.cmap.get(0x41)).toBe(1);
    // CFF table bytes preserved verbatim.
    expect(Array.from(f.table!('CFF ')!)).toEqual(Array.from(cff));
  });
});
```

Note: `SfntFont.table` is `@internal` but callable in-package; the `!` narrows the optional. If TS complains about `table` visibility from a test, assert via `f.outlines`/`f.numGlyphs` only and drop the CFF-bytes check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sfntwrite.test.ts -t otfFromCff`
Expected: FAIL — `otfFromCff is not a function`.

- [ ] **Step 3: Implement `otfFromCff` in `src/sfntwrite.ts`**

```ts
export interface OtfMetrics {
  numGlyphs: number; unitsPerEm: number; advances: number[];
  bbox: [number, number, number, number]; ascent: number; descent: number;
}

function u16(v: DataView, o: number, n: number): void { v.setUint16(o, n & 0xffff); }
function i16(v: DataView, o: number, n: number): void { v.setInt16(o, n); }

function buildHead(m: OtfMetrics): Uint8Array {
  const b = new Uint8Array(54); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);                 // version 1.0
  v.setUint32(4, 0x00010000);                 // fontRevision
  v.setUint32(12, 0x5f0f3cf5);                // magicNumber
  u16(v, 16, 0x000b);                         // flags
  u16(v, 18, m.unitsPerEm);
  v.setUint32(20, 0); v.setUint32(24, 0);     // created
  v.setUint32(28, 0); v.setUint32(32, 0);     // modified
  i16(v, 36, m.bbox[0]); i16(v, 38, m.bbox[1]); i16(v, 40, m.bbox[2]); i16(v, 42, m.bbox[3]);
  u16(v, 44, 0); u16(v, 46, 0);               // mac style, lowestRecPPEM handled below
  i16(v, 48, 2);                              // fontDirectionHint
  i16(v, 50, 0);                              // indexToLocFormat (CFF: 0)
  i16(v, 52, 0);                              // glyphDataFormat
  return b;
}

function buildHhea(m: OtfMetrics, numHMetrics: number): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);
  i16(v, 4, m.ascent); i16(v, 6, m.descent); i16(v, 8, 0);   // ascender/descender/lineGap
  u16(v, 10, m.unitsPerEm);                                   // advanceWidthMax (approx)
  u16(v, 34, numHMetrics);
  return b;
}

function buildHmtx(m: OtfMetrics): Uint8Array {
  const def = Math.round(m.unitsPerEm / 2);
  const b = new Uint8Array(m.numGlyphs * 4); const v = new DataView(b.buffer);
  for (let g = 0; g < m.numGlyphs; g++) {
    const adv = m.advances[g];
    u16(v, g * 4, Math.max(0, Math.round(adv === undefined || adv <= 0 ? def : adv)));
    i16(v, g * 4 + 2, 0);
  }
  return b;
}

function buildMaxpCff(numGlyphs: number): Uint8Array {
  const b = new Uint8Array(6); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00005000);                 // version 0.5 (CFF)
  u16(v, 4, numGlyphs);
  return b;
}

function buildOS2(m: OtfMetrics): Uint8Array {
  const b = new Uint8Array(96); const v = new DataView(b.buffer);
  u16(v, 0, 4);                               // version 4
  i16(v, 2, Math.round(m.unitsPerEm / 2));    // xAvgCharWidth (approx)
  u16(v, 4, 400);                             // usWeightClass
  u16(v, 6, 5);                               // usWidthClass
  u16(v, 8, 0);                               // fsType = 0 (installable) — we already gate on source fsType
  i16(v, 68, m.ascent); i16(v, 70, -Math.abs(m.descent)); // sTypoAscender/Descender
  i16(v, 72, 0);                              // sTypoLineGap
  u16(v, 74, m.ascent); u16(v, 76, Math.abs(m.descent)); // usWinAscent/Descent
  b[32] = 0x2a; b[33] = 0x2a; b[34] = 0x2a; b[35] = 0x2a; // achVendID 'ADBE'-ish spaces
  i16(v, 88, m.ascent);                       // sxHeight (approx)
  i16(v, 90, m.ascent);                       // sCapHeight (approx)
  return b;
}

function buildName(): Uint8Array {
  // Minimal name table: 4 records (family=1, subfamily=2, full=4, ps=6) in
  // Windows/Unicode (3,1,0x409), all the ASCII "Embedded".
  const str = 'Embedded';
  const utf16 = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) utf16[i * 2 + 1] = str.charCodeAt(i);
  const ids = [1, 2, 4, 6];
  const count = ids.length;
  const headerLen = 6 + count * 12;
  const b = new Uint8Array(headerLen + utf16.length);
  const v = new DataView(b.buffer);
  u16(v, 0, 0);                               // format
  u16(v, 2, count);
  u16(v, 4, headerLen);                       // stringOffset
  let p = 6;
  for (const id of ids) {
    u16(v, p, 3); u16(v, p + 2, 1); u16(v, p + 4, 0x409); u16(v, p + 6, id);
    u16(v, p + 8, utf16.length); u16(v, p + 10, 0);
    p += 12;
  }
  b.set(utf16, headerLen);
  return b;
}

function buildPostV3(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00030000);                 // version 3.0 (no glyph names)
  return b;
}

/** Wrap a bare CFF program into an OTTO sfnt with synthesized required tables. */
export function otfFromCff(cff: Uint8Array, cmap: Uint8Array, m: OtfMetrics): Uint8Array {
  const numHMetrics = m.numGlyphs;
  const tables = [
    { tag: 'CFF ', data: cff },
    { tag: 'OS/2', data: buildOS2(m) },
    { tag: 'cmap', data: cmap },
    { tag: 'head', data: buildHead(m) },
    { tag: 'hhea', data: buildHhea(m, numHMetrics) },
    { tag: 'hmtx', data: buildHmtx(m) },
    { tag: 'maxp', data: buildMaxpCff(m.numGlyphs) },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPostV3() },
  ];
  return assembleSfnt(0x4f54544f, tables);    // 'OTTO'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sfntwrite.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/sfntwrite.ts test/sfntwrite.test.ts
git commit -m "feat(kkh): otfFromCff — wrap bare CFF into a browser OTF"
```

---

## Task 3: `woffwrite.ts` — `sfntToWoff`

**Files:**
- Create: `src/woffwrite.ts`
- Test: `test/woffwrite.test.ts`

**Interfaces:**
- Consumes: `assembleSfnt`/`replaceTable`/`buildCmap` (test only), `sfntFromWoff` from `src/woff.ts` (test only), `node:zlib` `deflateSync`.
- Produces: `sfntToWoff(sfnt: Uint8Array): Uint8Array` — a WOFF 1.0 container. Each table is `deflateSync`-compressed; a table is stored uncompressed when deflate does not shrink it (`compLength === origLength`). Table directory entries carry the original checksum (recomputed) and original length.

- [ ] **Step 1: Write the failing test**

Create `test/woffwrite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sfntToWoff } from '../src/woffwrite.js';
import { sfntFromWoff } from '../src/woff.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';
import { parseSfnt } from '../src/sfnt.js';

describe('sfntToWoff', () => {
  it('has the wOFF signature', () => {
    const woff = sfntToWoff(buildMinimalTtf());
    expect((woff[0] << 24 | woff[1] << 16 | woff[2] << 8 | woff[3]) >>> 0).toBe(0x774f4646);
  });

  it('round-trips every table through sfntFromWoff', () => {
    const ttf = buildMinimalTtf();
    const back = parseSfnt(sfntFromWoff(sfntToWoff(ttf)));
    const orig = parseSfnt(ttf);
    expect(back.numGlyphs).toBe(orig.numGlyphs);
    expect(back.cmap.get(0x41)).toBe(orig.cmap.get(0x41));
    expect(back.outlines).toBe(orig.outlines);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/woffwrite.test.ts`
Expected: FAIL — `Cannot find module '../src/woffwrite.js'`.

- [ ] **Step 3: Implement `src/woffwrite.ts`**

```ts
import { deflateSync } from 'node:zlib';
import { PdfParseError } from './errors.js';

function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Compress an sfnt into a WOFF 1.0 container (per-table zlib). */
export function sfntToWoff(sfnt: Uint8Array): Uint8Array {
  if (sfnt.length < 12) throw new PdfParseError('sfnt too short for WOFF');
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = dv.getUint32(0);
  const numTables = dv.getUint16(4);
  const dir: { tag: string; origOffset: number; origLength: number }[] = [];
  let p = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(sfnt[p], sfnt[p + 1], sfnt[p + 2], sfnt[p + 3]);
    dir.push({ tag, origOffset: dv.getUint32(p + 8), origLength: dv.getUint32(p + 12) });
    p += 16;
  }
  // WOFF header (44) + table directory (20 per table), then compressed bodies.
  const headerLen = 44 + numTables * 20;
  let bodyOffset = headerLen;
  const bodies: { comp: Uint8Array; entry: { tag: string; offset: number; compLength: number; origLength: number; checksum: number } }[] = [];
  for (const t of dir) {
    const raw = sfnt.subarray(t.origOffset, t.origOffset + t.origLength);
    const deflated = new Uint8Array(deflateSync(Buffer.from(raw)));
    const useComp = deflated.length < raw.length;
    const comp = useComp ? deflated : raw;
    const padded = (4 - (comp.length & 3)) & 3;
    bodies.push({ comp, entry: { tag: t.tag, offset: bodyOffset, compLength: comp.length, origLength: raw.length, checksum: tableChecksum(raw) } });
    bodyOffset += comp.length + padded;
  }
  const total = bodyOffset;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x774f4646);                 // 'wOFF'
  ov.setUint32(4, flavor >>> 0);
  ov.setUint32(8, total);                       // length
  ov.setUint16(12, numTables);
  ov.setUint16(14, 0);                          // reserved
  ov.setUint32(16, 12 + numTables * 16);        // totalSfntSize (uncompressed dir estimate)
  ov.setUint16(20, 1); ov.setUint16(22, 0);     // major/minor version
  ov.setUint32(24, 0); ov.setUint32(28, 0); ov.setUint32(32, 0); // meta off/len/origLen
  ov.setUint32(36, 0); ov.setUint32(40, 0);     // priv off/len
  let q = 44;
  for (const b of bodies) {
    for (let k = 0; k < 4; k++) out[q + k] = b.entry.tag.charCodeAt(k);
    ov.setUint32(q + 4, b.entry.offset);
    ov.setUint32(q + 8, b.entry.compLength);
    ov.setUint32(q + 12, b.entry.origLength);
    ov.setUint32(q + 16, b.entry.checksum);
    out.set(b.comp, b.entry.offset);
    q += 20;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/woffwrite.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/woffwrite.ts test/woffwrite.test.ts
git commit -m "feat(kkh): sfntToWoff — WOFF 1.0 writer"
```

---

## Task 4: raster exports + `htmlfontembed.ts` — `EmbeddedFontRegistry`

**Files:**
- Modify: `src/raster.ts` (add `export` keywords only)
- Create: `src/htmlfontembed.ts`
- Test: `test/html.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `buildGlyphSource`, `gidForCode`, `GlyphSource` (now exported from `src/raster.ts`); `TextFont` from `src/font.ts`; `TextRunInfo` from `src/pagerender.ts`; `SfntFont`/`parseSfnt` from `src/sfnt.ts`; `CffFont` from `src/cff.ts`; `buildCmap`/`replaceTable`/`otfFromCff` from `src/sfntwrite.ts`; `sfntToWoff` from `src/woffwrite.ts`; `Rgb`/`rgbHex` from `src/colorspace.ts`; `Document`/`PdfDict` types.
- Produces:
  - `class EmbeddedFontRegistry`
    - `constructor(doc: Document, allowRestricted: boolean)` — `allowRestricted` true for `'embed-all'`.
    - `run(info: TextRunInfo): { cls: string; display: string } | null` — returns the embedded CSS class and per-glyph rendering string for the run, or `null` when the run's font is not embeddable (caller falls back to map mode). `display` is the concatenation of each glyph's assigned rendering codepoint (real Unicode or PUA).
    - `css(): string` — every `@font-face` rule (base64 WOFF) plus every `.eN` class rule. Empty string when nothing was embedded.

**Embeddability + fsType policy (implemented inside `run`, cached per `fontDict`):**
- Resolve `GlyphSource` via `buildGlyphSource(doc, fontDict)`.
- Embeddable iff `src.sfnt` (glyf or OTTO-CFF) **or** `src.cff` came from an embedded `FontFile2`/`FontFile3` — i.e. **not** the Std-14 substitute. Detect the substitute by re-checking the `FontDescriptor` has a `FontFile2`/`FontFile3` (a `FontFile` PFB → not embeddable; no `FontFile*` → not embeddable).
- If `src.sfnt` exposes an `OS/2` table and `!allowRestricted` and `(fsType & 0x0002)`, mark non-embeddable.

- [ ] **Step 1: Add exports in `src/raster.ts`**

Change three declarations (no logic change):

```ts
export interface GlyphSource {          // was: interface GlyphSource
```
```ts
export function buildGlyphSource(doc: Document, fontDict: PdfDict): GlyphSource {   // add export
```
```ts
export function gidForCode(src: GlyphSource, code: number, text: string): number | undefined {   // add export
```

Run: `npm run typecheck`
Expected: no errors (pure export widening).

- [ ] **Step 2: Write the failing test**

Add to `test/html.test.ts`:

```ts
import { buildSimpleTtfPdf } from './helpers/build-optimize-pdf.js';

describe('ToHtml — fixed embed', () => {
  it('emits one @font-face with a base64 WOFF for an embedded TrueType', () => {
    const html = Document.Open(buildSimpleTtfPdf()).Pages[0]
      .ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
    expect(html).toContain('src:url(data:font/woff;base64,');
  });

  it('map mode (default) emits no @font-face', () => {
    const html = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).not.toContain('@font-face');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/html.test.ts -t "fixed embed"`
Expected: FAIL — `fonts` not accepted / no `@font-face` (option not wired yet — Task 5 wires it, but the registry itself is unit-tested here once imported). First make it fail on the missing `fonts` type/behavior.

- [ ] **Step 4: Implement `src/htmlfontembed.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, isDict, isName, isStream } from './types.js';
import { Rgb, rgbHex } from './colorspace.js';
import { TextRunInfo } from './pagerender.js';
import { buildGlyphSource, gidForCode, GlyphSource } from './raster.js';
import { buildCmap, replaceTable, otfFromCff, OtfMetrics } from './sfntwrite.js';
import { sfntToWoff } from './woffwrite.js';

const PUA_BASE = 0xe000;

/** Per-embedded-program accumulation: GID→rendering codepoint, GID→advance. */
interface ProgramState {
  key: number;                          // stable family index (pf<key>)
  src: GlyphSource;
  gidToCp: Map<number, number>;
  claimed: Set<number>;                 // Unicode scalars already taken by some GID
  advances: Map<number, number>;        // gid -> font-unit advance
  nextPua: number;                      // next free PUA codepoint
  embeddable: boolean;
}

export class EmbeddedFontRegistry {
  private programs = new Map<PdfDict, ProgramState>();
  private classes = new Map<string, string>();   // "pf<key>|hex" -> ".eN"
  private classRules: string[] = [];
  private nextProgram = 0;

  constructor(private doc: Document, private allowRestricted: boolean) {}

  /** Rendering string + CSS class for `info`, or null to fall back to map mode. */
  run(info: TextRunInfo): { cls: string; display: string } | null {
    const dict = info.fontDict;
    if (!dict) return null;
    const prog = this.program(dict);
    if (!prog.embeddable) return null;

    const glyphs = info.font.decodeGlyphs(info.bytes);
    let display = '';
    const unitsPerEm = programUnitsPerEm(prog);
    for (const g of glyphs) {
      const code = codeOf(info.bytes, g.byteStart, g.byteLen);
      const gid = gidForCode(prog.src, code, g.text) ?? 0;
      let cp = prog.gidToCp.get(gid);
      if (cp === undefined) {
        cp = this.assign(prog, gid, g.text);
        prog.gidToCp.set(gid, cp);
        prog.advances.set(gid, Math.round(g.width * unitsPerEm));
      }
      display += String.fromCodePoint(cp);
    }
    return { cls: this.classFor(prog, info.color), display };
  }

  /** Assign a stable rendering codepoint: real Unicode if 1 scalar and unclaimed,
   *  else the next PUA codepoint. */
  private assign(prog: ProgramState, gid: number, text: string): number {
    const cps = [...text];
    if (cps.length === 1) {
      const u = cps[0].codePointAt(0)!;
      if (!prog.claimed.has(u)) { prog.claimed.add(u); return u; }
    }
    return prog.nextPua++;
  }

  private classFor(prog: ProgramState, color: Rgb): string {
    const hex = rgbHex(color);
    const key = `pf${prog.key}|${hex}`;
    let cls = this.classes.get(key);
    if (!cls) {
      cls = `e${this.classes.size}`;
      // No synthetic weight/style: the embedded program is the exact face.
      this.classRules.push(`.${cls}{font-family:pf${prog.key};color:${hex}}`);
      this.classes.set(key, cls);
    }
    return cls;
  }

  private program(dict: PdfDict): ProgramState {
    let prog = this.programs.get(dict);
    if (prog) return prog;
    const src = buildGlyphSource(this.doc, dict);
    prog = {
      key: this.nextProgram++, src,
      gidToCp: new Map(), claimed: new Set(), advances: new Map(),
      nextPua: PUA_BASE, embeddable: this.probe(dict, src),
    } as ProgramState;
    this.programs.set(dict, prog);
    return prog;
  }

  /** Embeddable iff an embedded FontFile2/FontFile3 backs it and fsType allows. */
  private probe(dict: PdfDict, src: GlyphSource): boolean {
    const fd = descriptorOf(this.doc, dict);
    if (!isDict(fd)) return false;
    const hasFF2 = isStream(this.doc.resolve(fd.get('FontFile2')));
    const hasFF3 = isStream(this.doc.resolve(fd.get('FontFile3')));
    if (!hasFF2 && !hasFF3) return false;             // FontFile (PFB) or none
    if (!src.sfnt && !src.cff) return false;          // failed to parse
    if (!this.allowRestricted && src.sfnt) {
      const os2 = src.sfnt.table('OS/2', false);
      if (os2 && os2.length >= 10) {
        const fsType = new DataView(os2.buffer, os2.byteOffset, os2.byteLength).getUint16(8);
        if (fsType & 0x0002) return false;
      }
    }
    return true;
  }

  css(): string {
    const faces: string[] = [];
    for (const prog of this.programs.values()) {
      if (!prog.embeddable || prog.gidToCp.size === 0) continue;
      try {
        const woff = sfntToWoff(buildProgramSfnt(prog));
        const b64 = Buffer.from(woff).toString('base64');
        faces.push(`@font-face{font-family:pf${prog.key};src:url(data:font/woff;base64,${b64}) format("woff")}`);
      } catch { /* drop this font; its runs already rendered map-mode text if null,
                   or embedded-but-unstyled — acceptable degrade */ }
    }
    return faces.join('') + this.classRules.join('');
  }
}
```

Add the free helpers at the bottom of `htmlfontembed.ts`:

```ts
function codeOf(bytes: Uint8Array, start: number, len: number): number {
  let c = 0; for (let k = 0; k < len; k++) c = (c << 8) | (bytes[start + k] ?? 0); return c;
}

function descriptorOf(doc: Document, dict: PdfDict): unknown {
  const sub = doc.resolve(dict.get('Subtype'));
  if (isName(sub) && sub.name === 'Type0') {
    const dfs = doc.resolve(dict.get('DescendantFonts'));
    const df = Array.isArray(dfs) ? doc.resolve(dfs[0]) : undefined;
    return isDict(df) ? doc.resolve(df.get('FontDescriptor')) : undefined;
  }
  return doc.resolve(dict.get('FontDescriptor'));
}

function programUnitsPerEm(prog: ProgramState): number {
  return prog.src.sfnt?.unitsPerEm ?? 1000;   // CFF defaults to 1000
}

/** Build the browser-ready sfnt for a program: replace cmap on an existing sfnt,
 *  or wrap a bare CFF into an OTF. */
function buildProgramSfnt(prog: ProgramState): Uint8Array {
  const cmap = buildCmap(prog.gidToCp);
  const sf = prog.src.sfnt;
  if (sf) return replaceTable(sf.raw, 'cmap', cmap);
  const cff = prog.src.cff!;
  const advances: number[] = [];
  for (const [gid, adv] of prog.advances) advances[gid] = adv;
  const m: OtfMetrics = {
    numGlyphs: cff.numGlyphs, unitsPerEm: 1000,
    advances, bbox: [0, -200, 1000, 800], ascent: 800, descent: -200,
  };
  return otfFromCff(cff.raw ?? bareCffBytes(cff), cmap, m);
}
```

Note on `cff.raw`: `CffFont` in `src/cff.ts` is constructed from the raw CFF bytes. If it does not already retain them on a public field, add `readonly raw: Uint8Array` to `CffFont` (assign `this.raw = bytes` in its constructor) as part of this task, and drop the `bareCffBytes` fallback. Verify with `grep -n "constructor" src/cff.ts` and add the field.

- [ ] **Step 5: Retain CFF bytes if needed**

Run: `grep -n "raw\|constructor(" src/cff.ts`
If `CffFont` has no public `raw`, add to the class body and constructor:

```ts
readonly raw: Uint8Array;
// ...in constructor, first line:
this.raw = bytes;
```
Then simplify `buildProgramSfnt` to use `cff.raw` and delete the `bareCffBytes` reference.

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run typecheck`
Expected: no errors.
(The `ToHtml` end-to-end assertion still fails until Task 5 wires the option — that is expected; the registry compiles and its helpers are covered indirectly next task.)

- [ ] **Step 7: Commit**

```bash
git add src/raster.ts src/htmlfontembed.ts src/cff.ts
git commit -m "feat(kkh): EmbeddedFontRegistry + raster gidForCode/buildGlyphSource exports"
```

---

## Task 5: Wire into `htmlfixed.ts` / `html.ts`, end-to-end tests, README

**Files:**
- Modify: `src/html.ts` (add `fonts` to `HtmlOptions`; thread to `fixedBody`; append embed CSS)
- Modify: `src/htmlfixed.ts` (`HtmlSink` uses the embed registry)
- Modify: `README.md`
- Create: `test/helpers/build-embed-fonts.ts`
- Test: `test/html.test.ts`

**Interfaces:**
- Consumes: `EmbeddedFontRegistry` from `src/htmlfontembed.ts`; existing `FontRegistry` from `src/htmlfont.ts`.
- Produces: `HtmlOptions.fonts?: 'map' | 'embed' | 'embed-all'`; `fixedBody` returns the embed CSS folded into its `css` field.

- [ ] **Step 1: Add the `fonts` option in `src/html.ts`**

In the `HtmlOptions` interface add:

```ts
  /** Font handling in `fixed` mode. Default 'map'. 'embed' inlines each
   *  embeddable font program as a base64 WOFF @font-face (fsType-restricted
   *  fonts fall back to CSS stacks); 'embed-all' ignores fsType. */
  fonts?: 'map' | 'embed' | 'embed-all';
```

- [ ] **Step 2: Route runs in `src/htmlfixed.ts`**

Modify `HtmlSink` to hold both registries and choose per run. Replace the constructor and `glyphRun` font resolution:

```ts
import { EmbeddedFontRegistry } from './htmlfontembed.js';
// ...
class HtmlSink implements RenderSink {
  private svg: SvgSink;
  private spans: string[] = [];
  constructor(
    doc: Document,
    private fonts: FontRegistry,
    private embed?: EmbeddedFontRegistry,   // present when fonts !== 'map'
  ) {
    this.svg = new SvgSink(doc);
  }
  // ...
  glyphRun(info: TextRunInfo): void {
    const text = info.decoded.text;
    if (text.length === 0) return;
    const L = mul(mul(translate(0, info.rise), info.tm), info.ctm);

    let cls: string, ascent: number, content: string;
    const emb = this.embed?.run(info);
    if (emb) {
      cls = emb.cls; content = emb.display;
      ({ ascent } = this.fonts.get(info.fontFamily, info.bold, info.italic, info.color));
    } else {
      const r = this.fonts.get(info.fontFamily, info.bold, info.italic, info.color);
      cls = r.cls; ascent = r.ascent; content = text;
    }
    // ...existing fast-path / general-path style computation, unchanged...
    this.spans.push(`<span class="${cls}" style="${style}">${escapeHtml(content)}</span>`);
  }
}
```

Then in `fixedBody` construct the embed registry when requested and fold its CSS:

```ts
export function fixedBody(
  doc: Document, pages: Page[], opts: HtmlOptions,
): { body: string; css: string } {
  const box = opts.box ?? 'crop';
  const fonts = new FontRegistry();
  const embed = opts.fonts && opts.fonts !== 'map'
    ? new EmbeddedFontRegistry(doc, opts.fonts === 'embed-all')
    : undefined;
  const divs: string[] = [];
  for (const page of pages) {
    const { matrix, width, height } = baseMatrix(page, box);
    const sink = new HtmlSink(doc, fonts, embed);
    try {
      interpret(doc, page, matrix, sink, { annotations: opts.annotations });
    } catch { /* degrade */ }
    divs.push(`<div class="pg" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + sink.finish(width, height) + `</div>`);
  }
  return { body: divs.join('\n'), css: fonts.css() + (embed?.css() ?? '') };
}
```

- [ ] **Step 3: Create fixtures `test/helpers/build-embed-fonts.ts`**

```ts
// Fixtures for @font-face embed tests, layered on build-optimize-pdf helpers.
import { buildSimpleTtfPdf, buildSimpleCffPdf } from './build-optimize-pdf.js';
import { buildOS2 } from './build-sfnt.js';

/** An OS/2 table whose fsType sets the Restricted-License bit (0x0002). */
export function buildRestrictedOS2(): Uint8Array {
  const os2 = buildOS2();
  new DataView(os2.buffer, os2.byteOffset, os2.byteLength).setUint16(8, 0x0002);
  return os2;
}

/** A TrueType PDF whose embedded font is fsType-restricted. */
export function buildRestrictedTtfPdf(): Uint8Array {
  return buildSimpleTtfPdf({ os2: buildRestrictedOS2() });   // see note below
}

export { buildSimpleTtfPdf, buildSimpleCffPdf };
```

Note: if `SimpleTtfOptions` has no `os2` hook, add one — inspect `test/helpers/build-optimize-pdf.ts` `buildSimpleTtfPdf`/`SimpleTtfOptions` and thread an optional `os2?: Uint8Array` that overrides the default OS/2 table in the embedded sfnt. This is a small, local fixture-builder change.

- [ ] **Step 4: Write the end-to-end tests**

Replace/extend the `ToHtml — fixed embed` describe in `test/html.test.ts`:

```ts
import { buildSimpleCffPdf, buildCffOttoPdf, buildWholeFontPdf } from './helpers/build-optimize-pdf.js';
import { buildRestrictedTtfPdf } from './helpers/build-embed-fonts.js';
import { sfntFromWoff } from '../src/woff.js';
import { parseSfnt } from '../src/sfnt.js';

function firstWoff(html: string): Uint8Array {
  const m = html.match(/data:font\/woff;base64,([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error('no embedded woff');
  return new Uint8Array(Buffer.from(m[1], 'base64'));
}

describe('ToHtml — fixed embed', () => {
  it('TrueType: one @font-face, base64 woff parses back to an sfnt', () => {
    const html = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect((html.match(/@font-face/g) ?? []).length).toBe(1);
    const f = parseSfnt(sfntFromWoff(firstWoff(html)));
    expect(f.cmap.size).toBeGreaterThan(0);
  });

  it('bare CFF wraps into a parseable OTTO', () => {
    const html = Document.Open(buildSimpleCffPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    const f = parseSfnt(sfntFromWoff(firstWoff(html)));
    expect(f.outlines).toBe('cff');
  });

  it('OpenType-CFF FontFile3 embeds', () => {
    const html = Document.Open(buildCffOttoPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
  });

  it('Type0/CIDFontType2 embeds', () => {
    const html = Document.Open(buildWholeFontPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
  });

  it('fsType-restricted font is skipped under embed, embedded under embed-all', () => {
    const pdf = buildRestrictedTtfPdf();
    expect(Document.Open(pdf).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' })).not.toContain('@font-face');
    expect(Document.Open(pdf).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed-all' })).toContain('@font-face');
  });

  it('default (map) output is unchanged vs no fonts option', () => {
    const a = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed' });
    const b = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'map' });
    expect(b).toBe(a);
    expect(a).not.toContain('@font-face');
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/html.test.ts test/sfntwrite.test.ts test/woffwrite.test.ts`
Expected: PASS. If the fsType or CID case fails, debug against the actual embedded OS/2 / descriptor with `Document.Open(pdf)` in a scratch script before adjusting the probe.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green (no regressions in existing html/render/optimize tests).

- [ ] **Step 7: Update README**

In `README.md` under the HTML export section, document:
- `fonts?: 'map' | 'embed' | 'embed-all'` (fixed mode only; default `'map'`).
- `'embed'` inlines embeddable programs as base64 WOFF `@font-face`; output size grows substantially.
- Limits: Type1 (`FontFile`) fonts and non-embedded Std-14 fonts fall back to CSS stacks; fonts are embedded as-is (no re-subsetting); ligature/collision glyphs use PUA codepoints (render correctly, copy as PUA); `'embed-all'` ignores `fsType` (caller assumes licensing responsibility).

- [ ] **Step 8: Commit**

```bash
git add src/html.ts src/htmlfixed.ts test/html.test.ts test/helpers/build-embed-fonts.ts test/helpers/build-optimize-pdf.ts README.md
git commit -m "feat(kkh): fonts:'embed' @font-face embedding for fixed-mode HTML export"
```

---

## Task 6: Hybrid PUA + dedup coverage

**Files:**
- Modify: `test/html.test.ts`
- Create: fixture in `test/helpers/build-embed-fonts.ts` (a ligature-ToUnicode PDF) if not already covered

**Interfaces:** Consumes everything above; no new production code expected (this task verifies the hybrid/dedup behavior and fixes any gaps found).

- [ ] **Step 1: Write the hybrid + dedup tests**

```ts
describe('ToHtml — fixed embed hybrid/dedup', () => {
  it('a multi-scalar ToUnicode glyph gets a PUA codepoint in the span', () => {
    // Build a simple font whose ToUnicode maps one code to "ffi".
    const html = Document.Open(buildLigatureTtfPdf()).Pages[0]
      .ToHtml({ mode: 'fixed', fonts: 'embed' });
    // A PUA scalar (U+E000..U+F8FF) must appear in a span for the ligature glyph.
    expect(/[-]/.test(html)).toBe(true);
  });

  it('two runs sharing one font emit exactly one @font-face', () => {
    const html = Document.Open(buildSharedProgramPdf()).ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect((html.match(/@font-face/g) ?? []).length).toBe(1);
  });
});
```

Add `buildLigatureTtfPdf` to `test/helpers/build-embed-fonts.ts` by cloning `buildSimpleTtfPdf` with a `/ToUnicode` CMap that maps the shown code to the string `ffi` (reuse the existing ToUnicode-stream construction in `build-optimize-pdf.ts`; if none is parameterizable, write a minimal `/ToUnicode` bfchar stream inline). Import `buildSharedProgramPdf` from `build-optimize-pdf.js`.

- [ ] **Step 2: Run, verify fail then implement fixture, verify pass**

Run: `npx vitest run test/html.test.ts -t "hybrid/dedup"`
Expected: initially FAIL (missing fixture), then PASS after adding `buildLigatureTtfPdf`. If the PUA assertion fails, confirm the ToUnicode really yields a 3-char string for that code via a scratch `TextFont.decodeGlyphs` call, then fix the fixture (not the registry — the registry logic is already covered).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/html.test.ts test/helpers/build-embed-fonts.ts
git commit -m "test(kkh): hybrid PUA assignment + per-program @font-face dedup"
```

---

## Task 7: Close-out

- [ ] **Step 1: Final gates**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Update the issue**

```bash
bd update aspose-pdf-foss-for-ts-kkh --status in_progress   # if not already
bd close aspose-pdf-foss-for-ts-kkh
```

- [ ] **Step 3: Session close (per CLAUDE.md)**

```bash
git pull --rebase
git push
git status   # must show up to date with origin
```

---

## Self-review notes

- **Spec coverage:** API (`fonts`) → Task 5; hybrid assignment → Task 4/6; flavor table (glyf replace-cmap, OTTO replace-cmap, bare-CFF wrap, Type1/no-FontFile fallback) → Task 4 (`buildProgramSfnt`/`probe`) + Task 5 tests; fsType policy → Task 4 `probe` + Task 5 test; WOFF → Task 3; cmap format 4/12 → Task 1; advances/hmtx → Task 2/4; never-throws degrade → guarded `run`/`css`; default byte-identical → Task 5 test; testing matrix → Tasks 1–6; out-of-scope items documented → Task 5 README.
- **Type consistency:** `EmbeddedFontRegistry.run` returns `{ cls, display } | null` (Task 4) and is consumed exactly so in Task 5; `OtfMetrics` defined in Task 2 and imported in Task 4; `buildGlyphSource`/`gidForCode`/`GlyphSource` exported in Task 4 Step 1 and imported in `htmlfontembed.ts`.
- **Known verification points flagged inline** (resolve during execution, not assumptions to skip): `CffFont` public `raw` field (Task 4 Step 5); `SimpleTtfOptions.os2` hook (Task 5 Step 3); `SfntFont.table` in-package visibility from tests (Task 2 Step 1 note).
