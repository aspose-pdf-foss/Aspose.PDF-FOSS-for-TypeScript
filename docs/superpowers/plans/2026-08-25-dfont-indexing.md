# `.dfont` indexing and embedding (`l1my.6`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `AddFont`/`AddFontFile` embed a face from a macOS `.dfont` suitcase, and let `LoadFontByName` find one in a registered folder.

**Architecture:** A `.dfont` holds ordinary sfnt faces inside a Macintosh resource-fork structure kept in the file's *data* fork. Each `sfnt` resource is a complete, self-consistent sfnt whose table offsets are relative to its own start, so a face is a `subarray` — no `assembleSfnt` rebuild of the kind `ttc.ts` needs. A new pure leaf `src/dfont.ts` walks the resource map through a **reader callback**, so `parseSfnt` (which holds the whole buffer) and `fontsource.ts` (which holds a file descriptor and must not read one) share one implementation of the format. `parseSfnt` dispatches on it last, after the cheap `u32` signature tests, so every downstream consumer — subsetting, `/FontFile2`, Identity-H, `/ToUnicode`, `fontmatch.ts` — is untouched.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-dfont-indexing-design.md` — read it before Task 1. The plan argues from the spec.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `src/dfont.ts` imports `./errors.js` and nothing else.
- **ESM + NodeNext:** every import specifier carries `.js` (`import { PdfParseError } from './errors.js';`).
- **Strict TypeScript.** `npm run typecheck` green before any commit.
- **No import cycles.** Verified before writing: `errors.ts` imports nothing. So `sfnt.ts → dfont.ts → errors.js` and `fontsource.ts → dfont.ts → errors.js` close no cycle. **Do not import `sfnt.ts`, `sfntwrite.ts` or `document.ts` from `dfont.ts`** — the first two would close a cycle and the third is a layering violation. There is nothing to assemble, so `sfntwrite.ts` is not needed at all.
- **Nothing in the folder scan throws.** A `.dfont` that will not parse yields no faces and is skipped. `extractDfontFace` *does* throw `PdfParseError` — that asymmetry is `ttc.ts`'s and is deliberate.
- **A face is a `subarray`, never a copy or a rebuild.** `SfntFont` threads `byteOffset` through every `DataView` (`src/sfnt.ts:21`), so this is safe. Do not `.slice()`.
- **Detection is structural, and goes LAST in the dispatch chain.** A `.dfont` has no signature bytes, so the walk *is* the test. It must not run before the three `u32` compares, or every other format pays for it.
- **Commit style:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` as the last line. Cite `l1my.6` in the subject scope.

### The resource-fork layout, written out once

Referred to by every task below.

```
0    u32 dataOffset      offset from file start to the data area
4    u32 mapOffset       offset from file start to the resource map
8    u32 dataLength
12   u32 mapLength
     ... conventionally zero padding to 256 ...

dataOffset:  per resource: u32 length, then that many bytes

mapOffset+0    16 bytes  reserved for a copy of the header (NOT relied on)
mapOffset+16   u32       reserved, next-map handle
mapOffset+20   u16       reserved, file reference number
mapOffset+22   u16       fork attributes
mapOffset+24   u16       offset to the TYPE LIST, from the MAP start
mapOffset+26   u16       offset to the name list, from the MAP start

type list +0   u16       number of types MINUS ONE
then per type, 8 bytes:
       +0      u32       type tag, e.g. 'sfnt'
       +4      u16       number of resources of this type MINUS ONE
       +6      u16       offset to its reference list, from the TYPE LIST start
then per reference, 12 bytes:
       +0      u16       resource id
       +2      u16       offset to its name, or 0xFFFF for none
       +4      u8        attributes
       +5      u24       offset to its data, from dataOffset
       +8      u32       reserved handle
```

**The four details that are silent when wrong**, each of which gets a mutation check below: both counts are stored **minus one**; the reference-list offset is based on the **type list**, not the map; the `u24` addresses a **length**, so the sfnt starts four bytes later; and non-`sfnt` types share the map, so faces are selected **by tag**, never by position.

---

### Task 1: `dfont.ts` — the container reader

**Files:**
- Create: `src/dfont.ts`
- Create: `test/helpers/build-dfont.ts`
- Test: `test/dfont.test.ts`

**Interfaces:**
- Consumes: `PdfParseError` from `src/errors.js` (`new PdfParseError(message: string, offset?: number)`). `buildNamedFont({ family, subfamily?, typographicFamily?, bold?, italic?, weight?, padGlyf? }): Uint8Array` from `test/helpers/build-sfnt.js`.
- Produces:
  - `export type ByteReader = (offset: number, length: number) => Uint8Array`
  - `export function dfontSfntRanges(read: ByteReader, fileLength: number): { offset: number; length: number }[] | undefined`
  - `export function isDfont(bytes: Uint8Array): boolean`
  - `export function extractDfontFace(bytes: Uint8Array, index: number): Uint8Array`
  - `export function buildDfont(spec: DfontSpec): Uint8Array` in the test helper, where `DfontSpec` is `{ faces: Uint8Array[]; otherTypes?: { tag: string; resources: Uint8Array[] }[]; dataOffset?: number; zeroHeaderCopy?: boolean }`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-dfont.ts`:

