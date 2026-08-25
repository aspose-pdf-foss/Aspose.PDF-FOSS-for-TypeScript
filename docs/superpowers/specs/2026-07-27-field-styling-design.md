# Form field styling — border, background and text

Issue: `aspose-pdf-foss-for-ts-dbpr.6`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Builds on: `dbpr.1`–`dbpr.5` (through commit `94e7e14`)

The last child of the epic. `dbpr.2`–`dbpr.5` can create all five field types
but every one of them renders with the same bare face: no background, no border,
and a check mark that is always black. This issue adds the styling half.

Half the work is already done and invisible. `mkOps` in `appearance.ts` already
paints `/MK /BG` and `/MK /BC` and already reads `/BS /W` for the border inset —
every field type and `buildPushButtonAP` compose it. What is missing is
*authoring*: nothing writes those keys except the push button's two hardcoded
defaults, which `dbpr.5` parked here deliberately. And `/BS /S` is never
honoured at all, so a border is always a plain solid rectangle.

## Scope

In scope:

- A `FieldStyle` / `WidgetStyle` option pair on every creation entry point.
- `Field.SetStyle` for fields that already exist, including ones we did not
  author.
- `/BS /S` rendering: all five border styles.
- `/DA` colour reaching a checkbox's and radio button's mark glyph.

Out of scope, deliberately:

- **Non-RGB authoring colours.** `mkOps` paints 1-, 3- and 4-component arrays,
  so grey and CMYK fields in documents we did not author keep rendering
  correctly. We just do not offer them as input: `textColor` is already an RGB
  triple, so widening only the two new keys would make the API inconsistent with
  itself, and widening `/DA` too is churn this issue does not need.
- **Per-option radio styling.** A radio group styles as a unit. Nothing wants
  one button in a group to differ from the rest.
- **`/MK /R`** (widget rotation). `widgetGeom` already reads it; nothing writes
  it. Orthogonal to colour and filed nowhere because nothing needs it.
- **Beveled as the push-button default.** See "Push button defaults" below.

## Architecture

### Two interfaces, one hierarchy

The three text-styling keys — `font`, `fontSize`, `textColor` — already ship
flat on `FieldInit`. They are extracted into a named interface **in place**, so
their position and meaning are unchanged and no shipped call site breaks:

```ts
/** /MK + /BS: what a widget's box looks like. */
export interface WidgetStyle {
  /** /MK /BG fill, RGB 0..1. `null` paints nothing (an empty /BG array). */
  backgroundColor?: [number, number, number] | null;
  /** /MK /BC stroke, RGB 0..1. `null` paints nothing. */
  borderColor?: [number, number, number] | null;
  /** /BS /W in points. Default 1 whenever /BS is written. */
  borderWidth?: number;
  /** /BS /S. Default 'solid'. */
  borderStyle?: FieldBorderStyle;
  /** /BS /D dash lengths in points. Only with 'dashed'; default [3]. */
  dashPattern?: number[];
}

/** WidgetStyle plus the /DA text half. */
export interface FieldStyle extends WidgetStyle {
  font?: StdFont;
  fontSize?: number;
  textColor?: [number, number, number];
}

export type FieldBorderStyle =
  'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';
```

`FieldInit extends FieldStyle`. `RadioGroupInit extends WidgetStyle` rather than
`FieldStyle`: it is deliberately not a `FieldInit` because a button draws no
`/DA` text, and giving it `fontSize` would be a documented key that provably
does nothing — the mark glyph is sized to its box.

It does declare its own `textColor`, because a radio button's dot *is* drawn in
the `/DA` colour (see "The check mark takes its colour from `/DA`" below).
Without it a styled group could set every colour on the widget except the one
thing it actually draws. Radio creation therefore always writes a `/DA` on the
parent, so the colour survives a later regeneration rather than living only in
the stream.

### A new module

The style types and their validation cannot live in `formcreate.ts`:
`Field.SetStyle` needs them, `formfield.ts` holds `Field`, and `formcreate.ts`
already imports `formfield.ts`. Putting them there closes an import cycle.

New `src/fieldstyle.ts` owns the style vocabulary and nothing else — the two
interfaces, `checkWidgetStyle` / `checkFieldStyle` (validate, mutate nothing)
and `applyWidgetStyle` (write `/MK` + `/BS` to one widget). `formcreate.ts` and
`formfield.ts` both import from it and neither imports the other for this.

`DR_KEY`, `ensureDRFont`, `fieldDA` and `pdfLatin` move there from
`formcreate.ts` for the same reason — `SetStyle` rewrites `/DA` and so needs
all four. `formcreate.ts` re-exports `ensureDRFont` and `fieldDA` so existing
import sites keep working.

The split is not decoration. It is the same split the format makes — `/MK` and
`/BS` live on the *widget annotation*, `/DA` on the *field* — and it is what
lets `Field.SetStyle` take one argument while radio creation takes the narrower
one.

