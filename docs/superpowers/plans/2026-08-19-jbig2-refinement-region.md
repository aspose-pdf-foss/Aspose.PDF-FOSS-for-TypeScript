# JBIG2 generic refinement region (GRRD) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode the generic refinement region procedure (T.88 §6.3) in a new leaf module and wire it to segment types 40/42/43, so a refinement region stops throwing `UnsupportedFeatureError`.

**Architecture:** `src/jbig2refine.ts` is pure over `Bitmap` and an `MqDecoder` — it takes the reference bitmap and its `(dx, dy)` as arguments and knows nothing about segments, which is what lets one procedure serve the three callers T.88 gives it. This child wires only the first (the refinement region segment); `utax.5` wires the other two. It follows `decodeGeneric`'s signature exactly, including the optional `mqIn`/`cxIn`, because those two later callers share a stream with their enclosing decode.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies. Test vectors are minted by the dev-only encoder in `scripts/jbig2-codec.mjs` through `scripts/mqenc.mjs`, which round-trips each one before writing.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 2 of 7 ("GRRD"). Tracked as `aspose-pdf-foss-for-ts-utax.3`. Builds directly on `utax.4`, which is closed: `buffersBySeg` already holds intermediate regions, and this is the segment type that reads it.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **`scripts/jbig2-codec.mjs` and `scripts/mqenc.mjs` are dev-only** — not shipped, imported by neither `src/` nor the tests. Tests read the *generated* `test/helpers/jbig2-*-vectors.ts` only.
- **Issue tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`.
- **Both quality gates must be green before the issue closes:** `npm run typecheck` and `npm test`.
- **This child narrows a throw rather than deleting it.** Refinement *regions* decode; refinement *inside* a symbol dictionary (REFAGG) or a text region (SBREFINE) still refuses by name until `utax.5`. Halftone, pattern dictionary, custom Huffman tables and Huffman-coded regions are untouched.
- **Prove every assertion load-bearing.** Break the path, watch the suite go red, restore. For a decoder this is both unusually cheap and unusually necessary — almost any mistake still produces *an* image.

## Background: the two things that can go wrong silently

**1. The context bit order cannot be validated by a round trip.** The refinement context is assembled from a fixed list of coding-bitmap pixels and reference-bitmap pixels. Which list position becomes which context bit is a decision, and *our encoder and our decoder will agree with each other whatever we choose* — the round trip passes with the order reversed, the AT pixels sorted in, or the two lists swapped. This is precisely the repo's recorded rule that a differential test cannot validate the parser it runs through.

The outside anchor is T.88's published **SLTP context values** for TPGRON: `0x0020` for template 0 and `0x0008` for template 1. Each is the context label for "every template pixel is 0 except the reference pixel at `(0, 0)`". That pins the template lengths, the coding-before-reference order, the position of `(0,0)` within the reference list, and the fact that the AT pixels are *appended* rather than sorted in — all four, from one constant per template. Task 1 asserts it directly, with no bitstream involved.

Worked through for template 0 (13 bits, MSB first): coding `[0,-1] [1,-1] [-1,0]` are bits 0–2, AT1 is bit 3, reference `[0,-1] [1,-1] [-1,0] [0,0] [1,0] [-1,1] [0,1] [1,1]` are bits 4–11, AT2 is bit 12. Setting only reference `[0,0]` sets bit 7, giving `1 << (12 - 7)` = `0x20`. For template 1 (10 bits): coding is bits 0–3, reference `[0,-1] [-1,0] [0,0] [1,0] [0,1] [1,1]` bits 4–9; setting only `[0,0]` sets bit 6, giving `1 << (9 - 6)` = `0x08`. Both match the published constants, and both land on the co-located reference pixel, which is what "typical" means semantically.

**Note the contrast with `jbig2generic.ts`:** its `buildTemplate` concatenates the AT pixels and then **sorts the whole set by `(y, x)`**. Refinement does **not** sort. Copying the generic module's habit here is the most likely way to get this wrong, and the SLTP anchor is the only thing in the suite that would notice.

**2. Combining where the spec says replace.** A refinement region whose referred-to set contains no intermediate region refines **the page itself** — the reference is the page's current pixels under the region rectangle, and the result **replaces** them. The region segment's external combination operator does not apply to that case. OR-ing the refinement output onto its own input is more ink in roughly the right places, which renders as a slightly bold page rather than as a fault. Task 3's fixture makes the refinement *clear* pixels the reference had set, so an OR cannot fake it.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/jbig2refine.ts` | create | The whole of §6.3: the two templates, context assembly, TPGRON's typicality test, and `decodeRefinement`. Pure — no segment knowledge, no `Document`. |
| `src/jbig2.ts` | modify | `case 40: case 42: case 43:` — parse the segment header, pick the reference, decode, then store (40) or composite/replace (42/43). |
| `scripts/jbig2-codec.mjs` | modify | `encodeRefinement` + `decodeRefinement` reference halves, mirroring the existing generic pair. |
| `scripts/mqenc.mjs` | modify | Mints `test/helpers/jbig2-refine-vectors.ts`, round-tripping each vector first. |
| `test/helpers/jbig2-refine-vectors.ts` | generated | Never hand-edited. Regenerate with `node scripts/mqenc.mjs`. |
| `scripts/gen-jbig2-fixtures.mjs` | modify | Two raw segment-level streams for Task 3. |
| `test/helpers/jbig2-fixtures.ts` | regenerated | Never hand-edited. Regenerate with `node scripts/gen-jbig2-fixtures.mjs`. |
| `test/jbig2-refine.test.ts` | create | The module's own tests: the SLTP anchor, `typicalPixel`, and the round-trip vectors. |
| `test/jbig2-assembly.test.ts` | modify | Segment-level behaviour; drop 40/42/43 from the refusal fence. |
| `test/jbig2-unsupported.test.ts` | modify | Its type-40 case is superseded — repointed to the truncated-segment refusal. |
| `CHANGELOG.md`, `CLAUDE.md`, `README.md` | modify | User-visible: refinement comes off the refusal list, carefully worded so REFAGG/SBREFINE stay on it. |

**Why a new module rather than growing `jbig2generic.ts`:** refinement reads *two* bitmaps and has its own template set, its own context size and its own typical-prediction rule. It shares nothing with §6.2 but the MQ decoder.

