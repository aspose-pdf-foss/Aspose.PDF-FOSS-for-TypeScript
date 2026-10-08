# cmark-gfm footnote examples

GitHub's `spec.txt` (in `test/fixtures/gfm/`) says nothing about footnotes: the
extension shipped in `cmark-gfm` after the spec document froze. Its only
machine-readable conformance data is `cmark-gfm`'s own test files, vendored
here byte for byte.

## Source

| | |
|---|---|
| File | `extensions.txt` |
| Upstream | `https://raw.githubusercontent.com/github/cmark-gfm/63dd7b72e0b785a967cb2f760e22e4e5e45bcd4b/test/extensions.txt` |
| Commit | `63dd7b72e0b785a967cb2f760e22e4e5e45bcd4b` (last commit touching `test/extensions.txt`) |
| Retrieved | 2026-10-07 |
| SHA-256 | `a2a45e98be9fca95f564f927265a0f63beea6cae5369d1cf4bde44caa51b2a3a` |
| Size | 21274 bytes, LF throughout |
| Declares | `title: Extensions test`, `author: Yuki Izumi`, `version: 0.1`, `date: '2016-08-31'` |
| Licence | CC-BY-SA 4.0 (the file's own header) |

| | |
|---|---|
| File | `regression.txt` |
| Upstream | `https://raw.githubusercontent.com/github/cmark-gfm/a97a478930ff164a2736d5011e2deafede214907/test/regression.txt` |
| Commit | `a97a478930ff164a2736d5011e2deafede214907` (last commit touching `test/regression.txt`) |
| Retrieved | 2026-10-07 |
| SHA-256 | `0920d7e8134d5e4ec3693f3f52d904b42de45e23a66c29f54fe714dc54213fd9` |
| Size | 10806 bytes. LF, except that its first example (line 7) carries `line1\r\r\n` — the doubled CR is the case under test there. `.gitattributes` marks both files `-text` so `eol=lf` cannot rewrite it and change the hash above |
| Licence | CC-BY-SA 4.0 (the file's own header) |

The transcribed grammar (`test/helpers/md-html.ts`'s footnote HTML, and the
parser in `src/mdblock.ts`, `src/mdinline.ts`, `src/mdgfm.ts`) comes from
`cmark-gfm` master `27d942c8b0a62d192f616e5bf3578f4b6a89e180`; every port names
its upstream function in a comment.

## What it covers

Ten examples, selected by a COMPUTED predicate in
`test/gfm-footnotes-spec.test.ts` whose count is asserted (3 + 7), so a case
cannot drop out of the run unnoticed.

`extensions.txt` — every example between `## Footnotes` and `## Interop`:

| Line | Section | Exercises |
|---|---|---|
| 704 | Footnotes | `![^1]` is a bang, numbering by first citation, an undefined `[^nope]` left literal, the spaces after `]:` swallowed, an 8-space continuation as code, a quote + code + paragraph definition, an uncited definition dropped, backrefs inside the last paragraph and on their own line after a code block |
| 764 | When a footnote is used multiple times… | three citations of one definition: `fnref-L-N` ids and three backrefs |
| 784 | Footnote reference labels are href escaped | a label full of `"><script>` |

`regression.txt` — every example whose fence tags include `footnotes`:

| Line | Exercises |
|---|---|
| 169 | a citation in a paragraph and in a table cell |
| 275 | a definition citing another, defined BEFORE it — numbering in tree order |
| 297 | two references side by side, `[^footnote1][^footnote2]`, not link references |
| 319 | labels beginning with `w` and holding `_`, next to the autolinker |
| 344 | `[^_a_]` inside a table row — strikethrough/emphasis interplay |
| 352 | `[^~~is~~1]` undefined — the RAW label comes back literally |
| 360 | footnotes with strikethrough (cmark-gfm's use-after-free regression) |

## What it does NOT cover

- **Every other example in both files is not run.** `extensions.txt`'s tables,
  strikethrough, autolinks, tag filter and task lists are covered by
  `test/fixtures/gfm/`; `regression.txt`'s non-footnote cases test cmark-gfm
  crashes, not grammar this library shares.
- **A footnote reference inside a link's text.** No example puts one there, so
  the HTML for it is untested.
- **`[\^x]`.** cmark-gfm treats a backslash-escaped caret as a reference;
  this implementation reads the raw text after the `[`, requires it to start
  with `^`, and so leaves `[\^x]` literal. A KNOWN
  DIVERGENCE, unexercised by the corpus and recorded rather than chased.
- **Rendering.** The corpus is HTML; what a footnote looks like in a PDF is
  held by hand-built cases in `test/markdown-footnotes.test.ts`.

## Measured

Mutation sweep at the end of `v9j3.3.1`, each mutation applied exactly once
and judged by vitest's exit status against this corpus plus the hand-built
parser, engine and mapping tests.

**Reddened by THIS corpus** (and usually by a hand-built case too): the
trailing blanks in `_scan_footnote_definition` (line 704's
`other-note`); the four-column continuation (line 704's block quote); the
`![^` image refusal (line 704); numbering by definition order instead of by
first citation (lines 704, 275, 319); an unmatched reference dropped instead
of kept literal (lines 704, 344, 352).

**Held by hand-built cases ALONE** — the corpus cannot see these:

- the FIRST definition of a label wins (`test/md-footnote-resolve.test.ts`);
- `[^]` is not a reference (`test/md-footnote-inlines.test.ts`);
- numbering in TREE order, a citation inside an earlier definition counting
  where that definition sits — line 275 has the shape but a citation order
  under which walking definitions afterwards gives the same numbers.

**Not covered by anything:** `test/helpers/md-html.ts` putting backrefs
inside the LAST paragraph only. No vendored definition has two top-level
paragraphs, so backrefs in every paragraph renders the same corpus. It is
test-oracle code, so nothing ships on it, but do not cite the corpus as
pinning it.

**Equivalent:** moving the definition start after the list-item start in
`tryStart`. A line beginning with `[` can open neither a list item nor a
thematic break, so the order cannot be observed.
