# CSS float placement — design

**Issue:** `zch2.10` — a floated box is laid out in flow and reported; it should
narrow the channel like a real float.

**Goal:** `float: left` / `float: right` place, text wraps beside them, and
`float` leaves `skipped` the way `table` did in `zch2.6`.

## What the issue got right, and what it got wrong

**Right — the width arithmetic is done and dead.** `resolveBoxes` has taken an
optional `MeasureFn` since `zch2.3`, and **no caller passes one** (three call
sites, all omit it). An auto-width float therefore falls to `width = avail` —
full width, which excludes the whole channel and is indistinguishable from
in-flow. Connecting this is not a nicety; without it "placement" changes nothing
visible.

**Right — `floatstack.ts` is nearly CSS-ready.** `insetsAt`, `nextBoundary`,
`clearTo` and `Render`'s channel narrowing already do what CSS floats need.

**Wrong — "needs new Flow machinery" overstates it.** The engine's float branch
touches a **four-member surface** on `FloatingBox`: `width`, `spacing`,
`measure()`, `paintAt()`. Widening `FloatItem.box` to a structural interface
with those four members costs one type change and no logic, and `FloatingBox`
satisfies it unedited.

**Wrong — the title asks for splitting, which this does NOT do.** Deferring a
float whole to the next column is correct for every float shorter than a column,
needs no remainder machinery, and is what the existing `pending` mechanism
already does. Splitting is its own follow-up. **The issue is renamed rather than
closed against a title it did not satisfy.**

**Not named, and it is the first thing the approach has to solve.**
`htmlElements` returns `FlowElement[]`, which all three entry points pass
around — but a float is a `FloatItem`, which is not a `FlowElement`. `cssflow.ts`
has no way to emit one.

**Not named — `placeElements` has no floats at all.** `flowplace.ts` is 86 lines
and its own header says it is `Render`'s loop "with columns, floats,
keep-with-next and page creation removed". So `page.AddHtml` cannot place a
float by any route.

**Not named — the engine THROWS on an over-tall float** (`flow.ts:1368`,
`'floating box does not fit in an empty column'`). This epic's rule is
degrade-and-report; a CSS float must not inherit that throw.

## Decisions

1. **Defer whole, do not split.** A float too tall for what is left leads the
   next column. One taller than a whole column lays out in flow. Splitting is a
   follow-up issue.
2. **All three entry points place floats.** `flowplace.ts` gains band
   bookkeeping, because `zch2.5`'s design is that the three are one
   implementation and `html-render.test.ts` asserts they agree.
3. **Flow's "floats never share a side" rule stands.** A second same-side float
   goes below rather than beside, and reports itself. `floatstack.ts`'s
   `ActiveFloat.band` is one width from the column edge and `insetsAt` takes the
   MAX per side; side-by-side floats need a SUM, so supporting them is a change
   to the band model rather than a flag, and `AddFloatBox` runs through the same
   arithmetic.
4. **A float is a `FlowElement` carrying a marker**, not a new item type.

## Architecture

### The marker

```ts
// on FlowElement, beside the existing optional keepWithNext / clear
readonly float?: { side: 'left' | 'right'; content: FloatContent };
```

Exactly the shape `keepWithNextEligible`, `keepWithNext`, `spaceBefore`,
`spaceAfter` and `clear` already have: optional metadata the engine reads off an
element. `htmlElements`' return type does not change and `Flow.AddHtml` pushes
elements as it always did.

### `FloatContent` — the four-member seam

```ts
interface FloatContent {
  readonly width: number;
  readonly spacing: number;
  measure(): number;
  paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number;
  /** Lay out in flow rather than throwing when it cannot fit an empty column.
   *  Only the CSS adapter sets it; FloatingBox keeps throwing. */
  readonly degradeOnOverflow?: boolean;
}
```

`FloatItem.box` widens from `FloatingBox` to `FloatContent`. `FloatingBox`
satisfies the first four members with no edit — each was checked against the
class.

### The adapter

Wraps the `FlowElement[]` `mapBox` already produces for that box, plus the
resolved float width and spacing, and implements `FloatContent` by delegating to
`flowplace.ts`. **It adds no chrome of its own**: the border, background and
padding are already on those elements from `frameBoxes`.

**Invariant:** `measure()` and `paintAt()` share one walk over the elements. Two
walks is how a float comes to measure one way and paint another — the failure
this repo records more often than any other.

**Invariant, and it is what the self-review of this design caught:** the adapter
is INJECTED into `cssflow.ts`, not constructed there.

```ts
// CssFlowOptions, beside resolveFamily and resolveImage
makeFloat?: (elements: FlowElement[], width: number, spacing: number) => FloatContent;
```

