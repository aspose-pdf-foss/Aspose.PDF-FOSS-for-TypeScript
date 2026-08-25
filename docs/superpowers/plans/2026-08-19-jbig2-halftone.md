# JBIG2 halftone regions — pattern dictionaries, grayscale planes, placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Segment types 16 (pattern dictionary) and 20/22/23 (halftone region) stop throwing `UnsupportedFeatureError`. A halftone region decodes a **grayscale image** rather than a bitmap, looks each cell's value up in a pattern dictionary, and stamps the pattern onto a grid — so this child adds the one JBIG2 construct that is not a bilevel decode at all.

**Architecture:** One new leaf module, `src/jbig2halftone.ts`, pure over `Bitmap` and the two entropy stacks it is handed. Two requirements fall *outside* it and are the reason this child is sized "large": `decodeGeneric` gains an optional skip bitmap, and `ccitt.ts` gains an entry that reports bytes consumed. The latter is the only change this epic makes outside `src/jbig2*.ts`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies. Arithmetic vectors are minted by the dev-only encoder in `scripts/jbig2-codec.mjs` through `scripts/mqenc.mjs`; the MMR fixture is assembled in the test file itself from the existing `test/helpers/ccitt-encode.ts`, because that encoder already exists and is already pinned against golden bit strings — a second G4 encoder in `scripts/` would be a second reading of T.6.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 4 of 7 ("halftone"). Tracked as `aspose-pdf-foss-for-ts-utax.1`. Depends on `utax.4` (closed) for the lookup maps and the intermediate-region rule.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **`scripts/jbig2-codec.mjs` and `scripts/mqenc.mjs` are dev-only** — not shipped, imported by neither `src/` nor the tests.
- **Issue tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`.
- **Both quality gates must be green before the issue closes:** `npm run typecheck` and `npm test`.
- **This child narrows throws rather than deleting them.** After it, the only `UnsupportedFeatureError`s left in `src/jbig2*.ts` are the three Huffman ones — the symbol dictionary, the text region, and custom table segment 53 reaching `default:`. Pattern dictionary and halftone region come off the list entirely.
- **`decodeCcitt`'s existing signature does not change.** It has callers throughout the filter stack; the new entry is an addition, and `decodeCcitt` becomes a thin wrapper over it so the two cannot drift.
- **Prove every assertion load-bearing.** Break the path, watch the suite go red, restore.

## Background: what a halftone region actually is

Every other JBIG2 region decodes pixels. A halftone region decodes **numbers**. §6.6 lays a grid of `HGW × HGH` cells over the region, gives each cell an integer, and stamps the pattern with that index from a referred-to pattern dictionary. The integers arrive as `ceil(log2(HNUMPATS))` separate bitplanes — each one an ordinary generic region of `HGW × HGH` — Gray-coded and MSB first.

Three things in that sentence are the whole risk of this child, and none of them is visible to a round trip through our own encoder:

**1. The Gray-code fold (Annex C.5).** Planes are decoded MSB first and then folded downward, `plane[j] ^= plane[j+1]`. This is a *published* transform — the Gray sequence `00 01 11 10` means `0 1 2 3` — so it gets a hand-computed test with no bitstream at all, which is one of the anchors the design named.

**2. The grid vectors (§6.6.5.2).** A cell at `(mg, ng)` sits at

```
x = HGX + mg·HRY + ng·HRX
y = HGY + mg·HRX − ng·HRY
```

both `>> 8`, since the vectors are 8.8 fixed point. The **cross terms are why a transposed pair does not fail loudly**: swapping `HRX` and `HRY` renders the screen sheared or rotated, which reads as an unusual halftone rather than as a decode fault. `>>` also floors toward negative infinity where `| 0` truncates, so a negative `HGX` distinguishes them — the same trap `utax.5` recorded for `RDW >> 1`. Both are anchored by arithmetic over known inputs, no coded data.

**3. HENABLESKIP.** A cell whose stamp falls entirely outside the region is marked in `HSKIP`, and the pixel in **every bitplane** at that grid position is set to 0 *without being decoded* — it consumes no arithmetic decision. Implemented as a post-filter over a fully decoded plane it desynchronises the bitstream from the first skipped pixel onward, so the whole plane is wrong, and only for streams that set the flag.

The pattern dictionary itself (§6.7) is the simple half, with one detail worth naming: its collective bitmap is decoded with **AT1 pinned at `(−HDPW, 0)`**, which points at the same column of the *previous* pattern. That is a published constant and a transcription check rather than an independent decode — say so, do not oversell it.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/ccitt.ts` | modify | New `decodeCcittConsumed` returning `{ data, consumed }`; `decodeCcitt` becomes a wrapper over it. |
| `src/jbig2generic.ts` | modify | `GenericParams.skip`; the MMR branch is extracted as `decodeMmrBitmap`, which reports bytes consumed. |
| `src/jbig2halftone.ts` | create | Pattern dictionary (§6.7), grayscale planes (Annex C.5), halftone region placement (§6.6). |
| `src/jbig2.ts` | modify | Parse the two segment headers; `patternsBySeg`; segment 20 intermediate, 22/23 immediate. |
| `scripts/jbig2-codec.mjs` | modify | Skip support in `encodeGeneric`; pattern-dictionary, grayscale-plane and halftone encoders. |
| `scripts/mqenc.mjs` | modify | Two new vectors (plain and skip). |
| `test/helpers/jbig2-halftone-vectors.ts` | generated | Never hand-edited. |
| `scripts/gen-jbig2-fixtures.mjs` | modify | The end-to-end segment-16 + segment-22 stream. |
| `test/helpers/jbig2-fixtures.ts` | generated | Never hand-edited. |
| `test/jbig2-halftone.test.ts` | create | Anchors, vectors, the MMR case, the skip case. |
| `test/ccitt.test.ts` | modify | `decodeCcittConsumed`'s own test, per the issue: it does not get validated solely through a halftone fixture. |
| `test/jbig2-unsupported.test.ts` | modify | The halftone refusal fence inverts. |
| `CHANGELOG.md`, `CLAUDE.md`, `README.md` | modify | Halftone comes off the refusal list. |

