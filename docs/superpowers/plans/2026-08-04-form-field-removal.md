# Form Field Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Form.RemoveField(field: Field | string): boolean` — unwire a terminal AcroForm field, its widgets, and the intermediate nodes it leaves empty.

**Architecture:** A new pure-unwiring module `src/formremove.ts` does the work on live dicts; the `Form` facade in `src/form.ts` resolves a name to a `Field` and rebuilds its field list afterwards. Nothing is deleted from the object map — `Save()` renumbers from `/Root` and drops whatever nothing points at, which is why `/AcroForm /CO` must be scrubbed too.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

Design spec: `docs/superpowers/specs/2026-08-04-form-field-removal-design.md`. Issue: `aspose-pdf-foss-for-ts-4nzl`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { isDict } from './types.js'`).
- **TDD.** Write the test, run it, watch it fail for the right reason, then implement. Never write production code first.
- **`npm run typecheck` and `npm test` must both be green before the issue is closed.** Target one file with `npx vitest run test/form-remove.test.ts`.
- **Errors** are `TypeError` / `RangeError` / the public types in `src/errors.ts`. Removal throws only `TypeError`, and only on an argument that is neither a string nor a `Field`.
- **`PdfDict` is a `Map<string, PdfObject>`** keyed without the leading `/`. Use `doc.resolve(x)` before inspecting anything that may be a `PdfRef`, and the `isDict` / `isArray` guards from `src/types.js`.
- **Every mutation ends with `doc.markModified()`** so a later incremental sign rewrites in full instead of emitting a delta that leaves the field wired.
- Comments explain *why*, in the voice of the surrounding files. Match their density; do not narrate what the code already says.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/formremove.ts` (create) | `removeField(doc, fieldDict): boolean` — locate, detach widgets, splice, prune ancestors, scrub `/CO`. Knows nothing about names. |
| `src/form.ts` (modify) | `Form.RemoveField(field: Field \| string): boolean` — resolve the argument, delegate, `build()` on success. |
| `test/form-remove.test.ts` (create) | The whole behaviour, over `buildBlankPage` and `buildFormPdf`. |
| `README.md` (modify) | One paragraph plus a snippet in the forms section. |

`src/index.ts` needs **no** change: it already exports `Form`, and `removeField` is internal.

### Shared test preamble

Tasks 1–4 all extend `test/form-remove.test.ts`. Task 1 creates it with this
header; later tasks add `it(...)` blocks inside the same `describe`.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isArray, PdfDict, PdfObject } from '../src/types.js';