Forced, not preferred. `placeElements` needs a `Document`; `FloatingBox`
captures one at construction (`doc.NewFloatingBox`), `Page.doc` is **private**,
and `paintAt` takes only a `Page` — so the adapter must capture a `Document`
too, and `cssflow.ts` is a pure leaf that may not import one. `htmlflow.ts`
already takes the `Document` and already supplies `resolveFamily` for exactly
this reason. Widening `paintAt` to take a `doc` was the alternative and is
worse: it would edit `FloatingBox`'s signature, forfeiting the "satisfies the
interface unedited" property the whole approach rests on.

**`spacing` is the float's own resolved MARGIN on the channel side**, since the
engine computes the excluded band as `width + spacing`. A float with no margin
therefore excludes exactly its own width, and text sits flush against it — which
is CSS's behaviour, not an oversight.

### `flow.ts`

Two edits, neither to the placement logic. `isFloat` widens to recognise an
element carrying the marker as well as the existing `FloatItem`; the float
branch reads its `FloatContent` from either. `resolveFloatTop`, the `pending`
deferral and the band push are untouched.

**Invariant, and it is the nicest property here: degrading is free.** Because
the marker rides ON a `FlowElement`, a float the engine declines to place is
just an element with a marker it ignores — it places in flow by the ordinary
path, frame and content intact. There is no fallback rendering path to write.
The throw at `flow.ts:1368` becomes: `FloatingBox` throws as documented, a
`degradeOnOverflow` content falls through to normal placement.

### `flowplace.ts`

Gains the same `ActiveFloat` bookkeeping from the pure `floatstack.ts` —
`insetsAt` to narrow the channel, `nextBoundary` to cap an element's height
beside a float, `clearTo` for `clear`. **This is the simpler half**: one rect, no
column carrying, so a float that does not fit is simply not floated. It also
gains a measure walk sharing the place loop's gap arithmetic, which the adapter
needs.

### Shrink-to-fit

`cellExtents` (`tableauthor.ts`, currently private) already computes the widest
LINE and widest WORD of `string | TextRun[]`, each piece at its own run's font —
which is max-content and min-content. It moves to a shared pure leaf, the
extraction `colornames.ts`, `preformat.ts`, `datauri.ts` and `bordersides.ts`
each already made. `cssflow.ts` then supplies the `MeasureFn` that `zch2.3`
built and nobody has passed, measuring a box's inline runs through it and taking
the max across children for a block-level float.

## Reporting

`float` leaves `skipped`, as `table` did in `zch2.6`. That departure is asserted
directly: a construct LEAVING the report is worth pinning too, since a caller
reads the report to tell a dropped construct from an empty document.

Two divergences remain, knowable at different times:

- **Same-side stacking is a BUILD-TIME fact.** Widths are resolved at build
  time, so `cssflow.ts` can see two same-side floats whose widths would have
  fitted side by side and report that pair as `degraded`.
- **An over-tall float degrading to in-flow is a PLACEMENT-TIME fact**, and
  `flow.AddHtml` hands `skipped` back BEFORE `Render()` runs — the structural
  limit `zch2.14` hit. It is **documented as a stated limit rather than
  reported**; a second report channel for one rare case is disproportionate.

## Testing

- The adapter's `measure()` must equal what `paintAt` consumes. One case, or the
  shared walk is pointless.
- End-to-end per entry point: text narrows beside a float (asserted on
  `GetTextFragments` x positions, NOT on "it did not throw"), the float's own
  content draws, `clear` drops past it, and all three entry points agree —
  extending `html-render.test.ts`'s existing equivalence case.
- **Fences that must not move:** `rich-runs-identity`, `html-identity`, and
  every existing `AddFloatBox` test. The `FloatContent` widening is a type change
  with no logic behind it; a red test there means it was not.
- Mutation checks on each new rule; anything uncovered is RECORDED rather than
  quietly kept.

### The oracle, and it covers half

`scripts/gen-box-goldens.ts` already drives headless Chrome and records
`getComputedStyle(el).width`, which IS the used content width — and a float's
shrink-to-fit width is exactly that. Its `PROVENANCE.md` currently excludes
floats; adding float fixtures gives browser-checked evidence for the **width**
arithmetic at near-zero cost.

**The placement half has no oracle.** Where text sits beside a float is not
observable through that corpus, and stays held by hand-built cases plus
mutation — which is what `zch2.4` already does for everything positional.
`PROVENANCE.md` must say so rather than leaving the reader to assume the corpus
covers floats now that float fixtures appear in it.

## Stated limits

- **No splitting.** Deferred whole; over-tall lays out in flow. Follow-up issue.
- **No same-side stacking.** Reported as `degraded`.
- **The over-tall degrade is silent.** See Reporting.

## Module list

Any new `src/*.ts` earns its CLAUDE.md entry when it lands, per the module-list
rule — the shared min/max-content leaf in particular.