**On module edges:** `jbig2halftone.ts` imports `jbig2.js` (for `Bitmap`/`newBitmap`/`combine`), `jbig2generic.js` and `jpxmq.js`. It is imported only by `jbig2.ts`. No cycle: `jbig2generic.ts` does not reach it.

---

### Task 1: `ccitt.ts` reports bytes consumed

**Files:**
- Modify: `src/ccitt.ts`
- Modify: `test/ccitt.test.ts`

**Interfaces:**
- Produces: `export interface CcittResult { data: Uint8Array; consumed: number }` and `export function decodeCcittConsumed(data: Uint8Array, p: CcittParams): CcittResult`.
- `decodeCcitt(data, p)` keeps its exact signature and becomes `decodeCcittConsumed(data, p).data`.

**Why this exists:** under HMMR the bitplanes are not separate streams. They are decoded consecutively from one MMR datastream with an EOFB between them, and `decodeCcitt` takes a byte range and returns an image with no way to say where it stopped.

- [ ] **Step 1: Write the failing test**

Add to `test/ccitt.test.ts`:

```ts
describe('decodeCcittConsumed', () => {
  const P = { k: -1, columns: 8, rows: 2, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: false };

  it('decodes two EOFB-terminated images from one buffer', () => {
    const a = [[1,1,1,1,0,0,0,0], [0,0,0,0,1,1,1,1]];
    const b = [[1,0,1,0,1,0,1,0], [0,1,0,1,0,1,0,1]];
    const ea = encodeG4(a, { eofb: true }), eb = encodeG4(b, { eofb: true });
    const both = new Uint8Array(ea.length + eb.length);
    both.set(ea, 0); both.set(eb, ea.length);

    const first = decodeCcittConsumed(both, P);
    expect(first.consumed).toBe(ea.length);
    const second = decodeCcittConsumed(both.subarray(first.consumed), P);
    // The second image comes back only because the first reported where it
    // stopped — this is the assertion the whole entry exists for.
    expect(Array.from(second.data)).toEqual(Array.from(decodeCcitt(eb, P)));
  });

  it('agrees with decodeCcitt on the pixels', () => { ... });
});
```

**The first assertion is the load-bearing one.** `consumed` equal to the whole buffer, or to the first image's length minus its EOFB, both leave the *second* decode reading from the wrong bit and producing something other than `b`.

- [ ] **Step 2: Implement**

In `src/ccitt.ts`, rename the body of `decodeCcitt` to `decodeCcittConsumed`, returning `{ data: merged, consumed }`. After the row loop, consume a trailing EOFB if one is there and round the bit position up to a byte:

```ts
/** Consume an EOFB (two EOLs) if one is next, restoring position if not. */
function tryEofb(br: BitReader): boolean {
  const start = br.tell();
  if (tryEol(br) && tryEol(br)) return true;
  br.seek(start);
  return false;
}
```

