# JBIG2 Huffman text region — runcode symbol IDs and mixed-mode refinement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The last child. `SBHUFF` stops throwing, and with it the Huffman aggregate inside a symbol dictionary — §6.5.8.2.1 decodes that *as* a Huffman text region, so the two refusals go together. After this, `decodeJbig2` raises no `UnsupportedFeatureError` at all except the `default:` arm for segment types T.88 does not assign.

**Architecture:** No new module. `utax.2` built the seam; this child fills the two holes it left — `HuffmanIntSource.id()` falling back to raw bits gets a real symbol-ID table, and the strip walk's refinement gets a producer so the Huffman spelling can alternate entropy coders without a second walk.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 7 of 7. Tracked as `aspose-pdf-foss-for-ts-utax.7`. Depends on `utax.2` (closed).

## Global Constraints

Unchanged from the previous children: zero runtime deps, ESM + NodeNext, `bd` for tracking, `CHANGELOG.md` in the same commit, both gates green, every assertion proved load-bearing by mutation. Plus:

- **The arithmetic path stays byte-identical.** `it()` and the refinement both grow a Huffman spelling; neither may move an existing vector. `node scripts/mqenc.mjs && node scripts/gen-jbig2-fixtures.mjs && git status --porcelain test/helpers/` must stay empty.
- **Still ONE strip walk.** The refinement difference is injected, not branched inline.

## Background: three Huffman-only differences in a walk that is otherwise shared

**1. CURT is raw bits, not a table.** T.88 §6.4.5 3(c)(ii): with `SBSTRIPS > 1`, a Huffman region reads CURT as `LOG2SBSTRIPS` **raw bits**. There is no `SBHUFFIT` in the flag word — the eight selectors are FS, DS, DT, RDW, RDH, RDX, RDY and RSIZE, and IT is not among them. So `HuffmanTables.it` should not exist, and `HuffmanIntSource` needs `logStrips` instead. A table there would be a field the format does not have.

**2. The symbol-ID code table (§7.4.3.1.7)** is built from the bitstream before any strip is read, and there is no simpler fallback — it runs for *every* Huffman text region:

```
35 four-bit RUNCODELENGTHs  ->  a runcode table (value i, length RUNCODELENGTH[i])
then, through that table, SBNUMSYMS code lengths:
  code < 32  -> this symbol's length is `code`
  code == 32 -> read 2 bits; repeat the PREVIOUS symbol's length 3 + n times
  code == 33 -> read 3 bits; repeat length 0, 3 + n times
  code == 34 -> read 7 bits; repeat length 0, 11 + n times
then the symbol-ID table (value i, length CODES[i]), then ALIGN
```

**32 repeats the previous length; 33 and 34 repeat zero.** Confusing the two is the mistake to guard: they differ only for a run following a non-zero length, and a wrong one shifts every later symbol ID by a code.

**3. Refinement alternates entropy coders within one stream (§6.4.11).** RSIZE is read with `SBHUFFRSIZE`, the reader aligns, an `MqDecoder` runs over **exactly** those RSIZE bytes, and Huffman reading resumes after them — by the file's own count, the same rule the collective bitmap follows.

## The aggregate, which comes free-ish

A symbol dictionary with `SDHUFF` and `REFAGGNINST > 1` decodes a Huffman text region whose parameters T.88 Table 17 fixes: FS→B.6, DS→B.8, DT→B.11, the four refinement deltas→B.15, RSIZE→B.1, and symbol IDs as `symCodeLen` **raw bits** (§6.5.8.2.3) rather than a runcode table — which is exactly `HuffmanIntSource`'s existing fallback. So the dictionary's last refusal goes with this child, and it must, because it *is* this feature.

## File Structure

| File | Change |
|---|---|
| `src/jbig2ints.ts` | `HuffmanTables.it` removed; `HuffmanIntSource` takes `logStrips`; `RefinementProducer`. |
| `src/jbig2huffman.ts` | `parseSymbolIdTable` (§7.4.3.1.7). |
| `src/jbig2text.ts` | Refinement injected; the Huffman driver. |
| `src/jbig2symbol.ts` | The Huffman aggregate; last refusal removed. |
| `src/jbig2.ts` | The Huffman flags field, eight selectors, `SBHUFF` refusal removed. |
| `test/jbig2-huffman-text.test.ts` | create |
| `test/jbig2-huffman.test.ts` | `parseSymbolIdTable`'s own cases. |
| `CLAUDE.md`, `README.md`, `CHANGELOG.md` | The epic's goal is met — say so once, accurately. |

---

### Task 1: `parseSymbolIdTable`

