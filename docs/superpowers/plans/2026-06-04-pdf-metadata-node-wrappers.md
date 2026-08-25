# PDF Metadata Node fs Wrappers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add async filesystem wrappers (`readMetadataFile`, `updateMetadataFile`, `clearMetadataFile`) in `src/node.ts` around the existing in-memory `Document` metadata API.

**Architecture:** Each wrapper composes `readFile` → `Document.open` → metadata method → (for update/clear) `save` → `writeFile`. No new metadata logic; all semantics (merge update, incremental save, encoding) live in the in-memory API. Output path is a required positional arg mirroring `splitPdfFile(inputPath, outDir)`; in-place editing = pass the same path twice (file is fully read into memory before write).

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Node built-in `fs/promises`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-06-04-pdf-metadata-node-wrappers-design.md`

---

### Task 1: `readMetadataFile`

**Files:**
- Test: `test/node-metadata.test.ts` (create)
- Modify: `src/node.ts` (add import + function)

- [ ] **Step 1: Write the failing test**

Create `test/node-metadata.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMetadataFile,
  updateMetadataFile,
  clearMetadataFile,
} from '../src/node.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const dir = mkdtempSync(join(tmpdir(), 'pdfmeta-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a fixture PDF with the given /Info to a fresh path and return it. */
function fixture(name: string, info?: Record<string, string>): string {
  const p = join(dir, name);
  writeFileSync(p, buildClassicPdf(1, info ? { info } : {}));
  return p;
}

