# TOC page generation (`page.AddTOC`) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.1` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-27.

Parity target: `page.AddTOC(entries, rect, TOCOptions)` in
[Aspose-PDF-FOSS-for-Go](https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/blob/main/_examples/feature_showcase/main.go),
whose `TOCEntry{Title, Page, Label}` / `TOCOptions{EntryStyle, LineSpacing}` render
titles with dotted leaders, right-aligned page numbers and borderless GoTo links.

## Scope

Render a table of contents into a rectangle on an existing page: wrapped entry
titles, dot leaders, right-aligned page labels, one borderless GoTo link per
entry, optional nesting indent, and overflow either as a returned remainder or by
appending pages.

No new rendering primitives. Titles, leaders and labels go through `stampText`
(stamp.ts); links through `addLink` (annotation.ts); wrapping through `layoutText`
(layout.ts). This is an ergonomic layer, in the sense decorate.ts is one.

Out of scope, deliberately:

- A custom leader character. `leader` is `'dots' | 'none'`.
- A per-level style table. Per-entry `style` covers "bold level 1".
- `/TOC` + `/TOCI` structure tagging. That belongs to structwrite.ts, not here;
  filed as a follow-up issue.
- RTL mirroring of the row (title right, number left). Shaping options pass
  through to the title text, but the row's column geometry stays LTR.

## Modules

Mirrors the table layer's authoring/render split.

- **`src/toc.ts`** — page-independent model, validation, measurement:
  `TOCEntry`, `TOCOptions`, option normalization, and the pure measure pass.
- **`src/tocrender.ts`** — `AddTOCResult` and `drawTOC`: painting, links,
  pagination.
- **`src/stamp.ts`** — gains one `@internal` export, `wrapLines` (below).
- **`src/page.ts`** — `AddTOC` delegating to `drawTOC`.
- **`src/index.ts`** — exports `TOCEntry`, `TOCOptions`, `AddTOCResult`.

## API

```ts
/** One row of a table of contents. */
export interface TOCEntry {
  /** Row text; wrapped to the title column. */
  title: string;
  /** 1-based target page for the row's GoTo link. */
  page: number;
  /** Displayed right-hand text. Default: the target page's logical /PageLabels
   *  label, else its decimal page number. */
  label?: string;
  /** Nesting depth, integer >= 1. Default 1. Indents the title by
   *  (level - 1) * indent. */
  level?: number;
  /** Per-row typographic override, merged over the call defaults. */
  style?: Pick<TOCOptions, 'font' | 'fontSize' | 'color'>;
}

/** Inherits the typographic options of TextBlockOptions (font, fontSize, color,
 *  opacity, leading, shape/dir/script/language) minus the ones a TOC controls
 *  itself. */
export interface TOCOptions extends Omit<TextBlockOptions, 'align' | 'valign' | 'tag'> {
  /** Extra vertical gap between consecutive rows, points. Default 0. */
  rowGap?: number;
  /** Indent step per nesting level, points. Default 18. */
  indent?: number;
  /** Leader run between title and label. Default 'dots'. */
  leader?: 'dots' | 'none';
  /** Minimum blank gap on each side of the leader run, points. Default 4. */
  leaderGap?: number;
  /** Create a borderless GoTo link over each row. Default true. */
  links?: boolean;
  /** Destination view for those links. Default { type: 'Fit' }. */
  view?: OutlineView;
  /** Append pages sized to the anchor and draw every entry. Default false. */
  autoPaginate?: boolean;
}

/** The outcome of {@link drawTOC} / `page.AddTOC`. */
export interface AddTOCResult {
  /** Pages drawn onto, anchor first; length > 1 only in auto mode. */
  pages: Page[];
  /** Entries fully drawn, across all pages. (Go's "rows rendered".) */
  drawn: number;
  /** y of the bottom of the last drawn row on the last page; the box top when
   *  nothing was drawn. */
  endY: number;
  /** Entries that did not fit — manual mode only; undefined when all drawn. */
  remainder?: TOCEntry[];
}

// page.ts
AddTOC(entries: TOCEntry[], rect: [number, number, number, number], opts?: TOCOptions): AddTOCResult
```

