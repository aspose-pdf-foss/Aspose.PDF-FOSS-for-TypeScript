# PDF/UA-2: per-type structure shape rules (`q7hc.4.1`)

## The gap this closes

`q7hc.4` landed the part selector, the namespace model, both structure-type
vocabularies and 18 of the anchor's 90 rules — identification, metadata and the
basics of the tree. It left ISO 14289-2 8.2.5, "additional requirements for
specific structure types", almost entirely unanswered: `ValidatePdfUa(2)` today
says nothing about a table whose cells overlap, a list whose labels have no
numbering, a Ruby with the wrong child sequence, or a footnote whose `/Ref`
graph does not close.

This issue is the 8.2.5 clause in full. Fourteen of its rules are shape checks
over the tree walk `structvalidate.ts` already makes; six are the table rules,
which need an occupancy grid and the ISO 32000-2 14.8.5.7 header-association
walk. That second half is most of the work and all of the risk.

## The anchor, and what it is not

Three sources, all `integration` branch, all fetched **2026-09-15**:

- `veraPDF/veraPDF-validation-profiles`,
  `PDF_UA/2/8.2 Logical structure/8.2.5 Additional requirements for specific structure types/**`
  — **23 rule files**, of which `8.2.5.2`'s two landed in `q7hc.4`, leaving the
  **21** this issue names.
- `veraPDF/veraPDF-validation`,
  `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/gfse/` —
  `GFSETable.java`, `GFSETableCell.java`, `GFSETH.java`, `GFSEL.java`. The
  profiles state each table rule as a single predicate (`hasIntersection`,
  `numberOfColumnWithWrongRowSpan`, `hasConnectedHeader`, `unknownHeaders`); the
  algorithms that compute those predicates are here, and nowhere else.
- `veraPDF/veraPDF-parser`,
  `src/main/java/org/verapdf/tools/AttributeHelper.java` and
  `TaggedPDFConstants.java` — the attribute owner names, defaults and
  inheritance flags.

**This is a TRANSCRIPTION and NOT a runnable oracle.** veraPDF is not installed
here, a profile is a rule list rather than bytes, and the Java above is read
rather than executed. The suite will prove the implementation agrees with our
reading of the anchor. It proves nothing about whether either matches
ISO 14289-2. Do not read a green suite as conformance evidence — `72nc.1`'s
exact ceiling, which `q7hc.4` already records for the other half of this
profile.

The reason the second source is cited at all is worth stating: **a rule whose
profile predicate is a single identifier is not transcribable from the profile.**
`<test>hasIntersection != true</test>` says nothing about how cells are placed.
Every table rule in this issue is of that shape.

## Twenty rules, not twenty-one

`8.2.5.28.2-1` — a Figure shall have `/Alt` or `/ActualText` — is **already
reported, at both parts**, by `structvalidate.ts`'s `IllustrationAlt`, whose
`ILLUSTRATION` set is `Figure`/`Formula`/`Form`. It is satisfied rather than
implemented, and it is deliberately **not duplicated**: a part-2-only twin would
make a Figure with no `/Alt` report twice under two names.

The issue's acceptance criterion — "each of the 21 rules reports at part 2 and
is silent at part 1" — is therefore false for this one rule and cannot be made
true without regressing part 1. The criterion is amended to **20 new rules,
silent at part 1, plus one pre-existing rule that reports at both.**

## The twenty

Each cites its own clause through `uaClause(part, { 2: ... })`, and each opens
`if (ctx.part !== 2) return [];`.

