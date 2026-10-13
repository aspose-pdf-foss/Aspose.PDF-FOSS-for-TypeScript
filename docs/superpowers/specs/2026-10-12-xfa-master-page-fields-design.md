# XFA master-page fields, one instance per page (`d3mq` part 2)

Part 1 (`feat(d3mq)`) reads the fields on a master page -- XFA's "page
background", a `<pageArea>`'s own fields -- into
`XfaTemplate.masterPageFields`, names each as LiveCycle writes a page's FIRST
instance (`form1[0].#pageSet[0].Page1[0].x[0]`), and REPORTS every one in
`skipped`; none is created. Part 2 creates them: one field per page that is an
instance of the field's page area, placed from the page origin, named as Adobe
names that instance. It became possible when `164g.3` made pages an output of
layout, which is what says which page area each page is an instance of.

The issue asked for a real form with a FILLABLE master-page field before any of
this was built. One was found; see The evidence.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | How master fields are placed | Each named `<pageArea>` becomes a **positioned layout root at the page origin**, laid out by `xfaflow.ts`'s `layoutPage` -- the ONE layout engine. Computing rects from `x`/`y` and ancestor offsets directly was rejected: it is a second placement rule, blind to flowed subforms and container margins. |
| 2 | A master field with no geometry | **Nothing is created**, and the field is reported ONCE (not once per page). A body field with no geometry goes bare; a per-page instance exists only as a place on a page. Adobe agrees: it writes nothing for a `presence="inactive"` Save/Print button or a hidden page counter. |
| 3 | Data | A master field binds ONLY through `<bind match="dataRef" ref>` (XFA 3.3 p. 270-271), through the existing `bindFieldValue`, every instance sharing the value. Without one it is correctly unbound and nothing is reported. `match="global"` is reported as waiting on `yy09`, filed from this issue. |
| 4 | A second page-set instance | **Refused**: every master field is reported. `#pageSet[1]` with a fresh numbering and a running count across page-set instances are both plausible, and no oracle tells them apart. |
| 5 | `<exclGroup>` on a master page | **Refused** by name. No found form has one, so a per-instance radio group would have no oracle. |
| 6 | `match="global"` | Filed separately as `yy09`, not built here. |

## Sources