**On the `jbig2.ts` ↔ `jbig2refine.ts` import:** `jbig2refine.ts` imports `Bitmap` and `newBitmap` from `jbig2.js` while `jbig2.ts` imports `decodeRefinement` back. That is the same shape `jbig2generic.ts` already has and closes no cycle at runtime — the type is erased and `newBitmap` is a function declaration, hoisted before `decodeJbig2` ever runs.

---

### Task 1: `jbig2refine.ts` — templates, context assembly, and the core decode

**Files:**
- Create: `src/jbig2refine.ts`
- Modify: `scripts/jbig2-codec.mjs` (append a refinement section after the generic one, around line 211)
- Modify: `scripts/mqenc.mjs` (append a refinement vector section before the final `console.log`)
- Generate: `test/helpers/jbig2-refine-vectors.ts`
- Create: `test/jbig2-refine.test.ts`

**Interfaces:**
- Consumes: `newBitmap(w, h, fill?): Bitmap` and `type Bitmap` from `src/jbig2.js`; `MqDecoder` from `src/jpxmq.js`.
- Produces, all from `src/jbig2refine.ts`:
  - `export interface RefineParams { width: number; height: number; reference: Bitmap; dx: number; dy: number; template: number; at: Array<{ x: number; y: number }>; tpgron: boolean }`
  - `export interface RefineTemplate { coding: number[][]; reference: number[][] }`
  - `export const REFINE_REUSED_CONTEXTS: number[]` — `[0x0020, 0x0008]`
  - `export function refineTemplate(template: number, at: Array<{ x: number; y: number }>): RefineTemplate`
  - `export function refineContext(bm: Bitmap, ref: Bitmap, tpl: RefineTemplate, x: number, y: number, dx: number, dy: number): number`
  - `export function typicalPixel(ref: Bitmap, rx: number, ry: number): number | undefined` — added in Task 2, declared here so Task 2's edit is additive
  - `export function decodeRefinement(data: Uint8Array, start: number, end: number, prm: RefineParams, mqIn?: MqDecoder, cxIn?: Int8Array): Bitmap`
- Produces, from `test/helpers/jbig2-refine-vectors.ts`: `refine_t0` and `refine_t1`, each `{ bytes: Uint8Array; width: number; height: number; refRows: string[]; rows: string[] }`.

- [ ] **Step 1: Write the module**

Create `src/jbig2refine.ts`:

```ts
// JBIG2 generic refinement region decode — ITU-T T.88 §6.3. Refines a reference
// bitmap into a new one of the same nominal size.
//
// Arithmetic only: T.88 defines no MMR refinement, which is why a Huffman text
// region has to alternate entropy coders within one stream rather than refining
// in its own coding.
//
// Pure over `Bitmap` and an `MqDecoder` — the reference and its (dx, dy) arrive
// as arguments and nothing here knows what a segment is, which is what lets one
// procedure serve all three callers T.88 gives it: the refinement region
// segment, a symbol dictionary with REFAGG=1, and a text region with SBREFINE.
import { MqDecoder } from './jpxmq.js';
import { newBitmap, type Bitmap } from './jbig2.js';

export interface RefineParams {
  width: number; height: number;
  /** The bitmap being refined (T.88 GRREFERENCE). */
  reference: Bitmap;
  /** Reference offset (GRREFERENCEDX/DY): reference pixel for (x, y) is
   *  (x - dx, y - dy). Zero for a refinement region segment; the decoded
   *  RDX/RDY for the symbol-dictionary and text-region callers. */
  dx: number; dy: number;
  /** GRTEMPLATE: 0 (13-bit context, two AT pixels) or 1 (10-bit, no AT). */
  template: number;
  /** The two AT pixels, template 0 only: at[0] joins the coding template,
   *  at[1] the reference template. Both nominally (-1, -1). */
  at: Array<{ x: number; y: number }>;
  /** TPGRON typical prediction (T.88 §6.3.5.6). */
  tpgron: boolean;
}

export interface RefineTemplate { coding: number[][]; reference: number[][] }

// T.88 §6.3.5.3, Figures 12-14. Coding pixels are read from the bitmap being
// built; reference pixels from GRREFERENCE at (x - dx, y - dy).
const CODING: number[][][] = [
  [[0, -1], [1, -1], [-1, 0]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0]],
];
const REFERENCE: number[][][] = [
  [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, 1]],
];

/** SLTP contexts for TPGRON (T.88 §6.3.5.6), per template — and the only
 *  outside evidence of the context bit order. Each is the label for "every
 *  template pixel 0 except the reference pixel at (0,0)", so asserting that
 *  equality pins the template lengths, the coding-before-reference order, and
 *  the fact that the AT pixels are appended rather than sorted in. A round trip
 *  through our own encoder agrees with itself whatever order we pick. */
export const REFINE_REUSED_CONTEXTS = [0x0020, 0x0008];

/** Build a template's pixel lists, AT pixels APPENDED — never sorted in, unlike
 *  jbig2generic.ts's buildTemplate, which sorts the whole set by (y, x).
 *  Copying that habit here is the likeliest way to get §6.3 wrong. */
export function refineTemplate(template: number, at: Array<{ x: number; y: number }>): RefineTemplate {
  const t = template === 0 ? 0 : 1;
  const coding = CODING[t].map((p) => [p[0], p[1]]);
  const reference = REFERENCE[t].map((p) => [p[0], p[1]]);
  if (t === 0) {
    coding.push([at[0]?.x ?? -1, at[0]?.y ?? -1]);
    reference.push([at[1]?.x ?? -1, at[1]?.y ?? -1]);
  }
  return { coding, reference };
}

function px(bm: Bitmap, x: number, y: number): number {
  return (x < 0 || x >= bm.width || y < 0 || y >= bm.height) ? 0 : bm.data[y * bm.width + x];
}

/** The context label for one pixel (T.88 §6.3.5.3): coding pixels first and
 *  most significant, then reference pixels. */
export function refineContext(
  bm: Bitmap, ref: Bitmap, tpl: RefineTemplate, x: number, y: number, dx: number, dy: number,
): number {
  let ctx = 0;
  for (const [ox, oy] of tpl.coding) ctx = (ctx << 1) | px(bm, x + ox, y + oy);
  for (const [ox, oy] of tpl.reference) ctx = (ctx << 1) | px(ref, x - dx + ox, y - dy + oy);
  return ctx;
}

/** Decode a generic refinement region (T.88 §6.3). When `mqIn`/`cxIn` are
 *  supplied (the symbol-dictionary and text-region callers) they drive the
 *  decode; otherwise a fresh decoder and a 2^13-context array are allocated. */
export function decodeRefinement(
  data: Uint8Array, start: number, end: number, prm: RefineParams,
  mqIn?: MqDecoder, cxIn?: Int8Array,
): Bitmap {
  const bm = newBitmap(prm.width, prm.height);
  const mq = mqIn ?? new MqDecoder(data, start, end);
  const cx = cxIn ?? new Int8Array(1 << 13);
  const tpl = refineTemplate(prm.template, prm.at);
  for (let y = 0; y < prm.height; y++) {
    for (let x = 0; x < prm.width; x++) {
      bm.data[y * prm.width + x] = mq.decode(cx, refineContext(bm, prm.reference, tpl, x, y, prm.dx, prm.dy));
    }
  }
  return bm;
}
```

