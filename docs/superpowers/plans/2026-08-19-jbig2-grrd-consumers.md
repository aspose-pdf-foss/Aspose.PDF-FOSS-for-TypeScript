# JBIG2 GRRD consumers — symbol-dict REFAGG and text-region SBREFINE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `decodeRefinement` into the two callers that live *inside* segment types we already handle — a text region with SBREFINE, and a symbol dictionary with REFAGG — so both stop throwing `UnsupportedFeatureError`.

**Architecture:** `utax.3` built `decodeRefinement` to take its reference and offset as arguments precisely so these two callers need no new decoding machinery. What they *do* need is a way to share one arithmetic decoder and one set of integer contexts with their enclosing decode, because T.88 has the symbol dictionary and its aggregate text region read from a single stream. That sharing is introduced as an explicit context bundle rather than as more optional parameters, and it is the shape `utax.6`'s `IntSource` will slot into.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies. Vectors are minted by the dev-only encoder in `scripts/jbig2-codec.mjs` through `scripts/mqenc.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 3 of 7 ("GRRD consumers"). Tracked as `aspose-pdf-foss-for-ts-utax.5`. Depends on `utax.3` (closed) for `decodeRefinement`, and on `utax.4` (closed) for the assembly loop.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **`scripts/jbig2-codec.mjs` and `scripts/mqenc.mjs` are dev-only** — not shipped, imported by neither `src/` nor the tests.
- **Issue tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`.
- **Both quality gates must be green before the issue closes:** `npm run typecheck` and `npm test`.
- **This child narrows throws rather than deleting them.** After it, the only `UnsupportedFeatureError`s left in `src/jbig2*.ts` are Huffman (symbol dictionary, text region, custom table segment 53), the pattern dictionary and the halftone region. The two refinement refusals go.
- **Prove every assertion load-bearing.** Break the path, watch the suite go red, restore.

## Background: three things that will not be caught by a round trip

`utax.3` established the general form of this hazard — a bijective relabelling of context bins is invisible to an encoder/decoder pair. This child has three *specific* instances, and unlike `utax.3` there is **no published constant to anchor any of them**. Each is therefore implemented to the letter of T.88, documented as unanchored, and given the sharpest test available.

**1. `symCodeLen` for the aggregate text region.** T.88 §6.5.8.2.3 makes it `ceil(log2(SDNUMINSYMS + SDNUMNEWSYMS))` — the dictionary's *declared total*, not the number of symbols decoded so far. Our encoder will use whatever our decoder uses, so a round trip passes on any consistent choice. Real-world encoders differ here (the `max(1, …)` question below), and getting it wrong misreads symbol IDs in files we did not write while every fixture stays green.

**2. The two offset rules are different, and both are plausible.** In a **text region** (§6.4.11.1) the reference offset is `(RDW >> 1) + RDX, (RDH >> 1) + RDY` — the half-delta re-centres the grown bitmap on the original. In a **symbol dictionary** with `REFAGGNINST == 1` (§6.5.8.2.2) it is plainly `RDX, RDY`, with no halving, because the refined symbol's size comes from the height class rather than from a delta. Using one rule in both places is a small, uniform misplacement that reads as bad rendering rather than as a decode fault.

**3. `>>` versus `/ 2`.** `RDW >> 1` is an arithmetic shift and floors toward negative infinity; `RDW / 2 | 0` truncates toward zero. They differ only for odd negative deltas, which is exactly the case a shrinking refinement produces. T.88 specifies floor.

Where an outside anchor is genuinely unavailable, the plan says so rather than implying the round trip covers it.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/jbig2arith.ts` | modify | Gains `TextIntCtx`, the bundle of integer contexts a text region needs — including the five refinement ones — so a symbol dictionary can hand its own bundle to an aggregate text region. |
| `src/jbig2text.ts` | modify | SBREFINE inside the strip walk; optional injection of decoder, context bundle and refinement context array. |
| `src/jbig2symbol.ts` | modify | REFAGG: the `REFAGGNINST == 1` refinement path and the `> 1` aggregate-text-region path. Gains an import of `jbig2text.js`. |
| `src/jbig2.ts` | modify | Parse `SBRTEMPLATE`/`SBRAT` and `SDRTEMPLATE`/`SDRAT` from the two segment headers; drop the two refusals. |
| `scripts/jbig2-codec.mjs` | modify | Encoder + reference-decoder halves for both paths. |
| `scripts/mqenc.mjs` | modify | Three new vectors. |
| `test/helpers/jbig2-refagg-vectors.ts` | generated | Never hand-edited. |
| `test/jbig2-refagg.test.ts` | create | Both consumers, plus the offset-rule assertions. |
| `test/jbig2-assembly.test.ts` | modify | The SBREFINE refusal fence inverts into a decode assertion. |
| `CHANGELOG.md`, `CLAUDE.md`, `README.md` | modify | Refinement comes fully off the refusal list. |

**On the new module edge:** `jbig2symbol.ts` will import `jbig2text.js`. That edge does not exist today and closes no cycle — `jbig2text.ts` imports only `jbig2.js`, `jbig2arith.js` and (after Task 1) `jbig2refine.js`, none of which reach `jbig2symbol.ts`.