XFA Specification 3.3, as pinned by `164g.1` (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`, re-fetched
and re-hashed for this design); printed page numbers.

- **Page background** (p. 270): "A pageArea may contain subforms, fields, draw
  objects and area objects ... referred to in this specification as page
  background." LiveCycle calls these master pages.
- **Layout of background** (p. 271): "Structural layout objects used in
  background content may use either positioned or flowing layout." The example
  draws one background image "in each instance of pageArea A".
- **Binding** (p. 271): "A field in page background can be a container for
  data, but it has to be linked to the data by an explicit data reference."
  **Explicit data references** (p. 199-200): `<bind match="dataRef" ref>`, a
  SOM expression into the Data DOM.
- **The layout algorithm** (p. 288): "The layout processor starts by copying
  the pageArea into the Layout DOM and then adding a copy of the background
  text" -- once per page-area instance, ahead of the content area.

## The evidence

A throwaway scanner (our own template reader) was run over 1,243 unique local
PDFs (14 carry XFA, none with a fillable master-page field) and 92 downloaded
federal forms (78 XFA, 70 with master-page fields). US DoD DD forms
(`https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/<name>.pdf`, US
federal works) are the find.

| Form | Kind | Master-page fields | What Adobe wrote |
|---|---|---|---|
| DD 1391 | hybrid, 1 page | `NumericField1`, a visible `numericEdit` "PAGE NO." with a caption reserve, `bind match="none"`, no script; `ResetButton`; Save/Print in a `presence="inactive"` subform | `form1[0].#pageSet[0].Page1[0].NumericField1[0]` (text) at `[560.253 19.418 591.165 30.982]`; `...ResetButton[0]` (push) at `[558 1.918 594 13.918]`; NO Save/Print |
| DD 0368, 1155, 1610, 1750, 2870, 2904, 2952 | hybrids, 1-3 pages | one Reset button each, on `Page1` or `Page2` | `#pageSet[0].PageN[0].ResetButton[0]` (push) |
| DD 2875, DD 1494 | dynamic (`/NeedsRendering`, no AcroForm) | fillable CUI / classification choice lists, `start`/`stop`, `form_no`, `page` -- `bind match="global"` | nothing; pdf.js is the second reading |
| 63 USCIS forms | hybrids | `PDF417BarCode1`, script-valued; two hidden counters | the barcode as `Page1[0..n]`, one per page |

`NumericField1` agrees with the existing rules: `x="181.691mm"` is 515.03pt,
less the `14.9536mm` (42.39pt) caption reserve and the field margins, from the
PAGE origin rather than a content area.

What is NOT found: a hybrid repeating a FILLABLE master field across several
pages. Multi-instance naming rests on the USCIS barcode names (Adobe) and on
DD 2875/1494 (pdf.js). The DD forms index refuses scripted access, which
bounded the search.

## Design

### 1. The template (`xfatemplate.ts`)

The master-page walk already exists and already takes a `parent: LayoutNode`;
today it passes none. For each named `<pageArea>` it now creates a ROOT node --
a positioned container (`layout="position"`), x/y 0, no height -- and walks the
page area with that root as the parent. Fields, draws, areas and subforms (DD's
`Footer`, `Screen_Buttons`) then form a layout tree exactly as body content
does: the same `nodeOf`, the same container margins, `presence`, `anchorType`
and flowed layouts. `<contentArea>` is not content and adds no node. An
`<exclGroup>` on a master page is not walked into fields; it is recorded as
refused (decision 5).

`XfaPageAreaModel` (`xfapage.ts`) gains `master?: LayoutNode`, matched to its
`<pageArea>` by ELEMENT IDENTITY: the walk skips an unnamed page area while
`pageSetOf` keeps it, so their indices can differ.

Each master field gains two members:

- `pageArea: number` -- its page area's index in `pageSet.pageAreas`;
- `instanceAt: number` -- the index, in its SOM name's parts, of the
  `PageN[0]` segment an instance re-indexes.

`masterPageFields` stays its own list: body layout, measuring and data binding
still never see a master field.

### 2. The converter (`xfaconvert.ts`, stage 5b)

Today's report-only loop is replaced.

1. **Document-level refusals**, one entry per master field: no geometry for the
   document (no `<pageSet>`, a page-count mismatch), more than one page-set
   instance (decision 4), a refused UI kind (barcode, signature, image edit), a
   master `<exclGroup>`.
2. **Lay out each page area's master root once**: `layoutPage(model.master,
   measure)` -- the `xfaMeasurer` the body uses. Every instance of a page area
   shares the answer, so it is computed once, not per page.
3. **A field the layout refuses** (hidden, inactive, an unreadable unit, a
   growable shape it cannot size) is reported once with the layout's reason
   and creates nothing (decision 2).
4. **For each laid-out page i** whose page area is k, n = the number of earlier
   pages whose page area is k. For each placed master field of k:
   - the name is the SOM parts with segment `instanceAt` re-indexed `[n]`;
   - a page `badPages` refused (medium mismatch) skips its instances, already
     reported once as a page;
   - the rect goes through the SAME `editRegion` / `buttonBox` / `rectFromBox`
     path as a body field. `geometryFor` is split so its box-to-rect half is
     shared rather than copied;
   - the value is `bindFieldValue` when the field states `match="dataRef"`
     with a `ref`, else none; `match="global"` reports once (`yy09`). The
     template default is `/DV` either way.
   - the instance is a `PlanEntry` like any other and goes through the
     unchanged apply, reconcile (name equality, so a hybrid's Adobe widget is
     reconciled) and report stages.

The plan still allocates nothing, so a refused conversion leaves the file
byte-identical; the signed-document refusal is unchanged. In a dynamic document
the instances land on the pages `164g.3` creates. The part-1 reason "not
converted yet (d3mq)" goes away.

### 3. Out of scope, filed

- `match="global"` -- `yy09`.
- A second page-set instance, a master `<exclGroup>` -- refused with a reason;
  no oracle exists for either.
- Background DRAWS are not drawn (`164g.4`, static chrome as page content).

## Testing

**Vendored fixtures** (US federal works; each recorded in PROVENANCE with URL,
SHA-256, producer and coverage):

- `test/fixtures/xfa/`: `dd1391.pdf` (the fillable field), `dd1610.pdf` and
  `dd2952.pdf` (3 pages, the master field on `Page1` and on `Page2` -- page
  identity across alternating page areas), `dd1155.pdf`.
- `test/fixtures/xfa-dynamic/`: `dd2875.pdf`, `dd1494.pdf`, with pdf.js goldens
  from an extended `npm run gen:xfa`.

**Oracle tests** (`test/xfa-real.test.ts`'s pattern: strip `/AcroForm /Fields`
in a copy, convert from the template alone, compare against Adobe):

- every `#pageSet` name Adobe wrote in the DD hybrids is reproduced, and no
  Save/Print button is created;
- each master rect equals Adobe's within 1pt, with an EXACT count beside the
  bound -- the bound alone accepted a nearly-right inset rule before (`mw1m`);
- I-130 and I-765 report the barcode under every one of Adobe's
  `Page1[0..n-1]` names (today only `[0]`);
- DD 2875 / 1494: each master instance pdf.js places agrees by page and box.
  **Stated unknown:** whether pdf.js reports master-page fields with a SOM
  name. The generator is checked first; if it does not, these two pin page and
  instance counts only, and PROVENANCE says so.

**Builder cases** for what no real form holds: instance counts per page area
across alternating `Page1`/`Page2`; a second page-set instance refused; a master
`<exclGroup>` refused; a hidden or inactive master field reported once and not
per page; a field in a positioned master subform takes the subform's offset; a
`dataRef` binding shared by every instance; `match="global"` reported; a medium
mismatch skipping one page's instances.

**Mutation sweep** at the end. Expected trap: in USCIS every page is `Page1`,
so a document-wide page index and a per-page-area count agree there; the
alternating builder case and DD 1610/2952 are what separate them.

**Docs**: CHANGELOG `Added`; README's XFA limitation; CLAUDE.md's XFA entry
(the master-page invariants) and the `fixtures/xfa*` rows; `bd remember` the
oracle find.