TPGRON is deliberately absent — Task 2 adds it. `prm.tpgron` is declared now so the interface does not move between tasks.

- [ ] **Step 2: Add the encoder and reference decoder halves**

In `scripts/jbig2-codec.mjs`, immediately after the generic-region section (after `decodeGeneric`, currently ending line 211), add:

```js
// ---- Generic refinement region (arithmetic) ----------------------------------
// Mirrors src/jbig2refine.ts. AT pixels are APPENDED, never sorted in.
export const REFINE_CODING = [
  [[0, -1], [1, -1], [-1, 0]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0]],
];
export const REFINE_REFERENCE = [
  [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, 1]],
];
export const REFINE_REUSED_CONTEXTS = [0x0020, 0x0008];

export function refineTemplate(template, at) {
  const t = template === 0 ? 0 : 1;
  const coding = REFINE_CODING[t].map((p) => [p[0], p[1]]);
  const reference = REFINE_REFERENCE[t].map((p) => [p[0], p[1]]);
  if (t === 0) {
    coding.push([at[0].x, at[0].y]);
    reference.push([at[1].x, at[1].y]);
  }
  return { coding, reference };
}
function refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy) {
  let ctx = 0;
  for (const [ox, oy] of tpl.coding) ctx = (ctx << 1) | gpx(bm, w, h, x + ox, y + oy);
  for (const [ox, oy] of tpl.reference) ctx = (ctx << 1) | gpx(ref, rw, rh, x - dx + ox, y - dy + oy);
  return ctx;
}
export function encodeRefinement(enc, cx, bm, w, h, ref, rw, rh, dx, dy, template, at) {
  const tpl = refineTemplate(template, at);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      enc.encode(cx, refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy), bm[y * w + x]);
    }
  }
}
export function decodeRefinement(dec, cx, w, h, ref, rw, rh, dx, dy, template, at) {
  const bm = new Uint8Array(w * h);
  const tpl = refineTemplate(template, at);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bm[y * w + x] = dec.decode(cx, refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy));
    }
  }
  return bm;
}
```

`gpx` is the existing bounds-checked pixel reader defined just above `encodeGeneric` (line 175) — reuse it, do not add a second one.

- [ ] **Step 3: Mint the vectors**

In `scripts/mqenc.mjs`, extend the import list from `./jbig2-codec.mjs` with `encodeRefinement, decodeRefinement as refDecodeRefinement` — note the alias, since `decodeTextRegion` is already imported unaliased and a second `decodeRefinement` name would be fine but the alias makes the reference half obvious at the call site. Then, immediately before the final `console.log('all round-trips OK');`, add:

```js
// ---- generic refinement region vectors ---------------------------------------
// A refinement is a small correction to a reference, which is what it is for in
// a real file: the reference is a box, the target is the same box with a few
// pixels flipped BOTH ways, so a decoder that OR-ed rather than replaced would
// still be caught by the cleared pixels.
{
  const RW = 16, RH = 16;
  const refBm = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++)
    refBm[y * RW + x] = (x === 0 || y === 0 || x === RW - 1 || y === RH - 1) ? 1 : 0;
  const target = Uint8Array.from(refBm);
  target[5 * RW + 5] = 1; target[5 * RW + 6] = 1; target[6 * RW + 5] = 1; // added ink
  target[0 * RW + 8] = 0; target[15 * RW + 8] = 0;                        // cleared ink
  const REF_AT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];
  const rowsOf = (bm, w, h) => { const r = []; for (let y = 0; y < h; y++) r.push(Array.from(bm.subarray(y * w, (y + 1) * w)).join('')); return r; };
  const vectors = {};
  for (const template of [0, 1]) {
    const enc = new MqEncoder();
    encodeRefinement(enc, new Int8Array(1 << 13), target, RW, RH, refBm, RW, RH, 0, 0, template, REF_AT);
    const bytes = enc.flush();
    const got = refDecodeRefinement(new MqDecoder(bytes, 0, bytes.length), new Int8Array(1 << 13), RW, RH, refBm, RW, RH, 0, 0, template, REF_AT);
    if (Buffer.compare(Buffer.from(got), Buffer.from(target)) !== 0) throw new Error(`refinement t${template} round-trip mismatch`);
    vectors[template] = { bytes, rows: rowsOf(target, RW, RH) };
  }
  write('jbig2-refine-vectors.ts', `// GENERATED by scripts/mqenc.mjs — do not edit by hand. Regenerate: node scripts/mqenc.mjs
/* eslint-disable */
function b64(s: string): Uint8Array { return Uint8Array.from(Buffer.from(s, "base64")); }
export const refine_t0 = { bytes: b64(${JSON.stringify(b64(vectors[0].bytes))}), width: ${RW}, height: ${RH}, refRows: ${JSON.stringify(rowsOf(refBm, RW, RH))}, rows: ${JSON.stringify(vectors[0].rows)} };
export const refine_t1 = { bytes: b64(${JSON.stringify(b64(vectors[1].bytes))}), width: ${RW}, height: ${RH}, refRows: ${JSON.stringify(rowsOf(refBm, RW, RH))}, rows: ${JSON.stringify(vectors[1].rows)} };
`);
}
```

Run it:

```bash
node scripts/mqenc.mjs
git status --short test/helpers/
git diff test/helpers/jbig2-arith-vectors.ts test/helpers/jbig2-generic-vectors.ts test/helpers/jbig2-symbol-vectors.ts test/helpers/jbig2-text-vectors.ts
```

Expected: `all round-trips OK` printed, `jbig2-refine-vectors.ts` created, and the four pre-existing vector files **unchanged** (the last command prints nothing). If any of them moved, stop — the script rewrites all of them and something in the shared codec shifted.

- [ ] **Step 4: Write the failing test**

