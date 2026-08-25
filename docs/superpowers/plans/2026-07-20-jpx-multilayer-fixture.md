# JPX Multi-Layer Quality-Layer Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit two multi-layer JPEG 2000 fixtures and the tests that finally execute `src/jpxt2.ts`'s multi-layer packet path, which today has zero coverage.

**Architecture:** An offline, dev-only transcoder (`scripts/jpx-relayer.mjs`) parses a single-layer codestream produced by the WASM OpenJPEG encoder, redistributes each code-block's already-coded passes and bytes across N packets, and re-emits the codestream with a patched COD layer count. `scripts/gen-jpx-fixtures.mjs` calls it, validates the result through the WASM OpenJPEG **decoder** before writing anything, and bakes the bytes into `test/helpers/jpx-fixtures.ts`.

**Tech Stack:** Node ESM (`.mjs`, no build step for `scripts/`), TypeScript + vitest for tests, `@cornerstonejs/codec-openjpeg` as a temporary dev-only dependency for Task 3 only.

**Spec:** `docs/superpowers/specs/2026-07-20-jpx-multilayer-fixture-design.md`

## Global Constraints

- **Zero runtime dependencies.** Nothing in `src/` may import `scripts/`. `@cornerstonejs/codec-openjpeg` is installed and uninstalled within Task 3 and must never appear in a committed `package.json`.
- **Do not modify `src/`.** This work adds coverage for code that already exists. If a new test fails, that is a decoder bug — file a bd issue, do not "fix" the test to pass.
- **ESM + NodeNext.** Import specifiers carry an extension (`./jpx-relayer.mjs`, `../src/jpxt2.js`).
- **`test/helpers/jpx-fixtures.ts` is generated.** Never hand-edit it; it carries a `GENERATED ... do not edit by hand` banner.
- **Layer count for both new fixtures is 3** — greater than 2, so the already-included path and `lblock` accumulation fire repeatedly rather than exactly once.
- Both `npm run typecheck` and `npm test` must be green before the bd issue is closed.

---

### Task 1: Packet-header bit writer and tag-tree encoder

The two primitives the transcoder needs, each the exact inverse of a class already in `src/jpxt2.ts`. Testing them against the real decoder classes is the whole point: a round trip through `Bio`/`TagTree` is the strongest available check short of OpenJPEG itself.

**Files:**
- Create: `scripts/jpx-relayer.mjs`
- Create: `scripts/jpx-relayer.d.mts`
- Test: `test/jpx-relayer.test.ts`

**Interfaces:**
- Consumes: `Bio` and `TagTree` from `src/jpxt2.ts` (both already exported, jpxt2.ts:10 and jpxt2.ts:33).
- Produces:
  - `class BioWriter` — `putbit(b: number): void`, `write(v: number, n: number): void`, `flush(): Uint8Array`
  - `class TagTreeEnc` — `constructor(w: number, h: number)`, `setLeaf(i: number, j: number, v: number): void`, `build(): void`, `encode(bw: BioWriter, i: number, j: number, threshold: number): void`
  - `function writePassCount(bw: BioWriter, n: number): void`

- [ ] **Step 1: Write the failing test**

