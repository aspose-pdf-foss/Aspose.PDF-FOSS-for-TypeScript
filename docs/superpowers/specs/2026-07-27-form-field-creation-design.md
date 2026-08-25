# AcroForm field creation: bootstrap & infrastructure

Issue: `aspose-pdf-foss-for-ts-dbpr.1`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Blocks: `dbpr.2` (text-field flags), `dbpr.3` (checkbox/radio), `dbpr.4`
(combo/list), `dbpr.5` (push button)

Today `src/form.ts` reads an existing `/AcroForm` and sets field *values*; it
cannot create a field. This issue adds the shared creation machinery — AcroForm
bootstrap, `/DR` + `/DA` defaults, hierarchical field-tree wiring, widget
construction — and proves it end to end with one vertical slice,
`AddTextField`. The remaining field types then reduce to composing the exported
pieces.

Parity target: `Aspose-PDF-FOSS-for-Go` `form.go`
(`AddTextField`/`validateNewField`/`appendToFields`/`ensureFontHelv`), with two
deliberate divergences noted under *Decisions*.

## Scope

In scope:

- `/AcroForm` bootstrap: create the catalog entry, `/Fields`, `/DR /Font` and a
  default `/DA` when absent; reuse them when present.
- Hierarchical field names: `'address.city'` creates (or reuses) intermediate
  non-terminal field nodes and wires the terminal field under them with
  `/Parent` back-links.
- Widget construction: the merged field/widget dict, attachment to the page's
  own `/Annots`, `/P` back-reference, `/F` print flag.
- Field-type-neutral flags: `readOnly`, `required`.
- Typed field handles: `Field` stays the base; `TextField`, `CheckboxField`,
  `RadioField`, `ChoiceField`, `ButtonField` extend it, and `Form.Fields`
  returns them too.
- The vertical slice: `Form.AddTextField` and its `Page.AddTextField`
  forwarder, with `/AP` generated at creation.

Out of scope, deliberately:

- **Text-field flags** — `Multiline`, `Password`, `MaxLen` belong to `dbpr.2`.
  `readOnly`/`required` land here instead because they are field-type-neutral
  and every `Add*` in `dbpr.3`–`.5` needs them.
- **Styling** — border, background (`/MK`, `/BS`) and `/Q` quadding belong to
  `dbpr.6`. The `/DA` half of styling (`font`, `fontSize`, `textColor`) lands
  here; see *Decisions*.
- **Other field types** — `dbpr.3`–`.5`.
- **Field removal.** Go has `Form.RemoveField`; no `dbpr` issue covers it.
  Filed as a follow-up.
- **Refactoring `document.ts`'s `attachSigWidget`.** It contains an ad-hoc
  copy of this bootstrap, but threads an incremental-update `touched` object-
  number set that the generic helper does not model. Folding it in would put
  the signing path at risk for no user-visible gain. Filed as a follow-up.

## Architecture

`src/form.ts` is 280 lines and would roughly triple. Three modules, so that the
field *model*, the creation *machinery*, and the `Form` facade stay separable:

| Module | Responsibility | Depends on |
|---|---|---|
| `src/formfield.ts` (new) | `FieldType`, the `Field` base class (moved verbatim), the typed subclasses, and `wrapField` | `document.ts`, `appearance.ts`, `metadata.ts` |
| `src/formcreate.ts` (new) | AcroForm bootstrap, `/DR`+`/DA`, name-path resolution, widget dict build, `createField` | `document.ts`, `page.ts`, `appearance.ts`, `metrics.ts` |
| `src/form.ts` | The `Form` facade: tree walk, `Get`, `GenerateAppearances`, `Add*` | `formfield.ts`, `formcreate.ts` |

`form.ts` re-exports `Field` and `FieldType` so existing import sites keep
working. `src/appearance.ts` switches its `FieldType` import to
`formfield.js`; it is `import type`, so it erases and no runtime cycle forms
(the same arrangement that exists between `form.ts` and `appearance.ts` today).
`src/index.ts` gains the subclasses.

### The field model (`formfield.ts`)

`wrapField(doc, acroForm, dict, name, fullName, type, ff, v): Field` dispatches
on `type`, mirroring `wrapAnnotation` in `annotation.ts`. The `Form` constructor
calls it instead of `new Field(...)`, so readers of existing documents get the
subclasses too — there is no split-brain model where the same field is one class
when created and another when read.

