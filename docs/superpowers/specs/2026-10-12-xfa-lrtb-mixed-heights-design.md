# XFA `lr-tb`: a wrap after a line of mixed heights (`bkdi`)

`xfaflow.ts` refuses an `lr-tb` flow that wraps after a line whose items differ
in height ("the specification does not say how far below it goes"). That is the
commonest shape in US DoD DD forms: DD 1391 and DD 1155 lose every body field to
it (60 of 62 and 86 of 90 bare). This design lays the wrap out, and corrects one
164g.7 rule the same oracle disputes.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Where does the next line start? | **Below the tallest item on the line.** XFA 3.3 p. 281 says "immediately below" and leaves "below what" open; Adobe's rects close it. |
| 2 | How far does the `min*` reversal go? | **A container in a flowed parent only.** A subform whose parent's layout is `tb` or `lr-tb` does not apply `minW`/`minH`. Leaves, positioned parents and table rows/cells keep 164g.7's floor. This reverses 164g.7 decision #2 for that one case, and it is the requester's decision. |

## The evidence

Adobe LiveCycle Designer wrote both hybrids' `/AcroForm`. With `/AcroForm
/Fields` stripped, the conversion runs from the template alone and is compared
with Adobe's rects (the f1040 arrangement). Fields placed exactly (to 0.01pt):

| Rule | DD 1391 | DD 1155 |
|---|---|---|
| Refuse the wrap (today) | 2 / 62 placed | 1 / 87 placed |
| Below the tallest, `min*` applied | 62 / 62 | 80 / 84, and page 1 overflows its content area by 1.8pt |
| **Below the tallest, container `min*` not applied in a flow** | **62 / 62** | **87 / 87** |
| Below the last item, `min*` not applied | 62 / 62 | 84 / 87 |
| Below the first item, `min*` applied | 62 / 62 | 85 / 87 |
| Below the shortest item | 5 / 62 | — |

DD 1391 cannot tell "tallest" from "last" or "first"; DD 1155 can. The decisive
container is DD 1155's `…twenty9_thirty012345.thirty`: an `lr-tb` subform inside
an `lr-tb`, `minH="8.89mm"` around 8.128mm of content, on a line beside two
8.128mm items. Adobe starts the next line at 8.128mm — so `thirty` was laid out at
its content height, not its `minH`. Applying the `minH` puts four fields 2.16pt
(0.762mm) low and the page 1.8pt past its content area. It is the only container
in the six vendored hybrids whose `min*` binds at all; no leaf's minimum moves
any field position in any of them, so Adobe says nothing about leaves.

pdf.js applies `min*` only in a positioned parent. Adobe agrees with it for this
container; for leaves the 164g.7 divergence (OPM 1644's `Q1`) stands.

## Design

### 1. The wrap (`flowLrTb`)

The mixed-heights refusal is deleted. A wrap advances `y` by the line's height,
which the loop already holds as `lineH`, the tallest item on the line; `x` returns
to 0. A container's height remains the sum of its line heights. Nothing else in
the flow changes: a single item wider than the line still starts a line of its
own, and `avail` (a stated height) still refuses with 164g.8's reason.

### 2. `min*` on a container in a flow

`measure()` is memoized per node and does not know the parent. The engine
records each node's parent layout ONCE per `layoutPage`, in a `WeakMap` built by
one walk over the root, and `measure` reads it for a container: when the parent's
layout is `tb` or `lr-tb`, `grow` is called with no minimum. `max*` is still
enforced, so content past a maximum is still refused.

- **Both axes.** Decision #2 is phrased as `min*`, pdf.js treats the two alike,
  and no container `minW` binds in any fixture, so `minW` moves no oracle either
  way.
- **Only `tb` and `lr-tb`.** A table row's cells are sized by `rowCells`, which
  has its own rules; no oracle speaks to a subform in a row.
- **The page level.** A page-level subform's parent is the root subform, usually
  `tb`, so the rule reaches it too. The full oracle suite (f1040, fw9, I-130,
  I-765, the OPM 1644 pdf.js goldens) is the check that it moves nothing.

### 3. What it reverses

164g.7's decision #2 ("the spec, p. 276: a floor everywhere") becomes: a floor
everywhere except on a container whose parent flows, where Adobe does not apply
it. CLAUDE.md's `xfarich.ts`/`xfatext.ts`/`xfafont.ts` entry and the `xfaflow.ts`
entry are corrected in place; the 164g.7 spec is left as the record of what was
decided then.

## Testing

- **Oracle.** `test/xfa-real.test.ts` gains a body oracle for DD 1391 and DD 1155:
  every positioned field on Adobe's page and rect, with the exact counts pinned
  (62 and 87).
- **Unit cases** in `test/xfaflow.test.ts`:
  - a wrap after a mixed-height line starts below the tallest item, and the
    container's height is the sum of its line heights;
  - a container's `minH` and `minW` are not applied under a `tb` parent and under
    an `lr-tb` parent;
  - they still apply under a `position` parent;
  - a leaf's `minH` still applies in a flow;
  - a container's `maxH` is still refused in a flow.

  The "refuses a wrap after a line of mixed heights" case is replaced.
- **Mutations**, each expected to redden:
  - the next line below the last item;
  - below the first item;
  - container `min*` applied in a flow;
  - the `tb` arm of the rule dropped;
  - the rule extended to leaves.

  The first three redden the DD 1155 oracle. The `tb` arm and the leaf extension
  are held by unit cases alone, and the plan must confirm that.

## Out of scope

DD 1610 and DD 2952 lay out 1 page against 3 today, so d3mq could not use them as
multi-page master-field oracles. This change may unblock them, but they are not
vendored; vendoring and checking them is a follow-up issue.

## Documentation

- CHANGELOG **Fixed**: converting a DoD DD form left nearly every body field
  without a widget; it now places them on Adobe's rects.
- CHANGELOG **Changed**: a container's `min*` is not applied in a flowed parent.
- CLAUDE.md: the `xfaflow.ts` entry (the wrap rule, the parent-layout map) and
  the 164g.7 entry (decision #2's exception).
- `test/fixtures/xfa/PROVENANCE.md`: DD 1391 and DD 1155 now anchor body layout,
  not only master-page fields.