```ts
// Builds a Macintosh resource fork around N sfnt payloads — the .dfont
// container. The layout is transcribed from Inside Macintosh: More Macintosh
// Toolbox, and src/dfont.ts reads it back. NOTE THE HAZARD, recorded in the
// design and in PROVENANCE.md: this builder and that reader share one reading
// of the format, so the suite proves they agree, NOT that either matches what
// Apple writes. There is no real .dfont in test/fixtures/.

function u32b(v: number): Uint8Array {
  return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
function u16b(v: number): Uint8Array { return Uint8Array.from([(v >> 8) & 0xff, v & 0xff]); }
function u24b(v: number): Uint8Array {
  return Uint8Array.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}
function tag4(s: string): Uint8Array {
  return Uint8Array.from([0, 1, 2, 3].map((i) => s.charCodeAt(i) & 0xff));
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The 28-byte map prologue: header copy, next-map handle, file ref,
 *  attributes, and the two list offsets. */
const MAP_PROLOGUE = 28;

export interface DfontSpec {
  /** sfnt payloads, in the order they become faces. */
  faces: Uint8Array[];
  /** Types written BEFORE the sfnt type — a real suitcase carries `FOND`, and
   *  often `NFNT` or `POST`, in the same map. Putting them first is what makes
   *  a positional reader return the wrong resource. */
  otherTypes?: { tag: string; resources: Uint8Array[] }[];
  /** Padding before the data area. Default 256, which is what Apple writes;
   *  a non-zero default is deliberate, so no offset is incidentally zero. */
  dataOffset?: number;
  /** Write zeros where the map's copy of the header goes. Default false.
   *  Nothing enforces that field, and src/dfont.ts must not depend on it. */
  zeroHeaderCopy?: boolean;
}

export function buildDfont(spec: DfontSpec): Uint8Array {
  const dataOffset = spec.dataOffset ?? 256;
  const types = [...(spec.otherTypes ?? []), { tag: 'sfnt', resources: spec.faces }];

  // Data area: each resource is a u32 length then its payload. A reference
  // entry holds the offset of that LENGTH, relative to the data area.
  const dataParts: Uint8Array[] = [];
  const resOffsets: number[][] = [];
  let dataLength = 0;
  for (const t of types) {
    const offs: number[] = [];
    for (const r of t.resources) {
      offs.push(dataLength);
      dataParts.push(u32b(r.length), r);
      dataLength += 4 + r.length;
    }
    resOffsets.push(offs);
  }

  // Type list: a count, one 8-byte entry per type, then the reference lists.
  // BOTH counts are stored MINUS ONE.
  const numTypes = types.length;
  const entries: Uint8Array[] = [u16b(numTypes - 1)];
  const refLists: Uint8Array[] = [];
  let refAt = 2 + numTypes * 8;              // from the TYPE LIST start
  types.forEach((t, ti) => {
    entries.push(tag4(t.tag), u16b(t.resources.length - 1), u16b(refAt));
    for (let i = 0; i < t.resources.length; i++) {
      refLists.push(
        u16b(128 + i),                       // resource id
        u16b(0xffff),                        // no name
        Uint8Array.from([0]),                // attributes
        u24b(resOffsets[ti][i]),
        u32b(0),                             // reserved handle
      );
    }
    refAt += t.resources.length * 12;
  });
  const typeList = concat([...entries, ...refLists]);

  const mapLength = MAP_PROLOGUE + typeList.length;   // empty name list
  const mapOffset = dataOffset + dataLength;
  const header = concat([u32b(dataOffset), u32b(mapOffset), u32b(dataLength), u32b(mapLength)]);

  const map = concat([
    spec.zeroHeaderCopy ? new Uint8Array(16) : header,
    u32b(0), u16b(0), u16b(0),
    u16b(MAP_PROLOGUE),                      // type list offset, from map start
    u16b(mapLength),                         // name list: empty, so at the end
    typeList,
  ]);

  const out = new Uint8Array(mapOffset + mapLength);
  out.set(header, 0);
  let p = dataOffset;
  for (const part of dataParts) { out.set(part, p); p += part.length; }
  out.set(map, mapOffset);
  return out;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/dfont.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dfontSfntRanges, isDfont, extractDfontFace } from '../src/dfont.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildDfont } from './helpers/build-dfont.js';
import { buildNamedFont, buildMinimalTtf } from './helpers/build-sfnt.js';

/** The walk over a whole buffer, which is what extractDfontFace does too. */
const ranges = (b: Uint8Array) => dfontSfntRanges((o, l) => b.subarray(o, o + l), b.length);

describe('dfontSfntRanges', () => {
  it('finds the one face of a single-face suitcase', () => {
    // THE MINUS-ONE CASE. Both counts are stored minus one, so a suitcase
    // holding one face stores 0 -- read raw, every single-face .dfont in
    // existence yields no faces at all, with nothing to say why.
    const face = buildNamedFont({ family: 'Solo Sans' });
    const r = ranges(buildDfont({ faces: [face] }));
    expect(r).toBeDefined();
    expect(r!.length).toBe(1);
  });

  it('finds both faces of a two-face suitcase, in order', () => {
    const a = buildNamedFont({ family: 'Duo Sans' });
    const b = buildNamedFont({ family: 'Duo Sans', subfamily: 'Bold', bold: true, weight: 700 });
    const d = buildDfont({ faces: [a, b] });
    const r = ranges(d)!;
    expect(r.length).toBe(2);
    expect(d.subarray(r[0].offset, r[0].offset + r[0].length)).toEqual(a);
    expect(d.subarray(r[1].offset, r[1].offset + r[1].length)).toEqual(b);
  });

  it('selects by TYPE TAG, not by position in the map', () => {
    // A real suitcase carries FOND family records beside its sfnts. Here the
    // FOND comes FIRST in both the data area and the type list, so a reader
    // that indexes positionally hands back the FOND as though it were a font.
    const face = buildNamedFont({ family: 'Tagged Sans' });
    const d = buildDfont({
      faces: [face],
      otherTypes: [{ tag: 'FOND', resources: [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])] }],
    });
    const r = ranges(d)!;
    expect(r.length).toBe(1);
    expect(d.subarray(r[0].offset, r[0].offset + r[0].length)).toEqual(face);
  });

  it('does not depend on the map carrying a copy of the header', () => {
    // Inside Macintosh reserves those 16 bytes for a header copy and nothing
    // enforces it. Requiring a match would refuse a font for no benefit.
    const r = ranges(buildDfont({
      faces: [buildNamedFont({ family: 'Zeroed Sans' })], zeroHeaderCopy: true,
    }));
    expect(r).toBeDefined();
    expect(r!.length).toBe(1);
  });

  it('rejects what is not a suitcase, rather than guessing', () => {
    expect(ranges(buildMinimalTtf())).toBeUndefined();
    expect(ranges(new Uint8Array(0))).toBeUndefined();
    expect(ranges(new Uint8Array(64))).toBeUndefined();          // all zeros
    expect(ranges(new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'))))
      .toBeUndefined();
  });

  it('rejects a suitcase holding no sfnt type', () => {
    // A bitmap-only suitcase is a real thing and is not a font we can use.
    const d = buildDfont({
      faces: [], otherTypes: [{ tag: 'NFNT', resources: [Uint8Array.from([9, 9])] }],
    });
    expect(ranges(d)).toBeUndefined();
  });
});

describe('extractDfontFace', () => {
  it('hands back a face that parseSfnt reads', () => {
    const d = buildDfont({ faces: [buildNamedFont({ family: 'Real Sans' })] });
    const f = parseSfnt(extractDfontFace(d, 0));
    expect(f.numGlyphs).toBe(2);
  });

  it('addresses faces by index, as a collection does', () => {
    const d = buildDfont({
      faces: [
        buildNamedFont({ family: 'Pick Sans' }),
        buildNamedFont({ family: 'Pick Sans', subfamily: 'Bold', bold: true, weight: 700 }),
      ],
    });
    expect(parseSfnt(extractDfontFace(d, 1)).postScriptName).toBe('PickSans');
    expect(extractDfontFace(d, 0)).not.toEqual(extractDfontFace(d, 1));
  });

  it('throws on a non-suitcase and on an index that is not there', () => {
    // The asymmetry ttc.ts sets: a folder scan catches and skips, while a
    // caller NAMING a face is told it asked for something absent.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'One Sans' })] });
    expect(() => extractDfontFace(buildMinimalTtf(), 0)).toThrow(/not a \.dfont/);
    expect(() => extractDfontFace(d, 1)).toThrow(/asked for index 1/);
    expect(() => extractDfontFace(d, -1)).toThrow();
  });

  it('returns a view, not a copy', () => {
    // A face needs no rebuild -- each sfnt resource is self-consistent with
    // offsets relative to its own start -- and SfntFont threads byteOffset
    // through every DataView, so a subarray is safe and free.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'View Sans' })] });
    expect(extractDfontFace(d, 0).buffer).toBe(d.buffer);
  });
});

describe('isDfont', () => {
  it('agrees with the walk', () => {
    expect(isDfont(buildDfont({ faces: [buildNamedFont({ family: 'Is Sans' })] }))).toBe(true);
    expect(isDfont(buildMinimalTtf())).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/dfont.test.ts`
