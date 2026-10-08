# Footnotes and endnotes in Flow (v9j3.3) — design

## Purpose

Let Flow content carry footnote and endnote references: an automatically
numbered superscript mark after a run, with the note placed at the foot of the
column holding the reference (footnotes) or after the flow's content
(endnotes), tagged as `/Note` in a tagged flow. .NET parity with
`TextFragment.FootNote`/`EndNote` and `Note`.

This issue is the ENGINE. Two child issues build on it and get their own
spec cycles once this API exists:

- `v9j3.3.1` — Markdown `[^label]` (GFM footnote extension) mapped onto it.
- `v9j3.3.2` — DOCX `w:footnoteReference`/`w:endnoteReference` mapped onto it.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Entry points | Flow API in this issue; Markdown and DOCX are `v9j3.3.1`/`.2`. |
| Note body | Arbitrary `FlowElement[]`, or `FlowText` for the common one-paragraph case. |
| Overflow | Word-style split: a note that cannot fit wholly continues at the foot of the next column(s). Whole notes are preferred; splitting is the fallback. |
| Numbering | Continuous per flow, assigned at Add time. Footnotes default arabic, endnotes lower roman. A stated `mark` takes no number. |
| Endnotes | After the flow's content, continuing in the column; `newPage` starts them on a fresh page. Each Flow owns its endnotes. |
| Reservation | Probe and shrink: `measure` reports refs in the kept content; `Render` lowers the budget until the content plus its notes fit. |
| Reference model | `FlowTextRun extends TextRun` with `footnote?`/`endnote?`; a new general `TextRun.rise` draws the superscript. |

## Public API

```ts
// flow.ts
export interface FlowNote {
  /** Note body: text/runs (one paragraph), or any FlowElements. */
  content: FlowText | FlowElement[];
  /** Explicit mark text, e.g. '*' or '†'. A stated mark consumes no number. */
  mark?: string;
}
export interface FlowTextRun extends TextRun {
  footnote?: FlowNote;
  endnote?: FlowNote;
}
export type FlowText = string | FlowTextRun[];   // widened; TextRun[] still assignable

export interface FlowNoteOptions {
  format?: 'arabic' | 'roman' | 'Roman' | 'alpha' | 'Alpha' | 'symbols';
  start?: number;              // default 1; positive integer
  markScale?: number;          // mark size / run size, default 0.6, in (0, 1]
  fontSize?: number;           // body size: footnotes 8, endnotes 10
  separator?: { width?: number; thickness?: number; color?: [number, number, number] } | false;
                               // default: rule 1/3 of the column wide, 0.5pt, black
  spacing?: number;            // gap above the separator and between notes, default 4
}
export interface FlowEndnoteOptions extends FlowNoteOptions {
  newPage?: boolean;           // default false
}
// FlowOptions gains: footnotes?: FlowNoteOptions; endnotes?: FlowEndnoteOptions;
```

`format: 'symbols'` is the sequence `* † ‡ § ¶ #` (all WinAnsi-encodable; Word's
`‖` is not, and drew nothing), doubled then tripled past
six (`**`, `††`, …), Word's convention. Roman and alpha follow the usual
rules (`alpha` past `z` is `aa`, `bb`, …, as Word does).

## `TextRun.rise`

`TextRun` (textdecor.ts) gains `rise?: number`, a baseline shift in points,
positive raising. It is general: HTML `<sup>`/`<sub>` and DOCX `w:vertAlign`
can map onto it later.

- Emitted as `Ts` before the run's `Tj` and reset to `0 Ts` after it, inside
  the same `BT…ET`. A run with no `rise` (or `rise: 0`) emits nothing new, so
  every existing output is byte-identical by construction —
  `test/rich-runs-identity.test.ts` stays UNEDITED.
- It moves INK, not LAYOUT: line bands are computed from `fontSize` exactly
  as today, and `linebox.ts` does not change. A mark at 0.6× size raised by a
  third of the run's size stays inside the ascent of the text it follows.
- Decoration and link rects follow the shifted baseline: `segmentBoxes` and
  `blockLineBoxes` add `rise` to the baseline they hand `decorRects` and
  `runLinkBoxes`, so a raised linked run is clickable where it is drawn.
- `checkRun` validates it as a finite number.

**Guard.** `resolveRuns` (stamp.ts) throws `TypeError` when a run carrying a
`footnote` or `endnote` key reaches it. Only Flow's lowering strips those
keys, so a `FlowTextRun` handed to `AddTextBlock`, a table cell, a TOC or a
`FloatingBox` is refused rather than silently drawn without its note — the
accepted-and-ignored-key trap `textedit.ts` records for `region`.

## Lowering and numbering (build time)

One function, `lowerNotes(text, state, ctx)` in the new `flownotes.ts`, runs
for `AddParagraph`, `AddHeading` and every list item's text (top-level items,
nested items and item `blocks` built through Flow's own builders).

- A run with a note becomes two runs: the body (`{ ...run, footnote:
  undefined, endnote: undefined }` minus both keys) and a MARK RUN — `text:
  mark`, `fontSize: size × markScale`, `rise: size × 0.33`, the run's own
  font, colour and link. `size` is the run's `fontSize`, else the block's.
