# CFF/Type2 Charstring Subsetting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subset embedded OpenType-CFF fonts to their used glyphs — renumbering and pruning the CharStrings INDEX and charset, and dropping subrs by inlining them into charstrings — instead of whole-embedding the whole font program.

**Architecture:** A new `src/cffsubset.ts` module parses a CFF program into a writer-friendly model, flattens each used glyph's charstring by expanding `callsubr`/`callgsubr` inline (a shared stem counter descends through subr calls so `hintmask` bytes are read correctly), and emits a compact **CID-keyed** CFF (`CIDFontType0C`) with empty subr INDEXes and a charset mapping `subsetGID → originalGID`. `src/fontembed.ts` calls it for CFF fonts and falls back to today's whole-embed on any CFF the subsetter can't faithfully flatten.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, `node:zlib`. Zero new runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension (e.g. `import { CffFont } from './cff.js'`).
- **Strict TypeScript** — `npm run typecheck` (`tsc --noEmit`) must stay green. No unused imports/locals.
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit. PDF fixtures are built programmatically in `test/helpers/`.
- **Public error types only** — throw `PdfParseError` or `UnsupportedFeatureError` from `src/errors.js`. Never invent new error classes.
- **Draw-time contract is fixed** — content streams already emit 2-byte Identity-H codes equal to the *original* GID. The emitted CFF must resolve `code(=origGID as CID) → correct outline` via its own charset. Do not change `EmbeddedFont.encode` or content-stream emission.
- **Run before closing:** `npm run typecheck` and `npm test` both green.

---

## File structure

- **Create `src/cffsubset.ts`** — the whole subsetter: CFF model parser, charstring flattener (inline subr expansion), INDEX/DICT writers, CID-CFF assembler, and the `subsetCff` entry point. One module, one responsibility (CFF read→subset→write).
- **Modify `src/cff.ts`** — export the existing internal INDEX/DICT primitives (`readIndex`, `parseDict`, `op1`, `bias`, `IndexResult`) so the subsetter reuses them (DRY) rather than duplicating the parser.
- **Modify `src/fontembed.ts`** — replace the CFF branch of `buildEmbeddedFont` to call `subsetCff`, emitting `FontFile3 /Subtype /CIDFontType0C`, with a `try/catch` fallback to whole-embed.
- **Modify `test/helpers/build-cff.ts`** — add `buildRichCff()`, a 6-glyph non-CID CFF with decoy + live global and local subrs, exercising inlining, pruning, and non-CID→CID conversion.
- **Create `test/cffsubset.test.ts`** — unit tests for the primitives/flattener and end-to-end subset round-trips.
- **Modify `test/fontembed.test.ts`** — assert the new CFF embedding shape and the fallback path.
- **Modify `README.md`** — note CFF fonts are now subset.

---

### Task 1: Export CFF primitives and add the program model parser

**Files:**
- Modify: `src/cff.ts` (add `export` to `readIndex`, `parseDict`, `op1`, `bias`, `IndexResult`)
- Create: `src/cffsubset.ts` (model types + `parseCffProgram`)
- Test: `test/cffsubset.test.ts`

**Interfaces:**
- Consumes: `readIndex`, `parseDict`, `op1` from `./cff.js`.
- Produces:
  ```ts
  export interface CffProgram {
    nameIndex: Uint8Array[];
    globalSubrs: Uint8Array[];
    charStrings: Uint8Array[];   // one entry per gid
    numGlyphs: number;
    isCID: boolean;
    fdOf: (gid: number) => number;
    localSubrsOf: (fd: number) => Uint8Array[];
    fdCount: number;
  }
  export function parseCffProgram(cff: Uint8Array): CffProgram;
  ```

- [ ] **Step 1: Export the primitives from `src/cff.ts`**

Add the `export` keyword to the five existing declarations (do not change their bodies):

```ts
// ~line 121
export interface IndexResult { items: Uint8Array[]; end: number; }
// ~line 123
export function readIndex(bytes: Uint8Array, v: DataView, at: number): IndexResult {
// ~line 141
export function parseDict(data: Uint8Array): Map<number, number[]> {
// ~line 179
export function op1(dict: Map<number, number[]>, key: number): number | undefined {
// ~line 184
export const bias = (n: number): number => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
```

- [ ] **Step 2: Write the failing test for `parseCffProgram`**

