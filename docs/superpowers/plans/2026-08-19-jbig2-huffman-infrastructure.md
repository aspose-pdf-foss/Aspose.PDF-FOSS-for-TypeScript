# JBIG2 Huffman infrastructure — bit reader, tables B.1–B.15, segment 53 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new leaf module `src/jbig2huffman.ts` holding everything the two Huffman consumers will need: an MSB-first bit reader with an explicit `align()`, the table model with T.88 B.3's canonical code assignment, the fifteen standard tables B.1–B.15 as literal data, and custom-table segment 53 parsed and stored in `tablesBySeg`. Segment 53 stops reaching `default:`.

**Architecture:** Pure and consumer-free. Nothing decodes a symbol or a text region in this child — `utax.2` and `utax.7` do that — so the module is exercised entirely by its own tests. Table *selection* (which flag bit picks B.4 versus B.5 versus a referred type-53 segment) stays out too: it belongs to `jbig2.ts` beside the rest of the header parsing, and it has nothing to select for until there is a consumer.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-jbig2-completeness-design.md` — child 5 of 7 ("Huffman infrastructure"). Tracked as `aspose-pdf-foss-for-ts-utax.6`. Depends on `utax.4` (closed) for the lookup maps. Blocks `utax.2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext, `strict` TypeScript.** Import specifiers carry the `.js` extension.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError` from `src/errors.ts`.
- **Issue tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change.** Note this child may be *invisible* to a library user — see Task 5.
- **Both quality gates green before close:** `npm run typecheck` and `npm test`.
- **This child narrows a throw rather than deleting it.** Segment 53 stops refusing; the two Huffman *flag* refusals (symbol dictionary, text region) stay, and the `default:` arm stays for genuinely unassigned segment types.
- **Prove every assertion load-bearing.** Break the path, watch the suite go red, restore.

## Background: this child is a transcription problem

Everything here is mechanical. There is no entropy coder, no geometry, no bitstream state machine — just fifteen tables of numbers and one textbook canonical-code assignment. That makes the risk profile completely different from the previous four children: **the danger is not a misread of T.88's prose, it is a typo in one of ~150 table rows**, and a typo in a table nothing yet consumes will sit undetected until `utax.2` decodes a real file wrongly.

Three independent checks are available, and all three are cheap. Use all three.

**1. The printed prefix codes (the anchor the issue names).** Annex B prints, for every line of every standard table, the assigned prefix **code** as well as its length. Those codes are exactly what B.3's assignment produces from the lengths, in table order. So transcribe the codes as a **separate column** from the lengths, compute the codes from the lengths, and assert equality. A typo in a PREFLEN changes the computed code and no longer matches the separately-transcribed printed one; a wrong assignment algorithm breaks every table at once.

**2. Kraft equality.** Every standard table is a *complete* prefix code: `sum(2^-PREFLEN) == 1` over its lines. A dropped line, a duplicated line, or a wrong PREFLEN breaks it.

**3. Range contiguity.** Every standard table's lines tile the integers with **no gap and no overlap**, from the lower-range line's bound to the upper-range line's. `RANGELOW[i] + 2^RANGELEN[i] == RANGELOW[i+1]` when the lines are sorted by `RANGELOW`. This is the check on the two columns the prefix codes cannot see, and it is what catches a mistyped `RANGELOW` or `RANGELEN`.

Checks 2 and 3 are properties of *what the table is*, not of what we wrote, so they are outside evidence in the same sense the Gray sequence was in `utax.1`. Assert them over all fifteen tables in a loop rather than case by case, so a table added later cannot skip them.

## The three line kinds, and why they are not interchangeable

A table line is `{ prefixLen, rangeLen, rangeLow }` plus a kind. Getting the kinds wrong produces plausible numbers:

| Kind | On a match | Notes |
|---|---|---|
| normal | read `rangeLen` bits → `rangeLow + offset` | |
| **lower range** | read **32** bits → `rangeLow − offset` | **subtracts.** `rangeLow` is `HTLOW − 1`, so it continues downward from the lowest normal line. |
| upper range | read 32 bits → `rangeLow + offset` | |
| OOB | nothing further | returns `null`, the same out-of-band `decodeInt` returns |

The lower-range line is the one that hides: it is spelled exactly like an upper-range line except for the sign, so adding instead of subtracting produces a large positive number where a large negative one was meant — which in a text region is a symbol placed far off the page rather than an error.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/jbig2huffman.ts` | create | Bit reader, table model, B.3 assignment, B.1–B.15, segment-53 parsing. |
| `src/jbig2.ts` | modify | `tablesBySeg`, the `case 53:` arm, one fewer `default:` refusal. |
| `test/jbig2-huffman.test.ts` | create | The three checks above, the bit reader, decoding, and the custom table. |
| `test/jbig2-assembly.test.ts` | modify | The segment-53 refusal fence inverts; an unassigned type takes its place. |
| `CLAUDE.md`, `README.md`, `CHANGELOG.md` | modify | See Task 5 on whether CHANGELOG applies. |