Create `test/jpx-relayer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Bio, TagTree } from '../src/jpxt2.js';
import { BioWriter, TagTreeEnc, writePassCount } from '../scripts/jpx-relayer.mjs';

/** Read n bits back out of a written buffer using the real decoder's Bio. */
const reader = (bytes: Uint8Array) => new Bio(bytes, 0, bytes.length);

describe('BioWriter', () => {
  it('round-trips a bit pattern through the decoder Bio', () => {
    const bits = [1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1];
    const bw = new BioWriter();
    for (const b of bits) bw.putbit(b);
    const bio = reader(bw.flush());
    expect(bits.map(() => bio.getbit())).toEqual(bits);
  });

  it('round-trips multi-bit values MSB-first', () => {
    const bw = new BioWriter();
    bw.write(0b1011, 4);
    bw.write(0b0110010, 7);
    const bio = reader(bw.flush());
    expect(bio.read(4)).toBe(0b1011);
    expect(bio.read(7)).toBe(0b0110010);
  });

  it('applies 0xFF bit-stuffing that the decoder unstuffs', () => {
    // Eight 1-bits emit an 0xFF byte; the next byte must carry only 7 bits.
    const bw = new BioWriter();
    for (let i = 0; i < 8; i++) bw.putbit(1);
    for (let i = 0; i < 7; i++) bw.putbit(1);
    const out = bw.flush();
    expect(out[0]).toBe(0xff);
    expect(out[1] & 0x80).toBe(0); // stuffed byte's top bit is not a data bit
    const bio = reader(out);
    for (let i = 0; i < 15; i++) expect(bio.getbit()).toBe(1);
  });
});

describe('writePassCount', () => {
  // Mirrors readPassCount (src/jpxt2.ts:112): 1, 2, 3-5, 6-36, 37+.
  it.each([1, 2, 3, 5, 6, 36, 37, 164])('round-trips a count of %i', (n) => {
    const bw = new BioWriter();
    writePassCount(bw, n);
    const bio = reader(bw.flush());
    const readPassCount = (): number => {
      if (bio.getbit() === 0) return 1;
      if (bio.getbit() === 0) return 2;
      const b = bio.read(2);
      if (b < 3) return 3 + b;
      const c = bio.read(5);
      if (c < 31) return 6 + c;
      return 37 + bio.read(7);
    };
    expect(readPassCount()).toBe(n);
  });
});

describe('TagTreeEnc', () => {
  it('round-trips leaf values through the decoder TagTree', () => {
    const w = 3, h = 2;
    const values = [0, 2, 1, 3, 0, 2]; // row-major
    const enc = new TagTreeEnc(w, h);
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) enc.setLeaf(i, j, values[i * w + j]);
    enc.build();

    // Encode every leaf at rising thresholds, exactly as the zero-bit-plane
    // loop in readPacket does (src/jpxt2.ts:146-148).
    const bw = new BioWriter();
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      for (let t = 1; t <= values[i * w + j] + 1; t++) enc.encode(bw, i, j, t);
    }

    const bio = reader(bw.flush());
    const dec = new TagTree(w, h);
    const got: number[] = [];
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      let t = 1, v = 0;
      for (;;) { const r = dec.decode(bio, i, j, t); if (r < t) { v = r; break; } t++; }
      got.push(v);
    }
    expect(got).toEqual(values);
  });

  it('signals non-inclusion when a leaf value exceeds the threshold', () => {
    // Inclusion coding: leaf = first layer of inclusion; nLayers means "never".
    const nLayers = 3;
    const enc = new TagTreeEnc(1, 1);
    enc.setLeaf(0, 0, nLayers);
    enc.build();
    const bw = new BioWriter();
    for (let l = 0; l < nLayers; l++) enc.encode(bw, 0, 0, l + 1);

    const bio = reader(bw.flush());
    const dec = new TagTree(1, 1);
    for (let l = 0; l < nLayers; l++) expect(dec.decode(bio, 0, 0, l + 1) <= l).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpx-relayer.test.ts`
Expected: FAIL — cannot resolve `../scripts/jpx-relayer.mjs`.

- [ ] **Step 3: Create the module with the two primitives**

Create `scripts/jpx-relayer.mjs`:

```js
// OFFLINE, dev-only. Re-layers a single-quality-layer JPEG 2000 codestream into an
// N-layer one by redistributing each code-block's already-coded passes and bytes
// across N packets. NOT a runtime dependency — nothing in src/ imports this.
//
// The layer boundaries are ARBITRARY, not rate-distortion-optimal: a transcoder
// cannot know where pass boundaries fall inside an MQ codeword segment. That is
// sound for a fully-decoded stream — total passes and total bytes are preserved,
// so decoding every layer is bit-identical to the source — but it means a
// TRUNCATED prefix of the output decodes to noise, not to a coarser image.
// Assert nothing about intermediate layers.
//
// The bit writer, tag-tree encoder and pass-count coder below are the exact
// inverses of Bio, TagTree and readPassCount in src/jpxt2.ts.

/** Packet-header bit writer — MSB-first with JPEG-2000 0xFF bit-stuffing.
 *  Inverse of Bio (src/jpxt2.ts:10). */
export class BioWriter {
  constructor() { this.bytes = []; this.buf = 0; this.ct = 8; }
  byteout() {
    this.buf = (this.buf << 8) & 0xffff;
    this.ct = this.buf === 0xff00 ? 7 : 8;
    this.bytes.push((this.buf >> 8) & 0xff);
  }
  putbit(b) {
    if (this.ct === 0) this.byteout();
    this.ct--;
    this.buf |= b << this.ct;
  }
  write(v, n) { for (let i = n - 1; i >= 0; i--) this.putbit((v >> i) & 1); }
  /** Byte-align and return the header bytes. Mirrors Bio.inalign(). */
  flush() {
    this.byteout();
    if (this.ct === 7) this.byteout(); // emit the stuffing byte after an 0xFF
    return Uint8Array.from(this.bytes);
  }
}

/** Pass-count coder — inverse of readPassCount (src/jpxt2.ts:112). */
export function writePassCount(bw, n) {
  if (n === 1) { bw.putbit(0); return; }
  bw.putbit(1);
  if (n === 2) { bw.putbit(0); return; }
  bw.putbit(1);
  if (n <= 5) { bw.write(n - 3, 2); return; }
  bw.write(3, 2);
  if (n <= 36) { bw.write(n - 6, 5); return; }
  bw.write(31, 5);
  bw.write(n - 37, 7);
}

/** Quad tag-tree encoder — inverse of TagTree (src/jpxt2.ts:33).
 *  Set every leaf, call build() to derive internal nodes, then encode() leaves
 *  at rising thresholds. Node state persists across calls, as on the decode side. */
export class TagTreeEnc {
  constructor(w, h) {
    this.levels = [];
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({
        w: lw, h: lh,
        value: new Int32Array(lw * lh),
        low: new Int32Array(lw * lh),
        known: new Uint8Array(lw * lh),
      });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  setLeaf(i, j, v) { const l0 = this.levels[0]; l0.value[i * l0.w + j] = v; }
  /** Internal node value = min over its children (the tag-tree invariant). */
  build() {
    for (let l = 1; l < this.levels.length; l++) {
      const p = this.levels[l], c = this.levels[l - 1];
      p.value.fill(0x7fffffff);
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const pi = (y >> 1) * p.w + (x >> 1);
        if (c.value[y * c.w + x] < p.value[pi]) p.value[pi] = c.value[y * c.w + x];
      }
    }
  }
  encode(bw, i, j, threshold) {
    const path = [];
    let x = j, y = i;
    for (let l = 0; l < this.levels.length; l++) { path.push({ l, x, y }); x >>= 1; y >>= 1; }
    let low = 0;
    for (let s = path.length - 1; s >= 0; s--) {
      const { l, x: nx, y: ny } = path[s];
      const lvl = this.levels[l];
      const idx = ny * lvl.w + nx;
      if (low > lvl.low[idx]) lvl.low[idx] = low; else low = lvl.low[idx];
      while (low < threshold) {
        if (low >= lvl.value[idx]) {
          if (!lvl.known[idx]) { bw.putbit(1); lvl.known[idx] = 1; }
          break;
        }
        bw.putbit(0);
        low++;
      }
      lvl.low[idx] = low;
    }
  }
}
```

