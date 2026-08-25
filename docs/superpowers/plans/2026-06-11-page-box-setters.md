# Page MediaBox/CropBox Setters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MediaBox` and `CropBox` setters to `Page` that write the page's own live dict, overriding inherited values (issue aspose-pdf-foss-for-ts-31b).

**Architecture:** Mirrors the existing `Rotate` setter in `src/page.ts` — a setter writes directly into `this.Dict`, the live page dict from the document's object map, so the existing `inherited()` walk finds the own key first. A module-level `checkBox` helper validates input (exactly 4 finite numbers) and returns a defensive copy.

**Tech Stack:** TypeScript, vitest. Spec: `docs/superpowers/specs/2026-06-11-page-box-setters-design.md`.

**Context for a zero-context engineer:**
- `Page` (`src/page.ts`) wraps a live `PdfDict` (a `Map<string, PdfObject>`). Getters `MediaBox`/`CropBox` already exist and resolve inheritable keys up the `/Parent` chain; `CropBox` falls back to `MediaBox`, `MediaBox` defaults to US Letter.
- `test/helpers/build-pdf.ts` → `buildClassicPdf(n)` builds an n-page PDF whose **MediaBox lives on the `/Pages` root**, so leaf pages inherit it — ideal for testing that a setter overrides inheritance for one page without affecting siblings.
- `Document.Open(bytes)` parses, `doc.Save()` returns serialized bytes; `Document.Open(doc.Save())` round-trips.
- Run tests with `npx vitest run test/page.test.ts` (full suite: `npx vitest run`).

---

### Task 1: Setters write the page's own dict

**Files:**
- Modify: `src/page.ts` (after the `MediaBox`/`CropBox` getters, lines 43-50)
- Test: `test/page.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `test/page.test.ts` (after the existing `describe('Page', ...)` block, before the `index exports` block):

```ts
describe('Page box setters', () => {
  it('MediaBox setter writes the live dict and is observable via the getter', () => {
    const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
    const page = new Page(doc, dict, 1);
    page.MediaBox = [0, 0, 300, 400];
    expect(page.MediaBox).toEqual([0, 0, 300, 400]);
    expect(dict.get('MediaBox')).toEqual([0, 0, 300, 400]); // wrote the live dict
  });

  it('CropBox setter is independent of MediaBox', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 600, 800]]]);
    const page = new Page(doc, dict, 1);
    page.CropBox = [10, 10, 290, 390];
    expect(page.CropBox).toEqual([10, 10, 290, 390]);
    expect(page.MediaBox).toEqual([0, 0, 600, 800]); // untouched
  });

  it('stores a copy: mutating the caller array afterwards does not change the page', () => {
    const page = new Page(doc, new Map(), 1);
    const box = [0, 0, 100, 100];
    page.MediaBox = box;
    box[2] = 999;
    expect(page.MediaBox).toEqual([0, 0, 100, 100]);
  });

  it('overrides an inherited MediaBox for that page only', () => {
    // buildClassicPdf puts MediaBox [0 0 200 200] on the /Pages root; leaves inherit it.
    const d = Document.Open(buildClassicPdf(2));
    d.Pages[0].MediaBox = [0, 0, 300, 300];
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 300, 300]);
    expect(d.Pages[1].MediaBox).toEqual([0, 0, 200, 200]); // sibling still inherits
  });

  it('set boxes survive Save + reopen', () => {
    const d = Document.Open(buildClassicPdf(1));
    d.Pages[0].MediaBox = [0, 0, 300, 300];
    d.Pages[0].CropBox = [5, 5, 295, 295];
    const d2 = Document.Open(d.Save());
    expect(d2.Pages[0].MediaBox).toEqual([0, 0, 300, 300]);
    expect(d2.Pages[0].CropBox).toEqual([5, 5, 295, 295]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/page.test.ts`
Expected: the 5 new tests FAIL (TypeScript assigns to a property with no setter — vitest/esbuild compiles it, the assignment is silently ignored at runtime, so getters still return old/inherited values). The 12 pre-existing tests still pass.

- [ ] **Step 3: Implement the setters**

In `src/page.ts`, add a module-level helper after the imports (before `export class Page`):

```ts
/** Validate a rectangle and return a defensive copy. */
function checkBox(key: string, box: number[]): number[] {
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    throw new TypeError(`${key} must be [llx, lly, urx, ury] (4 finite numbers)`);
  }
  return [...box];
}
```

Add the setters directly after their getters (matching the `Rotate` getter/setter layout):

```ts
  /** Write /MediaBox into the page's own live dict (overrides any inherited value). */
  set MediaBox(box: number[]) {
    this.Dict.set('MediaBox', checkBox('MediaBox', box));
  }
```

(after the `MediaBox` getter), and

```ts
  /** Write /CropBox into the page's own live dict (overrides any inherited value). */
  set CropBox(box: number[]) {
    this.Dict.set('CropBox', checkBox('CropBox', box));
  }
```

(after the `CropBox` getter).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/page.test.ts`
Expected: all tests PASS (12 old + 5 new + the `index exports` test).

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "feat: Page MediaBox/CropBox setters write the live page dict (31b)"
```

---

### Task 2: Reject invalid boxes

**Files:**
- Modify: `src/page.ts` (no change expected — `checkBox` from Task 1 already throws; this task proves it)
- Test: `test/page.test.ts`

- [ ] **Step 1: Write the tests**

Append inside the `describe('Page box setters', ...)` block from Task 1:

```ts
  it('throws TypeError on anything that is not 4 finite numbers', () => {
    const page = new Page(doc, new Map(), 1);
    expect(() => { page.MediaBox = [0, 0, 100] as any; }).toThrow(TypeError);            // wrong length
    expect(() => { page.MediaBox = [0, 0, 100, '100'] as any; }).toThrow(TypeError);     // non-number entry
    expect(() => { page.CropBox = [0, 0, 100, NaN]; }).toThrow(TypeError);               // NaN
    expect(() => { page.CropBox = [0, 0, Infinity, 100]; }).toThrow(TypeError);          // non-finite
    expect(() => { page.MediaBox = 'box' as any; }).toThrow(TypeError);                  // not an array
    expect(() => { page.MediaBox = [0, 0, 100] as any; }).toThrow(/MediaBox must be/);   // names the key
  });

  it('leaves the dict untouched when the setter throws', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
    const page = new Page(doc, dict, 1);
    expect(() => { page.MediaBox = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(page.MediaBox).toEqual([0, 0, 200, 200]); // old value intact
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/page.test.ts`
Expected: PASS immediately — `checkBox` (Task 1) throws before `Dict.set` runs, so the dict is never touched on invalid input. If any of these FAIL, fix `checkBox` until they pass; do not weaken the assertions.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: all tests green (175+ tests; 168 existed before this feature).

- [ ] **Step 4: Commit and close the issue**

```bash
git add test/page.test.ts
git commit -m "test: Page box setters reject invalid rectangles (31b)"
bd close aspose-pdf-foss-for-ts-31b
```