and at the end of the decode:

```ts
  // T.88 Annex C.5 packs every grayscale bitplane into ONE MMR datastream with
  // an EOFB between them, so the count must include the terminator. The next
  // plane is taken to start at the next BYTE — T.88 does not say so in as many
  // words, and no real-world fixture is available to settle it; recorded as an
  // assumption rather than as a fact.
  tryEofb(br);
  const consumed = Math.min(data.length, (br.tell() + 7) >> 3);
```

Note the row loop already breaks on an EOFB when `endOfBlock` is set, so `tryEofb` here is reached only when the loop ended on `rows` — which is every JBIG2 call, since they all pass an explicit height.

- [ ] **Step 3: Verify**

```bash
npx vitest run test/ccitt.test.ts test/ccitt-encode.test.ts test/filters.test.ts
```

- [ ] **Step 4: Prove it load-bearing**

Delete the `tryEofb(br)` call. Expected: the two-image test goes RED — the second decode starts three bytes early and reads the EOFB as image data. Restore.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(utax.1): a CCITT entry that reports bytes consumed" -m "T.88 Annex C.5 packs every grayscale bitplane into one MMR datastream with an EOFB between them, so a halftone region needs to know where each plane stopped. decodeCcitt keeps its signature and becomes a wrapper, so the two cannot drift. The only change this epic makes outside src/jbig2*.ts." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `decodeGeneric` gains a skip bitmap, and its MMR branch is extracted

**Files:**
- Modify: `src/jbig2generic.ts`
- Modify: `scripts/jbig2-codec.mjs` (the encoder half)

**Interfaces:**
- `GenericParams` gains `skip?: Bitmap`.
- Produces: `export function decodeMmrBitmap(data, start, end, width, height): { bitmap: Bitmap; consumed: number }`.

- [ ] **Step 1: Extract the MMR branch**

```ts
/** Decode one MMR-coded bitmap (T.88 §6.2.6), reporting bytes consumed. The
 *  count exists for Annex C.5's grayscale planes, which are packed into ONE
 *  datastream; decodeGeneric's mmr branch is this with the count dropped, so
 *  there is one place that knows how MMR bits become a Bitmap. */
export function decodeMmrBitmap(
  data: Uint8Array, start: number, end: number, width: number, height: number,
): { bitmap: Bitmap; consumed: number }
```

- [ ] **Step 2: Add the skip bitmap**

```ts
  /** HENABLESKIP's skip bitmap (T.88 §6.6.5.1), same dimensions as the region.
   *  A set pixel is 0 and is NOT decoded — it consumes no arithmetic decision,
   *  which is why this cannot be a post-filter: filtering afterwards leaves the
   *  stream desynchronised from the first skipped pixel onward. Arithmetic only;
   *  T.88 hands the skip bitmap to no MMR procedure, so the mmr branch ignores it. */
  skip?: Bitmap;
```

and in the inner loop, **before** the context is assembled:

```ts
      if (prm.skip !== undefined && prm.skip.data[y * prm.width + x]) { bm.data[y * prm.width + x] = 0; continue; }
```

- [ ] **Step 3: Encoder half**

In `scripts/jbig2-codec.mjs`, give `encodeGeneric` and its reference `decodeGeneric` a trailing `skip` argument with the same rule — skipped pixels are neither encoded nor decoded. Existing call sites pass nothing and must keep producing identical bytes.

- [ ] **Step 4: Verify nothing moved**

```bash
node scripts/mqenc.mjs && node scripts/gen-jbig2-fixtures.mjs && git diff --stat test/helpers/
```

Expected: **no** change to any generated helper. If one moves, the skip parameter has leaked into the default path — stop and fix it rather than regenerating.

```bash
npm run typecheck && npx vitest run test/jbig2-generic.test.ts test/jbig2.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(utax.1): skip bitmaps and an MMR entry that reports its length" -m "HENABLESKIP sets a pixel to 0 WITHOUT decoding it - a post-filter would desynchronise the arithmetic stream from the first skipped pixel onward. decodeMmrBitmap is decodeGeneric's mmr branch lifted out with the byte count kept, so the grayscale-plane decoder and the generic-region decoder share one reading of how MMR bits become a Bitmap." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `jbig2halftone.ts` — the pure module

**Files:**
- Create: `src/jbig2halftone.ts`
- Create: `test/jbig2-halftone.test.ts` (anchors only at this stage)

**Interfaces produced:**

```ts
export interface PatternDictParams {
  mmr: boolean; template: number;
  patternWidth: number; patternHeight: number; grayMax: number;
}
export function patternDictAt(patternWidth: number): Array<{ x: number; y: number }>;
export function decodePatternDict(data: Uint8Array, start: number, end: number, prm: PatternDictParams): Bitmap[];