**Why a context bundle rather than more optional parameters:** the aggregate text region shares *ten* integer contexts plus the IAID context plus the refinement context array with its enclosing dictionary. Threading eleven optionals through `decodeTextRegion` would be unreadable, and `utax.6` needs exactly this seam to swap the whole set for a Huffman implementation.

---

### Task 1: Text-region SBREFINE

**Files:**
- Modify: `src/jbig2arith.ts` (append `TextIntCtx`)
- Modify: `src/jbig2text.ts` (params, the strip walk's refinement branch)
- Modify: `src/jbig2.ts` (the `case 4: case 6: case 7:` header parse)
- Modify: `scripts/jbig2-codec.mjs`, `scripts/mqenc.mjs`
- Generate: `test/helpers/jbig2-refagg-vectors.ts`
- Create: `test/jbig2-refagg.test.ts`
- Modify: `test/jbig2-assembly.test.ts`

**Interfaces:**
- Consumes: `decodeRefinement`, `RefineParams` from `src/jbig2refine.js`; `IntCtx`, `IaidCtx`, `decodeInt`, `decodeIaid` from `src/jbig2arith.js`.
- Produces:
  - `export class TextIntCtx { readonly IADT; IAFS; IADS; IAIT; IARI; IARDW; IARDH; IARDX; IARDY: IntCtx; readonly IAID: IaidCtx; constructor(symCodeLen: number) }` in `src/jbig2arith.ts`.
  - `TextRegionParams` gains `refine: boolean`, `rTemplate: number`, `rAt: Array<{ x: number; y: number }>`.
  - `decodeTextRegion(data, start, end, p, mqIn?, ctxIn?, cxGRIn?)` — three new optional trailing parameters, used by Task 3 and by nothing else yet.
  - Vector `refine_text` from `test/helpers/jbig2-refagg-vectors.ts`, shape `{ bytes, width, height, numInstances, symbols: Array<{ w, h, data }>, rTemplate, rows }`.

- [ ] **Step 1: Add the context bundle**

Append to `src/jbig2arith.ts`:

```ts
/** The integer contexts one text region needs (T.88 §6.4). Bundled rather than
 *  passed individually because a symbol dictionary with REFAGG > 1 decodes an
 *  aggregate text region from its OWN stream and must share every one of them
 *  (§6.5.8.2.1) — eleven optional parameters would be unreadable, and this is
 *  the seam the Huffman implementation replaces wholesale. */
export class TextIntCtx {
  readonly IADT = new IntCtx(); readonly IAFS = new IntCtx(); readonly IADS = new IntCtx();
  readonly IAIT = new IntCtx(); readonly IARI = new IntCtx(); readonly IARDW = new IntCtx();
  readonly IARDH = new IntCtx(); readonly IARDX = new IntCtx(); readonly IARDY = new IntCtx();
  readonly IAID: IaidCtx;
  constructor(symCodeLen: number) { this.IAID = new IaidCtx(symCodeLen); }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/jbig2-refagg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeTextRegion } from '../src/jbig2text.js';
import type { Bitmap } from '../src/jbig2.js';
import * as F from './helpers/jbig2-refagg-vectors.js';

function rows(bm: Bitmap): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

const NOMINAL_RAT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];

describe('jbig2 text region with SBREFINE', () => {
  it('refines a symbol instance in place', () => {
    const v = F.refine_text;
    const bm = decodeTextRegion(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, numInstances: v.numInstances,
      symbols: v.symbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0,
      refine: true, rTemplate: v.rTemplate, rAt: NOMINAL_RAT,
    });
    expect(rows(bm)).toEqual(v.rows);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/jbig2-refagg.test.ts`

Expected: FAIL — the vector module does not exist yet and `TextRegionParams` has no `refine`.

- [ ] **Step 4: Implement SBREFINE in the strip walk**

Rewrite `src/jbig2text.ts`. Its `TextRegionParams` gains three fields and `decodeTextRegion` three optional trailing parameters:

```ts
export interface TextRegionParams {
  width: number; height: number; numInstances: number; symbols: Bitmap[];
  logStrips: number; refCorner: number; transposed: boolean; combOp: number;
  defPixel: number; dsOffset: number;
  /** SBREFINE (T.88 §6.4.11): each instance may carry a refinement. */
  refine: boolean;
  /** SBRTEMPLATE and SBRAT, read only when `refine` is set. */
  rTemplate: number; rAt: Array<{ x: number; y: number }>;
}
```

and the decode signature becomes:

```ts
export function decodeTextRegion(
  data: Uint8Array, start: number, end: number, p: TextRegionParams,
  mqIn?: MqDecoder, ctxIn?: TextIntCtx, cxGRIn?: Int8Array,
): Bitmap {
  const reg = newBitmap(p.width, p.height, p.defPixel);
  const strips = 1 << p.logStrips;
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, p.symbols.length))));
  const mq = mqIn ?? new MqDecoder(data, start, end);
  const ctx = ctxIn ?? new TextIntCtx(symCodeLen);
  // Allocated lazily: a region with refine off never touches it, and 8 KB per
  // text region on a page of hundreds is not free.
  const cxGR = cxGRIn ?? (p.refine ? new Int8Array(1 << 13) : undefined);
  let stripT = -(decodeInt(mq, ctx.IADT) ?? 0) * strips;
  let firstS = 0, inst = 0;
  while (inst < p.numInstances) {
    stripT += (decodeInt(mq, ctx.IADT) ?? 0) * strips;
    firstS += decodeInt(mq, ctx.IAFS) ?? 0;
    let curS = firstS, first = true;
    for (;;) {
      if (!first) { const ds = decodeInt(mq, ctx.IADS); if (ds === null) break; curS += ds + p.dsOffset; }
      first = false;
      const curT = stripT + (strips === 1 ? 0 : (decodeInt(mq, ctx.IAIT) ?? 0));
      const id = decodeIaid(mq, ctx.IAID, symCodeLen);
      let sym = p.symbols[id];
      // T.88 §6.4.11: with SBREFINE set, every instance carries an RI flag, and
      // a non-zero one replaces the symbol with a refinement of it.
      if (p.refine) {
        const ri = decodeInt(mq, ctx.IARI) ?? 0;
        if (ri !== 0 && sym) {
          const rdw = decodeInt(mq, ctx.IARDW) ?? 0;
          const rdh = decodeInt(mq, ctx.IARDH) ?? 0;
          const rdx = decodeInt(mq, ctx.IARDX) ?? 0;
          const rdy = decodeInt(mq, ctx.IARDY) ?? 0;
          // §6.4.11.1. The half-deltas re-centre the grown bitmap on the
          // original; `>>` floors toward negative infinity as T.88 requires,
          // where `/ 2 | 0` would truncate toward zero and differ for every odd
          // NEGATIVE delta — i.e. for a shrinking refinement.
          sym = decodeRefinement(data, start, end, {
            width: sym.width + rdw, height: sym.height + rdh, reference: sym,
            dx: (rdw >> 1) + rdx, dy: (rdh >> 1) + rdy,
            template: p.rTemplate, at: p.rAt, tpgron: false,
          }, mq, cxGR);
        }
      }
      if (sym) curS = place(reg, sym, curS, curT, p.refCorner, p.transposed, p.combOp);
      inst++;
      if (inst >= p.numInstances) break;
    }
  }
  return reg;
}
```

Update the imports at the top of the file:

```ts
import { MqDecoder } from './jpxmq.js';
import { TextIntCtx, decodeInt, decodeIaid } from './jbig2arith.js';
import { decodeRefinement } from './jbig2refine.js';
import { newBitmap, combine, type Bitmap } from './jbig2.js';
```

Note `IntCtx`/`IaidCtx` are no longer imported here — the bundle owns them.

**Careful:** `cxGR` is `Int8Array | undefined`, and `decodeRefinement`'s `cxIn` is `Int8Array | undefined`, so it passes through cleanly. When `p.refine` is false the branch never runs, so the undefined never reaches a decode.

- [ ] **Step 5: Encoder half**

In `scripts/jbig2-codec.mjs`, `encodeTextRegion` gains refinement. Replace it with:

```js
export function encodeTextRegion(enc, strips, symCodeLen, sbStrips, initialDt, refine, rTemplate, rAt, cxCommon) {
  const ctx = cxCommon ?? {
    IADT: new Int8Array(512), IAFS: new Int8Array(512), IADS: new Int8Array(512),
    IAIT: new Int8Array(512), IARI: new Int8Array(512), IARDW: new Int8Array(512),
    IARDH: new Int8Array(512), IARDX: new Int8Array(512), IARDY: new Int8Array(512),
    IAID: new Int8Array(1 << (symCodeLen + 1)), cxGR: new Int8Array(1 << 13),
  };
  const numInstances = strips.reduce((n, s) => n + s.syms.length, 0);
  encodeInt(enc, ctx.IADT, initialDt);
  let inst = 0;
  for (const strip of strips) {
    encodeInt(enc, ctx.IADT, strip.dt); encodeInt(enc, ctx.IAFS, strip.dfs);
    let first = true;
    for (const sym of strip.syms) {
      if (!first) encodeInt(enc, ctx.IADS, sym.ids);
      first = false;
      if (sbStrips !== 1) encodeInt(enc, ctx.IAIT, sym.curt);
      encodeIaid(enc, ctx.IAID, symCodeLen, sym.id);
      if (refine) {
        const ri = sym.refine ? 1 : 0;
        encodeInt(enc, ctx.IARI, ri);
        if (ri) {
          const r = sym.refine;
          encodeInt(enc, ctx.IARDW, r.rdw); encodeInt(enc, ctx.IARDH, r.rdh);
          encodeInt(enc, ctx.IARDX, r.rdx); encodeInt(enc, ctx.IARDY, r.rdy);
          encodeRefinement(enc, ctx.cxGR, r.target, r.w, r.h, r.ref, r.refW, r.refH,
            (r.rdw >> 1) + r.rdx, (r.rdh >> 1) + r.rdy, rTemplate, rAt, false);
        }
      }
      inst++;
      if (inst >= numInstances) return;
    }
    encodeInt(enc, ctx.IADS, null);
  }
}
```

and give `decodeTextRegion` (the reference half) the mirror — the same `ctx` bundle, the same `IARI`/`IARD*` reads, and `refDecodeRefinement` for the body — returning the placed region as before. The `sym.refine` descriptor carries `{ rdw, rdh, rdx, rdy, w, h, target, ref, refW, refH }`.

- [ ] **Step 6: Mint the vector**

In `scripts/mqenc.mjs`, before the final `console.log`, add:

```js
// ---- text region with SBREFINE ----------------------------------------------
// One instance is placed plain and one is refined: the refined symbol GROWS by
// one pixel in each direction (rdw/rdh = 1) and gains ink the base symbol does
// not have, so a decoder that ignored RI entirely would place the base symbol
// and produce a visibly different region.
{
  const base = { w: 4, h: 4, data: Uint8Array.from([
    1,1,1,1,
    1,0,0,1,
    1,0,0,1,
    1,1,1,1,
  ]) };
  const RW = 16, RH = 8, symCodeLen = 1;
  // The refined instance: 5x5, the box with its interior filled in.
  const refined = Uint8Array.from([
    1,1,1,1,1,
    1,1,1,1,0,
    1,1,1,1,0,
    1,1,1,1,0,
    1,1,1,1,0,
  ]);
  const RAT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];
  const strips = [{ dt: 1, dfs: 1, syms: [
    { id: 0, curt: 0 },
    { id: 0, curt: 0, ids: 4, refine: {
      rdw: 1, rdh: 1, rdx: 0, rdy: 0, w: 5, h: 5,
      target: refined, ref: base.data, refW: base.w, refH: base.h,
    } },
  ] }];
  const enc = new MqEncoder();
  encodeTextRegion(enc, strips, symCodeLen, 1, 0, true, 0, RAT);
  const bytes = enc.flush();
  const reg = refDecodeTextRegion(new MqDecoder(bytes, 0, bytes.length), RW, RH, 2,
    [base], symCodeLen, 1, 1, 0, 0, true, 0, RAT);
  const rowsOf = (bm, w, h) => { const r = []; for (let y = 0; y < h; y++) r.push(Array.from(bm.subarray(y * w, (y + 1) * w)).join('')); return r; };
  const out = rowsOf(reg, RW, RH);
  // Guard the FIXTURE, not the decoder: if the refined instance renders the same
  // as the base one, the vector proves nothing about RI.
  if (!out.join('').includes('11111')) throw new Error('SBREFINE vector: refined instance is not distinguishable from the base symbol');
  write('jbig2-refagg-vectors.ts', `// GENERATED by scripts/mqenc.mjs — do not edit by hand. Regenerate: node scripts/mqenc.mjs
/* eslint-disable */
function b64(s: string): Uint8Array { return Uint8Array.from(Buffer.from(s, "base64")); }
export const refine_text = {
  bytes: b64(${JSON.stringify(b64(bytes))}),
  width: ${RW}, height: ${RH}, numInstances: 2, rTemplate: 0,
  symbols: [{ w: ${base.w}, h: ${base.h}, data: ${JSON.stringify(Array.from(base.data))} }],
  rows: ${JSON.stringify(out)},
};
`);
}
```

Extend the import list in `scripts/mqenc.mjs` with `decodeTextRegion as refDecodeTextRegion` — note the existing unaliased `decodeTextRegion` import is used by the plain text-region vector and must keep working; alias the *new* usage only if the two signatures diverge, otherwise reuse the existing binding and drop the alias.

Run:

```bash
node scripts/mqenc.mjs
git diff test/helpers/jbig2-arith-vectors.ts test/helpers/jbig2-generic-vectors.ts test/helpers/jbig2-symbol-vectors.ts test/helpers/jbig2-text-vectors.ts test/helpers/jbig2-refine-vectors.ts
```

Expected: `all round-trips OK` and **no diff** on the five pre-existing vector files. `encodeTextRegion` gained parameters, so its existing call site must pass `false` for `refine` and keep producing identical bytes — if `jbig2-text-vectors.ts` moved, the refinement branch is leaking into the non-refine path.

- [ ] **Step 7: Parse SBRTEMPLATE and SBRAT in the segment header**

In `src/jbig2.ts`, in `case 4: case 6: case 7:`, replace the SBREFINE refusal and the fixed body offset:

```ts
        if (f & 1) throw new UnsupportedFeatureError('JBIG2: Huffman-coded text region not supported');
        if (f & 2) throw new UnsupportedFeatureError('JBIG2: refinement text region (SBREFINE) not supported');
        const logStrips = (f >> 2) & 3, refCorner = (f >> 4) & 3, transposed = ((f >> 6) & 1) !== 0;
        const combOp = (f >> 7) & 3, defPixel = (f >> 9) & 1;
        let dsOffset = (f >> 10) & 0x1f; if (dsOffset > 15) dsOffset -= 32;
        let o = ri.bodyStart + 2;
```

with:

```ts
        if (f & 1) throw new UnsupportedFeatureError('JBIG2: Huffman-coded text region not supported');
        const refine = (f & 2) !== 0;
        const logStrips = (f >> 2) & 3, refCorner = (f >> 4) & 3, transposed = ((f >> 6) & 1) !== 0;
        const combOp = (f >> 7) & 3, defPixel = (f >> 9) & 1;
        let dsOffset = (f >> 10) & 0x1f; if (dsOffset > 15) dsOffset -= 32;
        const rTemplate = (f >> 15) & 1;
        let o = ri.bodyStart + 2;
        // T.88 §7.4.3.1: SBRAT sits between the flags and SBNUMINSTANCES, and
        // only when refinement is on with template 0. Reading it in the wrong
        // order shifts SBNUMINSTANCES by four bytes.
        const rAt: Array<{ x: number; y: number }> = [];
        if (refine && rTemplate === 0) {
          for (let i = 0; i < 2; i++) { rAt.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
```

and add the three new fields to the `decodeTextRegion` call:

```ts
        const bm = decodeTextRegion(src, o, h.dataStart + h.dataLength, { width: ri.width, height: ri.height, numInstances, symbols, logStrips, refCorner, transposed, combOp, defPixel, dsOffset, refine, rTemplate, rAt });
```

- [ ] **Step 8: Invert the refusal fence**

The `sbrefine_stream` fixture built in `utax.3` sets the SBREFINE flag over a *plain* text-region body, which is no longer a valid stream now that the flag is honoured. Rebuild it as a real one in `scripts/gen-jbig2-fixtures.mjs`, using the same base symbol and refinement descriptor as Step 6's vector:

```js
// A text region with SBREFINE genuinely set: one plain instance and one refined.
// This is the only fixture that exercises the SBRAT header ordering — SBRAT sits
// between the flags and SBNUMINSTANCES, so reading it in the wrong order shifts
// the instance count by four bytes and the region decodes to nothing.
const sbrefineArith = (() => {
  const e = new MqEncoder();
  encodeTextRegion(e, sbrStrips, 1, 1, 0, true, 0, REF_AT);
  return Array.from(e.flush());
})();
function textRegionRefineData(w, h, x, y, combOp, sbFlags, at, numInstances, arith) {
  const out = [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, ...u16(sbFlags)];
  for (const a of at) out.push(a.x & 0xff, a.y & 0xff); // SBRAT, before SBNUMINSTANCES
  out.push(...u32(numInstances), ...arith);
  return out;
}
const sbrefineStream = Uint8Array.from([
  ...seg(0, 0, [], sbrSdData),
  ...seg(1, 6, [0], textRegionRefineData(16, 8, 0, 0, 0, 0x12, REF_AT, 2, sbrefineArith)),
]);
```

with `sbrStrips` and `sbrSdData` built from the same 4×4 box symbol, and export `sbrefine_samples` alongside. Then in `test/jbig2-assembly.test.ts` replace the refusal test with:

```ts
  // SBREFINE decodes as of utax.5. This is the only test that fences the SBRAT
  // header ordering: it sits between the text-region flags and SBNUMINSTANCES,
  // so reading it late shifts the instance count by four bytes.
  it('decodes a text region with SBREFINE set', () => {
    const out = decodeJbig2(F.sbrefine_stream, undefined, 16, 8);
    expect(Array.from(out)).toEqual(Array.from(F.sbrefine_samples));
  });
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/jbig2-refagg.test.ts test/jbig2-assembly.test.ts test/jbig2-text.test.ts`

Expected: all PASS. `test/jbig2-text.test.ts` exercises the non-refine path and must be untouched — its two call sites need `refine: false, rTemplate: 0, rAt: []` added.

- [ ] **Step 10: Prove it load-bearing — two mutations**

1. **Ignore RI** — in `decodeTextRegion`, change `if (ri !== 0 && sym)` to `if (false as boolean)`. Expected: RED on "refines a symbol instance in place". This is the mutation that matters: it also desynchronises the stream, since the refinement's decisions are still in it.
2. **Truncate instead of floor** — change `(rdw >> 1) + rdx` to `((rdw / 2) | 0) + rdx` and the same for `rdh`. Expected: **GREEN**, because the fixture's deltas are positive and the two agree there. Record that: it means the floor rule is *not* covered by this vector. Either add a vector with an odd negative delta or state plainly in the test file that the rule is unanchored.

- [ ] **Step 11: Commit**

```bash
git add src/jbig2arith.ts src/jbig2text.ts src/jbig2.ts scripts/jbig2-codec.mjs scripts/mqenc.mjs test/helpers/jbig2-refagg-vectors.ts test/jbig2-refagg.test.ts test/jbig2-assembly.test.ts test/jbig2-text.test.ts
git commit -m "feat(utax.5): text-region SBREFINE" -m "T.88 6.4.11: with SBREFINE set every instance carries an RI flag, and a non-zero one replaces the symbol with a refinement of it, sized by RDW/RDH and offset by (RDW>>1)+RDX, (RDH>>1)+RDY." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Symbol-dictionary REFAGG with `REFAGGNINST == 1`

**Files:**
- Modify: `src/jbig2symbol.ts`, `src/jbig2.ts`, `scripts/jbig2-codec.mjs`, `scripts/mqenc.mjs`
- Regenerate: `test/helpers/jbig2-refagg-vectors.ts`
- Modify: `test/jbig2-refagg.test.ts`

**Interfaces:**
- Consumes: `decodeRefinement`; `TextIntCtx` is *not* needed here — the single-instance path uses the dictionary's own contexts.
- Produces: `SymbolDictParams` gains `rTemplate: number` and `rAt: Array<{ x: number; y: number }>`. Vector `refagg_one` from `test/helpers/jbig2-refagg-vectors.ts`, shape `{ bytes, numNewSyms, numExSyms, inputSymbols, rTemplate, sizes, syms }`.

- [ ] **Step 1: Write the failing test**

Add to `test/jbig2-refagg.test.ts`:

```ts
import { decodeSymbolDict } from '../src/jbig2symbol.js';

describe('jbig2 symbol dictionary with REFAGG', () => {
  it('refines an existing symbol when REFAGGNINST is 1', () => {
    const v = F.refagg_one;
    const out = decodeSymbolDict(v.bytes, 0, v.bytes.length, {
      huffman: false, refAgg: true, template: 0,
      at: [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }],
      numExSyms: v.numExSyms, numNewSyms: v.numNewSyms,
      inputSymbols: v.inputSymbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      rTemplate: v.rTemplate, rAt: [{ x: -1, y: -1 }, { x: -1, y: -1 }],
    });
    expect(out.map((s) => [s.width, s.height])).toEqual(v.sizes);
    expect(out.map((s) => Array.from(s.data))).toEqual(v.syms);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/jbig2-refagg.test.ts`

Expected: FAIL — `F.refagg_one` undefined, and `decodeSymbolDict` still throws on `refAgg`.

- [ ] **Step 3: Implement the single-instance path**

In `src/jbig2symbol.ts`, extend the params:

```ts
export interface SymbolDictParams {
  huffman: boolean; refAgg: boolean; template: number; at: Array<{ x: number; y: number }>;
  numExSyms: number; numNewSyms: number; inputSymbols: Bitmap[];
  /** SDRTEMPLATE and SDRAT, read only when `refAgg` is set. */
  rTemplate: number; rAt: Array<{ x: number; y: number }>;
}
```

Drop the `refAgg` refusal, add the contexts and the branch:

```ts
  if (p.huffman) throw new UnsupportedFeatureError('JBIG2: Huffman-coded symbol dictionary not supported');
  const mq = new MqDecoder(data, start, end);
  const cxGB = new Int8Array(1 << 16);
  const IADH = new IntCtx(), IADW = new IntCtx(), IAEX = new IntCtx();
  const IAAI = new IntCtx(), IARDX = new IntCtx(), IARDY = new IntCtx();
  // T.88 §6.5.8.2.3: the ID width comes from the dictionary's DECLARED total,
  // not from how many symbols have been decoded so far.
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, p.inputSymbols.length + p.numNewSyms))));
  const IAID = new IaidCtx(symCodeLen);
  const cxGR = p.refAgg ? new Int8Array(1 << 13) : undefined;