There is deliberately **no** `SignatureField` subclass: the name is already
exported from `signature.ts`, and neither `signature` nor `unknown` is
creatable. `wrapField` returns the base `Field` for both.

`Field.Value`'s type-switch stays on the base class, untouched. Pushing it into
the subclasses would mean overriding an accessor pair with a narrowed setter
type on every subclass — churn in tested behaviour for no functional gain. The
subclasses are extension points for `dbpr.2`–`.5`, not a rewrite.

### Bootstrap (`formcreate.ts`)

```ts
ensureAcroForm(doc): PdfDict           // indirect /AcroForm with /Fields []; idempotent
ensureDRFont(doc, acro, std): string   // /DR /Font /<key>; returns the resource key
fieldDA(key, size, color): string      // "/Helv 0 Tf 0 g"
```

`ensureDRFont` uses Acrobat's conventional resource keys (`Helv`, `HeBo`,
`TiRo`, `Cour`, `ZaDb`, `Symb`, …). It reuses an existing entry whose
`/BaseFont` already matches the requested Standard-14 face, and picks a
suffixed key when the conventional one is taken by a different face — so
repeated calls never duplicate a font, and never silently retarget an existing
one.

`/NeedAppearances` is **never** set. Every `Add*` writes a real `/AP` through
the existing `generateFieldAppearance`, so the result renders identically
everywhere rather than depending on a viewer honouring the flag. This matches
`GenerateAppearances`, which already *deletes* the flag.

Every `Add*` ends with `doc.markModified()`, matching the existing value
setters: in-place edits to live dicts must force a full rewrite on the next
sign, or an incremental append could silently drop the new field.

### Hierarchical name wiring

`resolvePath(doc, acro, fullName, create)` splits `fullName` on `.` and walks
the field tree from `/AcroForm /Fields`:

| Situation | Outcome |
|---|---|
| Any empty part (`''`, `'a.'`, `'.a'`, `'a..b'`) | `TypeError` |
| Intermediate part resolves to a non-terminal node | descend into its `/Kids` |
| Intermediate part resolves to a terminal field | `RangeError("'a' is an existing terminal field")` |
| Intermediate part missing | create `<< /T (a) /Kids [] /Parent … >>` as an indirect object |
| Terminal part already present | `RangeError("field 'a.b' already exists")` |

A node counts as **terminal** when it has no `/Kids`, or when its `/Kids`
entries lack `/T` (they are widgets, not child fields) — the same rule the
existing walker in `form.ts` uses to decide where a field ends.

**Invariant: a throw leaves the document byte-identical.** `resolvePath` is
called twice — first with `create: false` to validate the whole path without
mutating, then with `create: true` to apply it. Creating intermediate nodes
allocates objects, so a single fused pass would leave orphan nodes behind on a
conflict deep in the path. This is the same guarantee `createAnnotation`
documents ("validates all inputs before allocating any object") and that
`Field.Value` already upholds.

Root-level fields are appended to `/AcroForm /Fields` with no `/Parent`. Deeper
ones are appended to the parent node's `/Kids` and carry a `/Parent` back-link;
intermediate nodes are therefore indirect objects, so they can be referenced.

### Field & widget construction

A terminal field is a single **merged field/widget dict**:

```
<< /Type /Annot /Subtype /Widget
   /FT /Tx /T (applicant) /Ff 0 /DA (/Helv 0 Tf 0 g) /V ()
   /Rect [72 700 272 722] /P 3 0 R /F 4 >>
```

