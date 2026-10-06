# Opt-in hyphenation (v9j3.2) — design

## Purpose

Let the authoring layer break a word across lines with a drawn hyphen, so
narrow columns and justified text stop leaving ragged gaps. Opt-in: with the
option absent every existing caller's output is byte-identical. The engine is
built so `6y39` (reflow hyphenation) and a later HTML `hyphens` mapping can
reuse it; neither is in this issue.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Entry points | Authoring API only: `AddTextBlock`, Flow paragraphs / lists / table cells, Markdown. Not HTML, not reflow, not `AddText`. |
| Languages | en-US, en-GB, de (1996), fr, es, it, nl, pt, pl. Russian left out: LPPL only. |
| Modes | `auto` (patterns + soft hyphens) and `manual` (soft hyphens only), mirroring CSS `hyphens`. |
| Soft hyphen U+00AD | Honoured as a break point and invisible except at a break — **only when hyphenation is on**. Off keeps today's behaviour (WinAnsi draws 0xAD as a visible hyphen) so the byte-identity fence holds. |
| Engine | Liang pattern matching over a per-language `Map`, not a packed trie. |

## Data

**Source:** `hyphenation/tex-hyphen`, pinned at commit
`5684c0f51c0b81133db2efbe60a408b4155a3ff5` (2026-02-24), files under
`hyph-utf8/tex/generic/hyph-utf8/patterns/`:

| Tag | Pattern file | Licence (from the file's own header) | Size of `.pat.txt` |
|---|---|---|---|
| en-US | hyph-en-us | all-permissive notice (G. Kuiken) | 31 KB |
| en-GB | hyph-en-gb | MIT | 55 KB |
| de | hyph-de-1996 | MIT | 272 KB |
| fr | hyph-fr | MIT | 10 KB |
| es | hyph-es | MIT/X11 | 40 KB |
| it | hyph-it | LPPL or MIT — taken under MIT | 2 KB |
| nl | hyph-nl | MIT | 83 KB |
| pt | hyph-pt | BSD-3-Clause | 2 KB |
| pl | hyph-pl | MIT or LPPL — taken under MIT | 30 KB |

**Generator:** `scripts/gen-hyphenation.mjs` (`npm run gen:hyph`), not run by
`npm test`, like the other `gen:*` scripts. It fetches `txt/hyph-<l>.pat.txt`,
`txt/hyph-<l>.hyp.txt` (absent for some languages) and `tex/hyph-<l>.tex`
(for `hyphenmins` and the licence), and writes `src/hyphdata.ts`:

```ts
export interface HyphLanguage {
  tag: string;            // 'en-US'
  left: number;           // hyphenmins left from the .tex header
  right: number;          // hyphenmins right
  licence: string;        // the copyright line and licence name, verbatim
  data: string;           // base64 of deflate('patterns\n---\nexceptions')
}
export const HYPH_LANGUAGES: readonly HyphLanguage[];
```

Each language's copyright and licence text ship in `hyphdata.ts`, which all
four licences require. `test/fixtures/hyphenation/PROVENANCE.md` records the
pin, the nine source paths and their SHA-256, and the decision to leave
Russian out.

## Engine — `src/hyphenate.ts`

A pure leaf importing `hyphdata.js`, `langmatch.js` and `node:zlib`. Never
throws after validation.

```ts
export interface Hyphenator {
  /** Break positions in `word` (code-unit offsets, 0 < p < word.length) where
   *  a hyphen may go, already filtered by minLeft / minRight / minWord. */
  points(word: string): readonly number[];
}
export function hyphenator(opts: ResolvedHyphenationOptions): Hyphenator;
export function hyphenationLanguages(): string[];
```

- **Lazy:** a language's blob is inflated and parsed into a `Map<string,
  number[]>` the first time it is asked for, and kept.
- **Tag matching:** RFC 4647 through `langmatch.ts` against the nine tags —
  `en` → en-US, `en-GB` → en-GB, `de-AT` → de, `pt-BR` → pt. Probed with
  `hasOwnProperty`, never `in` (the `predefcmap.ts` trap).
- **Words:** only the maximal run of letters (`\p{L}` plus combining marks) is
  hyphenated; leading and trailing punctuation is kept out of the match and
  the offsets are mapped back. Matching is on the lower-cased letters.
- **Liang:** standard — `.word.`, every substring up to the longest pattern
  looked up, odd values allow a break. Exceptions from `.hyp.txt` are looked
  up first and win outright.
- **Soft hyphens:** a U+00AD in the word is always a point (in `manual`, the
  only kind); patterns run over the word with the soft hyphens removed.
- **Memo:** points per word, per hyphenator, so a word re-tried on every page
  of a long paragraph is analysed once.

## Wrapping engine — `src/layout.ts`

`layoutRuns` gains one optional trailing parameter
`hyphenation?: Hyphenator`. When it is `undefined` **no new code runs**; the
identity fences (`rich-runs-identity`, `html-identity`, `markdown-flow`,
`docx-flow-identity`) must pass unedited.

When it is set:

1. **A word that does not fit the current non-empty line:** take its points;
   choose the **rightmost** point whose prefix plus a hyphen fits the room left.
   The prefix becomes a `Unit` with `hyphen: true`, the line is kept, and the
   rest of the word becomes a new unit with no space before it, which goes
   through the same test on the next line. No point fits → today's behaviour.
2. **An over-wide word** (wider than the box) is split at hyphenation points
   first, each piece drawing a hyphen; whatever no point can split falls back
   to today's UAX #14 split with nothing drawn.
3. **The hyphen** is U+002D, drawn under the `Tf` of the run owning the last
   character before the break and counted in the line's width and its `text`.
   A point whose run's driver cannot draw `-` (`probe('-') === 0`) is skipped.
4. **Soft hyphens** are excluded from every measure and every drawn piece —
   zero width, no glyph — but stay in the raw text, so the remainder carries
   them to the next page.
5. **Remainder and justification** need no new code: the remainder is already
   the raw tail from the first unkept line's start, which may now fall
   mid-word; a hyphenated line is a soft wrap and justifies normally.

`Unit` gains `hyphen?: boolean`; `piecesOf` appends `'-'` to the piece of the
run owning the unit's last character when it is set.

## Public API and plumbing

```ts
export interface HyphenationOptions {
  lang?: string;                  // required for 'auto'
  mode?: 'auto' | 'manual';       // default 'auto'
  minLeft?: number;               // default: the language's hyphenmins left
  minRight?: number;              // default: the language's hyphenmins right
  minWord?: number;               // default 5
}
```

- `TextBlockOptions.hyphenate?: HyphenationOptions` (`AddTextBlock`).
- `FlowParagraphOptions.hyphenate?: HyphenationOptions | false`; list items and
  table cells take it the way they take the paragraph's other options.
- `FlowOptions.hyphenate?: HyphenationOptions` — a flow-wide default; an
  element's own value wins and `false` turns it off. `lang` defaults to
  `FlowOptions.lang` when that is set.
- `MarkdownFlowOptions.hyphenate?: HyphenationOptions`.
- `AddHeading` does not hyphenate unless its own options ask.
- `flowTextBlock` and `measureTextBlock` resolve it once through `resolveRuns`,
  which they already share, so a paragraph cannot measure one way and paint
  another.
- **Auto-fit column widths are unchanged:** a cell's min-content stays its
  longest word.
- Exports: `HyphenationOptions`, `hyphenationLanguages`. Each gets a README API
  Reference row (`test/readme-api.test.ts`).

## Validation and errors

Validated before any page is touched:

- `TypeError` — not an object, `lang` not a string, a minimum not an integer.
- `RangeError` — `mode` outside `auto`/`manual`; a minimum below 1; `auto` with
  no `lang`, or a `lang` no bundled table matches. `manual` accepts any `lang`
  or none.

Layout never throws on account of hyphenation.

## Extracted text and tagging

A drawn hyphen is page content: `GetText` reads `hyphen-\nation`, as for any
PDF another producer hyphenated. In a tagged flow it sits inside the
paragraph's marked content. Marking it as an artifact, or giving the word an
`/ActualText`, is out of scope and is recorded in README's limitations.

## Testing

- **Engine against data it did not compute:** every `.hyp.txt` exception word
  comes back exactly as listed (en-US, en-GB, nl, pt, pl ship one), and Liang's
  own published examples for the en-US patterns (e.g. `hy-phen-ation`) are
  asserted as printed in his thesis. Further reference words come from an
  outside hyphenator only if one is available when the plan is written; if
  none is, the test file says so — exceptions plus Liang's examples are then
  the whole external anchor, and the rest is hand-checked. Tag matching,
  `minLeft`/`minRight`/`minWord`, punctuation, case, soft hyphens in both modes.
- **Layout:** off is byte-identical; a hyphenated line draws `-` and fits; the
  rightmost fitting point wins; limits respected; an over-wide word hyphenates
  before falling back; soft hyphens draw nothing mid-line, draw `-` at a break
  and survive into the remainder; a driver without `-` skips the point; measure
  equals paint; the drawn text with line-end hyphens removed equals the input.
- **Plumbing:** each entry point reaches the engine; the flow default and the
  per-element override and `false`; `lang` falls back to `FlowOptions.lang`.
- **Mutation pass** over every rule above before closing.

## Out of scope

HTML `hyphens` (follow-up issue), reflow hyphenation (`6y39`), `AddText`,
artifact-marked hyphens, languages beyond the nine, a packed trie.
