# Flatten struct-tree retag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `FlattenAnnotations`/`FlattenForm` follow the ink — re-point a flattened annotation's `/OBJR` at the marked content flatten just wrote, instead of leaving a dangling `/OBJR` that keeps the annotation alive through `Save()`'s mark-sweep.

**Architecture:** One new export, `retagAsContent`, in `src/structwrite.ts` — the third member of the `tagAnnotation`/`untagObjects` family. It performs the whole structure-tree edit and hands the caller back a tag name plus MCID to wrap its content in. `src/flatten.ts` calls it inside the loop where it already builds the content body (so no `EditableContent`, no content rewriting — flatten stays append-only) and finishes with one `untagObjects` sweep over every annotation that left `/Annots`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-08-04-flatten-struct-retag-design.md`. Issue: `aspose-pdf-foss-for-ts-4dqa` (already claimed).

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { … } from './structwrite.js'`), including in tests.
- **Strict TypeScript.** `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) must be green.
- **Both gates before closing.** `npm run typecheck` and `npm test` must both be green. Target one file with `npx vitest run test/<name>.test.ts`.
- **Issue tracking is `bd`.** Do not use TodoWrite, TaskCreate, or markdown TODO lists.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Prove assertions load-bearing.** Per CLAUDE.md: a test passing on the first run is not evidence. Where a step says "mutation check", break the named line, confirm the named test goes red, then restore.
- **Never mutate on the render path.** `resolveAppearance` stays read-only; only flatten promotes refs.

## File Structure

| File | Responsibility |
|---|---|
| `src/structwrite.ts` (modify) | Add `retagAsContent` + the `FLATTENED_TYPE` map + (Task 3) `parentTreeLookup`. Already owns `tagAnnotation`, `untagObjects`, `pageMcidArray`, `clearParentTreeKeys`, `kArray` — all private helpers this needs are in-file, so nothing new is exported from anywhere else. |
| `src/flatten.ts` (modify) | Call `retagAsContent` in the bake loop; collect the `dead` set; one `untagObjects` sweep. |
| `test/flatten-struct.test.ts` (create) | The whole behaviour. Mirrors `test/struct-remove.test.ts` — same helper shapes, same `buildBlankPage` base. |
| `CLAUDE.md` (modify) | Extend the struct.ts invariant block. |

No new module. `retagAsContent` needs `pageMcidArray`, `clearParentTreeKeys` and `kArray`, all file-private to `structwrite.ts`; putting it anywhere else would mean exporting three internals to serve one caller.

`src/flatten.ts` currently imports nothing from the struct stack. Adding `./structwrite.js` creates no cycle: `structwrite.ts` imports `document`, `page`, `struct`, `annotation`, `editcontent`, `text`, `content` — never `flatten`.

---

### Task 1: Close the leak — untag every annotation that leaves /Annots

The minimum honest fix, shippable on its own: whatever else happens, an annotation that leaves `/Annots` must not stay reachable from `/Root`.

**Files:**
- Modify: `src/flatten.ts:41-81` (`flattenPageAnnots`)
- Test: `test/flatten-struct.test.ts` (create)

**Interfaces:**
- Consumes: `untagObjects(doc: Document, dead: ReadonlySet<PdfDict>): void` from `src/structwrite.ts:261`.
- Produces: nothing new. Task 2 replaces the drop with a re-point but keeps this sweep as the mop-up.

- [ ] **Step 1: Write the failing test**

Create `test/flatten-struct.test.ts`. The helpers mirror `test/struct-remove.test.ts` exactly — later tasks add cases to this same file.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { flattenForm } from '../src/flatten.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { PdfDict, PdfObject, isArray, isDict, isName } from '../src/types.js';

/** Dicts of the given /Subtype anywhere in the object map — including objects no
 *  page points at any more, which is the whole question here. */
function subtypeCount(doc: Document, subtype: string): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) {
    if (!isDict(o)) continue;
    const st = doc.resolve(o.get('Subtype'));
    if (isName(st) && st.name === subtype) n++;
  }
  return n;
}

/** The /K kids of a struct element, as an array however /K is shaped. */
function kids(doc: Document, elem: PdfDict): PdfObject[] {
  const k = doc.resolve(elem.get('K'));
  if (isArray(k)) return k;
  return k === null || k === undefined ? [] : [k];
}

/** Every OBJR dict among an element's kids. */
function objrs(doc: Document, elem: PdfDict): PdfDict[] {
  const out: PdfDict[] = [];
  for (const kid of kids(doc, elem)) {
    const d = doc.resolve(kid);
    if (!isDict(d)) continue;
    const t = doc.resolve(d.get('Type'));
    if (isName(t) && t.name === 'OBJR') out.push(d);
  }
  return out;
}

/** The flat /ParentTree /Nums array of the document's structure tree. */
function parentTreeNums(doc: Document): PdfObject[] {
  const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;
  const pt = doc.resolve(root.get('ParentTree')) as PdfDict;
  const nums = doc.resolve(pt.get('Nums'));
  return isArray(nums) ? nums : [];
}

/** The keys (even slots) of the /ParentTree /Nums array. */
const parentTreeKeys = (doc: Document): number[] =>
  parentTreeNums(doc).filter((_, i) => i % 2 === 0).map((k) => k as number);

/** The page's content streams as text. */
const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

/** A blank page carrying a text field tagged under a /Form element with an
 *  /Alt. Returns the document, that element's dict, and the widget's
 *  /StructParent key. */
function taggedField(): { doc: Document; form: PdfDict; key: number } {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
  const root = doc.CreateStructTree();
  const form = root.Append('Form', { alt: 'Your name' });
  const widget = doc.Pages[0].Annotations[0];
  form.AddAnnotation(widget);
  const key = doc.resolve(widget.Dict.get('StructParent')) as number;
  return { doc, form: form.Dict, key };
}

describe('flatten and the structure tree', () => {
  it('does not leave a flattened widget alive through Save', () => {
    const { doc } = taggedField();

    flattenForm(doc);

    // The OBJR /Obj ref is reachable from /Root through /StructTreeRoot, so a
    // leftover keeps the widget in the saved bytes with no /Annots entry.
    const saved = Document.Open(doc.Save());
    expect(subtypeCount(saved, 'Widget')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flatten-struct.test.ts`
