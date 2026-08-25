# Search-driven Redaction (`RedactText`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `page.RedactText(find, opts?)` and `doc.RedactText(find, opts?)` that redact by content — search the page(s) for a literal/RegExp and remove every matched region via the existing `Redact` pipeline — returning the occurrence count.

**Architecture:** A new `redactText(doc, page, find, opts)` in `src/redact.ts` runs `searchText` (`src/textedit.ts`), flattens every `TextMatch.quads` into one `Rect[]`, and makes a single `redactPage` call. `Page.RedactText` and `Document.RedactText` are thin wrappers (doc sums over pages), mirroring the existing `Redact` / `ReplaceText` methods.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. ESM + NodeNext (`.js` specifiers).
- Reuse `RedactOptions` (`color`, `scrubMetadata`) — no new option types.
- Return value is the occurrence count (number of `TextMatch`), mirroring `ReplaceText`.
- No matches ⇒ no-op: no content rewrite, no metadata scrub, return `0`.
- Errors inherit from `redactPage`/`checkRect` (`TypeError` for a malformed rect, `UnsupportedFeatureError` for a partially-covered image).
- Run `npm run typecheck` and `npm test` green before closing.
- Keep `README.md` in sync.

---

### Task 1: `redactText` + `Page.RedactText` + `Document.RedactText`

**Files:**
- Modify: `src/redact.ts` (add `redactText`; it imports `searchText`)
- Modify: `src/page.ts` (import `redactText`; add `RedactText` method next to `Redact`)
- Modify: `src/document.ts` (add `RedactText` method next to `Redact`/`ReplaceText`)
- Test: `test/redact-text.test.ts` (create)

**Interfaces:**
- Consumes: `searchText(doc, page, find): TextMatch[]` (`src/textedit.js`), `redactPage(doc, page, rects, opts)` (`src/redact.js`), `RedactOptions` (`src/redact.js`), `Rect` (`src/text.js`).
- Produces:
  - `export function redactText(doc: Document, page: Page, find: string | RegExp, opts?: RedactOptions): number`
  - `Page.RedactText(find: string | RegExp, opts?: RedactOptions): number`
  - `Document.RedactText(find: string | RegExp, opts?: RedactOptions): number`

- [ ] **Step 1: Write the failing test**

Create `test/redact-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** Full latin1 text of the page's /Contents (fixtures are single-stream here). */
function contentText(doc: Document, pageIndex = 0): string {
  return new TextDecoder('latin1').decode(doc.Pages[pageIndex].Contents);
}

describe('page.RedactText', () => {
  it('redacts a literal match: removes the glyphs and paints a marker', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    const n = doc.Pages[0].RedactText('Secret');
    expect(n).toBe(1);

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('Secret'); // glyphs gone
    expect(re.Pages[0].Search('Secret')).toHaveLength(0);
    expect(contentText(re)).toContain('rg');               // a marker fill was painted
  });

  it('redacts every RegExp occurrence and returns the count', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 10 Tf 50 150 Td (id 111 here) Tj ET',
      'BT /F1 10 Tf 50 100 Td (id 222 here) Tj ET',
    ]));
    const n = doc.Pages[0].RedactText(/\d{3}/);
    expect(n).toBe(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('111');
    expect(re.Pages[0].GetText()).not.toContain('222');
  });

  it('honors marker color and scrubMetadata', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (classified) Tj ET']));
    doc.SetMetadata({ Author: 'Alice' });
    const n = doc.Pages[0].RedactText('classified', { color: [1, 0, 0], scrubMetadata: true });
    expect(n).toBe(1);

    const re = Document.Open(doc.Save());
    expect(contentText(re)).toContain('1 0 0 rg');         // red marker
    expect(re.GetMetadata().Author).toBeUndefined();       // metadata scrubbed
  });

  it('no match is a no-op: returns 0 and leaves text + metadata intact', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (visible) Tj ET']));
    doc.SetMetadata({ Author: 'Bob' });
    const n = doc.Pages[0].RedactText('absent', { scrubMetadata: true });
    expect(n).toBe(0);

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).toContain('visible');    // untouched
    expect(re.GetMetadata().Author).toBe('Bob');           // not scrubbed on a no-op
  });
});

describe('doc.RedactText', () => {
  it('redacts across all pages and returns the total occurrences', () => {
    const src = buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (secret) Tj ET']);
    const doc = Document.Open(src);
    doc.AddPage(Document.Open(src).Pages[0]); // a second page with the same word
    expect(doc.Pages).toHaveLength(2);

    const total = doc.RedactText('secret');
    expect(total).toBe(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('secret');
    expect(re.Pages[1].GetText()).not.toContain('secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/redact-text.test.ts`
Expected: FAIL — `RedactText` is not a function on `Page`/`Document`.

- [ ] **Step 3: Add `redactText` to `src/redact.ts`**

At the top of `src/redact.ts`, add the `searchText` import beside the existing imports:

```ts
import { searchText } from './textedit.js';
```