/** The four fields cellOrigin needs, so the geometry is testable on its own. */
export interface HalftoneGrid { gridX: number; gridY: number; vectorX: number; vectorY: number }

export interface HalftoneParams extends HalftoneGrid {
  width: number; height: number;
  mmr: boolean; template: number; enableSkip: boolean; combOp: number; defPixel: number;
  gridWidth: number; gridHeight: number;   // HGW, HGH
  patterns: Bitmap[];
}
export function cellOrigin(g: HalftoneGrid, mg: number, ng: number): { x: number; y: number };
export function halftoneSkip(prm: HalftoneParams): Bitmap;
export function grayscaleValues(planes: Bitmap[], width: number, height: number): Int32Array;
export function decodeHalftoneRegion(data: Uint8Array, start: number, end: number, prm: HalftoneParams): Bitmap;
```

`grayscaleValues` takes the dimensions explicitly rather than reading `planes[0]`, because a one-pattern dictionary gives **zero** planes and the grid still has a size.

- [ ] **Step 1: Write the anchor tests first**

Create `test/jbig2-halftone.test.ts` with the tests that need no coded data. These are the anchors the design promised, and they are worth more than the round trip.

```ts
describe('jbig2 halftone grid geometry', () => {
  // T.88 §6.6.5.2. The cross terms are the whole point: a transposed vector
  // pair renders the screen rotated, which reads as an unusual halftone rather
  // than as a decode fault, so both axes are pinned with the other zeroed.
  const grid = (vectorX: number, vectorY: number, gridX = 0, gridY = 0) => ({ gridX, gridY, vectorX, vectorY });

  it('lays an axis-aligned screen out row by row', () => {
    const g = grid(256, 0); // one pel per column step, no shear
    expect(cellOrigin(g, 0, 3)).toEqual({ x: 3, y: 0 });
    expect(cellOrigin(g, 2, 0)).toEqual({ x: 0, y: 2 });
  });

  it('rotates when the vector pair is swapped', () => {
    const g = grid(0, 256);
    expect(cellOrigin(g, 0, 3)).toEqual({ x: 0, y: -3 });  // n drives -y
    expect(cellOrigin(g, 2, 0)).toEqual({ x: 2, y: 0 });   // m drives +x
  });

  // 8.8 fixed point, and `>>` floors toward negative infinity where `| 0`
  // truncates toward zero. Same trap utax.5 recorded for (RDW >> 1).
  it('floors a negative origin rather than truncating it', () => {
    expect(cellOrigin(grid(256, 0, -128, -128), 0, 0)).toEqual({ x: -1, y: -1 });
  });
});

describe('jbig2 grayscale plane assembly', () => {
  // Annex C.5 is Gray decoding, and the Gray sequence is published: 00 01 11 10
  // are 0 1 2 3. Hand-computed, no bitstream, no encoder of ours involved.
  it('folds two Gray-coded planes into the values they name', () => {
    const msb = fromRows(['0011']);
    const lsb = fromRows(['0110']);
    expect(Array.from(grayscaleValues([lsb, msb], 4, 1))).toEqual([0, 1, 2, 3]);
  });

  it('gives every cell pattern 0 when there are no planes at all', () => {
    // HNUMPATS == 1 gives ceil(log2(1)) == 0 planes, so the grid still has a
    // size and every cell names the only pattern there is.
    expect(Array.from(grayscaleValues([], 3, 1))).toEqual([0, 0, 0]);
  });
});
```

- [ ] **Step 2: The grid, the fold and the skip**

```ts
/** A cell's top-left corner in region pixels (T.88 §6.6.5.2). The grid vectors
 *  are 8.8 fixed point and the CROSS TERMS are load-bearing: swapping HRX and
 *  HRY renders the screen rotated, which reads as an unusual halftone rather
 *  than as a fault. `>>` floors toward negative infinity as T.88 requires;
 *  `| 0` truncates toward zero and differs for every negative origin. */