**On module edges:** `jbig2huffman.ts` imports `errors.js` and nothing else — not even `jbig2.js`, since it deals in numbers rather than bitmaps. That makes it the most isolated module in the JBIG2 stack and the easiest to test.

---

### Task 1: The bit reader and the table model

**Files:** create `src/jbig2huffman.ts`, create `test/jbig2-huffman.test.ts`

**Interfaces produced:**

```ts
export class HuffmanReader {
  constructor(data: Uint8Array, start: number, end: number);
  bit(): number;
  bits(n: number): number;
  /** Advance to the next byte boundary. */
  align(): void;
  /** The current position as a byte offset into the underlying array. */
  bytePos(): number;
  atEnd(): boolean;
}

export const enum HuffmanLineKind { Normal, Lower, Upper, OutOfBand }
export interface HuffmanLine {
  prefixLen: number; rangeLen: number; rangeLow: number; kind: HuffmanLineKind;
  /** Assigned by `assignPrefixCodes`; -1 until then, and for `prefixLen === 0`. */
  code: number;
}
export class HuffmanTable {
  constructor(lines: HuffmanLine[]);
  readonly lines: readonly HuffmanLine[];
  /** Decode one value. `null` is OOB, which only a table with an OOB line returns. */
  decode(r: HuffmanReader): number | null;
}
export function assignPrefixCodes(lines: HuffmanLine[]): void;
```

- [ ] **Step 1: The bit reader, and its tests first**

Three things it must get right, each with its own test:

```ts
it('reads MSB first across a byte boundary', () => {
  const r = new HuffmanReader(Uint8Array.from([0b10110010, 0b01000000]), 0, 2);
  expect(r.bits(3)).toBe(0b101);
  expect(r.bits(7)).toBe(0b1001001); // spans the boundary
});

// align() is explicit and load-bearing: a Huffman symbol dictionary reads a
// BMSIZE, aligns, and then takes a whole collective bitmap byte-wise (utax.2),
// and the symbol-ID runcode table aligns after itself (utax.7).
it('aligns to the next byte boundary, and is a no-op when already there', () => {
  const r = new HuffmanReader(Uint8Array.from([0xff, 0x0f]), 0, 2);
  r.bits(3); r.align();
  expect(r.bytePos()).toBe(1);
  r.align();
  expect(r.bytePos()).toBe(1); // no-op, NOT a byte skipped
});

// A 32-bit range value does not fit in a signed int, and `(v << 1) | b`
// silently wraps to negative at bit 32. This is the one arithmetic hazard in
// the whole module.
it('reads a full 32-bit value without sign overflow', () => {
  const r = new HuffmanReader(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0, 4);
  expect(r.bits(32)).toBe(0xffffffff);
});
```

Accumulate with `v * 2 + bit`, never `(v << 1) | bit`.

Reading past `end` returns 0 bits rather than throwing — a truncated Huffman stream is a damaged file, and the *caller* decides that, which is the same division `lexer.ts` records. Expose `atEnd()` so a consumer can.

- [ ] **Step 2: `assignPrefixCodes` — B.3**

The canonical assignment, in table order within each length:

```
LENCOUNT[len] = number of lines with prefixLen == len   (lines with prefixLen 0 EXCLUDED)
FIRSTCODE[0] = 0; LENCOUNT[0] = 0
for curLen = 1 .. maxLen:
  FIRSTCODE[curLen] = (FIRSTCODE[curLen-1] + LENCOUNT[curLen-1]) * 2
  curCode = FIRSTCODE[curLen]
  for each line, IN TABLE ORDER, with prefixLen == curLen:
    line.code = curCode++
```

