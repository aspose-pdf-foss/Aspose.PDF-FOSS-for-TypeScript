# Design: Text stamping / content addition (`Page.AddText`)

Issue: aspose-pdf-foss-for-ts-b3y — Content addition / stamping (text watermark, page numbers)

## Goal

Append text to a page (watermarks, page numbers) without disturbing existing
content. Stamp given text at a position, optionally sized, colored, rotated, and
semi-transparent, anchored left/center/right. Output round-trips through `Save()`
and renders in a real viewer. The Standard-14 Helvetica font is registered into
the page `/Resources/Font` at most once per page.

Depends on the content-stream tokenizer (`src/content.ts`, issue 6lc — done). We
reuse its serialization helpers rather than re-tokenizing existing content.

## Public API

```ts
interface StampOptions {
  /** Font size in points. Default 12. */
  fontSize?: number;
  /** Fill color as RGB components in 0..1. Default [0, 0, 0] (black). */
  color?: [number, number, number];
  /** Rotation in degrees, counter-clockwise, about the anchor (x, y). Default 0. */
  rotate?: number;
  /** Fill opacity in 0..1. Default 1. When 1, no /ExtGState is emitted. */
  opacity?: number;
  /** Which point of the baseline (x, y) anchors. Default 'left'. */
  align?: 'left' | 'center' | 'right';
}

class Page {
  /** Stamp `text` at (x, y) in PDF user space. Existing content is preserved. */
  AddText(text: string, x: number, y: number, options?: StampOptions): void;

  /** Rendered width of `text` in points for the stamping font at `fontSize`
   *  (default 12). Uses Helvetica AFM metrics. */
  MeasureText(text: string, fontSize?: number): number;
}
```

### Semantics

