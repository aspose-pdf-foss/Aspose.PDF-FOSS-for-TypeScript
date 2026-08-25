# BleedBox / TrimBox / ArtBox Accessors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `BleedBox`, `TrimBox`, and `ArtBox` getter/setter pairs to `Page` — non-inheritable per PDF spec, defaulting to CropBox.

**Architecture:** A private `ownBox(key)` helper on `Page` reads the page's own dict only (no `/Parent` walk) and falls back to `this.CropBox`; setters reuse the existing `checkBox` validator and write the live dict, exactly like the 31b MediaBox/CropBox setters.

**Tech Stack:** TypeScript ESM, vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-bleed-trim-art-box-design.md`

**Issue:** aspose-pdf-foss-for-ts-cjc (already claimed / in_progress)

---

## File structure

| File | Responsibility |
|---|---|
| `src/page.ts` (modify) | `ownBox` helper + three getter/setter pairs, after the CropBox setter |
| `test/page.test.ts` (modify) | new `describe('BleedBox / TrimBox / ArtBox')` block |
| `README.md` (modify) | one API-table row |

Run tests with: `npx vitest run test/page.test.ts` (full suite: `npm test`).

`test/page.test.ts` already imports `Document`, `Page`, `buildClassicPdf`, and `PdfDict`, and defines a shared `doc` (line 9) — the new tests reuse those.

---

### Task 1: Getters (own-dict read, CropBox fallback)

**Files:**
- Modify: `src/page.ts` (after the CropBox setter, ~line 72)
- Test: `test/page.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `test/page.test.ts`, as a new top-level `describe` after the existing `describe('Page', ...)` block:

```ts
describe('BleedBox / TrimBox / ArtBox', () => {
  const KEYS = ['BleedBox', 'TrimBox', 'ArtBox'] as const;

  it('falls back to CropBox (then MediaBox) when absent', () => {
    const page = new Page(doc, new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]), 1);
    for (const k of KEYS) expect(page[k]).toEqual([0, 0, 200, 200]);
    const page2 = new Page(doc, new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['CropBox', [10, 10, 190, 190]],
    ]), 1);
    for (const k of KEYS) expect(page2[k]).toEqual([10, 10, 190, 190]);
  });

  it('reads an own value; other boxes still fall back', () => {
    const page = new Page(doc, new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['BleedBox', [5, 5, 195, 195]],
    ]), 1);
    expect(page.BleedBox).toEqual([5, 5, 195, 195]);
    expect(page.TrimBox).toEqual([0, 0, 200, 200]);
    expect(page.ArtBox).toEqual([0, 0, 200, 200]);
  });

  it('is NOT inherited from an ancestor /Pages node', () => {
    // MediaBox IS inheritable (the CropBox fallback resolves through the
    // parent), but the parent's BleedBox must be ignored.
    const parent: PdfDict = new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['BleedBox', [1, 1, 9, 9]],
    ]);
    const page = new Page(doc, new Map<string, any>([['Parent', parent]]), 1);
    expect(page.BleedBox).toEqual([0, 0, 200, 200]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/page.test.ts`
Expected: 3 new tests FAIL with `expected undefined to deeply equal [...]` (no such getters yet).

- [ ] **Step 3: Implement the helper and getters**

In `src/page.ts`, insert after the `CropBox` setter (after line 72):

```ts
  /** Own-dict (non-inheritable) box read; falls back to CropBox. */
  private ownBox(key: string): number[] {
    const b = this.doc.resolve(this.Dict.get(key));
    if (isArray(b) && b.length === 4) {
      const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
      if (nums.length === 4) return nums;
    }
    return this.CropBox;
  }

  /** Bleed boundary for print production; own key only (not inheritable); falls back to CropBox. */
  get BleedBox(): number[] {
    return this.ownBox('BleedBox');
  }

  /** Intended finished-page boundary; own key only (not inheritable); falls back to CropBox. */
  get TrimBox(): number[] {
    return this.ownBox('TrimBox');
  }

  /** Meaningful-content boundary; own key only (not inheritable); falls back to CropBox. */
  get ArtBox(): number[] {
    return this.ownBox('ArtBox');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/page.test.ts`
