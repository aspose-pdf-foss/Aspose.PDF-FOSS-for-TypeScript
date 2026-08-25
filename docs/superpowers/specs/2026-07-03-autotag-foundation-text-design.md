# Accessibility Auto-tagging: Foundation + Text Structure

**Issues:** aspose-pdf-foss-for-ts-pwi.1 (content-marking primitive) + pwi.2
(AutoTag text structure), under the pwi umbrella. pwi.3 (tables) is a follow-up.
**Date:** 2026-07-03

## Context

`doc.ConvertToPdfUa` deliberately never fabricates structure — alt text,
reading order, and tagging of untagged content surface as `unresolved`. This
feature adds `doc.AutoTag()`, which *does* infer a `/StructTreeRoot` from layout,
composing three shipped subsystems:

- **`page.GetStructuredText(): TextBlock[]`** — paragraph-like blocks → lines →
  positioned `TextFragment`s (each with `quad`, `fontSize`), in reading order.
- **tagged-authoring** — `doc.CreateStructTree()` (marks the doc Tagged),
  `root.Append(type, opts?)`, and `allocContentMcid` (wires `/ParentTree` + `/K`).
- **content provenance** — `visitContent` emits `GlyphEvent`/`ImageEvent` carrying
  `addr {path, streamIndex, opIndex}` and the active `mcid`; `mcidGlyphs`
  correlates MCID → glyphs. `EditableContent` exposes and rewrites a page's
  top-level content op lists (the mechanism redaction uses).

The missing piece is a way to wrap *existing* content in `/<Type> <</MCID n>> BDC
… EMC`, so a re-walk correlates those glyphs to the element. That is pwi.1;
pwi.2 is the heuristic layer over it.

## Scope

- **pwi.1** — `StructElement.MarkContent(page, region): number`: mark existing
  page content under a structure element.
- **pwi.2** — `doc.AutoTag(opts?): AutoTagReport`: headings (font-size
  clustering), paragraphs, and figures/artifacts (images), tagged via pwi.1.

Non-goals (pwi.3 / documented limitations): tables and lists; content nested
inside Form XObjects; blocks whose ops span multiple top-level content streams;
fabricated alt text (undescribed images become `/Artifact`).

## pwi.1 — Content-marking primitive

