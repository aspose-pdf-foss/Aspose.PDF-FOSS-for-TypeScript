# JBIG2 page assembly and intermediate regions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `decodeJbig2` hold an intermediate region segment for a later segment to consume instead of compositing it onto the page, and stop refusing the profiles segment — the prerequisite every other child of the `utax` epic builds on.

**Architecture:** `src/jbig2.ts` keeps its shape: one `switch` over segment types, header parsing here and body decoding in the `jbig2*.ts` bodies. Two things change inside it. A second lookup map, `buffersBySeg: Map<number, Buffered>`, joins `symbolsBySeg`, and the two region cases that today composite unconditionally learn to branch on their own segment type — the intermediate form (4, 36) stores, the immediate forms (6/7, 38/39) draw. Type 52 joins the `case 48: … break;` skip line. No new module, no new dependency, no change to any decoder body.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies. Fixtures are minted by the dev-only encoder `scripts/jbig2-codec.mjs` through `scripts/gen-jbig2-fixtures.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 1 of 7 ("page assembly"). Tracked as `aspose-pdf-foss-for-ts-utax.4`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins (`zlib`, `crypto`, `fs`). Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension (`import { decodeGeneric } from './jbig2generic.js'`).
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **`scripts/jbig2-codec.mjs` and `scripts/gen-jbig2-fixtures.mjs` are dev-only** — not shipped, imported by neither `src/` nor the tests. Tests read the *generated* `test/helpers/jbig2-fixtures.ts` only.
- **Issue tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`.
- **Both quality gates must be green before the issue closes:** `npm run typecheck` and `npm test`.
- **Each child narrows a throw rather than deleting it.** After this task set, types 16, 20, 22, 23, 40, 42, 43 and 53 still refuse by name. That is the point, not an oversight — the decoder must never be in a state where it silently produces a wrong image instead of refusing one it cannot read.
- **Prove every assertion load-bearing.** A test that passes on the first run is not evidence. Break the path it covers, watch the suite go red, restore. Each task below carries an explicit mutation step.

## Background: what is actually wrong today

`src/jbig2.ts:123` handles `case 36: case 38: case 39:` in one block and ends it with an unconditional `combine(page, bm, ri.x, ri.y, ri.combOp)`. `src/jbig2.ts:139` does the same for `case 4: case 6: case 7:`. Types 36 and 4 are the **intermediate** forms of the generic and text region; 38/39 and 6/7 are the immediate ones.

T.88 §7.4 says an intermediate region segment is not part of the page. It is decoded and retained for a later segment — in practice a refinement region (types 40/42/43) — to use as its reference. Only the immediate forms composite.

This is wrong in the direction that looks right: in a file where the intermediate region is subsequently refined onto the same spot, the page ends up with approximately the intended ink, so every fixture we have passes either way. It has to be fixed before `utax.3` (GRRD) lands, because GRRD's reference bitmap *is* the buffer this task starts keeping.

**On the orphan case.** After this change, a stream carrying an intermediate region that nothing consumes contributes no ink. That is the conformant reading — a file with an orphan intermediate is not conformant to T.88 — and it is not a regression in practice: a conformant file pairs the intermediate with a refinement segment, and every refinement segment type still throws `UnsupportedFeatureError` today, so such a file refuses as a whole either way. Task 1 asserts the orphan behaviour directly so it is a decision on the record rather than a surprise.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/jbig2.ts` | modify | Adds `export interface Buffered`, the `buffersBySeg` map, the two intermediate branches, and type 52 on the skip line. Nothing else in this file moves. |
| `scripts/gen-jbig2-fixtures.mjs` | modify | Emits four new *raw JBIG2 stream* exports (not PDFs) so page assembly can be tested through `decodeJbig2` directly, without a `Document.Open` round trip. |
| `test/helpers/jbig2-fixtures.ts` | regenerated | Generated file — never hand-edited. Regenerate with `node scripts/gen-jbig2-fixtures.mjs`. |
| `test/helpers/jbig2-unsupported.ts` | modify | Gains an exported `segmentStream(type)` for hand-built single-segment streams; the two existing named exports stay, since `test/jbig2-unsupported.test.ts` imports them. |
| `test/jbig2-assembly.test.ts` | create | The whole of this child's behaviour: immediate composites, intermediate does not, 52 is skipped, and the remaining refusals still fire by name. |
| `CHANGELOG.md` | modify | One `### Fixed` entry under `## [Unreleased]`. |
| `CLAUDE.md` | modify | Records the intermediate-region invariant beside the `jbig2.ts` description. |