describe('readMetadataFile', () => {
  it('reads standard and custom fields from a file', async () => {
    const input = fixture('read.pdf', { Title: 'Hi', Author: 'Ada', Custom1: 'X' });
    const meta = await readMetadataFile(input);
    expect(meta.title).toBe('Hi');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Custom1: 'X' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-metadata`
Expected: FAIL — `readMetadataFile` is not exported / not a function.

- [ ] **Step 3: Add the import and implement `readMetadataFile`**

In `src/node.ts`, extend the imports and add the function. The existing
top-of-file imports are:

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitPdf, SplitOptions } from './split.js';
```

Add after them:

```ts
import { Document } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';
```

Add at the end of the file:

```ts
/** Read a PDF from disk and return its document metadata (/Info). */
export async function readMetadataFile(inputPath: string): Promise<Metadata> {
  const input = new Uint8Array(await readFile(inputPath));
  return Document.open(input).getMetadata();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-metadata`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add test/node-metadata.test.ts src/node.ts
git commit -m "feat: add readMetadataFile node wrapper"
```

---

### Task 2: `updateMetadataFile` (merge + delete)

**Files:**
- Test: `test/node-metadata.test.ts` (modify — add `describe` block)
- Modify: `src/node.ts` (add function)

- [ ] **Step 1: Write the failing tests**

Append to `test/node-metadata.test.ts`:

```ts
describe('updateMetadataFile', () => {
  it('merges updates and preserves untouched fields', async () => {
    const input = fixture('upd-in.pdf', { Title: 'Old', Author: 'Ada' });
    const output = join(dir, 'upd-out.pdf');
    await updateMetadataFile(input, output, { title: 'New', custom: { K: 'V' } });
    const meta = await readMetadataFile(output);
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ K: 'V' });
  });

  it('deletes a field when set to null', async () => {
    const input = fixture('del-in.pdf', { Title: 'Old', Author: 'Ada' });
    const output = join(dir, 'del-out.pdf');
    await updateMetadataFile(input, output, { author: null });
    const meta = await readMetadataFile(output);
    expect(meta.author).toBeUndefined();
    expect(meta.title).toBe('Old');
  });

  it('edits in place when input and output paths are the same', async () => {
    const path = fixture('inplace.pdf', { Title: 'Old' });
    await updateMetadataFile(path, path, { title: 'New' });
    const meta = await readMetadataFile(path);
    expect(meta.title).toBe('New');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- node-metadata`
Expected: FAIL — `updateMetadataFile` is not a function.

- [ ] **Step 3: Implement `updateMetadataFile`**

Add to the end of `src/node.ts`:

```ts
/**
 * Read a PDF, merge `update` into its metadata, and write the result to
 * `outputPath`. undefined leaves a field unchanged, null deletes it, a value sets it.
 */
export async function updateMetadataFile(
  inputPath: string,
  outputPath: string,
  update: MetadataUpdate,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.open(input);
  doc.setMetadata(update);
  await writeFile(outputPath, doc.save());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- node-metadata`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add test/node-metadata.test.ts src/node.ts
git commit -m "feat: add updateMetadataFile node wrapper"
```

---

### Task 3: `clearMetadataFile`

**Files:**
- Test: `test/node-metadata.test.ts` (modify — add `describe` block)
- Modify: `src/node.ts` (add function)

- [ ] **Step 1: Write the failing test**

Append to `test/node-metadata.test.ts`:

```ts
describe('clearMetadataFile', () => {
  it('removes all metadata', async () => {
    const input = fixture('clr-in.pdf', { Title: 'Old', Author: 'Ada', Custom1: 'X' });
    const output = join(dir, 'clr-out.pdf');
    await clearMetadataFile(input, output);
    const meta = await readMetadataFile(output);
    expect(meta).toEqual({ custom: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-metadata`
Expected: FAIL — `clearMetadataFile` is not a function.

- [ ] **Step 3: Implement `clearMetadataFile`**

Add to the end of `src/node.ts`:

```ts
/** Read a PDF, remove all document metadata, and write the result to `outputPath`. */
export async function clearMetadataFile(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.open(input);
  doc.clearMetadata();
  await writeFile(outputPath, doc.save());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-metadata`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add test/node-metadata.test.ts src/node.ts
git commit -m "feat: add clearMetadataFile node wrapper"
```

---

### Task 4: Export from the package index

**Files:**
- Modify: `src/index.ts:6`

- [ ] **Step 1: Add the exports**

In `src/index.ts`, the line is currently:

```ts
export { splitPdfFile } from './node.js';
```

Replace it with:

```ts
export { splitPdfFile, readMetadataFile, updateMetadataFile, clearMetadataFile } from './node.js';
```

(`Metadata` / `MetadataUpdate` types are already exported on line 8 — no change needed.)

- [ ] **Step 2: Add an index re-export assertion to the test**

Append to `test/node-metadata.test.ts`:

```ts
import * as api from '../src/index.js';

describe('index exports', () => {
  it('re-exports the metadata file wrappers', () => {
    expect(typeof api.readMetadataFile).toBe('function');
    expect(typeof api.updateMetadataFile).toBe('function');
    expect(typeof api.clearMetadataFile).toBe('function');
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -- node-metadata`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts test/node-metadata.test.ts
git commit -m "feat: export metadata file wrappers from index"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors, exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass (existing suites + the new `node-metadata` suite).

- [ ] **Step 3: Close the beads issue and commit any remaining state**

```bash
bd close aspose-pdf-foss-for-ts-30g --reason="Implemented read/update/clear Node fs metadata wrappers per spec"
git add -A
git commit -m "chore: beads close metadata node wrappers issue"
```

---

## Self-Review Notes

- **Spec coverage:** read (Task 1), update merge + delete + in-place (Task 2), clear (Task 3), exports (Task 4), typecheck + full suite (Task 5). All spec test cases mapped.
- **Type consistency:** signatures match the spec and the in-memory API — `Document.open(Uint8Array)`, `getMetadata(): Metadata`, `setMetadata(update: MetadataUpdate): void`, `clearMetadata(): void`, `save(): Uint8Array`. `buildClassicPdf(pageCount, { info })` matches the helper signature.
- **No new error handling:** intentional per spec — fs/parse errors propagate.