| Clause | Rule name | Subject | Reports when |
|---|---|---|---|
| 8.2.5.8-1 | `TociRef` | TOCI element | neither it nor any descendant has `/Ref` |
| 8.2.5.12-1 | `HeadingH` | element | its standard type is `H` |
| 8.2.5.14-1 | `NoteProhibited` | element | its standard type is `Note` |
| 8.2.5.14-2 | `FENoteRefOrphan` | FENote | an element cites it that it does not cite back |
| 8.2.5.14-3 | `FENoteRefGhost` | FENote | it cites an element that does not cite it |
| 8.2.5.14-4 | `FENoteType` | FENote | `NoteType` ∉ {`Footnote`, `Endnote`, `None`} |
| 8.2.5.20-1 | `LinkEnclosure` | link annotation | its struct parent is neither Link nor Reference |
| 8.2.5.20-2 | `LinkTargets` | link annotation | a sibling link under one parent targets elsewhere |
| 8.2.5.23-1 | `RubySequence` | Ruby | kids are neither `RB,RT` nor `RB,RP,RT,RP` |
| 8.2.5.24-1 | `WarichuSequence` | Warichu | kids are not `WP,WT,WP` |
| 8.2.5.25-1 | `ListNumbering` | L | an LI child holds an Lbl and effective `ListNumbering` is `None` |
| 8.2.5.25-2 | `ListItemContent` | LI | it owns marked content directly |
| 8.2.5.26-1 | `TableCellIntersection` | TH / TD | it overlaps another cell |
| 8.2.5.26-2 | `TableRowRegularity` | Table | a column's row count differs, or a span crosses a row-grouping seam |
| 8.2.5.26-3 | `TableColumnRegularity` | Table | a row's column count differs, the counts unknown |
| 8.2.5.26-4 | `TableColumnCount` | Table | a row's column count differs, the counts known |
| 8.2.5.26-5 | `TableHeaderConnectivity` | TD | no `/Headers`, and none derivable |
| 8.2.5.26-6 | `TableHeaderUndefined` | TD | `/Headers` names an id no TH declares |
| 8.2.5.27-1 | `CaptionPosition` | element | a Caption child is neither first nor last |
| 8.2.5.29-1 | `MathMLParent` | MathML element | its parent is neither Formula nor MathML |

**Invariant: the two complementary pairs get four distinct rule names.** The
profile states 26-3/26-4 and 26-5/26-6 as pairs whose tests are exact
complements, differing only in whether the message can carry the two span counts
— so one defect reports under exactly one of the two. Mirroring that costs
nothing (the discriminating condition is already computed) and is what keeps the
transcription checkable by **comparing reports** rather than by reading code,
which is the whole value an unrunnable anchor still has.

## Design

### `structgrid.ts` — the third table grid, and why it must be a third

A pure leaf importing **nothing**: numbers and plain shapes in, findings out, so
every table rule is drivable with no PDF built — the split `tablespan.ts`,
`floatstack.ts`, `linebox.ts` and `meshtri.ts` each already make.

**Invariant, and it is the decision this module exists for: `tablespan.ts`
provably cannot answer these rules.** `buildSpanGrid` does
`while (busy[r][c]) c++` and clamps every `rowSpan` to the table end — it places
cells where they *fit*. Rule 26-1 asks whether cells *collide* and 26-2 whether
a span *overhangs*. An authoring grid is constructed so that neither can ever
happen, so reusing it would leave both rules permanently silent while looking
correct. Authoring places declared spans **legally**; validation places them **as
declared** and reports the collision. Opposite directions, no shared code.

That makes three grids in `src/`, and the repo already records the first two as
a false-friend pair: `tablegrid.ts` infers spans from gaps in ruling lines
(extraction), `tablespan.ts` places declared spans legally (authoring), and this
places declared spans faithfully (validation). The `mdscan.ts`/`htmltoken.ts`
and `cssselect.ts`/`svgcss.ts` idiom.