- [ ] **Step 4: Add the type declaration so `tsc` accepts the import**

`tsconfig.json` has `"include": ["src", "test"]`, so `test/jpx-relayer.test.ts` is typechecked and needs declarations for the untyped `.mjs`.

Create `scripts/jpx-relayer.d.mts`:

```ts
export declare class BioWriter {
  putbit(b: number): void;
  write(v: number, n: number): void;
  flush(): Uint8Array;
}
export declare function writePassCount(bw: BioWriter, n: number): void;
export declare class TagTreeEnc {
  constructor(w: number, h: number);
  setLeaf(i: number, j: number, v: number): void;
  build(): void;
  encode(bw: BioWriter, i: number, j: number, threshold: number): void;
}
export declare function relayer(j2k: Uint8Array, nLayers: number): Uint8Array;
```

`relayer` is declared now and implemented in Task 2; nothing imports it yet, so this stays consistent.

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `npx vitest run test/jpx-relayer.test.ts`
Expected: PASS — 6 tests (3 BioWriter, 8 parameterized `writePassCount` cases, 2 TagTreeEnc).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/jpx-relayer.mjs scripts/jpx-relayer.d.mts test/jpx-relayer.test.ts
git commit -m "test(jpx): packet-header bit writer and tag-tree encoder (pol)"
```

---

### Task 2: The re-layering transcoder

Now the transcoder proper. Its test needs no WASM and no network: it re-layers a codestream already committed in `test/helpers/jpx-fixtures.ts` and decodes the result with our own `decodeJpx`.

**Files:**
- Modify: `scripts/jpx-relayer.mjs` (append; the Task 1 primitives are unchanged)
- Test: `test/jpx-relayer.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `BioWriter`, `TagTreeEnc`, `writePassCount` from Task 1.
- Produces: `function relayer(j2k: Uint8Array, nLayers: number): Uint8Array` — already declared in `scripts/jpx-relayer.d.mts` in Task 1. Throws `Error` if the source is not a bare single-layer codestream, or uses precinct partitions / SOP / EPH.

- [ ] **Step 1: Write the failing test**

Append to `test/jpx-relayer.test.ts` (and extend the existing import from `../scripts/jpx-relayer.mjs` to include `relayer`):

```ts
import { decodeJpx, parseCodestream } from '../src/jpx.js';
import * as F from './helpers/jpx-fixtures.js';

describe('relayer', () => {
  it('re-layers a single-layer codestream to 3 layers, sample-preserving', () => {
    const out = relayer(F.lossless_gray_j2k, 3);
    expect(parseCodestream(out).cod.layers).toBe(3);
    const img = decodeJpx(out);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('preserves samples for a 3-component source', () => {
    // rpcl_j2k is RPCL; the relayer must re-emit in the source's own
    // progression order, not assume LRCP.
    const out = relayer(F.rpcl_j2k, 3);
    expect(parseCodestream(out).cod.layers).toBe(3);
    expect(Array.from(decodeJpx(out).data)).toEqual(Array.from(F.rpcl_rgb.data));
  });

  it('is stable across layer counts', () => {
    for (const n of [2, 3, 5]) {
      expect(Array.from(decodeJpx(relayer(F.lossless_gray_j2k, n)).data))
        .toEqual(Array.from(F.lossless_gray_rgb.data));
    }
  });

  it('refuses a source that already has multiple layers', () => {
    expect(() => relayer(relayer(F.lossless_gray_j2k, 3), 2)).toThrow(/already has 3 layers/);
  });

  it('refuses a layer count below 2', () => {
    expect(() => relayer(F.lossless_gray_j2k, 1)).toThrow(/nLayers/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpx-relayer.test.ts`
