# XFA: split a field between its lines (`164g.13`)

A field that straddles a content-area break is refused today: in a positioned
subform (164g.11's R4), and in an `lr-tb` (164g.12's rule 7). A field in a
`tb` flow is moved whole (164g.8). Adobe Reader splits all three. This design
splits a text-like field where Adobe does, and writes it as ONE AcroForm field
with one widget per piece.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | What does a split field become? | **One AcroForm field, one widget per piece.** Each widget's `/Rect` is Adobe's piece; `/V` holds the whole value; each widget's appearance shows only its own lines. |
| 2 | Which oracle? | **New Adobe Reader probes** (t40-t54), the 164g.11 pipeline, beside the existing t6, t9-t11, t20, t21, t27, t28, t31. |
| 3 | Captioned fields | **Refused by name** when they would split: where Adobe puts a caption across a break is unprobed. |

## Evidence

Adobe Acrobat Reader 26.1, 2026-10-15 (t40-t54) and 2026-10-14 (the rest).
"Room" is the height from the field's top to the break; `top/bottom` are the
heights of Adobe's two pieces. Fields are 2in wide, fonts 10pt unless stated.

**Empty fields** (no value):

| Probe | Field h | Room | Adobe |
|---|---|---|---|
| t20 | 48 | 10 | 10/38 |
| t9 | 48 | 11 | 11/37 |
| t10 | 48 | 12 | 12/36 |
| t11 | 48 | 24 | 24/24 |
| t6 (`b`) | 72 | 36 | 36/36 |
| t43 | 48 | 36 | 36/12 |
| t42 | 48 | 38 | 38/10 |
| t21 | 46 | 40 | **30/16** |
| t41 | 48 | 42 | **32/16** |
| t40 | 48 | 46 | **36/12** |
| t44 (20pt) | 48 | 42 | **22/26** |

**Fields with text** (`line 01` ... `line 10`, one line each, multi-line `textEdit`):

| Probe | Font | Field h | Room | Adobe |
|---|---|---|---|---|
| t45 | Courier New 10 | 130 | 64 | 60/70 |
| t46 | Courier New 10 | 130 | 60 | 60/70 |
| t50 | Arial 10 | 130 | 64 | 60/70 |
| t51 | Courier New 20 | 260 | 64 | 48/212 |
| t52 | Courier New 10 | 130 | 14 | 12/118 |
| t53 | Courier New 10 | 120 | 110 | 108/12 |
| t54 (3 lines) | Courier New 10 | 130 | 64 | 64/66 |

**Parents:**

| Probe | Shape | Adobe |
|---|---|---|
| t47 | text field in a `tb` | split 96/34 |
| t48 | text **draw** in a `tb` | moved whole |
| t49 | text field, `lr-tb` line 2, room 44 | split 36/94 |
| t27 | empty 60pt field, `lr-tb` line 2, room 44 | split 44/16 |
| t28, t31 | empty field, `lr-tb`, room 14 | split 14/46 |
| t29 | field in a table row | the row moves whole |

## Design

### 1. The rules

1. **Lines.** A field's text lines sit on a grid of `1.2 x font size`
   from the field's top, whatever the font's own metrics (t45, t50: 12pt pitch
   for Courier New and Arial at 10pt; t51: 24pt at 20pt).
2. **Inside the text**, the cut snaps down to the last whole line that fits
   (t45-t47, t49-t51). At least one line must fit, or the field moves whole.
   There is no orphan or widow control (t52 keeps one line, t53 carries one).
3. **Below the text, or in an empty field**, the cut is the room left, when
   that is at least one font size (t9-t11, t20, t54).
4. **Bottom floor.** When the piece below the cut would be smaller than one
   font size, the cut moves up by EXACTLY one font size (t21, t40, t41, t44 --
   not "until the bottom is one font size", which t40 and t41 contradict). If
   the top piece is then below one font size, the field moves whole. A cut
   moved into the text snaps by rule 2.
5. **Parents.** The rules apply to a field in a positioned, `tb` or `lr-tb`
   parent. A table row still moves whole (t29); a draw never splits (t48).
6. **Refused by name** (a new child issue): a field that would split and is
   not text-like (`checkButton`, `choiceList`, `button`, `signature`,
   `imageEdit`, `barcode`, a comb `textEdit`), states a caption, a top inset,
   `vAlign` other than `top`, a `para` `lineHeight`, `orphans` or `widows`, or
   whose value mixes font sizes. Text-like means `textEdit`, `numericEdit`,
   `dateTimeEdit` and `passwordEdit`.
7. **Splitting repeats.** The piece below the cut is the field again; if it
   straddles the next break it splits again.

### 2. `src/xfafieldsplit.ts` (new, pure leaf)

`fieldCut(field: LayoutNode, room: number, lines: number | undefined)`
returns `{ cut }`, `'move'`, or `{ refusal }`. It holds rules 1-4 and 6 and
imports only `xfaflow.js` TYPES and `xfageom.js`. `lines` is the wrapped line
count of the field's value; `undefined` means it could not be counted, and a
field with a value is then refused rather than guessed at. An empty value is
0 lines. The font size is `xfasplitpos.ts`'s `fontSizeOf`, so both splitters
read one size.