Expected: FAIL — `Failed to load url ../src/dfont.js`.

- [ ] **Step 4: Write the implementation**

Create `src/dfont.ts`:

```ts
/**
 * Macintosh `.dfont` font suitcases.
 *
 * A `.dfont` is a DATA-fork font: it holds resource-fork-FORMAT bytes in the
 * ordinary data fork, which is the entire reason the format exists. So there
 * is no `..namedfork/rsrc` path to handle and no platform branch anywhere —
 * `openSync` sees one as a plain file.
 *
 * Each `sfnt` resource is a complete, self-consistent sfnt whose table offsets
 * are relative to its own start, so a face is a `subarray` rather than the
 * `assembleSfnt` rebuild `ttc.ts` needs. `SfntFont` threads `byteOffset`
 * through every `DataView`, which is what makes that safe.
 *
 * A pure leaf: `errors.js` and nothing else.
 */
import { PdfParseError } from './errors.js';

/** Reads `length` bytes at `offset`, or fewer at end of file. */
export type ByteReader = (offset: number, length: number) => Uint8Array;

const u16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const u24 = (d: Uint8Array, o: number): number => (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

const SFNT = 0x73666e74;   // 'sfnt'
/** Header copy, next-map handle, file ref, attributes, two list offsets. */
const MAP_PROLOGUE = 28;
/** `mapLength` is a u32 in a file we did not write. A map is small even for a
 *  large suitcase — 1 MB is some 87,000 resources — so this bounds a hostile
 *  value without bounding a real one. */
const MAX_MAP = 1 << 20;

/**
 * The byte range of each `sfnt` resource, or `undefined` when this is not a
 * `.dfont`.
 *
 * A `.dfont` carries NO SIGNATURE — it opens with a raw `u32` data offset — so
 * the walk that finds the faces IS the test that the file is one. Same shape as
 * `ttcFaceOffsets`, and for the same reason.
 *
 * Takes a READER rather than bytes, because two callers want this walk over
 * different access strategies: `parseSfnt` holds the whole buffer, and
 * `fontsource.ts` holds a file descriptor and must not read one. A bytes-only
 * signature would force `fontsource.ts` to keep its own map parse — which is
 * how an index and a loader come to disagree about how many faces a file holds.
 */
export function dfontSfntRanges(
  read: ByteReader, fileLength: number,
): { offset: number; length: number }[] | undefined {
  if (fileLength < 16 + MAP_PROLOGUE) return undefined;
  const h = read(0, 16);
  if (h.length < 16) return undefined;
  const dataOffset = u32(h, 0), mapOffset = u32(h, 4);
  const dataLength = u32(h, 8), mapLength = u32(h, 12);

  if (dataOffset < 16 || mapOffset < 16) return undefined;
  if (mapLength < MAP_PROLOGUE + 2 || mapLength > MAX_MAP) return undefined;
  if (dataOffset + dataLength > fileLength) return undefined;
  if (mapOffset + mapLength > fileLength) return undefined;

  const map = read(mapOffset, mapLength);
  if (map.length < mapLength) return undefined;

  // The map's first 16 bytes are reserved for a copy of the header. Nothing
  // enforces that, so it is deliberately NOT checked: a tool that zeroes the
  // field would otherwise cost us a font for no benefit.
  const typeListAt = u16(map, 24);
  if (typeListAt + 2 > mapLength) return undefined;
  const numTypes = u16(map, typeListAt) + 1;          // stored MINUS ONE
  if (typeListAt + 2 + numTypes * 8 > mapLength) return undefined;

  for (let i = 0; i < numTypes; i++) {
    const e = typeListAt + 2 + i * 8;
    // Faces are selected by TAG, never by position: a real suitcase carries
    // FOND records, and often NFNT strikes or POST fragments, in this same list.
    if (u32(map, e) !== SFNT) continue;
    const count = u16(map, e + 4) + 1;                // stored MINUS ONE
    // The reference-list offset is from the TYPE LIST start, not the map start.
    // The two bases differ by the 28-byte prologue, so confusing them lands
    // inside a real structure and reads a plausible wrong list.
    const refAt = typeListAt + u16(map, e + 6);
    if (refAt < 0 || refAt + count * 12 > mapLength) return undefined;

    const out: { offset: number; length: number }[] = [];
    for (let r = 0; r < count; r++) {
      const at = dataOffset + u24(map, refAt + r * 12 + 5);
      if (at + 4 > fileLength) return undefined;
      const lenBytes = read(at, 4);
      if (lenBytes.length < 4) return undefined;
      // That u24 addresses a LENGTH, not data: the sfnt begins four bytes on.
      const length = u32(lenBytes, 0);
      const offset = at + 4;
      if (length === 0 || offset + length > fileLength) return undefined;
      out.push({ offset, length });
    }
    return out;
  }
  return undefined;      // a bitmap-only suitcase, or not a suitcase at all
}

const slicer = (bytes: Uint8Array): ByteReader =>
  (o, l) => bytes.subarray(o, Math.min(o + l, bytes.length));

/**
 * Whether `bytes` opens as a `.dfont`.
 *
 * This walks the container a second time, which is accepted rather than
 * optimised away: the walk reads the header and the map and no glyph data, and
 * what it buys is a `parseSfnt` dispatch chain that reads uniformly beside
 * `isType1(bytes)`, plus an `extractDfontFace` that can still distinguish "not
 * a suitcase" from "no such face in this suitcase".
 */
export function isDfont(bytes: Uint8Array): boolean {
  return dfontSfntRanges(slicer(bytes), bytes.length) !== undefined;
}

/**
 * Face `index` of a suitcase, as a standalone sfnt.
 *
 * Throws `PdfParseError` for a non-`.dfont` or an out-of-range index. A caller
 * scanning a folder catches that and skips the file; a caller naming a face is
 * being told it asked for something that is not there — `ttc.ts`'s rule.
 */
export function extractDfontFace(bytes: Uint8Array, index: number): Uint8Array {
  const ranges = dfontSfntRanges(slicer(bytes), bytes.length);
  if (!ranges) throw new PdfParseError('not a .dfont (no resource map with an sfnt type)', 0);
  if (!Number.isInteger(index) || index < 0 || index >= ranges.length) {
    throw new PdfParseError(`.dfont holds ${ranges.length} faces, asked for index ${index}`, 0);
  }
  const r = ranges[index];
  return bytes.subarray(r.offset, r.offset + r.length);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/dfont.test.ts`
