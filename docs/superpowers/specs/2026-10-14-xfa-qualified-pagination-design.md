# XFA qualified pagination (164g.9) — design

## Goal

A dynamic XFA form whose `<pageSet>` states `relation="simplexPaginated"` or
`relation="duplexPaginated"` paginates and converts, where `xfapage.ts` refuses
it by name today. The epic's rule holds: what cannot be laid out is refused BY
NAME and reported, never approximated.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Scope | **One qualified page set**: `pagePosition`/`oddOrEven`/`blankOrNotBlank` selection, `pageEven`/`pageOdd` breaks with duplex filler pages, `last`/`only` termination. Nested page sets and `relevant`-chosen sibling page sets stay refused by name, filed as a follow-up. |
| 2 | Oracle | **Adobe Acrobat Reader probes**, 164g.11's harness (`scripts/gen-xfa-adobe-probes.ts`, `scripts/run-xfa-adobe-probe.ps1`). pdf.js is NOT an oracle here: it always starts on the first page area, makes no simplex/duplex distinction, has no termination processing and counts pages from 1. Where a probe contradicts the spec, Adobe wins and the reading is recorded. |
| 3 | Architecture | **A strategy inside `Paginator`**: one `chooseArea(state)` owns the qualified rule; the ordered path is untouched. Rejected: a second `QualifiedPaginator` (two engines that can disagree about a break) and incremental termination by replaying the last page from a snapshot (would have to rewind 164g.8 fragments and 164g.11 cuts mid-split). |
| 4 | Termination | **Rerun** pagination from the start with one override, page k → page area X. Accepted only if the page count is unchanged and nothing the first run placed is refused. Costs about twice the pagination work; heights are memoized. |

## Sources