**`prefixLen === 0` means the line is unused and takes no code.** No standard table has one; a custom table routinely does, because B.2.3 writes a length for every range whether or not the encoder used it. Including them shifts every subsequent code.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run test/jbig2-huffman.test.ts && npm run typecheck
git add -A && git commit -m "feat(utax.6): JBIG2 Huffman bit reader and B.3 code assignment" ...
```

---

### Task 2: The fifteen standard tables

**Files:** modify `src/jbig2huffman.ts`, `test/jbig2-huffman.test.ts`

- [ ] **Step 1: Transcribe them**

One literal per table, as rows of `[rangeLow, prefixLen, rangeLen, printedCode]` plus a kind marker, in T.88's own line order — **order matters**, because B.3 assigns within a length in table order.

Keep the printed code in the data. It is not used at runtime (the assignment computes it) and exists solely to be asserted against; say so in a comment so nobody "cleans it up".

Coverage, for orientation while transcribing:

| Table | Covers | Has OOB | Has lower range |
|---|---|---|---|
| B.1 | 0 .. ∞ | no | no |
| B.2 | 0 .. ∞ | yes | no |
| B.3 | −∞ .. ∞ | yes | yes |
| B.4 | 1 .. ∞ | no | no |
| B.5 | −∞ .. ∞ | no | yes |
| B.6 | −∞ .. ∞ | no | yes |
| B.7 | −∞ .. ∞ | no | yes |
| B.8 | −∞ .. ∞ | yes | yes |
| B.9 | −∞ .. ∞ | yes | yes |
| B.10 | −∞ .. ∞ | yes | yes |
| B.11 .. B.13 | 1 .. ∞ | no | no |
| **B.14** | **−2 .. 2 only** | no | **no — bounded, no upper range either** |
| B.15 | −∞ .. ∞ | no | yes |

**B.14 is the one to double-check.** It is the only standard table with neither a lower nor an upper range line: five lines, values −2..2, complete. A transcription that adds an upper-range line out of habit breaks Kraft equality, which is what check 2 is for.

- [ ] **Step 2: The three checks, over all fifteen in a loop**

```ts
const ALL = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] as const;

// THE ANCHOR. Annex B prints the assigned prefix CODES, not merely their
// lengths, and those codes are what B.3's assignment produces from the lengths
// in table order. The lengths and the codes are transcribed as separate
// columns, so a typo in either one breaks this equality — and a wrong
// assignment algorithm breaks all fifteen tables at once. Nothing here runs
// through an encoder of ours, unlike most of this stack.
it.each(ALL)('assigns table B.%i the prefix codes T.88 prints', (n) => {
  const t = standardTable(n);
  expect(t.lines.map((l) => l.code)).toEqual(t.lines.map((l) => l.printedCode));
});

// Every standard table is a COMPLETE prefix code. A dropped line, a duplicated
// line or a wrong PREFLEN breaks this; it is a property of what the table IS,
// so it is evidence from outside our transcription.
it.each(ALL)('table B.%i is a complete prefix code (Kraft equality)', (n) => {
  const sum = standardTable(n).lines
    .filter((l) => l.prefixLen > 0)
    .reduce((a, l) => a + 2 ** -l.prefixLen, 0);
  expect(sum).toBeCloseTo(1, 10);
});

// The columns the prefix codes cannot see. Sorted by rangeLow, the normal lines
// tile the integers with no gap and no overlap, the lower-range line continues
// downward from the first, and the upper-range line continues upward from the
// last. A mistyped RANGELOW or RANGELEN shows up here and nowhere else.
it.each(ALL)('table B.%i tiles its range contiguously', (n) => { ... });
```

- [ ] **Step 3: Decoding through a standard table**

Bit strings in, values out, chosen to hit every line kind:

```ts
const read = (bits: string) => new HuffmanReader(bytesOf(bits), 0, ...);

it('decodes a normal line, an upper range and an OOB from table B.2', () => {
  // B.2: code 0 -> value 0; 111110 + 32 bits -> upper; 111111 -> OOB.
});