Expected: PASS, 11 tests.

If "finds both faces of a two-face suitcase" fails on the payload comparison, the fault is almost certainly the four-byte length skip or the reference-list base — diagnose which before touching anything else; both are covered by the mutations in the next step.

- [ ] **Step 6: Mutation-check the four silent details**

Run `npx vitest run test/dfont.test.ts` after each, then **restore it**.

1. **Minus-one on the type count.** Change `const numTypes = u16(map, typeListAt) + 1;` to drop the `+ 1`. Expected: RED — a single-type suitcase finds no types at all.
2. **Minus-one on the resource count.** Change `const count = u16(map, e + 4) + 1;` to drop the `+ 1`. Expected: RED on "finds the one face of a single-face suitcase".
3. **Reference-list base.** Change `const refAt = typeListAt + u16(map, e + 6);` to `const refAt = u16(map, e + 6);`. Expected: RED.
4. **The four-byte length skip.** Change `const offset = at + 4;` to `const offset = at;`. Expected: RED on the payload comparisons.
5. **Selection by tag.** Change `if (u32(map, e) !== SFNT) continue;` to `if (false) continue;`. Expected: RED on "selects by TYPE TAG, not by position in the map".

Record all five in the commit body.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/dfont.ts test/helpers/build-dfont.ts test/dfont.test.ts
git commit -F - <<'EOF'
feat(l1my.6): read a face out of a .dfont suitcase

A .dfont is a DATA-fork font -- resource-fork format bytes in the
ordinary data fork -- so there is no macOS-specific path handling here
and no platform branch anywhere. And a face needs no assembleSfnt
rebuild of the kind ttc.ts does: each sfnt resource is self-consistent
with offsets relative to its own start, so extraction is a subarray.
SfntFont threading byteOffset through every DataView is what makes that
safe. The module is therefore a pure leaf over errors.js alone.

A .dfont carries NO signature -- it opens with a raw u32 data offset --
so the walk that finds the faces IS the test that the file is one,
mirroring ttcFaceOffsets. The walk takes a reader CALLBACK rather than
bytes, because parseSfnt holds a buffer while fontsource.ts holds a file
descriptor and must not read one; a bytes-only signature would force a
second map parse, which is how an index and a loader come to disagree
about how many faces a file holds.

Five mutations, each measured red: dropping either MINUS-ONE count (a
single-face suitcase then yields nothing at all), basing the
reference-list offset on the map rather than the type list, omitting the
four-byte skip past the resource length, and selecting resources
positionally rather than by type tag -- which returns a FOND record as
though it were a font.

The map's 16-byte copy of the header is deliberately NOT checked. Nothing
enforces that field, and requiring it would cost us a font for no gain.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Dispatch from `parseSfnt`

After this task `AddFont`/`AddFontFile` accept a `.dfont`, and everything downstream works untouched.