const blank = () => Document.Open(buildBlankPage());
const acroOf = (d: Document) => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const fieldsOf = (d: Document) => d.resolve(acroOf(d).get('Fields')) as PdfObject[];
const annotsOf = (d: Document, page = 1): PdfObject[] => {
  const a = d.resolve(d.Pages[page - 1].Dict.get('Annots'));
  return isArray(a) ? a : [];
};
const names = (d: Document) => d.Form.Fields.map((f) => f.FullName);
```

`doc.Form` builds a fresh `Form` on every access (document.ts:523), so
`doc.Form.RemoveField(...)` followed by `doc.Form.Fields` always reads the
current tree.

---

## Task 1: Core removal of a merged field/widget

A field created by this library is a single merged field/widget dict: it is its
own widget, it sits in `/AcroForm /Fields`, and its ref sits in the page's
`/Annots`. This task removes that case end to end.

**Files:**
- Create: `src/formremove.ts`
- Modify: `src/form.ts` (import + one method on `Form`)
- Test: `test/form-remove.test.ts` (create)

**Interfaces:**
- Consumes: `Document.resolve`, `Document.catalog()`, `Document.Pages`, `Document.markModified()`; `Field` and its public `Dict` from `src/formfield.js`; `Form.Get`, `Form.build` (private) from `src/form.js`.
- Produces: `removeField(doc: Document, field: PdfDict): boolean` from `src/formremove.js`; `Form.RemoveField(field: Field | string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/form-remove.test.ts` with the shared preamble above, followed by:

```ts
describe('Form.RemoveField', () => {
  it('removes the field, its /Fields entry and its widget', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'b' });
    expect(annotsOf(doc).length).toBe(2);

    expect(doc.Form.RemoveField('a')).toBe(true);

    expect(names(doc)).toEqual(['b']);
    expect(fieldsOf(doc).length).toBe(1);
    expect(annotsOf(doc).length).toBe(1);
    expect(doc.Form.Get('a')).toBeUndefined();
  });

  it('is idempotent, and an unknown name changes nothing', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(doc.Form.RemoveField('a')).toBe(true);
    const after = doc.Save().length;
    expect(doc.Form.RemoveField('a')).toBe(false);
    expect(doc.Form.RemoveField('nope')).toBe(false);
    expect(doc.Save().length).toBe(after);
  });

  it('takes a Field handle, and returns false for one already removed', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(doc.Form.RemoveField(f)).toBe(true);
    expect(doc.Form.RemoveField(f)).toBe(false);
    expect(doc.Form.Fields).toEqual([]);
  });

  it('does not remove a field belonging to another document', () => {
    const a = blank();
    const foreign = a.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const b = blank();
    b.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const before = b.Save().length;
    expect(b.Form.RemoveField(foreign)).toBe(false);
    expect(names(b)).toEqual(['a']);
    expect(b.Save().length).toBe(before);
  });

  it('rebuilds a held Form', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const form = doc.Form;
    expect(form.Fields.length).toBe(1);
    form.RemoveField('a');
    expect(form.Fields).toEqual([]);
  });

  it('rejects an argument that is neither a name nor a Field', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(() => doc.Form.RemoveField({} as never)).toThrow(TypeError);
    expect(names(doc)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/form-remove.test.ts`
Expected: every test fails with `doc.Form.RemoveField is not a function`.

- [ ] **Step 3: Write `src/formremove.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';

/** One step of the path from /AcroForm /Fields down to a field: the live array
 *  the node sits in, and where in it. */
interface Step {
  container: PdfObject[];
  index: number;
  node: PdfDict;
}

/** The chain of steps from `container` down to `target`, or undefined when the
 *  field is not in this tree.
 *
 *  Matched by dict identity, not by name: a stale handle, or one belonging to
 *  another document, is simply not found rather than removing the field that
 *  happens to share its name. */
function locate(doc: Document, container: PdfObject[], target: PdfDict): Step[] | undefined {
  for (let i = 0; i < container.length; i++) {
    const d = doc.resolve(container[i]);
    if (!isDict(d)) continue;
    if (d === target) return [{ container, index: i, node: d }];
    const kids = doc.resolve(d.get('Kids'));
    if (!isArray(kids)) continue;
    const below = locate(doc, kids as PdfObject[], target);
    if (below) return [{ container, index: i, node: d }, ...below];
  }
  return undefined;
}

/** The field's widget annotations: a merged field/widget dict is its own widget,
 *  otherwise the resolved /Kids entries. The rule Field.widgets() uses. */
function widgetsOf(doc: Document, field: PdfDict): PdfDict[] {
  const kids = doc.resolve(field.get('Kids'));
  if (!isArray(kids)) return [field];
  const out: PdfDict[] = [];
  for (const k of kids) {
    const d = doc.resolve(k);
    if (isDict(d)) out.push(d);
  }
  return out;
}

/** Drop every dict in `dead` from every page's /Annots.
 *
 *  Spliced in place so an indirect /Annots array keeps its identity, as
 *  Page.RemoveAnnotation does. Every page is scanned rather than the one named
 *  by the widget's /P: /P is optional, and a radio group's widgets sit on
 *  different pages anyway. */
function detachWidgets(doc: Document, dead: Set<PdfDict>): void {
  for (const page of doc.Pages) {
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    for (let i = annots.length - 1; i >= 0; i--) {
      const d = doc.resolve(annots[i]);
      if (isDict(d) && dead.has(d)) annots.splice(i, 1);
    }
  }
}

/** Remove a terminal field: unwire it from the field tree and drop its widgets
 *  from every page. True when the field was found.
 *
 *  Nothing is deleted from the object map. Save() renumbers what is reachable
 *  from /Root, so an unwired field is collected there — which is also why every
 *  remaining reference to it has to go. */
export function removeField(doc: Document, field: PdfDict): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return false;
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return false;
  const chain = locate(doc, fields as PdfObject[], field);
  if (!chain) return false;

  const dead = new Set<PdfDict>([field]);
  for (const w of widgetsOf(doc, field)) dead.add(w);
  detachWidgets(doc, dead);

  const last = chain[chain.length - 1];
  last.container.splice(last.index, 1);

  doc.markModified();
  return true;
}
```

- [ ] **Step 4: Add `RemoveField` to `src/form.ts`**

Extend the existing `formremove` import — there is none yet, so add it below the
`formcreate.js` import block near the top of the file:

```ts
import { removeField } from './formremove.js';
```

Then add the method to the `Form` class, immediately after `AddPushButton` and
before `GenerateAppearances`:

```ts
  /** Remove a terminal field: unwire it from /AcroForm /Fields (or its parent's
   *  /Kids) and drop its widgets from every page's /Annots. Accepts a FullName
   *  or a Field handle.
   *
   *  Returns false, changing nothing, when the field is not in this document —
   *  an unknown name, or a handle whose field is already gone — so removal is
   *  idempotent. Page.RemoveAnnotation is a no-op off-page for the same reason:
   *  the Add* family throws to protect an allocation it has not made yet, and
   *  there is nothing here to protect. */
  RemoveField(field: Field | string): boolean {
    const target = typeof field === 'string' ? this.Get(field) : field;
    if (target === undefined) return false;
    if (!(target instanceof Field))
      throw new TypeError('RemoveField takes a Field or a full field name');
    if (!removeField(this.doc, target.Dict)) return false;
    this.build();
    return true;
  }
```

`Field` is already imported as a value in `form.ts` (line 4), so `instanceof`
needs no new import.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/form-remove.test.ts`
Expected: PASS, 6 tests, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/formremove.ts src/form.ts test/form-remove.test.ts
git commit -m "feat(form): Form.RemoveField for a merged field/widget (4nzl)"
```

---

## Task 2: Widgets held in /Kids, across pages

A field read from a file — or any radio group — keeps its widgets in `/Kids`
rather than merging them. Task 1 only detaches the field dict itself, so those
widgets stay in `/Annots` and keep drawing.

**Files:**
- Modify: `src/formremove.ts` (nothing, if Task 1's `widgetsOf` is already correct — see Step 3)
- Test: `test/form-remove.test.ts`

**Interfaces:**
- Consumes: `removeField(doc, field)` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe`:

```ts
  it('drops /Kids widgets from every page they sit on', () => {
    const doc = blank();
    doc.AddPage();
    doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 10, 30, 30], export: 'red' },
        { page: 2, rect: [10, 10, 30, 30], export: 'green' },
      ],
    });
    expect(annotsOf(doc, 1).length).toBe(1);
    expect(annotsOf(doc, 2).length).toBe(1);

    expect(doc.Form.RemoveField('color')).toBe(true);

    expect(annotsOf(doc, 1)).toEqual([]);
    expect(annotsOf(doc, 2)).toEqual([]);
    expect(fieldsOf(doc)).toEqual([]);
  });

  it('removes a /Kids-widget field read from a file', () => {
    // buildFormPdf: field 8 'color' owns widgets 9 and 10, and the page /Annots
    // is [6 7 9 10 11 13].
    const doc = Document.Open(buildFormPdf());
    expect(doc.Form.RemoveField('color')).toBe(true);
    expect(doc.Form.Get('color')).toBeUndefined();
    expect(annotsOf(doc).length).toBe(4);

    const back = Document.Open(doc.Save());
    expect(back.Form.Get('color')).toBeUndefined();
    expect(back.Form.Fields.map((f) => f.FullName).sort())
      .toEqual(['agree', 'font', 'name', 'parent.child', 'sig', 'size', 'tags']);
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/form-remove.test.ts`
Expected: both new tests FAIL — the widgets are still in `/Annots`
(`expected 1 to be 0` / `expected 6 to be 4`) — while Task 1's tests stay green.

If they pass immediately, Task 1's `widgetsOf` already handled `/Kids`. Do not
accept that silently: confirm the tests are load-bearing by temporarily
replacing `widgetsOf`'s body with `return [field];`, re-running to see these two
fail, then restoring it. Note in the commit message that no production change
was needed.

- [ ] **Step 3: Make the tests pass**

`widgetsOf` in `src/formremove.ts` already returns the `/Kids` entries when
`/Kids` is present, and `detachWidgets` already scans every page. If you wrote
Task 1 exactly as given, there is no code to change here; if you simplified it,
restore both behaviours now.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/form-remove.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add test/form-remove.test.ts src/formremove.ts
git commit -m "test(form): removal covers /Kids widgets across pages (4nzl)"
```

---

## Task 3: Prune the intermediate nodes a removal empties

Removing `address.city` when `address.zip` is gone leaves an `address` node with
an empty `/Kids`. The form walk reports that node as a terminal field of its
own, so the document gains a phantom field named `address`.

**Files:**
- Modify: `src/formremove.ts` (the splice loop in `removeField`)
- Test: `test/form-remove.test.ts`

**Interfaces:**
- Consumes: `removeField`, the `Step[]` chain from Task 1.
- Produces: nothing new — same signature, more thorough.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe`:

```ts
  it('keeps a sibling and the parent node it still needs', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'address.city' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'address.zip' });

    expect(doc.Form.RemoveField('address.city')).toBe(true);

    expect(names(doc)).toEqual(['address.zip']);
    expect(fieldsOf(doc).length).toBe(1);
  });

  it('prunes every ancestor the removal empties', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a.b.c' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'keep' });

    expect(doc.Form.RemoveField('a.b.c')).toBe(true);

    expect(names(doc)).toEqual(['keep']);
    expect(fieldsOf(doc).length).toBe(1);
  });

  it('prunes an intermediate node read from a file', () => {
    // buildFormPdf: field 12 'parent' exists only to hold kid 13 'child'.
    const doc = Document.Open(buildFormPdf());
    expect(doc.Form.RemoveField('parent.child')).toBe(true);

    const after = Document.Open(doc.Save()).Form.Fields.map((f) => f.FullName);
    expect(after).not.toContain('parent.child');
    expect(after).not.toContain('parent');
    expect(after.length).toBe(7);
  });
```

The third test is the sharp one: without pruning, the emptied `parent` node is
walked as a terminal field and `after` contains `'parent'`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/form-remove.test.ts`
Expected: the two pruning tests FAIL (`expected 2 to be 1`, and
`expected [ 'name', …, 'parent' ] not to contain 'parent'`). The sibling test
passes already — that is fine, it guards the stopping condition.

- [ ] **Step 3: Replace the splice in `removeField`**

In `src/formremove.ts`, replace these two lines:

```ts
  const last = chain[chain.length - 1];
  last.container.splice(last.index, 1);
```

with:

```ts
  // Deepest first: each ancestor is judged only after its child is gone, and
  // pruning stops at the first that still has kids. Every container appears
  // once in the chain, so the recorded indices stay valid as we go.
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = chain[i];
    if (i < chain.length - 1) {
      const kids = doc.resolve(step.node.get('Kids'));
      if (isArray(kids) && kids.length > 0) break;
      dead.add(step.node);
    }
    step.container.splice(step.index, 1);
  }