### `StructElement.MarkContent(page: Page, region: Rect): number`
Allocate an MCID under this element and wrap the page's top-level show/`Do` ops
whose content falls in `region` in `/<Type> <</MCID n>> BDC … EMC` (`<Type>` =
this element's `/S`). Returns the MCID.

Implementation (`markContentRegion` in `src/structwrite.ts`):
1. `visitContent` the page; collect, per **top-level** stream (`addr.path.length
   === 0`), the op indices whose `GlyphEvent`/`ImageEvent` `quad` intersects the
   normalized `region`.
2. Choose the stream with the most region ops (v1 marks one contiguous span in
   one stream; region content in other top streams or in XObjects is left
   untagged — limitation). If no ops fall in `region`, return `-1` without
   allocating (no-op).
3. `const mcid = allocContentMcid(doc, element, page)`.
4. `wrapRegionOps(ec, streamIndex, min, max, before, after)` — rebuild the
   stream's op list inserting `before` (`/<Type> <</MCID mcid>> BDC`) at `min`
   and `after` (`EMC`) after `max`; `ec.commit()`.
5. Return `mcid`.

`wrapRegionOps` is a shared helper (exported from `src/structwrite.ts`) taking a
leading and trailing `ContentOp`, reused by the artifact path in pwi.2.

`ContentOp` for `BDC`: `{ operator: 'BDC', operands: [name(type), new Map([['MCID', mcid]])] }`
→ serializes as `/<type> <</MCID n>> BDC` (verified: `serializeContentStream`
routes operands through `serializeValue`, which handles names and dicts). `EMC`
is `{ operator: 'EMC', operands: [] }`.

Each `MarkContent` call uses a fresh `visitContent` + `EditableContent`, so
op-index shifts from earlier marks on the same page are re-derived consistently.
MCIDs are allocated per call in call order (`allocContentMcid` returns
`arr.length`); the number written into the `BDC` matches the `/ParentTree` slot,
so stream order need not match allocation order.

## pwi.2 — `doc.AutoTag(opts?)`

```ts
interface AutoTagOptions {
  force?: boolean;                                 // re-tag even if IsTagged (default false → throw)
  lang?: string;                                   // set doc.Lang
  title?: string;                                  // set /Info title
  alt?: (image: ImageEvent) => string | undefined; // Figure /Alt; undefined → /Artifact
}
interface AutoTagReport { headings: number; paragraphs: number; figures: number; artifacts: number; }
```

`doc.AutoTag(opts?)` (`src/autotag.ts`, new):
1. If `doc.IsTagged` and not `opts.force`, throw `UnsupportedFeatureError`
   ("document is already tagged; pass { force: true } to re-tag").
2. `const root = doc.CreateStructTree()` (marks Tagged). Set `doc.Lang` / title
   from opts when given.
3. **Heading sizes** — walk every page's fragments; accumulate total characters
   per rounded `fontSize` (0.5 pt buckets). The bucket with the most characters
   is `bodySize`. Distinct sizes `> bodySize + 0.5` sorted descending map to
   `H1, H2, …`, capped at `H6` (extras collapse to `H6`).
4. **Per page, in reading order** (`GetStructuredText()` order):
   - For each block: `blockSize` = the size bucket with the most characters among
     the block's fragments. If `blockSize` is a heading size **and** the block has
     ≤ 2 lines → append `H<rank>`; else append `P`. `element.MarkContent(page,
     block.quad)`; count.
   - For each top-level `ImageEvent`: `alt = opts.alt?.(image)`. With alt →
     `root.Append('Figure', { alt })` + `MarkContent(page, image.quad)` (figures++).
     Without alt → wrap `image.quad` ops in `/Artifact BMC … EMC` via
     `wrapRegionOps` (no element, no MCID) (artifacts++).
5. Return the `AutoTagReport`.

`Page` gets no new method; `AutoTag` is document-level. (`MarkContent` is the
per-element method from pwi.1.)

## Errors

- `MarkContent` on an element with no `/Ref` throws (via `allocContentMcid`).
- `AutoTag` on an already-tagged doc without `force` throws
  `UnsupportedFeatureError`.

## Testing

### pwi.1 (`test/struct-mark-content.test.ts`)
- Build an untagged single-stream page with two text lines at different y.
  `CreateStructTree`; `root.Append('P')`; `p.MarkContent(page, line1Rect)`.
  Save + reopen: `GetStructTree()` finds the `P`, and `p.GetText()` returns
  line 1's text (MCID correlation round-trips); the other line is not under it.
- `MarkContent` over an empty region returns `-1` and tags nothing.
- The written content contains `/P <</MCID 0>> BDC` and `EMC` (raw-bytes check).

### pwi.2 (`test/autotag.test.ts`)
- A fixture with a large-font title line and two body paragraphs:
  `doc.AutoTag()` returns `{ headings: 1, paragraphs: 2, ... }`; `doc.IsTagged`
  is true; `GetStructTree()` root has an `H1` then two `P`s; each element's
  `GetText()` returns its text.
- Image fixture: with `alt: () => 'a logo'` the image is a `Figure` with
  `/Alt`; with no `alt` it becomes an `/Artifact` (not in the tree) — assert via
  `GetStructTree` child types and raw `/Artifact BMC`.
- Already-tagged doc throws without `force`, succeeds with `{ force: true }`.
- `opts.lang` sets `doc.Lang`; `opts.title` sets the metadata title.
- `ValidatePdfUa()` on an auto-tagged simple doc has fewer errors than before
  (at minimum: tagging-present and marked-content rules pass).

## README

- Features: new "Accessibility auto-tagging" bullet — `doc.AutoTag(opts?)` infers
  a `/StructTreeRoot` (headings by font-size clustering, paragraphs, figures/
  artifacts) via `MarkContent`; heuristic; tables/lists are follow-ups.
- API table: `doc.AutoTag(opts?)`, `element.MarkContent(page, region)`.
- Limitations: AutoTag is heuristic — reading order follows `GetStructuredText`;
  headings are font-size based; undescribed images are marked `/Artifact` (no
  fabricated alt); tables/lists, XObject-nested and multi-stream-spanning content
  are not tagged. A passing structure is a starting point, not guaranteed
  semantic correctness.
