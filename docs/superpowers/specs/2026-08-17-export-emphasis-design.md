# Emphasis in the HTML and Markdown exports (c3t7.8)

`DocText` has carried `bold`/`italic` since `8yt9.2` and `script` since
`c3t7.4`/`c3t7.7`, and `docxflow.ts` is the only serializer that reads any of
them. A bold word therefore exports bold to `.docx` and flat to HTML and
Markdown, though both formats can express it. This closes that.

## What ships

Bold, italic **and** script, in one pass over both serializers. Leaving script
out would re-create in miniature the asymmetry the issue exists to remove: a
document would export its superscripts to `.docx` and flatten them everywhere
else.

## Spelling

**HTML: `<b>` and `<i>`, not `<strong>` and `<em>`.** HTML5 defines `<b>` as
stylistically offset *without* conveying importance and `<i>` as an alternate
voice, which is exactly what we have: `CLAUDE.md` records that emphasis here is
DERIVED from the producing font and never declared, because a PDF records a
face and not an emphasis. `<strong>` would assert an importance the document
never stated — a heading set in a bold face is typography, not emphasis. It
also matches the DOCX side, where `w:b`/`w:i` are presentational too.

**Markdown: `*`, `**`, `***` — never `_`.** `_` does not work intraword and PDF
text runs split mid-word constantly.

**Markdown script: raw `<sub>`/`<sup>`.** CommonMark has no syntax for it, and
the alternative is dropping the information. Emitting raw HTML follows the
precedent `Table.toMarkdown` already sets with `<br>` for a cell newline, under
the recorded rule that what GFM cannot express is *reported, never dropped*.
The cost is recorded rather than hidden: the output stops being pure CommonMark,
and these reparse as `html_inline` rather than text, so the round-trip test
compares rendered output rather than node kinds.

**Nesting: script outermost.** `<sup>**x**</sup>`, not `**<sup>x</sup>**`, so
the Markdown delimiters stay adjacent to the text the flanking rules are about.
HTML nests the same way for consistency, though nothing there requires it.

## Two rules that belong to neither serializer

`docmodel.ts` gains one exported helper, which the builder itself never calls:

```ts
/** A container's children, prepared for an inline serializer. */
export function styledChildren(node: DocContainer): DocNode[];
```

One function so the two serializers cannot drift on either rule.

### Merge adjacent text siblings sharing (bold, italic, script)

Required for correctness, not tidiness. `struct.ts` splits a run per MCID and
per style, so adjacent same-style siblings are the normal case rather than an
edge one — and emitting two of them separately gives Markdown `**a****b**`, a
four-asterisk delimiter run that does not reparse as two strong spans.

### Suppress uniform bold inside H1–H6

Only bold, only in a heading, and only when *every* text run in the heading's
subtree carries it. That is the heading's baseline typography, not an inline
distinction, and both output formats already render headings bold themselves.

The scope is deliberately narrow in three directions:

- **Headings only.** A paragraph set entirely in bold IS a distinction the
  document is making, and neither format renders paragraphs bold by default, so
  suppressing it there would simply lose information.
- **Bold only.** Neither format supplies italic to a heading, so a uniformly
  italic heading keeps its italic.
- **Uniform only.** One bold word among plain ones is a real inline
  distinction and survives.

Without this rule `# Title` round-trips through our own renderer as
`# **Title**`, because `mdstyle.ts` defaults headings to `Helvetica-Bold`.

### Why these cannot move into the builder

`test/docx-flow-identity.test.ts` pins the **sha256** of DOCX flow output, and
`docxflow.ts` emits one `w:r` per `DocText`. Merging runs in `buildDocModel`
would change that count and move the hash. The rules are serializer-local by
necessity, not by preference.

## Markdown emission

`mdescape.ts` gains the emitter, keeping Markdown text-level spelling in the
module that already owns it:

```ts
export function emphasizeMarkdown(
  escaped: string,
  style: { bold?: boolean; italic?: boolean; script?: 'sub' | 'super' },
): string;
```

It takes text that is **already escaped**, and never escapes its own
delimiters. Escaping does the hard part for us: `escapeMarkdown` already
escapes `*` and `_` in body text, so an emitted delimiter can never collide
with a literal asterisk the document contained.

Three rules:

1. **Hoist leading and trailing whitespace outside the delimiters**, with the
   same `/^(\s*)([\s\S]*?)(\s*)$/` move `inlineText`'s Link case already makes.
   A closing `**` preceded by whitespace is not a closer, so `** bold **`
   silently fails to emphasize — it renders the asterisks literally.
2. An **all-whitespace core** is returned unchanged. There is nothing to
   emphasize, and wrapping it produces literal asterisks by rule 1's logic.
3. No style is returned unchanged, so the untouched path stays byte-identical.

**Invariant:** correctness is defined against our own parser, exactly as the
module already requires of its escapers —
`parseMarkdown(emphasizeMarkdown(escape(s), style))` must yield back `s`
carrying that emphasis. A hand-written list of delimiter hazards makes both
under- and over-emission invisible.

## HTML emission

`<b>` / `<i>` / `<sub>` / `<sup>` in `htmlsemantic.ts`, script outermost, bold
outside italic. No whitespace hoisting: HTML has no flanking rules, and
`<b> a </b>` is well formed.

## Out of scope

**Table cells stay flat.** `Table.toHtml()` and `Table.toMarkdown()` take their
text from the `Table` model, which carries no emphasis at all. That is a gap in
the table model, not in these serializers, and it needs its own issue.

Nothing about `docxflow.ts`, which already reads all three fields.

## Testing

New `test/export-emphasis.test.ts`:

- Both formats emit for bold, italic, bold+italic, sub and super.
- **Adjacency**: two adjacent bold runs emit `**ab**`, asserted *not* to be
  `**a****b**`. This is the case that makes the merge load-bearing rather than
  cosmetic, so it is asserted on the exact string.
- **Whitespace hoisting**: a bold run drawn with surrounding spaces emits
  `` **bold** `` with the spaces outside, and reparses as emphasis.
- **Heading suppression**, both directions: a uniformly bold heading emits no
  emphasis, and a heading with one bold word among plain ones keeps it. The
  second is what stops the rule from being "headings never emphasize".
- **Round trip through our own parser**: `parseMarkdown` of the emitted string
  yields the emphasis back.
- `via('**bold** and *italic*')` through the authoring stack, which today loses
  both.

### The fences

`test/html-identity.test.ts`'s snapshot and `test/markdown-export.test.ts`'s
expectations are fences, not goldens. Measured before starting: no fixture in
the html-identity set uses a bold, italic or oblique face, and no `via()` case
in markdown-export uses a heading — so **neither is expected to move**. If
either does, the diff gets read line by line and brought to the user before
being accepted; it is not refreshed silently.

`test/docx-flow-identity.test.ts` must stay green untouched. It is the evidence
that the two new rules did not leak into the model.

## Documentation

`CLAUDE.md`'s `docmodel.ts` entry currently states the opposite of what will be
true — that `DocText.bold`/`.italic`/`.script` are "read by `docxflow.ts`
alone", and that this is what keeps the HTML and Markdown output still. That
invariant is deliberately retired for all three fields and replaced with the
rules above, including the note that `docx-flow-identity` is now the fence that
matters.

`README.md`'s two statements that HTML and Markdown "export it flat, because
those two serializers read no character styling at all" become false and are
rewritten.