```

`dead` collects the pruned ancestors as well as the field, which Task 4 needs.
Update `removeField`'s doc comment to say it also prunes intermediate nodes it
empties.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/form-remove.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/formremove.ts test/form-remove.test.ts
git commit -m "feat(form): prune intermediate nodes emptied by a removal (4nzl)"
```

---

## Task 4: Scrub /AcroForm /CO

`/CO` (calculation order, PDF 32000-1 table 218) is an array of field refs
hanging off `/AcroForm`, so it is reachable from `/Root`. A leftover entry keeps
the removed field alive through `Save()`'s mark-sweep together with its widgets:
the saved file carries a field that is in no `/Fields` and has no `/Annots`
entry — removed everywhere a viewer looks, still present in the bytes.

Nothing this library writes emits `/CO`, so no builder fixture would catch it;
`src/docmdp.ts:62` lists it among the `/AcroForm` keys real documents carry.

**Files:**
- Modify: `src/formremove.ts`
- Test: `test/form-remove.test.ts`

**Interfaces:**
- Consumes: `removeField`, the `dead` set built in Tasks 1 and 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe`:

```ts
  it('scrubs /AcroForm /CO so the field cannot survive Save', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'total' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'keep' });
    // Nothing we write emits /CO; documents from other producers do.
    const acro = acroOf(doc);
    acro.set('CO', [fieldsOf(doc)[0]]);

    expect(doc.Form.RemoveField('total')).toBe(true);

    expect(doc.resolve(acro.get('CO'))).toEqual([]);
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved)).not.toContain('(total)');
    expect(Document.Open(saved).Form.Get('total')).toBeUndefined();
  });

  it('scrubs a pruned ancestor from /CO too', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'sums.total' });
    const acro = acroOf(doc);
    acro.set('CO', [fieldsOf(doc)[0]]);   // the 'sums' node, which pruning removes

    expect(doc.Form.RemoveField('sums.total')).toBe(true);

    expect(doc.resolve(acro.get('CO'))).toEqual([]);
    expect(new TextDecoder('latin1').decode(doc.Save())).not.toContain('(sums)');
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/form-remove.test.ts`
Expected: both FAIL — `/CO` still holds its ref, and the saved bytes still
contain `(total)` / `(sums)` because the ref kept the object reachable.

- [ ] **Step 3: Add the scrub**

In `src/formremove.ts`, add this function after `detachWidgets`:

```ts
/** Drop refs to any removed node from /AcroForm /CO, the calculation order.
 *
 *  /CO hangs off /AcroForm and so is reachable from /Root: a leftover entry
 *  keeps the dead field and its widgets alive through Save()'s mark-sweep, and
 *  the saved file then carries a field that is in no /Fields and has no /Annots
 *  entry. Nothing we write emits /CO — documents from other producers do. */
