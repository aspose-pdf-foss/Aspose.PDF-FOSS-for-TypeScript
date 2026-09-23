# FreeText rich text (`/RC`) — design

Issue: `v0tz.3`, narrowed to FreeText. Rich-text form fields (`/RV`) are split
into their own issue, because they carry a separate question: whether an
appearance may reference the form's `/DR` font rather than a fresh Standard-14
one.

## Problem

A FreeText comment's styling lives in `/RC`, an XHTML fragment (ISO 32000-1
12.7.3.4). Nothing draws it. Two cases reach the user:

1. **Import.** XFDF/FDF import calls `annotdraw.ts`'s `regenerateAppearance`
   for an annotation arriving without `/AP`; its FreeText branch draws plain
   `/Contents`, so a styled comment flattens unstyled.
2. **No `/AP` at all.** A FreeText from another tool with `/RC` and no `/AP`
   draws nothing: `annotappearance.ts`'s viewer fallback covers `/Text`,
   `/FileAttachment` and `/Stamp` only.

`AddFreeText({ richText })` — making this library an `/RC` producer — is out of
scope.

## Approach

A pure rich-text module feeding the ONE wrapping engine, `layout.ts`'s
`layoutRuns`, with a Standard-14 `winAnsiDriver` per face. Rejected: growing
`appearance.ts`'s private word-wrapper into a second rich-text engine; routing
through the HTML stack, which needs a `Document`, font loading and a page, and
would make rendering allocate.

## What is understood

**Elements** (Table 227 plus `<br>`): `<body>`, `<p>`, `<span>`, `<b>`, `<i>`,
`<br>`. `<b>`/`<i>` set weight/style. `<p>` and `<br>` break lines, by the
block-boundary rule `richtext.ts` already owns. Any other element is
TRANSPARENT: its text kept, its tag ignored.

**Properties**, from a `style` attribute on any element, or from `/DS` (the
default style string, applied beneath everything):

| Property | Handling |
|---|---|
| `font-size` | pt; px (x0.75) and em (x parent size) accepted |
| `font-weight` | `bold`/`bolder`/`normal`/`lighter`, or a number (600+ is bold) |
| `font-style` | `italic`/`oblique` are italic, `normal` is not |
| `font-family` | a list; the FIRST name recognised wins — Helvetica, Arial, sans-serif to Helvetica; Times, Times New Roman, serif to Times; Courier, Courier New, monospace to Courier. A list naming nothing recognised leaves what the run inherited |
| `font` | the shorthand, since Acrobat writes `/DS` as `font: Helvetica 12pt` |
| `color` | any form `cssvalue.ts`'s `colorOf` parses |
| `text-align` | left/center/right/justify, per paragraph |
| `text-decoration` | `underline`, `line-through` |

**Inheritance:** down the tree from `/DS`, beneath which `/DA`'s size and
colour, beneath which Helvetica 12pt black.

**Ignored, documented:** `vertical-align`, `font-stretch`, backgrounds,
margins, nested block layout. A `style` value that does not parse is skipped
and the run keeps what it inherited.

**Faces:** the 12 Standard-14 text faces. Characters WinAnsi cannot encode are
dropped, as for every Standard-14 appearance here.

## Modules and data flow

**`richlayout.ts`** — a pure leaf over `xml.ts`, `cssparse.ts`, `cssvalue.ts`,
`layout.ts`, `metrics.ts` and `textdecor.ts`. No `Document`, no allocation.

- `parseRichText(markup, ds, base) -> RichParagraph[] | undefined` —
  `RichParagraph = { align, runs: RichRun[] }`,
  `RichRun = { text, face: StdFont, size, color, underline, strike }`.
  `undefined` when the markup will not parse. It parses as `richtext.ts` does,
  wrapping the fragment in a synthetic root so several top-level `<p>` survive.
- `richTextBody(paragraphs, boxW, boxH, inset) -> { body, faces }` — each
  paragraph laid out by `layoutRuns`, paragraphs stacked top-down, emitted as
  `BT`/`Tf`/`rg`/`Td`/`Tj`/`ET`, `Tw` on justified lines, filled rects for
  underline and line-through from `vmetricsFor`. `faces` maps each font key the
  body names (`F0`, `F1`, …) to its face.

**One FreeText builder, two wrappers.** `annotdraw.ts`'s `freeTextBody` becomes
a pure `freeTextAppearanceParts(doc, dict) -> { body, faces }`: it reads the
dict and allocates nothing, uses `/RC` when it parses and otherwise today's
plain `/Contents` path; frame, fill, `/RD` padding and the `/CL` callout are
drawn exactly as now.

- `regenerateAppearance` (import) registers the faces as allocated font
  objects and installs the `/AP`, as now.
- `annotappearance.ts`'s `viewerAppearance` gains a `/FreeText` case for an
  annotation with NO `/AP` key, with INLINE font dictionaries — rendering
  allocates nothing (`v0tz.1`/`v0tz.2`'s rule).

**A FreeText without `/RC` does not move:** it takes today's plain path,
pinned by hashing a regenerated appearance before and after.

## Layout

The box is the `/RD`-inset rect less the border width, with the plain path's
`PAD`. Top-anchored; each paragraph starts a new line; line height is
`layoutRuns`' per-line band. Overflow is clipped by the form's `/BBox`, as the
plain path is — no shrink-to-fit, which viewers do not do for FreeText.
`justify` does not stretch a paragraph's last line.

## Errors

Nothing throws on damage. Unparseable markup, or `/RC` reducing to no text,
falls back to plain `/Contents`, so a comment is never drawn emptier than its
plain text. An unparseable style value is skipped. A `ResourceLimitError`
(e.g. nesting past `maxNestingDepth`, which `xml.ts` enforces) propagates, as
every `catch` calls `rethrowLimit`.

## Testing

- `test/richlayout.test.ts` — the pure module from strings: elements,
  inheritance and `/DS`; the family stack including the unknown-family case;
  the `font` shorthand; colours; alignment; decorations; the parse-failure
  result. Asserts run structure directly.
- `test/freetext-rich.test.ts` — end to end: text via `SearchAnnotations`;
  per-glyph font, size and colour via `GetTextFragments` after
  `FlattenAnnotations` (a bold word in Helvetica-Bold, a red word red, the
  styling surviving the flatten); the XFDF-import path and the no-`/AP`
  fallback both.
- A hash fence on plain FreeText regeneration.
- Each rule mutation-checked.

## Docs

CHANGELOG Added; README annotation bullet; CLAUDE.md entry for
`richlayout.ts`; a new `v0tz` issue for rich-text form fields.