```

and inside the width loop, replace the unconditional `decodeGeneric` with:

```ts
      let bm: Bitmap;
      if (p.refAgg) {
        const nInst = decodeInt(mq, IAAI);
        if (nInst === null) throw new PdfParseError('JBIG2: symbol dictionary REFAGGNINST OOB');
        if (nInst === 1) {
          // §6.5.8.2.2. Note the offsets are RDX/RDY PLAIN — no half-delta, unlike
          // the text region's §6.4.11.1, because the refined symbol's size comes
          // from the height class rather than from a decoded delta.
          const id = decodeIaid(mq, IAID, symCodeLen);
          const rdx = decodeInt(mq, IARDX) ?? 0;
          const rdy = decodeInt(mq, IARDY) ?? 0;
          const ref = [...p.inputSymbols, ...newSyms][id];
          if (!ref) throw new PdfParseError('JBIG2: symbol dictionary REFAGG reference out of range');
          bm = decodeRefinement(data, start, end, {
            width: symWidth, height: hcHeight, reference: ref, dx: rdx, dy: rdy,
            template: p.rTemplate, at: p.rAt, tpgron: false,
          }, mq, cxGR);
        } else {
          throw new UnsupportedFeatureError('JBIG2: aggregate symbol dictionary (REFAGGNINST > 1) not supported');
        }
      } else {
        bm = decodeGeneric(data, start, end,
          { width: symWidth, height: hcHeight, template: p.template, at: p.at, tpgdon: false, mmr: false }, mq, cxGB);
      }
      newSyms.push(bm);