function scrubCO(doc: Document, acro: PdfDict, dead: Set<PdfDict>): void {
  const co = doc.resolve(acro.get('CO'));
  if (!isArray(co)) return;
  for (let i = co.length - 1; i >= 0; i--) {
    const d = doc.resolve(co[i]);
    if (isDict(d) && dead.has(d)) co.splice(i, 1);
  }
}
```

and call it in `removeField`, between the splice loop and `doc.markModified()`:

```ts
  scrubCO(doc, acro, dead);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/form-remove.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/formremove.ts test/form-remove.test.ts
git commit -m "fix(form): scrub /AcroForm /CO when removing a field (4nzl)"
```

---

## Task 5: Docs, gates and close-out

**Files:**
- Modify: `README.md`
- Test: the full suite

- [ ] **Step 1: Document `RemoveField` in the README**

In the forms section, immediately **before** the `#### Field styling` heading
(README.md:1082), insert:

````markdown
A field can also be **removed**, by full name or by handle:

```ts
doc.Form.RemoveField('address.city');   // true when it removed something
doc.Form.RemoveField(field);            // a handle works too
```

Removal unwires the field from `/AcroForm /Fields` (or its parent's `/Kids`),
drops its widgets from every page they sit on, and prunes intermediate nodes it
leaves empty — removing the last child of `address` removes `address` as well.
It returns `false` and changes nothing for a name that is not there or a handle
whose field is already gone, so it is safe to call twice. The objects
themselves go at the next `Save()`, which writes only what is still reachable.
````

- [ ] **Step 2: Run the full gates**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: all test files pass; the suite takes ~70s.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Form.RemoveField (4nzl)"
```

- [ ] **Step 4: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-4nzl --reason "<what shipped, with the commit ids>"
git add .beads/interactions.jsonl
git commit -m "chore(bd): close 4nzl"
git pull --rebase
git push
git status -sb   # MUST show no 'ahead'
```

Leave the untracked `_my/` notes alone — they are the user's, committed separately.

---

## Self-Review

**Spec coverage.** API shape and the `Field | string` union, terminal-only
targeting, boolean/no-op contract → Task 1. Module split (`formremove.ts` vs
`form.ts`) → Task 1 file structure. Algorithm steps 1–4 → Task 1, step 2's
`/Kids` rule proven by Task 2, step 5 pruning → Task 3, step 6 `/CO` → Task 4,
step 7 `markModified` → Task 1. Signed signature fields need no code: nothing
special-cases them, which is the decision. Every row of the spec's test table
appears in Tasks 1–4 (the "unknown name / stale handle" row is split across two
tests, plus a foreign-document case the spec implied by "identity"). "Not
covered" items are documented in the spec, not implemented — correct.

**Placeholders.** None: every step carries the code it needs, and the one
conditional step (Task 2 Step 3) says exactly what to check and how to prove the
test is load-bearing.

**Type consistency.** `removeField(doc: Document, field: PdfDict): boolean`,
`locate(doc, container: PdfObject[], target: PdfDict): Step[] | undefined`,
`widgetsOf(doc, field: PdfDict): PdfDict[]`, `detachWidgets(doc, dead:
Set<PdfDict>): void`, `scrubCO(doc, acro: PdfDict, dead: Set<PdfDict>): void`
and `Form.RemoveField(field: Field | string): boolean` are used with those exact
names and signatures in every task that mentions them. `dead` is introduced in
Task 1, extended in Task 3, and consumed in Task 4.