Expected: FAIL — `relayer is not a function`.

- [ ] **Step 3: Implement the transcoder**

Append to `scripts/jpx-relayer.mjs`:

```js
// ---------- codestream parse ----------

const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

function concat(arrs) {
  let total = 0; for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** Walk the main header. Mirrors parseCodestream (src/jpx.ts:55) but keeps the
 *  marker byte offsets, which the rewrite stage needs. */
function parseHeader(buf) {
  if (!(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x4f)) throw new Error('relayer: missing SOC marker (pass a bare codestream, not a JP2 box)');
  let p = 2, codPos = -1, sotPos = -1, sodEnd = -1, psot = 0;
  let siz = null, cod = null, tileData = null;
  while (p + 2 <= buf.length) {
    const markerPos = p;
    const m = u16(buf, p); p += 2;
    if (m === 0xffd9) break; // EOC
    if (m === 0xff93) { // SOD
      sodEnd = p;
      let end = buf.length;
      if (psot > 0 && sotPos >= 0) end = Math.min(buf.length, sotPos + psot);
      else { for (let i = p; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i; break; } }
      tileData = buf.subarray(p, end);
      break;
    }
    if (p + 2 > buf.length) break;
    const len = u16(buf, p);
    const seg = buf.subarray(p + 2, p + len);
    p += len;
    if (m === 0xff51) { // SIZ
      siz = { xsiz: u32(seg, 2), ysiz: u32(seg, 6), xosiz: u32(seg, 10), yosiz: u32(seg, 14), comps: u16(seg, 34) };
    } else if (m === 0xff52) { // COD
      codPos = markerPos;
      // Scod bit 0 = custom precincts, bit 1 = SOP, bit 2 = EPH. All three would
      // change the packet layout this transcoder rewrites.
      if (seg[0] & 0x07) throw new Error('relayer: precinct partitions / SOP / EPH unsupported');
      cod = { progression: seg[1], layers: u16(seg, 2), levels: seg[5], cbW: 1 << (seg[6] + 2), cbH: 1 << (seg[7] + 2) };
    } else if (m === 0xff90) { // SOT
      sotPos = markerPos; psot = u32(seg, 2);
    }
  }
  if (!siz || !cod || !tileData) throw new Error('relayer: missing SIZ/COD/tile data');
  if (sotPos < 0 || sodEnd < 0) throw new Error('relayer: missing SOT/SOD');
  return { siz, cod, tileData, codPos, sotPos, sodEnd };
}

/** Resolution/subband/code-block geometry. Mirrors buildComponent (src/jpxt2.ts:90). */
function buildComponent(siz, cod) {
  const cw = siz.xsiz - siz.xosiz, ch = siz.ysiz - siz.yosiz;
  const N = cod.levels;
  const res = [];
  for (let r = 0; r <= N; r++) {
    const rw = Math.ceil(cw / (1 << (N - r))), rh = Math.ceil(ch / (1 << (N - r)));
    const mk = (type, x1, y1) => ({ type, x1, y1, blocks: [], cols: 1, rows: 1 });
    let subbands;
    if (r === 0) subbands = [mk('LL', rw, rh)];
    else {
      const lw = Math.ceil(rw / 2), hw = Math.floor(rw / 2);
      const lh = Math.ceil(rh / 2), hh = Math.floor(rh / 2);
      subbands = [mk('HL', hw, lh), mk('LH', lw, hh), mk('HH', hw, hh)];
    }
    for (const sb of subbands) {
      sb.cols = Math.max(1, Math.ceil(sb.x1 / cod.cbW));
      sb.rows = Math.max(1, Math.ceil(sb.y1 / cod.cbH));
      for (let by = 0; by < sb.y1; by += cod.cbH) for (let bx = 0; bx < sb.x1; bx += cod.cbW) {
        sb.blocks.push({ segment: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, lblock: 3, included: false });
      }
    }
    res.push({ subbands });
  }
  return res;
}

/** Packet iteration order. Mirrors the switch at src/jpxt2.ts:177. */
function forEachPacket(cod, nc, nr, nl, fn) {
  switch (cod.progression) {
    case 0: for (let l = 0; l < nl; l++) for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) fn(c, r, l); break; // LRCP
    case 1: for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) for (let c = 0; c < nc; c++) fn(c, r, l); break; // RLCP
    case 2: for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) for (let l = 0; l < nl; l++) fn(c, r, l); break; // RPCL
    case 3: case 4: for (let c = 0; c < nc; c++) for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) fn(c, r, l); break; // PCRL, CPRL
    default: throw new Error(`relayer: unknown progression order ${cod.progression}`);
  }
}

function readPassCount(bio) {
  if (bio.getbit() === 0) return 1;
  if (bio.getbit() === 0) return 2;
  const b = bio.read(2);
  if (b < 3) return 3 + b;
  const c = bio.read(5);
  if (c < 31) return 6 + c;
  return 37 + bio.read(7);
}

/** Parse every packet, recovering each code-block's total passes, zero bit-planes
 *  and coded segment. Mirrors readPacket (src/jpxt2.ts:134). */
function parseTier2(siz, cod, tile, Bio, TagTree) {
  const nc = siz.comps, nr = cod.levels + 1;
  const comps = [];
  for (let c = 0; c < nc; c++) {
    const comp = buildComponent(siz, cod);
    for (const res of comp) for (const sb of res.subbands) {
      sb.inclTree = new TagTree(sb.cols, sb.rows);
      sb.zbpTree = new TagTree(sb.cols, sb.rows);
    }
    comps.push(comp);
  }
  let bytePos = 0;
  const readPacket = (res, layer) => {
    const bio = new Bio(tile, bytePos, tile.length);
    const contrib = [];
    if (bio.getbit() === 1) {
      for (const sb of res.subbands) {
        sb.blocks.forEach((cb, bi) => {
          const col = bi % sb.cols, row = (bi / sb.cols) | 0;
          let include;
          if (!cb.included) {
            include = sb.inclTree.decode(bio, row, col, layer + 1) <= layer;
            if (include) {
              cb.included = true;
              let t = 1, zbp = 0;
              for (;;) { const v = sb.zbpTree.decode(bio, row, col, t); if (v < t) { zbp = v; break; } t++; if (t > 64) { zbp = v; break; } }
              cb.zeroBitPlanes = zbp;
            }
          } else {
            include = bio.getbit() === 1;
          }
          if (!include) return;
          const passes = readPassCount(bio);
          while (bio.getbit() === 1) cb.lblock++;
          const len = bio.read(cb.lblock + Math.floor(Math.log2(passes)));
          cb.passes += passes;
          contrib.push({ cb, len });
        });
      }
    }
    bio.inalign();
    let body = bio.bp;
    for (const { cb, len } of contrib) {
      const chunk = tile.subarray(body, body + len);
      cb.segment = concat([cb.segment, chunk]);
      body += len;
    }
    bytePos = body;
  };
  forEachPacket(cod, nc, nr, cod.layers, (c, r, l) => readPacket(comps[c][r], l));
  return comps;
}

// ---------- re-layer ----------

/** Spread a code-block's passes and bytes over nLayers.
 *  Every contributing layer gets at least one pass AND at least one byte, so no
 *  packet ever signals a zero-length contribution. The cut points are arbitrary
 *  (see the file header); only the reassembled total carries meaning. */
function splitBlock(cb, nLayers) {
  const P = cb.passes, S = cb.segment.length;
  const plan = [];
  for (let i = 0; i < nLayers; i++) plan.push({ passes: 0, bytes: new Uint8Array(0) });
  if (P === 0 || S === 0) return plan;
  const L = Math.min(nLayers, P, S);
  const basePass = Math.floor(P / L), remPass = P % L;
  const baseByte = Math.floor(S / L), remByte = S % L;
  let off = 0;
  for (let i = 0; i < L; i++) {
    const nb = baseByte + (i < remByte ? 1 : 0);
    plan[i] = { passes: basePass + (i < remPass ? 1 : 0), bytes: cb.segment.subarray(off, off + nb) };
    off += nb;
  }
  return plan;
}

/** Re-emit every packet, now over nLayers. Inverse of parseTier2. */
function emitTier2(siz, cod, comps, nLayers) {
  const nc = siz.comps, nr = cod.levels + 1;
  for (const comp of comps) for (const res of comp) for (const sb of res.subbands) {
    sb.incEnc = new TagTreeEnc(sb.cols, sb.rows);
    sb.zbpEnc = new TagTreeEnc(sb.cols, sb.rows);
    sb.blocks.forEach((cb, bi) => {
      cb.plan = splitBlock(cb, nLayers);
      let first = cb.plan.findIndex((p) => p.passes > 0);
      if (first < 0) first = nLayers; // never included: value >= nLayers
      cb.encIncluded = false;
      cb.encLblock = 3;
      const row = (bi / sb.cols) | 0, col = bi % sb.cols;
      sb.incEnc.setLeaf(row, col, first);
      sb.zbpEnc.setLeaf(row, col, cb.zeroBitPlanes);
    });
    sb.incEnc.build();
    sb.zbpEnc.build();
  }

  const out = [];
  const writePacket = (res, layer) => {
    let any = false;
    for (const sb of res.subbands) for (const cb of sb.blocks) if (cb.plan[layer].passes > 0) { any = true; break; }
    const bw = new BioWriter();
    if (!any) { bw.putbit(0); out.push(bw.flush()); return; }
    bw.putbit(1);
    const bodies = [];
    for (const sb of res.subbands) {
      sb.blocks.forEach((cb, bi) => {
        const row = (bi / sb.cols) | 0, col = bi % sb.cols;
        const part = cb.plan[layer];
        if (!cb.encIncluded) {
          sb.incEnc.encode(bw, row, col, layer + 1);
          if (part.passes === 0) return;
          cb.encIncluded = true;
          for (let t = 1; t <= cb.zeroBitPlanes + 1; t++) sb.zbpEnc.encode(bw, row, col, t);
        } else {
          bw.putbit(part.passes > 0 ? 1 : 0);
          if (part.passes === 0) return;
        }
        writePassCount(bw, part.passes);
        const len = part.bytes.length;
        const extra = Math.floor(Math.log2(part.passes));
        const need = len === 0 ? 1 : Math.floor(Math.log2(len)) + 1;
        let k = 0;
        while (cb.encLblock + k + extra < need) k++;
        for (let i = 0; i < k; i++) bw.putbit(1); // lblock growth
        bw.putbit(0);
        cb.encLblock += k;
        bw.write(len, cb.encLblock + extra);
        bodies.push(part.bytes);
      });
    }
    out.push(bw.flush(), ...bodies);
  };
  forEachPacket(cod, nc, nr, nLayers, (c, r, l) => writePacket(comps[c][r], l));
  return concat(out);
}

/** Re-layer a bare single-layer J2K codestream into an nLayers one.
 *  Bio and TagTree are injected so this file stays free of src/ imports. */
export function relayerWith(j2k, nLayers, Bio, TagTree) {
  if (!Number.isInteger(nLayers) || nLayers < 2) throw new Error('relayer: nLayers must be an integer >= 2');
  const h = parseHeader(j2k);
  if (h.cod.layers !== 1) throw new Error(`relayer: source already has ${h.cod.layers} layers`);
  const comps = parseTier2(h.siz, h.cod, h.tileData, Bio, TagTree);
  const tile = emitTier2(h.siz, h.cod, comps, nLayers);

  const head = j2k.slice(0, h.sodEnd); // SOC .. SOD marker inclusive (a copy)
  head[h.codPos + 6] = (nLayers >>> 8) & 0xff; // COD SGcod layer count (u16)
  head[h.codPos + 7] = nLayers & 0xff;
  const psot = (h.sodEnd - h.sotPos) + tile.length; // SOT marker .. end of tile-part
  head[h.sotPos + 6] = (psot >>> 24) & 0xff;
  head[h.sotPos + 7] = (psot >>> 16) & 0xff;
  head[h.sotPos + 8] = (psot >>> 8) & 0xff;
  head[h.sotPos + 9] = psot & 0xff;
  return concat([head, tile, Uint8Array.from([0xff, 0xd9])]);
}
```