- The mark run carries an internal `NoteRef` under a module-private `Symbol`
  key. `NoteRef` = `{ kind: 'footnote' | 'endnote', mark, id, body:
  FlowElement[] }`. A symbol key does not trip the guard above, and survives
  `sliceContent`'s `{ ...source, text }` spread, so a remainder carries its
  refs with no change to `stamp.ts`.
- Numbers are assigned in ONE pass at the start of `Render`, over the queue
  in order — which is Add order — from per-kind counters, so a mark's width
  is known before anything is measured. (Not inside `AddParagraph`: the
  builders `paragraph()`, `heading()` and `list()` are free functions with no
  flow to number against, and their elements may be composed into list-item
  `blocks` or quotes before they reach one. Lowering happens in the builders;
  numbering in `Render`.)
- `id` is `fn-<k>`/`en-<k>`, the smallest `k` whose ID is not already in the
  document's `/IDTree` (read once per `Render`), so two flows in one document
  never collide. It is assigned at tagging commit, in reading order.
- A `FlowNote` may be cited once per Render (the numbering pass refuses a
  second citation); building the same runs again for another document is fine.
- The body is lowered once: `FlowText` through `paragraph()` at the note
  `fontSize`; `FlowElement[]` used as given. Then every body element is
  wrapped in a `NoteElement` (below).
- `TypeError`, at Add time: a run with both `footnote` and `endnote`; a
  `mark` that is not a non-empty string; a `FlowNote` object referenced twice
  (in this flow); a note body containing a note reference (no nesting);
  `content` that is neither `FlowText` nor an array of objects with a `place`
  function.

**Why the mark stays with its word:** in `claim¹` the boundary is AL × AL
under UAX #14, so no break opportunity exists between them. A mark after a
space may begin a line, as in Word.

**Which refs were kept** by a placement is `refs(element) − refs(remainder)`,
by `NoteRef` identity.

## `NoteElement`

A note's body lowers to a flat array of single-child decorators sharing one
per-note holder — the pattern `quote()` and the list-item marker already
use, so a note splits across columns with no special case (`flow.ts`'s rule
that a container never paginates its children).

- The holder records the mark, the gutter width (measured mark width + 3pt
  at the body's first font size), the `/Note` struct element once created,
  and whether the label has been drawn.
- Each decorator indents its child by the gutter through `insetScale` (the
  `e1bp` floor), and fires `onCompromise('squeezed')` when it squeezes, as
  the other decorators do.
- The FIRST decorator to draw paints the mark in the gutter at the child's
  first baseline, at the body size raised like the reference mark. Drawing
  goes through the same helper `ListItemElement` uses for its marker, not a
  copy of it.
- It forwards `measure().notes` from its child (empty: nesting is refused).

## The protocol change

`FlowElement.measure` may return `notes?: readonly NoteRef[]` — the refs in
the content that would be KEPT at this budget. Absent means none.

- Originates in `TextElement` (`refs(text) − refs(remainder)`) and the list
  item body.
- Forwarded by every decorator that wraps a child: `QuotedElement`,
  `ListItemElement`, `ListBlockElement`, `IndentElement` (flowblock.ts),
  `BoxElement` (cssframe.ts), `NoteElement`.
- `CodeBlockElement`, `ImageElement`, `RuleElement`, figures and tables carry
  no refs (tables refuse them through the guard).
- `PlaceResult` is unchanged: `Render` commits the refs the final `measure`
  reported.

## `NoteColumn` and the Render loop

`flownotes.ts` holds a `NoteColumn` per column: `committed` (notes whose
references are in this column, in order) and `carry` (the unpainted
remainder from the previous column, placed first).

**`footHeight()`** is 0 with no notes, else
`spacing + separatorHeight + measureElements(carry ++ committed, width)`.
`measureElements` shares `placeElements`' gap rule, so what is reserved and
what is painted agree by construction.

**Effective bottom** = `g.contentBottom + footHeight()`. `Render` reads it at
every site that reads `g.contentBottom` today: element `availHeight`, the
float fit test (`boxTop - h >= bottom`), the float split budget, the
keep-with-next `remaining`.

**Probe and shrink.** Before placing an element whose `measure` reports refs:

1. `A = top − effectiveBottom`; `R` = refs from `measure({ availHeight: A })`.
2. If `R` is empty, place as today.
3. Else `A' = min(A, top − contentBottom − footHeight(committed ∪ R))`. If
   `A' < A`, set `A = A'`, re-measure, recompute `R`, repeat.
4. Place at the settled `A`; commit `R` to the column (footnotes) or the
   endnote list (endnotes — which reserve nothing).

`A` only decreases and there are finitely many kept prefixes, so the loop
terminates.

**Cost and identity.** `Render` places without measuring today, so the probe
is an extra `measure` per element. It runs ONLY when the flow lowered at least
one note (a flag set by `lowerNotes`); a flow with no notes takes exactly
today's path, which is what keeps every existing Flow, Markdown, HTML and DOCX
fence byte-identical by construction rather than by test.

**Collapse.** If the loop ends with nothing kept:

- not at a column start → `advanceColumn()`, like any element that does not
  fit;
- at a column start → the content plus its whole notes cannot share an empty
  column. Bisect `A` in `(0, top − contentBottom]` for the smallest budget
  whose `measure` keeps something (tolerance 0.01pt, at most 30 measures;
  this path alone), place there, and commit `R` — the notes will split.

**Paint at column close.** `advanceColumn()` and the end of `Render` call
`NoteColumn.paint(page, x, width)` before resetting. With no notes it does
nothing. Otherwise it draws the separator at `contentBottom + footHeight()`
and calls `placeElements(doc, page, carry ++ committed, [x, contentBottom,
width, footHeight() − spacing − separatorHeight])`. Its `remainder` becomes
the next column's `carry`. Painting is never incremental: the area grows as
references arrive, and note 1 must sit above note 2.

**Carry.** A carried column paints its carry first under the separator. Carry
takes precedence over new content: if carry alone fills the column, the
content gets no room and waits for the next column. Every column with carry
paints some of it, so the carry shrinks and `Render` terminates. A carried
piece that cannot split and is taller than an empty column is placed at its
natural height and reported `onCompromise('overflow')`, the main loop's rule.
After the last queue item, `Render` keeps advancing columns, creating pages,
until the carry drains.

**Endnotes.** When the queue drains, if endnotes were committed, `Render`
pushes onto the queue: a column break if `newPage`, a separator element (an
artifact rule, `spacing` above), then each endnote's `NoteElement`s in
reference order. They are ordinary flow content from there: they paginate
and split like any element. They carry no references of their own, since
nesting is refused at lowering.

## Tagging (tagged flows only)

An untagged flow emits no new marked content and no new structure.

- At commit, each note gets a `/Note` created as a CHILD of the referencing
  element's struct node (the `/P`, `/Hn` or `/LBody` holding the reference),
  so it sits in reading order right after the placed chunk containing its
  reference — for endnotes too, whose ink is at the end. This is where a
  screen reader should announce a note.
- `/Note` carries `/ID` (the `NoteRef.id`), registered in the
  `StructTreeRoot`'s `/IDTree` through `nametree.ts` (PDF/UA-1 7.9 requires
  the ID; an ID nothing resolves is half done).