Expected: FAIL — `expected 1 to be 0`. That 1 is the dangling widget the issue measured.

- [ ] **Step 3: Implement the sweep**

In `src/flatten.ts`, add the import next to the existing ones:

```ts
import { untagObjects } from './structwrite.js';
```

Then replace the tail of `flattenPageAnnots` (currently lines 75-80):

```ts
  if (count === 0) return 0;
  appendContent(doc, page, enc(body));
  // Second pass: /Annots order is arbitrary, so a popup can only be judged once
  // the whole baked set is known.
  page.Dict.set('Annots', keep.filter((e) => !isOrphanedPopup(doc, e, baked)));
  return count;
```

with:

```ts
  if (count === 0) return 0;
  appendContent(doc, page, enc(body));

  // Second pass: /Annots order is arbitrary, so a popup can only be judged once
  // the whole baked set is known.
  const kept: PdfObject[] = [];
  const dead = new Set(baked);
  for (const e of keep) {
    if (!isOrphanedPopup(doc, e, baked)) { kept.push(e); continue; }
    const d = doc.resolve(e);
    if (isDict(d)) dead.add(d);
  }
  page.Dict.set('Annots', kept);

  // Every annotation that just left /Annots must also leave the structure tree.
  // /StructTreeRoot hangs off /Root, so an OBJR still naming one keeps it in the
  // saved bytes with no /Annots entry anywhere — the same trap hob8 closed for
  // Page.RemoveAnnotation and Form.RemoveField.
  untagObjects(doc, dead);
  return count;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flatten-struct.test.ts test/flatten-annotations.test.ts test/flatten-form.test.ts test/flatten-api.test.ts`
Expected: PASS, all four files.

- [ ] **Step 5: Mutation check**

Change `untagObjects(doc, dead)` to `untagObjects(doc, new Set())` and rerun `npx vitest run test/flatten-struct.test.ts`. Expected: the new test goes red. Restore the line.

- [ ] **Step 6: Commit**