Create `test/jbig2-refine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { newBitmap, type Bitmap } from '../src/jbig2.js';
import {
  decodeRefinement, refineContext, refineTemplate, REFINE_REUSED_CONTEXTS,
} from '../src/jbig2refine.js';
import * as F from './helpers/jbig2-refine-vectors.js';

function rows(bm: Bitmap): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

function fromRows(r: string[]): Bitmap {
  const bm = newBitmap(r[0].length, r.length);
  for (let y = 0; y < r.length; y++) for (let x = 0; x < r[y].length; x++) bm.data[y * bm.width + x] = r[y][x] === '1' ? 1 : 0;
  return bm;
}

const NOMINAL_AT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];

describe('jbig2 generic refinement', () => {
  // The outside anchor. T.88 §6.3.5.6 publishes the SLTP context as 0x0020 for
  // template 0 and 0x0008 for template 1, and each is the label for "every
  // template pixel 0 except the reference pixel at (0,0)". Asserting that
  // equality pins the template lengths, the coding-before-reference bit order,
  // the position of (0,0) in the reference list, and the fact that the AT
  // pixels are APPENDED rather than sorted in the way jbig2generic.ts sorts
  // them. A round trip through our own encoder cannot see any of that — it
  // agrees with itself whatever order we pick.
  it.each([[0], [1]])('assembles a template-%i context to T.88\'s published SLTP value', (template) => {
    const bm = newBitmap(5, 5);
    const ref = newBitmap(5, 5);
    ref.data[2 * 5 + 2] = 1; // the co-located reference pixel, and nothing else
    const tpl = refineTemplate(template, NOMINAL_AT);
    expect(refineContext(bm, ref, tpl, 2, 2, 0, 0)).toBe(REFINE_REUSED_CONTEXTS[template]);
  });

  it('gives template 0 a 13-bit context and template 1 a 10-bit one', () => {
    const t0 = refineTemplate(0, NOMINAL_AT);
    expect(t0.coding.length + t0.reference.length).toBe(13);
    const t1 = refineTemplate(1, NOMINAL_AT);
    expect(t1.coding.length + t1.reference.length).toBe(10);
  });

  it.each([
    ['t0', F.refine_t0, 0],
    ['t1', F.refine_t1, 1],
  ])('refines a reference bitmap (%s)', (_name, v, template) => {
    const reference = fromRows(v.refRows);
    const out = decodeRefinement(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, reference, dx: 0, dy: 0,
      template, at: NOMINAL_AT, tpgron: false,
    });
    expect(rows(out)).toEqual(v.rows);
    // The vector clears pixels as well as adding them, so the result is not
    // reachable by OR-ing anything onto the reference.
    expect(rows(out)).not.toEqual(v.refRows);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run test/jbig2-refine.test.ts`

Expected: FAIL — `Cannot find module '../src/jbig2refine.js'` if Step 1 has not been done, or all five cases failing. If Step 1 is already in place this run should PASS; that is fine, the load-bearing proof is Step 7.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/jbig2-refine.test.ts`

Expected: PASS, 5 tests (2 SLTP cases, 1 width case, 2 round-trip cases).

- [ ] **Step 7: Prove the SLTP anchor load-bearing — three mutations**

This is the most important verification in the whole child, because it is the only thing standing between us and a plausible-looking wrong decoder. Apply each mutation to `src/jbig2refine.ts`, run `npx vitest run test/jbig2-refine.test.ts`, confirm RED, then restore:

1. **Sort the AT pixels in**, the way `jbig2generic.ts` does — in `refineTemplate`, after the two `push` calls, add `coding.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0])); reference.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0]));`. Expected: the two SLTP cases go RED; the round-trip cases stay GREEN, because our encoder does not sort and the vectors were minted before the change — **note which cases fail, this is the whole point**.
2. **Swap the two halves** — in `refineContext`, run the `reference` loop before the `coding` loop. Expected: SLTP cases RED.
3. **Drop a reference pixel** — remove `[1, 1]` from `REFERENCE[0]`. Expected: the template-0 SLTP case and the 13-bit width case both RED.

If mutation 1 leaves the round-trip cases green, that is the expected and important result: it demonstrates in this repo, on this code, that the differential test cannot see a bit-order error. Record that observation in the commit message.

- [ ] **Step 8: Commit**

```bash
git add src/jbig2refine.ts scripts/jbig2-codec.mjs scripts/mqenc.mjs test/helpers/jbig2-refine-vectors.ts test/jbig2-refine.test.ts
git commit -m "feat(utax.3): generic refinement region decode (T.88 6.3)" -m "New leaf module jbig2refine.ts: templates 0 and 1, context assembly, and decodeRefinement, pure over Bitmap and an MqDecoder so one procedure can serve all three callers T.88 gives it. Follows decodeGeneric's mqIn/cxIn shape because the symbol-dictionary and text-region callers share a stream with their enclosing decode." -m "The context bit order is anchored on T.88's published SLTP constants (0x0020, 0x0008), each of which is the label for 'every template pixel 0 except the reference pixel at (0,0)'. That is the only outside evidence available: measured, sorting the AT pixels in the way jbig2generic.ts does leaves both round-trip vectors GREEN and turns only the SLTP assertions red. A differential test cannot validate the parser it runs through." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: TPGRON typical prediction