XFA Specification 3.3 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`), printed
page numbers.

- **p. 295**: `relation` selects the strategy; qualified strategies choose the
  next page area by its qualifications.
- **p. 296**: `pageEven`/`pageOdd` breaks are "independent of the pagination
  strategy"; start point rule 3: "If the layout strategy is qualified it is the
  first qualified one in document order"; occur is ignored under qualified
  pagination.
- **p. 302**: "It uses the first pageArea (in document order) that has not
  already been exhausted and that has suitable qualifications." `first`,
  `last`, `only` inherently limit a page area to one use; `occur` is ignored.
- **p. 303**: `oddOrEven` is the physical surface count's parity; the count
  starts at zero; "When the pagination strategy is simplexPaginated the page is
  always assumed to be the front surface of a sheet, hence always odd."
  `blankOrNotBlank`: `blank` means included only to satisfy a `pageEven` or
  `pageOdd` break.
- **p. 304**: the layout state (position first/not-first, parity, blank);
  "If at any time during processing the layout processor cannot find a
  pageArea … that matches its state variables a fatal error occurs."
- **p. 305**: under duplex, a break to the wrong parity emits a blank filler
  page qualified for the opposite parity and `blank`/`any`.
- **p. 306 (Example 8.27)**: ends on a front surface, "so it renders another
  blank page for the back of the sheet".
- **p. 306-308**: termination. `last` redo requires the same number of content
  areas and a current page not qualified `first` or `last`; on failure a blank
  `last` page is appended. `only` takes precedence over `first` (Example
  8.29); on failure the page is kept.
- **p. 310**: a qualified page set may not nest inside an ordered one or vice
  versa; a break to a page area qualified `blank` is forbidden.
- **p. 798 (reference)**: "simplexPaginated: pageArea objects are chosen
  according to need, ignoring oddOrEven and blankOrNotBlank properties but
  taking into account pagePosition."

**The recorded spec conflict:** p. 303-304 keep simplex in the odd state, so an
`oddOrEven="even"` page area never matches; p. 798 ignores `oddOrEven`, so it
matches. Probe q3 settles it.

## Layout state and matching

- **position**: `first` until the first page of the page set is placed, then
  `rest`.
- **parity**: page i (0-based) is odd when i is even — the first surface is
  page 1. Under simplex, per q3.
- **blank**: true only for a filler page inserted by a `pageEven`/`pageOdd`
  break, or a page appended by `last` termination.

A page area matches when all hold:

- `pagePosition` is `any`, or equals position. `last` and `only` never match
  in normal layout; they are used by termination alone.
- `oddOrEven` is `any` or equals parity (simplex: per q3).
- `blankOrNotBlank` is `any`, or `blank` for a filler page, `notBlank`
  otherwise (simplex ignores it, p. 798).

The first matching page area in document order is chosen. `occur` on a page
area or the page set is ignored, with one warning per stated `occur`. No match
refuses every remaining root child, naming the state
(`no pageArea matches position=rest parity=even blank=false (XFA 3.3 p. 304)`).

**The start point** is the existing rule (p. 296); rule 3 picks the first
qualified page area rather than the first in document order.

## Breaks

- **`pageArea`/`contentArea` target**: goes to the named page area whatever its
  qualifiers say (p. 310), except one qualified `blank`, which is refused.
  Under duplex, when the target's `oddOrEven` conflicts with the next page's
  parity, a blank filler page is inserted first.
- **`pageEven`/`pageOdd`**: if the next page has that parity, move to it; under
  duplex otherwise insert one blank filler page, then the content page.
  `startNew="0"` on a current page of that parity stays. The ordered relation
  gets the same rule with its own page choice (p. 296); simplex per q12.
- A break with no target and `targetType="pageArea"` keeps today's meaning.

## Termination

At the end of content:

1. If the page set has exactly one page and a page area qualified `only`
   exists, redo that page on it. The `last` preconditions do not apply.
2. Else, if a page area qualified `last` exists and the final page's page area
   has as many content areas and is not itself qualified `first` or `last`,
   redo the final page on it.
3. A redo is `paginate(body, …, force)` with `force = { lastIndex → area }`;
   it is accepted if it yields the same page count and refuses nothing the
   first run placed.
4. A failed `last` redo appends a blank page of the `last` page area; a failed
   `only` redo keeps the page.
5. Under duplex, a document ending on an odd page gets a trailing blank page
   if q9 shows Adobe does so.

## Code changes

- **`xfatemplate.ts`**: `pageAreaOf` reads `pagePosition`, `oddOrEven`,
  `blankOrNotBlank` (default `any`); an unknown value refuses the page set by
  name. `pageSetOf` accepts the two relations; more than one page set still
  refuses, now citing the follow-up issue.
- **`xfapage.ts`**: `XfaPageAreaModel` gains the three qualifiers;
  `PaginatedPage` gains `blank?: true`; `Paginator` gains a qualified mode and
  a page state, and `chooseArea` is the one owner of matching; `nextPage`,
  `toPageArea`, `start` and `apply` call it when qualified; `apply` accepts
  `pageEven`/`pageOdd`; `paginate` takes an optional `force` map, and the
  termination pass lives beside it. Still a pure leaf that never throws.
- **`xfaconvert.ts`**: blank pages are created like boilerplate pages, master
  chrome and no body. The hybrid page-count check is unchanged.

## Probes (Adobe Reader 26.1)

Each probe's page areas carry a named draw; the docReady report adds one line
per page, `page=<n> area=<draw name>`, from
`xfa.layout.pageContent(p, "draw", true)`, beside every field's page.

| Probe | Shape | Settles |
|---|---|---|
| q1 | Example 8.25, simplex rest/first | basic selection |
| q2 | Example 8.26, duplex odd/even/first | parity |
| q3 | simplex, `even`-only area before a catch-all | the spec conflict |
| q4 | Example 8.27, duplex `breakAfter pageOdd` | filler pages |
| q5 | Example 8.28, `last` | last redo |
| q6 | Example 8.29, one item | only redo |
| q7 | Example 8.29, three items | first/rest/last |
| q8 | `last` area too short | appended blank last page |
| q9 | duplex, no breaks, odd page count | trailing back page |
| q10 | nothing matches page 1 | the fatal case |
| q11 | `pageEven` under ordered | ordered parity breaks |
| q12 | `pageEven` under simplex | simplex parity breaks |
| q13 | `blank`-only vs `notBlank` areas | filler choice |
| q14 | `occur max="1"` under qualified | occur ignored |

Probe templates live in `test/fixtures/xfa-adobe/qN.xml`, captures in
`captures/qN.png`, transcriptions in `adobe-qualified.json`; `PROVENANCE.md`
gains a section with its ceiling (one producer, one version, hand
transcription, the screen as the channel).

## Testing

- `test/xfapage-qualified.test.ts`: hand-built templates, one rule per case —
  each matching predicate, each break parity case, termination preconditions in
  both directions, the force-rerun acceptance guard.
- `test/xfa-adobe-qualified-oracle.test.ts`: each probe converted, Adobe's page
  → page area sequence and every field's page asserted exactly.
- Fence: every ordered-relation oracle (f1040, fw9, USCIS I-130/I-765,
  OPM 1644, DD forms, the 164g.11 probes) green unedited.
- Mutation sweep: one mutation per rule; the harness reports timeouts and load
  errors as such.

## Out of scope (refused by name)

- Nested page sets and breaks between page sets (p. 309-311).
- Sibling page sets chosen by `relevant="simplex"`/`"duplex"` (p. 308) — needs
  a printer-mode option.
- `duplexImposition` (no effect on page selection, p. 296).
- Page-number initialization and scripting (p. 296's note on `pageEven`).