export function cellOrigin(g: HalftoneGrid, mg: number, ng: number): { x: number; y: number } {
  return {
    x: (g.gridX + mg * g.vectorY + ng * g.vectorX) >> 8,
    y: (g.gridY + mg * g.vectorX - ng * g.vectorY) >> 8,
  };
}
```

`grayscaleValues` carries the argument for applying the fold late:

> The fold is applied here, after every plane is decoded, rather than interleaved with the decoding the way C.5 writes it. That is exactly equivalent and not a shortcut: plane J is folded against the ALREADY-FOLDED plane J+1, and folding J changes nothing plane J's own arithmetic decode reads, since each plane is an independent generic region over its own pixels. Separating them is what makes this a pure function with a hand-computable expectation.

`halftoneSkip` is HGW × HGH, indexed `[mg * HGW + ng]`, set where `x + HPW <= 0 || x >= width || y + HPH <= 0 || y >= height`. Its test:

```ts
it('marks only the cells whose whole stamp misses the region', () => {
  // n=0 lands at x=-2 with a 2-wide pattern: entirely off. n=1 at x=0, n=2 at x=2.
  expect(Array.from(halftoneSkip({ ...base, gridWidth: 3, gridHeight: 1, gridX: -512, vectorX: 512 }).data))
    .toEqual([1, 0, 0]);
});
```

- [ ] **Step 3: The pattern dictionary**

```ts
/** The collective bitmap's adaptive-template pixels (T.88 §6.7.5). AT1 is
 *  pinned at (-HDPW, 0) — the same column of the PREVIOUS pattern, which is
 *  the correlation the collective layout exists to exploit; the other three are
 *  the nominal set. Published constants, so the test below is a transcription
 *  check and not an independent decode: a round trip cannot see this at all,
 *  because our encoder reads the same line of the spec. */