`rect` is `[x, y, w, h]`, the authoring-call convention (`AddTextBlock`,
`AddImage`, `AddBarcode`) — not the annotation `[llx, lly, urx, ury]`.

`entry.page` is a 1-based page **number**, not a `Page` handle, because that is
what `GoToAction` already takes (actions.ts).

### Naming vs the Go target

Go's `LineSpacing: 2.4` has no direct equivalent: `leading` (baseline-to-baseline,
inherited from `TextBlockOptions`) already exists, so the between-row space is
`rowGap` rather than a third spacing vocabulary. Go's `EntryStyle: TextStyle{...}`
flattens into the inherited `font` / `fontSize` / `color`, making the parity call:

```ts
page.AddTOC(entries, [72, 160, width - 172, height - 340], {
  fontSize: 13, color: [0.1, 0.1, 0.15], rowGap: 2.4,
});
```

## Layout

### Column resolution

`numberWidth = max(measureText(label, row.fontSize, row.font))` over **all**
entries passed in — not only the ones that fit — so the number column lands at the
same x on every page of an auto-paginated TOC. Then per row:

```
rowRight   = x + w
numberLeft = rowRight - numberWidth
titleLeft  = x + (level - 1) * indent
titleWidth = numberLeft - leaderGap - titleLeft
```

`titleWidth <= 0` for any row (deep indent in a narrow box) throws a `RangeError`
naming the row, from the measure pass — before anything is drawn.

### Wrapping

Every line of a title wraps to the same `titleWidth`, the last line included; the
leader then fills from the last line's end to the number column. This needs one
`@internal` addition to stamp.ts:

```ts
/** @internal Greedy-wrap `text` to `width` with no height limit, reporting each
 *  line's measured width. Shares layoutText with flowTextBlock (and its shaped
 *  driver), so a caller that later draws these lines through stampText gets the
 *  same breaks. */
export function wrapLines(text: string, width: number, options: TextBlockOptions = {}):
  { text: string; width: number }[]
```

It is `layoutText(text, driver, fontSize, width, Infinity, leading)` with the
driver selection (`shapedDriver` vs `driverFor`) that `flowTextBlock` already
performs. The height-unbounded call is legitimate: `layoutText`'s Phase B keeps
lines while `used + leading <= boxHeight`, which never terminates early at
`Infinity`.

`rowHeight = max(lines.length, 1) * leading`; consecutive rows are separated by
`rowGap`. The `max(…, 1)` matters: `layoutText('')` returns no lines, so an empty
or fully-unencodable `title` would otherwise give a zero-height row with a
degenerate link rect. Such a row still occupies one line and still draws its
leader, label and link.