- `(x, y)` is the **baseline anchor** in PDF default user space: origin at the
  bottom-left of the page, units in points (1/72"). For `align: 'left'` it is the
  left edge of the baseline; `'center'`/`'right'` shift the text so (x, y) lands
  at the horizontal center / right edge.
- `rotate` rotates the text counter-clockwise about (x, y).
- Coordinates are raw user space — no automatic compensation for `/CropBox`
  origin or `/Rotate`. Callers that need that compute it themselves (a follow-up
  can add a convenience helper; out of scope here).
- **Unencodable characters** (not representable in WinAnsiEncoding) are dropped
  silently. Stamping must not throw on a stray glyph. `MeasureText` measures the
  same dropped-down string, so width and rendered output agree.
- Invalid numeric options (non-finite `fontSize`, `opacity` outside 0..1, color
  components outside 0..1, non-finite `rotate`, malformed `color` array) throw
  `TypeError`. Empty/whitespace text is a no-op that still registers no garbage.

## Architecture

### New module: `src/metrics.ts`

- `HELVETICA_WIDTHS: readonly number[]` — 256-entry table indexed by WinAnsi byte
  code, glyph advance widths in 1000-unit em space, transcribed from the Adobe
  Core-14 Helvetica AFM. Codes with no glyph get width 0.
- `export function measureWinAnsi(bytes: Uint8Array, fontSize: number): number` —
  sum of widths, scaled: `Σ width[b] / 1000 * fontSize`.

The table is the only sizable data addition. It is mechanical reference data
(like the existing Annex-D encoding tables) and lives in its own module so it can
be reviewed and tested independently.

### `src/encoding.ts` (addition)

- `export function encodeWinAnsi(text: string): Uint8Array` — reverse of the
  existing `winAnsi` table, built once into a `Map<codepoint, byteCode>`. Maps a
  JS string to WinAnsi bytes, dropping codepoints with no WinAnsi slot. Reuses
  the existing `winAnsi` array as the single source of truth.

### New module: `src/stamp.ts`

```ts
export function measureText(text: string, fontSize: number): number;
export function stampText(
  doc: Document, page: Page,
  text: string, x: number, y: number, options: StampOptions,
): void;
```

`stampText` orchestrates: validate options, encode text to WinAnsi bytes, measure
width, register resources (font + optional ExtGState), build the stamp content
stream, and splice it into the page `/Contents`. It uses `doc.resolve`,
`doc.allocObject` (see below), and the `enc` / `serializeString` helpers from
`src/serialize.ts`. `Page.AddText` and `Page.MeasureText` are thin delegates.

### `src/document.ts` (addition)

One `@internal` helper, mirroring the `alloc` callback already used by
`SetOutlines`:

```ts
/** @internal Allocate a fresh indirect object, returning its ref. */
allocObject(obj: PdfObject): PdfRef {
  const n = this.maxObjNum() + 1;
  this.objects.set(n, obj);
  return ref(n);
}
```

No other widening of the `Document` public surface. `Page` already holds the
owning `doc`; `AddText` calls `stampText(this.doc, this, ...)`.

## Resource registration (dedup — "added once")

### Inherited-Resources safety

`/Resources` may be inherited from a `/Pages` ancestor and shared across pages.
We must never **shadow** it with a fresh empty dict on the page — that would hide
the fonts/XObjects the existing content depends on, breaking rendering. So:

1. If the page dict has its own `/Resources`, use it.
2. Otherwise shallow-copy the inherited `/Resources` (copy the `Map` entries —
   they are refs/sub-dicts, shared safely) onto the page's own dict, then use
   that copy.

The same shallow-copy-if-inherited applies to the `/Font` and `/ExtGState`
sub-dicts before we add a key, so we mutate only structures owned by this page.

### Font

- Scan the page's effective `/Resources/Font`. If an entry resolves to a dict
  that is Helvetica + WinAnsiEncoding (`Subtype` Type1, `BaseFont` Helvetica,
  `Encoding` WinAnsiEncoding), reuse its key.
- Otherwise allocate an indirect font dict and register it under a fresh,
  non-colliding key (`F0`, `F1`, … — first `F<n>` not already present):

  ```
  << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>
  ```

Stored as an **indirect object** (via `allocObject`), conventional and keeps the
resource dict compact.

### ExtGState (only when `opacity < 1`)

- Scan `/Resources/ExtGState` for a dict with matching `/ca` and `/CA` equal to
  the requested opacity; reuse its key if found.
- Otherwise allocate an indirect `<< /Type /ExtGState /ca o /CA o >>` under a
  fresh `GS<n>` key.

When `opacity === 1`, no ExtGState is registered and no `gs` operator is emitted.

## Content assembly (preserve existing content)

Normalize `/Contents` to an array of indirect stream refs and wrap defensively
against an unbalanced graphics state left by existing content:

```
/Contents = [ <q-stream>  …existing stream refs…  <Q+stamp stream> ]
```

- `<q-stream>` is a new indirect stream whose body is `q`.
- `<Q+stamp stream>` is a new indirect stream whose body is `Q\n` followed by the
  stamp body (below). The leading `q` / trailing `Q` neutralize any CTM that
  existing content modified without restoring, so the stamp draws at the page's
  base coordinate system.
- If the page has **no** existing content, `/Contents = [ <stamp stream> ]` with
  no q/Q wrapper needed (the stamp body is self-balancing).

Existing `/Contents` may be a single ref or an array of refs; both normalize to
the array form. (Direct inline streams, if ever present, are allocated an object
number via `allocObject` so the array holds only refs.)

### Stamp body

```
q
/GS0 gs                              % only when opacity < 1
BT
/F0 <fontSize> Tf
r g b rg
cosθ sinθ -sinθ cosθ tx ty Tm        % θ = rotate in radians
(<escaped WinAnsi bytes>) Tj
ET
Q
```

- Color emitted with `r g b rg`.
- Alignment folds into the text-matrix translation:
  `tx = x − f·w·cosθ`, `ty = y − f·w·sinθ`, where `w` is the measured width and
  `f ∈ {0 (left), 0.5 (center), 1 (right)}`.
- The shown string is escaped with `serializeString` from `src/serialize.ts`.
- New streams are uncompressed; the serializer recomputes `/Length` from the raw
  bytes, so no filter is needed.

Numbers in the content stream are formatted to a fixed, compact precision (e.g.
trim trailing zeros, cap fractional digits) to avoid `0.30000000000000004`-style
noise.

## Testing (TDD, vitest)

Fixture builder `test/helpers/build-stamp-target.ts`: a minimal single-page PDF
with a small amount of existing content (so "preserved" is observable), built in
the style of the existing `test/helpers/` builders. A variant produces a page
that relies on inherited `/Resources` (Resources on the `/Pages` node, not the
page) to exercise the shadow-safety path.

Tests (`test/stamp.test.ts`):

1. **Round-trip:** stamp text → `Save()` → reopen → `GetText()` contains both the
   original content's text and the stamped text.
2. **Font dedup:** two `AddText` calls on the same page → exactly one Helvetica
   entry in `/Resources/Font`.
3. **ExtGState:** `opacity < 1` registers exactly one `/ExtGState` entry and emits
   `gs`; `opacity === 1` registers none and emits no `gs`.
4. **Measurement:** `MeasureText` returns the AFM-derived width for a known
   string within a tight tolerance; scales linearly with `fontSize`.
5. **Inherited resources:** stamping a page whose `/Resources` is inherited adds
   the font without losing access to the inherited resources (existing content
   still resolves; original text still extractable after save).
6. **Alignment:** `align: 'center'`/`'right'` shift the emitted `Tm` translation
   by `0.5·w` / `w` versus `'left'` (assert on the generated content bytes).
7. **Rotation:** `rotate` produces the expected `cosθ sinθ -sinθ cosθ` matrix
   coefficients in the content.
8. **Validation:** out-of-range `opacity`/`color`, non-finite `fontSize`/`rotate`
   throw `TypeError`; unencodable characters are dropped (no throw); empty text
   is a no-op.

Real-viewer rendering is the manual acceptance check on the issue; the automated
suite covers structural round-trip and the resource/content invariants.

## Documentation

Update `README.md` (Features + API overview) with `Page.AddText` / `MeasureText`
once the API lands.

## Out of scope (file follow-ups if wanted)

- Fonts other than Helvetica / Standard-14 (bold/italic variants, embedded
  fonts, non-Latin scripts).
- Automatic `/CropBox` / `/Rotate` coordinate compensation helpers.
- Multi-line / wrapped text, vertical text, line spacing.
- Stamping images or vector graphics (separate content-addition primitives).