**Files:**
- Modify: `src/jbig2refine.ts` (add `typicalPixel`, extend `decodeRefinement`'s row loop)
- Modify: `scripts/jbig2-codec.mjs` (TPGRON in both refinement halves)
- Modify: `scripts/mqenc.mjs` (a third vector)
- Regenerate: `test/helpers/jbig2-refine-vectors.ts`
- Modify: `test/jbig2-refine.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `export function typicalPixel(ref: Bitmap, rx: number, ry: number): number | undefined` from `src/jbig2refine.ts` — `0` or `1` when the 3×3 reference neighbourhood centred on `(rx, ry)` is uniform, `undefined` otherwise. Vector export `refine_tpgron` from `test/helpers/jbig2-refine-vectors.ts`, same shape as `refine_t0`.

- [ ] **Step 1: Write the failing test**

`typicalPixel` is a pure function on bit patterns, so it gets hand-computed expectations with no bitstream — the same class of anchor the spec names for the Gray-code fold. Add to `test/jbig2-refine.test.ts`, extending the import to include `typicalPixel`:

```ts
  it('reports a uniform 3x3 reference neighbourhood and nothing else', () => {
    const zeros = newBitmap(5, 5);
    expect(typicalPixel(zeros, 2, 2)).toBe(0);

    const ones = newBitmap(5, 5, 1);
    expect(typicalPixel(ones, 2, 2)).toBe(1);

    const mixed = newBitmap(5, 5);
    mixed.data[1 * 5 + 1] = 1; // one corner of the neighbourhood differs
    expect(typicalPixel(mixed, 2, 2)).toBeUndefined();
  });

  // Out-of-bounds reference pixels read as 0, so the corner of an all-ones
  // reference is NOT typical — its neighbourhood is five 1s and four 0s. Getting
  // this wrong makes the whole first and last row of every TPGRON region take
  // the typical path when it should be decoded, which desynchronises the stream.
  it('does not treat an edge of a uniform reference as typical', () => {
    const ones = newBitmap(5, 5, 1);
    expect(typicalPixel(ones, 0, 0)).toBeUndefined();
    expect(typicalPixel(ones, 4, 4)).toBeUndefined();
  });

  it('refines with TPGRON typical prediction', () => {
    const v = F.refine_tpgron;
    const out = decodeRefinement(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, reference: fromRows(v.refRows), dx: 0, dy: 0,
      template: 0, at: NOMINAL_AT, tpgron: true,
    });
    expect(rows(out)).toEqual(v.rows);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/jbig2-refine.test.ts`

Expected: FAIL — `typicalPixel is not a function` (not yet exported) and `F.refine_tpgron` undefined.

- [ ] **Step 3: Add `typicalPixel` and the LTP row loop**

In `src/jbig2refine.ts`, add after `refineContext`:

```ts
/** TPGRON's typicality test (T.88 §6.3.5.6): where LTP is set, a pixel whose
 *  3x3 reference neighbourhood is uniform takes that value directly and is NOT
 *  decoded — it consumes no arithmetic decision. Anything else returns
 *  undefined and is decoded normally.
 *
 *  Note this is unlike TPGDON in jbig2generic.ts, which copies the row above:
 *  refinement's typicality is a property of the REFERENCE, not of the row. */
export function typicalPixel(ref: Bitmap, rx: number, ry: number): number | undefined {
  const first = px(ref, rx - 1, ry - 1);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) if (px(ref, rx + ox, ry + oy) !== first) return undefined;
  }
  return first;
}
```

Then replace `decodeRefinement`'s body loop with:

```ts
  const tpl = refineTemplate(prm.template, prm.at);
  const sltp = REFINE_REUSED_CONTEXTS[prm.template === 0 ? 0 : 1];
  let ltp = 0;
  for (let y = 0; y < prm.height; y++) {
    if (prm.tpgron) ltp ^= mq.decode(cx, sltp);
    for (let x = 0; x < prm.width; x++) {
      if (ltp) {
        const t = typicalPixel(prm.reference, x - prm.dx, y - prm.dy);
        if (t !== undefined) { bm.data[y * prm.width + x] = t; continue; }
      }
      bm.data[y * prm.width + x] = mq.decode(cx, refineContext(bm, prm.reference, tpl, x, y, prm.dx, prm.dy));
    }
  }
```

- [ ] **Step 4: Mirror TPGRON in the codec**

In `scripts/jbig2-codec.mjs`, add the typicality helper after `refineCtx`:

```js
function refineTypical(ref, rw, rh, rx, ry) {
  const first = gpx(ref, rw, rh, rx - 1, ry - 1);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (gpx(ref, rw, rh, rx + ox, ry + oy) !== first) return undefined;
  return first;
}
```

Give both refinement halves a trailing `tpgron` parameter. In `encodeRefinement`, replace the body loop with:

```js
  const tpl = refineTemplate(template, at);
  const sltp = REFINE_REUSED_CONTEXTS[template === 0 ? 0 : 1];
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgron) {
      // Set LTP for a row where every pixel is typical, so the row costs one
      // decision instead of w of them — which is the point of the mode, and
      // makes the vector actually exercise the typical path.
      let allTypical = true;
      for (let x = 0; x < w; x++) {
        const t = refineTypical(ref, rw, rh, x - dx, y - dy);
        if (t === undefined || t !== bm[y * w + x]) { allTypical = false; break; }
      }
      const want = allTypical ? 1 : 0;
      enc.encode(cx, sltp, ltp ^ want);
      ltp = want;
    }
    for (let x = 0; x < w; x++) {
      if (ltp) {
        const t = refineTypical(ref, rw, rh, x - dx, y - dy);
        if (t !== undefined) continue;
      }
      enc.encode(cx, refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy), bm[y * w + x]);
    }
  }
```

and give `decodeRefinement` the mirror of `src/jbig2refine.ts`'s loop. Update the two existing call sites in `scripts/mqenc.mjs` to pass `false`.

- [ ] **Step 5: Mint the TPGRON vector**

In `scripts/mqenc.mjs`'s refinement block, after the `for (const template of [0, 1])` loop, add:

```js
  const encT = new MqEncoder();
  encodeRefinement(encT, new Int8Array(1 << 13), target, RW, RH, refBm, RW, RH, 0, 0, 0, REF_AT, true);
  const bytesT = encT.flush();
  const gotT = refDecodeRefinement(new MqDecoder(bytesT, 0, bytesT.length), new Int8Array(1 << 13), RW, RH, refBm, RW, RH, 0, 0, 0, REF_AT, true);
  if (Buffer.compare(Buffer.from(gotT), Buffer.from(target)) !== 0) throw new Error('refinement TPGRON round-trip mismatch');
  if (bytesT.length >= vectors[0].bytes.length) throw new Error('TPGRON vector is no smaller than the plain one — the typical path is not being exercised');
