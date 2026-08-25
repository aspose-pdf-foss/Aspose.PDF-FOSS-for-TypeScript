# Form Appearance Generation — Design (Phase 2b)

**Date:** 2026-06-17
**Status:** Approved (brainstorming)
**Roadmap:** Phase 2b of the content-authoring roadmap
(`docs/superpowers/specs/2026-06-17-content-authoring-design.md`). Depends on the
Phase 1 drawing primitives and the existing `form.ts` field model.

## Problem

Filling an AcroForm field today sets `/V` and flips the AcroForm
`/NeedAppearances` flag, delegating the visual rendering to the PDF viewer.
Viewers that ignore the flag (or rasterizers, print pipelines, and flattening)
show stale or empty fields. Phase 2b generates the field **appearance streams**
(`widget /AP /N`) ourselves so a filled form renders identically everywhere and
`/NeedAppearances` can be dropped.

## Scope

In scope — generate appearances for:

- **Text fields** (`Tx`): single-line, multiline (word-wrap), and comb.
- **Checkbox / radio** (`Btn`): synthesize on/off appearances only when the
  widget has none; otherwise preserve author-supplied states.
- **Choice** (`Ch`): combo boxes (selected value) and list boxes (option list
  with highlighted selection).

Plus fidelity extras: `/MK` background + border painting, widget rotation
(`/MK /R`), `/DA` font/size/color/alignment, and Standard-14 font metrics.

Out of scope: pushbutton and signature fields (never display a value);
appearance generation for fields created from scratch (the library fills
existing forms); Type0/embedded-font width measurement (substituted — see
Limitations).

## Approach

A dedicated generator module plus a `/DA` parser, with `metrics.ts` extended
from Helvetica-only to the full Standard-14 width set. The field setters and a
new explicit API call into the generator. We reuse the low-level content
builders from `serialize.ts`/`pagecontent.ts` (`num`, `serializeString`,
`encodeWinAnsi`, the Standard-14 font-dict pattern) but **not** the page-targeted
`appendContent` — appearances are form XObjects, not page content.

Rejected alternatives: folding generation into `form.ts` (bloats a focused
255-line module); retargeting `PageGraphics` to emit into an XObject (refactors
shipped Phase-1 code for modest gain — appearance content is simple).

## Modules

| Module | Responsibility |
|--------|---------------|
| `src/metrics.ts` (extend) | Add the 14 AFM width tables (Helvetica×4, Times×4, Courier×4, Symbol, ZapfDingbats) keyed by base font; add `glyphWidth(font, code)` and `measure(font, bytes, size)`. Keep `measureWinAnsi(bytes, size)` as a Helvetica-bound shim so `stamp.ts` is untouched. |
| `src/da.ts` (new) | `parseDA(s) → { fontName, size, color }`; `resolveDA(doc, field, acroForm) → DA` with field→AcroForm→default fallback and DR→BaseFont→Standard-14 mapping. |
| `src/appearance.ts` (new) | `generateFieldAppearance(doc, acroForm, field)` — installs `/AP /N` on every widget of one field. Internal per-type layout helpers. |
| `src/form.ts` (wire) | Setters call the generator instead of setting `/NeedAppearances`; add `Form.GenerateAppearances()` and `Field.GenerateAppearance()`. |

## Public API

- `Form.GenerateAppearances(): void` — regenerate every terminal field, then
  delete `/NeedAppearances` from the AcroForm (document becomes
  viewer-independent).
- `Field.GenerateAppearance(): void` — regenerate just this field; leaves the
  global flag untouched.
- `Field.Value` setters now generate the field's appearance and **no longer set**
  `/NeedAppearances`.

No new exported types (`FieldType` is already public).

## Appearance generation algorithm

### Common envelope (every widget)

Build a form XObject stream and install it at `widget /AP /N`:

- `/Type /XObject`, `/Subtype /Form`, `/FormType 1`
- `/BBox [0 0 w h]` — `w,h` from the normalized absolute `/Rect`
- `/Matrix` — identity, or a BBox-preserving rotation from `/MK /R`
  (90/180/270)
- `/Resources << /Font << <key> <fontdict> >> >>` — register the DA font (reuse
  the `stamp.ts` Type1 font-dict pattern; copy from AcroForm `/DR /Font` when the
  named font lives there, else synthesize a Standard-14 Type1 dict). The
  resource key reuses the `/DA` font name when possible so the `/DA` string stays
  valid.
- content = MK painting + type-specific body, wrapped in `q … Q`

Buttons install a sub-dict `<< /<OnState> … /Off … >>`; text/choice install a
single stream.

### MK painting (all types, when `/MK` present)

- `/BG` array → fill the BBox (gray/RGB/CMYK by component count).
- `/BC` array → stroke an inset border at `/BS /W` width (default 1), honoring
  `/BS /S` (`S` solid, `D` dashed).
- Subsequent text/content is clipped to the border-inset rectangle.

### Text fields (`Tx`)

- **Single-line:** one line, vertically centered; horizontal placement by `/Q`
  (0 left, 1 center, 2 right) using `measure()`. Auto-size when DA size is 0:
  largest size that fits height (≈ `0.85·h`) and width.
- **Multiline** (`Ff` bit 13): greedy word-wrap by `measure()`, top-aligned,
  leading ≈ `1.15·size`; auto-size shrinks to fit all wrapped lines in the box.
- **Comb** (`Ff` bit 25, requires `/MaxLen`): `MaxLen` equal cells of width
  `w/MaxLen`, one glyph centered per cell.

