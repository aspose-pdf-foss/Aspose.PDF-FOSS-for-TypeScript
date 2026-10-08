# Markdown footnotes (v9j3.3.1) — design

## Purpose

`parseMarkdown(src, { gfm: true })` learns GitHub's footnotes — `[^label]`
references and `[^label]: …` definitions, which may hold several blocks — and
the three `AddMarkdown` entry points render them through the Flow footnote
engine shipped in `v9j3.3`. With `gfm` off nothing changes.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Placement | Footnotes at the column foot by default; `MarkdownFlowOptions.footnotePlacement: 'end'` makes them endnotes (GitHub's rendering). Renamed from `footnotes` in the plan: `doc.AddMarkdown` takes `MarkdownFlowOptions & FlowOptions`, and `FlowOptions.footnotes` is already the note-style object. |
| A definition cited several times | Same mark at every citation, the note once — a small engine addition (a repeated citation). |
| `page.AddMarkdown` (one rect) | Notes are numbered and placed after the content inside the same rect; overflow is part of the returned remainder. A small engine helper. |
| Oracle | cmark-gfm's own test data (`extensions.txt`, `regression.txt`), vendored at pinned commits; the test-only HTML oracle is extended to emit cmark-gfm's footnote HTML. |
| AST shape | Resolved at parse time: `MdDocument.footnotes` in first-reference order, references carry `index` and `occurrence`. |

## Parser and AST (`gfm: true` only)

```ts
// mdast.ts
export interface MdFootnoteReference {
  type: 'footnote_reference';
  label: string;       // as written, without `^`
  index: number;       // 1-based, order of first reference
  occurrence: number;  // 1 for the first citation of this definition, 2, 3…
}
export interface MdFootnoteDefinition {
  type: 'footnote_definition';
  label: string;       // as written at the definition
  index: number;
  children: MdBlock[];
}
export interface MdDocument {
  type: 'document'; children: MdBlock[];
  /** Cited definitions in `index` order; absent when nothing was cited. */
  footnotes?: MdFootnoteDefinition[];
}
```

`MdFootnoteReference` joins `MdInline`; `MdFootnoteDefinition` joins `MdBlock`
and is a container (its children are blocks). It never appears in
`MdDocument.children`.

- **Block phase (`mdblock.ts`).** A line opening with `[^label]:` starts a
  footnote definition container; its continuation is cmark-gfm's — content
  indented four or more columns belongs to it, so a definition may hold
  paragraphs, quotes, lists and code. Definitions are collected into a map
  keyed by the case-folded label (`caseFold`, the link-label rule); the first
  definition of a label wins.
- **Inline phase (`mdinline.ts`).** `[^label]` with a definition becomes a
  `footnote_reference`; without one it stays literal text. References inside
  a definition body resolve too.
- **Numbering in the AST.** `index` follows first reference in cmark-gfm's
  traversal order — which decides where a citation INSIDE a definition falls
  is transcribed from its source in the plan, not assumed here, and pinned by
  a hand-built case; `occurrence` counts citations per definition. Uncited
  definitions are dropped.
- **Grammar the prose does not settle** — label characters, a `^` inside
  brackets, a reference meeting a link opener, the definition's continuation
  and lazy lines — is transcribed from `cmark-gfm` (`src/blocks.c`,
  `src/inlines.c`, `extensions/` footnote code) at a pinned commit, each port
  naming its upstream function in a comment, as `mdgfm.ts` does.
- **Fences.** `test/commonmark-spec.test.ts` with no options is unchanged. Its
  `{ gfm: true }` run's divergence list must not grow without a stated reason
  per new entry.

## Engine additions (`flownotes.ts`)

**1. A repeated citation.** A `FlowNote` cited by several runs:

- the first citation in queue order (reading order) is numbered and places the
  note; every later one gets the same mark, an empty body and
  `ref.repeatOf = first`;
- an empty body reserves no foot room and commits nothing, so `settleBudget`
  and `NoteColumn` are unchanged;
- `Render` skips repeats when collecting endnotes and when tagging — one
  `/Note` per note;
- `lowerNotes` no longer refuses one `FlowNote` twice in a run list, and
  `NoteNumberer` no longer refuses it twice per flow.

This reverses `v9j3.3`'s "cited once per flow" rule; its CHANGELOG entry is
amended.

**2. Notes in a single rect.**

```ts
export function notesAsTrailing(
  elements: FlowElement[], foot: ResolvedNoteOptions, end: ResolvedNoteOptions,
  makeBody: BodyMaker,
): FlowElement[];
```

It numbers every reference in `elements` (footnotes and endnotes in their own
sequences), DETACHES each by deleting the symbol key from its mark run (the
runs are the lowering's own objects), and returns `[...elements, separator,
...bodies]` with footnotes before endnotes. `placeElements` then sees no
reference. Numbering is per call.

## Mapping (`mdruns.ts`, `mdflow.ts`)

- One `FlowNote` per cited definition, built once per document from a label
  map; repeated citations share it. Content is the definition's blocks through
  the same `blockElements` a top-level block uses.
- Note body size: `MarkdownStyle.footnoteSize`, default 8 (the engine's
  default), with code and heading sizes scaled by `footnoteSize / bodySize`.
- `footnote_reference` → an empty run carrying `footnote` (or `endnote` under
  `MarkdownFlowOptions.footnotePlacement: 'end'`), inheriting the run state, so a mark
  in bold text is bold.
- A citation that cannot be honoured is drawn as its literal `[^label]` and
  reported in `skipped` (`footnote (table cell)`, `footnote (nested)`):
  inside a table cell (until `v9j3.3.3`) and inside a footnote definition
  (notes do not nest).
- `doc.AddMarkdown` and `flow.AddMarkdown` render through the engine;
  `doc.AddMarkdown` forwards `footnotePlacement: 'end'`. `page.AddMarkdown` calls
  `notesAsTrailing` before `placeElements`.
- `footnotePlacement` other than `'foot'`/`'end'` and a non-positive `footnoteSize` are
  `TypeError`s, validated before anything is built.

## Oracle

- Vendor `test/fixtures/gfm-footnotes/extensions.txt` (cmark-gfm
  `63dd7b72e0b785a967cb2f760e22e4e5e45bcd4b`) and `regression.txt`
  (`a97a478930ff164a2736d5011e2deafede214907`), CC-BY-SA 4.0, with
  `PROVENANCE.md` recording SHA-256s, which examples run and what they do not
  cover.
- The runner selects examples by a computed predicate: every example in
  `extensions.txt`'s `## Footnotes` section, and every `regression.txt`
  example whose fence tags include `footnotes` — 10 at the pinned commits.
  Each is parsed with `{ gfm: true }` and rendered through
  `test/helpers/md-html.ts`.
- `md-html.ts` gains cmark-gfm's footnote HTML: a reference is
  `<sup class="footnote-ref"><a href="#fn-L" id="fnref-L[-N]" data-footnote-ref>I</a></sup>`
  and the document ends with `<section class="footnotes" data-footnotes><ol>`
  of `<li id="fn-L">` items whose last paragraph carries one backref per
  citation (`data-footnote-backref-idx`, `aria-label="Back to reference I[-N]"`),
  the label href-escaped. The exact spelling is the vendored expectation's.

## Testing

- The 10 vendored examples, plus the existing GFM and CommonMark suites
  unchanged.
- Parser units: definition continuation (indented, lazy, blank lines), first
  definition wins, case-folded matching, an undefined reference is literal,
  uncited definitions dropped, numbering across text and definitions,
  `occurrence`.
- Engine units: a repeated citation draws the mark twice and the note once,
  reserves nothing, makes one `/Note`; `notesAsTrailing` numbers, detaches and
  appends.
- Mapping end to end: marks and note bodies through `doc.AddMarkdown`, the
  `'end'` option, `footnoteSize`, bold inheritance, a list and code inside a
  note, `page.AddMarkdown` trailing notes and remainder, table-cell and nested
  citations literal and reported, tagged output, `gfm` off identical.
- Mutation-check each grammar rule against the corpus; PROVENANCE records the
  rules only hand-built tests hold.
