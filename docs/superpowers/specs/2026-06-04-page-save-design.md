# Page.Save & splitPdf Delegation — Design

**Issue:** aspose-pdf-foss-for-ts-z53
**Date:** 2026-06-04
**Status:** Approved

## Goal

Add a `Save` method to the `Page` class that serializes a single page to a
self-contained single-page PDF (`Uint8Array`), and refactor `splitPdf` to
produce each output by calling the corresponding `Page.Save`.

## Scope

In scope:
- `Page.Save(options?: PageSaveOptions): Uint8Array`.
- `splitPdf` delegates to `doc.Pages[i].Save(options)`.
- `SplitOptions` becomes a type alias of `PageSaveOptions` (one source of truth).
- Make the extractor's `Document` import type-only to avoid a runtime import
  cycle introduced by `page.ts` importing the extractor.

Out of scope:
- Any change to the extraction or serialization logic itself (byte-identical
  output preserved).
- Saving multiple pages from one `Page`, or whole-document save (that already
  exists as `Document.save()` for metadata).

## API

In `src/page.ts`:

```ts
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writeSinglePagePdf } from './writer.js';

export interface PageSaveOptions {
  /** Pruning policy applied while extracting the page's object graph. */
  prunePolicy?: PrunePolicy;
}

// method on Page:
Save(options: PageSaveOptions = {}): Uint8Array {
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  const { objects, pageNum } = extractPage(this.doc, this.Dict, policy);
  return writeSinglePagePdf(objects, pageNum);
}
```

This is exactly the per-page body currently in `splitPdf`, relocated onto
`Page`. `page.ts` already holds the owning `doc` and the materialized `Dict`.

## splitPdf delegation

`src/split.ts` collapses to:

```ts
import { Document } from './document.js';
import type { PageSaveOptions } from './page.js';

export type SplitOptions = PageSaveOptions;

/** Split a PDF into one self-contained single-page PDF per page, in page order. */
export function splitPdf(input: Uint8Array, options: SplitOptions = {}): Uint8Array[] {
  return Document.open(input).Pages.map((page) => page.Save(options));
}
```

`split.ts` no longer imports the extractor or writer. `SplitOptions` is now an
alias of `PageSaveOptions`, so the two stay in sync; it is still exported from
the index unchanged (`export type { SplitOptions } from './split.js'`). The
`import type { PageSaveOptions }` is erased at runtime, so it adds no runtime
import edge.

## Import-cycle fix

Relocating extract+write into `page.ts` would create a runtime cycle:

```
page.ts -> extractor.ts -> document.ts -> pagetree.ts -> page.ts
```

The extractor uses `Document` only as a type (function parameter
annotations), so change `src/extractor.ts` line 1 from:

```ts
import { Document } from './document.js';
```

to:

```ts
import type { Document } from './document.js';
```

This erases the `extractor -> document` runtime edge. After the change, the
runtime dependency chain is `document -> pagetree -> page -> {extractor, writer,
flate}`, and none of those import `document` at runtime (`page.ts` and
`extractor.ts` reference `Document` type-only). No cycle remains.
`writer.ts` imports only `types` and `serialize`, so it is already cycle-free.

## Behavior & error handling

No behavior change. `splitPdf` runs the same `extractPage -> writeSinglePagePdf`
path with the same default policy, so its output is byte-identical to today's.
Errors propagate unchanged. `Save` is callable on any `Page` in `doc.Pages`.

## Exports

Add to `src/index.ts`:

```ts
export type { PageSaveOptions } from './page.js';
```

`Page` and `SplitOptions` are already exported.

## Testing (TDD, Vitest)

Add to `test/page.test.ts`:
- **Round-trip:** open `buildClassicPdf(2)`, call `doc.Pages[1].Save()`, reparse
  the bytes with `Document.open`, assert the result has exactly one page and
  its `Contents` decode to text containing `"Page 2"`.
- **Custom policy honored:** call `Save({ prunePolicy })` with a policy whose
  `dropPageKeys` additionally drops a key present on the page object (e.g.
  `Type`), then reparse and assert the emitted page object lacks that key —
  proving the options object reaches `extractPage`.

Regression guard:
- The existing `test/split.test.ts` round-trip and content-preservation tests
  must still pass unchanged, confirming the delegation is behavior-preserving.