Append at the end of `src/redact.ts`:

```ts
/** Redact every occurrence of `find` (a literal string or RegExp) on `page`:
 *  search the page's assembled text, then remove and mark every matched region
 *  in a single {@link redactPage} pass (honoring `opts.color` /
 *  `opts.scrubMetadata`). Returns the number of occurrences redacted; a run with
 *  no matches is a no-op that returns 0 (no content rewrite, no metadata scrub). */
export function redactText(
  doc: Document, page: Page, find: string | RegExp, opts: RedactOptions = {},
): number {
  const matches = searchText(doc, page, find);
  if (matches.length === 0) return 0;
  const rects: Rect[] = matches.flatMap((m) => m.quads);
  redactPage(doc, page, rects, opts);
  return matches.length;
}
```

- [ ] **Step 4: Wire up `Page.RedactText`**

In `src/page.ts`, extend the `./redact.js` import to include `redactText`:

```ts
import { redactPage, redactText, RedactOptions } from './redact.js';
```

(If the existing import is `import { redactPage, RedactOptions } from './redact.js';`, replace it with the line above.)

Add the method to the `Page` class immediately after `Redact`:

```ts
  /** Redact by content: find every occurrence of `find` (a literal string or
   *  RegExp) via the same search as `Search`, then remove and mark each matched
   *  region through the `Redact` pipeline. Returns the number of occurrences
   *  redacted (0 leaves the page untouched). */
  RedactText(find: string | RegExp, opts?: RedactOptions): number {
    return redactText(this.doc, this, find, opts ?? {});
  }
```

- [ ] **Step 5: Wire up `Document.RedactText`**

In `src/document.ts`, add the method immediately after `Redact` (it already imports `RedactOptions`; `Rect` is already used there):

```ts
  /** Redact every occurrence of `find` across all pages; see `Page.RedactText`.
   *  Returns the total number of occurrences redacted. */
  RedactText(find: string | RegExp, opts?: RedactOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.RedactText(find, opts);
    return total;
  }
```

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/redact-text.test.ts && npm run typecheck`
Expected: PASS (all `it` blocks), no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/redact.ts src/page.ts src/document.ts test/redact-text.test.ts
git commit -m "feat(vcc): RedactText — search-driven redaction (page + doc)"
```

---

### Task 2: Public export + README docs + full-suite verification + close

**Files:**
- Modify: `src/index.ts` (export `redactText`)
- Modify: `README.md` (Features + API table + Limitations)

**Interfaces:**
- Consumes: the public API from Task 1. Produces: documentation + one re-export.

- [ ] **Step 1: Export `redactText`**

In `src/index.ts`, the line `export { searchText, replaceText } from './textedit.js';` exports the sibling text primitives. Add `redactText` from redact.js next to the existing redact export. Find `export type { RedactOptions } from './redact.js';` and add above it:

```ts
export { redactText } from './redact.js';
```

- [ ] **Step 2: Update the Features "Redaction" bullet**

In `README.md`, the Features "Redaction" bullet describes `page.Redact`. Append a sentence:

```md
`page.RedactText(find | RegExp, opts?)` (and `doc.RedactText(...)`) redact **by content** — locating text with the same search as `page.Search` and removing every matched region through the same pipeline — and return the occurrence count.
```

- [ ] **Step 3: Add API-overview table rows**

In `README.md`, find the API-overview row for `page.Redact(...)` and add after it:

```md
| `page.RedactText(find, opts?)` | Redact every occurrence of a string/RegExp on the page; returns the count |
| `doc.RedactText(find, opts?)` | Redact every occurrence across all pages; returns the total count |
```

- [ ] **Step 4: Update the Limitations "Redaction is rectangle-driven" bullet**

In `README.md`, find the Limitations bullet beginning "**Redaction is rectangle-driven and removes whole glyphs/images**". Replace its opening clause "`Redact` takes explicit regions (it does not search for text to redact);" with:

```md
`Redact` takes explicit regions; `RedactText` derives them from a text search (still rectangle-based underneath — a neighboring glyph whose box overlaps a match's union quad may be removed too, and device-space quads assume unrotated pages);
```

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs(vcc): document RedactText + export redactText"
```

- [ ] **Step 7: Close the issue**

Run: `bd close aspose-pdf-foss-for-ts-vcc`

---

## Notes for the implementer

- `TextMatch.quads` is already one page-space box per line; `flatMap` over all matches gives the flat `Rect[]` `redactPage` expects — no per-line handling needed.
- Do not short-circuit `scrubMetadata` on a real redaction; only the *no-match* path skips it (return 0 before touching anything).
- `buildMultiStreamPage(streams)` builds a page with a Helvetica `/F1`, so `searchText` resolves glyph quads via Standard-14 metrics — the fixtures need no extra font setup.
- The marker-fill assertion uses `rg` (RGB fill) because `paintRedactionBoxes` emits `<r> <g> <b> rg` before the box; black is `0 0 0 rg`, red is `1 0 0 rg`.