Expected: PASS (22 tests: 19 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "feat: BleedBox/TrimBox/ArtBox getters, non-inheritable with CropBox fallback (cjc)"
```

---

### Task 2: Setters

**Files:**
- Modify: `src/page.ts`
- Test: `test/page.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('BleedBox / TrimBox / ArtBox', ...)` block:

```ts
  it('setter writes the live dict and the getter reflects it (all three keys)', () => {
    for (const k of KEYS) {
      const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
      const page = new Page(doc, dict, 1);
      page[k] = [5, 6, 100, 101];
      expect(page[k]).toEqual([5, 6, 100, 101]);
      expect(dict.get(k)).toEqual([5, 6, 100, 101]);
    }
  });

  it('stores a defensive copy', () => {
    const page = new Page(doc, new Map<string, any>(), 1);
    const box = [1, 2, 3, 4];
    page.TrimBox = box;
    box[0] = 99;
    expect(page.TrimBox).toEqual([1, 2, 3, 4]);
  });

  it('throws TypeError on invalid input, leaving the dict untouched', () => {
    const dict: PdfDict = new Map<string, any>();
    const page = new Page(doc, dict, 1);
    const bad: any[] = [[1, 2, 3], [1, 2, 3, '4'], [1, 2, 3, NaN], [1, 2, 3, Infinity], 'nope', null];
    for (const b of bad) expect(() => { (page as any).ArtBox = b; }).toThrow(TypeError);
    expect(dict.has('ArtBox')).toBe(false);
  });

  it('survives Save + reopen', () => {
    const d = Document.Open(buildClassicPdf(1));
    d.Pages[0].BleedBox = [2, 2, 198, 198];
    d.Pages[0].ArtBox = [3, 3, 197, 197];
    const re = Document.Open(d.Save());
    expect(re.Pages[0].BleedBox).toEqual([2, 2, 198, 198]);
    expect(re.Pages[0].ArtBox).toEqual([3, 3, 197, 197]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/page.test.ts`
Expected: the live-dict and Save+reopen tests FAIL (assigning to a getter-only
property throws TypeError in strict mode — note the TypeError test passes
vacuously for now; the suite as a whole must be red).

- [ ] **Step 3: Implement the setters**

In `src/page.ts`, add a setter under each getter from Task 1:

```ts
  /** Write /BleedBox into the page's own live dict. */
  set BleedBox(box: number[]) {
    this.Dict.set('BleedBox', checkBox('BleedBox', box));
  }
```

```ts
  /** Write /TrimBox into the page's own live dict. */
  set TrimBox(box: number[]) {
    this.Dict.set('TrimBox', checkBox('TrimBox', box));
  }
```

```ts
  /** Write /ArtBox into the page's own live dict. */
  set ArtBox(box: number[]) {
    this.Dict.set('ArtBox', checkBox('ArtBox', box));
  }
```

(`checkBox` already exists at the top of `src/page.ts` — it validates 4 finite
numbers, throws TypeError otherwise, and returns a defensive copy.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/page.test.ts`
Expected: PASS (26 tests).

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "feat: BleedBox/TrimBox/ArtBox setters via checkBox validator (cjc)"
```

---

### Task 3: README + close out

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the API-table row**

In `README.md`, after the `page.Rect` row of the API overview table, insert:

```markdown
| `page.BleedBox` / `page.TrimBox` / `page.ArtBox` | Print boxes (own key only, fall back to `CropBox`; settable) |
```

- [ ] **Step 2: Quality gates**

Run: `npm test` then `npm run typecheck`
Expected: all suites green (form 28, page 26, etc.), typecheck clean. Do not proceed otherwise.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README lists BleedBox/TrimBox/ArtBox accessors"
```

- [ ] **Step 4: Close the bead**

```bash
bd close aspose-pdf-foss-for-ts-cjc
```

- [ ] **Step 5: Push (MANDATORY per CLAUDE.md)**

```bash
git add .beads/issues.jsonl .beads/interactions.jsonl
git commit -m "chore: sync beads export (cjc closed)"
git pull --rebase
git push
git status
```

Expected: "up to date with 'origin/main'". (Leave `_my/` files untouched — they are the user's.)

---

## Self-review notes

- **Spec coverage:** fallback chain (Task 1 test 1), own read (test 2), non-inheritance (test 3), setter round-trip/live-dict (Task 2 test 1), defensive copy (test 2), TypeError + untouched dict (test 3), Save+reopen (test 4), README row (Task 3). Complete.
- **Type consistency:** getters land in Task 1, setters in Task 2 — TS accessor pairs may be split across edits in the same class body; `ownBox` and `checkBox` names match `src/page.ts` as it exists today.
- **Test counts** (22 → 26 in page.test.ts) assume the current 19; trust per-test results over totals if they drift.