```ts
/** A table cell as the validator reads it off the structure tree. */
export interface GridCell {
  isHeader: boolean;            // TH rather than TD
  rowSpan: number;              // Table owner /RowSpan, default 1
  colSpan: number;              // Table owner /ColSpan, default 1
  id?: string;                  // the element's own /ID (TH only, in practice)
  scope?: string;               // Table owner /Scope, absent when unstated
  headers?: string[];           // Table owner /Headers
}

/** Which cell: the row it was declared in, and its index among that row's
 *  cells — never the slot it occupies, so the caller can map straight back to
 *  the StructElement it read. */
export interface CellAddr { row: number; index: number }

export type TableIrregularity =
  | { kind: 'intersection'; a: CellAddr; b: CellAddr }
  | { kind: 'row-columns'; row: number; span?: number }
  | { kind: 'column-rows'; column: number };

export interface StructGrid {
  rowCount: number;
  columnCount: number;
  /** The FIRST irregularity found, in the anchor's own order; absent = regular. */
  irregularity?: TableIrregularity;
  /** occupancy[r][c] — the address of the cell filling that slot, or null. */
  occupancy: (CellAddr | null)[][];
}

export function buildStructGrid(
  rows: readonly (readonly GridCell[])[],
  groupBoundaries: readonly number[],
): StructGrid;

export function headerConnectivity(
  grid: StructGrid, rows: readonly (readonly GridCell[])[],
): { cell: CellAddr; unknown: string[] } | undefined;
```

`headerConnectivity` returns the **first** disconnected TD or nothing, and
`unknown` is what selects between the two rules it feeds: **empty → 26-5** (no
`/Headers`, and none derivable), **non-empty → 26-6** (`/Headers` names ids no
TH declares, and none derivable either). That is the profile's own
discrimination — `unknownHeaders == ''` against `!= ''` — expressed as data
rather than re-derived by each rule.

### What the grid transcribes, and the four things a first reading gets wrong

All four are from `GFSETable.java` and none follows from the obvious reading.

**The column count comes from the FIRST row alone** (`getNumberOfColumns`, the
sum of that row's cells' `colSpan`). Every later row is measured against it,
which is why the profile's message reads "Table rows 1 and %1 span different
number of columns". A grid sized by the widest row accepts tables the anchor
rejects.

**The row count is not the TR count.** `getNumberOfRows` walks the TRs and, for
each, takes the **first** cell's `rowSpan`, adds it, then skips forward that many
TRs. A table whose first column spans is counted through that column. Using
`listTR.length` gives a different number for exactly the tables these rules are
about.

**A row-grouping seam is a hard boundary.** `getTR` records an index at the start
*and* the end of each THead/TBody/TFoot, and a `rowSpan` crossing one is an
irregularity — gated in veraPDF on `isPDFUA2RelatedFlavour`, which for us is
simply part 2, so the check sits inside a rule that is already part-2 only.

**Leftover empty slots are a column-count defect, not a cell defect.** After
placement, a row still holding `null` slots reports `row-columns` with
`span = columnCount − emptyCount`, which is the 26-4 variant; a TR holding no
TH/TD at all reports the same with `span = 0`. A row that is merely short
reports 26-3, with no span.

### The header walk (ISO 32000-2 14.8.5.7)

Two gates before any TD is examined, both from `checkTable`:

1. an empty table, or an irregular one, is **connected by definition** — there is
   nothing to associate;
2. if **every** TH in the table carries an explicit `/Scope`, the table is
   connected and **no TD is checked at all**.

Only then is each TD tested. A TD is connected when its `/Headers` is non-empty
and every id in it is declared by some TH, or when the walk finds a header:

- **upward**, for each column the cell covers, from the row above to row 0:
  a TH whose effective scope is `Column` or `Both` connects. Scanning a column
  stops once a run of THs has ended — `headerFound && !isTH → break`.
- **leftward**, for each row the cell covers, from the column to the left to
  column 0: a TH whose effective scope is `Row` or `Both` connects, with the
  same stop.

The cell at (0,0) is skipped, and only a cell's own origin slot is examined
rather than every slot it spans.

**Invariant: an absent `/Scope` is not "no scope".** `GFSETH.getDefaultScope`
supplies one from position — **(0,0) → `Both`, row 0 → `Column`, column 0 →
`Row`, otherwise → `Both`**. Defaulting to absent instead makes the walk find
nothing and reports every TD in every table with unscoped headers, which is most
real tables.

### Three small modifications

**`struct.ts` — `StructElement.Refs`.** The `/Ref` **key**: an array of
references to other structure elements (ISO 32000-2 14.7.5.4), read by the TOCI
rule and both FENote graph rules.

