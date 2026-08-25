# CommonMark spec suite — provenance

The official conformance suite for CommonMark, here to validate `parseMarkdown`
against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-11-commonmark-parser-design.md`.

**Source:** <https://spec.commonmark.org/0.31.2/spec.json>, the machine-readable
dump of the CommonMark 0.31.2 specification, published by the CommonMark project
(John MacFarlane et al., CC-BY-SA 4.0). Downloaded verbatim, not regenerated.

| File | Bytes | SHA-256 |
|---|---|---|
| `spec.json` | 140,487 | `d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20` |

### Command

```bash
curl -fsSL https://spec.commonmark.org/0.31.2/spec.json -o test/fixtures/commonmark/spec.json
```

## Shape

A JSON array of 652 objects across 26 sections, each with `markdown` (the input),
`html` (the expected rendering), `example` (1-based index), `section`, and
`start_line`/`end_line` into the specification prose.

The sections, in spec order: Tabs, Backslash escapes, Entity and numeric
character references, Precedence, Thematic breaks, ATX headings, Setext
headings, Indented code blocks, Fenced code blocks, HTML blocks, Link reference
definitions, Paragraphs, Blank lines, Block quotes, List items, Lists, Inlines,
Code spans, Emphasis and strong emphasis, Links, Images, Autolinks, Raw HTML,
Hard line breaks, Soft line breaks, Textual content.

## What it covers

Every construct in CommonMark 0.31.2, including the ones a PDF renderer will
never draw — raw HTML blocks, HTML comments, processing instructions. The suite
is what catches the class a programmatic builder cannot: our parser and our own
expectations agreeing with each other and both disagreeing with CommonMark.

## What it does NOT cover

- **GFM.** No tables, strikethrough, task lists or extended autolinks. That is
  `gl6o.2`, which brings its own fixture.
- **The AST.** The expectations are HTML, so the suite is blind to every
  distinction the rendering collapses — list tightness above all, which drives
  paragraph spacing in Flow. `test/markdown-ast.test.ts` exists for exactly the
  gap this fixture leaves.
- **Robustness.** No case nests deeper than ten or exercises adversarial
  emphasis. `test/markdown-pathological.test.ts` covers that.
- **Rendering.** `test/helpers/md-html.ts` is a test-only oracle whose sole
  purpose is to make this fixture measurable. It is not a supported output
  format and nothing in `src/` imports it.