### 3. Pagination

- `LayoutNode` gains `piece?: { index: number; offset: number }`: a copy of a
  field stating the piece's `h` (its `minMax` dropped), `offset` being how far
  down the original field the piece starts.
- `XfaPaginateHooks` gains `fieldLines?: (n: LayoutNode) => number | undefined`.
- **Flows** (`xfapage.ts`): rule 7 of 164g.12 (`straddle`) asks `fieldCut` for
  a field whose parent is `tb` or `lr-tb`. On a cut, the head piece joins the
  region and the tail piece replaces the leaf, retried in the next region.
  `straddle`'s `piece` is computed as today: room less the field's top in the
  candidate fragment less the bottom margins around it.
- **Positioned** (`xfasplitpos.ts`): R4's refusal is replaced. A straddling
  field asks `fieldCut` with `cut - k.top`; `'move'` keeps R2 (move the cut to
  its top), a cut leaves the consensus cut where it is. `positionedFragment`
  emits a piece of each field crossing an edge.

### 4. `xfaflow.ts`

A piece is an ordinary leaf. Nothing else changes.

### 5. Converter (`xfaconvert.ts`, `formcreate.ts`)

- `xfaLineCounter(doc, tpl, values)` counts a field value's wrapped lines
  through `xfatext.ts` with the faces `xfaMeasurer` uses; `layoutPages` takes
  it and passes it as `fieldLines`.
- `where` maps a field name to a LIST of placements. Placements on several
  pages are the field's pieces when each carries `piece`; otherwise the old
  duplicate-name refusal stands.
- A plan entry gains `widgets: Array<{ page; rect; lines: [from, to] }>`. One
  piece keeps today's merged field/widget dict, byte for byte.
- Several pieces: an internal `formcreate.ts` path creates one field dict with
  `/Kids` widgets, one per piece, each on its page. It is not public API.
- Each widget's appearance shows only its lines: `lines` is the range of the
  value's wrapped lines inside the piece, from rule 1's grid. `/V` is the
  whole value. **Stated limit:** an editor that regenerates appearances draws
  the whole value from the top of every widget; AcroForm cannot flow text
  between widgets. README's Scope and Limitations says so.
- Chrome on created pages paints each piece's border; a split field has no
  caption (rule 6).

## Risks

- DD 1494's `tb` chains may hold fields that straddle a break and moved whole
  under 164g.8. If its pdf.js comparison moves, it is investigated, not
  re-recorded.
- Our wrapped line count can differ from Adobe's where widths differ, moving
  a cut by a line. The probes use single-word lines, which do not wrap.

## Testing

**Oracle** (`test/xfa-adobe-oracle.test.ts`):
- t40-t54 vendored beside t3-t39 (`tN.xml`, `tN.pdf`, `captures/tN.png`),
  transcribed into `adobe.json`. t48 is a draw probe.
- t6, t9-t11, t20, t21, t27, t28, t31 flip from `refused` to `match`.
- A field's every fragment is compared: one widget per Adobe fragment, on its
  page, at its box.

**Unit:** `test/xfafieldsplit.test.ts` drives every rule from numbers, each
case naming its probe. `test/xfapage.test.ts` gains a field split twice, a
field in a `tb` split, and each refusal by name. A converter case checks one
field, two widgets, and per-widget lines in the appearance.

**Fences that must not move:** DD 1494 against pdf.js; fw9, I-130, I-765,
DD 1391, DD 1155, DD 2952; OPM 1644; t3-t39 other than the nine above;
q1-q15.

**Mutations, each expected to redden:**

| Mutation | Probe |
|---|---|
| pitch = font metric line height | t45, t50 |
| no snap inside text | t45, t46 |
| free cut inside text below the last line too | t54 |
| bottom floor: up to one font size instead of by one | t40, t41 |
| no bottom floor | t21 |
| no split in `tb` | t47 |
| a draw splits | t48 |
| widget appearance shows the whole value | converter case |

## Documentation

- CHANGELOG **Added**: `ConvertXfaToAcroForm` splits a text field across a
  page break where Adobe Reader does, as one field with a widget per page.
- CHANGELOG **Changed**: a field straddling a break in a `tb` subform is split
  rather than moved to the next page, as Adobe does.
- CLAUDE.md: `xfafieldsplit.ts`'s entry, the `xfapage.ts`/`xfasplitpos.ts`
  invariants, the `fixtures/xfa-adobe/` row.
- README Scope and Limitations: the editor-regeneration limit.
- `test/fixtures/xfa-adobe/PROVENANCE.md`: a section for t40-t54.

## Child issues

- Filed at the start: splitting a captioned, non-text, inset, `vAlign`ed or
  `lineHeight`/orphan/widow field (rule 6).