```

That second guard is the important one: it fails the *generator* if TPGRON never actually takes the typical path, so the vector cannot silently degenerate into a plain refinement that would pass the decoder test whatever the LTP code does.

Add the export line to the written template:

```js
export const refine_tpgron = { bytes: b64(${JSON.stringify(b64(bytesT))}), width: ${RW}, height: ${RH}, refRows: ${JSON.stringify(rowsOf(refBm, RW, RH))}, rows: ${JSON.stringify(rowsOf(target, RW, RH))} };
```

Run:

```bash
node scripts/mqenc.mjs
```

Expected: `all round-trips OK`, no throw from either guard.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/jbig2-refine.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 7: Prove it load-bearing — two mutations**

1. **Never take the typical path** — in `decodeRefinement`, change `if (ltp)` to `if (false as boolean)`. Expected: the TPGRON round-trip case RED (the stream desynchronises, so the output is wrong from the first typical row onward). The two plain vectors stay green, since they decode with `tpgron: false`.
2. **Treat an out-of-bounds neighbour as matching** — in `typicalPixel`, start `first` from `px(ref, rx, ry)` instead of the corner. Expected: the "does not treat an edge of a uniform reference as typical" case RED.

Restore after each and confirm green.

- [ ] **Step 8: Commit**

```bash
git add src/jbig2refine.ts scripts/jbig2-codec.mjs scripts/mqenc.mjs test/helpers/jbig2-refine-vectors.ts test/jbig2-refine.test.ts
git commit -m "feat(utax.3): TPGRON typical prediction for refinement" -m "Per T.88 6.3.5.6 an LTP bit is decoded per row against the SLTP context, and where it is set a pixel whose 3x3 REFERENCE neighbourhood is uniform takes that value directly and consumes no arithmetic decision. Unlike TPGDON in jbig2generic.ts, which copies the row above, refinement's typicality is a property of the reference rather than of the row." -m "typicalPixel is pure and gets hand-computed expectations with no bitstream. The edge case is asserted separately: out-of-bounds reference pixels read as 0, so the corner of an all-ones reference is not typical, and getting that wrong sends the first and last row of every TPGRON region down the typical path and desynchronises the stream. The generator refuses to write a TPGRON vector that is no smaller than the plain one, so the fixture cannot silently stop exercising the path it exists for." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire segment types 40/42/43

**Files:**
- Modify: `src/jbig2.ts` — replace the `case 40: case 42: case 43:` throw (currently line 157)
- Modify: `scripts/gen-jbig2-fixtures.mjs` — two raw streams
- Regenerate: `test/helpers/jbig2-fixtures.ts`
- Modify: `test/jbig2-assembly.test.ts` — segment-level tests; drop 40/42/43 from the fence
- Modify: `test/jbig2-unsupported.test.ts` — its type-40 case is superseded
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: `decodeRefinement` and `RefineParams` from `src/jbig2refine.js`; `buffersBySeg`, `Buffered`, `parseRegionInfo`, `combine`, `s8` — all already in `src/jbig2.ts` from `utax.4`.
- Produces, all `Uint8Array` from `test/helpers/jbig2-fixtures.ts`: `refine_page_stream` (a type-38 generic region drawing the reference onto the page, then a type-42 refinement referring to nothing), `refine_buffer_stream` (the same region as type 36 intermediate, then a type-42 referring to it), `refine_samples` (the refined target's packed samples, shared by both), `refine_ref_samples` (the *un*refined reference's packed samples, used as the negative assertion), and `sbrefine_stream` (a text region with SBREFINE set, for the narrowed-refusal fence).

**The segment header (T.88 §7.4.7):** region info (17 bytes), then one flags byte — bit 0 is `GRTEMPLATE`, bit 1 is `TPGRON` — then, when `GRTEMPLATE` is 0, four bytes holding the two AT pixels as signed byte pairs. The arithmetic data follows.

**Reference selection (§7.4.7.2), which is the invariant:** if the referred-to set names an intermediate region we hold, that buffer is `GRREFERENCE` and `dx = dy = 0`. Otherwise the reference is **the page's current pixels under the region rectangle**, `dx = dy = 0`, and the result **replaces** them — the external combination operator does not apply to that case.

- [ ] **Step 1: Add the fixture streams**

In `scripts/gen-jbig2-fixtures.mjs`, add a region serializer beside the existing ones (after `textRegionData`, around line 44):

```js
function refinementRegionData(w, h, x, y, combOp, template, at, tpgron, arith) {
  const flags = (template & 1) | (tpgron ? 2 : 0);
  const out = [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, flags];
  if ((template & 1) === 0) for (const a of at) out.push(a.x & 0xff, a.y & 0xff);
  out.push(...arith);
  return out;
}
```

Extend the codec import list with `encodeRefinement`, and add after the intermediate-text stream:

```js
// Refinement fixtures. The target CLEARS two pixels the reference had set as
// well as adding three, so a decoder that combined instead of replacing cannot
// produce it — the cleared pixels would stay black.
const RFW = 16, RFH = 16;
const rfRef = new Uint8Array(RFW * RFH);
for (let y = 0; y < RFH; y++) for (let x = 0; x < RFW; x++)
  rfRef[y * RFW + x] = (x === 0 || y === 0 || x === RFW - 1 || y === RFH - 1) ? 1 : 0;
const rfTarget = Uint8Array.from(rfRef);
rfTarget[5 * RFW + 5] = 1; rfTarget[5 * RFW + 6] = 1; rfTarget[6 * RFW + 5] = 1;
rfTarget[0 * RFW + 8] = 0; rfTarget[15 * RFW + 8] = 0;
const REF_AT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];
function genRefineArith() {
  const e = new MqEncoder();
  encodeRefinement(e, new Int8Array(1 << 13), rfTarget, RFW, RFH, rfRef, RFW, RFH, 0, 0, 0, REF_AT, false);
  return Array.from(e.flush());
}
const refineArith = genRefineArith();
// The reference is drawn onto the PAGE by an immediate generic region, then
// refined in place by a type-42 segment referring to nothing.
const refineRefRegion = genericRegionData(RFW, RFH, 0, 0, 0, 0, AT0, true, (() => {
  const e = new MqEncoder(); encodeGeneric(e, new Int8Array(1 << 16), rfRef, RFW, RFH, 0, AT0, true); return Array.from(e.flush());
})());
const refinePageStream = Uint8Array.from([
  ...seg(0, 38, [], refineRefRegion),
  ...seg(1, 42, [], refinementRegionData(RFW, RFH, 0, 0, 0, 0, REF_AT, false, refineArith)),
]);
// The reference is an INTERMEDIATE generic region (type 36), invisible to the
// page, consumed by a type-42 segment that refers to it.
const refineBufferStream = Uint8Array.from([
  ...seg(0, 36, [], refineRefRegion),
  ...seg(1, 42, [0], refinementRegionData(RFW, RFH, 0, 0, 0, 0, REF_AT, false, refineArith)),
]);
const refineSamples = packInvert(rfTarget, RFW, RFH);
// Text region flags with SBREFINE (bit 1) set, for the narrowed-refusal fence.
// The body is an ordinary arithmetic text region and is never read: the refusal
// fires on the flag, before any decoding starts.
const sbrefineStream = Uint8Array.from([
  ...seg(0, 0, [], sdData),
  ...seg(1, 6, [0], textRegionData(TW, TH, 0, 0, 0, 0x12, 2, genTextArith())),
]);
```