```bash
git add src/flatten.ts test/flatten-struct.test.ts
git commit -m "$(cat <<'EOF'
fix(flatten): untag every annotation that leaves /Annots (4dqa)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Re-point the OBJR at the baked marked content

Task 1 stopped the leak by throwing the tag away. That makes flattened output less accessible than its input: the `/Alt` and the reading-order position describe content that is *still on the page*. Replace the drop with a re-point.

**Files:**
- Modify: `src/structwrite.ts` (add `FLATTENED_TYPE` + `retagAsContent` after `tagAnnotation`, i.e. after line 218)
- Modify: `src/flatten.ts:51-73` (the bake loop)
- Test: `test/flatten-struct.test.ts`

**Interfaces:**
- Consumes: file-private `pageMcidArray(doc, rootDict, page): PdfObject[]` (`structwrite.ts:138`), `parentTreeNums(doc, rootDict): PdfObject[]` (`structwrite.ts:117`), `clearParentTreeKeys(doc, rootDict, keys): void` (`structwrite.ts:234`), `kArray(doc, dict): PdfObject[]` (`structwrite.ts:88`), `asNum` (`structwrite.ts:13`).
- Produces: `retagAsContent(doc: Document, page: Page, annot: PdfDict): { tag: string; mcid: number } | undefined`, exported from `src/structwrite.ts`. Task 3 changes its `/ParentTree` lookup; nothing else consumes it.

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe` in `test/flatten-struct.test.ts`:

```ts
  it('retypes the flattened element from /Form to /Figure and keeps its /Alt', () => {
    const { doc, form } = taggedField();

    flattenForm(doc);

    // /Form identifies a widget annotation (ISO 32000-1 Table 337) and there is
    // no widget any more — but /Figure is alt-required too, so the /Alt the
    // document already needed to validate carries over untouched.
    expect((doc.resolve(form.get('S')) as { name: string }).name).toBe('Figure');
    expect(doc.GetStructTree()!.Children[0].Alt).toBe('Your name');
  });

  it('swaps the OBJR for a marked-content kid wired to the page', () => {
    const { doc, form } = taggedField();

    flattenForm(doc);

    expect(objrs(doc, form).length).toBe(0);
    const k = kids(doc, form);
    expect(k.length).toBe(1);
    expect(typeof k[0]).toBe('number');

    // The element claims the page it now draws on, and the page's MCID array
    // maps that MCID back to the element.
    expect(doc.resolve(form.get('Pg'))).toBe(doc.Pages[0].Dict);
    const sp = doc.resolve(doc.Pages[0].Dict.get('StructParents')) as number;
    const nums = parentTreeNums(doc);
    const at = nums.indexOf(sp);
    const arr = doc.resolve(nums[at + 1]) as PdfObject[];
    expect(doc.resolve(arr[k[0] as number])).toBe(form);
  });

  it('clears the annotation /ParentTree slot', () => {
    const { doc, key } = taggedField();
    expect(parentTreeKeys(doc)).toContain(key);

    flattenForm(doc);

    expect(parentTreeKeys(doc)).not.toContain(key);
  });

  it('wraps the baked appearance in BDC/EMC under the retyped tag', () => {
    const { doc } = taggedField();

    flattenForm(doc);

    const c = content(doc);
    expect(c).toMatch(/\/Figure <<\/MCID 0>> BDC\s+q [^\n]* cm \/Fm0 Do Q\s+EMC/);
  });

  it('keeps the baked content in the annotation reading-order slot', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const root = doc.CreateStructTree();
    const el = root.Append('Form', { alt: 'Your name' });
    // The widget comes FIRST, with a text run after it. That order is what makes
    // this discriminating: with the OBJR last, appending the content kid and
    // then letting the untagObjects sweep drop the OBJR lands on the same array
    // as writing in place, and the assertion proves nothing.
    el.AddAnnotation(doc.Pages[0].Annotations[0]);
    const after = el.NextMcid(doc.Pages[0]);
    expect(kids(doc, el.Dict).length).toBe(2);

    flattenForm(doc);

    // The content kid replaces the OBJR in place, so the baked ink stays ahead
    // of the text run it preceded. Appending would put it behind.
    const k = kids(doc, el.Dict);
    expect(k).toEqual([after + 1, after]);
  });

  it('leaves an untagged document byte-identical', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });

    flattenForm(doc);

    expect(content(doc)).not.toContain('BDC');
    expect(doc.Pages[0].Dict.has('StructParents')).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flatten-struct.test.ts`
