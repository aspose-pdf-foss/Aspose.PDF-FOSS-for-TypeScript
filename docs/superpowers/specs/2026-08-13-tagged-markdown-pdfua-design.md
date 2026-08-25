# Tagged Markdown rendering for PDF/UA conformance

Design for `aspose-pdf-foss-for-ts-gl6o.4`, the last child of the `gl6o` epic
(Markdown to PDF authoring). It follows `gl6o.3` (Render Markdown into Flow and
directly onto a page), whose three children shipped the renderer, and subsumes
`xsmk` (emit `/Code` and `/BlockQuote` structure types).

## Problem

The issue was filed with no description, before the renderer existed. Its scope
has to be established by measurement rather than assumed — so it was. Rendering
a source exercising every construct into a tagged flow and running
`doc.ValidatePdfUa()` reports, today:

| Rule | Severity | Count |
|---|---|---|
| `NaturalLanguage` | error | 17 |
| `DocumentTitle` | error | 1 |
| `DisplayDocTitle` | error | 1 |
| `UntaggedContent` | warning | 1 |

Per construct, under a tagged flow:

| Construct | Structure emitted | Untagged |
|---|---|---|
| heading | `H1` | — |
| paragraph | `P` | — |
| bullet / ordered / task list | `L LI Lbl LBody` | — |
| link | `P Link` | — |
| table | `Table TR TH TD` | — |
| thematic break | (artifact — correct) | — |
| block quote | `P` — **no `/BlockQuote`** | — |
| **code block** | **nothing at all** | **1** |

Three findings, and they are not what the issue title suggests:

**1. A code block emits no structure element and is not artifacted.**
`CodeBlockElement.place` calls `flowTextBlock(ctx.doc, ctx.page, this.text, rect,
this.opts)` and `this.opts` never carries a `tag` — unlike `TextElement` in
flow.ts, which appends its `/P` or `/Hn` before drawing. The text is painted
into a tagged page as neither tagged nor artifacted content. This is a defect,
not a missing feature.

**2. A block quote's contents tag as bare `/P`.** `quote()` lowers to a flat
array of `QuotedElement` decorators, each passing `ctx.structParent` straight
through, so quoted paragraphs are siblings of unquoted ones and the quotation is
invisible to assistive technology. `/BlockQuote` is a grouping element
(32000-1 §14.8.4.1) and nothing creates one.

**3. The document-level errors are not library gaps.** Setting `doc.Lang` and
`doc.SetMetadata({ title })` clears all 17 `NaturalLanguage` errors and
`DocumentTitle`, leaving only `DisplayDocTitle` — a catalog flag
`ConvertToPdfUa` already sets. Everything needed exists; what is missing is that
a caller must know to make three separate calls, none of which the Markdown API
mentions. A library that gets a caller 95% of the way to conformance and leaves
the last 5% undocumented has not delivered conformance.

## Scope

In scope:

- Fix the code-block tagging defect.
- Emit `/Code` and `/BlockQuote` (this subsumes `xsmk`; close it as part of this
  work).
- A `lang` option on `FlowOptions`, written to the flow's own `/Sect`.
- A `title` option on `Document.AddMarkdown`, writing `/Info`, XMP `dc:title`
  and `/ViewerPreferences /DisplayDocTitle`.
- A `Document.DisplayDocTitle` accessor, with `pdfuaconvert.ts`'s inline pass
  rewritten over it.

Out of scope, each for a stated reason:

- **Per-element `/Lang` for mixed-language content.** Markdown has no syntax for
  marking language, so there is no source to drive it. A caller who needs it can
  set `el.Lang` on a `structParent` they own.
- **Widening the validator.** `structvalidate.ts` enforces no block-level /
  inline-level nesting rule, which is why the `/Code` decision below cannot lean
  on it. Adding one is a validator change affecting every producer, not a
  Markdown change.
- **Heading-level sequencing.** `HeadingNesting` already passes for Markdown,
  whose heading levels come from the source.
- **`ConvertToPdfUa` changes** beyond the `DisplayDocTitle` consolidation.

## Architecture

Two independent halves: structure fixes in the flow layer, options in the
Markdown and flow entry points.

```
── structure ────────────────────────────────────────────────────
flowblock.ts   CodeBlockElement   creates /P > /Code, tags its text
               QuotedElement      substitutes a shared /BlockQuote

── options ──────────────────────────────────────────────────────
flow.ts        FlowOptions.lang   -> /Lang on the flow's /Sect
document.ts    AddMarkdown title  -> /Info + XMP + DisplayDocTitle
               DisplayDocTitle    NEW accessor, beside Document.Lang
pdfuaconvert.ts                   its inline pass rewritten over it
```

