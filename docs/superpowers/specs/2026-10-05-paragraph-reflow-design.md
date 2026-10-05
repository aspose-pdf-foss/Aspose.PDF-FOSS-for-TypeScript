# Paragraph reflow after replace (u3l5.5)

## Goal

`page.ReplaceText(find, replacement, { adjust: 'reflow' })` and the same on
`doc.ReplaceText` re-wrap every paragraph a match touches, so a longer or
shorter replacement reads like text that was always there: words move between
lines, the paragraph may grow into free space below it, and nothing is
overprinted. Where that cannot be done safely, the call refuses and changes
nothing.

This is the fourth `ReplaceAdjust` mode, after `'none'`, `'shiftRest'` and
`'spaceWidth'` (u3l5.4). It mirrors .NET's ShiftRestOfContents together with
whole-word line breaking.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| Q1 | Which documents | Tagged and untagged. A tagged document's paragraph is its block-level structure element; an untagged one's is the geometric `TextBlock`. Ambiguity refuses. |
| Q2 | How text is written back | Reposition the existing glyph bytes: split operators at new line starts and insert `Tm`/`TJ` kerns. Nothing is re-encoded, so fonts, colours, kerning inside words and marked content survive. |
| Q3 | Vertical growth | Grow only into free space below the paragraph, up to the next ink or the crop box. Refuse if it does not fit. A shrunk paragraph leaves its gap; content below never moves. |
| Q4 | Alignment | Detect left, right, centred or justified, keep the first-line indent; ambiguous falls back to left. Justification spreads kerns at word gaps, never `Tw`. |
| Q5 | API | `adjust: 'reflow'`. A refusal throws `UnsupportedFeatureError`; `onUnreflowable` turns it into "replace without reflow and report". |
| Q6 | Annotations | Links and the four text-markup subtypes move with their glyphs (`/QuadPoints` and `/Rect` recomputed). Any other annotation overlapping the paragraph refuses. |
| — | Where wrapping starts | At the line holding the first edit. Lines before it keep their breaks; re-wrapping from line 0 could change lines the edit never touched, since a producer's breaks need not be greedy. Wrapping stops at CONVERGENCE — the first new break that lands on an original break with no pending edit after it — and later lines keep their breaks, moving down by (lines added) × pitch. |

## API

```ts
type ReplaceAdjust = 'none' | 'shiftRest' | 'spaceWidth' | 'reflow';

interface ReplaceTextOptions {
  // …existing…
  /** With adjust: 'reflow', called once per paragraph that cannot be reflowed;
   *  that paragraph's matches are then replaced without reflow. Without it,
   *  such a call throws UnsupportedFeatureError and changes nothing. */
  onUnreflowable?: (r: UnreflowableText) => void;
}

interface UnreflowableText {
  page: number;          // 1-based
  match: string;         // the first match in the paragraph
  reason: UnreflowableReason;
}

type UnreflowableReason =
  | 'vertical' | 'rotated' | 'scopes' | 'interleaved' | 'foreign-ink'
  | 'annotation' | 'pitch' | 'no-room' | 'not-found';
```

`onUnreflowable` given with an `adjust` other than `'reflow'` is a `TypeError`
(an accepted-and-ignored key is the trap `region` already records).

## Units

### `reflowpara.ts` — finding the paragraph (pure)

Input: the page's glyph events in content order, its layout (`text`, `refs`,
lines), the structure lookup (MCID → element) when tagged, and the anchor
glyph of each edit. Output per touched paragraph: a `Paragraph` or a reason.

- **Tagged:** the element owning the anchor glyph's MCID, walked up to the
  nearest block-level type (`P`, `H1`–`H6` and `Hn`, `LBody`, `TD`, `TH`,
  `Caption`, `BlockQuote`, `Note`, through the RoleMap). Its glyphs are every
  glyph whose MCID belongs to that element's subtree.
- **Untagged:** the `TextBlock` holding the anchor, from the grouping
  `extractStructured` applies. That grouping is extracted into a function
  both call, so the two cannot disagree about what a block is.