// The lower-range line SUBTRACTS. It is spelled exactly like an upper-range
// line but for the sign, and adding instead would put a text-region symbol far
// off the page rather than raise an error.
it('subtracts on a lower-range line', () => {
  // B.3: the lower line's rangeLow is -257, so offset 3 decodes to -260.
});
```

- [ ] **Step 4: Prove the checks load-bearing**

Not by mutating the code — by mutating the **data**, which is what this child's risk actually is:

1. Change one PREFLEN in B.6. Expected: the anchor and Kraft both go red.
2. Change one RANGELOW in B.9. Expected: contiguity goes red, and **the anchor stays green** — which is the asymmetry that justifies having check 3 at all. Record it.
3. Reverse the order of two same-length lines in B.7. Expected: the anchor goes red, Kraft and contiguity stay green — the check that pins "in table order".

If (2) or (3) come out otherwise, the checks are not covering what this plan claims; say so rather than moving on.

- [ ] **Step 5: Commit**

---

### Task 3: Custom table segment 53 (B.2.3)

**Files:** modify `src/jbig2huffman.ts`, `test/jbig2-huffman.test.ts`

**Interface:** `export function parseCustomTable(data: Uint8Array, start: number, end: number): HuffmanTable`

- [ ] **Step 1: Implement**

```
byte 0: flags — bit 0 HTOOB, bits 1-3 (HTPS - 1), bits 4-6 (HTRS - 1)
bytes 1-4: HTLOW  (signed 32)
bytes 5-8: HTHIGH (signed 32)
then, bit-packed, MSB first:
  cur = HTLOW
  while cur < HTHIGH:
    prefixLen = bits(HTPS); rangeLen = bits(HTRS)
    line(normal, prefixLen, rangeLen, cur); cur += 2 ** rangeLen
  line(lower, bits(HTPS), 32, HTLOW - 1)
  line(upper, bits(HTPS), 32, HTHIGH)
  if HTOOB: line(OOB, bits(HTPS))
  assignPrefixCodes(...)
```

Note **HTPS and HTRS are stored one less than their value** — a three-bit field cannot hold 8. Reading them raw gives every prefix length one bit too few, which decodes plausible nonsense.

Damage guards, `PdfParseError`:
- fewer than 9 bytes of segment data;
- `HTLOW > HTHIGH`;
- the `while` loop failing to advance. `rangeLen` is at most 2^HTRS − 1 ≤ 255, so `2 ** rangeLen` cannot be zero and the loop does terminate — but it can run for `HTHIGH − HTLOW` iterations with `rangeLen` 0, which for a corrupt pair of bounds is 4 billion one-value lines. Bound the line count and refuse past it.

- [ ] **Step 2: Test with a hand-built table**

Hand-built bits rather than a minted vector: there is no encoder for this and writing one would be a second reading of B.2.3, exactly the trap `utax.1` avoided by assembling its MMR fixture from the pinned G4 encoder. A bit string is also readable, which a base64 blob is not.

Build a small table — say HTLOW 0, HTHIGH 8, HTPS 3, HTRS 3, three lines of rangeLen 2, plus lower, upper and OOB — assert the parsed lines, their assigned codes, and a decode through it.

One test must cover a **`prefixLen === 0` line**, which is the case no standard table has:

```ts
// B.2.3 writes a prefix length for every range whether or not the encoder used
// it, so an unused range arrives as prefixLen 0. It takes NO code, and
// including it in the assignment shifts every subsequent code by one — which
// decodes a different line rather than failing.
it('gives a zero-length line no code and does not let it shift the others', () => { ... });
```

- [ ] **Step 3: Prove load-bearing**

- Read HTPS/HTRS raw instead of `+ 1`. Expected: RED.
- Include `prefixLen === 0` lines in the assignment. Expected: RED on the zero-length test only.

- [ ] **Step 4: Commit**

---

### Task 4: `tablesBySeg` and the segment-53 arm

**Files:** modify `src/jbig2.ts`, `test/jbig2-assembly.test.ts`, `test/jbig2-huffman.test.ts`

- [ ] **Step 1: The fourth map**

```ts
  // Custom Huffman tables (type 53), keyed by segment number. The fourth and
  // last of the design's lookup maps. Nothing consumes it until utax.2 — a
  // table segment is stored the moment it is met, because a symbol dictionary
  // refers to it by segment number and may appear later in the stream.
  const tablesBySeg = new Map<number, HuffmanTable>();
```

- [ ] **Step 2: The arm**

```ts
      case 53: { // custom Huffman table (T.88 §B.2.3)
        tablesBySeg.set(h.number, parseCustomTable(src, h.dataStart, h.dataStart + h.dataLength));
        break;
      }