- [ ] Implement in `jbig2huffman.ts`: it is table machinery and belongs beside B.3's assignment, not in the strip walk.
- [ ] Guards (`PdfParseError`): runcode 32 as the *first* code (no previous length to repeat); a repeat run overshooting `numSyms`; a decoded runcode above 34.
- [ ] Tests, hand-built bit strings:
  - a flat table (every symbol the same length);
  - **each repeat code separately** — 32 after a non-zero length, 33, and 34 — asserting the resulting lengths, because the three differ only in what they repeat and by how much;
  - the align afterwards, asserted on `bytePos()`;
  - the first-code-32 refusal.
- [ ] Mutation: make 33 repeat the previous length instead of 0. Expect RED on the 33 case and GREEN on the 32 case — if both go red the fixture cannot tell them apart.

---

### Task 2: `it()` as raw bits, and the refinement producer

- [ ] `HuffmanIntSource(reader, tables, symCodeLen, logStrips = 0)`; `it()` returns `bits(logStrips)`. Drop `it` from `HuffmanTables` — a field the format does not have should not be representable.
- [ ] `RefinementProducer` in `jbig2ints.ts` beside `SymbolProducer`, and `decodeTextRegion` builds the arithmetic one when none is supplied. **Byte-identity check here**, not at the end.
- [ ] Test that `it()` reads exactly `logStrips` bits, and that `logStrips` 0 reads none — the walk skips IT entirely at `SBSTRIPS == 1`, so a source that read a bit anyway would desynchronise every single-strip region.

---

### Task 3: The Huffman text region

- [ ] `decodeTextRegion` gains `huffman` and the tables; it builds a `HuffmanIntSource`, parses the symbol-ID table, and injects the Huffman refinement producer.
- [ ] The refinement producer: RSIZE, align, `MqDecoder` over exactly RSIZE bytes, `seekByte(at + rsize)`.
- [ ] Note `SBHUFFRDW`/`RDH`/`RDX`/`RDY` default to **B.14 or B.15**, and B.14 is the bounded table (−2..2 only) — a refinement delta outside that range with B.14 selected is a damaged file, and `HuffmanTable.decode` already refuses a code no line matches.

---

### Task 4: Header parsing and selection

- [ ] The **Huffman flags** are a 2-byte field sitting between the text-region flags and SBRAT, present only when `SBHUFF` is set. Getting that order wrong shifts SBRAT and SBNUMINSTANCES — the same class of bug the SBRAT ordering already caused once.
- [ ] Eight selectors: FS → B.6/B.7/custom; DS → B.8/B.9/B.10/custom; DT → B.11/B.12/B.13/custom; RDW/RDH/RDX/RDY → B.14/B.15/·/custom; RSIZE → B.1/custom. Reserved values refuse. Custom tables consumed in referred-to order across all eight in field order.
- [ ] Test the mapping directly, as `utax.2` learned to: an end-to-end decode that only checks "does not throw" cannot see a wrong table.

---

### Task 5: The Huffman aggregate in the symbol dictionary

- [ ] Build the Table 17 source and call `decodeTextRegion`. Remove the refusal.
- [ ] Fixture: a `SDHUFF` + `SDREFAGG` dictionary whose symbol aggregates two others.

---

### Task 6: Fixtures for the text region

- [ ] A Huffman text region placing two symbols, through B.6/B.8/B.11.
- [ ] One with `SBSTRIPS > 1`, so CURT's raw-bit read is exercised at all.
- [ ] One with `SBREFINE`, so the alternating coders are exercised. Pad the RSIZE payload deliberately — `utax.2` measured that an unpadded one cannot tell "advance by the count" from "advance by what the inner decoder read".
- [ ] End to end through `decodeJbig2`, since that is the only thing that exercises header parsing and selection.

---

### Task 7: Documentation and close

- [ ] `CLAUDE.md`: the three Huffman-only differences, and the repeat-code rule.
- [ ] `README.md` / `CHANGELOG.md`: JBIG2 is complete for coding features. **State the remaining limit accurately** — `0xffffffff` unknown segment length is still a `PdfParseError`, and it always was out of scope. Do not claim more than that.
- [ ] Close `utax.7` **and the epic**, with the epic's close reason summarising what the seven children bought and what is still unanchored.

---

## Notes for the executor

**This is the child where a wrong claim is easiest to make.** "No `UnsupportedFeatureError` at all" is the epic's goal and it is nearly true — verify it by grepping `src/jbig2*.ts` rather than by asserting it, and describe the `default:` arm and the `0xffffffff` refusal honestly.

**The repeat codes are the one genuinely new rule here** and they have no anchor: our encoder will share our reading. Fixture design is the mitigation — one case per code, each asserting the resulting length array rather than only that a decode succeeded.