and the export lines in the emitted template:

```js
export const refine_page_stream: Uint8Array = b64(${JSON.stringify(b64(refinePageStream))});
export const refine_buffer_stream: Uint8Array = b64(${JSON.stringify(b64(refineBufferStream))});
export const refine_samples: Uint8Array = b64(${JSON.stringify(b64(refineSamples))});
export const refine_ref_samples: Uint8Array = b64(${JSON.stringify(b64(packInvert(rfRef, RFW, RFH)))});
export const sbrefine_stream: Uint8Array = b64(${JSON.stringify(b64(sbrefineStream))});
```

Run and verify insertions only:

```bash
node scripts/gen-jbig2-fixtures.mjs
git diff test/helpers/jbig2-fixtures.ts | grep '^-' | grep -v '^---'; echo "(end)"
```

Expected: prints only `(end)`.

- [ ] **Step 2: Write the failing test**

In `test/jbig2-assembly.test.ts`, add to the existing `describe`:

```ts
  // T.88 §7.4.7.2: with no intermediate region in the referred-to set, the
  // reference is the page's own pixels under the rect and the result REPLACES
  // them — the external combination operator does not apply. The fixture's
  // target clears two pixels the reference had set, so an OR cannot produce it:
  // combining instead of replacing is the failure that hides, since refinement
  // output OR-ed onto its own input is more ink in roughly the right places.
  it('refines the page in place when no intermediate region is referred to', () => {
    const out = decodeJbig2(F.refine_page_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.refine_samples));
    expect(Array.from(out)).not.toEqual(Array.from(F.refine_ref_samples));
  });

  it('refines a referred-to intermediate region and composites the result', () => {
    const out = decodeJbig2(F.refine_buffer_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.refine_samples));
  });
```

Change the refusal fence's `it.each` list to drop 40, 42 and 43, leaving:

```ts
  it.each([
    [16, /pattern dictionary/i],
    [20, /halftone/i],
    [22, /halftone/i],
    [23, /halftone/i],
    [53, /segment type 53/i],
  ])('still refuses segment type %i by name', (type, message) => {
```

and add, immediately after it, the fence for what refinement still cannot do. It uses the generator-minted `sbrefine_stream` from Step 1 rather than patching a flag byte into `symtext_stream` by hand — a byte search into an arithmetic-coded stream is fragile and would silently stop finding the flag if the fixture ever moved:

```ts
  // Narrowed, not deleted: refinement REGIONS decode now, but refinement inside
  // a text region (SBREFINE) or a symbol dictionary (REFAGG) is utax.5.
  it('still refuses refinement inside a text region (SBREFINE)', () => {
    expect(() => decodeJbig2(F.sbrefine_stream, undefined, 12, 6)).toThrow(UnsupportedFeatureError);
    expect(() => decodeJbig2(F.sbrefine_stream, undefined, 12, 6)).toThrow(/SBREFINE|refinement/i);
  });
```

In `test/jbig2-unsupported.test.ts`, its type-40 case is superseded — a bare type-40 segment now reaches the region parser with a zero-length body. Replace that test with:

```ts
  it('rejects a truncated refinement region rather than decoding garbage', () => {
    expect(() => decodeJbig2(refinementStream(), undefined, 8, 8)).toThrow(PdfParseError);
  });
```

adding `PdfParseError` to that file's imports from `'../src/errors.js'`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/jbig2-assembly.test.ts test/jbig2-unsupported.test.ts`

Expected: the two refinement tests FAIL with `UnsupportedFeatureError: JBIG2: refinement region (segment type 42) not supported`; the truncated case FAILS with the same `UnsupportedFeatureError` where `PdfParseError` was expected; the SBREFINE case PASSES (that refusal already exists).

- [ ] **Step 4: Implement the segment case**

In `src/jbig2.ts`, add the import beside the others:

```ts
import { decodeRefinement } from './jbig2refine.js';
```

and replace the throw at line 157:

```ts
      case 40: case 42: case 43: throw new UnsupportedFeatureError(`JBIG2: refinement region (segment type ${h.type}) not supported`);
```

with:

```ts
      case 40: case 42: case 43: { // refinement region: 40 intermediate, 42/43 immediate (lossless)
        // 17-byte region info + 1 flags byte is the minimum; anything shorter is
        // a damaged file, and parsing on would build a bitmap out of undefined.
        if (h.dataLength < 18) throw new PdfParseError('JBIG2: truncated refinement region segment', h.dataStart);
        const ri = parseRegionInfo(src, h.dataStart);
        const flags = src[ri.bodyStart];
        const template = flags & 1;
        const tpgron = ((flags >> 1) & 1) !== 0;
        let o = ri.bodyStart + 1;
        const at: Array<{ x: number; y: number }> = [];
        if (template === 0) {
          for (let i = 0; i < 2; i++) { at.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
        // T.88 §7.4.7.2: an intermediate region in the referred-to set is the
        // reference. With none, the reference is the PAGE under the rect and the
        // result REPLACES it — the external combination operator does not apply.
        let reference: Bitmap | undefined;
        for (const r of h.referredTo) { const got = buffersBySeg.get(r); if (got) { reference = got.bitmap; break; } }
        const onPage = reference === undefined;
        // Branch on `reference === undefined`, not on `onPage` — TypeScript
        // narrows through the former and not through the latter, so using the
        // boolean here leaves `reference` as `Bitmap | undefined` at the call.
        if (reference === undefined) {
          const ref = newBitmap(ri.width, ri.height);
          for (let y = 0; y < ri.height; y++) {
            for (let x = 0; x < ri.width; x++) {
              ref.data[y * ri.width + x] = (ri.y + y < page.height && ri.x + x < page.width)
                ? page.data[(ri.y + y) * page.width + (ri.x + x)] : 0;
            }
          }
          reference = ref;
        }
        const bm = decodeRefinement(src, o, h.dataStart + h.dataLength,
          { width: ri.width, height: ri.height, reference, dx: 0, dy: 0, template, at, tpgron });
        if (h.type === 40) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, onPage ? 4 /* REPLACE */ : ri.combOp);
        break;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/jbig2-assembly.test.ts test/jbig2-unsupported.test.ts test/jbig2-refine.test.ts`

Expected: all PASS.