The parse stage needs a `Bio` reader and a `TagTree` decoder. Rather than duplicate them a third time, `relayerWith` takes them as arguments. Add the convenience wrapper that supplies the copies this file already owns — append:

```js
/** Bio reader — a copy of src/jpxt2.ts:10, so scripts/ stays standalone. */
class BioReader {
  constructor(data, start, end) { this.data = data; this.bp = start; this.end = end; this.buf = 0; this.ct = 0; }
  bytein() {
    this.buf = (this.buf << 8) & 0xffff;
    this.ct = this.buf === 0xff00 ? 7 : 8;
    if (this.bp >= this.end) this.buf += 0xff;
    else this.buf += this.data[this.bp++];
  }
  getbit() { if (this.ct === 0) this.bytein(); this.ct--; return (this.buf >> this.ct) & 1; }
  read(n) { let v = 0; for (let i = n - 1; i >= 0; i--) v += this.getbit() << i; return v; }
  inalign() { if ((this.buf & 0xff) === 0xff) this.bytein(); this.ct = 0; }
}

/** Tag-tree decoder — a copy of src/jpxt2.ts:33. */
class TagTreeDec {
  constructor(w, h) {
    this.levels = [];
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({ w: lw, h: lh, value: new Int32Array(lw * lh), final: new Uint8Array(lw * lh) });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  decode(bio, i, j, threshold) {
    const path = [];
    let x = j, y = i;
    for (let l = 0; l < this.levels.length; l++) { path.push({ l, x, y }); x >>= 1; y >>= 1; }
    let lower = 0;
    for (let s = path.length - 1; s >= 0; s--) {
      const { l, x: nx, y: ny } = path[s];
      const lvl = this.levels[l];
      const idx = ny * lvl.w + nx;
      if (lvl.value[idx] < lower) lvl.value[idx] = lower;
      while (!lvl.final[idx] && lvl.value[idx] < threshold) {
        if (bio.getbit()) lvl.final[idx] = 1;
        else lvl.value[idx]++;
      }
      lower = lvl.value[idx];
    }
    return lower;
  }
}

export function relayer(j2k, nLayers) { return relayerWith(j2k, nLayers, BioReader, TagTreeDec); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/jpx-relayer.test.ts`
Expected: PASS — all Task 1 tests plus 5 new `relayer` tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