**Files:**
- Modify: `src/sfnt.ts:370-377` (the signature dispatch in `parseSfnt`)
- Test: `test/dfont-embed.test.ts`

**Interfaces:**
- Consumes: `isDfont`, `extractDfontFace` from Task 1.
- Produces: no new exports — `parseSfnt(bytes, faceIndex?)` simply accepts a `.dfont`.

- [ ] **Step 1: Write the failing test**

Create `test/dfont-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildDfont } from './helpers/build-dfont.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

/** A real font inside the suitcase, so the embed path has glyphs to draw and
 *  the extracted face is proved to be a working font rather than merely a
 *  parseable one. */
const LIBERATION = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));

describe('parseSfnt — .dfont', () => {
  it('reads a face out of a suitcase', () => {
    const f = parseSfnt(buildDfont({ faces: [LIBERATION] }));
    expect(f.numGlyphs).toBe(parseSfnt(LIBERATION).numGlyphs);
    expect(f.postScriptName).toBe(parseSfnt(LIBERATION).postScriptName);
  });

  it('selects a face with faceIndex, as it does for a collection', () => {
    const d = buildDfont({
      faces: [buildNamedFont({ family: 'Alpha Sans' }), buildNamedFont({ family: 'Beta Sans' })],
    });
    expect(parseSfnt(d, 0).postScriptName).toBe('AlphaSans');
    expect(parseSfnt(d, 1).postScriptName).toBe('BetaSans');
  });

  it('throws for a face that is not there', () => {
    // A .dfont is a CONTAINER, so this behaves as a .ttc does. Contrast a bare
    // sfnt, where faceIndex is meaningless rather than erroneous.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'Solo Sans' })] });
    expect(() => parseSfnt(d, 3)).toThrow(/asked for index 3/);
    expect(() => parseSfnt(LIBERATION, 3)).not.toThrow();
  });
});

describe('Document.AddFontFile — .dfont', () => {
  it('embeds a face from a suitcase and keeps the text extractable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-dfont-'));
    const path = join(dir, 'Suitcase.dfont');
    writeFileSync(path, buildDfont({ faces: [LIBERATION] }));

    const doc = Document.New();
    const font = doc.AddFontFile(path);
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('Hamburg', 72, 700, { font, fontSize: 24 });
    const out = doc.Save();

    const reopened = Document.Open(out);
    expect(reopened.Pages[0].GetText()).toContain('Hamburg');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/dfont-embed.test.ts`
Expected: FAIL — `PdfParseError: unrecognized sfnt version 0x00000100`.

- [ ] **Step 3: Write the implementation**

In `src/sfnt.ts`, add the import beside the existing ones:

```ts
import { isDfont, extractDfontFace } from './dfont.js';
```

and extend the dispatch. The existing chain at `src/sfnt.ts:370-377` ends with the Type 1 branch; append after it:

```ts
  // A .dfont carries no signature, so this is a structural walk rather than a
  // u32 compare — which is why it goes LAST, after every cheap test. A face is
  // a subarray of one `sfnt` resource; see dfont.ts for why nothing is rebuilt.
  else if (isDfont(bytes)) bytes = extractDfontFace(bytes, faceIndex);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/dfont-embed.test.ts test/dfont.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the dispatch and its position**

1. Delete the `else if (isDfont(bytes))` branch. Run `npx vitest run test/dfont-embed.test.ts`. Expected: RED on every case. **Restore it.**
2. Move the `isDfont` branch to the FRONT of the chain, ahead of the `wOFF` test. Run `npx vitest run test/dfont-embed.test.ts test/woff.test.ts test/ttc.test.ts test/type1-embed.test.ts`. Expected: **still green** — which is the point, and why it is recorded rather than assumed. Ordering here is a COST rule, not a correctness one: nothing tests wrong, every other format merely pays for a structural walk it can never match. **Restore it**, and note in the commit that the suite cannot fence this.

- [ ] **Step 6: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/sfnt.ts test/dfont-embed.test.ts
git commit -F - <<'EOF'
feat(l1my.6): AddFont accepts a .dfont suitcase

parseSfnt extracts the named face, so the whole authoring stack --
subsetting, /FontFile2, Identity-H, /ToUnicode, fontmatch.ts -- sees an
ordinary sfnt and needed no change. Same placement as woff.ts
reconstructing a WOFF and ttc.ts extracting a collection face: convert
before anything else sees it. faceIndex addresses sfnt resources exactly
as it addresses collection faces, so naming a face that is not there
throws while naming one of a bare sfnt is still ignored.

The branch goes LAST, after the three u32 signature compares, because a
.dfont has no signature and its test is a structural walk. Recorded as
measured-and-unfenced: moving it to the front leaves the suite GREEN,
since nothing decodes wrong -- every other format simply pays for a walk
it can never match. Do not read the green suite as covering the ordering.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Index a `.dfont` by family name

**Files:**
- Modify: `src/fontsource.ts` (`FONT_EXT` at line 53, `faceAt` at lines 124-140, and a `.dfont` branch after the `ttcf` branch at lines 142-153)
- Test: `test/font-byname.test.ts` (append)

**Interfaces:**
- Consumes: `dfontSfntRanges`, `ByteReader` from Task 1. `FontNames` from `src/fontnames.js`.
- Produces: no new exports — `indexFolder` simply returns faces for `.dfont` files too.

- [ ] **Step 1: Write the failing test**

Append to `test/font-byname.test.ts`:

```ts
describe('Document.LoadFontByName — .dfont', () => {
  const LIBERATION = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));

  it('finds a .dfont by family name and embeds it', () => {
    const dir = folderWith({ 'Suitcase.dfont': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Liberation Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.numGlyphs).toBe(parseSfnt(LIBERATION).numGlyphs);
  });

  it('resolves each face of a multi-face suitcase separately', () => {
    // The common Mac shape: regular, bold and italic in ONE file. This is what
    // faceIndex addressing buys, and a single-face suitcase cannot show it.
    const dir = folderWith({
      'Fam.dfont': buildDfont({
        faces: [
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Regular' }),
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Bold', bold: true, weight: 700 }),
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Italic', italic: true }),
        ],
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.ResolveFontByName('Suit Sans', { weight: 700 })!.weight).toBe(700);
    expect(doc.ResolveFontByName('Suit Sans', { weight: 700 })!.faceIndex).toBe(1);
    expect(doc.ResolveFontByName('Suit Sans', { italic: true })!.faceIndex).toBe(2);
    expect(doc.ResolveFontByName('Suit Sans')!.faceIndex).toBe(0);
  });

  it('is found by DEFAULT, needing no sniff', () => {
    const dir = folderWith({ 'Plain.dfont': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);                  // no { sniff: true }
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });

  it('is found by STRUCTURE when the file has no extension at all', () => {
    // The payoff of structural detection: l1my.4's extensionless case reaches
    // one format further. An extension-only test would miss this entirely.
    const dir = folderWith({ 'Suitcase': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });

  it('skips a .dfont that will not parse, and still finds a real one', () => {
    // One corrupt suitcase in a system directory must not break every lookup.
    const dir = folderWith({
      'broken.dfont': Uint8Array.from([0, 0, 1, 0, 0, 0, 9, 9, 0, 0, 0, 4, 0, 0, 0, 4]),
      'good.dfont': buildDfont({ faces: [LIBERATION] }),
    });
    const doc = Document.New();
    expect(() => doc.RegisterFontFolder(dir)).not.toThrow();
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });
});
```

Add to the file's imports at the top: `parseSfnt` from `../src/sfnt.js`, and `buildDfont` from `./helpers/build-dfont.js`. `readFileSync` and `buildNamedFont` are already imported (the former by `l1my.5`'s Type 1 block).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-byname.test.ts`
Expected: FAIL — the `.dfont` cases return `undefined`, because `.dfont` is not in `FONT_EXT` and `peekNames` does not branch.

- [ ] **Step 3: Extend `FONT_EXT`**

In `src/fontsource.ts`, replace the `FONT_EXT` declaration:

```ts
/** Extensions worth opening. A cheap filter, not a trusted claim -- the magic
 *  is checked afterwards. `.pfb`/`.pfa` are Type 1 and `.dfont` is a Macintosh
 *  resource-fork suitcase; both are different containers entirely, and
 *  `peekNames` branches on what it finds. */
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc', '.pfb', '.pfa', '.dfont']);
```

- [ ] **Step 4: Give `faceAt` a base offset**

A `.dfont`'s table offsets are relative to its resource, while a bare sfnt's and a `.ttc`'s are absolute into the file. In `src/fontsource.ts`, change the `faceAt` signature and its one table read:

```ts
    /**
     * The naming fields of the face whose directory begins at `dirOffset`.
     *
     * `base` is added to each table offset. It is 0 for a bare sfnt and for a
     * collection, whose table offsets are absolute into the FILE — and it is
     * the resource's own start for a `.dfont`, whose are relative to it.
     */
    const faceAt = (dirOffset: number, base = 0): FontNames | undefined => {
```

and inside the `table` helper, replace the read:

```ts
        const b = readAt(fd!, base + r.offset, r.length);
```

Leave the two existing call sites alone — they take the default `0`.

- [ ] **Step 5: Add the `.dfont` branch to `peekNames`**

Add `fstatSync` to the `node:fs` import:

```ts
import { openSync, readSync, closeSync, readdirSync, fstatSync } from 'node:fs';
```

and the walk import beside the others:

```ts
import { dfontSfntRanges } from './dfont.js';
```

Then, in `peekNames`, insert immediately **after** the `ttcf` block (which ends `return out; }`) and **before** the final `const names = faceAt(0);`:

```ts
    // A .dfont carries no signature, so the walk that finds its faces IS the
    // test that this is one -- it therefore runs after the ttcf test, which is
    // a u32 compare. The cost model survives one more format: the 16-byte
    // header, then the map, then only each face's name/head/OS2 ranges.
    const dfont = dfontSfntRanges((o, l) => readAt(fd!, o, l), fstatSync(fd).size);
    if (dfont) {
      const out: { faceIndex: number; names: FontNames }[] = [];
      for (let i = 0; i < dfont.length; i++) {
        // A resource's table offsets are relative to the resource, not the file.
        const names = faceAt(dfont[i].offset, dfont[i].offset);
        if (names) out.push({ faceIndex: i, names });
      }
      return out;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/font-byname.test.ts`
Expected: PASS — the five new cases and every pre-existing one.

- [ ] **Step 7: Mutation-check the two things this task adds**

1. **The base offset.** Change `faceAt(dfont[i].offset, dfont[i].offset)` to `faceAt(dfont[i].offset)`. Run `npx vitest run test/font-byname.test.ts`. Expected: RED on the `.dfont` cases — the table reads land at file offsets that belong to some other part of the suitcase. Confirm the pre-existing sfnt and `.ttc` cases stay GREEN, which is what shows the default did not move them. **Restore it.**
2. **Default discoverability.** Remove `'.dfont'` from `FONT_EXT`. Run again. Expected: RED on "finds a .dfont by family name" and "is found by DEFAULT" — and **green** on "is found by STRUCTURE when the file has no extension at all", since that path never consults the extension. That asymmetry is the whole argument for structural detection and is worth seeing. **Restore it.**

- [ ] **Step 8: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/fontsource.ts test/font-byname.test.ts
git commit -F - <<'EOF'
feat(l1my.6): index a .dfont by family name

.dfont joins FONT_EXT so a suitcase is found by default, and peekNames
branches on the structural walk after the ttcf u32 compare. The cost
model survives one more format: the 16-byte header, then the map, then
only each face's name/head/OS2 ranges -- no glyph data is touched.

faceAt gained a `base` parameter, because a .dfont's table offsets are
relative to its resource while a bare sfnt's and a collection's are
absolute into the file. Both existing callers take the default 0, so
their behaviour is unmoved; measured, dropping the argument reddens the
.dfont cases alone and leaves the sfnt and .ttc ones green.

faceIndex addresses sfnt resources in reference-list order, which is what
gives multi-face suitcases -- the common Mac shape, with regular, bold
and italic in one file -- to LoadFontByName and fontmatch.ts for free.

Measured, and the asymmetry is the argument for structural detection:
removing .dfont from FONT_EXT reddens the by-name and by-default cases
but leaves the EXTENSIONLESS case green, because that path never consults
the extension at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Documentation

**Files:**
- Modify: `CHANGELOG.md` (an entry under the existing `### Added` in `## [Unreleased]`)
- Modify: `README.md` (the accepted-formats sentence in the font section, beside the Type 1 clause `l1my.5` added)
- Modify: `CLAUDE.md` (a bullet for `dfont.ts`, after the `type1header.ts`/`type1cff.ts` bullet)
- Modify: `test/fixtures/fonts/PROVENANCE.md` (the fixture gap)

**Interfaces:** consumes everything from Tasks 1-3; produces no code.

- [ ] **Step 1: Add the CHANGELOG entry**

Insert as the FIRST bullet under the existing `### Added` heading in `## [Unreleased]`:

```markdown
- **A macOS `.dfont` suitcase can be embedded, and found by family name** — a `.dfont` holds ordinary sfnt faces inside a Macintosh resource-fork structure, so `parseSfnt` rejected one outright and `RegisterFontFolder` found nothing in a folder of them. Both work now, and a multi-face suitcase — the common Mac shape, with regular, bold and italic in one file — resolves each face separately through the same `{ weight, italic }` matching a folder of separate files gets. Two things made this smaller than it looked. A `.dfont` is a *data-fork* font: it keeps resource-fork-*format* bytes in the ordinary data fork, which is the whole reason the format exists, so there is no macOS-specific path handling anywhere. And a face needs no reassembly — each `sfnt` resource is a complete, self-consistent font whose table offsets are relative to its own start, so extraction is a view onto the bytes rather than a rebuild of the kind a `.ttc` needs. Detection is **structural**, because unlike every other container here a `.dfont` carries no signature at all: it opens with a raw offset, so the walk that finds the faces is the test that the file is one. That is what lets a classic suitcase which has lost its extension still be found, the same miss `l1my.4` closed for bare sfnt files. (`l1my.6`)
```

- [ ] **Step 2: Update the README**

In the font section, the accepted-formats sentence currently ends with the Type 1 clause added by `l1my.5` ("...A `.pfb` in a registered folder is also findable by family name, with its `/Weight` and `/ItalicAngle` driving style matching."). Append after it:

```markdown
Macintosh **`.dfont`** suitcases are accepted too. A suitcase holding several
faces — the usual Mac packaging for a family — exposes each of them, so
`LoadFontByName('Skia', { weight: 700 })` reaches the bold face inside one file.
Unlike every other format here a `.dfont` carries no signature bytes, so it is
recognised by its structure; a classic suitcase stored without its extension is
therefore still found.
```

- [ ] **Step 3: Update CLAUDE.md**

Append immediately after the `type1header.ts`, `type1cff.ts` bullet (which ends with the `psName`/subset-tag note):

```markdown
- **dfont.ts** — Macintosh `.dfont` suitcases, added in `l1my.6`. Note what the
  name does NOT mean: a `.dfont` is a *data-fork* font, holding
  resource-fork-FORMAT bytes in the ordinary data fork, which is the entire
  reason the format exists. There is no `..namedfork/rsrc` handling and no
  platform branch anywhere.
  **Invariant:** a face is a `subarray`, never a rebuild. Each `sfnt` resource
  is a complete, self-consistent sfnt whose table offsets are relative to its
  OWN start — unlike a `.ttc`, whose are absolute into the file, which is why
  `ttc.ts` must `assembleSfnt` and this must not. `SfntFont` threads
  `byteOffset` through every `DataView` (`sfnt.ts:21`), which is what makes the
  view safe; this module imports `errors.js` and nothing else, `sfntwrite.ts`
  included.
  **Invariant:** detection is STRUCTURAL, because a `.dfont` has no signature —
  it opens with a raw `u32` data offset. The walk that finds the faces IS the
  test that the file is one, so `dfontSfntRanges` returns `undefined` exactly as
  `ttcFaceOffsets` does. The map's 16-byte copy of the header is deliberately
  NOT checked: Inside Macintosh reserves those bytes but nothing enforces them,
  and a tool that zeroes the field would cost us a font for no benefit.
  **Invariant:** the branch goes LAST in `parseSfnt`'s dispatch, after the three
  `u32` signature compares. **Note, measured and NOT fenced:** moving it to the
  front leaves the whole suite green — nothing decodes wrong, every other format
  merely pays for a structural walk it can never match. This is a cost rule, so
  do not read the green suite as covering it.
  **Invariant:** the walk takes a reader CALLBACK rather than bytes. `parseSfnt`
  holds the whole buffer while `fontsource.ts` holds a file descriptor and must
  not read one, and a bytes-only signature forces `fontsource.ts` to keep its own
  map parse — which is how an index and a loader come to disagree about how many
  faces a file holds. Same seam `grayimage.ts` takes `resolve`/`inflate`
  through.
  **Four details that are silent when wrong, all mutation-checked:** both the
  type count and each type's resource count are stored **minus one**, so reading
  either raw makes every single-face suitcase yield nothing at all; the
  reference-list offset is based on the **type list**, not the map, and the two
  differ by the 28-byte prologue, so confusing them reads a plausible wrong
  list; a resource's `u24` addresses a **length**, so the sfnt begins four bytes
  later; and non-`sfnt` types share the map — a real suitcase carries `FOND`,
  often `NFNT` or `POST` — so faces are selected **by tag**, never by position,
  or a `FOND` record comes back as though it were a font.
  **Invariant:** `faceAt` in `fontsource.ts` takes a `base` added to each table
  offset, 0 for a bare sfnt and a collection and the resource start for a
  `.dfont`. Measured: dropping it reddens the `.dfont` cases alone.
  **Note on the `FontNames` mapping:** there is none. A `.dfont`'s payload is an
  ordinary sfnt, so the existing `name`/`head`/`OS/2` reader answers, and
  resource IDs and resource names are ignored entirely — unlike `l1my.5`'s Type 1
  header, which had to be mapped by hand.
  **Note, and do NOT read the green suite as covering it:** there is no real
  `.dfont` in `test/fixtures/`. `test/helpers/build-dfont.ts` and this module
  share one reading of Inside Macintosh, so the suite proves they agree, not that
  either matches what Apple writes — the shared-convention class this repo keeps
  real-world fixtures for, uncovered here. `test/fixtures/fonts/PROVENANCE.md`
  records it.
  **Note:** a `.dfont` whose `sfnt` resource is itself a `ttcf` is out of scope.
  `faceIndex` is consumed by the container layer before such a payload reaches
  the collection test, so it would need two-level addressing nobody has asked
  for. `.suit` is out of scope too: its resources live in a TRUE resource fork,
  so on any non-Mac filesystem its data fork is empty or arbitrary.
```

- [ ] **Step 4: Record the fixture gap**

Append to `test/fixtures/fonts/PROVENANCE.md`:

```markdown
---

## What is NOT here: a real `.dfont`

`l1my.6` added `src/dfont.ts`, a reader for Macintosh `.dfont` suitcases, and
**no real one is vendored**. Its tests build suitcases with
`test/helpers/build-dfont.ts`, which transcribes the same section of Inside
Macintosh the reader does.

So this is precisely the shared-convention class the fixtures above exist to
guard against, left uncovered: the builder and the reader can agree with each
other and both disagree with what Apple writes. The suite demonstrates that the
two halves of our own understanding are consistent; it is not evidence that the
understanding is right.

The mutation checks recorded in `l1my.6`'s commits are worth more here than the
green suite is — they show each rule is load-bearing, not that it is correct.

Vendoring `Monaco.dfont`, `Geneva.dfont` or `Courier.dfont` from a macOS
`/System/Library/Fonts` and asserting the face count and family names against
them would close this. It needs a macOS machine, which is the only reason it was
not done.
```

- [ ] **Step 5: Verify the suite and the build**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. A docs-only task must not move a test.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md CLAUDE.md test/fixtures/fonts/PROVENANCE.md
git commit -F - <<'EOF'
docs(l1my.6): .dfont support in CHANGELOG, README, CLAUDE.md, PROVENANCE

States in all four that a .dfont is a DATA-fork font, since the name is a
false friend and it is the fact that makes the feature small.

CLAUDE.md records the subarray-not-rebuild rule and why it differs from
ttc.ts, the structural detection and the header copy we deliberately do
not check, the reader-callback seam and the disagreement it prevents, the
four silent-when-wrong format details, and two things the suite cannot
fence: the dispatch ORDER, which is a cost rule that leaves everything
green when broken, and the absence of any real .dfont fixture.

PROVENANCE.md states the fixture gap plainly rather than leaving it to be
discovered: our builder and our reader share one reading of Inside
Macintosh, so the suite proves they agree, not that either is right.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Close out

- [ ] **Step 1: Verify**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 2: File the follow-up.** One issue, and only one: vendor a real `.dfont` and cross-check face count and family names against it, citing `test/fixtures/fonts/PROVENANCE.md`. Do **not** file issues for `.suit`, for nested `ttcf` payloads, or for `NFNT`/`POST` resources — all three were settled against in the spec's *Out of scope*, not deferred.

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-l1my.6 --reason "<what shipped, the invariants, what was measured, what is unfenced>"
bd show aspose-pdf-foss-for-ts-l1my
```

- [ ] **Step 4: Decide the epic.** `l1my.6` is its last open child. Ask whether to close `aspose-pdf-foss-for-ts-l1my` — do not close it unilaterally; the user deferred that call once already.

- [ ] **Step 5: Push — work is NOT complete until this succeeds**

```bash
git pull --rebase
git push
git status          # MUST show "up to date with origin"
```

Note `_my/20260825/20260825.2.` is untracked and its trailing dot makes `git add` fail on Windows. Leave it; do not rename a user file to make a commit tidy.

---

## Self-review notes

**Spec coverage.** Every section maps to a task: the module layout and the reader callback to Task 1; the four silent format details to Task 1's mutations; the eager `parseSfnt` placement and dispatch order to Task 2; the index half, `FONT_EXT` and the `faceAt` base to Task 3; documentation and the fixture gap to Task 4. The spec's degradation section is covered by Task 1's throw cases and Task 3's corrupt-suitcase case. The four out-of-scope items produce no task by design, and Task 5 Step 2 says so explicitly so an executor does not file them.

**Two places the plan is honest about a limit, rather than claiming coverage.** Task 2's ordering mutation is expected to stay GREEN — it is recorded because a future reader would otherwise assume the position is fenced. And the whole feature has no real-world fixture, which Task 4 Step 4 writes into `PROVENANCE.md` rather than leaving implicit.

**Type consistency.** `dfontSfntRanges(read, fileLength)` takes the reader first in its definition and at both call sites (Task 1's `slicer`, Task 3's `readAt` closure). `{ offset, length }` is the element shape throughout, with `offset` always meaning the sfnt's first byte — *after* the four-byte resource length — in Tasks 1, 2 and 3 alike. `faceAt(dirOffset, base = 0)` is used with one argument at the two pre-existing call sites and two at the new one. `DfontSpec.faces` is `Uint8Array[]` in the builder and every test.

**A risk worth naming for the executor.** Task 1's payload-equality assertions are the ones most likely to fail first, and their failure is diagnostic: a mismatch means the four-byte length skip or the reference-list base, in that order of likelihood. Do not relax them to a length check — comparing the extracted bytes against the exact payload that went in is the only assertion in this feature that pins both details at once.
