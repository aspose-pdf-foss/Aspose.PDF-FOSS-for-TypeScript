# GFM spec suite

## Source

| | |
|---|---|
| File | `spec.txt` |
| Upstream | `https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt` |
| Commit | `499789b49373bfa045d0e7547e5ee63444c77bca` (last commit touching `test/spec.txt`, 2026-07-13) |
| Retrieved | 2026-08-12 |
| SHA-256 | `7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c` |
| Size | 216680 bytes, LF throughout (no CR anywhere in the file) |
| Declares | `title: GitHub Flavored Markdown Spec`, `version: 0.29`, `date: 2019-04-06` |
| Licence | CC-BY-SA 4.0 |

Byte-identical to upstream. Tabs are written as `→` (U+2192) inside example
bodies, exactly as in the CommonMark spec file; the loader substitutes them.

The canonical rendering at `https://github.github.com/gfm/spec.txt` returns a
404 — the document is published as HTML there, and `cmark-gfm`'s own test data
is the machine-readable form.

## What it covers

The 24 examples tagged with an extension name on their opening fence:

| Tag | Section | Examples |
|---|---|---|
| `table` | Tables (extension) | 8 |
| `disabled` | Task list items (extension) | 2 |
| `strikethrough` | Strikethrough (extension) | 2 |
| `autolink` | Autolinks (extension) | 11 |
| `tagfilter` | Disallowed Raw HTML (extension) | 1 |

The tag is the extension's own name in every case but the task lists, which
GitHub tags `disabled` after the `disabled=""` attribute their checkboxes carry.

## What it does NOT cover

**The other 648 examples in this file are not run.** They are a whole CommonMark
**0.29** document, and this library conforms to **0.31.2**; running them would
need an allowlist for the version divergences, and an allowlist means a
shortfall stops being a red build. `test/fixtures/commonmark/spec.json` (the
official 0.31.2 suite, 652 examples, no allowlist) covers that body of the file
instead.

Coverage inside the extension sections is thin, and thinnest where the grammar
is richest:

- **Tables** get 8 examples. Not covered: a table inside a block quote or a list
  item, alignment markers with no dashes (`:-`), a header row whose cells are
  empty, or a table interrupted by a fenced code block.
- **Task lists** get 2. Neither uses an uppercase `[X]`, though the prose
  mandates it; neither has a loose item or a non-paragraph first block.
- **Strikethrough** gets 2, both `~~`. Single-tilde `~x~`, which `cmark-gfm`
  accepts, is not exercised here at all.
- **Autolinks** get 11, all inside plain paragraphs. Not covered: an autolink
  candidate inside link text, inside emphasis, or spanning a soft break; and
  neither the `mailto:` nor the `xmpp:` form, which `cmark-gfm` implements but
  the spec document never mentions.

`test/gfm-ast.test.ts` covers what the HTML rendering collapses, and the
hand-written cases in `test/mdtable.test.ts`, `test/mdgfm-autolink.test.ts` and
`test/mdgfm-tagfilter.test.ts` cover the gaps listed above. Rules that neither
the examples nor the prose settle were transcribed from `cmark-gfm`'s own
`extensions/` sources at the same commit.