Expected: FAIL — four of the six new cases. `retypes the flattened element…` fails on `/S` still being `Form`; `swaps the OBJR…` fails because Task 1's `untagObjects` pruned the element outright, so `kids` is empty; `wraps the baked appearance…` finds no `BDC`; `keeps the baked content in the annotation reading-order slot` gets `[0]` not `[1, 0]`. `clears the annotation /ParentTree slot` and `leaves an untagged document byte-identical` already pass (Task 1 clears the key; an untagged document has no tag to write) — that is expected, they are guarding against regressions from here on.

- [ ] **Step 3: Implement `retagAsContent`**

In `src/structwrite.ts`, insert after `tagAnnotation` (after line 218):

```ts
/** Structure types that describe an *annotation* rather than the ink it draws.
 *  Once flatten has baked that ink into the page, neither is true any more:
 *  ISO 32000-1 Table 337 has /Form identify a widget annotation and a /Link
 *  contain a link annotation. /Figure carries the same /Alt requirement /Form
 *  does (structvalidate.ts, Matterhorn 13-004), so a document that validated
 *  before still validates; /Span requires nothing, so demoting a /Link cannot
 *  break one either.
 *
 *  Matched on the raw /S, never StandardType: a custom type role-mapped to
 *  /Form is a name the author chose deliberately, and retyping is already a
 *  judgment made on the caller's behalf. */
const FLATTENED_TYPE: ReadonlyMap<string, string> = new Map([
  ['Form', 'Figure'],
  ['Link', 'Span'],
]);

/**
 * Re-point a flattened annotation's tag at the page content that replaced it:
 * swap the OBJR naming `annot` for a marked-content kid in the *same* /K slot,
 * retype the element, and clear the annotation's /ParentTree key. Returns the
 * BDC tag and MCID for the caller to wrap its content in, or undefined when
 * there is nothing to re-point (the caller then writes its content unwrapped
 * and lets `untagObjects` drop the tag).
 *
 * The near-mirror of `tagAnnotation`, and the reason flatten does not simply
 * call `untagObjects` like removal does: removal destroys the annotation *and*
 * its ink, so dropping the tag loses nothing that still exists. Flatten keeps
 * the ink. Dropping the tag there throws away the /Alt and the reading-order
 * position of content still on the page, and prunes the element outright when
 * the OBJR was its only kid.
 */
export function retagAsContent(
  doc: Document, page: Page, annot: PdfDict,
): { tag: string; mcid: number } | undefined {
  const key = asNum(doc.resolve(annot.get('StructParent')));
  if (key === undefined) return undefined; // untagged: nothing to re-point
  const rootDict = doc.resolve(doc.catalog().get('StructTreeRoot'));
  if (!isDict(rootDict)) return undefined;

  // The ref, not just the dict: the page's MCID array is written in refs.
  const nums = parentTreeNums(doc, rootDict);
  let elemRef: PdfRef | undefined;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (asNum(doc.resolve(nums[i])) === key && isRef(nums[i + 1])) {
      elemRef = nums[i + 1] as PdfRef;
      break;
    }
  }
  if (elemRef === undefined) return undefined;
  const elem = doc.resolve(elemRef);
  if (!isDict(elem)) return undefined;

  // Where the OBJR sits in /K — the content kid takes that exact slot, so the
  // baked ink keeps the annotation's place in the reading order.
  const k = kArray(doc, elem);
  let at = -1;
  for (let i = 0; i < k.length && at < 0; i++) {
    const kid = doc.resolve(k[i]);
    if (!isDict(kid)) continue;
    const type = doc.resolve(kid.get('Type'));
    if (isName(type) && type.name === 'OBJR' && doc.resolve(kid.get('Obj')) === annot) at = i;
  }
  if (at < 0) return undefined;

  const s = doc.resolve(elem.get('S'));
  if (!isName(s)) return undefined;
  const tag = FLATTENED_TYPE.get(s.name) ?? s.name;
  if (tag !== s.name) elem.set('S', name(tag));

  const arr = pageMcidArray(doc, rootDict, page);
  const mcid = arr.length;
  arr.push(elemRef);

  // Same /Pg rule as appendContentKid: an integer MCID while the element's
  // content stays on one page, an MCR dict once a second page contributes.
  const pageRef = doc.pageRef(page.Number);
  const pg = elem.get('Pg');
  if (pg === undefined) {
    elem.set('Pg', pageRef);
    k[at] = mcid;
  } else if (isRef(pg) && pg.num === pageRef.num) {
    k[at] = mcid;
  } else {
    k[at] = new Map<string, PdfObject>([['Type', name('MCR')], ['Pg', pageRef], ['MCID', mcid]]);
  }

  clearParentTreeKeys(doc, rootDict, new Set([key]));
  annot.delete('StructParent');
  doc.markModified();
  return { tag, mcid };
}
```