export function patternDictAt(patternWidth: number): Array<{ x: number; y: number }> {
  return [{ x: -patternWidth, y: 0 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];
}
```

`decodePatternDict` decodes ONE generic region `(grayMax + 1) * patternWidth` wide and `patternHeight` tall, TPGDON off, then slices it into `grayMax + 1` patterns by column.

Damage guards, all `PdfParseError`:
- `patternWidth <= 0 || patternHeight <= 0` — a zero-size pattern makes the collective bitmap degenerate and every stamp a no-op.
- the collective bitmap's pixel count. This is the one place in the format where a **product of three header fields** sizes an allocation, so unlike a single u32 region dimension it gets an explicit bound (`1 << 26` pixels) rather than being left to blow up as a `RangeError`. Say that in the comment — it is a damage guard, not a format limit.

- [ ] **Step 4: The halftone region**

```
1. region = newBitmap(width, height, defPixel)
2. patterns.length === 0 -> PdfParseError('JBIG2: halftone region refers to no pattern dictionary')
3. skip = enableSkip ? halftoneSkip(prm) : undefined
4. bpp: the integer loop `while ((1 << bpp) < patterns.length) bpp++`, NOT
   Math.ceil(Math.log2(n)) — the float form is exact for the powers of two that
   matter but the loop cannot be wrong, and this decides how many planes are read.
5. planes: bpp of them, MSB FIRST off the stream.
     arithmetic: one MqDecoder and one 2^16 context array shared by all of them.
     MMR: one datastream, decodeMmrBitmap per plane, offset advanced by `consumed`.
6. values = grayscaleValues(planes, gridWidth, gridHeight)   // planes[] indexed LSB-first
7. for mg, ng: skip -> continue; v clamped to patterns.length - 1;
   combine(region, patterns[v], ...cellOrigin(prm, mg, ng), combOp)
```

The value clamp is a damage guard: T.88 does not say what an out-of-range grayscale value means, and an unclamped index stamps `undefined`.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npx vitest run test/jbig2-halftone.test.ts
```

At this point only the anchor tests exist and they must all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(utax.1): jbig2halftone.ts - pattern dictionary, Gray planes, placement" -m "T.88 6.6, 6.7 and Annex C.5, pure over Bitmap and the decoders it is handed. The Gray-code fold and the grid geometry are tested with no coded data at all, which is the anchor the design named: an encoder written from one reading of T.88 shares that reading's mistakes, and both of these are published transforms our own encoder cannot vouch for." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Encoder halves and the round-trip vectors

**Files:**
- Modify: `scripts/jbig2-codec.mjs`, `scripts/mqenc.mjs`
- Generate: `test/helpers/jbig2-halftone-vectors.ts`
- Modify: `test/jbig2-halftone.test.ts`

- [ ] **Step 1: Encoder**

Add to `scripts/jbig2-codec.mjs`:

- `encodePatternDict(enc, cx, patterns, hdpw, hdph, template)` — assemble the collective bitmap and `encodeGeneric` it with the `(-hdpw, 0)` AT set.
- `encodeGrayscale(enc, cx, values, w, h, bpp, template, at, skip)` — split each value into its Gray code (`gray = v ^ (v >> 1)`), emit plane `bpp-1` first, then downward. **Assert in the generator that folding the Gray code back reproduces `v`**, so a wrong direction fails the generator rather than shipping a vector that agrees with a wrong decoder.

**There is deliberately no reference `decodeHalftoneRegion` in the codec.** Same decision `utax.5` recorded for REFAGG: the expected output is the KNOWN value grid the encoder was handed, so the check that matters happens between this `.mjs` encoder and the independently written `.ts` decoder — two implementations, rather than one file agreeing with itself.

- [ ] **Step 2: Choose the fixture geometry so the expectation is hand-derivable**

Set `HRX = 256 · HDPW`, `HRY = 0`, `HGX = HGY = 0`. The grid then tiles exactly: cell `(m, n)` lands at `(n·HDPW, m·HDPW)`, and the expected region bitmap is the value grid with each cell replaced by its pattern — derivable without a second copy of the placement code. The cross terms are covered by the `cellOrigin` anchors and deliberately *not* by this vector; the test says so.

Patterns: four 2×2 cells at gray levels 0..3 (0, 1, 2 and 4 dots). Grid 4×4 with the values arranged so every level appears and no row is uniform. Region 8×8.

- [ ] **Step 3: The skip vector**

Same shape with `HGX = -512` and a 5-wide grid, so column `n = 0` lands at `x = -2` with a 2-wide pattern and is entirely off the region. Encoder and decoder must both skip it.

**The generator asserts the vector is capable of proving anything:** fail the generator if `halftoneSkip`'s rule marks no cell, exactly as `mqenc.mjs` already fails when the TPGRON vector sets LTP on no row.

- [ ] **Step 4: Tests over the vectors**

```ts
it('decodes a halftone region', () => { ... });
it('decodes a halftone region with HENABLESKIP', () => { ... });
```

- [ ] **Step 5: Run, then prove load-bearing**

```bash
node scripts/mqenc.mjs && npx vitest run test/jbig2-halftone.test.ts
```

Three mutations, each expected RED, each restored:

1. **Skip as a post-filter.** Move the skip test in `decodeGeneric` out of the loop and zero the pixels afterwards. Expected: the skip vector goes red and the plain one stays green — that asymmetry is the point.
2. **Plane order.** Read the planes LSB first. Expected: the plain vector goes red.
3. **Drop the fold.** Expected: the plain vector goes red.

If a mutation stays green the fixture cannot see the rule; rebuild it and say so rather than moving on. In particular a value grid that happens to be Gray-invariant would survive mutation 3.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(utax.1): halftone round-trip vectors, plain and HENABLESKIP" -m "The expected output is the known value grid the encoder was handed rather than a reference decoder's opinion - the same decision utax.5 made for REFAGG, so the check runs between two independently written implementations. The fixture's grid vectors tile exactly, which makes its expectation hand-derivable; the cross terms are anchored by cellOrigin's own tests instead." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The MMR path

**Files:**
- Modify: `test/jbig2-halftone.test.ts`

The MMR fixture needs no arithmetic coder and therefore no generated vector: it is assembled in the test from `test/helpers/ccitt-encode.ts`, which already exists and is already pinned against golden bit strings by `test/ccitt-encode.test.ts`.

- [ ] **Step 1: The test**

```ts
it('decodes a halftone region whose planes come from ONE MMR datastream', () => {
  // Two Gray-coded planes, each EOFB-terminated, concatenated. This is the only
  // thing in the suite that exercises decodeCcittConsumed's byte count through a
  // JBIG2 decode: get it wrong and the second plane decodes from the middle of
  // the first one's terminator.
});
```

Build the pattern dictionary for this case with `mmr: true` as well, so the collective bitmap is MMR too — that is the segment-16 MMR path and nothing else covers it.

- [ ] **Step 2: Prove load-bearing**

Make the plane loop restart each plane at `start` instead of advancing by `consumed`. Expected: RED. (With a single-plane fixture it would stay green — check the fixture has at least two planes.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(utax.1): halftone planes under HMMR" -m "Annex C.5 packs every bitplane into one MMR datastream with an EOFB between them, which is what decodeCcittConsumed was added for. The fixture is assembled in the test from the existing G4 encoder rather than minted, because that encoder is already pinned against golden bit strings and a second one in scripts/ would be a second reading of T.6." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the two segment types into `decodeJbig2`

**Files:**
- Modify: `src/jbig2.ts`, `scripts/gen-jbig2-fixtures.mjs`
- Generate: `test/helpers/jbig2-fixtures.ts`
- Modify: `test/jbig2-halftone.test.ts`, `test/jbig2-unsupported.test.ts`

- [ ] **Step 1: `patternsBySeg`**

The third of the design's four maps:

```ts
  // Pattern dictionaries (type 16), keyed by segment number. A halftone region
  // resolves its patterns by KIND, so a reference to a symbol dictionary is a
  // lookup miss rather than a runtime type test.
  const patternsBySeg = new Map<number, Bitmap[]>();
```

- [ ] **Step 2: Segment 16**

Header per T.88 §7.4.4: 1 flags byte (bit 0 HDMMR, bits 1-2 HDTEMPLATE), 1 byte HDPW, 1 byte HDPH, 4 bytes GRAYMAX. Guard `dataLength < 7` with `PdfParseError`, the shape the refinement case already uses.

- [ ] **Step 3: Segments 20/22/23**

17-byte region info, then 1 flags byte (bit 0 HMMR, bits 1-2 HTEMPLATE, bit 3 HENABLESKIP, bits 4-6 HCOMBOP, bit 7 HDEFPIXEL), HGW, HGH (u32), HGX, HGY (**signed** 32), HRX, HRY (u16). Guard `dataLength < 38`.

**20 is the intermediate form: stored in `buffersBySeg`, never drawn.** Only 22/23 composite. That is `utax.4`'s invariant and it applies here unchanged — an orphan intermediate contributes nothing.

Add a signed-32 reader beside the existing `s8`:

```ts
/** Read a signed 32-bit big-endian value. HGX/HGY are signed (T.88 §7.4.5.1.2)
 *  and a grid may legitimately start off the left or top edge of its region. */
function s32(data: Uint8Array, o: number): number {
  return ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) | 0;
}
```

- [ ] **Step 4: End-to-end fixture**

In `scripts/gen-jbig2-fixtures.mjs`, add `halftone_stream` — segment 16 then segment 22 — plus `halftone_samples` from `packInvert` of the known region. Export an `intermediate_halftone_stream` too (type 20 in place of 22), for the invisible-to-the-page assertion.

- [ ] **Step 5: Invert the refusal fence**

`test/jbig2-unsupported.test.ts`'s halftone test asserts a refusal today. The bare type-22 header with a zero-length body is now a *damaged file* rather than an unsupported feature — it is shorter than the 38-byte minimum — so it must become a `PdfParseError` assertion, exactly as the refinement one did in `utax.3`. Keep the test; change what it expects and say why in a comment.

- [ ] **Step 6: End-to-end tests**

```ts
it('assembles a halftone region onto the page', () => {
  expect(Array.from(decodeJbig2(F.halftone_stream, undefined, 8, 8))).toEqual(Array.from(F.halftone_samples));
});

// utax.4's rule, unchanged: an intermediate region is held for a later segment
// to consume and is invisible to the page. Nothing consumes this one, so the
// page stays blank — which under packBitmap's inversion is all 0xff.
it('holds an intermediate halftone region off the page', () => {
  expect(Array.from(decodeJbig2(F.intermediate_halftone_stream, undefined, 8, 8)).every((b) => b === 0xff)).toBe(true);
});
```

- [ ] **Step 7: Verify everything**

```bash
node scripts/gen-jbig2-fixtures.mjs
npm run typecheck && npm test
```

- [ ] **Step 8: Prove the intermediate rule load-bearing**

Make `case 20` composite. Expected: the intermediate test goes RED. Restore.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(utax.1): wire pattern dictionaries and halftone regions" -m "Segment types 16 and 20/22/23 decode. patternsBySeg is the third of the design's four lookup maps, resolving by kind so a wrong-kind reference is a miss rather than a runtime type test. 20 is the intermediate form and stays off the page, per utax.4. HGX/HGY are SIGNED - a grid may legitimately start off the left or top edge of its region." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation and close

- [ ] **Step 1: `CLAUDE.md`**

Name `jbig2halftone.ts` in the rendering paragraph's module list and add these invariants:

```markdown
  **Invariant:** a halftone region decodes a GRAYSCALE image, not a bitmap
  (T.88 §6.6, Annex C.5): `ceil(log2(HNUMPATS))` bitplanes, each an ordinary
  generic region of HGW x HGH, all sharing one arithmetic decoder and one
  context set, MSB plane first, then Gray-folded downward. The fold is applied
  after every plane is decoded rather than interleaved as C.5 writes it — which
  is exactly equivalent, since plane J is folded against the already-folded
  plane J+1 and folding changes nothing plane J's own decode reads — and that is
  what makes `grayscaleValues` a pure function with a hand-computable
  expectation. The Gray sequence 00 01 11 10 meaning 0 1 2 3 is published, so it
  is one of the few things in this stack anchored outside our own encoder.
  **Invariant:** the grid vectors' CROSS TERMS are load-bearing. A cell sits at
  `x = HGX + mg·HRY + ng·HRX`, `y = HGY + mg·HRX − ng·HRY`, both `>> 8` since
  they are 8.8 fixed point. Transposing the pair renders the screen rotated,
  which reads as an unusual halftone rather than as a decode fault, so
  `cellOrigin` is pinned by arithmetic over known inputs with one vector zeroed
  at a time — the round-trip fixture deliberately uses an exactly-tiling grid
  and cannot see this. `>>` floors toward negative infinity where `| 0`
  truncates, and HGX/HGY are SIGNED, so a grid starting off the left edge
  distinguishes them.
  **Invariant:** HENABLESKIP sets a pixel to 0 WITHOUT decoding it — it consumes
  no arithmetic decision. As a post-filter over a fully decoded plane it
  desynchronises the bitstream from the first skipped pixel onward, so the whole
  plane is wrong, and only for streams that set the flag.
  **Invariant:** a pattern dictionary is ONE collective bitmap `(GRAYMAX+1)·HDPW`
  wide with AT1 pinned at `(-HDPW, 0)` — the same column of the previous
  pattern — sliced into patterns afterwards. The AT set is a published constant,
  so its test is a transcription check and NOT an independent decode: our
  encoder reads the same line of T.88.
  **Invariant:** under HMMR the bitplanes are ONE datastream with an EOFB
  between them, which is what `ccitt.ts`'s `decodeCcittConsumed` exists for —
  the only change this epic makes outside `src/jbig2*.ts`. `decodeCcitt` is a
  wrapper over it so the two cannot drift. Note the next plane is taken to begin
  at the next BYTE; T.88 does not say so in as many words and no real-world
  fixture is available to settle it, so it is recorded as an assumption.
```

- [ ] **Step 2: `README.md`**

Two places. The `Decode()` paragraph: halftone and pattern dictionary come off the refusal list, leaving Huffman alone. The rendering bullet's `/JBIG2Decode` parenthetical likewise.

- [ ] **Step 3: `CHANGELOG.md`**

One `### Added` entry at the top of `## [Unreleased]`, in the house style: what it does, why the design went that way, what was measured. Name the three things a round trip cannot see, and name what remains (Huffman alone).

- [ ] **Step 4: Final gates**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Close and push**

```bash
bd close aspose-pdf-foss-for-ts-utax.1 --reason "..."
git pull --rebase && git push && git status
```

---

## Notes for the executor

**The anchors matter more than the vectors here.** Two of this child's three risks — the Gray fold and the grid geometry — are *published transforms*, so unlike `utax.5` there genuinely is outside evidence available, and it costs no bitstream. Write those tests first. The round trip covers entropy coding and plane ordering and nothing else.

**The skip rule is the one that hides.** A skipped pixel that is decoded-then-zeroed produces a plausible image for the plane it starts in and garbage after, and no fixture without HENABLESKIP can see it at all. Mutation 1 in Task 4 Step 5 is the only proof.

**A halftone fixture is easy to build so that it proves nothing.** A uniform value grid survives the fold mutation, a single-plane grid survives the MMR offset mutation, an exactly-tiling grid cannot see the cross terms, and a grid entirely inside the region cannot see the skip rule. Each of those is a real trap; the geometry above is chosen against them, and where a vector deliberately does not cover something the test says so in its own comment.

**`decodeCcitt`'s byte-identity is a real fence.** It has callers throughout the filter stack. `npx vitest run test/ccitt.test.ts test/filters.test.ts` after Task 1, and the generated JBIG2 helpers not moving after Task 2, are both checks worth actually running rather than reasoning about.
