# XFA to AcroForm — mutation results (`6t2v.3`)

What was changed, what went red, and — for the rules that reddened nothing —
why, and what holds them instead. Recorded so a later reader can tell a rule the
suite covers from one it merely states.

Reproduce with `docs/superpowers/plans/2026-09-09-xfa-to-acroform.md`'s Task 12,
or by hand: apply the change, run the six XFA test files, revert.

## The seven the design names

Run against `test/xfageom.test.ts`, `test/xfatemplate.test.ts`,
`test/xfadata.test.ts`, `test/xfapacket.test.ts`, `test/xfaconvert.test.ts` and
`test/xfa-public-api.test.ts`. Baseline 0 failed, and 0 again after every
revert.

| # | Mutation | Red | Files |
|---|---|---|---|
| 1 | `rectFromBox`: `ury = crop[1] + box.y` (flip the y-axis) | **5** | xfaconvert, xfageom |
| 2 | `valueEntries`: write `defaultValue` to `/V` and `value` to `/DV` | **5** | xfaconvert |
| 3 | `accumulateOrigin`: read only the last offset | **3** | xfaconvert, xfageom |
| 4 | `itemsOf`: `lists[0]` is export, `lists[1]` display | **2** | xfaconvert, xfatemplate |
| 5 | `buildXfaPlan`: skip the `mediumAgrees` check | **2** | xfaconvert |
| 6 | `chainIsPositioned`: test only the last layout | **2** | xfaconvert, xfageom |
| 7 | `fieldOf`: `readOnly: false, required: false` | **4** | xfaconvert, xfatemplate |

## Fixtures that had to be REBUILT because the obvious one measured nothing

Four, and each passed with the bug in place before it was rewritten. This is the
part worth reading before adding a case here.

1. **The `<items>` pairing.** Written the natural way — `save="1"` on the FIRST
   `<items>` list — "the save list" and "the first list" are the same list, so
   hard-coding the halves by position reddens **nothing**. Measured at 0. The
   display list is written first now (`PAIRED_ITEMS_TEMPLATE`, and the
   `xfatemplate.ts` case), and the mutation reddens 2.

2. **Reconciliation leaving geometry alone.** `{HYBRID}`'s widget rect was
   `[72 628 288 648]` — exactly what `POSITIONED_TEMPLATE` computes — so
   "leaves the existing rect alone" was green with `applyReconcile` rewriting
   `/Rect` unconditionally: the two values agreed. It is `[100 100 300 120]`
   now, and that mutation reddens 2.

3. **The `/XFA` removal guard.** The obvious "converted nothing" fixture
   (`template: '<template/>'`) returns EARLY — entries and groups both empty —
   before the removal is reached, so removing `/XFA` unconditionally left it
   green. It takes a template whose SOM path descends THROUGH an existing
   terminal field, which plans a real entry that then fails to apply; that case
   reddens 1.

4. **The y-flip.** A field at the page centre lands identically under both
   readings. `Y_FLIP_TEMPLATE` puts it 0.5in from the page TOP, against a
   CropBox with a non-zero origin so the offset is pinned too.

## Rules that redden NOTHING, and what holds them instead

Recorded rather than deleted. Do not read the green suite as covering these.

- **The positioned-to-bare fallback** in `convertXfaToAcroForm`'s apply loop.
  Structural, not a fixture gap: of everything `createField` throws on — an
  out-of-range page, a non-finite rect, a malformed name, a path conflict — the
  plan phase has already excluded all but the conflict, and a conflict fails
  `applyBare` for the same reason. So the two provably cannot disagree as the
  code stands. Retained as defence, because the plan phase's guarantees are the
  only thing making it dead. Noted in the source at its site.

- **The signed-refusal ORDERING.** That it runs before `buildXfaPlan` rather
  than after is not observable without a spy: both orders throw, and the plan
  phase allocates nothing either way. Held by reasoning. What IS covered is that
  it throws at all (1 case).

## The oracle, and what it changed

`test/fixtures/xfa/` now holds two hybrid LiveCycle Designer 6.5 forms, and
`test/xfa-real.test.ts` compares a template-only conversion against the
`/AcroForm` Adobe wrote. See that directory's PROVENANCE.md.

**It found a bug no mutation could have.** Mutation testing proves the suite
notices when the code changes; it cannot notice a rule nobody wrote. The design
never mentioned `<caption>`, so no fixture had one and no mutation targeted it —
yet an XFA field's box includes its label and the widget covers only the edit
region. Worst rect error across 151 placed fields: **229pt before, 12pt after**,
with 100 of 151 inside 1pt. Disabling the caption rule now reddens 2 cases in
`xfa-real.test.ts`.

It also **confirmed the layout-chain interpretation**, which was reasoned when
the feature was written: f1040's root subform is `layout="tb"`, so reading the
chain from the document root would place ZERO fields. It places 151.

### Still not covered, after the oracle

- **One producer.** Evidence for the forms it covers, not conformance. No second
  XFA implementation arbitrates our output.
- **Positioned layout only** — a flow-laid field has no Adobe rect to compare
  against either.
- **Two residual geometry rules**, measured and filed: `<checkButton size>` and
  border/margin insets. The rect assertion is a bound, not an equality, for
  exactly that reason.
- **`px` / `pc` / `em`, non-`topLeft` anchors and `<occur>`** appear in neither
  fixture and remain builder-covered only.