This is what `Field.widgets()` already handles ("a merged field/widget dict is
its own widget"). Radio groups (`dbpr.3`) need the non-merged shape — a parent
field with N kid widgets — so `formcreate.ts` exports the individual pieces
(`resolvePath`, `buildWidgetDict`, `attachWidget`) alongside the all-in-one
`createField`, rather than only the latter.

The widget goes on the page's **own** `/Annots` array, created when absent
(never an inherited one). `annotation.ts`'s existing `ownAnnots` helper is
exported and reused rather than duplicated.

## Public API

```ts
/** Options common to every Form.Add* field constructor. */
export interface FieldInit {
  /** 1-based page number carrying the widget. */
  page: number;
  /** Widget rectangle [llx, lly, urx, ury] in default user space. */
  rect: [number, number, number, number];
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** Standard-14 face for the field's /DA. Default 'Helvetica'. */
  font?: StdFont;
  /** /DA font size; 0 (the default) auto-sizes to the box. */
  fontSize?: number;
  /** /DA text colour, RGB 0..1. Default black. */
  textColor?: [number, number, number];
  /** /Ff ReadOnly (bit 1). */
  readOnly?: boolean;
  /** /Ff Required (bit 2). */
  required?: boolean;
}

/** Options for Form.AddTextField / Page.AddTextField. */
export interface TextFieldInit extends FieldInit {
  /** Initial /V. Default ''. */
  value?: string;
}

Form.AddTextField(init: TextFieldInit): TextField
Page.AddTextField(init: Omit<TextFieldInit, 'page'>): TextField
```

`Form.AddX` is the primitive; `Page.AddX` is a thin forwarder binding
`page = this.Number`. The `Form` entry point matches the Go API and is the
natural home for a document-scoped concept; the `Page` entry point matches this
library's own authoring style, where `AddTextNote`, `AddLink`, `AddStamp`,
`AddBarcode` and `AddTable` all hang off `Page`.

`Form.Fields` becomes a getter over a private array, rebuilt in place after
each `Add*`. Today `doc.Form` snapshots the tree on every access, so a held
`Form` instance would otherwise go stale the moment it created a field.

Errors follow the convention already in `form.ts`: `TypeError` for a malformed
argument, `RangeError` for a value that is well-formed but rejected (duplicate
name, terminal conflict, page out of range).

## Decisions

Two boundaries were drawn against the filed issue text:

- **`readOnly` / `required` land in `dbpr.1`, not `dbpr.2`.** `dbpr.2` lists
  them alongside the text-specific flags, but they are field-type-neutral —
  every `Add*` in `dbpr.3`–`.5` needs them, and duplicating the bit-setting per
  type is worse than one shared `FieldInit`.
- **`font` / `fontSize` / `textColor` land in `dbpr.1`, not `dbpr.6`.**
  `ensureDRFont` is generic over `StdFont` regardless, so exposing the `/DA`
  half of styling here costs nothing and spares `dbpr.6` a rewrite of the
  `/DA` builder. `dbpr.6` then adds only `/MK` (border, background), `/BS`, and
  `/Q`.

Divergences from the Go parity target:

- **`fontSize` defaults to 0 (auto-size), where Go hard-codes 12.** Our
  `appearance.ts` already implements auto-sizing (`min(12, 0.85·h)`, shrunk to
  fit the width), and `0 Tf` is the standard viewer-side spelling of the same
  thing. A fixed 12 overflows a short box.
- **Hierarchical names are supported, where Go accepts flat names only.** Real
  field trees matter for FDF/XFDF round-trips and for inherited `/Ff`, `/DA`
  and `/V`, all of which this library already reads.

## Testing

New `test/form-create.test.ts`, built over `test/helpers/build-blank-page.ts`:

- **Bootstrap.** `/AcroForm`, `/Fields`, `/DR /Font /Helv` created on a
  document that had none. An existing `/DR /Font /Helv` is reused, not
  duplicated. A `/DR /Font /Helv` bound to a *different* `/BaseFont` yields a
  suffixed key rather than being retargeted.
- **Round-trip.** `Save` → `Open` → `doc.Form.Get('applicant').Value`.
- **Widget placement.** Present exactly once in the page's own `/Annots`; `/P`
  resolves to that page; `/AP /N` exists and its `/BBox` matches the rect size.
- **Hierarchy.** `'address.city'` creates an intermediate node with `/T` and
  `/Kids`, a `/Parent` back-link, and the correct `FullName` after reopen.
  `'address.city'` + `'address.zip'` share one intermediate node.
- **Failure atomicity.** Duplicate name, terminal conflict, and each malformed
  name all throw *and* leave the document unmutated — asserted on both the
  field count and the total object count, so an orphaned intermediate node is
  caught.
- **Forwarder.** `page.AddTextField` produces the same structure as
  `form.AddTextField` with an explicit `page`.
- **`wrapField`.** `Form.Fields` over the existing `test/helpers/build-form-pdf.ts`
  fixture yields `TextField` / `CheckboxField` / … instances.

Per `CLAUDE.md`, the load-bearing assertions are proven by mutation rather than
by watching them go green: breaking `resolvePath`'s terminal-conflict branch,
and collapsing the two-pass validation into one pass, must each turn the suite
red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md`'s API overview gains the field-creation entry points.