`clearParentTreeKeys` is declared at line 234, below this insertion point, and `pageMcidArray` at 138 above it. Both are fine — these are hoisted function declarations.

- [ ] **Step 4: Wire it into the bake loop**

In `src/flatten.ts`, extend the import added in Task 1:

```ts
import { retagAsContent, untagObjects } from './structwrite.js';
```

Then in `flattenPageAnnots`, replace the single body line (currently line 69):

```ts
    body += `q ${ap.place.map(num).join(' ')} cm /${key} Do Q\n`;
```

with:

```ts
    // Flatten writes this content itself, so it can bracket its own bytes —
    // no regionOpSpan, no EditableContent, and flatten stays append-only.
    const tagged = retagAsContent(doc, page, annot);
    if (tagged) body += `/${tagged.tag} <</MCID ${tagged.mcid}>> BDC\n`;
    body += `q ${ap.place.map(num).join(' ')} cm /${key} Do Q\n`;
    if (tagged) body += 'EMC\n';
```

Leave the `untagObjects(doc, dead)` sweep from Task 1 exactly as it is. It is unconditional on purpose: for a retagged annotation the OBJR is already gone, so the sweep finds nothing, prunes nothing, and costs one idempotent key-clear — while a malformed document naming one annotation from two OBJRs still cannot leak.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/flatten-struct.test.ts test/flatten-annotations.test.ts test/flatten-form.test.ts test/flatten-api.test.ts test/struct-remove.test.ts`
Expected: PASS, all five files.

- [ ] **Step 6: Mutation checks**

Three separate checks — run each, confirm the named test goes red, then restore:

1. Change **both** `k[at] = mcid` lines in `retagAsContent` to `k.push(mcid)`. Expected red: `keeps the baked content in the annotation reading-order slot` (`expected [ 0, 1 ] to deeply equal [ 1, 0 ]`). This is the assertion the in-place invariant exists for.

   Two traps here, both hit during execution:
   - **Which branch.** The reading-order fixture calls `NextMcid` *after* `AddAnnotation`, so `/Pg` is already set by flatten time and the write goes through the `else if (isRef(pg) && …)` branch, not `pg === undefined`. Mutating only the first branch leaves this test green and reddens `swaps the OBJR…` instead. Mutate both.
   - **Do not `replace_all` on `k.push(mcid);` when restoring.** `appendContentKid` (`structwrite.ts:159`) has two identical `k.push(mcid);` lines; a blanket replace rewrites those too and the build dies on `at is not defined`. Restore the two lines inside `retagAsContent` specifically, then confirm with `git diff --stat src/structwrite.ts` — it must show insertions only, no deletions, since this task is purely additive to that file.
2. Change `if (tag !== s.name) elem.set('S', name(tag));` to a no-op (`// elem.set(…)`). Expected red: `retypes the flattened element from /Form to /Figure and keeps its /Alt`.
3. Change `arr.push(elemRef)` to `arr.push(0)`. Expected red: `swaps the OBJR for a marked-content kid wired to the page`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/structwrite.ts src/flatten.ts test/flatten-struct.test.ts
git commit -m "$(cat <<'EOF'
fix(flatten): re-point a flattened annotation's OBJR at the baked content (4dqa)

Flatten keeps the ink, so the tag follows it: the OBJR becomes a marked-content
kid in the same /K slot, and /Form retypes to /Figure (/Link to /Span) since
neither describes an annotation any more.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Do not throw on a /Kids-based /ParentTree

`parentTreeNums` throws `UnsupportedFeatureError` on a `/Kids`-based number tree — correct for *authoring*, wrong here. Flatten must not fail on a tree shape we merely decline to author into; it should fall back to dropping the tag, which `untagObjects` already does safely (`clearParentTreeKeys` leaves a `/Kids` tree alone by design).