```

Task 3 replaces that inner throw. Add `decodeRefinement`, `IaidCtx`, `decodeIaid` to the imports.

- [ ] **Step 4: Parse SDRTEMPLATE and SDRAT**

In `src/jbig2.ts`, `case 0:`, after the `at` loop and before `numExSyms`:

```ts
        const rTemplate = (flags >> 12) & 1;
        // T.88 §7.4.4.1: SDRAT sits between SDAT and SDNUMEXSYMS.
        const rAt: Array<{ x: number; y: number }> = [];
        if (refAgg && rTemplate === 0) {
          for (let i = 0; i < 2; i++) { rAt.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
```

and pass `rTemplate, rAt` into `decodeSymbolDict`.

- [ ] **Step 5: Encoder half and vector**

In `scripts/jbig2-codec.mjs`, `encodeSymbolDict` gains a REFAGG mode. Rather than complicate the existing signature, add a sibling:

```js
export function encodeSymbolDictRefagg(enc, inputSyms, newSyms, rTemplate, rAt) {
  const IADH = new Int8Array(512), IADW = new Int8Array(512), IAEX = new Int8Array(512);
  const IAAI = new Int8Array(512), IARDX = new Int8Array(512), IARDY = new Int8Array(512);
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, inputSyms.length + newSyms.length))));
  const IAID = new Int8Array(1 << (symCodeLen + 1));
  const cxGR = new Int8Array(1 << 13);
  const all = [...inputSyms];
  let hcHeight = 0;
  // newSyms must already be grouped by ascending height, as encodeSymbolDict does.
  const classes = [];
  for (const s of newSyms) {
    const last = classes[classes.length - 1];
    if (last && last.h === s.h) last.items.push(s); else classes.push({ h: s.h, items: [s] });
  }
  for (const cls of classes) {
    encodeInt(enc, IADH, cls.h - hcHeight); hcHeight = cls.h;
    let symWidth = 0;
    for (const s of cls.items) {
      encodeInt(enc, IADW, s.w - symWidth); symWidth = s.w;
      encodeInt(enc, IAAI, 1);
      encodeIaid(enc, IAID, symCodeLen, s.refId);
      encodeInt(enc, IARDX, s.rdx); encodeInt(enc, IARDY, s.rdy);
      const ref = all[s.refId];
      encodeRefinement(enc, cxGR, s.data, s.w, s.h, ref.data, ref.w, ref.h, s.rdx, s.rdy, rTemplate, rAt, false);
      all.push(s);
    }
    encodeInt(enc, IADW, null);
  }
  encodeInt(enc, IAEX, inputSyms.length);
  encodeInt(enc, IAEX, newSyms.length);
}
```

Note the export runs: skip the input symbols, export the new ones — so `numExSyms` is `newSyms.length`. Add the mirror reference decoder, then mint `refagg_one` in `scripts/mqenc.mjs` with one input symbol (a 4×4 box) and one new symbol that refines it into a filled 4×4, round-tripping before writing.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/jbig2-refagg.test.ts`