### The code block

`CodeBlockElement` gains the shape `TextElement` already has — create on first
draw, remember, hand the same element to the continuation:

```ts
place(ctx: PlaceContext): PlaceResult {
  if (this.code === undefined && ctx.structParent !== undefined && this.text !== '') {
    // /P is block level; /Code is inline level (32000-1 14.8.4.3) and owns the
    // marked content. A bare /Code here would put an ILSE where a BLSE belongs.
    this.code = ctx.structParent.Append('P').Append('Code');
  }
  const opts = this.code ? { ...this.opts, tag: this.code } : this.opts;
  …
}
```

Lazily, so a code block that draws nothing leaves no orphan element — the rule
`TextElement` and `TableTagger` both already follow. The remainder carries the
same `/Code`, so a code block split across a column is one element rather than
one per fragment.

`/P` wrapping `/Code` is deliberate and cannot be justified by our own report:
`structvalidate.ts` has no BLSE/ILSE nesting rule, so a bare `/Code` would pass
it while being misplaced per the spec. The codebase already records that a
passing report is necessary but not sufficient; an issue whose whole purpose is
conformance must not lean on a gap in its own checker.

### The block quote

`quote()` builds N `QuotedElement`s that must share ONE `/BlockQuote`. A shared
mutable holder, created in `quote()` and passed to every sibling:

```ts
interface QuoteStruct { elem?: StructElement }

// in QuotedElement.place, before delegating:
if (this.st.elem === undefined && ctx.structParent !== undefined)
  this.st.elem = ctx.structParent.Append('BlockQuote');
const inner = { ...ctx, structParent: this.st.elem ?? ctx.structParent,
                x: ctx.x + this.indent, width: ctx.width - this.indent };
```

**Invariant:** the holder is per-QUOTE state, not per-element. Whichever sibling
draws first creates the element and every other sibling finds it; give each its
own and a three-paragraph quote becomes three `/BlockQuote`s. This is the
pattern `gl6o.3.2` established for a list item's marker, for the same reason. A
split quote carries the holder into its continuation, so a quote broken across a
column stays one `/BlockQuote` — the rule `gl6o.3.3` applied to `TableTagger`.

Nesting falls out: an inner quote's elements receive the outer `/BlockQuote` as
`ctx.structParent` and append their own beneath it.

### `lang`

`FlowOptions.lang?: string`, written to the `/Sect` the flow creates. It reaches
`Document.AddMarkdown` unchanged, since that already takes
`MarkdownFlowOptions & FlowOptions`.

It is validated in the `Flow` **constructor**, beside `tagged`, not in
`normalizeFlowOptions` — that function returns `Geometry`, which carries page
and column measurements only and does not see `tagged` either. The cross-check
belongs where both values are in hand:

```ts
// Flow constructor, after this.tagged is resolved
if (options?.lang !== undefined) {
  if (typeof options.lang !== 'string' || options.lang === '')
    throw new TypeError('lang must be a non-empty string');
  if (!this.tagged)
    throw new TypeError('lang requires tagged: true — an untagged flow has no /Sect to carry it');
}
this.lang = options?.lang;
```

The `/Sect` is created eagerly at the top of `Render()`
(`this.tagged ? this.doc.CreateStructTree().Append('Sect') : undefined`), so
applying the language is one line there:

```ts
if (structParent !== undefined && this.lang !== undefined) structParent.Lang = this.lang;
```

`EffectiveLang` walks ancestors before falling back to `doc.Lang`, so a `/Sect`
`/Lang` satisfies `NaturalLanguage` for exactly the content the flow added and
nothing else. That is why it goes there rather than on the catalog: a flow
appended to an existing document must not relabel that document's language, and
two flows in different languages must not fight over one slot.

**`lang` without `tagged: true` throws a `TypeError`.** There is no `/Sect` in
untagged output, so the option would do nothing; someone passing `lang` is
unambiguously asking for accessible output, and silently discarding it is the
failure mode this issue exists to close. `MarkOptions` already rejects
`artifact` combined with `tag` or `alt` on the same reasoning.

`Page.AddMarkdown` deliberately gets no `lang`. It takes a `structParent` the
caller owns, and `el.Lang = 'en-US'` is the one-liner; an option that mutated
the caller's own element would be the surprising side effect rejected for the
catalog.

### `title`

`Document.AddMarkdown` only — the one entry point that authors a whole document
rather than appending to one. `Flow.AddMarkdown` and `Page.AddMarkdown` append
to a document whose title is someone else's business.