**Files:**
- Modify: `src/structwrite.ts` (`retagAsContent`, the lookup added in Task 2)
- Test: `test/flatten-struct.test.ts`

**Interfaces:**
- Consumes: `retagAsContent` from Task 2 (signature unchanged).
- Produces: nothing new; `parentTreeLookup` stays file-private.

- [ ] **Step 1: Write the failing test**

Append inside the same `describe`:

```ts
  it('falls back to dropping the tag on a /Kids-based /ParentTree', () => {
    const { doc } = taggedField();
    // Rehang the flat /Nums under a /Kids leaf — a shape we read but decline to
    // author into. Authoring throws there, and flatten must not.
    const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;
    const pt = doc.resolve(root.get('ParentTree')) as PdfDict;
    const nums = doc.resolve(pt.get('Nums')) as PdfObject[];
    const leaf: PdfDict = new Map<string, PdfObject>([
      ['Limits', [0, 999]], ['Nums', nums],
    ]);
    pt.delete('Nums');
    pt.set('Kids', [doc.allocObject(leaf)]);

    expect(() => flattenForm(doc)).not.toThrow();

    expect(content(doc)).not.toContain('BDC');
    expect(subtypeCount(Document.Open(doc.Save()), 'Widget')).toBe(0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flatten-struct.test.ts -t 'Kids-based'`
Expected: FAIL — `UnsupportedFeatureError: authoring into a /Kids-based /ParentTree is not supported`, thrown from `parentTreeNums` via `retagAsContent`.

- [ ] **Step 3: Replace the lookup**

In `src/structwrite.ts`, add above `retagAsContent`:

```ts
/** The element ref the /ParentTree maps `key` to, or undefined.
 *
 *  Reads /Nums directly rather than going through `parentTreeNums`, which
 *  throws on a /Kids-based tree. That throw protects *authoring*; flatten must
 *  not fail on a tree shape we merely decline to author into, so an unreadable
 *  tree returns undefined and the caller drops the tag instead. Same principle
 *  as `clearParentTreeKeys`, which leaves a /Kids tree alone rather than
 *  failing removal. */
function parentTreeLookup(doc: Document, rootDict: PdfDict, key: number): PdfRef | undefined {
  const pt = doc.resolve(rootDict.get('ParentTree'));
  if (!isDict(pt)) return undefined;
  const nums = doc.resolve(pt.get('Nums'));
  if (!isArray(nums)) return undefined;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (asNum(doc.resolve(nums[i])) === key && isRef(nums[i + 1])) return nums[i + 1] as PdfRef;
  }
  return undefined;
}
```

Then in `retagAsContent`, replace the inline scan:

```ts
  // The ref, not just the dict: the page's MCID array is written in refs.
  const nums = parentTreeNums(doc, rootDict);
  let elemRef: PdfRef | undefined;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (asNum(doc.resolve(nums[i])) === key && isRef(nums[i + 1])) {
      elemRef = nums[i + 1] as PdfRef;
      break;
    }
  }
  if (elemRef === undefined) return undefined;
```

with:

```ts
  // The ref, not just the dict: the page's MCID array is written in refs.
  const elemRef = parentTreeLookup(doc, rootDict, key);
  if (elemRef === undefined) return undefined;
```

The later `pageMcidArray` call is now unreachable on a `/Kids` tree, because the lookup returns `undefined` first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flatten-struct.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Mutation check**

Change `parentTreeLookup`'s body back to `const nums = parentTreeNums(doc, rootDict);` plus the scan. Expected red: `falls back to dropping the tag on a /Kids-based /ParentTree`. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/structwrite.ts test/flatten-struct.test.ts
git commit -m "$(cat <<'EOF'
fix(flatten): drop the tag rather than throw on a /Kids-based /ParentTree (4dqa)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The popup path, docs, and close-out

An orphaned `/Popup` is *removed*, not baked — there is no content for its tag to point at, so it takes the removal path by construction. Prove it, then document the invariant and run the gates.

**Files:**
- Test: `test/flatten-struct.test.ts`
- Modify: `CLAUDE.md` (the struct.ts bullet)

**Interfaces:**
- Consumes: `flattenAnnotations(doc, page): number` from `src/flatten.ts:91`; `buildFlattenPopupTarget()` from `test/helpers/build-flatten-target.ts:58`.
- Produces: nothing.