Expected: PASS.

- [ ] **Step 7: Prove the offset rule load-bearing**

Change the single-instance offsets from `dx: rdx, dy: rdy` to the text-region rule — there is no RDW/RDH here, so use `dx: (symWidth >> 1) + rdx`. Expected: RED. Restore. Then run the *text region* test too and confirm it is unaffected: the two rules being different is the point, and a test that goes red for both means they are not actually independent.

- [ ] **Step 8: Commit**

```bash
git add src/jbig2symbol.ts src/jbig2.ts scripts/jbig2-codec.mjs scripts/mqenc.mjs test/helpers/jbig2-refagg-vectors.ts test/jbig2-refagg.test.ts
git commit -m "feat(utax.5): symbol-dictionary REFAGG with REFAGGNINST 1" -m "T.88 6.5.8.2.2: a single-instance aggregate refines an existing symbol, with the offsets taken PLAIN from RDX/RDY - no half-delta, unlike the text region's 6.4.11.1, because the refined symbol's size comes from the height class rather than from a decoded delta." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Symbol-dictionary REFAGG with `REFAGGNINST > 1`

**Files:**
- Modify: `src/jbig2symbol.ts` (the aggregate branch), `scripts/jbig2-codec.mjs`, `scripts/mqenc.mjs`
- Regenerate: `test/helpers/jbig2-refagg-vectors.ts`
- Modify: `test/jbig2-refagg.test.ts`
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: `decodeTextRegion` and `TextIntCtx` — this is the edge `jbig2symbol.ts → jbig2text.ts` the spec predicted.
- Produces: vector `refagg_many`, same shape as `refagg_one`.

- [ ] **Step 1: Write the failing test**

Add to `test/jbig2-refagg.test.ts` a case mirroring `refagg_one` but using `F.refagg_many`, whose one new symbol is built from **two** instances of the input symbols placed side by side.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL with `UnsupportedFeatureError: JBIG2: aggregate symbol dictionary (REFAGGNINST > 1) not supported`.

- [ ] **Step 3: Implement the aggregate path**

Replace the inner throw in `src/jbig2symbol.ts` with a text-region decode over the dictionary's current symbols, sharing the stream:

```ts
        } else {
          // §6.5.8.2.1: more than one instance is decoded as a TEXT REGION over
          // the dictionary's current symbols, sharing this stream and these
          // contexts. The parameters are fixed by the spec, not read from
          // anywhere: one strip, TOPLEFT, OR, no transpose, no offset.
          textCtx ??= new TextIntCtx(symCodeLen);
          bm = decodeTextRegion(data, start, end, {
            width: symWidth, height: hcHeight, numInstances: nInst,
            symbols: [...p.inputSymbols, ...newSyms],
            logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
            defPixel: 0, dsOffset: 0,
            refine: true, rTemplate: p.rTemplate, rAt: p.rAt,
          }, mq, textCtx, cxGR);
        }