**Invariant, and it is a hazard rather than a nicety:** `StructElement.Ref`
already exists and is the element's **own object reference**. `Ref` and `Refs`
are one letter apart and name unrelated things, so the accessor carries a doc
comment saying so. A future reader reaching for `el.Ref` in a `/Ref` rule gets a
`PdfRef | undefined` that type-checks in some positions.

**`structattr.ts` — an `FENote` owner, and an inheriting `ListNumbering` read.**
The owner name is `FENote` and `NoteType`'s default is `None`
(`AttributeHelper.getNoteType`), which is why an **absent** `NoteType` passes
8.2.5.14-4 rather than failing it.

**Invariant, and first principles get it wrong: `ListNumbering` is
INHERITABLE.** `AttributeHelper.getListNumbering` passes `isInheritable = true`
and walks `/P` until it finds a value, falling back to `None`; `NoteType` and
`Scope` pass `false`. So a nested `L` inherits its ancestor's numbering and does
**not** report, while an absent value anywhere in the chain reads as `None` and
**does**. Both halves are the rule: the existing `readList` does not inherit, so
the validator needs the inheriting read and cannot simply call it.

**`structvalidate.ts` — `WalkedNode` gains the parent ELEMENT** beside
`parentType`. The MathML rule needs the parent's *namespace*, which a type
string cannot supply. Additive to a private interface and invisible to part-1
output.

Rules are **appended** to `RULES`, so the part-1 report order is unchanged —
`q7hc.4`'s own invariant, fenced by `test/pdfua-part1-identity.test.ts`.

### What needs nothing new

The link rules reach their annotations through
`StructTreeRoot.ElementForObject(structParentKey)`, which already exists for
exactly this. `StructElement.ID`, `Children`, `ContentItems`, `Namespace` and
`TableAttributes` are all already public and already correct.

## Deliberate divergences, each recorded in source

**`8.2.5.28.2-1` is satisfied, not implemented.** Covered at both parts by
`IllustrationAlt`; duplicating it would double-report. The one rule of the 21
that is not silent at part 1.

**The first-failing-TD stop is mirrored.** `GFSETable.hasHeaders` returns on the
first disconnected TD, so a table with fifty of them reports one finding. That
is veraPDF's model-population artifact rather than a stated rule of
ISO 14289-2 — but our finding count is the only thing an unrunnable anchor can
still be compared on, and a differing count would be indistinguishable from a
transcription bug. Noted in source so that widening it later reads as a decision
and not a fix. Rule 26-1 is the exception and marks **both** cells of a
collision, because `checkRegular` does.

**8.2.5.20-1 passes a link annotation with no struct parent.** The test is
`… || structParentType == null || isArtifact == true`. An untagged link
annotation therefore does not report under this rule. It reads wrong; it is what
the profile says, and a link outside the structure tree is caught by
`UntaggedContent` instead.

**Nothing here is widened to part 1.** Several of these rules would be
meaningful at part 1 and the `PDF_UA/1/` profile carries some of them. Widening
changes shipped behaviour, which is the acceptance criterion `q7hc.4` set and
this issue inherits. `q7hc.4.5` is where part 1 grows.

## Testing

- **`test/structgrid.test.ts`** — the grid and the header walk from hand-built
  numbers, no PDF built: first-row column count, the skipping row count, seam
  crossing, leftover slots, both complementary variants, and all four arms of
  the default-scope table.
- **`test/pdfua2-structure.test.ts`** — each of the 20 rules as a cross-part
  **PAIR**: it reports at part 2 **and** is silent at part 1. `72nc.1`'s shape,
  and the reason is not ceremony — a single-part assertion provably cannot tell
  a rule that correctly went quiet from one that was never wired up.
- **`test/helpers/build-irregular-table-pdf.ts`** — the deliberately irregular
  spans the issue's acceptance criterion names, built both ways (regular and
  irregular) so the regular case proves the rule is not simply firing always.
- **`test/pdfua-part1-identity.test.ts` must pass UNEDITED.** If it needs
  editing, the change is wrong.

