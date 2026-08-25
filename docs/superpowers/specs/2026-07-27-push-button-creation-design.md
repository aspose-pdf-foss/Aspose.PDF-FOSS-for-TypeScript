# Push button creation, appearance and actions

Issue: `aspose-pdf-foss-for-ts-dbpr.5`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Builds on: `dbpr.1`–`dbpr.4` (through commit `74e7f63`)

Adds the last field type: push buttons. Unlike the other four they carry no
value — a push button exists to have an appearance and an action. So this issue
is mostly those two things, and it is the largest of the five.

It also extracts the `/A` action model, which is currently inline in two places
and reusable from neither.

## Scope

In scope:

- `Form.AddPushButton` / `Page.AddPushButton`.
- `src/actions.ts`: one `PdfAction` union with `encodeAction` / `parseAction`,
  covering GoTo, URI, SubmitForm, ResetForm and JavaScript.
- `/MK` appearance characteristics: `/CA`, `/RC`, `/AC`, `/TP`, and default
  `/BG` and `/BC` so a created button looks like a button.
- Three appearance streams — `/AP /N`, `/R` and `/D` — so the button reacts to
  hover and press in any viewer.
- An optional icon (JPEG or PNG) and the four `/TP` layouts Go supports.
- `ButtonField.Action`.

Out of scope, deliberately:

- **Colours.** `dbpr.6` owns `/MK` styling — border, background and text — for
  every field type. Go's `ButtonAppearance` bundles `TextColor`, `FaceColor` and
  `BorderColor`; duplicating them here would create two ways to set the same
  keys. This issue writes *defaults* into the same `/MK` entries `dbpr.6` will
  overwrite.
- **`/TP` 3, 4 and 5** (caption above / right of / left of the icon). Go models
  four of the seven layouts; these three are the remaining ones and need extra
  geometry. Filed as a follow-up.
- **`/MK /R` caption rotation**, and exposing the icon as a `/MK /I` Form
  XObject for viewer-side regeneration. The icon is drawn into the `/AP`
  streams, which renders everywhere without relying on regeneration. Go
  documents the same two as its own follow-ups.
- **Named actions** (`/S /Named`, e.g. NextPage). Nothing needs them.

## Architecture

### One action model, two consumers

`/A` handling exists twice today and is reusable from neither place:

| Where | What |
|---|---|
| `addLink` | builds the `/A` dict inline for `goto` and `uri` |
| `LinkAnnotation.Action` | parses `/A` inline, returning `undefined` for anything else |

New `src/actions.ts`:

```ts
export type GoToAction = { type: 'goto'; page: number; view?: OutlineView };
export type UriAction = { type: 'uri'; uri: string };
export type SubmitAction = {
  type: 'submit';
  url: string;
  /** Fully-qualified field names. Omit to submit every field. */
  fields?: string[];
  /** Treat `fields` as an exclusion list (/Flags IncludeExclude). */
  exclude?: boolean;
  /** Wire format. Default 'fdf'. */
  format?: 'fdf' | 'html' | 'xfdf' | 'pdf';
};
export type ResetAction = { type: 'reset'; fields?: string[]; exclude?: boolean };
export type JavaScriptAction = { type: 'javascript'; script: string };

export type PdfAction =
  GoToAction | UriAction | SubmitAction | ResetAction | JavaScriptAction;

export function encodeAction(doc: Document, a: PdfAction): PdfDict;
export function parseAction(doc: Document, annot: PdfDict): PdfAction | undefined;
```

Both inline copies are deleted and replaced by calls. `LinkAction` becomes an
alias of `PdfAction` and is re-exported from `annotation.ts`, so existing import
sites keep working.

This widens `LinkAnnotation.Action` from `goto | uri` to the full union. That is
correct rather than merely convenient: a link annotation may legally carry a
submit-form action, and today such a link reads back as `undefined`. The cost is
a public type widening — a consumer exhaustively switching on the result gains
new cases.

**`/Flags` mapping** (PDF 32000-1 table 237 for SubmitForm, 239 for ResetForm),
by 1-based specification bit:

| Option | Bit | Value |
|---|---|---|
| `exclude` | 1 (IncludeExclude) | 1 |
| `format: 'html'` | 3 (ExportFormat) | 4 |
| `format: 'xfdf'` | 6 (XFDF) | 32 |
| `format: 'pdf'` | 9 (SubmitPDF) | 256 |
| `format: 'fdf'` | — | 0 (the default encoding) |

`SubmitForm`'s `/F` is written as a URL file specification —
`<< /FS /URL /F (…) >>` — not a bare string. A bare string is a valid file
specification in general, but a URL requires the `/FS /URL` form.

### Push button creation

A merged field/widget dict through the existing `createField`, with `/FT /Btn`,
the Pushbutton flag, and **no `/V`**: a push button has no value, which
`Field.Value`'s setter already refuses for this type.

`createField`'s `buildAP` hook (added in `dbpr.3`) supplies the appearance, so
the value-driven generator is never consulted.

### Three appearance streams

`/AP` carries all three siblings rather than only `/N`:

| Key | State | Caption |
|---|---|---|
| `/N` | normal | `/MK /CA` |
| `/R` | rollover (hover) | `/MK /RC`, falling back to `/CA` |
| `/D` | down (pressed) | `/MK /AC`, falling back to `/CA`, on a darkened face |

The darkened face is the one change to shared code: `mkOps` gains an optional
`darken` factor, defaulting to 1, multiplied into `/BG` only. The alternative —
a button-specific face painter — would duplicate the `/BG` + `/BC` + inset
logic that every other field type already shares.

Creation writes a default `/BG` of light grey and `/BC` of grey. Without them
`mkOps` paints nothing and the button renders as a bare caption floating on the
page. Writing them into `/MK` rather than baking a face into the stream is what
lets `dbpr.6` restyle the button through the ordinary path.

### Icon and layout

The icon is embedded with the existing `buildImageXObject` (JPEG and PNG),
registered in each appearance stream's `/Resources /XObject`, and drawn
aspect-fit into a region. A pure layout function maps `/TP` to the icon and
caption rectangles:

| `iconPosition` | `/TP` | Layout |
|---|---|---|
| `'caption-only'` | 0 | caption fills the box; no icon |
| `'icon-only'` | 1 | icon fills the box; no caption |
| `'icon-above-caption'` | 2 | icon in the upper region, caption beneath |
| `'caption-over-icon'` | 6 | icon fills the box, caption centred over it |

Keeping the layout pure — rect and mode in, two rects out — is what makes the
four modes testable without inspecting content streams.

## Public API

```ts
export type ButtonIconPosition =
  | 'caption-only' | 'icon-only' | 'icon-above-caption' | 'caption-over-icon';

/** Options for Form.AddPushButton / Page.AddPushButton. */
export interface PushButtonInit extends FieldInit {
  /** /MK /CA — the normal-state caption. */
  caption?: string;
  /** /MK /RC — the caption while hovered. Defaults to `caption`. */
  rolloverCaption?: string;
  /** /MK /AC — the caption while pressed. Defaults to `caption`. */
  downCaption?: string;
  /** JPEG or PNG bytes, drawn into the appearance streams. */
  icon?: Uint8Array;
  /** /MK /TP layout. Default 'caption-only', or 'icon-only' when an icon is
   *  given without a caption. */
  iconPosition?: ButtonIconPosition;
  /** The activation action, written to /A. */
  action?: PdfAction;
}

Form.AddPushButton(init: PushButtonInit): ButtonField
Page.AddPushButton(init: Omit<PushButtonInit, 'page'>): ButtonField
```

`ButtonField` gains one member — the flags it could carry (`ReadOnly`,
`Required`) already live on `Field`:

```ts
get/set Action: PdfAction | undefined   // undefined clears /A
```

## Validation

Everything is checked before the first object is allocated, so a rejected call
leaves the document byte-identical.

| Rejected | Error |
|---|---|
| any caption given but not a string | `TypeError` |
| `iconPosition` not one of the four | `TypeError` |
| an icon-bearing `iconPosition` with no `icon` | `RangeError` |
| `icon` given with `iconPosition: 'caption-only'` | `RangeError` |
| `action.type` unrecognised | `TypeError` |
| an empty `uri`, `url` or `script` | `TypeError` |
| a goto `page` out of range | `RangeError` |
| `fields` present but not an array of strings | `TypeError` |

The two icon pairings follow the precedent set in `dbpr.2` and `dbpr.4`:
reject a combination that would silently render as something the caller did not
ask for — here, an image that is embedded but never drawn.

## Testing

New `test/form-button.test.ts` for the button, with the action model in
`test/actions.test.ts`:

- **Structure.** `/FT /Btn` with the Pushbutton bit (spec bit 17, asserted as
  the literal `65536`), no `/V`, and `/MK` carrying `/CA`, `/RC`, `/AC`, `/TP`
  plus the default `/BG` and `/BC`.
- **Three streams.** `/AP` has `/N`, `/R` and `/D`, and the three are distinct
  objects with distinct content.
- **Per-state captions.** Each stream draws its own caption, with `/RC` and
  `/AC` falling back to `/CA` when omitted.
- **The down face is darker.** The `/D` stream's fill colour is numerically
  below the `/N` stream's.
- **Icon.** The `/N` stream's `/Resources /XObject` holds the image and the
  content has a `Do`.
- **Layouts differ.** The four `/TP` modes are compared pairwise; every pair
  must differ, so a layout function that ignores `/TP` fails.
- **Actions.** Each of the five types encodes the expected `/S` and payload —
  including the `/Flags` values from the table above and the `/FS /URL`
  filespec — and round-trips through `parseAction`.
- **`ButtonField.Action`** reads back what creation wrote, and assigning
  `undefined` removes `/A`.
- **`LinkAnnotation` is unbroken.** Its existing tests pass unchanged, and a
  link carrying a submit action — previously `undefined` — now parses.
- **Rejections** each leave the saved byte length unchanged.

Per `CLAUDE.md`, two assertions are proven by mutation rather than by watching
them go green:

- Make the down state reuse the normal face — the darkness test must go red.
- Make the layout function ignore `/TP` and always return the caption-only
  rects — the pairwise-difference test must go red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md` gains the entry point and the action model.
