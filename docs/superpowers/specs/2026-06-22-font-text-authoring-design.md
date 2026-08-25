# Phase 6 — Font & Text Authoring (design)

Content-authoring roadmap **Phase 6**, the first phase after the Phase 5
composition/navigation epic (`aspose-pdf-foss-for-ts-639`) closed. This spec is
the shared design for the Phase 6 epic and blocks its implementation children.

Phase 6 enriches **text authoring**: it unlocks the full **Standard-14** font
set in `AddText` and adds real **multi-line text layout** (word-wrap, leading,
horizontal/vertical alignment, justification, overflow). It introduces **no font
file parsing** — every glyph-width table it needs already exists in
`metrics.ts`. It adds no new runtime dependencies and does not change the
full-rewrite `Save` model.

## Scope

Two independent tracks over the existing metrics infrastructure:

1. **Track F — Standard-14 selection** (`stamp.ts`): let `AddText` use any of
   the 12 Latin Standard-14 fonts (Helvetica/Times/Courier × regular/bold/
   italic/bold-italic), not just Helvetica.
2. **Track L — Multi-line layout** (`layout.ts` + `stamp.ts`): a new
   `page.AddTextBlock(text, rect, opts?)` that flows text into a rectangle with
   word-wrap, configurable leading, horizontal alignment (incl. justify),
   vertical alignment, and overflow handling.

### Key decisions (resolved during design)

- **No font embedding/subsetting.** Parsing TrueType/OpenType, glyph
  subsetting, and `Type0`/CIDFont embedding are deferred to a dedicated
  **Phase 7**. There is no sfnt/glyf/cmap parser in the codebase today; building
  one is a phase of its own. Phase 6 stays within the Standard-14 fonts, whose
  width tables already ship.
- **Track F is mostly wiring.** `metrics.ts` already exports a `StdFont` union
  and width tables for all 12 Latin Standard-14 fonts (plus Symbol/ZapfDingbats).
  `stampText` simply hardcodes Helvetica today; the change is to thread a font
  selection through registration and measurement.
- **Symbol/ZapfDingbats authoring is deferred.** Their width tables exist, but
  their *text → byte* encoders (built-in encodings, not WinAnsi) do not. Track F
  covers the 12 Latin fonts with WinAnsi encoding only.
- **`AddTextBlock` returns the overflow remainder.** Flowing into a fixed-height
  box, layout stops when the next line would cross the box bottom and returns the
  unconsumed text (`string | null`). Callers chain the remainder onto the next
  page or box. The alternative (a `boolean` "did it clip") was rejected: it loses
  the remainder, making multi-box/page flow impossible.
- **A rectangle box, not an anchored wrap.** `AddTextBlock` takes an explicit
  `[x, y, w, h]` rect (enabling vertical alignment and a real overflow contract)
  rather than extending `AddText` with a `wrapWidth`. `AddText` stays
  point-anchored and single-line.

### Dependencies (all shipped on `main`)

- `metrics.ts` — `StdFont` union, the internal per-font width map (`WIDTHS`),
  and the public `glyphWidth(font, code)`, `measure(font, bytes, fontSize)`,
  `measureWinAnsi`, `normalizeFont` — Track F measures via `measure`.
- `encoding.ts` — `encodeWinAnsi(text) → Uint8Array`.
- `stamp.ts` — `stampText`, `StampOptions`, `measureText`, `registerFont`
  (currently Helvetica-only), `buildStampBody`.
- `pagecontent.ts` — `appendContent`, `ensureOwnResources`, `ensureOwnSubdict`,
  `registerExtGState`, `freshKey`, `num`.
- `serialize.ts` — `enc`, `serializeString`.
- `page.ts` — `Page.AddText`, `Page.MeasureText` wiring points.

## Track F — Standard-14 selection (`stamp.ts`)

Add a `font` selector to the shared `StampOptions`:

```ts
export interface StampOptions {
  /** Standard-14 base font. Default 'Helvetica'. */
  font?: StdFont;
  fontSize?: number;                 // default 12
  color?: [number, number, number];  // default [0,0,0]
  rotate?: number;                    // default 0
  opacity?: number;                   // default 1
  align?: 'left' | 'center' | 'right'; // (AddText anchor align)
}
```