Create `test/cffsubset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCffProgram } from '../src/cffsubset.js';
import { buildMinimalCff, buildCidCff } from './helpers/build-cff.js';

describe('parseCffProgram', () => {
  it('parses a non-CID program: glyphs, no CID, single FD', () => {
    const p = parseCffProgram(buildMinimalCff());
    expect(p.numGlyphs).toBe(2);
    expect(p.isCID).toBe(false);
    expect(p.charStrings.length).toBe(2);
    expect(p.fdCount).toBe(1);
    expect(p.fdOf(1)).toBe(0);
    expect(p.localSubrsOf(0)).toEqual([]);
  });

  it('parses a CID-keyed program with FDArray/FDSelect', () => {
    const p = parseCffProgram(buildCidCff());
    expect(p.isCID).toBe(true);
    expect(p.numGlyphs).toBe(2);
    expect(p.fdCount).toBeGreaterThanOrEqual(1);
    expect(p.fdOf(1)).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: FAIL — module/`parseCffProgram` missing.

- [ ] **Step 4: Implement `parseCffProgram` in `src/cffsubset.ts`**

```ts
import { readIndex, parseDict, op1 } from './cff.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

interface FdData { localSubrs: Uint8Array[]; }

export interface CffProgram {
  nameIndex: Uint8Array[];
  globalSubrs: Uint8Array[];
  charStrings: Uint8Array[];
  numGlyphs: number;
  isCID: boolean;
  fdOf: (gid: number) => number;
  localSubrsOf: (fd: number) => Uint8Array[];
  fdCount: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read a Private DICT [size, offset]'s local subr INDEX (or [] if none). */
function loadLocalSubrs(bytes: Uint8Array, v: DataView, priv: number[] | undefined): Uint8Array[] {
  if (priv && priv.length >= 2) {
    const size = priv[0], off = priv[1];
    if (size > 0 && off + size <= bytes.length) {
      const subrsOff = op1(parseDict(bytes.subarray(off, off + size)), 19);
      if (subrsOff !== undefined) return readIndex(bytes, v, off + subrsOff).items;
    }
  }
  return [];
}

function parseFdSelect(bytes: Uint8Array, v: DataView, off: number, numGlyphs: number): (gid: number) => number {
  const format = v.getUint8(off);
  if (format === 0) {
    const fds = bytes.subarray(off + 1, off + 1 + numGlyphs);
    return (gid) => fds[gid] ?? 0;
  }
  if (format === 3) {
    const nRanges = v.getUint16(off + 1);
    const ranges: { first: number; fd: number }[] = [];
    let p = off + 3;
    for (let i = 0; i < nRanges; i++) { ranges.push({ first: v.getUint16(p), fd: v.getUint8(p + 2) }); p += 3; }
    const sentinel = v.getUint16(p);
    return (gid) => {
      for (let i = 0; i < ranges.length; i++) {
        const next = i + 1 < ranges.length ? ranges[i + 1].first : sentinel;
        if (gid >= ranges[i].first && gid < next) return ranges[i].fd;
      }
      return 0;
    };
  }
  throw new UnsupportedFeatureError(`CFF FDSelect format ${format} unsupported`);
}

export function parseCffProgram(cff: Uint8Array): CffProgram {
  const v = view(cff);
  const hdrSize = v.getUint8(2);
  let p = hdrSize;
  const nameIdx = readIndex(cff, v, p); p = nameIdx.end;
  const topIdx = readIndex(cff, v, p); p = topIdx.end;
  const stringIdx = readIndex(cff, v, p); p = stringIdx.end;   // unused, but advances p
  const gsubrIdx = readIndex(cff, v, p);

  if (topIdx.items.length === 0) throw new PdfParseError('CFF: empty Top DICT INDEX');
  const top = parseDict(topIdx.items[0]);

  const csOff = op1(top, 17);
  if (csOff === undefined) throw new PdfParseError('CFF: Top DICT has no CharStrings offset');
  const charStrings = readIndex(cff, v, csOff).items;
  const numGlyphs = charStrings.length;
  const isCID = top.has(0xc1e);   // 12 30 ROS

  let fds: FdData[]; let fdOf: (gid: number) => number;
  if (isCID) {
    const fdArrayOff = op1(top, 0xc24);   // 12 36 FDArray
    const fdSelectOff = op1(top, 0xc25);  // 12 37 FDSelect
    const fdArray = fdArrayOff !== undefined ? readIndex(cff, v, fdArrayOff).items : [];
    fds = fdArray.map((d) => ({ localSubrs: loadLocalSubrs(cff, v, parseDict(d).get(18)) }));
    if (fds.length === 0) fds = [{ localSubrs: [] }];
    fdOf = fdSelectOff !== undefined ? parseFdSelect(cff, v, fdSelectOff, numGlyphs) : () => 0;
  } else {
    fds = [{ localSubrs: loadLocalSubrs(cff, v, top.get(18)) }];
    fdOf = () => 0;
  }

  return {
    nameIndex: nameIdx.items, globalSubrs: gsubrIdx.items,
    charStrings, numGlyphs, isCID, fdOf,
    localSubrsOf: (fd) => fds[fd]?.localSubrs ?? [],
    fdCount: fds.length,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cffsubset.test.ts test/cff.test.ts`
Expected: PASS (cff.test.ts still green after the exports).

- [ ] **Step 6: Commit**

```bash
git add src/cff.ts src/cffsubset.ts test/cffsubset.test.ts
git commit -m "feat(y18): CFF program model parser; export CFF primitives"
```

---

### Task 2: The `buildRichCff` fixture and the charstring flattener

**Files:**
- Modify: `test/helpers/build-cff.ts`
- Modify: `src/cffsubset.ts`
- Test: `test/cffsubset.test.ts`

**Interfaces:**
- Produces (fixture): `export function buildRichCff(): Uint8Array;` — a non-CID CFF, 6 glyphs, global subrs `[decoy, box]`, local subrs `[decoy, box2]` (see fixture code below for exact glyphs/subrs).
- Produces (subsetter):
  ```ts
  export interface FlattenCtx { localSubrs: Uint8Array[]; localBias: number; globalSubrs: Uint8Array[]; globalBias: number; }
  export function flattenGlyph(code: Uint8Array, ctx: FlattenCtx): Uint8Array;
  ```
  Returns a self-contained charstring (no `callsubr`/`callgsubr`) equivalent to `code` with all subrs expanded inline, terminated by `endchar`.

- [ ] **Step 1: Add the `buildRichCff` fixture**

Append to `test/helpers/build-cff.ts` (reuses the file's existing `u16`, `concat`, `index`, `dictInt5` helpers):

```ts
/** A non-CID CFF with decoy + live global and local subrs, 6 glyphs, for
 *  exercising subset inlining, pruning, and non-CID -> CID conversion.
 *  gid1 draws the box via global subr #1; gid2 via local subr #1. */
export function buildRichCff(): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);
  const nameIndex = index([new TextEncoder().encode('RICH')]);
  const stringIndex = index([]);

  const decoy = Uint8Array.from([139, 139, 21, 11]);                          // 0 0 rmoveto return
  const boxG = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 11]);
  const gsubrIndex = index([decoy, boxG]);                                    // global subrs [0]=decoy [1]=box

  const glyphs: Uint8Array[] = [
    Uint8Array.from([14]),                                                    // 0 .notdef
    Uint8Array.from([33, 29, 14]),                                            // 1 callgsubr #1 (33 -> -106; +bias107 = idx1)
    Uint8Array.from([33, 10, 14]),                                            // 2 callsubr  #1
    Uint8Array.from([239, 139, 21, 189, 139, 5, 14]),                        // 3 inline: 100 0 rmoveto 50 0 rlineto
    Uint8Array.from([239, 139, 21, 239, 139, 5, 14]),                        // 4 inline: 100 0 rmoveto 100 0 rlineto
    Uint8Array.from([139, 139, 21, 14]),                                     // 5 inline: 0 0 rmoveto
  ];
  const charStrings = index(glyphs);

  const boxL = Uint8Array.from([239, 139, 21, 139, 189, 5, 11]);             // 100 0 rmoveto 0 50 rlineto return
  const localSubrs = index([decoy, boxL]);                                    // local subrs [0]=decoy [1]=box2

  const privLen = 5 + 1;                                                      // dictInt5(subrsOff) + op(19)
  const privateDict = concat([dictInt5(privLen), [19]]);                      // Subrs at offset = privLen

  const topBodyLen = (5 + 5 + 1) + (5 + 1);                                   // Private[size off](18) + CharStrings(17) = 17
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const prefixLen = header.length + nameIndex.length + topIndexLen + stringIndex.length + gsubrIndex.length;

  const csOff = prefixLen;
  const privOff = csOff + charStrings.length;

  const topDict = concat([
    dictInt5(privLen), dictInt5(privOff), [18],
    dictInt5(csOff), [17],
  ]);
  const topIndex = index([topDict]);
  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex, charStrings, privateDict, localSubrs]);
}
```

- [ ] **Step 2: Write the failing tests for the fixture and `flattenGlyph`**

Append to `test/cffsubset.test.ts`:

```ts
import { flattenGlyph } from '../src/cffsubset.js';
import { buildRichCff } from './helpers/build-cff.js';
import { CffFont } from '../src/cff.js';
import { bias } from '../src/cff.js';