**Fixture traps, recorded in advance because each measures nothing if got
wrong:**

- A **uniform** table cannot see the default-scope table at all — every arm
  agrees when every TH is in row 0. The fixture needs a header column as well as
  a header row, and a cell at neither (0,·) nor (·,0).
- A table whose THs all carry an explicit `/Scope` never reaches the per-TD walk
  (gate 2 above), so a fixture built the obvious way leaves 26-5 and 26-6
  unmeasured whatever the code does.
- An **irregular** table short-circuits the header rules entirely, so the header
  fixture must be regular and the regularity fixture must not be reused for it.
- `Ref`/`Refs`: a FENote fixture whose `/Ref` graph is symmetric cannot separate
  26-2's orphans from 26-3's ghosts. Each needs its own one-sided graph.

**Mutation checks** on: the first-row column count (versus the widest row), the
skipping row count (versus `listTR.length`), each arm of the default-scope
table, the seam-crossing check, the `ListNumbering` inheritance walk, and the
`Refs`/`Ref` accessor. Anything that reddens nothing is recorded as uncovered
rather than assumed covered.

## Acceptance

- Each of the 20 new rules reports at part 2 and is silent at part 1, asserted
  as a pair.
- `8.2.5.28.2-1` is asserted as reporting at **both** parts under
  `IllustrationAlt`, so its exemption reads as a decision.
- A deliberately irregular table reports under 26-1, 26-2 and 26-3/26-4 as its
  shape selects, and a regular one reports under none of them.
- A regular table with unscoped headers and a disconnected TD reports exactly
  **one** 26-5 finding.
- `ValidatePdfUa()` is byte-identical at part 1 and every existing UA test passes
  unedited.
- `npm run typecheck`, `npm test` and `test/import-cycles.test.ts` green, the
  last with the same 15 pairs — `structgrid.ts` imports nothing, so it closes no
  cycle.

## Out of scope

- The other 51 anchor rules — `q7hc.4.2` (annotations and forms, 25), `.3`
  (fonts and CMaps, 15), `.4` (PUA, language, optional content, destinations,
  embedded files, 11). With `q7hc.4`'s 18 and this issue's 21, that is the
  anchor's 90.
- **Conversion.** Nothing here is repairable without inventing content: a
  missing `/Alt`, a numbering scheme, a header association or a row's worth of
  cells are all authorial. `ConvertToPdfUa` is untouched and these rules land in
  `unresolved`.
- Widening any of these rules to part 1 — `q7hc.4.5`.
- Any use of the grid outside validation. It is not a table model and it is not
  `tablespan.ts`'s replacement.

## Structurally significant children — the rule under all of these

Every rule here that reads "children" reads them as
`GFPDStructTreeNode.getStructuralSignificanceChildren()` does, and that is not
`StructElement.Children`:

```java
// GFPDStructTreeNode.java:140                  // PDStructElem.java:173
if (PDStructElem.isPassThroughTag(child.getstandardType())) {
    result.addAll(child.getStructuralSignificanceChildren());   // recursive
} else { result.add(child); }

static boolean isPassThroughTag(String t) {     // NON_STRUCT / DIV / PART
    return "NonStruct".equals(t) || "Div".equals(t) || "Part".equals(t);
}
```

**Invariant: `NonStruct`, `Div` and `Part` are TRANSPARENT, recursively.** A
pass-through element contributes its own children in its place, at any depth. So
a `<Table><Div><TR>…` has that TR as a row, a Ruby wrapping its RB in a Div
still matches `RB,RT`, and a Caption inside a Div is the parent's first child
for 8.2.5.27.

`Part` is the surprising member — it is a grouping element rather than a wrapper,
and a first reading treats it as opaque. Left opaque, a table whose rows are
grouped under `Part` has **zero** rows and is reported regular by default, which
is a silent false negative.

This is one shared helper in `structgrid.ts`'s consumer rather than a rule each
of the six sites repeats, and it is mutation-checked: making the walk
non-transparent must redden the Ruby, Warichu, table-row and Caption fixtures.
