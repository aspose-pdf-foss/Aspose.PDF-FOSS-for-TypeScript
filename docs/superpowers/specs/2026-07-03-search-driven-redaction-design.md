# Search-driven Redaction: `RedactText`

**Issue:** aspose-pdf-foss-for-ts-vcc
**Date:** 2026-07-03

## Context

Redaction today is rectangle-driven: `page.Redact(rects, opts)` / `doc.Redact(page, rects, opts)`
(`src/redact.ts`) truly remove text and images under caller-supplied page-space
rectangles, prune orphaned resources, and paint an opaque marker box — but the
caller must supply the rectangles. Separately, `page.Search(find)` /
`searchText` (`src/textedit.ts`) locate a literal string or `RegExp` over the
same word/line assembly as `GetText`, returning `TextMatch[]` where each match
carries `quads: Rect[]` (one page-space box per line the match spans).

`RedactText` closes the gap by driving `Redact` from a text search, so callers
can redact by content instead of by geometry.

## Scope

Add `page.RedactText(find, opts?)` and `doc.RedactText(find, opts?)` that search
the page(s) for `find` and redact every matched region, returning the number of
occurrences redacted. No new option types — reuse `RedactOptions`
(`color`, `scrubMetadata`).

Non-goals: padding/expanding the matched quads, partial-image handling, OCR of
rasterized text, and rotated-page device-space correction (all shared with the
existing `Search`/`Redact` limitations).

## Behavior

`redactText(doc, page, find, opts)` (new, `src/redact.ts`):

1. `const matches = searchText(doc, page, find)`.
2. If `matches` is empty, return `0` — a no-op: no content rewrite and no
   metadata scrub (scrubbing is tied to an actual redaction happening).
3. Flatten every match's `quads` into one `Rect[]` (`matches.flatMap(m => m.quads)`).
4. One `redactPage(doc, page, rects, opts)` call — a single pass removes the
   covered glyphs, prunes orphaned resources, and paints the markers, honoring
   `opts.color` and `opts.scrubMetadata`.
5. Return `matches.length` (occurrence count, mirroring `ReplaceText`).

`page.RedactText(find, opts?)` → `redactText(this.doc, this, find, opts ?? {})`.

`doc.RedactText(find, opts?)` → sum `page.RedactText(find, opts)` over
`this.Pages`, returning the total occurrences (mirroring `doc.ReplaceText`).

## API

```ts
// Page
RedactText(find: string | RegExp, opts?: RedactOptions): number

// Document
RedactText(find: string | RegExp, opts?: RedactOptions): number
```

`RedactOptions` (existing): `{ color?: [r,g,b] 0..1 (default black); scrubMetadata?: boolean }`.

## Errors

Inherits `redactPage`/`checkRect` validation (a malformed rect throws
`TypeError`, a partially-covered image throws `UnsupportedFeatureError`). A
non-string / non-RegExp `find` yields no matches via `searchText` (returns `[]`
→ no-op), matching `Search`.

## Testing (`test/redact.test.ts` or a new `test/redact-text.test.ts`)

Using the existing redaction/search fixtures (programmatic page builders):

- **Literal redaction**: `RedactText('secret')` on a page containing the word
  returns the occurrence count, removes the glyphs (`GetText()` / `Search` no
  longer finds it), and paints a marker (content grows a fill op over the quad).
- **RegExp across multiple occurrences**: a pattern matching several spots
  returns the right count and each region is cleared.
- **Multi-line match**: a match spanning two lines redacts both line quads.
- **Options honored**: `color` sets the marker fill; `scrubMetadata: true` clears
  `/Info` + XMP (assert via `GetMetadata`).
- **No match → 0, untouched**: `RedactText('absent')` returns `0`, leaves text and
  metadata intact.
- **Document level**: `doc.RedactText` sums across pages and redacts each.

## README

- Features "Redaction" bullet: mention `RedactText(find | RegExp)` as the
  search-driven entry point layered over `Search` + `Redact`.
- API-overview table: rows for `page.RedactText(find, opts?)` and
  `doc.RedactText(find, opts?)`.
- Limitations "Redaction is rectangle-driven" bullet: note that `RedactText`
  now derives regions from a text search (still rectangle-based underneath, so a
  neighboring glyph overlapping a match's union quad may be removed too; device
  space assumes unrotated pages).