### Checkbox / radio (`Btn`)

For each widget: if it already has `/AP /N` states, preserve them (current
behavior — setters flip `/AS`). Only when missing, synthesize `Off` (MK only)
and `<OnState>` (MK + a centered ZapfDingbats check `4`, or `l` circle for
radio). The on-state name comes from `form.ts`’s existing on-state logic.

### Choice (`Ch`)

- **Combo** (`Ff` bit 18): render the selected `/V` like a single-line
  left/`/Q` text field.
- **List:** draw each visible option line from `/Opt` starting at `/TI`; behind
  selected options (`/I` indices, else those matching `/V`) fill a highlight rect
  (`0.6 0.6 0.6 rg`); text left-aligned, clipped to the box.

## `/DA` parsing & metrics

### `parseDA` (`da.ts`)

Tokenize the default-appearance string (reuse `Lexer`) and scan operators,
keeping the last of each:

- `<name> <size> Tf` → font resource name + size (`0` = auto)
- `g` (gray), `rg` (RGB), `k` (CMYK→RGB) → fill color (default black)
- ignore everything else

Returns `{ fontName, size, color: [r,g,b] }`.

### `resolveDA(doc, field, acroForm)`

Field `/DA` if present, else AcroForm `/DA`, else default `"/Helv 0 Tf 0 g"`.
Map `fontName` to a base font: look it up in AcroForm `/DR /Font`, read its
`/BaseFont`; if that resolves to a Standard-14 name use it, otherwise substitute
Helvetica.

### Standard-14 metrics (`metrics.ts`)

Add `WIDTHS: Record<BaseFont, readonly number[]>` (256-entry WinAnsi-indexed
arrays per font) plus a name-normalization map (`Helv`, `HeBo`→Helvetica-Bold,
`Cour`, `TiRo`, `Symb`, `ZaDb`, …). Generalize to:

- `glyphWidth(font, code): number` (units/1000)
- `measure(font, bytes, size): number`
- `measureWinAnsi(bytes, size)` ≡ `measure('Helvetica', …)`

Symbol and ZapfDingbats use their own built-in encodings; v1 exercises only the
button glyphs (`4`, `l`) and basic Symbol coverage, so a partial-but-correct
table for those two is acceptable and documented.

## `/NeedAppearances` lifecycle

- A `Field.Value` setter generates that field's appearance and does **not** set
  `/NeedAppearances`, nor clear an existing global flag (other untouched fields
  may still rely on it).
- `Form.GenerateAppearances()` regenerates **all** fields, then **deletes**
  `/NeedAppearances`.
- `Field.GenerateAppearance()` regenerates one field; leaves the global flag
  as-is.

## Error handling & edge cases

- **Missing/degenerate `/Rect`** (absent or zero-area) → skip that widget, no
  throw. Generation is best-effort per widget.
- **Unencodable characters** → dropped, consistent with `encodeWinAnsi` in
  `stamp.ts`.
- **Auto-size floor:** below a minimum size (≈4pt) stop shrinking and clip to the
  box (no infinite shrink).
- **No widgets / pushbutton / signature** → no-op.
- **Existing `/AP`:** replaced for text/choice on regeneration (we own it);
  preserved for checkbox/radio unless absent.
- **Live-mutation invariant:** mutate live widget dicts and allocate new XObject
  stream objects via `doc.allocObject`; never touch `Save`’s renumbering.
  Generated streams are uncompressed `raw` bytes; `Save({ compressed })`
  flate-compresses them like any stream.

## Limitations (v1)

- Type0/embedded DA fonts can't be measured: layout uses Helvetica metrics as an
  approximation while drawing with the named font.
- Symbol/ZapfDingbats width coverage is limited to the glyphs v1 actually emits.
- No appearance generation for newly-created fields (none exist yet — fill-only).

## Testing strategy

Fixtures: extend `test/helpers/build-form-pdf.ts` (or add
`build-appearance-pdf.ts`) to emit widgets with `/Rect`, `/DA`, `/MK`, `/Q`,
flags, and `/Opt`/`/TI`/`/I`, matching existing builder style.

Unit tests:

- `da.test.ts` — `parseDA` across `Tf`/`g`/`rg`/`k`, missing/malformed strings;
  `resolveDA` fallback chain and DR→BaseFont→Standard-14 mapping.
- `metrics.test.ts` — spot-checked AFM widths per family (e.g. Helvetica
  space=278, Courier fixed=600), `measure` additivity, name normalization.
- `appearance.test.ts` — the core: for each field type, generate then assert the
  `/AP /N` is a `/Form` XObject with correct `/BBox`/`/Resources`; tokenize its
  content with `parseContentStream` and assert structure — `BT/Tf/Td/Tj/ET`
  present, correct font key & size, alignment offset within tolerance, multiline
  → N `Tj`s, comb → `MaxLen` placements, choice highlight emits `re … f` behind
  selected rows, MK emits fill/border ops.

Integration tests:

- Setter path: set a value → `/AP /N` exists and `/NeedAppearances` was not
  added.
- `Form.GenerateAppearances()` → all fields have `/AP`, global
  `/NeedAppearances` deleted.
- Round-trip: `Open → set → Save → Open` re-reads `/AP` and `/V` (also under
  `Save({ compressed })`).

Gates: `npm run typecheck` and full `npm test` green before close; the existing
suite stays untouched (the `measureWinAnsi` shim keeps `stamp.ts` tests stable).
