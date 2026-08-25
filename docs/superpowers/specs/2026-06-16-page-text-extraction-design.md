# Page Text Extraction — Design

**Issue:** aspose-pdf-foss-for-ts-e37 (P2, feature)
**Date:** 2026-06-16
**Depends on:** content-stream tokenizer (`src/content.ts`, issue 6lc — shipped)

## Goal

Add `Page.GetText(): string` — extract visible text from a page with reasonable
word and line ordering. Walk the content-stream op tuples from the tokenizer
(`parseContentStream`), track text/graphics state, decode showing-string bytes
through the active font's encoding, and assemble runs into lines.

### Acceptance criteria (from the issue)

- `GetText()` returns expected text for WinAnsi simple-font PDFs.
- `GetText()` returns expected text for `/ToUnicode`-mapped PDFs.
- Spaces and line breaks are reasonable.
- Image-only (no text-showing) pages return `""`.

## Design decisions

These were settled during brainstorming:

1. **Coordinate-based layout** (not op-order heuristics). Track the full text
   matrix so reading order is recovered even when content order differs from
   visual order, and so scaled/rotated content positions correctly.
2. **All three encoding tiers:** simple-font base encodings + `/Differences`;
   `/ToUnicode` CMap (takes precedence); `Type0`/CID composite fonts
   (Identity-H 2-byte codes + ToUnicode).
3. **API:** `Page.GetText(): string` — a PascalCase **method** (matches
   codebase style like `Document.Save()`; method, not getter, signals it does
   real work each call).
4. **Glyph advances are estimated** as `chars × fontSize × 0.5em` rather than
   reading real `/Widths` / `/W` tables. Advances only affect intra-line
   space insertion, not line breaking or run ordering. Real width tables are a
   possible follow-up if spacing quality proves insufficient.
5. **Recurse into Form XObjects** (`Do`), depth-guarded — headers/footers and
   stamped content often live there, and it reuses the same walker. Image
   XObjects are ignored.

## Module layout

Mirrors the existing per-feature module style (`content.ts`, `image.ts`,
`form.ts`). Zero new runtime dependencies; `node:` built-ins only.

| File | Responsibility |
|------|----------------|
| `src/encoding.ts` | Base encodings as `code(0..255) → Unicode codepoint` arrays for WinAnsi / MacRoman / Standard / PDFDoc. Plus a `glyphName → Unicode` map (a practical Adobe Glyph List subset) with algorithmic handling of `uniXXXX` / `uXXXXXX` names, used to resolve `/Differences`. Pure data + small helpers. |
| `src/cmap.ts` | Parse a CMap stream (`/ToUnicode` or embedded): `begincodespacerange`/`endcodespacerange`, `beginbfchar`/`endbfchar`, `beginbfrange`/`endbfrange`. Produces `{ lookup(code: number): string \| undefined; codeWidth: number }`. Reuses `Lexer` for tokenizing (hex strings, numbers, names, keywords). |
| `src/font.ts` | `TextFont` over a resolved font dict. Determines simple vs `Type0`, builds the decoder (precedence below), exposes `decodeRun(bytes) → string` and `codeWidth` (1 for simple fonts; 2 for Identity-H / from the ToUnicode codespace). |
| `src/text.ts` | Text-state machine that walks the op stream + line/word assembly. Exports `extractText(doc: Document, page: Page): string`. |
| `src/page.ts` | New `GetText(): string` delegating to `extractText(this.doc, this)`. |

`index.ts` needs no new public export (method lives on `Page`); export any
shared types only if a test or consumer needs them.

## Decoding precedence (`font.ts`)

Per font, build a decoder applied to each show-string. For each code (1 byte
for simple fonts, `codeWidth` bytes for Type0):

1. **`/ToUnicode`** CMap if present → wins (most reliable mapping to Unicode).
2. Else **simple font**: `code → base encoding glyph (WinAnsi / MacRoman /
   Standard / PDFDoc, honoring `/Encoding` name or `/Encoding` dict
   `/BaseEncoding` + `/Differences`) → Unicode`.
3. Else **Type0 / Identity-H**: 2-byte code → ToUnicode if available; otherwise
   the code is unmapped.
4. **Unmappable** code → dropped (avoids emitting garbage).

Base-encoding default: if no `/Encoding` is specified, default to StandardEncoding
for Type1 and WinAnsi for the common non-symbolic case; symbolic fonts without
ToUnicode may decode poorly — acceptable, and ToUnicode covers most real files.

## Text-state machine (`text.ts`)