```

with `let textCtx: TextIntCtx | undefined;` declared beside the other contexts.

**Invariant to record:** the aggregate text region's `symCodeLen` must be the dictionary's — `ceil(log2(SDNUMINSYMS + SDNUMNEWSYMS))` — not `decodeTextRegion`'s own derivation from `symbols.length`, which is the count decoded *so far* and grows as the dictionary is built. `decodeTextRegion` computes `symCodeLen` internally from `p.symbols.length`, so this is a real conflict and must be resolved: give `TextRegionParams` an optional `symCodeLen` override and pass the dictionary's.

- [ ] **Step 4: Add the `symCodeLen` override**

In `src/jbig2text.ts`:

```ts
  /** Overrides the derivation from `symbols.length`. A symbol dictionary's
   *  aggregate text region (§6.5.8.2.3) sizes IDs by the dictionary's DECLARED
   *  total, which is larger than the number of symbols decoded so far — deriving
   *  it here instead reads every symbol ID at the wrong width. */
  symCodeLen?: number;
```

and `const symCodeLen = p.symCodeLen ?? Math.max(1, Math.ceil(Math.log2(Math.max(1, p.symbols.length))));`

- [ ] **Step 5: Encoder half and vector**

Extend `encodeSymbolDictRefagg` to emit `REFAGGNINST > 1` by calling `encodeTextRegion` with the shared context bundle, and mint `refagg_many`. The new symbol must be **wider than either input symbol** so that two placed instances are visibly two instances.

- [ ] **Step 6: Run to verify it passes, then run everything**

```bash
npx vitest run test/jbig2-refagg.test.ts
npm run typecheck
npm test
```

- [ ] **Step 7: Prove it load-bearing**

Change the aggregate call to omit `symCodeLen` (letting `decodeTextRegion` derive it). Expected: RED whenever `inputSymbols.length + numNewSyms` and `symbols.length` fall in different `ceil(log2(...))` buckets — **choose the fixture's symbol counts so that they do**, e.g. 2 input + 1 new (total 3 → 2 bits) with 2 decoded so far (→ 1 bit). If it stays green, the fixture cannot see the rule and must be rebuilt; say so rather than moving on.

- [ ] **Step 8: Documentation**

`CLAUDE.md` — append to the `jbig2.ts` bullet:

```markdown
  **Invariant:** the two GRRD offset rules are DIFFERENT and both are plausible.
  A text region (§6.4.11.1) offsets by `(RDW >> 1) + RDX, (RDH >> 1) + RDY` — the
  half-delta re-centres the grown bitmap on the original — while a symbol
  dictionary with `REFAGGNINST == 1` (§6.5.8.2.2) offsets by RDX/RDY plain,
  because the refined symbol's size comes from the height class rather than from
  a decoded delta. Using one rule in both places is a small uniform
  misplacement that reads as bad rendering rather than as a decode fault. Note
  `>>` floors toward negative infinity as T.88 requires; `/ 2 | 0` truncates
  toward zero and differs for every odd NEGATIVE delta, i.e. for a shrinking
  refinement.
  **Invariant:** an aggregate text region's `symCodeLen` is the DICTIONARY's
  declared total (`SDNUMINSYMS + SDNUMNEWSYMS`, §6.5.8.2.3), never the number of
  symbols decoded so far. `decodeTextRegion` derives it from `symbols.length` for
  a standalone region, which is why `TextRegionParams.symCodeLen` exists as an
  override — without it every symbol ID inside an aggregate is read at the wrong
  width once the dictionary grows past a power of two.
  **Note, recorded as unanchored:** none of the three rules above has a published
  constant to check against the way §6.3's SLTP constants pin the refinement
  context order, and our encoder shares our reading of all three. They are
  implemented to the letter of T.88 and fenced by fixtures chosen to straddle the
  boundary each rule turns on; do not read the green suite as independent
  confirmation.