A row's `leading` defaults to `1.2 × that row's fontSize`, so a level-1 row at
16pt is not cramped by a 12pt call default. An explicit `opts.leading` applies to
every row uniformly.

### Painting one row

| Part | Call | Position |
|---|---|---|
| Title lines | `stampText` per line, `align: 'left'` | `titleLeft`, baseline `rowTop - leading*i - fontSize` |
| Leader | `stampText(dots, align: 'right')` | at `numberLeft - leaderGap`, last line's baseline |
| Label | `stampText(label, align: 'right')` | at `rowRight`, last line's baseline |
| Link | `addLink`, `{type:'goto', page, view}`, `border: 0` | `[titleLeft, rowBottom, rowRight, rowTop]` |

Dot count is `floor(gap / measureText('.'))` where
`gap = (numberLeft - leaderGap) - (lastLineEnd + leaderGap)`; `<= 0` dots draws no
leader. The run is right-aligned against the number column so leaders line up
vertically across rows — left-aligning them leaves the dots ragged where they meet
the numbers, which is the one place the eye follows them.

The link rect starts at `titleLeft`, not `x`, so a nested row's indent is not
clickable, and spans every line of a wrapped row.

### Row atomicity and guaranteed progress

A row is atomic: a wrapped title never splits across pages, which keeps exactly
one link rect per entry. A row taller than an **empty** box is drawn anyway and
overflows the box bottom, then pagination continues — the same choice `layoutText`
already makes for a word wider than its box ("emitted alone … no hyphenation").
Without this rule `autoPaginate` appends pages forever, and the manual-mode caller
loop below never advances.

## Pagination

**Manual** (default): draw what fits, return the undrawn tail as `remainder` — a
slice of the caller's array, so the same objects come back:

```ts
let rest = page.AddTOC(entries, rect, o).remainder;
while (rest?.length) rest = doc.AddPage().page.AddTOC(rest, rect, o).remainder;
```

Because a row that cannot fit an empty box is drawn regardless, `drawn >= 1`
whenever `entries` is non-empty, so this loop always advances.

**Auto** (`autoPaginate: true`): append pages with `doc.AddPage().page`, copying
the anchor's `MediaBox`, as tablerender.ts does, and reuse the **same rect** on
each continuation page. `AddTable`'s `topMargin` / `bottomMargin` have no analogue:
the caller already supplied a box, so "the same box on the next page" is the whole
policy.

`endY` is the bottom of the last drawn row, excluding any trailing `rowGap`.

## Validation and errors

Everything is validated before anything is drawn; a throwing call leaves the
document byte-identical, which is the creation invariant the form layer already
holds itself to.

The measure pass validates as a side effect: `wrapLines` / `measureText` route
through `normalizeBlockOptions`, so a bad font, `fontSize`, `color` or `opacity`
throws there. On top of that, toc.ts explicitly checks:

- `entries` is an array of objects with a string `title` (may be empty — see the
  one-line-minimum rule above).
- `level` is an integer `>= 1`; `rowGap`, `indent`, `leaderGap` are finite `>= 0`;
  `leader` is `'dots'` or `'none'`.
- `rect` is four finite numbers with positive `w` and `h`.
- **Per entry, `encodeAction(doc, {type:'goto', page, view})` is called and the
  dict discarded**, purely to validate the page range and the `view` shape.
  `encodeAction` allocates nothing when it throws, so a bad `entry.page` or a
  malformed `view` fails with nothing written rather than after ten rows are
  painted.

`RangeError` for out-of-range `entry.page` and for `titleWidth <= 0`; `TypeError`
for malformed shapes. Empty `entries` is a no-op returning
`{ pages: [page], drawn: 0, endY: y + h }` and leaves page content untouched.

## Labels

`entry.label` omitted resolves through pagelabels.ts: `parsePageLabels(doc)` once
per call, then `resolvePageLabel(labels, entry.page - 1)`; with no `/PageLabels`
covering the page, `String(entry.page)`. So roman front matter shows `iii`, which
is what the page itself shows. An explicit `label` always wins.

## Tests

`test/toc.test.ts`, fixtures from the existing `test/helpers/` builders.

- **Geometry**, asserted through `GetTextFragments` rather than raw content bytes:
  title at `titleLeft`, label right-flush at `x + w`, baselines at
  `rowTop - i*leading - fontSize`.
- **Leader alignment**: rows with different title lengths end their dot runs at the
  same x; a title that fills its column emits no dots.
- **Links**: one `/Link` per entry, `/A << /S /GoTo /D [pageRef /Fit] >>`,
  `/Border [0 0 0]`, rect spanning all lines of a wrapped row; `links: false` adds
  no `/Annots`.
- **Label default**: roman `/PageLabels` front matter → `iii`; no `/PageLabels` →
  `3`; explicit `label` wins.
- **Wrapping**: an N-line title gives row height `N × leading`, with leader and
  number on the last line only.
- **Levels & style**: `level: 2` indents and narrows the title column (moving the
  wrap point); a per-entry `fontSize` drives that row's default leading.
- **Pagination**: manual `remainder` is exactly the undrawn entries; auto mode
  appends pages carrying the anchor's `MediaBox` and keeps the number column at an
  identical x on page 2; a row taller than the whole box is drawn once and
  terminates.
- **Atomicity**: every throwing call leaves `doc.Save()` byte-identical to a
  pre-call save.

`README.md` gains `AddTOC` under the authoring section. `npm run typecheck` and
`npm test` must be green before the issue closes.
