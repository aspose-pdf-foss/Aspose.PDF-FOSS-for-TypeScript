# css-box — provenance

Chrome's used content width and collapsed sibling gap for every element of a
set of documents, here to validate `src/cssresolve.ts` and `src/cssmargin.ts`
against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-28-css-box-model-design.md`.

**GENERATED, not vendored**, the way `test/fixtures/svg/`,
`test/fixtures/css-selectors/` and `test/fixtures/css-cascade/` are.

**Producer:** Chrome/152.0.7977.54, via puppeteer.
**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-box-goldens.ts

| File | Bytes | Cases | Rows | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | 9683 | 13 | 82 | `ba9d4c34df541054737b66a94b234ce7c49d9fd4ff079657ed4cbaf202038fe0` |

## The two numbers, and why exactly these

- **`getComputedStyle(el).width` IS the used CONTENT width** in px. Measured:
  a block in an 800px container with `padding: 10px` and `border: 5px` reports
  770px, while its `getBoundingClientRect().width` is 800 — the border box. So
  the comparison needs no arithmetic on our side and cannot drift.
- **`next.top − prev.bottom` IS the collapsed margin** between two siblings.

**The gap is the ONLY way to observe collapsing at all.**
`getComputedStyle(el).marginTop` reports the SPECIFIED margin, never the
collapsed one — measured, a wrapper whose first child has `margin-top: 40px`
collapsing through it still reports `0px`. A corpus built on computed styles,
as `test/fixtures/css-cascade/` is, could not test this rule set. That is the
whole argument for measuring geometry here.

**One measurement covers rules 1 and 2 together**, which was not obvious until
it was run: that same wrapper produces a 40px gap before ITSELF, because the
child's margin escaped it, and `wrap.top === child.top`.

Every fixture pins `html { width: 800px }` so percentages are
viewport-independent, and `body { margin: 0 }` so the UA sheet's 8px body
margin does not enter a comparison about author CSS.

## What it found on its first run

Two real defects, both in `src/`, neither in the goldens.

1. **A border edge's used width is 0 when its style is `none`.** The initial
   `border-width` is `medium` (3px) and the initial `border-style` is `none`,
   so every box that states no border carried a computed 3px per edge —
   taking 6px off the content width of every element in every document. Found
   before the corpus ran, by `test/cssresolve.test.ts`, and it is the same
   rule that forced `test/fixtures/css-cascade/PROVENANCE.md` to exclude
   `border-width` from that corpus.
2. **An empty block's collapsed margin was spent twice.** `collapseMargins`
   emitted the collapsed run before the zero-height box AND again after it —
   60px where 30px is right. The corpus caught this one; no hand-written test
   had, because the unit test asserted the same wrong pair.

## Offsets, not per-sibling gaps

The suite compares the CUMULATIVE gap from the start of each sibling list
rather than each gap on its own, because an empty block occupies no vertical
space and our model does not place it *within* the collapsed margin it sits
in. Chrome splits a 30px run as 20px before the zero-height box and 10px
after; we put all 30 after. The running total agrees, and it is the number
that decides where visible content lands.

Two rows are skipped, each for a stated reason rather than to dodge a
failure:

- **An empty block's own offset**, per the paragraph above. Every box AFTER
  it is still compared, which is what keeps rule 4 measured.
- **A box whose Chrome-predecessor generates no box here.** `<head>` is
  `display: none` in both engines, so Chrome measures `<body>` from it while
  `<body>` is our first child. Everything inside `<body>` is still compared.

`test/cssbox-suite.test.ts` asserts the NUMBER of rows actually compared, so a
skip that swallowed everything would be a red build rather than a green one.

## The ceiling — do not read the corpus past it

1. **One engine, no second to arbitrate** — as for `zch2.2.2` and `zch2.2.3`.
2. **ABSOLUTE POSITIONS ARE OUTSIDE THE CORPUS, because we produce none.**
   `zch2.3` computes no x and no y by design; widths and inter-sibling offsets
   are the whole comparison. A reader expecting a "box model" corpus to have
   checked where anything *is* will be wrong.
3. **Float WIDTHS are in it since `zch2.10`; everything else about a float is
   not.** Three fixtures resolve a float with a STATED width — plain, with
   insets, and with margins — and Chrome agrees with all of them. Two limits,
   and the second is the one to remember:
   - **Shrink-to-fit is NOT comparable.** An auto-width float's width depends
     on font metrics: Chrome renders the UA serif while the suite stubs
     Helvetica, so the numbers differ by far more than the 0.5px tolerance. It
     stays hand-tested in `test/cssresolve.test.ts` against an injected
     measurer.
   - **A float's MARGINS are invisible here, and that was measured, not
     assumed.** `zch2.10` fixed a real defect — a stated-width float fell
     through CSS 2.1 §10.3.3's over-constrained rule and absorbed the leftover
     column into `margin-right`, 326pt for a 150px float in a 601px container.
     Reverting that fix reddens **nothing** in this corpus and two cases in
     `test/css-float.test.ts`. The corpus compares CONTENT WIDTHS and the bug
     was in margins, which no row records. Do not read a green corpus as having
     checked a float's margins.
   - Float PLACEMENT — where the box sits, which text wraps beside it — is
     outside it as before: `getComputedStyle` does not report it, and every
     fixture is an only child so no sibling gap is even measured.
4. **Line breaking is outside it.** Where a line breaks is `layoutRuns`'
   answer and is pinned by that module's tests; fixture text is kept short
   enough not to wrap, so a difference there cannot reach these numbers.
5. **Inline geometry is outside it** — `inline-block`, `vertical-align` and
   inline padding are out of `zch2.3`'s scope entirely.
6. **Inline `<svg>` sizing is outside it, and that was MEASURED rather than
   assumed.** `zch2.12` added five float-free fixtures for it, regenerated them,
   and then found they pin nothing: an `<svg>` is an ATOMIC rather than a
   resolved box, so `ourRows` produces no row for it and the comparison loop's
   `if (mine === undefined) continue` skips every one — a sizing mutation that
   reddens `test/css-svg.test.ts` leaves this corpus green. The fixtures were
   REVERTED rather than kept, because 250 lines of goldens that cover nothing
   tell a reader inline-SVG sizing is browser-checked when it is not. The
   measured table lives in
   `docs/superpowers/specs/2026-09-02-inline-svg-design.md` and is fenced by
   `test/css-svg.test.ts` and `test/cssbox-svg.test.ts`.
7. **Clearance is outside it, and diverges by design.** Real clearance depends
   on where the floats are; `src/cssmargin.ts` takes the conservative reading
   that a cleared box never collapses, and the actual clearing is
   `floatstack.ts`'s through the `clear` `zch2.4` passes to Flow.

## Regenerating

Only when the fixture set grows. Re-run the command above and update the
table. If a comparison then fails it is REAL — fix `src/`, never the goldens.
