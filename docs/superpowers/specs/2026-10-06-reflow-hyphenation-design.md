# Reflow hyphenation — design (6y39)

## Goal

`ReplaceText({ adjust: 'reflow' })` and `RestyleText({ adjust: 'reflow' })`
re-wrap a paragraph but never break inside a word: a word that no longer fits
moves whole to the next line. This adds opt-in hyphenation to that reflow,
reusing the v9j3.2 engine, so a reflowed paragraph hyphenates exactly as
`AddTextBlock({ hyphenate })` would.

**Note on the issue title.** .NET's `ReplaceAdjustment.WholeWordsHyphenation`
is believed (unverified) to move whole words only, which `'reflow'` already
does. This work goes beyond parity: real in-word hyphenation.

## Decisions

| Question | Decision |
|---|---|
| Scope | Real hyphenation (Liang patterns or soft hyphens), not parity-only |
| Existing line-end hyphens | A soft hyphen (U+00AD) is rejoined; a drawn `-` never is (final review: patterns cannot tell a break from a compound's hyphen) |
| Words holding an edit | Hyphenate too — a replacement may split across lines |
| Language | Option, then the paragraph element's `EffectiveLang`, then catalog `/Lang`; none → silent whole-word reflow |
| Wrap approach | Proxy text through `layoutRuns` — the one wrapping engine |
| Drawn hyphen extraction | Plain `-`, no `/ActualText` — as `AddTextBlock` does |

## 1. Options surface

- `hyphenate?: HyphenationOptions | false` on `ReplaceTextOptions` and
  `RestyleTextOptions` (the v9j3.2 public type: `lang`, `mode`, `minLeft`,
  `minRight`, `minWord`). Absent or `false`: off, and no new code runs — output
  is byte-identical.
- Valid only with `adjust: 'reflow'`; stated with any other `adjust` it throws
  `RangeError` before any page is read (the accepted-and-ignored trap `region`
  records).
- Validated up front through `resolveHyphenation`; a rejected call leaves the
  document byte-identical. Unlike `AddTextBlock`, a missing `lang` in `'auto'`
  is not an error — the language may come from the document.
- Language per paragraph, first tag that selects a bundled table wins:
  1. `hyphenate.lang`;
  2. the tagged paragraph key's block element `EffectiveLang` (ancestors
     walked); skipped on an untagged page or a glyph with no MCID;
  3. catalog `/Lang`.
  None selects a table → that paragraph reflows whole-word, silently.
  `'manual'` mode needs no language (soft hyphens only).
- `doc.ReplaceText` / `doc.RestyleText` pass it through; still all-or-nothing.

## 2. The wrap (`reflowwrap.ts`)

Off: today's atomic path, untouched. On:

- **Units.** A word is a list of drawn units: an original glyph (kern lead +
  advance), a ligature glyph (one unit, several characters), or one CHARACTER
  of an edit's runs (residue and fallback runs included). Edit characters need
  per-character advances summing exactly to `runsAdvance`:
  `runUnits(runs, anchor)` in `replaceadjust.ts`, the same arithmetic.
- **One run per unit.** Each unit is its own `LayoutRun` whose text is one
  private-use proxy code point (no UAX #14 opportunity, so a word breaks only at
  hyphenation points). Its driver measures the proxy at the unit's width and
  `'-'` as the hyphen that unit would end with. `layoutRuns` draws a hyphen in
  the run of the character before the break, so `segment.run → unit` is a
  direct lookup, and a segment text ending `'-'` means a hyphen follows that
  unit. Gap runs unchanged.