If the sample-preservation tests fail, the bug is in this file, not in `src/` — `src/jpxt2.ts` already decodes the committed single-layer fixtures correctly. Debug with `superpowers:systematic-debugging`; do not change `src/`.

- [ ] **Step 5: Commit**

```bash
git add scripts/jpx-relayer.mjs test/jpx-relayer.test.ts
git commit -m "test(jpx): offline re-layering transcoder for multi-layer fixtures (pol)"
```

---

### Task 3: Generate the fixtures and assert the decoder path

The only task needing the WASM encoder, the network, and a temporary dependency. It ends with the fixtures committed and the multi-layer decode path covered.

**Files:**
- Modify: `scripts/gen-jpx-fixtures.mjs`
- Modify: `test/helpers/jpx-fixtures.ts` (regenerated, never hand-edited)
- Test: `test/jpx.test.ts`

**Interfaces:**
- Consumes: `relayer(j2k, nLayers)` from Task 2.
- Produces: fixtures `multilayer_gray_j2k`, `multilayer_rgb_j2k`, `multilayer_rgb_rgb` in `test/helpers/jpx-fixtures.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/jpx.test.ts`, inside the existing `describe('decodeJpx end-to-end', ...)` block, after the `'JP2 box wrapper ...'` case. Extend the existing import to `import { decodeJpx, parseCodestream } from '../src/jpx.js';`:

```ts
  it('multi-layer (3 quality layers) grayscale decodes exactly', () => {
    // Guards against a regeneration silently producing a single-layer stream,
    // which would leave the assertion below passing while covering nothing.
    expect(parseCodestream(F.multilayer_gray_j2k).cod.layers).toBe(3);
    const img = decodeJpx(F.multilayer_gray_j2k);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('multi-layer (3 quality layers) RGB decodes exactly', () => {
    expect(parseCodestream(F.multilayer_rgb_j2k).cod.layers).toBe(3);
    const img = decodeJpx(F.multilayer_rgb_j2k);
    expect(img.comps).toBe(3);
    expect(Array.from(img.data)).toEqual(Array.from(F.multilayer_rgb_rgb.data));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpx.test.ts`
Expected: FAIL — `F.multilayer_gray_j2k` is undefined (and `npm run typecheck` reports the missing exports).

- [ ] **Step 3: Wire the relayer and the validation gate into the generator**

In `scripts/gen-jpx-fixtures.mjs`:

Update the header comment — replace these two lines:

```
// The encoder here emits single quality-layer streams only; a real multi-layer
// fixture is tracked as a follow-up bd issue.
```

with:

```
// The encoder here emits single quality-layer streams only (its embind surface has
// no setNumLayers), so the multi-layer fixtures are produced by re-layering its
// output offline — see scripts/jpx-relayer.mjs — and every re-layered stream is
// verified by decoding it back through this same WASM OpenJPEG decoder before
// anything is written.
```

Add the import next to the existing ones near the top:

```js
import { relayer } from './jpx-relayer.mjs';
```

Add these two helpers beside `emit`:

```js
/** Emit a codestream with no paired ground truth (it reuses another fixture's). */
function emitStreamOnly(name, j2k) {
  out.push(`export const ${name}_j2k: Uint8Array = b64(${JSON.stringify(b64(j2k))});`);
}

/** Validation gate: a re-layered stream must decode through the real OpenJPEG
 *  decoder to exactly the source samples. Our packet writer is otherwise checked
 *  only by our own packet reader, where a shared misreading of Annex B.10 would
 *  pass silently. Throws rather than writing a bad fixture. */
function assertOpenJpegDecodes(name, j2k, expected) {
  const got = decode(j2k);
  if (got.length !== expected.length) throw new Error(`${name}: OpenJPEG returned ${got.length} samples, expected ${expected.length}`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== expected[i]) throw new Error(`${name}: OpenJPEG decode differs at sample ${i} (${got[i]} != ${expected[i]})`);
  }
  console.log(`  ${name}: OpenJPEG round-trip OK`);
}
```

Append after the existing fixture 4 (`emit('jp2box', ...)`), before the `writeFileSync` call:

```js
// 5) Multi-layer (3 quality layers), 5/3 lossless grayscale, LRCP — exact.
//    Ground truth is fixture 1's, since re-layering is sample-preserving.
const gray3 = relayer(glossless, 3);
assertOpenJpegDecodes('multilayer_gray', gray3, gray);
emitStreamOnly('multilayer_gray', gray3);

// 6) Multi-layer (3 quality layers), 5/3 lossless RGB, LRCP — exact.
//    A fresh LRCP encode: fixture 3 is RPCL, and we want the layer loop nested
//    across components in progression order 0.
const rgbLrcp = encode(rgb, 3, { reversible: true, progression: 0 });
const rgb3 = relayer(rgbLrcp, 3);
assertOpenJpegDecodes('multilayer_rgb', rgb3, rgb);
emit('multilayer_rgb', rgb3, rgb, 3);
```

- [ ] **Step 4: Regenerate the fixtures**

```bash
npm install --save-dev @cornerstonejs/codec-openjpeg
node scripts/gen-jpx-fixtures.mjs
npm uninstall @cornerstonejs/codec-openjpeg
```

