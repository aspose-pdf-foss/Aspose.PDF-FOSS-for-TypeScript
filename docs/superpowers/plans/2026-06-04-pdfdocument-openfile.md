# Document.OpenFile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronous static `Document.OpenFile(fileName): Document` that reads a PDF from a file path and delegates to `Document.Open`.

**Architecture:** `OpenFile` reads the whole file with `fs.readFileSync`, wraps the Buffer as a `Uint8Array`, and calls the existing `Open` factory — reusing all parsing/validation. This introduces a `node:fs` import into the otherwise fs-free `document.ts` core (an accepted, deliberate coupling).

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Vitest, Node built-in `fs`.

**Spec:** `docs/superpowers/specs/2026-06-04-pdfdocument-openfile-design.md`

## File Structure

- **Modify `src/document.ts`** — add `import { readFileSync } from 'node:fs'` and the static `OpenFile` method.
- **Modify `test/document.test.ts`** — add an `OpenFile` describe block (temp-file fixture + missing-file case).

---

### Task 1: Add `Document.OpenFile`

**Files:**
- Modify: `src/document.ts`
- Test: `test/document.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/document.test.ts`, the current top imports are:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';
```

Replace that import block with (adds `afterAll`, temp-fs/os/path helpers):

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';
```

Append this block to the end of `test/document.test.ts`:

```ts
describe('Document.OpenFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfopenfile-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a PDF from a file path', () => {
    const path = join(dir, 'in.pdf');
    writeFileSync(path, buildClassicPdf(2));
    const doc = Document.OpenFile(path);
    expect(doc.Pages.length).toBe(2);
    expect(isDict(doc.catalog())).toBe(true);
  });

  it('throws when the file does not exist', () => {
    expect(() => Document.OpenFile(join(dir, 'nope.pdf'))).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- document.test`
Expected: FAIL — `Document.OpenFile is not a function`.

- [ ] **Step 3: Implement `OpenFile` in `src/document.ts`**

Add this import after the existing `import { buildPages } from './pagetree.js';` line:

```ts
import { readFileSync } from 'node:fs';
```

Add the static method directly below the existing `Open` method. The current
`Open` ends like this:

```ts
  static Open(buf: Uint8Array): Document {
    const { entries, trailer } = readXref(buf);
    if (trailer.get('Encrypt') !== undefined)
      throw new UnsupportedFeatureError('encrypted PDFs are not supported');
    return new Document(buf, entries, trailer);
  }
```

Insert immediately after its closing brace:

```ts
  /** Open a PDF from a file path (synchronous), delegating to Open. */
  static OpenFile(fileName: string): Document {
    return Document.Open(new Uint8Array(readFileSync(fileName)));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- document.test`
Expected: PASS (existing document cases + the two new `OpenFile` cases).

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: add Document.OpenFile static method"
```

---

### Task 2: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors, exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 3: Close the beads issue and commit any state**

```bash
bd close aspose-pdf-foss-for-ts-by5 --reason="Added Document.OpenFile (sync, delegates to Open); typecheck + full suite green"
git add -A
git commit -m "chore: beads close OpenFile issue"
```

---

## Self-Review Notes

- **Spec coverage:** `OpenFile` method + `readFileSync` delegation to `Open` (Task 1, Step 3); node:fs import / accepted coupling (Task 1, Step 3); opens-a-file and missing-file tests using the temp-dir pattern (Task 1, Step 1); full verification (Task 2). No export change needed (Document already exported) — nothing to do, correctly omitted.
- **Type/name consistency:** `OpenFile(fileName: string): Document` and the delegation `Document.Open(new Uint8Array(readFileSync(fileName)))` match the spec; `Open` (PascalCase, post-rename) is the delegate.
- **No placeholders:** every code step shows full code; every run step states the expected result.