**Why a new test file rather than growing `test/jbig2-segments.test.ts`:** that file tests `parseSegments` — header syntax, in isolation. This tests `decodeJbig2` — what the assembly loop does with a parsed segment. Two different units.

**Not touched, deliberately:** `README.md`. Its JBIG2 paragraph (around line 1740) lists which sub-features throw, and this task changes none of them. Editing it would be a no-op edit.

**Deviation from a literal reading of the spec, recorded here rather than made silently:** the spec's decomposition table lists "four lookup maps" in this child. Only two are buildable now. `tablesBySeg` is `Map<number, HuffmanTable>` and `HuffmanTable` is defined by child 5 (`utax.6`), so it cannot be typed yet; `patternsBySeg` would have neither a producer (type 16 still throws) nor a consumer (types 20/22/23 still throw) and would be dead code a reviewer should reject. This task delivers `buffersBySeg` — the one map with a real producer and an observable behaviour change — and the `Buffered` shape the other two follow. The design is unchanged; only the staging is.

---

### Task 1: `Buffered` and the intermediate generic region (type 36)

**Files:**
- Modify: `scripts/gen-jbig2-fixtures.mjs:70` (stream assembly) and `:131-142` (the emitted TypeScript)
- Regenerate: `test/helpers/jbig2-fixtures.ts`
- Create: `test/jbig2-assembly.test.ts`
- Modify: `src/jbig2.ts` — after `parseRegionInfo` (line 89), and inside `decodeJbig2` at lines 104 and 123-138

**Interfaces:**
- Consumes: `decodeJbig2(data, globals, width, height): Uint8Array`, `parseRegionInfo(data, start): RegionInfo`, `combine(dst, src, x, y, op): void`, `newBitmap(w, h, fill?): Bitmap`, all already exported from `src/jbig2.ts`.
- Produces:
  - `export interface Buffered { bitmap: Bitmap; info: RegionInfo }` in `src/jbig2.ts` — consumed by `utax.3` (GRRD), which needs both the pixels and the `RegionInfo` to align the reference against the region rectangle.
  - `buffersBySeg: Map<number, Buffered>`, a local in `decodeJbig2`, keyed by segment number — the map `utax.3`'s refinement case looks its referred-to segment up in.
  - Fixture exports `generic_stream` and `intermediate_generic_stream` (`Uint8Array`, raw JBIG2 segment streams) from `test/helpers/jbig2-fixtures.ts`.

- [ ] **Step 1: Claim the issue**

```bash
bd update aspose-pdf-foss-for-ts-utax.4 --claim
```

- [ ] **Step 2: Teach the fixture generator to emit raw JBIG2 streams**

`scripts/gen-jbig2-fixtures.mjs` today embeds every stream inside a PDF and exports only the PDFs. Page assembly is best tested through `decodeJbig2` directly, so the raw streams need their own exports.

In `scripts/gen-jbig2-fixtures.mjs`, replace this line (currently line 70):

```js
const genericStream = Uint8Array.from(seg(0, 38, [], genericRegionData(GW, GH, 0, 0, 0, 0, AT0, true, genGenericArith())));
```

with:

```js
const genericArith = genGenericArith();
const genericRegion = genericRegionData(GW, GH, 0, 0, 0, 0, AT0, true, genericArith);
const genericStream = Uint8Array.from(seg(0, 38, [], genericRegion));
// The same region body under the INTERMEDIATE type (T.88 7.4): decoded and held
// for a later segment to consume, never composited onto the page.
const intermediateGenericStream = Uint8Array.from(seg(0, 36, [], genericRegion));
```

