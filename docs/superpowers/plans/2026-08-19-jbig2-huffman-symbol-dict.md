# JBIG2 Huffman symbol dictionary and the IntSource seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `decodeSymbolDict` stops throwing on `SDHUFF`. Getting there means introducing the seam the whole epic has been building toward: `IntSource`, so the symbol dictionary and the text region read *"decode DH using SDHUFFDH or IADH"* as one call rather than hard-wiring the arithmetic half of that sentence.

**Architecture:** One new leaf, `src/jbig2ints.ts`, holding the interface and its two implementations. `jbig2symbol.ts` and `jbig2text.ts` then depend on the interface instead of on both entropy stacks. Table *selection* stays in `jbig2.ts` with the rest of the header parsing — `jbig2ints.ts` receives concrete tables and never sees a flag word.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 6 of 7. Tracked as `aspose-pdf-foss-for-ts-utax.2`. Depends on `utax.5` (REFAGG, closed) and `utax.6` (tables, closed). Blocks `utax.7`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`.
- **Issue tracking is `bd`.** No TodoWrite, no markdown TODO lists.
- **`CHANGELOG.md` in the same commit as the user-visible change.**
- **Both gates green before close:** `npm run typecheck` and `npm test`.
- **THE FENCE FOR TASK 1 IS BYTE-IDENTITY.** The refactor onto `IntSource` must leave every existing JBIG2 vector green **with no regeneration**. `node scripts/mqenc.mjs && node scripts/gen-jbig2-fixtures.mjs && git diff --stat test/helpers/` must show nothing moved. A refactor that quietly changes the arithmetic path is the worst outcome available here, because the Huffman path has no independent reference to catch it.
- **Prove every assertion load-bearing.** Break the path, watch the suite go red, restore.

## Background

### The seam, and where it stops

T.88 writes §6.5 (symbol dictionary) and §6.4 (text region) as one procedure each with the entropy source swapped. `IntSource` is that swap made explicit: thirteen integer fields plus a symbol ID plus `align()`, each returning `number | null` so OOB survives. The arithmetic implementation wraps `decodeInt`/`decodeIaid` over an `MqDecoder`; the Huffman one wraps `HuffmanTable.decode` over a `HuffmanReader`.

**The seam does not cover everything, and the plan says where it stops.** A Huffman symbol dictionary with `SDREFAGG == 0` does **not** decode a bitmap per symbol. It decodes the widths of a whole height class, reads `BMSIZE`, aligns, reads **one** bitmap for the entire class, and slices it by the widths already decoded. The outer height-class walk is shared; the inner bitmap production is not. So it is injected as a **separate per-class producer** rather than folded into the integer interface:

```ts
export type SymbolProducer =
  | { kind: 'perSymbol'; produce(width: number, height: number): Bitmap }
  | { kind: 'perClass'; produce(widths: number[], height: number): Bitmap[] };
```

A discriminated union rather than two optional methods, so the walk branches exactly once and neither shape can silently be absent.

**Invariant:** there is ONE height-class walk and ONE strip walk. A second copy of either — which is how Go arranges it, in `jbig2_huffsym.go` and `jbig2_hufftext.go` — is how the Huffman and arithmetic paths come to disagree about one document.

### The context-sharing question, which this child must decide

`utax.5` gave the symbol dictionary its own `IADH`/`IADW`/`IAEX`/`IAAI`/`IAID`/`IARDX`/`IARDY`, and gave the aggregate text region a **separate** `TextIntCtx` with its own `IAID`/`IARDX`/`IARDY`. T.88 §6.5.8.2.1 reads the other way: the aggregate text region uses the *dictionary's* arithmetic statistics, which would make those one set, not two.

Under `IntSource` the natural code shape is one source shared by both, which is also the spec's reading — so **merge**. Two things make that safe and one makes it unproven:

- **Safe:** neither existing fixture can tell the difference. `refagg_one` uses only the `NINST == 1` path and `refagg_many` only the aggregate path, and in each case the contexts the other path would have used are untouched and therefore in their initial state. Measured — the merge must leave both vectors byte-identical, and if it does not, the reasoning here is wrong and the merge must be reverted rather than the vectors regenerated.
- **Unproven:** no fixture MIXES the two paths in one dictionary, which is the only shape that distinguishes them. Task 5 adds one. It pins that our encoder and our decoder agree about the merge; it does **not** pin that the merge matches T.88, and the test must say so.

### What a Huffman symbol dictionary reads

| Field | Arithmetic | Huffman | Selector |
|---|---|---|---|
| DH | IADH | B.4 / B.5 / custom | flags bits 2–3 |
| DW | IADW | B.2 / B.3 / custom | flags bits 4–5 |
| BMSIZE | — | B.1 / custom | flags bit 6 |
| REFAGGNINST | IAAI | B.1 / custom | flags bit 7 |
| EX run | IAEX | **B.1, always** | none — §6.5.10 fixes it |
| ID (REFAGG, NINST 1) | IAID | `symCodeLen` raw bits | none |
| RDX / RDY | IARDX / IARDY | **B.15, always** | none |

Two of those have **no selector at all** and are easy to give one by mistake: the export run is always Table B.1 and the refinement deltas are always Table B.15.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/jbig2ints.ts` | create | `IntSource`, `ArithIntSource`, `HuffmanIntSource`, `SymbolProducer`. |
| `src/jbig2symbol.ts` | modify | Height-class walk over `IntSource` + a producer; the Huffman collective-bitmap producer. |
| `src/jbig2text.ts` | modify | Strip walk over `IntSource`. No Huffman driver yet — that is `utax.7`. |
| `src/jbig2.ts` | modify | Symbol-dictionary table selection; the `SDHUFF` refusal goes. |
| `test/helpers/jbig2-huffman-encode.ts` | create | Bit writer + `encodeValue` through a table. |
| `test/jbig2-huffman-symbol.test.ts` | create | The Huffman dictionary end to end. |
| `test/jbig2-intsource.test.ts` | create | The seam itself: both implementations against one walk. |
| `CLAUDE.md`, `README.md`, `CHANGELOG.md` | modify | |