describe('buildRichCff fixture', () => {
  it('parses to 6 glyphs, 2 global subrs, 2 local subrs; gid1 renders the box', () => {
    const p = parseCffProgram(buildRichCff());
    expect(p.numGlyphs).toBe(6);
    expect(p.globalSubrs.length).toBe(2);
    expect(p.localSubrsOf(0).length).toBe(2);
    const f = new CffFont(buildRichCff());
    expect(f.glyphPath(1)).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });
});

describe('flattenGlyph', () => {
  function ctxFor() {
    const p = parseCffProgram(buildRichCff());
    return {
      p,
      ctx: {
        localSubrs: p.localSubrsOf(0), localBias: bias(p.localSubrsOf(0).length),
        globalSubrs: p.globalSubrs, globalBias: bias(p.globalSubrs.length),
      },
    };
  }

  it('inlines a global subr call, dropping the index literal and call op', () => {
    const { p, ctx } = ctxFor();
    // gid1 = [33,29,14] -> box body (boxG minus return) + endchar.
    expect([...flattenGlyph(p.charStrings[1], ctx)]).toEqual(
      [239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 14],
    );
  });

  it('inlines a local subr call', () => {
    const { p, ctx } = ctxFor();
    // gid2 = [33,10,14] -> boxL body (minus return) + endchar.
    expect([...flattenGlyph(p.charStrings[2], ctx)]).toEqual(
      [239, 139, 21, 139, 189, 5, 14],
    );
  });

  it('leaves a subr-free glyph byte-identical', () => {
    const { p, ctx } = ctxFor();
    expect([...flattenGlyph(p.charStrings[3], ctx)]).toEqual([...p.charStrings[3]]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: FAIL — `flattenGlyph` not exported.

- [ ] **Step 4: Implement the flattener in `src/cffsubset.ts`**

Add byte helpers (top of file, after imports) and the flattener:

```ts
function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Decode a Type2 integer operand at `at`, or undefined if it is not an integer
 *  (e.g. a 255 16.16 fixed real) — used to read a subr index literal. */
function decodeInt(code: Uint8Array, at: number): number | undefined {
  const b = code[at];
  if (b === 28) return ((code[at + 1] << 8) | code[at + 2]) << 16 >> 16;
  if (b >= 32 && b <= 246) return b - 139;
  if (b >= 247 && b <= 250) return (b - 247) * 256 + code[at + 1] + 108;
  if (b >= 251 && b <= 254) return -(b - 251) * 256 - code[at + 1] - 108;
  return undefined;
}

export interface FlattenCtx { localSubrs: Uint8Array[]; localBias: number; globalSubrs: Uint8Array[]; globalBias: number; }
interface FlattenState { out: Uint8Array[]; nStems: number; depth: number; }

/** Recursively emit `code` with subr calls expanded inline. `startStack` is the
 *  operand-stack depth on entry (threaded so a subr that leaves values for its
 *  caller is handled). Returns the ending stack depth and whether `endchar` was
 *  reached (which terminates the whole glyph). */
function flattenInto(code: Uint8Array, ctx: FlattenCtx, st: FlattenState, startStack: number): { stack: number; done: boolean } {
  if (st.depth > 60) throw new UnsupportedFeatureError('CFF subset: subr recursion too deep');
  let i = 0, stackLen = startStack, emitFrom = 0, lastStart = -1;
  while (i < code.length) {
    const b = code[i];
    if (b >= 32 || b === 28) {                       // operand
      lastStart = i;
      if (b === 28) i += 3;
      else if (b < 247) i += 1;
      else if (b < 251) i += 2;
      else if (b < 255) i += 2;
      else i += 5;                                   // 255: 16.16 fixed
      stackLen++;
      continue;
    }
    switch (b) {
      case 1: case 3: case 18: case 23:              // h/v stem(hm)
        st.nStems += stackLen >> 1; stackLen = 0; i++; break;
      case 19: case 20:                              // hintmask / cntrmask
        st.nStems += stackLen >> 1; stackLen = 0;
        i += 1 + ((st.nStems + 7) >> 3); break;      // mask bytes copied by later bulk flush
      case 10: case 29: {                            // callsubr / callgsubr
        const idx = decodeInt(code, lastStart);
        if (idx === undefined) throw new UnsupportedFeatureError('CFF subset: non-literal subr index');
        const subrs = b === 10 ? ctx.localSubrs : ctx.globalSubrs;
        const ti = idx + (b === 10 ? ctx.localBias : ctx.globalBias);
        if (ti < 0 || ti >= subrs.length) throw new UnsupportedFeatureError('CFF subset: subr index out of range');
        st.out.push(code.subarray(emitFrom, lastStart)); // everything up to (not incl.) the index literal
        st.depth++;
        const r = flattenInto(subrs[ti], ctx, st, Math.max(0, stackLen - 1));
        st.depth--;
        stackLen = r.stack;
        i++;                                         // skip the call op
        emitFrom = i;
        if (r.done) return { stack: stackLen, done: true };
        break;
      }
      case 11:                                       // return
        st.out.push(code.subarray(emitFrom, i));     // drop the return byte
        return { stack: stackLen, done: false };
      case 14:                                       // endchar
        if (stackLen >= 4) throw new UnsupportedFeatureError('CFF subset: seac-form endchar unsupported');
        st.out.push(code.subarray(emitFrom, i + 1)); // include endchar
        return { stack: 0, done: true };
      case 12: i += 2; stackLen = 0; break;          // escape (flex etc.)
      default: stackLen = 0; i++; break;             // moves / curves / lines
    }
  }
  st.out.push(code.subarray(emitFrom, i));
  return { stack: stackLen, done: false };
}

export function flattenGlyph(code: Uint8Array, ctx: FlattenCtx): Uint8Array {
  const st: FlattenState = { out: [], nStems: 0, depth: 0 };
  const r = flattenInto(code, ctx, st, 0);
  if (!r.done) st.out.push(Uint8Array.from([14]));   // ensure endchar terminates the glyph
  return cat(st.out);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/cffsubset.test.ts test/cff.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cffsubset.ts test/helpers/build-cff.ts test/cffsubset.test.ts
git commit -m "feat(y18): buildRichCff fixture and inline subr charstring flattener"
```

---

### Task 3: CID-keyed CFF assembler

**Files:**
- Modify: `src/cffsubset.ts`
- Test: `test/cffsubset.test.ts`

**Interfaces:**
- Consumes: `writeIndex` (defined here), `cat` (Task 2).
- Produces:
  ```ts
  export function writeIndex(items: Uint8Array[]): Uint8Array;
  export function assembleCidCff(nameIndex: Uint8Array[], charStrings: Uint8Array[], cidOfSubsetGid: number[]): Uint8Array;
  ```
  `cidOfSubsetGid[subsetGid]` is the original GID (used as the CID). Single FD, empty subrs.

- [ ] **Step 1: Write the failing test**

Append to `test/cffsubset.test.ts`:

```ts
import { assembleCidCff, writeIndex } from '../src/cffsubset.js';
import { readIndex } from '../src/cff.js';

describe('writeIndex', () => {
  it('round-trips through readIndex', () => {
    const items = [Uint8Array.from([1, 2, 3]), Uint8Array.from([]), Uint8Array.from([9])];
    const idx = writeIndex(items);
    const v = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const back = readIndex(idx, v, 0);
    expect(back.items.map((x) => [...x])).toEqual([[1, 2, 3], [], [9]]);
    expect(back.end).toBe(idx.length);
  });
  it('emits an empty INDEX as a 2-byte zero count', () => {
    expect([...writeIndex([])]).toEqual([0, 0]);
  });
});

describe('assembleCidCff', () => {
  it('assembles a CID-keyed CFF that CffFont parses and renders', () => {
    const box = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 14]);
    const bytes = assembleCidCff([new TextEncoder().encode('SUB')], [Uint8Array.from([14]), box], [0, 7]);
    const f = new CffFont(bytes);
    expect(f.isCID).toBe(true);
    expect(f.numGlyphs).toBe(2);
    expect(f.cidToGid(7)).toBe(1);        // charset maps CID 7 -> subset gid 1
    expect(f.glyphPath(1)).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: FAIL — `assembleCidCff`/`writeIndex` not exported.

- [ ] **Step 3: Implement `writeIndex` + `assembleCidCff`**

```ts
function u16b(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }

/** Serialize items as a CFF INDEX (auto offSize). */
export function writeIndex(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return u16b(0);
  let dataLen = 0; for (const it of items) dataLen += it.length;
  const lastOff = dataLen + 1;
  const offSize = lastOff <= 0xff ? 1 : lastOff <= 0xffff ? 2 : lastOff <= 0xffffff ? 3 : 4;
  const head: number[] = [(items.length >> 8) & 0xff, items.length & 0xff, offSize];
  const writeOff = (o: number): void => { for (let k = offSize - 1; k >= 0; k--) head.push((o >> (8 * k)) & 0xff); };
  let off = 1; writeOff(off);
  for (const it of items) { off += it.length; writeOff(off); }
  return cat([Uint8Array.from(head), ...items]);
}

/** CFF DICT integer, fixed 5-byte form (29 + int32) — keeps DICTs constant-width
 *  so the program lays out in a single pass. */
function dictInt5(n: number): Uint8Array {
  const b = new Uint8Array(5); b[0] = 29; new DataView(b.buffer).setUint32(1, n >>> 0); return b;
}

/** Assemble a bare CID-keyed CFF (CIDFontType0C): single FD, empty subrs, charset
 *  mapping subset gid -> original gid (CID). */
export function assembleCidCff(nameIndex: Uint8Array[], charStrings: Uint8Array[], cidOfSubsetGid: number[]): Uint8Array {
  const n = charStrings.length;
  const header = Uint8Array.from([1, 0, 4, 1]);
  const name = writeIndex(nameIndex.length ? nameIndex : [new TextEncoder().encode('Subset')]);
  const strings = writeIndex([new TextEncoder().encode('Adobe'), new TextEncoder().encode('Identity')]); // SID 391, 392
  const gsubr = writeIndex([]);
  const cs = writeIndex(charStrings);

  // charset format 0: gid 1..n-1 -> u16 CID (gid0 => CID0 implicitly).
  const charsetParts: Uint8Array[] = [Uint8Array.from([0])];
  for (let g = 1; g < n; g++) charsetParts.push(u16b(cidOfSubsetGid[g]));
  const charset = cat(charsetParts);

  // FDSelect format 3: one range, all glyphs -> FD 0.
  const fdSelect = cat([Uint8Array.from([3]), u16b(1), u16b(0), Uint8Array.from([0]), u16b(n)]);

  // FDArray: one Font DICT with Private [size 0, offset 0] (no Private body).
  const fontDict = cat([dictInt5(0), dictInt5(0), Uint8Array.from([18])]);
  const fdArray = writeIndex([fontDict]);

  // Fixed-width Top DICT (ROS, CharStrings, charset, FDArray, FDSelect); FDArray
  // is emitted last, so all offsets are known once the prefix length is fixed.
  const topLen = (5 * 3 + 2) + (5 + 1) + (5 + 1) + (5 + 2) + (5 + 2);   // = 43
  const topIndexLen = 2 + 1 + 2 + topLen;                               // 1 item, offSize 1
  const prefixLen = header.length + name.length + topIndexLen + strings.length + gsubr.length;

  const csOff = prefixLen;
  const charsetOff = csOff + cs.length;
  const fdSelectOff = charsetOff + charset.length;
  const fdArrayOff = fdSelectOff + fdSelect.length;

  const topDict = cat([
    dictInt5(391), dictInt5(392), dictInt5(0), Uint8Array.from([12, 30]),  // ROS
    dictInt5(csOff), Uint8Array.from([17]),                                // CharStrings
    dictInt5(charsetOff), Uint8Array.from([15]),                           // charset
    dictInt5(fdArrayOff), Uint8Array.from([12, 36]),                       // FDArray
    dictInt5(fdSelectOff), Uint8Array.from([12, 37]),                      // FDSelect
  ]);
  if (topDict.length !== topLen) throw new PdfParseError('CFF subset: Top DICT length mismatch');
  const topIndex = writeIndex([topDict]);

  return cat([header, name, topIndex, strings, gsubr, cs, charset, fdSelect, fdArray]);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cffsubset.ts test/cffsubset.test.ts
git commit -m "feat(y18): CID-keyed CFF assembler (charset/FDSelect/FDArray writer)"
```

---

### Task 4: `subsetCff` orchestration and end-to-end round-trips

**Files:**
- Modify: `src/cffsubset.ts`
- Test: `test/cffsubset.test.ts`

**Interfaces:**
- Consumes: `parseCffProgram`, `flattenGlyph`, `assembleCidCff`, `bias`.
- Produces:
  ```ts
  export function subsetCff(cff: Uint8Array, usedGids: Iterable<number>): { bytes: Uint8Array; gidMap: Map<number, number>; };
  ```
  `gidMap` is `origGID → subsetGID`. Output is a bare CID-keyed CFF whose charset maps each `subsetGID → origGID`.

- [ ] **Step 1: Write the failing end-to-end tests**

Append to `test/cffsubset.test.ts`:

```ts
import { subsetCff } from '../src/cffsubset.js';

describe('subsetCff (end to end)', () => {
  it('preserves outlines through inlining + renumbering and maps CID->subsetGID', () => {
    const orig = new CffFont(buildRichCff());
    const { bytes, gidMap } = subsetCff(buildRichCff(), [1, 2, 4]);   // keep {0,1,2,4}
    expect([...gidMap.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [1, 1], [2, 2], [4, 3]]);
    const sub = new CffFont(bytes);
    expect(sub.isCID).toBe(true);
    expect(sub.numGlyphs).toBe(4);
    for (const [origG, subG] of gidMap) {
      expect(sub.cidToGid(origG)).toBe(subG);                   // charset: CID(=origGID) -> subsetGID
      expect(sub.glyphPath(subG)).toEqual(orig.glyphPath(origG)); // outline preserved
    }
  });

  it('drops unused glyphs and empties the subr INDEXes, shrinking the program', () => {
    const original = buildRichCff();
    const { bytes } = subsetCff(original, [3]);   // keep {0,3} — small subset, subrs unused
    const p = parseCffProgram(bytes);
    expect(p.numGlyphs).toBe(2);                  // was 6
    expect(p.globalSubrs.length).toBe(0);         // inlined away (were 2)
    expect(p.localSubrsOf(0).length).toBe(0);     // were 2
    expect(bytes.length).toBeLessThan(original.length);
  });

  it('subsets a bare non-CID CFF (buildMinimalCff) to a CID-keyed CFF', () => {
    const orig = new CffFont(buildMinimalCff());
    const { bytes, gidMap } = subsetCff(buildMinimalCff(), [1]);
    const sub = new CffFont(bytes);
    expect(sub.isCID).toBe(true);
    expect(sub.cidToGid(1)).toBe(gidMap.get(1));
    expect(sub.glyphPath(gidMap.get(1)!)).toEqual(orig.glyphPath(1));
  });

  it('always retains gid 0 (.notdef) even if unused', () => {
    const { gidMap } = subsetCff(buildRichCff(), [3]);
    expect(gidMap.get(0)).toBe(0);
    expect(gidMap.get(3)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: FAIL — `subsetCff` not exported.

- [ ] **Step 3: Implement `subsetCff`**

```ts
import { readIndex, parseDict, op1, bias } from './cff.js';   // add `bias` to the existing import
// ... existing code ...

export function subsetCff(cff: Uint8Array, usedGids: Iterable<number>): { bytes: Uint8Array; gidMap: Map<number, number> } {
  const prog = parseCffProgram(cff);

  const keep = new Set<number>([0]);
  for (const g of usedGids) if (Number.isInteger(g) && g >= 0 && g < prog.numGlyphs) keep.add(g);
  const order = [...keep].sort((a, b) => a - b);
  const gidMap = new Map<number, number>(); order.forEach((g, i) => gidMap.set(g, i));

  const globalBias = bias(prog.globalSubrs.length);
  const charStrings = order.map((g) => {
    const local = prog.localSubrsOf(prog.fdOf(g));
    const ctx: FlattenCtx = { localSubrs: local, localBias: bias(local.length), globalSubrs: prog.globalSubrs, globalBias };
    return flattenGlyph(prog.charStrings[g], ctx);
  });

  const bytes = assembleCidCff(prog.nameIndex, charStrings, order);   // cidOfSubsetGid[i] = order[i] = origGID
  return { bytes, gidMap };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/cffsubset.test.ts`
Expected: PASS — all outline-equivalence, CID-map, and size-reduction assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cffsubset.ts test/cffsubset.test.ts
git commit -m "feat(y18): subsetCff end-to-end orchestration"
```

---

### Task 5: Wire the subsetter into `buildEmbeddedFont` with fallback

**Files:**
- Modify: `src/fontembed.ts` (imports + the CFF branch ~lines 130-137, and the header comment ~lines 78-91)
- Test: `test/fontembed.test.ts`

**Interfaces:**
- Consumes: `subsetCff` from `./cffsubset.js`.
- Produces: no new exports; changes the object graph `buildEmbeddedFont` emits for CFF fonts.

- [ ] **Step 1: Write the failing tests**

Open `test/fontembed.test.ts` and read the existing CFF describe block (~line 114) for helpers in scope (`makeStore`, `nm`, `makeOttoWithCff`). Add the `CffFont` import at the top:

```ts
import { CffFont } from '../src/cff.js';
import { buildCffOtto } from './helpers/build-cff.js';
```

Then replace the existing whole-embed CFF describe block with:

```ts
describe('buildEmbeddedFont — CFF subsetting', () => {
  function build(used: number[]) {
    const font = parseSfnt(buildCffOtto());   // OTTO wrapping buildMinimalCff, cmap 'A'->gid1
    const store = makeStore();
    const type0 = buildEmbeddedFont(font, new Set(used), store.alloc);
    return { font, store, type0 };
  }
  function cidFontOf(store: ReturnType<typeof makeStore>, type0: PdfDict): PdfDict {
    return store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
  }

  it('emits CIDFontType0 + FontFile3 /Subtype /CIDFontType0C with /CIDToGIDMap /Identity', () => {
    const { store, type0 } = build([1]);
    const cid = cidFontOf(store, type0);
    expect(nm(cid.get('Subtype'))).toBe('CIDFontType0');
    expect(nm(cid.get('CIDToGIDMap'))).toBe('Identity');
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    expect(nm(ff.dict.get('Subtype'))).toBe('CIDFontType0C');
  });

  it('the embedded CFF resolves the drawn original GID to the right outline', () => {
    const { store, type0 } = build([1]);
    const cid = cidFontOf(store, type0);
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    const sub = new CffFont(store.inflate(ff));
    // Draw-time code is original GID 1 (treated as CID) -> resolves to the box.
    expect(sub.glyphPath(sub.cidToGid(1))).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });

  it('falls back to whole-embed (/Subtype /OpenType) when the CFF table is unparseable', () => {
    const font = parseSfnt(makeOttoWithCff());   // 'CFF ' table is 4 zero bytes -> subsetCff throws
    const store = makeStore();
    const type0 = buildEmbeddedFont(font, new Set([1]), store.alloc);
    const cid = cidFontOf(store, type0);
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    expect(nm(ff.dict.get('Subtype'))).toBe('OpenType');
  });
});
```

Note: `makeOttoWithCff` and `buildClosureTtf`/`makeOttoWithCff` are already imported at the top of `test/fontembed.test.ts`; keep those imports. If the file lacks `makeOttoWithCff` in scope, add it to the existing `./helpers/build-sfnt.js` import.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fontembed.test.ts`
Expected: FAIL — CFF branch still emits `/Subtype /OpenType` for the parseable `buildCffOtto`.

- [ ] **Step 3: Update `src/fontembed.ts`**

Add the import near the other imports at the top:

```ts
import { subsetCff } from './cffsubset.js';
```

Replace the CFF `else` branch (currently ~lines 130-137):

```ts
  } else {
    descendantSubtype = 'CIDFontType0';
    cidToGidMap = name('Identity');
    try {
      const { bytes, gidMap } = subsetCff(font.table('CFF ')!, usedGids);
      baseTag = subsetTag(bytes);
      descriptor.set('FontFile3', alloc(flateStream(bytes, { Subtype: name('CIDFontType0C') })));
      cids = [...gidMap.keys()].sort((a, b) => a - b);
    } catch {
      // Exotic/malformed CFF: preserve robustness by whole-embedding the OTTO
      // program, as before. Draw-time GIDs still resolve (identity).
      baseTag = subsetTag(font.raw);
      descriptor.set('FontFile3', alloc(flateStream(font.raw, { Subtype: name('OpenType') })));
      cids = [...usedGids].filter((g) => Number.isInteger(g) && g >= 0 && g < font.numGlyphs).sort((a, b) => a - b);
      if (!cids.includes(0)) cids.unshift(0);
    }
  }
```

Update the doc comment above `buildEmbeddedFont` (~lines 86-90): CFF fonts are subset and embedded as `CIDFontType0 + FontFile3 /Subtype /CIDFontType0C` (charset carries CID→GID), falling back to whole-embed `/Subtype /OpenType` on unparseable CFF.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run test/fontembed.test.ts test/cffsubset.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fontembed.ts test/fontembed.test.ts
git commit -m "feat(y18): embed CFF fonts as subset CIDFontType0C with whole-embed fallback"
```

---

### Task 6: Documentation and full-suite verification

**Files:**
- Modify: `README.md`
- Test: full suite + typecheck

- [ ] **Step 1: Update README**

Find the font-embedding section (search `AddFont` / `FontFile`). Change any statement that CFF/`.otf` fonts are whole-embedded to: CFF fonts are **subset** (used glyphs only) and embedded as `CIDFontType0` / `FontFile3` `/Subtype /CIDFontType0C`; malformed CFF falls back to whole-embedding. If a Limitations entry says CFF is not subset, remove or amend it.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — entire `test/**/*.test.ts` suite green, including `cff.test.ts`, `cffsubset.test.ts`, `fontembed.test.ts`, `stamp-fonts.test.ts`, `embedded-authoring.test.ts`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(y18): CFF fonts are now subset, not whole-embedded"
```

- [ ] **Step 5: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-y18
```

---

## Notes for the implementer

- **Why CID-keyed output?** Under a `CIDFontType0` descendant, `CIDToGIDMap` is ignored by PDF readers; the CID→GID map is the CFF's own charset. Content streams emit the *original* GID as the Identity-H code, so the subset CFF's charset must map each retained glyph's `subsetGID → originalGID` (used as CID). A reader then takes `code (origGID) → charset → subsetGID → outline`.
- **Why inline subrs?** Statically renumbering `callsubr`/`callgsubr` operands requires walking past `hintmask` bytes whose length depends on stem counts that hint-replacement fonts declare *inside* subrs — a static single-pass rewrite can silently misalign there. Inlining expands subrs into each glyph while a shared stem counter descends through the calls, so `hintmask` bytes are always copied with the right length; the output then carries empty subr INDEXes.
- **Widths/geometry are not recomputed.** Charstring bytes are copied verbatim apart from inline subr expansion. CFF advance widths are unused for `CIDFontType0` (PDF `/W`, still built from `font.advanceWidth` in fontembed.ts, governs), and the interpreter discards any leading width operand — so collapsing to a single FD with an empty Private DICT is outline-neutral.
- **Fallback is the safety net.** Any structure the flattener can't handle (non-literal subr index, out-of-range subr index, `seac`-form `endchar`, unsupported FDSelect format, malformed DICT/INDEX, runaway recursion) throws, and `buildEmbeddedFont` whole-embeds instead. Output is always valid.
- **Single-pass layout** relies on the Top DICT being fixed-width (`dictInt5`) and the FDArray being emitted last. Keep the `topDict.length !== topLen` assertion in `assembleCidCff`; if it trips, the layout math and the writer have diverged.