It calls `SetMetadata({ title })`, which already mirrors to XMP `dc:title`, and
sets `DisplayDocTitle`. The two go together because a title with
`DisplayDocTitle` false still fails PDF/UA, so setting one without the other
buys nothing for the stated purpose.

Not coupled to `tagged`: a document title is good practice regardless.

### `Document.DisplayDocTitle`

A boolean accessor beside the existing `Document.Lang`, creating
`/ViewerPreferences` when absent. `pdfuaconvert.ts`'s `displayDocTitlePass` is
rewritten over it, so the flag has one writer rather than two. Its
already-true early return is preserved, since that pass reports whether it
changed anything.

## Invariants

To be recorded in `CLAUDE.md`:

- **A tagged flow element tags its own ink or artifacts it — there is no third
  option.** A code block did neither for two issues, and no test noticed:
  `UntaggedContent` is a per-page warning that names no element, and the only
  Markdown fixture reaching the validator did not contain a code block.
- **A quote's `/BlockQuote` is per-quote state shared by its siblings**, and it
  survives a split. Per-element state yields one element per paragraph; dropping
  it on a split yields one per column.
- **`/Code` is inline level and `/BlockQuote` is grouping level** (32000-1
  §14.8.4.3 and §14.8.4.1). A code block is therefore `/P` > `/Code`, and our
  own validator cannot tell the difference.
- **`lang` writes the flow's `/Sect`, never the catalog.** Composability, and no
  side effect on a document the flow did not create.

## Error handling

- `lang` must be a non-empty string, and requires `tagged: true`; both throw
  `TypeError` from `NewFlow`/`AddMarkdown` before anything is allocated.
- `title` must be a non-empty string; `TypeError` otherwise.
- Nothing here throws on document content — the Markdown stack's existing rule.
- Untagged output is unchanged in every respect, including byte-for-byte: every
  new element is created only when `ctx.structParent` is present.

## Testing

- **The per-construct sweep becomes a test.** Render each construct
  (heading, paragraph, bullet/ordered/task list, quote, code block, thematic
  break, table, link) into a tagged flow; assert its structure types AND that
  `UntaggedContent` is empty. That table is what turned a vague issue into three
  concrete defects, and it is what will catch the next one. Asserting only the
  types would have missed this defect entirely, since a missing element and an
  artifacted one look identical in a type list.
- **The code-block defect, directly:** a tagged flow containing a code block
  reports no `UntaggedContent` and emits `/P` > `/Code`; the untagged case emits
  neither and is byte-identical.
- **A code block split across a column is one `/Code`;** a three-paragraph quote
  is one `/BlockQuote`; a quote split across a column is one `/BlockQuote`; a
  nested quote is a `/BlockQuote` inside a `/BlockQuote`. Each is the failure a
  shared holder exists to prevent, and each is asserted by walking the tree —
  never by serializing it, which throws on a cyclic tree.
- **End to end:** `doc.AddMarkdown(everySource, { tagged: true, gfm: true, lang,
  title })` yields `ValidatePdfUa().Passed === true`. This is false today for
  four distinct reasons and is the single assertion that states the issue's
  goal.
- **Rejections:** `lang` without `tagged`, empty `lang`, empty `title`.
- **`page.AddMarkdown`** under a caller-supplied `structParent` carrying `Lang`
  reports no `NaturalLanguage` errors — the documented substitute for the option
  it does not have.
- **`DisplayDocTitle`** round-trips through the new accessor, and
  `test/pdfuaconvert.test.ts` stays green across the rewrite.

## Public surface

```ts
// flow.ts
interface FlowOptions {
  …
  /** Natural language of this flow's content (e.g. 'en-US'), written to the
   *  /Sect it creates. Requires `tagged: true`. */
  lang?: string;
}

// document.ts
Document.AddMarkdown(src, options?: MarkdownFlowOptions & FlowOptions & {
  /** Document title: /Info /Title, XMP dc:title, and DisplayDocTitle. */
  title?: string;
}): { pages: Page[]; skipped: string[] }

/** Catalog /ViewerPreferences /DisplayDocTitle — whether a viewer shows the
 *  document title rather than the file name. Required true by PDF/UA. */
Document.DisplayDocTitle: boolean
```

No new modules, and no new exports from `index.ts`: `FlowOptions` and `Document`
are already exported.

`README.md` gains the `lang`/`title` options in the Markdown section and a
worked PDF/UA example; the Limitations entry on Markdown rendering drops
nothing, since no limitation is removed — the tagging gaps were defects rather
than documented limits.