`Paragraph` carries: words in reading order (each a list of glyphs, with the
gap before it — a space glyph's advance, or the inferred distance), original
lines (word ranges, baseline, left and right edge), the box, the pitch, and
the alignment.

**Alignment** (tolerance 0.5pt): justified when every line but the last shares
both edges; left when lefts agree (line 0 may be indented); right when rights
agree; centred when centres agree; otherwise, or with one line, left. The
first-line indent is line 0's left minus the others' (0 with one line).

**Pitch:** the median baseline distance. A one-line paragraph uses 1.2 × its
dominant font size.

**Refusals**, each a reason above, all at plan time:

- `vertical` — any glyph `vertical`; `rotated` — any glyph angle not 0 within
  0.01 rad, or a CTM/`Tm` with skew or unequal axis scale;
- `scopes` — paragraph glyphs in more than one scope path;
- `interleaved` — a non-paragraph glyph in the same pen chain (no `PEN_RESET`
  between) as a paragraph glyph, either side;
- `foreign-ink` — any non-paragraph glyph, image or path inside the box;
- `annotation` — an annotation overlapping the box other than `/Link`,
  `/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly`;
- `pitch` — baseline distances varying by more than 10%;
- `no-room` — the added lines would reach the next ink below (any glyph, image
  or path overlapping the box's horizontal span) or the crop box bottom;
- `not-found` — the anchor is in no paragraph (a tagged glyph with no MCID,
  for instance).

### `reflowwrap.ts` — wrapping (pure)

Each word is an ATOMIC `LayoutRun` (U+FFFC with its measured width); each gap
is a one-space text run whose driver measures exactly that gap's width. That
keeps `layoutRuns` the one wrapping engine while breaking only BETWEEN words —
a replacement containing spaces stays one unbreakable unit, and nothing is
hyphenated. Word width is the sum of its glyph advances, with each edit's new
runs measured by u3l5.4's `runsAdvance`.

Wrapping starts at the first edited line, with the box width from that line's
left (indent applied on line 0 only) to the paragraph's right edge. It runs
until convergence, then hands back:

- each reflowed word's target device point (baseline y = first line's y −
  i × pitch; x from the alignment; justified lines spread the slack evenly
  over their gaps, the last line not);
- for each later line, the vertical shift (lines added × pitch).

### `textedit.ts` — writing

`ShowPiece` gains `{ kind: 'op'; op: ContentOp }`, written between pieces;
`applyEdits` gains insertions AFTER an operator. Glyph events gain `tm`,
`tlm` and `ctm` (the matrices in force), REQUIRED like `tfSize`.

Walking paragraph glyphs in content order and tracking each scope's natural pen
position (as u3l5.4 does along a line):

- a word whose first glyph follows a pen reset, or starts a new line, or sits
  on a different baseline from its target, gets an absolute `Tm` before it:
  the glyph's own `Tm` with only the translation solved so the glyph lands on
  the target, through the inverse `ctm`. Every glyph after a pen reset gets
  one, so nothing depends on simulating `Td` against a line matrix we moved;
- a word on the right line but at the wrong x, in a chain, gets a `TJ` kern;
- otherwise nothing.

After the paragraph's last show operator in each text object, when a later
operator there positions relative to the line matrix (`Td`, `TD`, `T*`, `'`,
`"`), a `Tm` restoring the ORIGINAL line matrix is inserted, so the next
paragraph does not move.

Annotations (Q6): each `/Link` or text-markup annotation whose quads cover
paragraph glyphs gets quads recomputed from those glyphs' new positions — one
per line they now span — and its `/Rect` set to their union. A glyph is covered
by its quad's centroid, `SearchOptions.region`'s rule.

## Byte identity

Operators the paragraph does not touch are unchanged. With `adjust` other than
`'reflow'` nothing in this design runs. A reflow that changes no break writes
only what u3l5.4 would.

## Testing

- **Oracle:** `page.AddTextBlock(T1, box)` then reflow to `T2` must give the
  same line breaks, and every word's x and baseline within 1e-3, as a fresh
  `AddTextBlock(T2, box)` — left and `align: 'justify'`. The wrapping is shared,
  so what this checks is the op surgery, against output drawn independently.
- **Third-party shapes**, hand-built: a `TJ` per line, a `Tj` per word, lines
  by `'`, lines by `T*`. Assert line texts, positions, and that the paragraph
  below keeps its operators and glyph quads.
- **Convergence:** an edit on line 2 of 5 converging on line 3 — lines 1 and
  4–5 keep their breaks, 4–5 move by exactly n × pitch.
- **Tagged:** a `/P` holding a `/Link`. Every MCID still resolves,
  `ValidatePdfUa` reports nothing new, and the link's quads cover its moved
  words.
- **Each refusal reason**, document byte-identical; the `onUnreflowable`
  fallback.
- **A mutation sweep** before closing; every surviving mutation is either a
  new fixture or a recorded redundant defence.

## Out of scope

Hyphenation; breaking inside a word or a replacement; moving content below the
paragraph; rotated, vertical or skewed text; a paragraph split across a column
or a page; widow/orphan control.