Expected output includes both gate lines, then the write:

```
  multilayer_gray: OpenJPEG round-trip OK
  multilayer_rgb: OpenJPEG round-trip OK
wrote test/helpers/jpx-fixtures.ts
```

If a gate throws, OpenJPEG rejected our packet syntax — that is the transcoder being wrong, and it is exactly what this gate exists to catch. Debug `scripts/jpx-relayer.mjs` with `superpowers:systematic-debugging`. Do not weaken or skip the gate.

Then confirm the dependency is gone:

```bash
git diff --stat package.json package-lock.json
```

Expected: no diff for `package.json`. If `package-lock.json` changed, restore it with `git checkout -- package-lock.json`.

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `npx vitest run test/jpx.test.ts`
Expected: PASS — 7 cases, including the two new ones.

Run: `npm test`
Expected: full suite green.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-jpx-fixtures.mjs test/helpers/jpx-fixtures.ts test/jpx.test.ts
git commit -m "test(jpx): multi-layer quality-layer fixtures, 3 layers gray + RGB (pol)"
```

---

### Task 4: Close out

**Files:**
- Modify: none (verification and session protocol only)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing importable.

- [ ] **Step 1: Confirm the multi-layer branches actually execute**

The point of the whole issue. Temporarily add a `throw new Error('reached')` at `src/jpxt2.ts:151` (the already-included path, `include = bio.getbit() === 1`), then run:

```bash
npx vitest run test/jpx.test.ts
```

Expected: the two new multi-layer cases FAIL with "reached"; the four single-layer cases still PASS. That proves the branch was previously dead and is now covered.

Revert immediately:

```bash
git checkout -- src/jpxt2.ts
git diff --stat  # MUST be empty
```

- [ ] **Step 2: Full verification**

```bash
npm run typecheck
npm test
```

Expected: both green. Record the actual test count in the close comment — do not claim green without having seen it.

- [ ] **Step 3: Close the issue and push**

```bash
bd close pol
git pull --rebase
git push
git status  # MUST show "up to date with origin"
```

- [ ] **Step 4: Record what was learned**

```bash
bd remember jpx-multilayer-fixture-shipped "Multi-layer JPX fixtures shipped (pol). The WASM OpenJPEG encoder (@cornerstonejs/codec-openjpeg) has no setNumLayers in its embind surface, so multi-layer streams are minted offline by scripts/jpx-relayer.mjs, which re-layers a single-layer codestream by splitting each code-block's coded passes and bytes across N packets. Split points are arbitrary, not rate-distortion-optimal: valid only because total passes and total bytes are preserved, so decoding ALL layers is bit-exact; a truncated prefix decodes to noise, so never assert on intermediate layers. gen-jpx-fixtures.mjs gates every re-layered stream through the WASM OpenJPEG decoder before writing. Fixtures multilayer_gray_j2k / multilayer_rgb_j2k are 3 layers; the tests assert cod.layers === 3 so a bad regeneration cannot pass vacuously."
```

---

## Self-Review

**Spec coverage.** Transcoder (spec *Components* → Tasks 1-2, including the self-contained decision and the `Bio`/`TagTree` duplication it entails); split policy (Task 2 `splitBlock`); rewrite of COD/`Psot` (Task 2 `relayerWith`); generator changes and the LRCP RGB source (Task 3); validation gate (Task 3 `assertOpenJpegDecodes`); fixtures and the `cod.layers === 3` guard (Task 3); verification (Task 4). The spec's *Problem* claim — that the branches are dead — is verified empirically in Task 4 Step 1 rather than merely asserted.

**Two deliberate deviations from the spec, both narrowing risk:**
1. The spec says packets are emitted "in LRCP order, layer outermost". The plan re-emits in the *source's own* progression order via `forEachPacket`, a five-line mirror of the decoder's switch. Forcing LRCP would silently corrupt a non-LRCP source; this also makes the `rpcl_j2k` test in Task 2 possible.
2. The spec has `relayer` importing nothing; the plan splits out `relayerWith(j2k, n, Bio, TagTree)` so the parse-side reader/decoder are injectable, then supplies file-local copies. This keeps `scripts/` standalone as specified while letting Task 1 test the encoders against the *real* `src/` classes.

**Placeholder scan:** none — every code step carries complete code, every command an expected result.

**Type consistency:** `BioWriter`/`TagTreeEnc`/`writePassCount`/`relayer` are named identically in `scripts/jpx-relayer.d.mts`, the implementation, and both test files. `relayerWith` is internal and deliberately absent from the `.d.mts`, since no TypeScript file imports it.

**Known risk.** `splitBlock` cuts an MQ codeword segment at a byte offset that is not a real pass boundary. Our decoder cannot object — it concatenates first and runs Tier-1 once. OpenJPEG's decoder is stricter and may reject the stream at the Task 3 gate. If it does, the fallback is to reduce to 2 layers, or to give layer 0 all but one pass so later layers carry a minimal tail. Both keep `cod.layers > 1` and preserve the coverage this issue is for.