Input: `parseContentStream(page.Contents)` (an array of `ContentOp`).

Tracked state:

- **Text matrix** `Tm` and **text line matrix** `Tlm` — 2×3 affine
  `[a b c d e f]`. Reset to identity on `BT`.
- **Graphics CTM** with a stack pushed/popped by `q`/`Q` and pre-multiplied by
  `cm`. Render position of a run = `Tm · CTM` applied to the text origin
  (plus text rise `Ts`). This makes scaled/rotated content position correctly.
- Text params: current `TextFont` + font size (`Tf`), char spacing `Tc`, word
  spacing `Tw`, horizontal scale `Tz` (percent), leading `TL`, rise `Ts`.

Operator handling:

| Operators | Effect |
|-----------|--------|
| `BT` / `ET` | `BT` resets `Tm = Tlm = identity`. |
| `Td tx ty` | `Tlm = translate(tx,ty) · Tlm; Tm = Tlm`. |
| `TD tx ty` | `TL = -ty`, then as `Td`. |
| `Tm a b c d e f` | `Tlm = Tm = [a b c d e f]`. |
| `T*` | as `Td 0 -TL`. |
| `Tc/Tw/Tz/TL/Ts` | set the corresponding param. |
| `Tf name size` | resolve font from `Resources/Font/<name>` (cached per dict); set size. |
| `Tj (str)` | show string → emit run; advance `Tm`. |
| `TJ [..]` | show with adjustments; numbers shift position (large negative → potential space). |
| `'` | `T*` then show. |
| `" aw ac (str)` | set `Tw=aw`, `Tc=ac`, `T*`, then show. |
| `q`/`Q`/`cm` | graphics CTM stack / pre-multiply. |
| `Do name` | if the XObject is a Form (`/Subtype /Form`), recurse: decode its stream, compose its `/Matrix` into CTM, use its `/Resources` (falling back to the page's), depth-guarded (e.g. max depth 8, cycle set). Image XObjects ignored. |

Each show op produces a **run**: `{ x, y, text, fontSize }` where `(x, y)` is the
device-space origin (`Tm · CTM` of `(0,0)`, plus rise). After showing, `Tm`
advances horizontally by the estimated run width (`chars × fontSize × 0.5`,
scaled by `Tz`) so consecutive `Tj` on the same line flow together.

## Line / word assembly

From the collected runs:

1. Sort by **Y descending** (PDF Y axis points up), then **X ascending**.
2. Group runs into lines: same line when baseline-Y differs by less than a
   tolerance (~`0.5 × fontSize`, with a small absolute floor).
3. Within a line, order by X and concatenate run text. Insert a single space
   when the X-gap between the previous run's estimated end and the next run's
   start exceeds ~`0.25 × fontSize`. Treat large `TJ` negative adjustments
   (beyond a threshold in text-space/1000 units) as a space within a run.
4. Join lines with `\n`; trim trailing whitespace per line. Optionally emit an
   extra blank line when the vertical gap between lines is large (> ~1.5 line
   heights) — kept minimal.
5. No runs → `""`.

Assumes predominantly horizontal text; vertical writing modes are out of scope
for v1.

## Testing

TDD per repo convention. New fixture builders in
`test/helpers/build-text-pdf.ts` (mirroring `build-pdf.ts` style — hand-written
classic-xref PDFs), and assertions in `test/text.test.ts`.

Fixtures / cases:

- **WinAnsi simple font** — basic Latin string round-trips.
- **`/Differences`** override — a remapped code decodes to the overridden glyph.
- **`/ToUnicode`-mapped font** — a font whose codes only make sense via the
  ToUnicode CMap (`bfchar` + `bfrange`).
- **`Type0` Identity-H + ToUnicode** — 2-byte codes decode via ToUnicode.
- **Multi-line / multi-run layout** — verifies newline inference between lines
  and space inference between separated runs on one line.
- **`cm`-transformed page** — text under a scale/translate CTM still extracts in
  correct order.
- **Image-only page** — content stream with no text-showing ops → `""`.

Run `npm run typecheck` and `npm test` green before closing the issue.

## Out of scope (possible follow-ups)

- Real glyph-width tables (`/Widths`, CID `/W`) for precise spacing.
- Vertical writing modes (`/Encoding Identity-V`, WMode 1).
- Symbolic TrueType fonts lacking `/ToUnicode` (best-effort only).
- Per-run style metadata / structured output (only a flat `string` is exposed).
- Embedded non-Identity CMaps beyond what `cmap.ts` parses for ToUnicode.