```

`README.md` — refinement comes fully off the refusal list: the JBIG2 sentence becomes `...plus MMR/Group-4 generic, generic refinement regions, and refinement within symbol dictionaries and text regions (REFAGG/SBREFINE); halftone, pattern-dictionary and Huffman-coded JBIG2 throw...`, and the rendering bullet's list drops `REFAGG/SBREFINE refinement`.

`CHANGELOG.md` — one `### Added` entry naming both consumers, the two different offset rules, and the `symCodeLen` rule.

- [ ] **Step 9: Commit and close**

```bash
git add -A
git commit -m "feat(utax.5): aggregate symbol dictionaries (REFAGGNINST > 1)" -m "T.88 6.5.8.2.1 decodes more than one instance as a text region over the dictionary's current symbols, sharing its stream and contexts - the jbig2symbol.ts -> jbig2text.ts edge the design predicted. Its symCodeLen is the dictionary's declared total, not the count decoded so far, which is what TextRegionParams.symCodeLen exists to override." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-utax.5 --reason "Text-region SBREFINE and symbol-dictionary REFAGG both decode, at both REFAGGNINST 1 and > 1. TextIntCtx bundles the eleven contexts a text region needs so a dictionary's aggregate region can share its stream - the jbig2symbol.ts -> jbig2text.ts edge the design predicted, closing no cycle. Three rules here have NO published constant to anchor them, unlike utax.3's SLTP: the two different offset rules (text region halves RDW/RDH, symbol dictionary does not), floor-versus-truncate on the half-delta, and the aggregate symCodeLen coming from the dictionary's declared total rather than the count decoded so far. Each is implemented to the letter of T.88 and fenced by a fixture chosen to straddle the boundary it turns on; the green suite is not independent confirmation."
```

---

## Notes for the executor

**This child is where `dx`/`dy` first get exercised.** `utax.3` wrote the offset arithmetic in `refineContext` and `typicalPixel` but no fixture there used a non-zero offset. Both fixtures here should, and if they do not, say so.

**The three unanchored rules are the risk.** `utax.3` had T.88's SLTP constants; this child has nothing equivalent. The mitigation is fixture *design* — Task 3 Step 7 in particular, where the symbol counts must straddle a `ceil(log2(...))` boundary or the test cannot see the rule at all. Treat a green-on-first-run test here as unproven until its mutation has been run.

**`encodeTextRegion`'s signature grows in Task 1** and its existing call site must keep producing identical bytes. `test/helpers/jbig2-text-vectors.ts` not moving is the check, and it is a real one.
