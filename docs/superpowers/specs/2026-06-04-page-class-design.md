# Page Class & Document.Pages — Design

**Issue:** aspose-pdf-foss-for-ts-3gq
**Date:** 2026-06-04
**Status:** Approved

## Goal

Add a `Page` class representing a single PDF page, and give `Document` a
populated `Pages` property (an array of `Page`, one per page in document order).
`Document.open` returns a document whose `Pages` property is already
populated.

The public surface follows Aspose.PDF naming (PascalCase) to match the library
the project is modeled on.

## Scope

In scope:
- A `Page` class with an Aspose-style PascalCase surface.
- `Document.Pages: readonly Page[]`, populated eagerly in `open()`.
- Unifying the existing page-tree machinery: `Page` replaces the `PageRef`
  interface; the splitter/extractor and tests consume `Page` instead.

Out of scope (possible follow-ups):
- Page mutation (adding/removing/reordering pages, editing content).
- Text extraction / content-stream tokenizing (beyond returning raw decoded
  content bytes).
- Annotation editing or typed annotation models.

## Module layout

- **New `src/page.ts`** — the `Page` class.
- **Refactor `src/pagetree.ts`** — keep the tree walk and inherited-attribute
  materialization, but rename `listPages` → `buildPages(doc): Page[]` returning
  `Page` objects. Remove the `PageRef` interface.
- **`src/document.ts`** — `open()` builds and assigns the `Pages` property.

### Import-cycle note

`document.ts` imports `buildPages` from `pagetree.ts` (runtime, used at
`open()` time). `pagetree.ts` imports the `Page` class from `page.ts` (runtime).
`page.ts` imports `Document` **type-only** (`import type`) and only calls
`doc.resolve(...)` at method-invocation time. Type-only import creates no
runtime cycle, so initialization is safe.

## The `Page` class

Constructed internally (not part of the public constructor contract) from the
owning document, the materialized page dict, and the 1-based page number:

```ts
import type { Document } from './document.js';
import { PdfDict } from './types.js';

export class Page {
  constructor(
    private readonly doc: Document,
    /** Materialized page dict: own entries with inheritable attrs folded in. */
    readonly Dict: PdfDict,
    /** 1-based position in document order. */
    readonly Number: number,
  ) {}

  get MediaBox(): number[];     // 4 numbers; defaults to [0,0,612,792] if absent
  get CropBox(): number[];      // 4 numbers; defaults to MediaBox if absent
  get Rect(): number[];         // effective visible rectangle = CropBox
  get Rotate(): number;         // normalized to 0/90/180/270; default 0
  get Resources(): PdfDict | undefined;  // resolved /Resources dict
  get Contents(): Uint8Array;   // concatenated, decoded content-stream bytes
  get Annotations(): PdfDict[]; // resolved /Annots dicts; [] when none
}
```

### Member semantics

- **`Number`** — 1-based page number, assigned at construction in document order.
- **`Dict`** — the materialized page dict produced by the page-tree walk (own
  entries plus inherited `Resources`/`MediaBox`/`CropBox`/`Rotate`). Raw access
  used by internal consumers (the extractor). Set at construction.
- **`MediaBox`** — reads `Dict`'s `/MediaBox`; resolves each element to a number.
  Returns a 4-element `number[]`. If `/MediaBox` is absent (should not happen
  after materialization, but be lenient), defaults to `[0, 0, 612, 792]`.
- **`CropBox`** — reads `/CropBox` the same way; if absent, returns `MediaBox`.
- **`Rect`** — returns `CropBox` (the effective visible rectangle).
- **`Rotate`** — reads `/Rotate` as a number, normalizes via `((r % 360) + 360)
  % 360`; non-numeric or absent → `0`.
- **`Resources`** — `doc.resolve(Dict.get('Resources'))`; returns it when a dict,
  otherwise `undefined`.
- **`Contents`** — resolve `/Contents`. It may be a single stream (ref) or an
  array of stream refs. Resolve each to a `PdfStream`, decode each via the
  existing `inflateStream` (handles unfiltered and FlateDecode; throws
  `UnsupportedFeatureError` for other filters), and concatenate the decoded
  byte runs with a single `\n` (0x0A) separator between streams, per the PDF
  spec's treatment of a content-stream array as one stream. Returns an empty
  `Uint8Array` when `/Contents` is absent. Non-stream entries are skipped.
- **`Annotations`** — `doc.resolve(Dict.get('Annots'))`; if an array, resolve
  each element and keep those that are dicts; returns `PdfDict[]` (`[]` when
  absent or not an array). `/Annots` is not inheritable, so it is read from the
  page dict directly.

The typed accessors are lazy getters (computed on access), so eager `Pages`
population pays only for the page-tree walk, not content decoding.

## Eager population in `open()`

`Document` gains a public `readonly Pages: Page[]`. `open()` constructs the
document, then calls `buildPages(doc)` and assigns the result before returning:

```ts
static open(buf: Uint8Array): Document {
  const { entries, trailer } = readXref(buf);
  if (trailer.get('Encrypt') !== undefined)
    throw new UnsupportedFeatureError('encrypted PDFs are not supported');
  const doc = new Document(buf, entries, trailer);
  doc.setPages(buildPages(doc));
  return doc;
}
```

`Pages` is declared with definite-assignment (`Pages!: Page[]`) and assigned via
a private `setPages` (or equivalent internal assignment), keeping it readonly to
external callers. A malformed page tree throws `PdfParseError` at `open()` time
(slightly earlier than today; acceptable).

## Unify the splitter/extractor onto `Page`

- `src/split.ts`: use `doc.Pages` directly (drop the `listPages` import); pass
  `page.Dict` to `extractPage`:

  ```ts
  const doc = Document.open(input);
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  return doc.Pages.map((page) => {
    const { objects, pageNum } = extractPage(doc, page.Dict, policy);
    return writeSinglePagePdf(objects, pageNum);
  });
  ```

- Tests referencing `listPages(doc)[i].dict` move to `doc.Pages[i].Dict`:
  - `test/pagetree.test.ts`
  - `test/writer.test.ts`
  - `test/extractor.test.ts`
  - `test/split.test.ts` (uses count only → `doc.Pages.length`)

No behavior change to splitting — the same materialized dicts flow through
`extractPage`.

## Testing (TDD, Vitest)

Use the existing `buildClassicPdf(pageCount, opts)` helper (uncompressed content
streams). Extend it with two optional fixture features needed here:
- `opts.flateContents?: boolean` — emit each page's content stream
  FlateDecode-compressed (to exercise `Contents` inflation).
- `opts.firstPageAnnots?: number` — attach N simple annotation dicts to page 1's
  `/Annots` (to exercise `Annotations`).

Cases:
- `open()` populates `Pages` with `pageCount` entries; `Number` is `1..N`.
- `MediaBox` returns the inherited `[0, 0, 200, 200]`; `CropBox` and `Rect` fall
  back to it.
- `Rotate` defaults to `0`.
- `Resources` is a dict that contains `/Font`.
- `Contents` (uncompressed fixture) decodes to bytes containing `"Page 1"`.
- `Contents` (FlateDecode fixture) decodes to the same expected text.
- `Annotations` is `[]` by default; with `firstPageAnnots`, page 1 returns that
  many annotation dicts and other pages return `[]`.
- Splitter and round-trip tests still pass after the unify refactor.

## Exports

Add to `src/index.ts`:

```ts
export { Page } from './page.js';
```

`Document` is already exported; `Pages` is reached through it.