- [ ] **Step 1: Write the regression guard**

Not a red-first case: Tasks 1-3 already implement this path. It is here because no other case exercises `flattenAnnotations` (rather than `flattenForm`) or the popup drop, and Step 3 is what proves it load-bearing.

Extend the imports at the top of `test/flatten-struct.test.ts`:

```ts
import { flattenAnnotations, flattenForm } from '../src/flatten.js';
import { buildFlattenPopupTarget } from './helpers/build-flatten-target.js';
```

Then append inside the same `describe`:

```ts
  it('untags an orphaned /Popup and retags the markup that displaced it', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    const page = doc.Pages[0];
    // The fixture mirrors what a viewer writes, which does not include /P;
    // tagAnnotation derives the page from it.
    for (const a of page.Annotations) a.Dict.set('P', doc.pageRef(1));
    const root = doc.CreateStructTree();
    const figure = root.Append('Figure', { alt: 'green box' });
    const note = root.Append('Note');
    figure.AddAnnotation(page.Annotations[0]); // /Square markup, gets baked
    note.AddAnnotation(page.Annotations[1]);   // /Popup, dropped with its parent

    flattenAnnotations(doc, page);

    // The markup's ink is now page content, so its tag follows it.
    expect(objrs(doc, figure.Dict).length).toBe(0);
    expect(kids(doc, figure.Dict).map((k) => typeof k)).toEqual(['number']);
    // The popup's ink is gone, so its tag goes with it — and the element it
    // emptied is pruned.
    expect(kids(doc, doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict)
      .map((k) => doc.resolve(k))).not.toContain(note.Dict);

    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).not.toContain('/Subtype /Popup');
    expect(saved).not.toContain('/Subtype /Square');
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/flatten-struct.test.ts -t 'orphaned'`
Expected: PASS. Do not treat that green as evidence — Step 3 is the evidence.

- [ ] **Step 3: Mutation check**

Two checks — run each, confirm red, restore:

1. In `src/flatten.ts`, stop adding dropped popups to `dead` (change the popup branch to `continue` without the `dead.add(d)`). Expected red: this test, on the `note.Dict` pruning assertion — it fires before the `/Subtype /Popup` one, and either proves the point.
2. In `src/flatten.ts`, change `const dead = new Set(baked);` to `const dead = new Set<PdfDict>();`. Expected red: **`falls back to dropping the tag on a /Kids-based /ParentTree`** (`expected 1 to be 0`) — *not* this test. Run the whole file, not `-t 'orphaned'`.

   The seed looks redundant from the popup test's angle and is not: that test's markup is successfully *retagged*, so its OBJR is already gone and `dead` never has to name it. The seed exists for the case where retagging **fails** and an OBJR survives, which is exactly what the `/Kids` fixture builds. If a future change makes the `/Kids` case unreachable, this seed loses its only guard — re-derive one before deleting it.

- [ ] **Step 4: Update CLAUDE.md**

In the `struct.ts` bullet, after the existing paragraph ending `exactly as a leftover /AcroForm /CO entry did.`, add:

```markdown
  **Invariant:** *flattening* an annotation must **retag** it, not untag it
  (`retagAsContent`, called by `flatten.ts`). Removal destroys the annotation
  and its ink together, so dropping the tag loses nothing that still exists;
  flatten keeps the ink as page content, so the `/OBJR` becomes a
  marked-content kid in the *same* `/K` slot — appending instead moves the
  baked ink behind whatever used to precede it. `/Form` retypes to `/Figure`
  and `/Link` to `/Span`, since neither describes an annotation any more. When
  the tag cannot be rewritten (a `/Kids`-based `/ParentTree`, a `/StructParent`
  naming no element), fall back to dropping it — flatten must never throw on a
  tree shape we merely decline to author into.
```

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: the whole suite green. Pay attention to `structvalidate`, `structpreserve`, `flatten-*` and `pdfua*` — those are the suites a structure-tree edit can disturb.

- [ ] **Step 6: Commit**

```bash
git add test/flatten-struct.test.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
test(flatten): cover the orphaned-popup untag path; document the retag invariant (4dqa)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-4dqa
git add -A .beads
git commit -m "$(cat <<'EOF'
chore(bd): close 4dqa

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Work is not complete until `git push` succeeds (CLAUDE.md session-completion protocol).