---

### Task 1: `jbig2ints.ts` and the refactor — byte-identical

**Files:** create `src/jbig2ints.ts`; modify `src/jbig2text.ts`, `src/jbig2symbol.ts`

- [ ] **Step 1: The interface**

```ts
export interface IntSource {
  dh(): number | null; dw(): number | null; ex(): number | null; ai(): number | null;
  dt(): number | null; fs(): number | null; ds(): number | null; it(): number | null;
  ri(): number | null; rdw(): number | null; rdh(): number | null;
  rdx(): number | null; rdy(): number | null;
  /** BMSIZE in a symbol dictionary, RSIZE in a text region. One field: T.88
   *  gives it two names and, in both places, Table B.1. */
  size(): number | null;
  /** Symbol ID. Never OOB, which is why it is the one method returning a
   *  bare number. */
  id(): number;
  /** Byte-align. A NO-OP on the arithmetic path, which is not bit-addressed —
   *  present so the shared walks never branch on which source they hold. */
  align(): void;
}
```

- [ ] **Step 2: `ArithIntSource`**

Wraps an `MqDecoder` plus the context objects. It must own **every** context both walks use, because the merge above makes the dictionary and its aggregate text region share one source.

- [ ] **Step 3: Refactor both walks onto it**

`decodeTextRegion` and `decodeSymbolDict` keep their signatures for callers that pass raw bytes, and gain an optional `IntSource` for the shared case. Delete `TextIntCtx` from `jbig2arith.ts` only if nothing else names it — otherwise leave it and note that `ArithIntSource` supersedes it.

- [ ] **Step 4: THE FENCE**

```bash
node scripts/mqenc.mjs && node scripts/gen-jbig2-fixtures.mjs
git diff --stat test/helpers/      # MUST be empty
npm run typecheck && npm test
```

If a generated helper moved, the refactor changed the arithmetic path. **Find out why; do not regenerate.** The merge in the Background section predicts no movement — if there is movement, that prediction was wrong and the merge must come out.

- [ ] **Step 5: Commit**

---

### Task 2: `HuffmanIntSource`

**Files:** modify `src/jbig2ints.ts`; create `test/jbig2-intsource.test.ts`

- [ ] **Step 1: Implement**

Constructed from a `HuffmanReader` plus a bag of tables — one per field, each already resolved by the caller. A field whose table is absent throws `PdfParseError` when read rather than returning a plausible zero: a dictionary that reads a field it was given no table for is a header we mis-parsed, and a zero there decodes silently.

`id()` reads `symCodeLen` raw bits when no symbol-ID table is supplied. That is exactly right for a symbol dictionary (§6.5.8.2.3) and is the seam `utax.7` fills with the runcode table.

`align()` calls through to the reader.

- [ ] **Step 2: Test the seam directly**

The point of the interface is that one walk serves both, so test *that*, not each implementation separately:

```ts
// One sequence of values, encoded twice — once arithmetically, once through
// standard tables — and read back through the SAME calls. This is the whole
// claim the seam makes.
it('reads the same values through either entropy source', () => { ... });
```

- [ ] **Step 3: Commit**

---

### Task 3: The Huffman symbol dictionary

**Files:** modify `src/jbig2symbol.ts`

- [ ] **Step 1: The collective bitmap producer (§6.5.9)**

```
BMSIZE = int.size()
int.align()
if BMSIZE == 0:
   uncompressed: hcHeight rows of ceil(totWidth / 8) bytes, read directly
else:
   MMR over exactly BMSIZE bytes (decodeMmrBitmap, ignoring its own consumed count)
advance the reader past the data, then align
slice by the recorded widths
```