`genGenericArith()` allocates a fresh `MqEncoder` per call and is pure, so hoisting it changes no bytes.

Then, in the emitted TypeScript template (the `const out = ...` block near line 131), add two export lines immediately after the `generic_samples` line:

```js
export const generic_stream: Uint8Array = b64(${JSON.stringify(b64(genericStream))});
export const intermediate_generic_stream: Uint8Array = b64(${JSON.stringify(b64(intermediateGenericStream))});
```

- [ ] **Step 3: Regenerate the fixtures and confirm nothing existing moved**

Run:

```bash
node scripts/gen-jbig2-fixtures.mjs
git diff --stat test/helpers/jbig2-fixtures.ts
git diff test/helpers/jbig2-fixtures.ts | grep '^-' | grep -v '^---'
```

Expected: the `--stat` shows insertions only, and the third command prints **nothing** — no line was removed or altered. The encoder is deterministic, so every pre-existing export must be byte-identical. If a line changed, stop and find out why before continuing; the existing suite is pinned to those bytes.

- [ ] **Step 4: Write the failing test**

Create `test/jbig2-assembly.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJbig2 } from '../src/jbig2.js';
import * as F from './helpers/jbig2-fixtures.js';

/** Packed samples for a page with no ink. `packBitmap` sets one bit per black
 *  pixel and then inverts the whole buffer, so an empty page is every byte
 *  0xff — not 0x00. */
function blank(width: number, height: number): number[] {
  return Array.from(new Uint8Array(((width + 7) >> 3) * height).fill(0xff));
}

describe('jbig2 page assembly', () => {
  it('composites an immediate generic region (type 38) onto the page', () => {
    const out = decodeJbig2(F.generic_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.generic_samples));
  });

  // T.88 7.4: an intermediate region is decoded and held for a later segment to
  // consume. It is invisible to the page until something consumes it — and in
  // this child nothing does yet, so the page stays empty. The second assertion
  // guards the first: without it, a `blank()` that happened to match the
  // region's real samples would pass.
  it('holds an intermediate generic region (type 36) off the page', () => {
    const out = decodeJbig2(F.intermediate_generic_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(blank(16, 16));
    expect(Array.from(out)).not.toEqual(Array.from(F.generic_samples));
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: the first test PASSES (it fences today's correct behaviour); the second FAILS, with the received array equal to `generic_samples` — the region was composited.

- [ ] **Step 6: Add the `Buffered` type**

In `src/jbig2.ts`, immediately after the `parseRegionInfo` function (currently ending line 89) and before the `s8` helper, add:

```ts
/** An intermediate region segment's decoded result (T.88 §7.4): the bitmap plus
 *  the region rectangle it was decoded for, held under its segment number for a
 *  later segment to consume. A refinement region needs both — the pixels as its
 *  reference, and the rectangle to align that reference against its own. */
export interface Buffered { bitmap: Bitmap; info: RegionInfo }
```

- [ ] **Step 7: Add the map and branch the generic-region case**

In `decodeJbig2`, replace the single map declaration (line 104):

```ts
  const symbolsBySeg = new Map<number, Bitmap[]>();
```

with:

```ts
  const symbolsBySeg = new Map<number, Bitmap[]>();
  // Intermediate regions (types 4, 20, 36, 40), keyed by segment number. A
  // referred-to segment resolves by KIND — a refinement region wants a buffer,
  // a text region wants symbol dictionaries — so a wrong-kind reference is a
  // lookup miss rather than a runtime type test.
  const buffersBySeg = new Map<number, Buffered>();
```

Then, in the `case 36: case 38: case 39:` block, replace the final `combine` (line 136):

```ts
        combine(page, bm, ri.x, ri.y, ri.combOp);
```

with:

```ts
        // 36 is the intermediate form: stored, not drawn. Only 38/39 composite.
        if (h.type === 36) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, ri.combOp);
```

Update the block's leading comment on line 123 from `// immediate (lossless) generic region` to `// generic region: 36 intermediate, 38/39 immediate (lossless)`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 9: Prove the assertion load-bearing**

Temporarily change the branch in `src/jbig2.ts` back to an unconditional composite:

```ts
        combine(page, bm, ri.x, ri.y, ri.combOp);
        if (h.type === 36) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
```

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: RED — "holds an intermediate generic region (type 36) off the page" fails. Then restore the `if`/`else` from Step 7 and re-run to confirm green. If it stayed green, the test is not testing what it claims and must be fixed before moving on.

- [ ] **Step 10: Run the whole JBIG2 suite**

Run:

```bash
npx vitest run test/jbig2-generic.test.ts test/jbig2-segments.test.ts test/jbig2-symbol.test.ts test/jbig2-text.test.ts test/jbig2-unsupported.test.ts test/jbig2.test.ts test/jbig2arith.test.ts test/jbig2-assembly.test.ts
```

Expected: all PASS. No existing fixture uses an intermediate region, so nothing should move.

- [ ] **Step 11: Commit**

```bash
git add src/jbig2.ts scripts/gen-jbig2-fixtures.mjs test/helpers/jbig2-fixtures.ts test/jbig2-assembly.test.ts
git commit -m "fix(utax.4): hold an intermediate generic region off the page" -m "T.88 7.4 makes segment type 36 an intermediate region: decoded and kept for a later segment to use as a reference, never composited. jbig2.ts handled 36 in the same block as 38/39 and drew all three." -m "Wrong in the direction that looks right — where the intermediate region is subsequently refined onto the same spot, the page ends up with roughly the intended ink, which is why every fixture passed either way. It has to go before GRRD (utax.3) lands, since the buffer this now keeps IS a refinement region's reference bitmap." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The intermediate text region (type 4)

**Files:**
- Modify: `scripts/gen-jbig2-fixtures.mjs:73` (stream assembly) and the emitted TypeScript near line 137
- Regenerate: `test/helpers/jbig2-fixtures.ts`
- Modify: `test/jbig2-assembly.test.ts` (two tests added to the existing `describe`)
- Modify: `src/jbig2.ts` — the `case 4: case 6: case 7:` block, currently lines 139-154

**Interfaces:**
- Consumes: `Buffered` and the `buffersBySeg` map from Task 1; the `blank(width, height): number[]` helper already in `test/jbig2-assembly.test.ts`.
- Produces: fixture exports `symtext_stream` and `intermediate_text_stream` (`Uint8Array`) from `test/helpers/jbig2-fixtures.ts`. Both are two-segment streams — a symbol dictionary (type 0) followed by the text region — because a text region with no symbols to place would test nothing.

- [ ] **Step 1: Extend the fixture generator**

In `scripts/gen-jbig2-fixtures.mjs`, immediately after the existing line:

```js
const symtextStream = Uint8Array.from([...seg(0, 0, [], sdData), ...seg(1, 6, [0], trData)]);
```

add:

```js
// The same text region under the INTERMEDIATE type (T.88 7.4). The symbol
// dictionary is unchanged and still contributes no ink of its own.
const intermediateTextStream = Uint8Array.from([...seg(0, 0, [], sdData), ...seg(1, 4, [0], trData)]);
```

In the emitted TypeScript template, after the `symtext_samples` line, add:

```js
export const symtext_stream: Uint8Array = b64(${JSON.stringify(b64(symtextStream))});
export const intermediate_text_stream: Uint8Array = b64(${JSON.stringify(b64(intermediateTextStream))});
```

- [ ] **Step 2: Regenerate and confirm nothing existing moved**

Run:

```bash
node scripts/gen-jbig2-fixtures.mjs
git diff test/helpers/jbig2-fixtures.ts | grep '^-' | grep -v '^---'
```

Expected: prints nothing — insertions only.

- [ ] **Step 3: Write the failing test**

Add these two tests inside the existing `describe('jbig2 page assembly', ...)` in `test/jbig2-assembly.test.ts`:

```ts
  it('composites an immediate text region (type 6) onto the page', () => {
    const out = decodeJbig2(F.symtext_stream, undefined, 12, 6);
    expect(Array.from(out)).toEqual(Array.from(F.symtext_samples));
  });

  // The symbol dictionary in this stream is unchanged and contributes no ink of
  // its own, so an empty page here means the type-4 region was held back — not
  // that the dictionary failed to decode. The immediate case above is what
  // proves the dictionary still works.
  it('holds an intermediate text region (type 4) off the page', () => {
    const out = decodeJbig2(F.intermediate_text_stream, undefined, 12, 6);
    expect(Array.from(out)).toEqual(blank(12, 6));
    expect(Array.from(out)).not.toEqual(Array.from(F.symtext_samples));
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: "composites an immediate text region (type 6)" PASSES; "holds an intermediate text region (type 4) off the page" FAILS with the received array equal to `symtext_samples`.

- [ ] **Step 5: Branch the text-region case**

In `src/jbig2.ts`, in the `case 4: case 6: case 7:` block, replace the final `combine` (currently line 152):

```ts
        combine(page, bm, ri.x, ri.y, ri.combOp);
```

with:

```ts
        // 4 is the intermediate form: stored, not drawn. Only 6/7 composite.
        if (h.type === 4) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, ri.combOp);
```

Update the block's leading comment on line 139 from `// text region (intermediate / immediate / immediate-lossless)` to `// text region: 4 intermediate, 6/7 immediate (lossless)`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 7: Prove the assertion load-bearing**

Temporarily change the condition in `src/jbig2.ts` to `if (false)`. Run `npx vitest run test/jbig2-assembly.test.ts` and expect RED on the type-4 test only. Restore, re-run, confirm green.

- [ ] **Step 8: Commit**

```bash
git add src/jbig2.ts scripts/gen-jbig2-fixtures.mjs test/helpers/jbig2-fixtures.ts test/jbig2-assembly.test.ts
git commit -m "fix(utax.4): hold an intermediate text region off the page" -m "Segment type 4 is the intermediate text region and shared the composite with 6/7, exactly as 36 shared it with 38/39. Same rule, same fix: store it under its segment number for a later segment to consume." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Skip the profiles segment, fence the refusals that remain, and document

**Files:**
- Modify: `src/jbig2.ts:107` (the skip line)
- Modify: `test/helpers/jbig2-unsupported.ts` (export a general `segmentStream`)
- Modify: `test/jbig2-assembly.test.ts` (the import block and two tests)
- Modify: `CHANGELOG.md` (one `### Fixed` entry under `## [Unreleased]`)
- Modify: `CLAUDE.md` (the invariant, at the end of the rendering bullet that describes `jbig2.ts`, around line 1782)

**Interfaces:**
- Consumes: the `blank(width, height): number[]` helper from `test/jbig2-assembly.test.ts`; `UnsupportedFeatureError` from `src/errors.js`.
- Produces: `export function segmentStream(type: number): Uint8Array` in `test/helpers/jbig2-unsupported.ts` — a one-segment embedded stream with a zero-length body, for any segment type whose case refuses (or skips) before reading a body. The existing `halftoneStream()` and `refinementStream()` exports stay, because `test/jbig2-unsupported.test.ts` imports them by name.

- [ ] **Step 1: Export a general single-segment stream builder**

In `test/helpers/jbig2-unsupported.ts`, promote the private `header` to a documented export and keep the two named wrappers. Replace the whole file with:

```ts
// Hand-built single-segment JBIG2 streams (embedded organization), for tests of
// segment types whose case in decodeJbig2 refuses — or skips — before reading a
// body. Layout matches the short-form header in test/jbig2-segments.test.ts.

/** A stream whose sole segment is of `type`, with a zero-length body. */
export function segmentStream(type: number): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0,  // segment number
    type & 0x3f, // flags (1-byte page association, count 0)
    0x00,        // referred-to count/retain (0)
    0x01,        // page association
    0, 0, 0, 0,  // data length 0
  ]);
}

/** A stream whose sole segment is an immediate halftone region (type 22). */
export function halftoneStream(): Uint8Array { return segmentStream(22); }

/** A stream whose sole segment is an intermediate generic refinement region (type 40). */
export function refinementStream(): Uint8Array { return segmentStream(40); }
```

- [ ] **Step 2: Write the failing test**

In `test/jbig2-assembly.test.ts`, extend the import block to:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJbig2 } from '../src/jbig2.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { segmentStream } from './helpers/jbig2-unsupported.js';
import * as F from './helpers/jbig2-fixtures.js';
```

and add these two tests to the existing `describe`:

```ts
  // Type 52 carries a profile, not a bitmap. It belongs on the skip line beside
  // the page-information and end-of-* segments and reaches `default:` only
  // because nobody has met one.
  it('skips a profiles segment (type 52) rather than refusing the stream', () => {
    expect(Array.from(decodeJbig2(segmentStream(52), undefined, 8, 8))).toEqual(blank(8, 8));
  });

  // Every child of this epic NARROWS a throw rather than deleting it. Type 20 is
  // the one that could go wrong quietly here: it is the *intermediate* halftone
  // region, so "intermediate means buffer it" would wave it through and leave
  // the decoder silently producing a blank page for a halftone it cannot read.
  // Type 53 is the second: it must not ride onto the skip line beside 52.
  it.each([
    [16, /pattern dictionary/i],
    [20, /halftone/i],
    [22, /halftone/i],
    [23, /halftone/i],
    [40, /refinement/i],
    [42, /refinement/i],
    [43, /refinement/i],
    [53, /segment type 53/i],
  ])('still refuses segment type %i by name', (type, message) => {
    expect(() => decodeJbig2(segmentStream(type as number), undefined, 8, 8)).toThrow(UnsupportedFeatureError);
    expect(() => decodeJbig2(segmentStream(type as number), undefined, 8, 8)).toThrow(message as RegExp);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: "skips a profiles segment (type 52)" FAILS with `UnsupportedFeatureError: JBIG2: segment type 52 not supported` thrown from the `default:` case. The eight `it.each` cases PASS — they fence behaviour that is already correct.

- [ ] **Step 4: Put type 52 on the skip line**

In `src/jbig2.ts`, replace line 107:

```ts
      case 48: case 49: case 50: case 51: case 62: break; // page info / end-of-* / extension: no bitmap
```

with:

```ts
      // page info / end-of-* / profiles / extension: carry no bitmap and
      // contribute nothing to the page.
      case 48: case 49: case 50: case 51: case 52: case 62: break;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: PASS, 13 tests (4 from Tasks 1-2, the profiles test, and 8 `it.each` cases).

- [ ] **Step 6: Prove the refusal fence load-bearing**

The `it.each` block passed on its first run, so it needs a mutation to be worth anything. Temporarily add `case 20:` to the skip line in `src/jbig2.ts` — the exact mistake the block exists to catch.

Run: `npx vitest run test/jbig2-assembly.test.ts`

Expected: RED on "still refuses segment type 20 by name". Restore the skip line to Step 4's version and re-run to confirm green.

- [ ] **Step 7: Record the invariant in CLAUDE.md**

In `CLAUDE.md`, the rendering bullet that describes `jbig2.ts` ends with `…and the bundled Standard-14 substitute faces (**std14data.ts**, **std14fonts.ts**).` (around line 1782). Append a new paragraph to that bullet, at the same two-space indentation as the other `**Invariant:**` paragraphs in the file:

```markdown
  **Invariant:** a JBIG2 **intermediate** region segment (4, 20, 36, 40) is
  decoded and stored under its segment number for a later segment to consume,
  and is **invisible to the page** until something consumes it. Only the
  immediate forms (6/7, 22/23, 38/39, 42/43) composite. `jbig2.ts` drew types 36
  and 4 as well, which is wrong by T.88 §7.4 — and wrong in the direction that
  looks right, because in a file where the intermediate region is subsequently
  refined onto the same spot the page ends up with approximately the intended
  ink, so every fixture passed either way. The buffer is a refinement region's
  reference bitmap, which is why it is kept with its `RegionInfo` and not just
  its pixels. An orphan intermediate — one nothing consumes — contributes
  nothing, which is the conformant reading; `test/jbig2-assembly.test.ts`
  asserts that directly so it stays a decision rather than a surprise.
```

- [ ] **Step 8: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`: Keep a Changelog orders sections Added, Changed, Deprecated, Removed, Fixed, Security, so the entry goes in a `### Fixed` section *after* the existing `### Added` list (create the section if it is not there yet). Add:

```markdown
- **JBIG2 intermediate region segments no longer draw on the page** — a type 36
  (intermediate generic region) or type 4 (intermediate text region) is now
  decoded and held for a later segment to use as its reference, which is what
  ITU-T T.88 §7.4 defines it for; only the immediate forms (6/7, 38/39)
  composite. Both were drawn unconditionally before, which is wrong in the
  direction that looks right: in a conformant file the intermediate region is
  subsequently refined onto the same spot, so the page ended up with
  approximately the intended ink and no fixture could tell the difference. It
  bites once refinement regions decode, since the buffer this now keeps *is* the
  reference a refinement reads. A file carrying an intermediate region nothing
  consumes is not conformant and now contributes no ink for it. The profiles
  segment (type 52) is also skipped rather than refused — it carries no bitmap
  and belongs beside the page-information and end-of-* segments; it reached the
  `default:` refusal only because nobody had met one. Halftone, pattern
  dictionary, refinement, custom Huffman tables and Huffman-coded regions still
  refuse by name. (`utax.4`)
```

- [ ] **Step 9: Run both quality gates**

Run:

```bash
npm run typecheck
npm test
```

Expected: `typecheck` clean, full suite green. If anything outside `test/jbig2*` moved, stop — this change should be invisible to every other suite.

- [ ] **Step 10: Commit**

```bash
git add src/jbig2.ts test/helpers/jbig2-unsupported.ts test/jbig2-assembly.test.ts CHANGELOG.md CLAUDE.md
git commit -m "fix(utax.4): skip the JBIG2 profiles segment, fence the refusals that remain" -m "Type 52 carries a profile, not a bitmap, and belongs on the skip line beside the page-information and end-of-* segments; it reached default: only because nobody had met one." -m "The it.each block is the other half: every child of this epic narrows a throw rather than deleting it, and type 20 is the case that could go wrong quietly — it is the *intermediate* halftone region, so \"intermediate means buffer it\" would wave it through and leave the decoder silently producing a blank page for a halftone it cannot read." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-utax.4 --reason "Intermediate regions (types 36 and 4) are held in buffersBySeg under their segment number instead of compositing, per T.88 7.4; the Buffered shape carries the bitmap plus its RegionInfo because a refinement region needs both. Type 52 skipped. Refusals for 16, 20, 22, 23, 40, 42, 43 and 53 fenced by name in test/jbig2-assembly.test.ts, proved load-bearing by putting 20 on the skip line and watching it go red. patternsBySeg and tablesBySeg deferred to utax.1 and utax.6 — tablesBySeg's value type does not exist until utax.6 defines HuffmanTable, and neither map has a producer or a consumer yet."
git pull --rebase
git push
git status
bd ready | grep utax
```

Expected: `git status` reports the branch up to date with origin, and `bd ready` now lists `aspose-pdf-foss-for-ts-utax.3` (Refinement region decoding) as the next unblocked child.

---

## Notes for the executor

**What the next child needs from this one.** `utax.3` adds `src/jbig2refine.ts` and the `case 40: case 42: case 43:` handling. Its refinement region resolves its reference by looking each `h.referredTo` entry up in `buffersBySeg` — and per the spec, a refinement region whose referred-to set contains **no** intermediate region refines the *page itself*: the reference is the page's current pixels under the region rectangle, and the result **replaces** them, with the external combination operator not applying. Do not "fix" that into a `combine` call; OR-ing refinement output onto its own input renders as a slightly bold page rather than as a fault.

**Do not run the other generators.** `npm test` runs no `scripts/gen-*` entry, and the committed `src/*data.ts` tables are pinned to the upstream versions their modules document. Only `scripts/gen-jbig2-fixtures.mjs` is in scope here.

**If `git diff` on the regenerated fixture file shows a removed line**, the encoder is not deterministic in the way this plan assumes and the whole fixture strategy needs re-examining before any further task. Stop and report it rather than committing the churn.