```

TypeScript will report `tablesBySeg` as unused-if-never-read depending on the lint setup — it is read by nothing until `utax.2`. Keep it and note why in the comment; do not defer it to the next child, because it is what makes the arm meaningful rather than a parse-and-discard.

- [ ] **Step 3: Move the refusal fence again**

`test/jbig2-assembly.test.ts` currently asserts type 53 refuses by name. After this child:
- a bare type-53 header with a zero-length body is a **damaged file** → `PdfParseError`, joining 16/20/22/23;
- the `default:` arm still refuses, and now has no assigned segment type reaching it, so fence it with an **unassigned** type instead — T.88 assigns 0, 4, 6, 7, 16, 20, 22, 23, 36, 38, 39, 40, 42, 43, 48–53 and 62, so 60 is free.

Say in the comment that the two remaining unsupported-*feature* refusals are now flag-driven and live in `test/jbig2-unsupported.test.ts`.

- [ ] **Step 4: An end-to-end test**

A stream of one type-53 segment plus a page-info segment must decode to a blank page rather than throwing — the table is stored and contributes no ink, exactly as an unconsumed intermediate region does.

- [ ] **Step 5: Verify everything**

```bash
npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

---

### Task 5: Documentation and close

- [ ] **Step 1: `CHANGELOG.md` — decide, do not default**

This child ships no capability a library user can reach: no file decodes today that did not decode yesterday, because nothing consumes a Huffman table yet. The changelog's stated audience is "someone deciding whether to upgrade", and `CLAUDE.md` says explicitly not to log internal work.

**The one user-visible change is the segment-53 refusal**, and it is real but narrow: a file carrying a custom Huffman table alongside otherwise-arithmetic content used to throw and now decodes. That is worth a short entry — and the entry should say plainly that Huffman *coding* still refuses, so nobody reads it as the feature landing. Do not write it up as though the Huffman path works.

- [ ] **Step 2: `CLAUDE.md`**

Name `jbig2huffman.ts` in the module list and record:

```markdown
  **Invariant:** the standard tables' printed prefix CODES are transcribed
  beside their lengths and asserted against B.3's assignment, which is the only
  outside check available on ~150 rows of hand-copied numbers. Two structural
  properties back it up because they see columns the codes cannot: every table
  is a COMPLETE prefix code (Kraft equality) and its lines tile the integers
  with no gap or overlap. Measured: a wrong RANGELOW reddens contiguity and
  leaves the code check GREEN, so neither subsumes the other.
  **Invariant:** a line with `prefixLen === 0` is unused and takes NO code. No
  standard table has one; a custom table routinely does, because B.2.3 writes a
  length for every range whether the encoder used it or not, and including them
  shifts every later code by one — which decodes a different line rather than
  failing.
  **Invariant:** a LOWER-range line subtracts. It is spelled exactly like an
  upper-range line but for the sign, and adding instead yields a large positive
  value where a large negative one was meant — a text-region symbol far off the
  page rather than an error.
  **Invariant:** HTPS and HTRS are stored one LESS than their value (§B.2.3), a
  three-bit field being unable to hold 8. Read raw, every prefix length is one
  bit short and the table decodes plausible nonsense.
```

- [ ] **Step 3: `README.md`**

Only if the segment-53 sentence needs it. The JBIG2 refusal sentence says "Huffman-coded JBIG2 throws" — still true, so it likely needs no change. Check rather than assume.

- [ ] **Step 4: Final gates, close, push**

---

## Notes for the executor

**Do not hand-verify the tables by re-reading your own transcription.** That is what the three checks are for, and they are cheap. Write the checks before the fifteenth table is typed, so the last few are transcribed against a live oracle.

**The three checks are not redundant** and Task 2 Step 4 proves it: the code anchor cannot see a `RANGELOW`, contiguity cannot see a `PREFLEN`, and Kraft cannot see line order. Each mutation in that step is aimed at exactly the one check that should catch it, and at confirming the others stay green.

**Nothing consumes any of this yet.** That is uncomfortable but correct — the alternative is landing the tables and the symbol dictionary together, where a table typo and a walk bug are indistinguishable. Resist adding a consumer "to prove it works"; the tables prove themselves.