**Invariant:** the reader advances by `BMSIZE` bytes, not by what MMR reported consuming. The two normally agree, and where they do not the file's own claim wins — otherwise one short bitmap desynchronises every later height class.

`BMSIZE == 0` is the case with no compression at all, and it is the one to build the first fixture on: it needs no encoder beyond a byte-packer.

- [ ] **Step 2: Wire the walk**

`SDHUFF && !SDREFAGG` → `perClass`. `SDHUFF && SDREFAGG` → `perSymbol`, refinement per symbol exactly as the arithmetic path does. The DW loop accumulates `totWidth` in the `perClass` case and produces nothing.

- [ ] **Step 3: Guards**

`PdfParseError` on: a height class whose total width is 0 with symbols in it; an uncompressed collective bitmap running past `end`; `BMSIZE` past `end`.

- [ ] **Step 4: Commit**

---

### Task 4: Table selection in `jbig2.ts`

**Files:** modify `src/jbig2.ts`

- [ ] **Step 1: Parse the four selectors**

`SDHUFFDH` bits 2–3, `SDHUFFDW` bits 4–5, `SDHUFFBMSIZE` bit 6, `SDHUFFAGGINST` bit 7.

- [ ] **Step 2: Resolve them**

Custom tables are consumed **in referred-to order**, one per selector that says "custom", walked in field order DH → DW → BMSIZE → AGGINST. A selector value of 2 for the two-bit fields is *reserved*: refuse it (`PdfParseError`) rather than falling through to a table that happens to be there.

Running out of referred custom tables is also a `PdfParseError` — the alternative is a field with no table, which Task 2 makes throw anyway, but at a point where the message names the field rather than the header.

- [ ] **Step 3: Drop the `SDHUFF` refusal**

The text-region `SBHUFF` refusal **stays** — that is `utax.7`.

- [ ] **Step 4: Commit**

---

### Task 5: Fixtures

**Files:** create `test/helpers/jbig2-huffman-encode.ts`, `test/jbig2-huffman-symbol.test.ts`

- [ ] **Step 1: The encoder half**

A `BitWriter` and `encodeValue(writer, table, value)` that finds the line covering a value and emits its code plus offset. Written against the table model, not against `HuffmanTable.decode`, so the two halves are independent code.

**Say plainly in the file** that this encoder reads the *same table data* the decoder does, so a table typo cancels out — these fixtures pin the WALK (height classes, BMSIZE, align, slicing), and the tables themselves are anchored separately by `utax.6`'s three checks.

- [ ] **Step 2: Three fixtures, in this order**

1. **`BMSIZE == 0`, uncompressed collective bitmap.** No compression anywhere; pins the height-class walk, the align, and the slicing.
2. **MMR collective bitmap**, assembled with `encodeG4` from `test/helpers/ccitt-encode.ts` — already pinned against golden bit strings, so no second reading of T.6.
3. **A dictionary of two height classes with different symbol counts**, so the per-class slicing cannot pass by accident on a single class of one symbol.

- [ ] **Step 3: The mixed-path arithmetic fixture**

The one that makes the context merge falsifiable: a REFAGG dictionary with a `NINST == 1` symbol **and** an aggregate symbol, in that order. Its comment must state that it pins encoder/decoder agreement about the merge and **not** that the merge matches T.88.

- [ ] **Step 4: Prove load-bearing**

- Drop the `align()` after BMSIZE. Expected: RED on fixture 1.
- Advance by MMR's own consumed count instead of `BMSIZE`. Expected: RED on fixture 2 only if the two differ — **check that they do**, and if they do not, say so rather than claiming coverage.
- Slice the collective bitmap by equal widths. Expected: RED on fixture 3.
- Give the export run a selector-chosen table instead of B.1. Expected: RED.

- [ ] **Step 5: Commit**

---

### Task 6: Documentation and close

- [ ] `CLAUDE.md`: the seam, where it stops, the merge and its unproven half, and the `BMSIZE` advance rule.
- [ ] `README.md`: Huffman symbol dictionaries decode; Huffman text regions still throw.
- [ ] `CHANGELOG.md`: one entry, honest that half the Huffman path is still missing.
- [ ] `npm run typecheck && npm test`, close, push.

---

## Notes for the executor

**Task 1 is the risky one and it is a refactor, not a feature.** Land it on its own commit with the byte-identity check actually run. Everything after it is additive.

**The context merge is a decision this child makes, not one it inherits.** If the byte-identity check fails, the prediction behind it was wrong — revert the merge, keep the two context sets, and record why. Do not regenerate vectors to make a refactor pass.

**Do not let the seam grow a Huffman text region.** `utax.7` owns the runcode symbol-ID table and mixed-mode refinement. This child leaves `SBHUFF` throwing, and the `id()`-reads-raw-bits behaviour is the hook it will use.