### What gets written

| Option | Key | On |
|---|---|---|
| `backgroundColor` | `/MK /BG` | each widget |
| `borderColor` | `/MK /BC` | each widget |
| `borderWidth` | `/BS /W` | each widget |
| `borderStyle` | `/BS /S` | each widget |
| `dashPattern` | `/BS /D` | each widget |
| `font`, `fontSize`, `textColor` | `/DA` | the field dict |

`/BS` is created only when at least one of `borderColor`, `borderWidth`,
`borderStyle` or `dashPattern` is given. A field with no border keys writes no
`/BS` at all rather than a `/BS` with `/W 0` — `mkOps` already paints no border
when `/BC` is absent, so the empty dict would be noise in every saved file.

`null` is written as an empty array, which is the specification's transparent
(`/BG` and `/BC` are "an array of numbers ... the number of elements determines
the colour space", and zero elements means no colour). `colorArr` already
returns `undefined` for an empty array, so `mkOps` paints nothing — no reader
change is needed for `null` to work.

`null` is distinct from absent, and both are needed. Absent means "leave the key
alone" — for creation that is the type's default, for `SetStyle` it is whatever
the field already had. `null` means "explicitly nothing", which is the only way
to suppress a push button's default face.

For a radio group this means the parent field dict gets neither `/MK` nor `/BS`,
and each kid widget gets both.

### Push button defaults

`addPushButton` currently hardcodes `/MK /BG [0.86 0.86 0.86]` and
`/BC [0.5 0.5 0.5]`. These become *defaults*: applied only when the caller
supplied neither key, and fully overridable — including to `null`.

The default `borderStyle` stays **`solid`**, not `beveled`. Beveled is what
Acrobat draws and what makes a button look pressable, but switching the default
would silently change the output of every push button `dbpr.5` shipped three
days ago. A caller opts in with one key. This is a reversible decision; changing
the default later is a one-line change plus a golden update.

### Rendering: `mkOps` learns `/BS /S`

`mkOps` reads `/BS /W` and always strokes a plain rectangle. It gains a
five-way switch on `/BS /S`. The return shape is unchanged — `{ ops, inset }` —
so every caller keeps working.

| `/S` | Style | Ops | `inset` |
|---|---|---|---|
| `/S` | solid | rect stroke (today's behaviour) | `bw` |
| `/D` | dashed | rect stroke preceded by `d` built from `/BS /D` | `bw` |
| `/B` | beveled | rect stroke, plus a light L (top + left) and a shadow L (bottom + right) **filled** inside it | `2 × bw` |
| `/I` | inset | the same two L polygons, light and shadow swapped | `2 × bw` |
| `/U` | underline | the bottom edge only | `0` |

Underline returns no inset because there is no side or top border for text to
avoid; insetting text on three sides that have no border would push it inward
for no reason.

Beveled and inset return **twice** the border width, not `bw`. The bevel band
sits *inside* the `/BC` stroke and occupies another `bw` of the box; insetting
by the stroke alone would lay the value's glyphs across the highlight.

Beveled and inset draw **filled polygons, not strokes**. A stroked bevel would
straddle the edge it is meant to sit inside, and the two L shapes must abut the
rectangle exactly. The two Ls are emitted as two separate fills rather than one
path: they share edges but never overlap, so no winding rule has to reconcile
them.

Unrecognised and absent `/S` fall back to solid, matching the specification's
default and keeping every existing document rendering as it does today.

### The check mark takes its colour from `/DA`

`glyphBody` in `appearance.ts` hardcodes `0 g`. A checkbox's check and a radio
button's dot are therefore always black, whatever `/DA` says. It takes the
resolved `/DA` colour as a parameter instead.

`buildButtonAP`'s trailing `std: StdFont = 'Helvetica'` parameter becomes a
required `da: ResolvedDA`, which carries both the face and the colour. Every
call site already has one in hand or can resolve it, and a defaulted `std` that
silently disagreed with the field's real `/DA` was a latent bug of its own.

Without this, `textColor` is silently inert on exactly the two field types where
a coloured mark is most visible — the caller sets it, the key lands in `/DA`,
and nothing changes on the page.

### Live restyle

```ts
Field.SetStyle(style: FieldStyle): void
```

Validate the whole object, then write `/DA` on the field dict and `/MK` + `/BS`
on every widget, then regenerate the appearance. Rejection leaves the document
byte-identical, the same invariant creation holds.

Regeneration dispatches on field type, because the three families build their
`/AP` differently:

| Type | Path |
|---|---|
| pushbutton | new `regeneratePushButtonAP` (below) |
| checkbox, radio | `buildButtonAP` directly, on-state from `synthOnState` |
| text, choice, other | the existing `generateFieldAppearance` |

**Checkbox and radio bypass `generateFieldAppearance` on purpose.** That
function guards button regeneration behind `hasNStates` — if the widget already
has appearance states it leaves them alone, to preserve an author's artwork.
A restyle is precisely the request to replace that artwork, so the guard has to
be stepped around rather than removed; the guard is still right for the
value-driven path it protects.

This is also the case `synthOnState` was written for. Creation must never route
through it (the epic invariant: creation names the export outright via
`buildAP`), but `SetStyle` runs against a field whose export name we may never
have known — reading it back off `/AS`, `/Opt` or `/V` is exactly its job.

### `regeneratePushButtonAP`

A push button's `/AP` cannot be rebuilt from a `PushButtonFace` on the restyle
path, because the caller of `SetStyle` does not have one — the captions, layout
and icon were supplied at creation and are now only in the document.

Everything needed is nonetheless still there:

| Face field | Recovered from |
|---|---|
| `caption`, `rolloverCaption`, `downCaption` | `/MK /CA`, `/RC`, `/AC` |
| `position` | `/MK /TP`, inverted through `TP_FOR` |
| icon | the existing `/AP /N` stream's `/Resources /XObject /BtnIco` |

So `buttonap.ts` gains `regeneratePushButtonAP(doc, widget, acro)`, which reads
those back and calls the existing builder. The icon is carried as an already
allocated `PdfRef` rather than a re-embedded `BuiltImage`, so restyling a button
any number of times never duplicates its image.

This mirrors `annotdraw.ts`'s `regenerateAppearance`, which exists for the same
reason: an appearance rebuilt from a dict rather than from an options object.

## Public API

```ts
export type FieldBorderStyle =
  'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';
export interface WidgetStyle { /* as above */ }
export interface FieldStyle extends WidgetStyle { /* as above */ }

interface FieldInit extends FieldStyle {}      // font/fontSize/textColor unmoved
interface RadioGroupInit extends WidgetStyle {
  textColor?: [number, number, number];        // the dot's colour
}

Field.SetStyle(style: FieldStyle): void
```

No new entry points. Every `Form.Add*` and `Page.Add*` accepts the new keys
because they all take a `FieldInit`, and `AddRadioGroup` takes the widget half.

## Validation

Checked before the first byte is written, so a rejected call — creation or
restyle — leaves the document unchanged.

| Rejected | Error |
|---|---|
| a colour that is not a 3-number tuple | `TypeError` |
| a colour component outside 0..1 | `TypeError` |
| `borderWidth` negative or not finite | `TypeError` |
| `borderStyle` not one of the five | `TypeError` |
| `dashPattern` not an array, or empty | `TypeError` |
| a `dashPattern` entry not a positive finite number | `TypeError` |
| `dashPattern` with a `borderStyle` other than `'dashed'` | `RangeError` |

The last follows the precedent set in `dbpr.2`, `dbpr.4` and `dbpr.5`: reject
the combination that would otherwise render as something the caller did not ask
for. A dash pattern on a beveled border is stored and ignored, so the field
comes out looking nothing like the call that made it.

Colour validation reuses the existing `checkNums` plus the 0..1 range check
`createField` already applies to `textColor`, lifted into one shared helper so
all three colours are validated identically.

## Testing

New `test/form-style.test.ts`, plus additions to the existing per-type tests:

- **Keys land.** Each option reaches `/MK`, `/BS` or `/DA` with the expected
  value, on the widget or the field as the table above specifies. For a radio
  group, `/MK` and `/BS` on each kid and on neither the parent nor the group's
  own `/DA`, which carries only the colour.
- **`null` writes `[]`**, and the resulting appearance paints no face.
- **The five border styles differ.** All five compared pairwise; every pair's
  `/AP` content must differ. A switch that silently falls through to solid fails
  this.
- **Underline has no side inset**, asserted through the drawn text's x-position
  against a solid border of the same width.
- **The mark takes `textColor`** — a red checkbox's on-state stream carries a
  red fill, not `0 g`.
- **Push button defaults** apply only when neither colour key is given;
  `backgroundColor: null` suppresses the default face.
- **Restyle round-trips** against a field parsed back from saved bytes, which is
  the "document we did not author" path — including a push button that keeps its
  icon, its three streams and its captions across `SetStyle`.
- **Restyle replaces** a checkbox's existing `/AP`, proving the `hasNStates`
  guard is stepped around.
- **Rejections** each leave the saved byte length unchanged, for both creation
  and `SetStyle`.

Per `CLAUDE.md`, two assertions are proven load-bearing by mutation rather than
by watching them go green:

- Make the border switch always draw solid — the pairwise-difference test must
  go red.
- Make `regeneratePushButtonAP` drop the icon — the icon-survival test must go
  red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md` gains the styling options and `Field.SetStyle`.