- **Normalization** validates `font` against the `StdFont` union (the 12 Latin
  names); an unknown name throws `TypeError`. Symbol/ZapfDingbats are *not*
  accepted by the authoring path in Phase 6 (no encoder), so they are excluded
  from the accepted set even though their metrics exist.
- **`registerFont(doc, page, font)`** generalizes today's Helvetica-only helper:
  it reuses an existing `/Font` entry whose `/BaseFont` matches `font` and
  `/Encoding` is `WinAnsiEncoding`, else allocates a `Type1` font dict with
  `/BaseFont = font` and `/Encoding = WinAnsiEncoding` under a fresh `F` key.
- **`measureText(text, fontSize, font?)`** and `Page.MeasureText` measure with
  the selected font's width table via `measure(font, encodeWinAnsi(text),
  fontSize)`. Default stays Helvetica for backward compatibility.

`buildStampBody` is unchanged except that the `Tf` operator names the
font-specific resource key (already parameterized).

## Track L — Multi-line layout

### L1 — Layout engine (`layout.ts`, new, internal)

A pure, dependency-free, unit-tested module that turns a string + box width +
font into positioned lines. No PDF objects, no document state.

```ts
// @internal
interface LaidLine {
  text: string;        // the line's text (no trailing newline)
  width: number;       // measured width in points at fontSize
  bytes: Uint8Array;   // WinAnsi-encoded bytes for emission
  hardBreak: boolean;  // true if this line ended at an explicit '\n' (or is last)
}

interface LayoutResult {
  lines: LaidLine[];   // lines that fit the box height
  remainder: string;   // unconsumed text ('' if everything fit)
}

function layoutText(
  text: string, font: StdFont, fontSize: number,
  boxWidth: number, boxHeight: number, leading: number,
): LayoutResult;
```

Algorithm:

1. **Split on explicit `\n`** into paragraphs; each newline forces a line break
   and marks the preceding line `hardBreak`.
2. **Greedy word-wrap** within a paragraph: accumulate space-separated words
   while the measured line width ≤ `boxWidth`; when the next word would exceed
   it, emit the current line and start a new one. A single word wider than
   `boxWidth` is emitted alone and **overflows horizontally** (no hyphenation —
   documented).
3. **Vertical fit**: lines consume `leading` of height each; stop emitting once
   the next line's baseline would fall below the box bottom
   (`usedHeight + leading > boxHeight`). Everything not emitted (including the
   partial word that triggered the stop) is returned as `remainder`, preserving
   original spacing/newlines so a follow-on `AddTextBlock` resumes cleanly.

The last emitted line of the whole result is treated as `hardBreak` for
justification purposes (a paragraph's final line is never justified).

### L2 — `page.AddTextBlock` (`stamp.ts` + `page.ts`)

```ts
page.AddTextBlock(
  text: string,
  rect: [number, number, number, number],   // [x, y, w, h], y = box bottom
  opts?: TextBlockOptions,
): string | null