- [ ] **Step 6: Prove the replace-vs-combine rule load-bearing**

Change `onPage ? 4 : ri.combOp` to just `ri.combOp` — the plausible, wrong-looking-right implementation.

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: RED on "refines the page in place when no intermediate region is referred to", because the two cleared pixels stay black under OR. Restore and confirm green. Then also confirm the *other* refinement test stays green under that mutation — it must, since the buffer path legitimately uses `ri.combOp`, and that asymmetry is the whole point of the rule.

- [ ] **Step 7: Update the three documents**

`CLAUDE.md` — append to the `jbig2.ts` bullet, after the intermediate-region invariant added by `utax.4`:

```markdown
  **Invariant:** a refinement region (T.88 §6.3) whose referred-to set contains
  no intermediate region refines **the page itself** — the reference is the
  page's current pixels under the region rectangle, and the result **replaces**
  them. The region segment's external combination operator does not apply to
  that case; it does apply when a referred-to buffer supplied the reference.
  Combining instead of replacing is the failure that hides: refinement output
  OR-ed onto its own input is more ink in roughly the right places, which
  renders as a slightly bold page rather than as a fault, so the fixture's
  target CLEARS pixels the reference had set.
  **Invariant:** GRRD is arithmetic-only — T.88 defines no MMR refinement, which
  is why a Huffman text region has to alternate entropy coders within one stream
  rather than refining in its own coding.
  **Invariant:** `jbig2refine.ts` appends its AT pixels to the coding and
  reference lists and never sorts them, unlike `jbig2generic.ts`'s
  `buildTemplate`, which sorts the whole set by `(y, x)`. Bit order is invisible
  to a round trip — our encoder and decoder agree with each other whatever order
  we pick — so it is pinned instead by T.88's published SLTP constants
  (`0x0020`, `0x0008`), each of which is the context label for "every template
  pixel 0 except the reference pixel at `(0,0)`". Measured: sorting the AT
  pixels in leaves both round-trip vectors green and turns only that assertion
  red.
```

`README.md` line 1741 — replace:

```
MMR/Group-4 generic; halftone, pattern-dictionary, refinement, and Huffman-coded
JBIG2 throw `UnsupportedFeatureError`)
```

with:

```
MMR/Group-4 generic, and generic refinement regions; halftone,
pattern-dictionary, refinement *within* a symbol dictionary or text region
(REFAGG/SBREFINE), and Huffman-coded JBIG2 throw `UnsupportedFeatureError`)
```

`README.md` line 62 — replace `only its unsupported sub-features — halftone, pattern dictionary, refinement, Huffman — throw` with `only its unsupported sub-features — halftone, pattern dictionary, REFAGG/SBREFINE refinement, Huffman — throw`.

`CHANGELOG.md` — add at the top of the `### Added` list under `## [Unreleased]`:

```markdown
- **JBIG2 generic refinement regions decode** — segment types 40, 42 and 43 (ITU-T T.88 §6.3) no longer throw. Both templates are supported, with their adaptive-template pixels and TPGRON typical prediction, in a new leaf module that is pure over a bitmap and the MQ decoder — it takes the reference and its offset as arguments, so the one procedure will also serve the symbol-dictionary and text-region callers when those land. A refinement whose referred-to set names an intermediate region refines that buffer and composites the result with the segment's combination operator; one that names none refines **the page itself** and *replaces* the pixels under its rectangle, per §7.4.7.2 — the combination operator does not apply there, and OR-ing instead would render as a slightly bold page rather than as a fault, so the fixture's target clears pixels the reference had set. Refinement *within* a symbol dictionary (REFAGG) or a text region (SBREFINE) still refuses by name; that is the next child. The context bit order is anchored on T.88's published SLTP constants rather than on our own encoder, because a round trip cannot see a bit-order error — measured: sorting the adaptive pixels the way the generic-region template does leaves every round-trip vector green. (`utax.3`)
```

- [ ] **Step 8: Run both quality gates**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean, full suite green. Nothing outside `test/jbig2*` should move.

- [ ] **Step 9: Commit**

```bash
git add src/jbig2.ts scripts/gen-jbig2-fixtures.mjs test/helpers/jbig2-fixtures.ts test/jbig2-assembly.test.ts test/jbig2-unsupported.test.ts CHANGELOG.md CLAUDE.md README.md
git commit -m "feat(utax.3): wire refinement region segments 40/42/43" -m "T.88 7.4.7.2: an intermediate region in the referred-to set is the reference, and the result composites with the segment's own operator. With none, the reference is the PAGE under the rect and the result REPLACES it - the external combination operator does not apply there." -m "The fixture's target clears two pixels the reference had set as well as adding three, so an OR cannot produce it. Confirmed load-bearing: dropping the replace and using ri.combOp everywhere turns that one case red and leaves the buffer case green, which is the asymmetry the rule is about." -m "Narrowed, not deleted: REFAGG and SBREFINE still refuse by name until utax.5." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-utax.3 --reason "jbig2refine.ts: templates 0 and 1, context assembly, TPGRON, pure over Bitmap + MqDecoder with decodeGeneric's mqIn/cxIn shape so utax.5's two callers can share a stream. Segments 40/42/43 wired: referred buffer is the reference and composites with ri.combOp; no referred buffer means the page is the reference and the result REPLACES it. Bit order anchored on T.88's published SLTP constants because a round trip cannot see a bit-order error - measured, sorting the AT pixels leaves every vector green. REFAGG/SBREFINE still refuse by name."
```

Then follow the finishing-a-development-branch skill for integration.

---

## Notes for the executor

**The single most important thing in this child** is Task 1 Step 7, mutation 1. If sorting the AT pixels leaves the round-trip vectors green — and it should — that is the demonstration that this module's correctness rests on the SLTP anchor and not on the encoder. Do not skip it, and record the result.

**What the next child needs from this one.** `utax.5` calls `decodeRefinement` twice more, both times passing `mqIn`/`cxIn` from the enclosing decode and a *non-zero* `dx`/`dy` decoded as RDX/RDY. Nothing about the module should need to change; if it does, that is a signal the reference/offset seam was drawn in the wrong place.

**`dx`/`dy` are zero everywhere in this child**, so the offset arithmetic in `refineContext` and `typicalPixel` is written but not exercised by any fixture here. That is deliberate — inventing a segment-level fixture with a non-zero offset would test a shape T.88 does not produce for region segments — but it means `utax.5` is the first thing to actually exercise it. Say so in that child's plan rather than assuming it is covered.
