# XFA read and flatten to AcroForm (`6t2v.3`)

## The decision this records

`6t2v.3` was filed as a scope decision: read XFA and flatten it to an AcroForm,
or decline outright. The answer is **build it**, and this spec is the design.

The issue's own framing needed correcting first, because its "pragmatic subset"
— read plus flatten, explicitly without the dynamic layout engine — is close to
an empty set as written. The two XFA flavours divide exactly against it:

- **Static / hybrid XFA** already carries a complete `/AcroForm`: real fields,
  widget annotations, appearance streams. This library reads and edits that
  today. There is nothing to flatten; the AcroForm is already there and already
  authoritative for every viewer but Acrobat.
- **Dynamic XFA** carries a shell AcroForm (typically one "open this in
  Acrobat" page), `/NeedsRendering true`, and *no field geometry anywhere* —
  pages and positions are computed by the layout engine at view time. There is
  nothing to flatten *to* without running that engine.

So the subset as filed helps the documents that need no help and cannot help
the ones that do. What rescues it is a finding the issue did not have: **XFA
geometry is not all-or-nothing.** A `<subform>` carries a `layout` attribute,
and `layout="position"` states absolute `x`/`y`/`w`/`h` on its children. Static
and XFAF forms — the LiveCycle output that dominates the archived corpus — are
positioned throughout, so their field rects are *stated in the template*, not
computed. Only the flow layouts (`tb`, `lr-tb`, `row`, `table`) need the engine
we are excluding.

That is what this design builds on: a **guaranteed floor** of a geometry-less
field tree for anything flow-laid, and **real widgets wherever the template
itself supplies the numbers** — with a report that makes the difference visible
rather than silent.

## Scope

**In:**

- Decoding `/AcroForm /XFA` (single-stream XDP, or the alternating name/stream
  array) into named packets.
- Modelling the `template` packet's field set: SOM names, UI types, `<items>`,
  flags, defaults, tooltips.
- Binding values out of the `datasets` packet.
- Emitting a real `/AcroForm` field tree: **widgets with rects and appearance
  streams** where the template's layout chain is positioned throughout,
  **geometry-less field dicts** otherwise.
- Reconciling with an existing AcroForm in a hybrid document (name equality —
  update `/V`, create nothing).
- Removing `/XFA` and `/NeedsRendering` on success, by default.
- One public entry point returning a report.

**Out, and each deliberately:**

- **The dynamic layout engine.** No text measurement, no box growth, no
  repeating subforms, no flow stacking. A field whose ancestor chain contains
  any flow layout gets no geometry, ever — see *Never an approximate rect*.
- **Approximate geometry of any kind.** Rejected as an approach: a field drawn
  in the wrong place looks right and is wrong, which is the failure shape this
  repo guards against everywhere (`raster.ts`'s stencil polarity,
  `bmpencode.ts`'s row order, the two mesh record encodings). It is also the
  first step onto the slope the issue excluded, and once one flow mode is in,
  the argument for the next is the same argument.
- **XFA scripting** (`<calculate>`, `<script>`, FormCalc, the event model).
  Nothing here executes anything. `<validate nullTest>` is read as a *flag*,
  not run.
- **Writing XFA back.** Conversion is one-way. Syncing AcroForm edits into the
  `datasets` packet so a hybrid's two halves stay consistent is a coherent
  separate feature and is *not* this one.
- **Rendering an XFA form.** A converted dynamic document has addressable field
  data; it does not gain the pages the layout engine would have built.
- **`<imageEdit>`, `<barcode>`, `<signature>` fields.** Refused and reported,
  never synthesized. The signature refusal matches the existing rule that there
  is no `SignatureField` because a signature field is not creatable.
- **Any change to `pdfaconvert.ts`.** It deletes `/XFA` outright today
  (`pdfaconvert.ts:452`). The useful order becomes `ConvertXfaToAcroForm` then
  `ConvertToPdfA` — the fields survive as a real AcroForm and the PDF/A rule is
  satisfied for free. That is documentation; touching the converter would move
  existing bytes and tests for no gain.

## Architecture

Five modules, following the split this repo makes everywhere — `svgdraw.ts`
walks and `svgembed.ts` alone touches a `Document`.

- **`xfapacket.ts`** — locates `/AcroForm /XFA` and decodes it to named
  packets. `/XFA` is either a single stream holding a whole XDP or an array of
  alternating name/stream pairs (`config`, `template`, `datasets`, `form`, …),
  so this owns that duality and nothing else does. It takes `resolve` and
  `inflate` as **arguments** rather than importing `document.js` — the seam
  `colorimage.ts` and `dfont.ts` already use — so every rule is drivable from a
  hand-built dict.
- **`xfatemplate.ts`** — pure. The `template` XML to an `XfaField[]` model:
  SOM path, UI kind, items, flags, default value, tooltip, the raw geometry
  attributes, and the `layout` of every ancestor. Imports `xml.js` alone.
- **`xfadata.ts`** — pure. The `datasets` packet to values by data path, plus
  the rules that join a template field to a datum: implicit name match, an
  explicit `ref`, and the `match` modes.
- **`xfageom.ts`** — pure arithmetic, importing **nothing**. Measurements to
  points, offset accumulation, anchor resolution, page resolution, the y-flip.
  This is the `floatstack.ts` / `booklet.ts` / `tablespan.ts` split, for their
  reason: geometry that is silently wrong when reversed must be testable from
  numbers with no PDF built.
- **`xfaconvert.ts`** — the only module here that touches a `Document`. Drives
  the other four, calls `createField` / `addRadioGroup` for positioned fields,
  builds bare field dicts otherwise, drops `/XFA` and `/NeedsRendering`, and
  assembles the report.

`document.ts` gains one method delegating to `xfaconvert.ts`. `index.ts`
exports the entry point and the report types and nothing else — the packet,
template and data models stay internal until a caller asks for them, the
posture `parseHtmlFragment` takes.

### Two constraints from `xml.ts` that shape this

**It strips namespace prefixes** (`xml.ts:38`), so `xfa:datasets` arrives as
`datasets`. Convenient, and it means the model must never rely on a prefix to
disambiguate two elements.

**It throws `PdfParseError`.** A damaged XFA packet must cost the conversion,
not the open, so `xfapacket.ts` catches at the one place the throwing parser is
called and turns it into a reported refusal — `markdown.ts`'s and
`htmltoken.ts`'s "damage is a value, never control flow", applied at the
boundary rather than by changing `xml.ts`, whose strictness four other callers
depend on.

## The template to AcroForm mapping

`xfatemplate.ts` walks `<subform>` / `<exclGroup>` / `<field>` and yields one
`XfaField` per terminal. The `<ui>` child selects the type:

| XFA | AcroForm |
|---|---|
| `<textEdit>` | `/FT /Tx`; `multiLine="1"` adds `FF_MULTILINE` |
| `<numericEdit>`, `<dateTimeEdit>` | `/FT /Tx`, value rendered as text |
| `<passwordEdit>` | `/FT /Tx` + `FF_PASSWORD` |
| `<checkButton>` in a `<field>` | `/FT /Btn` checkbox |
| `<checkButton>` inside `<exclGroup>` | one `/Btn` + `FF_RADIO` parent per group, kid widgets per option |
| `<choiceList open="userControl">` | `/FT /Ch` + `FF_COMBO` + `FF_EDIT` |
| `<choiceList open="multiSelect">` | `/FT /Ch` + `FF_MULTISELECT` |
| `<choiceList>` otherwise | `/FT /Ch` list box |
| `<button>` | `/FT /Btn` + `FF_PUSHBUTTON` |
| `<signature>`, `<imageEdit>`, `<barcode>` | refused and reported |
| `access="readOnly"` \| `"protected"` | `FF_READONLY` |
| `<validate nullTest="error">` | `FF_REQUIRED` |
| `<value><text maxChars="N">` | `/MaxLen` |
| `<items save="1">` + display `<items>` | `/Opt`, through `choiceopt.ts` |
| `<assist><toolTip>` | `/TU` |

### Invariant: the synthesized name is the SOM expression

Occurrence indices included — `form1[0].Page1[0].f1_01[0]`. Not cosmetic: that
is exactly what LiveCycle already writes into a hybrid's `/AcroForm`, so
reconciling the two halves is a name equality rather than a heuristic, and an
FDF exported from a converted document stays interchangeable with Acrobat's. An
anonymous container is transparent to the path, as SOM defines it.

### Invariant: `/Opt` is written through `choiceopt.ts` and nowhere else

This repo already records that an `/Opt` entry's export half is what `/V`
carries and its display half is what gets drawn, and that every consumer which
re-derived that grammar got one of the two wrong — a list box highlighting
nothing, a combo drawing the export value. XFA states the same pair by another
spelling: two parallel `<items>` lists, the one carrying `save="1"` being the
export side. It is converted into `NormalizedOption` and written by the one
existing writer.

### Invariant: values come from `datasets`; the template `<value>` is `/DV`

Conflating them destroys the difference between what the form was authored with
and what someone entered — which, for the filled archived forms this feature
exists to open, is the entire content.

### Invariant: a signature field is refused, not synthesized

Matching `formfield.ts`'s existing rule. Reported, so the absence is visible
rather than a silently missing field.

### The hybrid case falls out

Where a field of that full name **already exists** in the AcroForm, nothing is
created: its `/V` is updated from `datasets` and its geometry is left alone,
reported as `reconciled`. The static-document sync is obtained by name equality
rather than by a second code path.

## Geometry

`xfageom.ts` is pure arithmetic over numbers and the template's attribute
strings.

**Measurements.** A value is a number plus a unit. `in`, `pt`, `cm` and `mm`
are unambiguous and convert directly to points. **`px` and `pc` are not**, and
their reading must be *transcribed from the XFA specification with the clause
cited* — the discipline `ccitt-tables.ts` and the JBIG2 SLTP constants already
follow — rather than guessed at, then pinned against a real form. This is an
explicit task in the plan, not an assumption to be discovered later.

**Positioned versus flow.** A field earns geometry only when **every** ancestor
in its chain is `layout="position"`. One `tb`, `lr-tb`, `row` or `table`
anywhere above it and the field degrades to geometry-less and is reported. The
test is on the whole chain, not the immediate parent, because a positioned
subform inside a flowed one has no fixed origin of its own — precisely the case
where a plausible wrong answer is available.

**Offsets and anchors.** Positions accumulate from the page origin down through
the chain, adding each container's own `x` / `y` and a `<contentArea>`'s origin
where the chain passes through one. `anchorType` (default `topLeft`, plus the
eight others) shifts what `x` / `y` names by half a width or a height — ten
lines of arithmetic, worth implementing rather than refusing. A field carrying
`rotate` degrades: rotation would need the widget `/MK /R` plus `/Matrix` dance
`appearance.ts` already documents as its own trap.

**The y-flip**, from XFA's top-left, y-down frame to the page's CropBox:

```
llx = cropLeft + X
ury = cropTop  - Y
urx = llx + W
lly = ury - H
```

`/Rotate` needs no handling — an annotation `/Rect` is in unrotated default user
space and the viewer applies the rotation, which is the rule this library
already states for annotation coordinates.

### Invariant: the medium must agree with the page

A `<pageArea>`'s `<medium short long orientation>` states the page size the form
was authored for. Before any field on that page is given a rect, that medium is
compared against the PDF page's CropBox — `orientation="landscape"` swapping
`short` and `long` — and on a mismatch of more than **1 pt on either axis**
**every field on that page degrades to geometry-less** and the page is
reported. One point is tight enough that a unit error cannot pass (the smallest
of them, `pt` read as `px`, moves an A4 edge by tens of points) and loose enough
to absorb a producer's rounding of `8.5in` to three decimal places.

This is the check that makes the rest trustworthy. It asserts against a number
we did not compute, so one comparison catches a unit-conversion error, an
orientation swap and a wrong page mapping alike — the discipline this repo
states as *to check an interpreter, assert against something outside it*.

Page identity is `<pageArea>` order to page index. A `pageArea` count that
disagrees with `doc.Pages.length` degrades the whole document's geometry rather
than aligning the two by guess.

### Invariant: never an approximate rect

There is exactly one way a field gets a rect, and every failure of it produces a
geometry-less field plus a report entry. No fallback estimates a position from a
sibling, a caption, or a flow order.

## Conversion order, report and refusals

### Invariant: plan fully, then apply

`xfaconvert.ts` first builds a complete `XfaPlan` — packets decoded, template
modelled, data bound, geometry computed, every field classified as positioned /
bare / reconcile / refused — **allocating nothing**. Only if that plan holds
anything does it apply.

This is `formcreate.ts`'s own rule scaled from one field to a document:
creation "validates every argument *and* the whole field path before allocating
any object, so a rejected call leaves the document byte-identical", and "the
path is walked twice — a single fused pass strands orphan nodes when a conflict
is found deeper down". A form we cannot convert leaves the file untouched
rather than half-populated.

**Apply order:** `ensureAcroForm`; then reconciles (existing fields, `/V`
only); then creations — positioned fields through `createField` /
`addRadioGroup`, so the widget dict, the `/AP` generation and the page
`/Annots` wiring all reuse existing code, and bare fields as plain field dicts
appended through `resolvePath` / `appendField` with no `/Subtype /Widget`, no
`/Rect` and no `/P`. Then `/XFA` and `/NeedsRendering` go.

No `TouchedObjects` is threaded: that seam exists for incremental signing, and
a signed document is refused outright (below).

### `/XFA` removal is default-true and optional

`{ removeXfa: false }` keeps it. Removal is one-way and discards the only
description of anything refused, so the caller can decline it. Worth being
plain that the removal itself destroys nothing immediately — it orphans the
packet streams, and it is `Save()`'s mark-sweep that drops them, so a caller
who dislikes the report can simply not save.

### Report

Mirroring `ColorConvertReport` / `ColorSkipped`, which is this repo's idiom for
a per-item conversion with visible refusals.

```ts
interface XfaFieldResult {
  /** SOM path, e.g. 'form1[0].Page1[0].f1_01[0]'. */
  name: string;
  type: FieldType;
  route: 'positioned' | 'bare' | 'reconciled';
  /** 1-based, positioned fields only. */
  page?: number;
}

interface XfaSkipped {
  what: 'document' | 'packet' | 'page' | 'field';
  /** SOM path for a field; absent for a whole-packet or whole-page refusal. */
  name?: string;
  reason: string;
}

interface XfaConvertReport {
  /** Which XDP packets were found, e.g. ['config', 'template', 'datasets']. */
  packets: string[];
  fields: XfaFieldResult[];
  /** What did not convert, and why. The first place to look when a converted
   *  document is missing a field or renders nothing. */
  skipped: XfaSkipped[];
  xfaRemoved: boolean;
  /** At least one field converted and NONE got geometry: the document converts
   *  to data and renders nothing. False for a document that converted nothing
   *  at all, which is a different answer and must not read as the same one. */
  dataOnly: boolean;
}
```

### Refusals

Exactly one throw: **`UnsupportedFeatureError` on a signed document**, matching
`ConvertToGrayscale`. `docmdp.ts` permits `/AcroForm /Fields` to change for
*filling* (`ACROFORM_ALLOWED`, `docmdp.ts:62`), and adding two hundred fields is
not filling — a certification would read as violated, so refusing is the honest
answer rather than producing a document whose signature silently fails.

Everything else is a value:

- no `/XFA` at all yields an empty report with a `document` skip, not an error —
  `ConvertToPdfA` likewise does not throw at an already-conformant file;
- a malformed packet is caught at the `parseXml` boundary and reported;
- a per-field failure costs that field and nothing else.

## Public surface

```ts
doc.ConvertXfaToAcroForm(opts?: XfaConvertOptions): XfaConvertReport
```

with `XfaConvertOptions` holding `removeXfa?: boolean` (default `true`).
Explicit and one-way: nothing changes for existing callers, `doc.Form` keeps
walking only fields the document actually contains, and `Field.Dict` stays a
dict the file holds.

## Testing and the oracle

### The anchor is the hybrid document itself

A static XFA form carries *two independent descriptions of the same field set*:
the XFA template, and the `/AcroForm` LiveCycle generated from it. So the
sharpest test takes a vendored hybrid, strips `/AcroForm /Fields` in a copy,
converts from the template alone, and compares the synthesized field set
against the one Adobe wrote — names, `/FT`, `/Ff`, `/Opt`, and **rects**.

That validates the SOM naming, the type mapping and the entire geometry
pipeline — units, anchors, offset accumulation, the y-flip — against numbers we
did not compute. It is the `cff.ts`-charstrings-checked-against-`hmtx`
arrangement, and it costs nothing beyond the fixture being vendored anyway.

Its limit, to be stated in PROVENANCE rather than discovered: it covers only
what that form uses, and only positioned layout.

### Builders cover what a real form will not

`test/helpers/build-xfa-pdf.ts` for the rule matrix: each UI type, `exclGroup`,
the `<items>` export/display pair, the flow-layout degrade, the medium
mismatch, a `pageArea` count disagreeing with the page count, malformed XML,
the signature refusal, every `anchorType`, the reconciliation path. Most of it
never needs a PDF — `xfageom.ts` drives from numbers and `xfatemplate.ts` from
XML strings, which is what the leaf split buys.

### Fixtures

`test/fixtures/xfa/` with a `PROVENANCE.md` recording producer and version
(readable from the packet's own generator processing instruction), source URL,
SHA-256, what each file covers and — as those documents always do — what it
provably does not: **no second implementation arbitrates our output**, and
`px` / `pc` units or a non-`topLeft` anchor may appear in no vendored form at
all. Sources are US federal forms (USCIS, IRS), which are US Government works
and public domain, so they can be committed; the suite stays hermetic and needs
neither network nor Acrobat.

### Mutations to prove load-bearing

Non-negotiable, and three of them need a fixture built deliberately because the
obvious one measures nothing:

| Mutation | Fixture requirement |
|---|---|
| Flip the y-axis sign | Page content **vertically asymmetric**, or the rect comparison passes either way |
| Use the template `<value>` as `/V` rather than `/DV` | A `datasets` value that **differs** from the template default, else green under both readings |
| Accumulate offsets from the immediate parent only | A chain **three deep with a non-zero offset at each level** |
| Swap the `<items>` export/display halves | A choice field whose two halves differ |
| Drop the medium-versus-CropBox check | A fixture whose medium deliberately disagrees |
| Test `layout` on the immediate parent, not the whole chain | A positioned subform nested inside a flowed one |
| Ignore `access="readOnly"` / `nullTest` | Fields carrying each |

Plus a byte-identity fence: a document with **no** `/XFA` must be unchanged by
the call, and the existing form, PDF/A and PDF/X suites must not move.

## What this design does not claim

- It does not make a dynamic XFA form **render**. Its fields become
  addressable, exportable and fillable; the pages the layout engine would have
  built do not appear. `dataOnly` on the report says so per document.
- It has **no runnable oracle**. The hybrid comparison is strong evidence for
  the forms it covers; nothing here is conformance-tested against a second XFA
  implementation, and PROVENANCE must say so.
- It is **one-way**. Nothing is written back into the XFA packets.

## Open questions for the implementation plan

1. The `px` and `pc` unit definitions — transcribe from the specification with
   the clause cited; do not infer.
2. Whether any vendored form exercises a non-`topLeft` `anchorType`; if none
   does, the anchor arithmetic is builder-covered only and PROVENANCE says so.
3. `<occur>` repeating subforms in an otherwise positioned template: the
   template states `initial`, so occurrence *count* is knowable without layout,
   but the repeat direction is not. Expected answer is to treat any subform
   with `occur max != 1` as flow-laid and degrade its fields — to be confirmed
   against a real form rather than assumed.