interface TextBlockOptions extends Omit<StampOptions, 'align' | 'rotate'> {
  align?: 'left' | 'center' | 'right' | 'justify';  // default 'left'
  valign?: 'top' | 'center' | 'bottom';             // default 'top'
  leading?: number;                                  // default 1.2 * fontSize
}
```

- Validate `rect` (four finite numbers, `w > 0`, `h > 0`) and options
  (`TypeError` otherwise). Empty or all-unencodable text → no-op, returns `null`.
- Register the selected Standard-14 font (Track F `registerFont`) and, if
  `opacity < 1`, an `/ExtGState`.
- Run `layoutText`. Compute the vertical start: `top` anchors the first baseline
  near the box top (offset by the font ascent approximation = `fontSize`);
  `center`/`bottom` shift the laid block within the box height.
- Emit one `BT … ET` run: set font/size/fill (`Tf`/`rg`), position the first
  line with `Tm` (or `Td`), then for each subsequent line move by `0 -leading
  Td`. Per-line horizontal offset implements `left`/`center`/`right` (shift by
  `boxWidth - lineWidth` times 0/0.5/1).
- **Return** the layout `remainder` (or `null` if empty) so callers can flow the
  rest onto another box/page.

### L3 — Justified alignment

When `align === 'justify'`, non-`hardBreak` lines distribute their slack
(`boxWidth - lineWidth`) across inter-word gaps using the **`Tw` word-spacing**
operator: `Tw = slack / spaceCount` set before the line's `Tj`, reset to `0`
for `hardBreak` lines (paragraph ends and single-word lines). Lines with no
interior spaces fall back to left alignment. The whole result's final line is
never justified.

This lands as a separate child so its spacing math and last-line rule get
focused TDD coverage, mirroring the repo's small-issue convention.

## Module / file layout

| Module | Track | Responsibility |
|---|---|---|
| `stamp.ts` (extend) | F, L | `font` option; generalize `registerFont`/`measureText`; `stampTextBlock` emission |
| `layout.ts` (new) | L | pure word-wrap/line-break/measure → positioned `LaidLine`s + remainder |
| `page.ts` (wire) | F, L | thread `font` through `AddText`/`MeasureText`; add `AddTextBlock` |
| `index.ts` (export) | F, L | export `TextBlockOptions` (and any newly public types) |

## Errors

- `TypeError` — malformed `rect`/options, non-finite numbers, unknown/unsupported
  `font` name, wrong arity (consistent with the rest of the authoring API).
- No `UnsupportedFeatureError` expected — Phase 6 stays within Standard-14 +
  WinAnsi, which is always encodable (unencodable characters are dropped, as
  `AddText` already does).

## Testing strategy

Per-issue vitest TDD; the layout engine is unit-tested without a document:

- **Track F**: stamp with Times/Courier/bold variants; assert the `/Font`
  resource carries the right `/BaseFont`, that widths come from the right table
  (a Courier monospace run measures `n × 600/1000 × fontSize`), and that a
  `Save()`/`Open` round-trip preserves the font.
- **L1**: pure `layoutText` cases — greedy wrap at a width, explicit `\n`
  handling, an over-wide single word, vertical truncation returning the exact
  remainder, and `remainder` re-flowing into a second call to reconstruct the
  whole text.
- **L2**: `AddTextBlock` emits N lines for a known wrap; `left`/`center`/`right`
  offsets; `valign` block placement; overflow remainder returned; round-trip.
- **L3**: justify sets a positive `Tw` on interior lines, `0` on the last line
  and on `\n`-terminated lines; single-word lines fall back to left.

Every operation asserts a `Save()` / `Open` round-trip where it mutates a page.

## Non-goals (Phase 6)

- **Font embedding / subsetting** — TrueType/OpenType parsing, glyph subsetting,
  `Type0`/CIDFont embedding (dedicated **Phase 7**).
- **Symbol / ZapfDingbats authoring** — width tables exist; built-in-encoding
  text encoders do not.
- **Complex text** — RTL/bidi, combining marks, and OpenType shaping.
- **Hyphenation** and tab stops; an over-wide word overflows horizontally.
- **Rich runs** — mixed font/size/color within a single block (one block = one
  font/size/color).
- **Rotated text blocks** — `AddTextBlock` is axis-aligned (point-anchored
  `AddText` keeps its `rotate`).

## Beads decomposition

Epic `Phase 6 — Font & text authoring`, children:

| ID | Title | Depends on |
|---|---|---|
| 6.1 | Phase 6 design spec (this document) | — |
| 6.2 | F1 — Standard-14 font selection in `AddText` | 6.1 |
| 6.3 | L1 — internal text layout engine (wrap/break/measure) | 6.1 |
| 6.4 | L2 — `page.AddTextBlock` (rect flow, leading, align, valign, overflow) | 6.2, 6.3 |
| 6.5 | L3 — justified alignment (`Tw` distribution, last-line rule) | 6.4 |

Each child follows the repo's spec → plan → implementation cycle with vitest TDD,
matching the Phase 5 structure. README (Features, API overview, Limitations) is
updated as each public API lands.