- Inside the `/Note`: the gutter mark is the `/Note`'s own content (a `/Lbl`
  fails this library's ListStructure rule); body elements tag as they
  would anywhere (`/P`, `/L`, `/Figure`…) under the `/Note`, through the
  `structParent` the decorator hands its child.
- The separator rule is an `/Artifact`.
- The reference mark stays ordinary text inside the referencing element.

## Out of scope, each failing loudly

| Construct | Behaviour | Follow-up |
|---|---|---|
| Note references in table cells | `TypeError` via the `resolveRuns` guard | new issue |
| `placeElements` (single-rect `page.AddMarkdown`/`AddHtml`/`AddDocx`) | `UnsupportedFeatureError` when an element reports refs | decided in `v9j3.3.1`/`.2` |
| `elementFloat` content reporting refs | `UnsupportedFeatureError` at `Render` | unreachable today: HTML has no notes |
| `FloatingBox` with a `FlowTextRun` note | `TypeError` via the guard | — |
| Restart numbering per page | not offered | — |
| Internal links from mark to note and back | not written | new issue |

## Errors

`TypeError` for invalid option values (validated in the Flow constructor),
and the Add-time lowering errors above. `UnsupportedFeatureError` as listed.
Nothing new is thrown from inside `Render` except those two scope-outs.

## Testing

- `TextRun.rise`: emitted `Ts`/`0 Ts`, decoration and link rects on the
  raised baseline, line bands unchanged. `rich-runs-identity` unedited.
- Lowering: every format past its first wrap (`roman` 4, 9, 40; `alpha` 27;
  `symbols` 7), `start`, explicit marks consuming no number, the body/mark
  split, remainders carrying refs, every Add-time `TypeError`.
- `NoteColumn`: pure arithmetic over stub `FlowElement`s — reserve equals
  paint, `footHeight` with carry, the shrink loop's monotonicity and
  termination (a stub whose kept refs grow with the budget), the column-start
  bisect, carry draining.
- End to end, read back through extracted text and fragment positions:
  reference and note on one page; a reference near the column foot moving its
  line to the next column; a note taller than a column splitting across two;
  two-column flows; a float never overlapping the foot area; endnotes
  continuing and on a new page; a `FlowElement[]` body holding a list; a
  heading reference; a list-item reference.
- Tagging: `ValidatePdfUa` reports no `UntaggedContent` for a tagged flow
  with footnotes, endnotes and a split note; every `/Note` has an `/ID` that
  resolves through `/IDTree` to it; the `/Note` is a child of the referencing
  element.
- Guards: `AddTextBlock`, `table()`, `FloatingBox` and `placeElements` each
  refuse a note.
- Mutation-check: the effective bottom in the float fit test, the shrink
  loop's `min`, paint order, carry precedence, `/IDTree` registration, the
  symbol key surviving `sliceContent`.