- **Hyphenator adapter.** v9j3.2's `hyphenator(resolved)` over the word's real
  text (units' characters concatenated); keep only points on a unit boundary
  (a point inside a ligature is dropped) and map them to proxy offsets.
- **Hyphen face.** The unit's own font when `drawCode('-')` qualifies (tier A);
  else u3l5.2's tiers — registered same face with `matchRegisteredFonts`, then
  `fallbackFonts`. No face → driver `probe('-')` is 0 and `layoutRuns` skips the
  point. Chosen at plan time; encoded at apply time.
- **Rejoin.** A line-final word ending in a drawn `-` (or U+00AD), followed on
  the next line by a word starting with a lowercase letter, where the patterns
  allow a break at that point in the joined text without the hyphen (or, in
  `'manual'` mode, the hyphen is a real U+00AD), becomes ONE word. The hyphen
  glyph is not a proxy: it is the preceding unit's "own hyphen", measured at
  the original glyph's width. Broken there → the original glyph stays, no
  insert; not broken → the glyph is suppressed.
- **Result.** `WrapResult` gains `hyphens` (after which unit, which face, which
  target) and `suppressed` (original hyphen glyphs to remove). Convergence and
  lines-before-the-edit are unchanged; a line starting mid-word is never a
  convergence point (conservative, still correct).

## 3. The writer (`writeReflow`, `showPieces`)

- An original word split across lines needs nothing new: per-glyph targets,
  and a glyph whose y differs from the pen gets a `Tm`.
- A hyphen after original glyph `g`: a new `ShowInsert` piece
  `{ kind: 'hyphen', face }` at the byte offset just after `g` in its show
  string (element end when last). Tier A → plain bytes; a fallback face →
  the existing `foreign` piece (`Tf` switch and restore, encoded at apply
  time). The pen advances by the hyphen's width.
- A hyphen inside a replacement: `StrEdit.breaks?: { at, face, tm }[]`, `at` a
  character offset. `showPieces` emits head runs, hyphen, the `tm` op piece,
  tail runs. An original-font run is cut at a character boundary from
  per-character codes chosen at plan time; a foreign run splits its text and
  encodes both halves at apply time. `tm` is `tmFor` solved from the anchor
  for the tail's target.
- Suppressing a rejoined hyphen: a synthetic `StrEdit` with `runs: []` over
  its bytes — `advanceOf` 0, skipped by `writeReflow`, an emptied `Tj`
  removed by the existing rule. Not counted as a replacement.
- A drawn hyphen extracts as `-` (as `AddTextBlock`); the rejoin rule is what
  keeps a second reflow over our own output clean. Recorded in README.
- Forms drawn twice, `placed`, and the trailing restore of a dirty `Tm` are
  unchanged.

## 4. Annotations, decorations, edge rules

- `moveAnnotQuads` already emits one quad per target line; the head quad
  extends over the drawn hyphen (its face's width), as v9j3.2 decorations span
  a segment's `-`. A rejoined word's quads merge; a suppressed hyphen adds no
  width.
- `RestyleText`: a split decorated match paints one decoration per line piece,
  head including the hyphen; a split replacement contributes head and tail as
  two pieces. u3l5.12's form-drawings rule unchanged.
- Refusal reasons unchanged; `no-room` fires less often, by design.
- Over-wide word with no fitting point: drawn whole and overflows (today's
  behaviour). With points: breaks across as many lines as needed.
- Vertical, rotated and `scopes` refused before any hyphenation work.

## 5. Testing

- **Oracle:** `AddTextBlock({ hyphenate })` of the post-edit text in the
  measured box (replacement spaces as U+00A0, u3l5.5's rule) — breaks and head
  choices must match. Patterns already anchored by v9j3.2's `hyphen@1.14.1`
  goldens.
- **Fences:** hash of reflow output recorded before the change, byte-identical
  with `hyphenate` absent; also identical with it on when nothing needs a break.
  Existing reflow/adjust/restyle suites unedited.
- **Cases, each mutation-checked:** option validation and the `'reflow'`
  requirement; language precedence and silent no-table; original word split
  with tier-A hyphen; fallback-face hyphen; point skipped when no face draws
  `-`; ligature point dropped; replacement split (original-font run and
  fallback run); rejoin kept-broken and suppressed, with guards (uppercase next
  word, non-pattern point such as `well-`/`known`, manual only for U+00AD);
  second reflow over our own output clean; link quads and restyle decorations
  per piece with hyphen; form drawn twice; `doc.ReplaceText` all-or-nothing.
- **Fixture traps:** a ligature case needs a pattern point INSIDE the
  ligature; a rejoin case needs a word the patterns break at that offset; a
  replacement-split case needs the replacement itself to be the overflowing
  word. Mutation harness must confirm every test file loaded.
- **Docs in the same commits:** README Text replace + Scope and Limitations,
  CHANGELOG **Added**, CLAUDE.md invariants (`reflowwrap.ts`, `textedit.ts`,
  `runUnits` in `replaceadjust.ts`).
