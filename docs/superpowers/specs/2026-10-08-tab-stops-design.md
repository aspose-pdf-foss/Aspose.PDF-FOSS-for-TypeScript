# Tab stops with alignment and leaders — design (v9j3.1)

Part of epic `v9j3` (Flow authoring conveniences). Matches .NET's
`TabStops`. Approved in conversation on 2026-10-08; this records it.

## Goal

A tab character in authored text advances to a stated stop, aligned left,
right, centre or on a decimal separator, with an optional leader filling
the gap. It is available on `AddTextBlock` and every Flow text builder.
TOC rows share its leader fill, and DOCX import renders Word's tab stops.

## Baseline (measured)

Today a tab stays in the line text at zero width with no break
opportunity. `encodeWinAnsi` drops it, so `Name\tValue` lays out as one
word and draws as `NameValue`. `wmlruns.ts` drops every `w:tab` and
reports `w:tab`. `w:pPr/w:tabs` is not read.

## Decisions

1. **Scope:** text blocks, Flow paragraphs, headings and list items, TOC
   leader reuse, and DOCX import. Table cells, Markdown and HTML are out of
   scope: a cell's tab stays zero-width, and DOCX import reports
   `w:tab (in a table cell)`.
2. **Opt-in.** Tabs take effect only when `tabStops` is stated, and `[]`
   means default stops only. Without it the output is byte-identical. DOCX
   import always opts in.
3. **The mechanism lives in the wrapping engine** (`layoutRuns`), so
   measurement and painting agree by construction. Pre-splitting into
   columns was rejected because it cannot wrap. Atomics were rejected
   because a tab's width depends on its line position, which only the pack
   loop knows.

## API

```ts
interface TabStop {
  position: number;   // points from the block's LEFT TEXT EDGE (before indent)
  align?: 'left' | 'right' | 'center' | 'decimal';           // default 'left'
  leader?: 'none' | 'dot' | 'middleDot' | 'hyphen' | 'underscore' | 'line'; // default 'none'
  decimalChar?: string;   // decimal stops only; one character; default '.'
}
// TextBlockOptions and FlowParagraphOptions (a Flow may set a default):
tabStops?: TabStop[];
defaultTabInterval?: number;   // default 36pt (Word's 0.5in)
```

Every option is validated before anything is drawn:

- **TypeError:** a non-finite position, an unknown `align` or `leader`, or
  a `decimalChar` that is not exactly one character.
- **RangeError:** a negative position, a duplicate position, or a
  `defaultTabInterval` that is not greater than 0.

Stops are sorted, so the order they are given in does not matter.
`tabStops` together with `shape: true` throws `TypeError`, because shaping
is single-run.

## Wrapping rules (in the pack loop)

1. **Stop choice.** A tab goes to the first explicit stop strictly past
   the pen's x, measured from the text edge. Past the last explicit stop,
   it goes to the next multiple of `defaultTabInterval`. There are no
   default stops left of the last explicit stop.
2. **Alignment.** The *tab segment* is the text after the tab, up to the
   next tab or the line end.
   - `left` starts it at the stop.
   - `right` ends it at the stop.
   - `center` centres it on the stop.
   - `decimal` puts its first `decimalChar` on the stop, and falls back to
     `right` when the segment has none.

   A segment that would start before the pen starts at the pen instead, so
   it is pushed right and never overprints.
3. **Breaking.** A tab is a break opportunity (break after). If no stop
   lies within the line width, the tab ends the line and draws nothing. A
   long tab segment wraps at its spaces, and the continuation starts at the
   margin. Hyphenation is unchanged.
4. **Indent and justification.** Stops are measured from the edge, so a
   first-line indent past a stop skips it. Justified `Tw` spreads only over
   spaces after the line's last tab.
5. **Unchanged:** line heights, `usedHeight`, pagination, and the raw-tail
   remainder.

## Painting

- A tab never reaches `driver.encode`. Its resolved width is emitted as a
  `[ -N ] TJ` kern in the font in force, the inline-atomic mechanism.
  `segmentBoxes` reads the resolved widths, so decoration, backgrounds and
  link rects follow, and a decorated run underlines across its tab gap.
- **Glyph leaders** (`.` `·` `-` `_`) are as many copies as fit in the gap,
  less a quarter-em clear at each end, right-aligned against the next
  segment, in the tab's own run font, size and colour. A face that cannot
  draw the leader glyph draws no leader. The count and the alignment come
  from ONE function shared with TOC.
- **`line`** is a vector rule on the baseline, drawn after the text the way
  decorations are, using the font's underline metrics.
- In a tagged block, leaders are wrapped as `/Artifact`.
- **Extraction:** a tab gap reads as a space (`567g`'s rule), and an
  untagged leader reads as its glyphs. The tab character does not round-trip.

## TOC

The leader computation in `tocrender.ts` moves to the shared leader-fill
function. Row structure is unchanged: a wrapped title, and a label on the
last baseline. TOC output stays byte-identical, fenced by a hash recorded
before the change. Rebuilding rows as a right tab stop was rejected: it
needs a "right indent for every line but the last" concept, and it would
move TOC bytes for no visible gain.

## DOCX import

- **`wmlstyles.ts`** resolves `w:tabs` through `docDefaults`, then the
  style chain, then the numbering level, then direct formatting. Stops
  accumulate down that chain, and `w:val="clear"` removes an inherited stop
  at its position (ECMA-376 17.3.1.37). `settings.xml`'s
  `w:defaultTabStop` gives the default interval in twips, else 720.
- **Mapping:**
  - Alignment: `left`/`start` → left; `right`/`end` → right; `center`;
    `decimal`.
  - Leaders: `dot`, `hyphen`, `underscore` and `middleDot` map directly;
    `heavy` → `line`; `none`.
  - Positions are twips → points, measured from the paragraph's left text
    edge.
  - Reported and skipped: `bar` and `num`.
  - `w:ptab` is reported and drawn as a default tab.
- **`wmlruns.ts`** writes each `w:tab` as a tab in the run text, and the
  paragraph opts in with its stops. It is no longer reported, except in a
  table cell.

## Testing

- **Engine unit tests** in Courier, for exact arithmetic. One per rule
  above. The fit and break cases assert both sides of the boundary.
- **Painting:**
  - glyph positions read back through `visitContent` land on the stops;
  - leader glyphs end where TOC's would;
  - the `line` rule's geometry;
  - leaders are `/Artifact` when tagged, and `ValidatePdfUa` reports nothing
    new;
  - `GetText` reads a tab as a space;
  - underline and link rects follow the tab gaps.
- **Fences:** `rich-runs-identity`, `markdown-flow`, `html-identity`,
  `docx-flow-identity` and the reflow fences stay unedited. A new TOC hash
  is recorded before the extraction. Text containing tabs, with
  `tabStops` absent, must stay byte-identical.
- **DOCX:**
  - hand-built WordprocessingML cases for chain resolution and `clear`;
  - a corpus recipe written by Word 2010 and LibreOffice, with the stops
    held to what both readers agree on;
  - a Word COM horizontal-position oracle (`Range.Information`) for where
    the stops land;
  - the existing `w:tab` report expectations updated.
- **Mutation sweep:** run over every rule, and record any green mutant
  honestly.

## Docs

- README: a Key Capabilities line, an example, and API Reference rows for
  `TabStop`, `tabStops` and `defaultTabInterval`
  (`test/readme-api.test.ts` requires them).
- CHANGELOG: an entry under Added.
- CLAUDE.md: invariants under `layout.ts`, `toc.ts` and `wmlstyles.ts`.
