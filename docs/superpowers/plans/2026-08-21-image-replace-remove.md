# Image replace and remove Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ImageInfo` two methods — `Replace(data)` swaps an embedded image's picture while keeping its placement, `Remove()` drops it from the page it was enumerated from — both scoped to that page, with the resource entry cleaned up.

**Architecture:** Two pure extractions first (`imageCutSet` → `content.ts`, `sanitizeResources` → a new `resprune.ts`) so that a new `imageedit.ts` reachable from `ImageInfo` never imports `redact.ts`, which imports `image.ts` for its decoder and would close a cycle. `imageedit.ts` then holds one scope walk (`imageScopes`) shared by both operations, plus `replaceImage` (build fresh, repoint resource keys copy-on-write) and `removeImage` (cut the draw ops through `EditableContent`, delete the key, optionally escalate to the full prune).

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest, zero runtime dependencies beyond `node:` built-ins.

**Spec:** `docs/superpowers/specs/2026-08-21-image-replace-remove-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **`imageedit.ts` must import neither `redact.ts` nor `image.ts`.** It takes `doc`, `page` and the target `PdfStream` as plain arguments. `Document` and `Page` are `import type` only.
- **Public error types** are `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (`src/errors.ts`). A "not found in the resource tree" condition uses `RangeError`, matching `editcontent.ts`'s existing `XObject /${nm} not found`.
- **Quality gates:** `npm run typecheck` and `npm test` must both be green before an issue is closed. Target one file with `npx vitest run test/<name>.test.ts`.
- **Changelog:** user-visible changes go under `## [Unreleased]` in `CHANGELOG.md` in the same commit. Internal refactors and test-only work do **not** get an entry.
- **Issue tracking:** `bd`, never TodoWrite or markdown TODO lists. This work is `aspose-pdf-foss-for-ts-10u9.4`.

## File Structure

| File | Responsibility |
|---|---|
| `src/content.ts` (modify) | Gains `imageCutSet` — pure `ContentOp[]` arithmetic for the `q … cm … Do … Q` group cut. Leaf module (`lexer.ts`, `types.ts`, `serialize.ts` only). |
| `src/resprune.ts` (create) | `NAME_OP`, `referencedNames`, `pruneResources`, `mergeRefs`, `sanitizeResources` — orphaned-resource pruning, moved verbatim out of `redact.ts`. Leaf; `Document`/`Page`/`EditableContent` type-only. |
| `src/redact.ts` (modify) | Loses both blocks; imports `imageCutSet` from `content.js` and re-exports `sanitizeResources` from `resprune.js` so its existing public path is unchanged. `dropDraws` deleted. |
| `src/editcontent.ts` (modify) | Gains `ownXObjectResources(path)`: force the COW, return the owned `/Resources`, creating one when the form has none. |
| `src/imageedit.ts` (create) | `ImageScope`, `imageScopes`, `ReplaceImageOptions`, `RemoveImageOptions`, `replaceImage`, `removeImage`. |
| `src/image.ts` (modify) | `ImageInfo` gains a `page?: Page` field and the two delegating methods; `collectImages` gains a `page` parameter. |
| `src/page.ts` (modify) | `get Images()` passes `this` to `collectImages`. |
| `src/index.ts` (modify) | Exports the two option types. |
| `test/helpers/build-image-pdf.ts` (modify) | Exports its private `Obj` type and `emitObjs` assembler so one assembler serves both helper files. |
| `test/helpers/build-image-edit-pdf.ts` (create) | Three fixtures: a shared image across two pages, an image nested in a form shared by two pages, and a one-page image drawn twice beside an unreferenced `/ExtGState`. |
| `test/content-cutset.test.ts` (create) | Direct unit tests for `imageCutSet`, including the `gs` limitation. |
| `test/editcontent-own-resources.test.ts` (create) | `ownXObjectResources` COW behaviour. |
| `test/image-edit.test.ts` (create) | `imageScopes`, `Replace`, `Remove`. |

---

### Task 1: Move `imageCutSet` to `content.ts`

`imageCutSet` decides which op indices a removed image draw takes with it. It is
pure `ContentOp[]` arithmetic with no `Document` knowledge, and it has to become
reachable from a module that must not import `redact.ts`. It has never been
tested directly — only through redaction — so this task adds that test.

**Files:**
- Modify: `src/content.ts` (append after `serializeContentStream`)
- Modify: `src/redact.ts:347-364` (delete `imageCutSet` and `dropDraws`, import the former)
- Test: `test/content-cutset.test.ts` (create)

**Interfaces:**
- Consumes: `ContentOp` from `src/content.ts` (`{ readonly operator: string; readonly operands: PdfObject[]; readonly inlineImage?: {...} }`).
- Produces: `export function imageCutSet(ops: readonly ContentOp[], remove: Set<number>): Set<number>` from `src/content.js`. Tasks 6 uses it.

- [ ] **Step 1: Write the failing test**

Create `test/content-cutset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseContentStream, imageCutSet } from '../src/content.js';
import { isName } from '../src/types.js';

const ops = (s: string) => parseContentStream(new TextEncoder().encode(s));

/** Index of the nth `Do` op naming `nm` (0-based n). */
function doIndex(list: ReturnType<typeof ops>, nm: string, n = 0): number {
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i].operands[0];
    if (list[i].operator === 'Do' && isName(a) && a.name === nm) {
      if (seen === n) return i;
      seen++;
    }
  }
  throw new Error(`no /${nm} Do #${n}`);
}

describe('imageCutSet', () => {
  it('takes the whole q/cm/Do/Q group', () => {
    const list = ops('q 10 0 0 10 0 0 cm /Im0 Do Q');
    // [q, cm, Do, Q]
    expect(list.map((o) => o.operator)).toEqual(['q', 'cm', 'Do', 'Q']);
    expect([...imageCutSet(list, new Set([doIndex(list, 'Im0')]))].sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3]);
  });

  it('walks back over a chain of cm ops', () => {
    const list = ops('q 2 0 0 2 0 0 cm 5 0 0 5 0 0 cm /Im0 Do Q');
    expect([...imageCutSet(list, new Set([doIndex(list, 'Im0')]))].sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 4]);
  });

  it('cuts the Do alone when there is no enclosing q/Q', () => {
    const list = ops('/Im0 Do');
    expect([...imageCutSet(list, new Set([0]))]).toEqual([0]);
  });

  it('cuts the Do alone when the Q does not immediately follow', () => {
    const list = ops('q 1 0 0 1 0 0 cm /Im0 Do /Im1 Do Q');
    const i = doIndex(list, 'Im0');
    expect([...imageCutSet(list, new Set([i]))]).toEqual([i]);
  });

  // Characterization, not an endorsement: the walk-back skips `cm` and nothing
  // else, so any other op between the `q` and the `Do` -- `gs` is the common one
  // -- defeats the group match and only the Do is cut. The leftover
  // `q /GS0 gs ... cm Q` is inert (Q restores the state it set), so this is a
  // cosmetic residue rather than a correctness hole. Tracked separately.
  it('cuts the Do alone when a gs sits between the q and the cm', () => {
    const list = ops('q /GS0 gs 10 0 0 10 0 0 cm /Im0 Do Q');
    const i = doIndex(list, 'Im0');
    expect([...imageCutSet(list, new Set([i]))]).toEqual([i]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/content-cutset.test.ts`
Expected: FAIL — `imageCutSet` is not exported from `../src/content.js` (TypeScript/import error).

- [ ] **Step 3: Move the function**

Append to `src/content.ts` (after `serializeContentStream`):

```ts
/** Indices an image-draw removal takes with it: the enclosing `q [cm…] Do Q`
 *  group where there is one, otherwise the `Do` alone.
 *
 *  **Invariant:** one owner. Redaction (`removeImagesUnder`) and
 *  `imageedit.ts`'s `removeImage` both cut image draws, and two copies of this
 *  rule is how one of them comes to leave a stranded `q` the other takes.
 *
 *  The walk-back skips `cm` and nothing else, so a `gs` (or any other op)
 *  between the `q` and the `Do` degrades the cut to the `Do` alone. What is left
 *  is inert — the `Q` restores whatever the `q` block set — so this is residue,
 *  not leakage. `test/content-cutset.test.ts` pins it as current behaviour. */
export function imageCutSet(ops: readonly ContentOp[], remove: Set<number>): Set<number> {
  const cut = new Set<number>();
  for (const i of remove) {
    let p = i - 1;
    while (p >= 0 && ops[p].operator === 'cm') p--;
    const wrapped = p >= 0 && ops[p].operator === 'q'
      && i + 1 < ops.length && ops[i + 1].operator === 'Q';
    if (wrapped) for (let k = p; k <= i + 1; k++) cut.add(k);
    else cut.add(i);
  }
  return cut;
}
```

In `src/redact.ts`, delete both the `imageCutSet` function and the `dropDraws`
function beneath it (`dropDraws` has no caller in `src/`, `test/` or `scripts/`
— confirm with the grep in step 4 before deleting). Add `imageCutSet` to the
existing `content.js` import, which currently reads:

```ts
import { ContentOp } from './content.js';
```

and becomes:

```ts
import { ContentOp, imageCutSet } from './content.js';
```

- [ ] **Step 4: Confirm `dropDraws` really was dead, then run the tests**

Run: `grep -rn "dropDraws" src/ test/ scripts/`
Expected: no output.

Run: `npx vitest run test/content-cutset.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Prove the redaction suite is the fence for the move**

Run: `npx vitest run test/redact.test.ts test/redact-image.test.ts test/redact-sanitize.test.ts`
Expected: PASS.

Now temporarily break the moved function — in `src/content.ts`, change
`else cut.add(i);` to `else { /* nothing */ }` — and re-run the same command.
Expected: FAIL. Restore the line and confirm green again. This is the evidence
that the redaction suite covers the move; a first-run green is not.

- [ ] **Step 6: Commit**

```bash
git add src/content.ts src/redact.ts test/content-cutset.test.ts
git commit -m "refactor(10u9.4): move imageCutSet to content.ts, drop dead dropDraws

The group-cut rule becomes reachable from a module that must not import
redact.ts. Adds the direct unit test it never had, including the gs case
where the walk-back degrades to cutting the Do alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract `sanitizeResources` into `src/resprune.ts`

Same reason: `removeImage`'s `sanitize` option needs this function, and reaching
it through `redact.ts` closes a cycle back to `image.ts`. A verbatim move plus a
re-export, so `redact.ts`'s existing import path keeps working.

**Files:**
- Create: `src/resprune.ts`
- Modify: `src/redact.ts:290-345` (delete the moved block, import + re-export)
- Test: `test/redact-sanitize.test.ts` (add one case asserting the new path)

**Interfaces:**
- Consumes: `EditableContent` (methods `streamCount`, `topOps(i)`, `editedXObjectPaths()`, `xobjectResources(path)`), `ensureOwnResources`/`ensureOwnSubdict` from `pagecontent.js`, `ContentOp` from `content.js`.
- Produces: `export function sanitizeResources(doc: Document, page: Page, ec: EditableContent): void` from `src/resprune.js`, re-exported from `src/redact.js`. Task 6 imports it from `resprune.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/redact-sanitize.test.ts` (add the import at the top of the file):

```ts
import { sanitizeResources as sanitizeFromOwner } from '../src/resprune.js';
```

```ts
describe('resprune.ts — the module that owns the prune', () => {
  it('is the same function redact.ts re-exports', () => {
    expect(sanitizeFromOwner).toBe(sanitizeResources);
  });

  it('prunes through its own import path', () => {
    const doc = Document.Open(buildTwoFontPage('BT /F1 10 Tf 50 100 Td (hi) Tj ET'));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    sanitizeFromOwner(doc, page, ec);
    ec.commit();
    expect(resourceKeys(doc, 'Font').sort()).toEqual(['F1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/redact-sanitize.test.ts`
Expected: FAIL — cannot resolve `../src/resprune.js`.

- [ ] **Step 3: Create the module and thin `redact.ts`**

Create `src/resprune.ts`:

```ts
// Orphaned-resource pruning: after content-stream surgery removes ops, delete
// the /Resources entries nothing references any more, so the removed text or
// images cannot be recovered from what is left behind. Its own module (rather
// than part of redact.ts) because redact.ts imports image.ts for its decoder,
// and imageedit.ts -- which is reachable from ImageInfo -- needs this function.
//
// **Invariant:** ONE owner for the prune. Redaction and image removal must not
// disagree about what "unreferenced" means.

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { EditableContent } from './editcontent.js';
import type { ContentOp } from './content.js';
import { PdfDict, isDict, isName } from './types.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';

/** Resource categories pruned by sanitization, keyed by the operator (and its
 *  first operand) that references a name in that /Resources sub-dict. */
const NAME_OP: Record<string, string> = { Tf: 'Font', Do: 'XObject', gs: 'ExtGState' };

/** Names still referenced by `ops`, bucketed by resource sub-dict. */
function referencedNames(ops: readonly ContentOp[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const op of ops) {
    const key = NAME_OP[op.operator];
    const a = op.operands[0];
    if (key && isName(a)) {
      let s = out.get(key);
      if (!s) { s = new Set(); out.set(key, s); }
      s.add(a.name);
    }
  }
  return out;
}

/** Delete entries of each prunable sub-dict of `resources` not in `refs`. The
 *  sub-dict is copy-on-written before mutation so shared dicts stay intact. */
function pruneResources(doc: Document, resources: PdfDict, refs: Map<string, Set<string>>): void {
  for (const key of Object.values(NAME_OP)) {
    const sub = doc.resolve(resources.get(key));
    if (!isDict(sub)) continue;
    const keep = refs.get(key) ?? new Set<string>();
    const owned = ensureOwnSubdict(doc, resources, key);
    for (const nm of [...owned.keys()]) if (!keep.has(nm)) owned.delete(nm);
  }
}

function mergeRefs(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [k, s] of from) {
    let t = into.get(k);
    if (!t) { t = new Set(); into.set(k, t); }
    for (const v of s) t.add(v);
  }
}

/** Prune resources orphaned by content-stream surgery from the page and every
 *  edited Form XObject, so removed text/images cannot be recovered from
 *  leftover resources (newly-unreachable objects are swept by `Save`). Run
 *  before `ec.commit()`. */
export function sanitizeResources(doc: Document, page: Page, ec: EditableContent): void {
  // Page scope: referenced names are the union across all top content streams.
  const pageRefs = new Map<string, Set<string>>();
  for (let i = 0; i < ec.streamCount; i++) mergeRefs(pageRefs, referencedNames(ec.topOps(i)));
  pruneResources(doc, ensureOwnResources(doc, page), pageRefs);

  // Each edited Form XObject: prune its own /Resources against its own ops.
  for (const path of ec.editedXObjectPaths()) {
    const res = ec.xobjectResources(path);
    if (res) pruneResources(doc, res, referencedNames(ec.xobjectOps(path)));
  }
}
```

> Copy the bodies of `referencedNames`, `pruneResources`, `mergeRefs` and
> `sanitizeResources` from `src/redact.ts` verbatim rather than retyping them —
> the text above is what they currently say, but the file is authoritative.

In `src/redact.ts`, delete `NAME_OP`, `referencedNames`, `pruneResources`,
`sanitizeResources` and `mergeRefs`, and add:

```ts
// Re-exported so `redact.js` stays the import path it has always been for this
// function; `resprune.ts` is the owner (see the module header there).
export { sanitizeResources } from './resprune.js';
```

No import becomes unused: `ensureOwnResources`, `ensureOwnSubdict`, `isName`
and `isDict` all still have callers in the rest of `redact.ts` (verified — 4, 1,
2 and 1 remaining uses respectively). Leave the import list alone.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/redact-sanitize.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

Run: `npm test`
Expected: PASS — this is a verbatim move, so nothing else may shift.

- [ ] **Step 5: Commit**

```bash
git add src/resprune.ts src/redact.ts test/redact-sanitize.test.ts
git commit -m "refactor(10u9.4): extract sanitizeResources into resprune.ts

redact.ts imports image.ts for its decoder, so a module reachable from
ImageInfo cannot reach the prune through redact.ts. Verbatim move plus a
re-export, so redact.js stays the path it has always been.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `EditableContent.ownXObjectResources`

`replaceImage` must copy-on-write a nested Form XObject's `/Resources` *without*
rewriting its content stream. Today the only way to trigger that COW is to call
`xobjectOps(path)` for its side effect and discard the result, and
`xobjectResources(path)` returns `undefined` until it has happened — and returns
`undefined` forever for a form that has no `/Resources` of its own.

**Files:**
- Modify: `src/editcontent.ts` (after `xobjectResources`, around line 82)
- Test: `test/editcontent-own-resources.test.ts` (create)

**Interfaces:**
- Consumes: the private `cowXObject(path)` already in the class.
- Produces: `ownXObjectResources(path: readonly string[]): PdfDict` on `EditableContent`. Tasks 5 and 6 call it.

- [ ] **Step 1: Write the failing test**

Create `test/editcontent-own-resources.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { buildImagePdf } from './helpers/build-image-pdf.js';
import { isDict, isRef, isStream, PdfDict, PdfObject } from '../src/types.js';

/** The page's /Resources /XObject entry for `nm`, raw (undereferenced). */
function pageXObjectEntry(doc: Document, nm: string): PdfObject | undefined {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const x = doc.resolve((res as PdfDict).get('XObject'));
  return isDict(x) ? (x as PdfDict).get(nm) : undefined;
}

describe('EditableContent.ownXObjectResources', () => {
  // buildImagePdf's /Fm0 is a Form XObject whose own /Resources holds /ImF.
  it('copy-on-writes the form and returns its own resources', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const before = pageXObjectEntry(doc, 'Fm0');
    expect(isRef(before)).toBe(true);

    const ec = new EditableContent(doc, doc.Pages[0]);
    const res = ec.ownXObjectResources(['Fm0']);

    expect(isDict(res)).toBe(true);
    expect(res.has('XObject')).toBe(true);
    // The page now points at a clone, not the original object.
    const after = pageXObjectEntry(doc, 'Fm0');
    expect(isRef(after)).toBe(true);
    expect(after).not.toEqual(before);
  });

  it('does not mutate the original form object', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const original = doc.resolve(pageXObjectEntry(doc, 'Fm0')!);
    expect(isStream(original)).toBe(true);
    const originalRes = isStream(original)
      ? doc.resolve(original.dict.get('Resources')) : null;
    expect(isDict(originalRes)).toBe(true);

    const ec = new EditableContent(doc, doc.Pages[0]);
    ec.ownXObjectResources(['Fm0']).set('Marker', 1);

    expect((originalRes as PdfDict).has('Marker')).toBe(false);
  });

  it('is idempotent — a second call returns the same dict', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.ownXObjectResources(['Fm0'])).toBe(ec.ownXObjectResources(['Fm0']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editcontent-own-resources.test.ts`
Expected: FAIL — `ec.ownXObjectResources is not a function`.

- [ ] **Step 3: Add the method**

In `src/editcontent.ts`, immediately after `xobjectResources`:

```ts
  /** Force the copy-on-write of the Form XObject at `path` and return its own
   *  /Resources, creating an empty one when the form has none.
   *
   *  `xobjectResources` reports what a COW'd scope already has and returns
   *  undefined otherwise; this is the write side. A caller that needs a form's
   *  resources copy-on-written WITHOUT rewriting its content stream (repointing
   *  an /XObject entry, say) has no other way to trigger the COW than calling
   *  `xobjectOps` for its side effect. The scope is left NOT dirty, so `commit`
   *  skips it -- which is correct, because `cowXObject` has already repointed
   *  the parent entry at the clone by then. */
  ownXObjectResources(path: readonly string[]): PdfDict {
    const e = this.cowXObject(path);
    const r = this.doc.resolve(e.dict.get('Resources'));
    if (isDict(r)) return r;
    const fresh: PdfDict = new Map();
    e.dict.set('Resources', fresh);
    return fresh;
  }
```

`isDict` and `PdfDict` are already imported by `editcontent.ts`; confirm with
`grep -n "^import" src/editcontent.ts` and add them if not.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/editcontent-own-resources.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/editcontent.ts test/editcontent-own-resources.test.ts
git commit -m "feat(10u9.4): EditableContent.ownXObjectResources

The write side of xobjectResources: force a form's copy-on-write and hand
back its own /Resources, creating one when it has none. Needed to repoint
an /XObject entry inside a form without rewriting its content stream.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Fixtures, the scope walk, and binding `ImageInfo` to its page

`imageScopes` is the one walk both operations share: given a page and an image
stream, where in that page's resource tree does the stream sit? It matches on
**stream identity**, never on `ImageInfo.Name` — `collectImages` descends into
forms, so two forms may each hold an `Im0`, and one stream may be registered
under two keys.

**Files:**
- Modify: `test/helpers/build-image-pdf.ts` (export `Obj` and `emitObjs`)
- Create: `test/helpers/build-image-edit-pdf.ts`
- Create: `src/imageedit.ts`
- Modify: `src/image.ts` (`ImageInfo` constructor, `collectImages` signature)
- Modify: `src/page.ts:390-392` (`get Images`)
- Test: `test/image-edit.test.ts` (create — scope-walk cases only)

**Interfaces:**
- Consumes: `Document.resolve`, `Page.Resources`, `isDict`/`isStream`/`isName` from `types.js`.
- Produces:
  - `export interface ImageScope { readonly path: string[]; readonly key: string }`
  - `export function imageScopes(doc: Document, page: Page, target: PdfStream): ImageScope[]`
  - `collectImages(doc: Document, resources: PdfDict | undefined, page?: Page): ImageInfo[]`
  - `new ImageInfo(doc, Name, stream, page?)`
  - Test helpers `buildSharedImagePdf()`, `buildFormImagePdf()`, `buildTwiceDrawnImagePdf()`, each `(): Uint8Array`.

- [ ] **Step 1: Export the shared assembler from `build-image-pdf.ts`**

In `test/helpers/build-image-pdf.ts`, change line 5 and the `emitObjs`
declaration to be exported:

```ts
export type Obj = string | { dict: string; raw: Uint8Array };
```

```ts
export function emitObjs(objs: Obj[], maxObj: number): Uint8Array {
```

Nothing else in that file changes — one assembler, not a fourth copy.

- [ ] **Step 2: Write the fixtures**

Create `test/helpers/build-image-edit-pdf.ts`:

```ts
import { deflateSync } from 'node:zlib';
import { emitObjs, type Obj } from './build-image-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A 2x2 DeviceRGB 8bpc Flate image's raw (deflated) bytes. */
function rgb2x2(): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(
    Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))));
}

const IMAGE_DICT = (len: number) =>
  `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB `
  + `/BitsPerComponent 8 /Filter /FlateDecode /Length ${len} >>`;

/** Two pages, each drawing the SAME image object (obj 6) as its own /Im0.
 *  The vehicle for the per-page copy-on-write rules. */
export function buildSharedImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const c1 = enc('q 80 0 0 40 10 10 cm /Im0 Do Q');
  const c2 = enc('q 60 0 0 30 20 20 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 6 0 R >> >> /Contents 7 0 R >>`;
  objs[5] = { dict: `<< /Length ${c1.length} >>`, raw: c1 };
  objs[6] = { dict: IMAGE_DICT(raw.length), raw };
  objs[7] = { dict: `<< /Length ${c2.length} >>`, raw: c2 };
  return emitObjs(objs, 7);
}

/** Two pages, each drawing the SAME Form XObject (obj 6), whose own resources
 *  hold the image (obj 7) as /ImF and whose content actually draws it. The
 *  vehicle for nested-scope removal and form copy-on-write. */
export function buildFormImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const form = enc('q 1 0 0 1 0 0 cm /ImF Do Q');
  const c1 = enc('q 100 0 0 100 0 0 cm /Fm0 Do Q');
  const c2 = enc('q 50 0 0 50 20 20 cm /Fm0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 8 0 R >>`;
  objs[5] = { dict: `<< /Length ${c1.length} >>`, raw: c1 };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] `
      + `/Resources << /XObject << /ImF 7 0 R >> >> /Length ${form.length} >>`,
    raw: form,
  };
  objs[7] = { dict: IMAGE_DICT(raw.length), raw };
  objs[8] = { dict: `<< /Length ${c2.length} >>`, raw: c2 };
  return emitObjs(objs, 8);
}

/** One page drawing /Im0 twice, with an /ExtGState /GS0 that is DECLARED in the
 *  page resources and referenced by no operator. That unreferenced entry is what
 *  separates a targeted Remove from a sanitizing one -- the image's own entry
 *  goes either way, and only the full prune takes /GS0 as well. */
export function buildTwiceDrawnImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const content = enc('q 80 0 0 40 10 10 cm /Im0 Do Q q 60 0 0 30 20 120 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> `
    + `/ExtGState << /GS0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: IMAGE_DICT(raw.length), raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = `<< /Type /ExtGState /ca 0.5 /CA 0.5 >>`;
  return emitObjs(objs, 6);
}
```

- [ ] **Step 3: Write the failing test**

Create `test/image-edit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { imageScopes } from '../src/imageedit.js';
import { isDict, PdfDict } from '../src/types.js';
import { buildImagePdf } from './helpers/build-image-pdf.js';
import {
  buildSharedImagePdf, buildFormImagePdf, buildTwiceDrawnImagePdf,
} from './helpers/build-image-edit-pdf.js';

/** The page's own /Resources /XObject dict, resolved. */
function xobjectDict(doc: Document, pageIndex = 0): PdfDict {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no /Resources');
  const x = doc.resolve(res.get('XObject'));
  if (!isDict(x)) throw new Error('no /XObject');
  return x;
}

describe('imageScopes', () => {
  it('finds a page-level image', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const page = doc.Pages[0];
    const img = page.Images.find((i) => i.Name === 'Im0')!;
    expect(imageScopes(doc, page, img.Stream)).toEqual([{ path: [], key: 'Im0' }]);
  });

  it('finds an image nested in a Form XObject, with the form path', () => {
    const doc = Document.Open(buildFormImagePdf());
    const page = doc.Pages[0];
    const img = page.Images.find((i) => i.Name === 'ImF')!;
    expect(imageScopes(doc, page, img.Stream)).toEqual([{ path: ['Fm0'], key: 'ImF' }]);
  });

  it('matches on stream identity, not on the resource name', () => {
    // buildImagePdf's page holds Im0, Dct0, Fm0, Msk0, Jb0; ImF lives in Fm0.
    const doc = Document.Open(buildImagePdf().bytes);
    const page = doc.Pages[0];
    const im0 = page.Images.find((i) => i.Name === 'Im0')!;
    const imf = page.Images.find((i) => i.Name === 'ImF')!;
    expect(imageScopes(doc, page, im0.Stream)).toEqual([{ path: [], key: 'Im0' }]);
    expect(imageScopes(doc, page, imf.Stream)).toEqual([{ path: ['Fm0'], key: 'ImF' }]);
  });

  it('returns every key one stream is registered under', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const page = doc.Pages[0];
    const img = page.Images[0];
    // Register the same object a second time under another name.
    const xobj = xobjectDict(doc);
    xobj.set('Im9', xobj.get('Im0')!);
    expect(imageScopes(doc, page, img.Stream).map((s) => s.key).sort())
      .toEqual(['Im0', 'Im9']);
  });

  it('returns [] for a stream the page does not reference', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const other = Document.Open(buildFormImagePdf());
    const foreign = other.Pages[0].Images[0].Stream;
    expect(imageScopes(doc, doc.Pages[0], foreign)).toEqual([]);
  });
});

// Un-skipped in Task 6, which is what adds Remove.
describe.skip('ImageInfo is bound to the page it was enumerated from', () => {
  it('page.Images hands back handles that know their page', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    // Not directly observable, so assert through the behaviour it enables:
    // a handle from page.Images can be removed, one built by hand cannot.
    expect(() => doc.Pages[0].Images[0].Remove()).not.toThrow();
  });
});
```

> The last `describe` is written `describe.skip` because `Remove` does not exist
> until Task 6, which un-skips it. Everything above it must pass at the end of
> this task.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/image-edit.test.ts`
Expected: FAIL — cannot resolve `../src/imageedit.js`.

- [ ] **Step 5: Create `src/imageedit.ts` with the scope walk**

```ts
// Editing an embedded image in place: where in a page's resource tree an image
// XObject sits, and the replace/remove operations built on that. Object-graph
// and content-stream work only -- no decoding, no rasterizing.
//
// **Invariant:** this module imports neither redact.ts nor image.ts. redact.ts
// imports image.ts for its decoder, so either edge would close a cycle back to
// ImageInfo, whose methods delegate here. It takes doc, page and the target
// stream as plain arguments, which is also what lets the scope walk be driven
// from hand-built resource dicts.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfStream, isDict, isName, isStream } from './types.js';

/** Where one image XObject sits in a page's resource tree. */
export interface ImageScope {
  /** Chain of Form XObject resource names from the page down; [] at page level. */
  readonly path: string[];
  /** The /XObject key the stream is registered under in that scope. */
  readonly key: string;
}

/** Every place `target` is registered in `page`'s resource tree, descending into
 *  Form XObjects exactly as `collectImages` does.
 *
 *  **Invariant:** the match is on stream IDENTITY, never on a resource name.
 *  Two forms may each hold an `Im0`, so a name alone does not say which; and one
 *  stream registered under two keys would be only half-handled by a name match.
 *  Identity is sound because `Document.resolve` is a map lookup -- the whole file
 *  is parsed into the object map on `Open`, so a given object number always
 *  yields the same instance. */
export function imageScopes(doc: Document, page: Page, target: PdfStream): ImageScope[] {
  const out: ImageScope[] = [];
  const seen = new Set<PdfDict>();
  const walk = (res: PdfObject, path: string[]): void => {
    const r = doc.resolve(res);
    if (!isDict(r)) return;
    const xobj = doc.resolve(r.get('XObject'));
    if (!isDict(xobj) || seen.has(xobj)) return;
    seen.add(xobj);
    for (const [key, val] of xobj) {
      const obj = doc.resolve(val);
      if (!isStream(obj)) continue;
      if (obj === target) { out.push({ path: [...path], key }); continue; }
      const sub = doc.resolve(obj.dict.get('Subtype'));
      if (isName(sub) && sub.name === 'Form')
        walk(obj.dict.get('Resources') ?? null, [...path, key]);
    }
  };
  walk(page.Resources ?? null, []);
  return out;
}
```

- [ ] **Step 6: Bind `ImageInfo` to its page**

In `src/image.ts`, add the type-only import and the constructor field:

```ts
import type { Page } from './page.js';
```

```ts
  constructor(
    private readonly doc: Document,
    /** Resource key under which the image was found (e.g. 'Im0'). */
    readonly Name: string,
    /** The live image XObject stream. */
    private readonly stream: PdfStream,
    /** The page this handle was enumerated from. Absent for an internally
     *  constructed handle -- the JBIG2-globals recursion in `Decode` builds
     *  one -- which is why the edit methods guard rather than assume. */
    private readonly page?: Page,
  ) {}
```

and thread it through `collectImages`:

```ts
export function collectImages(
  doc: Document, resources: PdfDict | undefined, page?: Page,
): ImageInfo[] {
```

changing the one construction site inside `walk` to:

```ts
        out.push(new ImageInfo(doc, key, obj, page));
```

In `src/page.ts`, `get Images()` becomes:

```ts
  get Images(): ImageInfo[] {
    return collectImages(this.doc, this.Resources, this);
  }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/image-edit.test.ts && npm run typecheck`
Expected: PASS (the final `describe` skipped), typecheck clean.

Run: `npx vitest run test/image.test.ts`
Expected: PASS — enumeration is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/imageedit.ts src/image.ts src/page.ts \
        test/helpers/build-image-pdf.ts test/helpers/build-image-edit-pdf.ts \
        test/image-edit.test.ts
git commit -m "feat(10u9.4): image scope walk, and bind ImageInfo to its page

imageScopes answers where in a page's resource tree an image stream sits,
matching on stream identity rather than resource name -- two forms may each
hold an Im0, and one stream may be registered twice. ImageInfo now carries
the page it was enumerated from, which the edit methods need.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `Replace`

**Files:**
- Modify: `src/imageedit.ts` (append)
- Modify: `src/image.ts` (add the method)
- Test: `test/image-edit.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `imageScopes` (Task 4), `ownXObjectResources` (Task 3), `buildImageXObject(data, format?, page?): BuiltImage` and `BuiltImage = { stream: PdfStream; smask?: PdfStream }` from `imageembed.js`, `ensureOwnResources`/`ensureOwnSubdict` from `pagecontent.js`, `EditableContent` from `editcontent.js`, `doc.allocObject(obj): PdfRef`.
- Produces:
  - `export interface ReplaceImageOptions { format?: 'jpeg' | 'png' | 'bmp' | 'tiff'; page?: number }`
  - `export function replaceImage(doc, page, target, data, opts?): void`
  - `ImageInfo.Replace(data: Uint8Array, opts?: ReplaceImageOptions): void`

- [ ] **Step 1: Write the failing test**

Append to `test/image-edit.test.ts` (extend the imports at the top with
`deflateSync` from `node:zlib`, `UnsupportedFeatureError` from
`../src/errors.js`, `buildSingleImagePdfWithCm` from
`./helpers/build-image-pdf.js`, `ImageInfo` from `../src/image.js`, and
`buildJpeg`, `buildPngRgb`, `buildPngRgba` from
`./helpers/build-embed-images.js`):

```ts
/** A 1-page PDF whose /Im0 is a 2x2 DeviceRGB image placed by `80 0 0 40 10 10 cm`. */
function placedPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(Buffer.from(
    Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))));
  return buildSingleImagePdfWithCm({
    width: 2, height: 2, colorSpace: 'DeviceRGB', bits: 8,
    filter: 'FlateDecode', raw, cm: '80 0 0 40 10 10',
  });
}

const contentText = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('ImageInfo.Replace', () => {
  it('swaps the picture and leaves the placement alone', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Replace(buildPngRgb()); // 2x1 RGB

    const img = doc.Pages[0].Images[0];
    expect(img.Width).toBe(2);
    expect(img.Height).toBe(1);
    expect(img.ColorSpace).toBe('DeviceRGB');
    // The cm that sizes the image lives in the content stream and is untouched.
    expect(contentText(doc)).toContain('80 0 0 40 10 10 cm');
  });

  it('survives a save/reopen round trip', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Replace(buildPngRgb());
    const back = Document.Open(doc.Save());
    expect(back.Pages[0].Images[0].Height).toBe(1);
    expect(contentText(back)).toContain('80 0 0 40 10 10 cm');
  });

  it('is copy-on-write: replacing from one page leaves the other alone', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const sharedBefore = doc.Pages[1].Images[0].Stream;

    doc.Pages[0].Images[0].Replace(buildPngRgb());

    expect(doc.Pages[0].Images[0].Height).toBe(1);   // replaced
    expect(doc.Pages[1].Images[0].Height).toBe(2);   // untouched
    expect(doc.Pages[1].Images[0].Stream).toBe(sharedBefore);
    expect(doc.Pages[0].Images[0].Stream).not.toBe(sharedBefore);
  });

  it('is copy-on-write for an image nested in a shared form', () => {
    const doc = Document.Open(buildFormImagePdf());
    const before = doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Stream;

    doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Replace(buildPngRgb());

    expect(doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Height).toBe(1);
    expect(doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Height).toBe(2);
    expect(doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Stream).toBe(before);
  });

  it('adds an /SMask for an alpha source and DROPS it for an opaque one', () => {
    const doc = Document.Open(placedPdf());

    doc.Pages[0].Images[0].Replace(buildPngRgba()); // 1x1 RGBA
    expect(doc.Pages[0].Images[0].Dict.has('SMask')).toBe(true);

    doc.Pages[0].Images[0].Replace(buildJpeg(4, 4, 3)); // opaque
    expect(doc.Pages[0].Images[0].Dict.has('SMask')).toBe(false);
    expect(doc.Pages[0].Images[0].Filter).toBe('DCTDecode');
  });

  it('carries /OC forward', () => {
    const doc = Document.Open(placedPdf());
    const layer = doc.OptionalContent.AddLayer('L1');
    doc.Pages[0].Images[0].Dict.set('OC', layer.Ref);

    doc.Pages[0].Images[0].Replace(buildPngRgb());

    expect(doc.Pages[0].Images[0].Dict.get('OC')).toEqual(layer.Ref);
  });

  it('validates before mutating: a rejected call leaves the bytes identical', () => {
    const doc = Document.Open(placedPdf());
    const before = doc.Save();
    expect(() => doc.Pages[0].Images[0].Replace(Uint8Array.from([1, 2, 3])))
      .toThrow(UnsupportedFeatureError);
    expect(Buffer.from(doc.Save()).equals(Buffer.from(before))).toBe(true);
  });

  it('rejects empty data', () => {
    const doc = Document.Open(placedPdf());
    expect(() => doc.Pages[0].Images[0].Replace(new Uint8Array(0)))
      .toThrow(UnsupportedFeatureError);
  });

  it('throws RangeError for a handle whose stream left the resource tree', () => {
    const doc = Document.Open(placedPdf());
    const stale = doc.Pages[0].Images[0];
    xobjectDict(doc).delete('Im0');
    expect(() => stale.Replace(buildPngRgb())).toThrow(RangeError);
  });

  it('refuses a page index for a format that has no pages', () => {
    const doc = Document.Open(placedPdf());
    expect(() => doc.Pages[0].Images[0].Replace(buildPngRgb(), { page: 1 }))
      .toThrow(UnsupportedFeatureError);
  });

  it('refuses a handle that is not bound to a page', () => {
    const doc = Document.Open(placedPdf());
    const stream = doc.Pages[0].Images[0].Stream;
    const unbound = new ImageInfo(doc, 'Im0', stream); // no page argument
    expect(() => unbound.Replace(buildPngRgb())).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/image-edit.test.ts`
Expected: FAIL — `doc.Pages[0].Images[0].Replace is not a function`.

- [ ] **Step 3: Implement `replaceImage`**

Append to `src/imageedit.ts` (and extend its imports):

```ts
import { EditableContent } from './editcontent.js';
import { buildImageXObject } from './imageembed.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { UnsupportedFeatureError } from './errors.js';
```

```ts
/** Options for {@link replaceImage} / `ImageInfo.Replace`. */
export interface ReplaceImageOptions {
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Which image of a multi-image file to use, 0-based. TIFF only; a non-zero
   *  value THROWS for a format with no pages rather than being silently
   *  ignored. Default 0. */
  page?: number;
}

/** Swap the picture `target` holds for `data`, keeping its placement.
 *
 *  Copy-on-write and scoped to `page`: a fresh XObject is built and this page's
 *  resource keys repointed at it, so an image shared with another page leaves
 *  that page alone. If nothing else pointed at the old object, `Save()` sweeps
 *  it — the file is the same size either way.
 *
 *  The new image is STRETCHED into the existing footprint whatever its
 *  proportions: the `cm` that sizes an image lives in the content stream, and
 *  the caller asked to change the picture, not the layout.
 *
 *  **Invariant:** the build runs before any mutation, so a rejected call leaves
 *  the document byte-identical.
 *
 *  **Invariant:** only /OC carries over from the old dict. Every other entry
 *  describes the samples being discarded — a stale /SMask would show the new
 *  picture through a stencil cut for the old one — while optional-content
 *  membership describes the slot. */
export function replaceImage(
  doc: Document, page: Page, target: PdfStream,
  data: Uint8Array, opts: ReplaceImageOptions = {},
): void {
  if (data.length === 0)
    throw new UnsupportedFeatureError('ImageInfo.Replace: empty image data');
  const built = buildImageXObject(data, opts.format, opts.page ?? 0);

  const scopes = imageScopes(doc, page, target);
  if (scopes.length === 0)
    throw new RangeError('ImageInfo.Replace: image not found in the page resource tree');

  const oc = target.dict.get('OC');
  if (oc !== undefined) built.stream.dict.set('OC', oc);
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const ref = doc.allocObject(built.stream);

  const ec = new EditableContent(doc, page);
  for (const { path, key } of scopes) {
    const res = path.length === 0
      ? ensureOwnResources(doc, page)
      : ec.ownXObjectResources(path);
    ensureOwnSubdict(doc, res, 'XObject').set(key, ref);
  }
  ec.commit();
}
```

- [ ] **Step 4: Add the method to `ImageInfo`**

In `src/image.ts`, add the import and the method (place it after `Decode`):

```ts
import { replaceImage, type ReplaceImageOptions } from './imageedit.js';
```

```ts
  /** Swap this image's picture for `data` (JPEG, PNG, BMP or TIFF), keeping its
   *  placement on the page. The new image is stretched into the existing
   *  footprint whatever its proportions.
   *
   *  Scoped to the page this handle came from: an image shared with another page
   *  is copied rather than mutated, so that page is unaffected. Throws before
   *  changing anything when `data` cannot be decoded. */
  Replace(data: Uint8Array, opts: ReplaceImageOptions = {}): void {
    replaceImage(this.doc, this.requirePage('Replace'), this.stream, data, opts);
  }

  /** The page this handle was enumerated from, or a clear throw. */
  private requirePage(what: string): Page {
    if (!this.page)
      throw new UnsupportedFeatureError(
        `ImageInfo.${what}: this handle is not bound to a page`);
    return this.page;
  }
```

`UnsupportedFeatureError` is already imported by `image.ts`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/image-edit.test.ts && npm run typecheck`
Expected: PASS (the page-binding `describe` still skipped), typecheck clean.

- [ ] **Step 6: Prove the /OC and /SMask assertions are load-bearing**

In `src/imageedit.ts`, temporarily delete the two `oc` lines. Re-run
`npx vitest run test/image-edit.test.ts`. Expected: FAIL on "carries /OC
forward". Restore.

Then temporarily change `replaceImage` to seed the new dict from the old one
(`for (const [k, v] of target.dict) if (!built.stream.dict.has(k)) built.stream.dict.set(k, v);`
before the `oc` handling) and re-run. Expected: FAIL on the /SMask case.
Restore, and confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/imageedit.ts src/image.ts test/image-edit.test.ts
git commit -m "feat(10u9.4): ImageInfo.Replace

Swaps an embedded image's picture for JPEG/PNG/BMP/TIFF bytes while keeping
its placement. Copy-on-write and scoped to the page the handle came from, so
a shared image leaves other pages alone; the dict is built fresh so a stale
/SMask cannot survive, with /OC the one entry carried over.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `Remove`

**Files:**
- Modify: `src/imageedit.ts` (append)
- Modify: `src/image.ts` (add the method)
- Test: `test/image-edit.test.ts` (append a `describe`, un-skip the Task 4 one)

**Interfaces:**
- Consumes: `imageScopes`, `ownXObjectResources`, `imageCutSet` from `content.js` (Task 1), `sanitizeResources` from `resprune.js` (Task 2), `EditableContent` methods `streamCount`, `topOps(i)`, `setTopOps(i, ops)`, `xobjectOps(path)`, `setXobjectOps(path, ops)`, `commit()`.
- Produces:
  - `export interface RemoveImageOptions { sanitize?: boolean }`
  - `export function removeImage(doc, page, target, opts?): void`
  - `ImageInfo.Remove(opts?: RemoveImageOptions): void`

- [ ] **Step 1: Write the failing test**

Append to `test/image-edit.test.ts` (`isDict`, `PdfDict`, `ImageInfo` and
`UnsupportedFeatureError` are already imported from Tasks 4 and 5):

```ts
/** Keys of a page's /Resources sub-dict (e.g. 'XObject'), or []. */
function resourceKeys(doc: Document, key: string, pageIndex = 0): string[] {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  const sub = isDict(res) ? doc.resolve(res.get(key)) : undefined;
  return isDict(sub) ? [...sub.keys()] : [];
}
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('ImageInfo.Remove', () => {
  it('drops the draw, the placement group and the resource entry', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Remove();

    const body = contentText(doc);
    expect(body).not.toContain('/Im0 Do');
    expect(body).not.toContain('80 0 0 40 10 10 cm'); // the whole q/cm/Do/Q went
    expect(body).not.toContain('q');
    expect(resourceKeys(doc, 'XObject')).not.toContain('Im0');
    expect(doc.Pages[0].Images).toEqual([]);
  });

  it('lets Save sweep the now-orphaned XObject', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Remove();
    expect(savedText(doc)).not.toContain('/Subtype /Image');
  });

  it('removes every draw of the image on the page', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove();
    const body = contentText(doc);
    expect(body).not.toContain('Do');
    expect(body).not.toContain('80 0 0 40 10 10 cm');
    expect(body).not.toContain('60 0 0 30 20 120 cm');
  });

  it('leaves the other page alone when the image is shared', () => {
    const doc = Document.Open(buildSharedImagePdf());
    doc.Pages[0].Images[0].Remove();

    expect(doc.Pages[0].Images).toEqual([]);
    expect(doc.Pages[1].Images.map((i) => i.Name)).toEqual(['Im0']);
    expect(contentText(doc, 1)).toContain('/Im0 Do');
    // Still reachable from page 2, so it must NOT be swept.
    expect(savedText(doc)).toContain('/Subtype /Image');
  });

  it('removes an image nested in a form, copy-on-writing that form', () => {
    const doc = Document.Open(buildFormImagePdf());
    doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Remove();

    expect(doc.Pages[0].Images.map((i) => i.Name)).toEqual([]);
    // The second page shares the form object and must keep its image.
    expect(doc.Pages[1].Images.map((i) => i.Name)).toEqual(['ImF']);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].Images.map((i) => i.Name)).toEqual([]);
    expect(back.Pages[1].Images.map((i) => i.Name)).toEqual(['ImF']);
  });

  it('leaves an unrelated unreferenced resource by default', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove();
    expect(resourceKeys(doc, 'ExtGState')).toEqual(['GS0']);
  });

  it('prunes it with { sanitize: true }', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove({ sanitize: true });
    expect(resourceKeys(doc, 'ExtGState')).toEqual([]);
    expect(resourceKeys(doc, 'XObject')).toEqual([]);
  });

  it('throws RangeError for a stale handle', () => {
    const doc = Document.Open(placedPdf());
    const stale = doc.Pages[0].Images[0];
    stale.Remove();
    expect(() => stale.Remove()).toThrow(RangeError);
  });

  it('refuses a handle that is not bound to a page', () => {
    const doc = Document.Open(placedPdf());
    const unbound = new ImageInfo(doc, 'Im0', doc.Pages[0].Images[0].Stream);
    expect(() => unbound.Remove()).toThrow(UnsupportedFeatureError);
  });
});
```

Then remove the `.skip` from the Task 4 `describe('ImageInfo is bound to the
page it was enumerated from')` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/image-edit.test.ts`
Expected: FAIL — `doc.Pages[0].Images[0].Remove is not a function`.

- [ ] **Step 3: Implement `removeImage`**

Append to `src/imageedit.ts` (extend its imports with
`import { imageCutSet, type ContentOp } from './content.js';` and
`import { sanitizeResources } from './resprune.js';`):

```ts
/** Options for {@link removeImage} / `ImageInfo.Remove`. */
export interface RemoveImageOptions {
  /** Also prune every now-unreferenced /Font, /XObject and /ExtGState name from
   *  the page and each edited form, as redaction does. Default false, which
   *  removes only this image's own entry. Either way `Save()` sweeps objects
   *  nothing points at, so this changes which /Resources entries survive, not
   *  which objects reach the file. */
  sanitize?: boolean;
}

/** Ops with each `Do` naming one of `keys` cut, together with its placement
 *  group, or undefined when this op list draws none of them. */
function cutDraws(ops: readonly ContentOp[], keys: Set<string>): ContentOp[] | undefined {
  const hits = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i].operands[0];
    if (ops[i].operator === 'Do' && isName(a) && keys.has(a.name)) hits.add(i);
  }
  if (hits.size === 0) return undefined;
  const cut = imageCutSet(ops, hits);
  return ops.filter((_, i) => !cut.has(i));
}

/** Drop `target` from `page`: every `Do` of it in the page's content streams and
 *  in the Form XObjects the page descends into, plus the /XObject entries it
 *  occupied. The XObject itself is left to `Save()`'s mark-sweep, which keeps it
 *  when another page still draws it.
 *
 *  **Invariant:** scoped to this page. A handle came from one page's `Images`,
 *  so it edits that page; a form shared with another page is copy-on-written
 *  rather than edited in place. */
export function removeImage(
  doc: Document, page: Page, target: PdfStream, opts: RemoveImageOptions = {},
): void {
  const scopes = imageScopes(doc, page, target);
  if (scopes.length === 0)
    throw new RangeError('ImageInfo.Remove: image not found in the page resource tree');

  // One bucket per scope: a stream may hold several keys in the same scope.
  const byPath = new Map<string, { path: string[]; keys: Set<string> }>();
  for (const { path, key } of scopes) {
    const id = path.join('\0');
    let e = byPath.get(id);
    if (!e) { e = { path, keys: new Set() }; byPath.set(id, e); }
    e.keys.add(key);
  }

  const ec = new EditableContent(doc, page);

  // 1. Cut the draws.
  for (const { path, keys } of byPath.values()) {
    if (path.length === 0) {
      for (let i = 0; i < ec.streamCount; i++) {
        const out = cutDraws(ec.topOps(i), keys);
        if (out) ec.setTopOps(i, out);
      }
    } else {
      const out = cutDraws(ec.xobjectOps(path), keys);
      if (out) ec.setXobjectOps(path, out);
    }
  }

  // 2. Delete the resource entries -- AFTER the op edit, because the form COW
  //    replaces a scope's /Resources and a dict captured earlier is stale.
  for (const { path, keys } of byPath.values()) {
    const res = path.length === 0
      ? ensureOwnResources(doc, page)
      : ec.ownXObjectResources(path);
    const xobjs = ensureOwnSubdict(doc, res, 'XObject');
    for (const key of keys) xobjs.delete(key);
  }

  if (opts.sanitize) sanitizeResources(doc, page, ec);
  ec.commit();
}
```

- [ ] **Step 4: Add the method to `ImageInfo`**

In `src/image.ts`, extend the `imageedit.js` import and add the method after
`Replace`:

```ts
import {
  replaceImage, removeImage,
  type ReplaceImageOptions, type RemoveImageOptions,
} from './imageedit.js';
```

```ts
  /** Drop this image from the page this handle came from: every draw of it in
   *  the page's content (including inside Form XObjects) and its /XObject
   *  resource entry. The image object itself is swept by `Save()` unless another
   *  page still draws it.
   *
   *  `{ sanitize: true }` additionally prunes every other now-unreferenced
   *  /Font, /XObject and /ExtGState name, as redaction does. */
  Remove(opts: RemoveImageOptions = {}): void {
    removeImage(this.doc, this.requirePage('Remove'), this.stream, opts);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/image-edit.test.ts && npm run typecheck`
Expected: PASS (all describes, none skipped), typecheck clean.

- [ ] **Step 6: Prove the two subtle steps are load-bearing**

a) **The group cut.** In `removeImage`'s `cutDraws`, temporarily replace
`const cut = imageCutSet(ops, hits);` with `const cut = hits;`. Run
`npx vitest run test/image-edit.test.ts`. Expected: FAIL on "drops the draw, the
placement group and the resource entry". Restore.

b) **The `sanitize` flag.** Temporarily change `if (opts.sanitize)` to
`if (false)`. Run the same command. Expected: FAIL on "prunes it with
{ sanitize: true }" and nothing else — confirming the default-leaves-it case
does not accidentally cover it. Restore.

c) **The ordering.** Move the resource-deletion loop above the op-cut loop. Run
the same command. Expected: FAIL on the nested-form case. Restore.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/imageedit.ts src/image.ts test/image-edit.test.ts
git commit -m "feat(10u9.4): ImageInfo.Remove

Drops every draw of an image on the page it was enumerated from -- page
content and the forms the page descends into -- plus its /XObject entry,
leaving the object to Save()'s mark-sweep so a page still drawing it keeps
it. { sanitize: true } escalates to the full redaction-grade prune.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Public exports, docs, and the follow-up issues

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `ReplaceImageOptions` and `RemoveImageOptions` on the package's public type surface.

- [ ] **Step 1: Export the option types**

In `src/index.ts`, beside the existing `export type { AddImageOptions } from './imageembed.js';` (line ~145):

```ts
export type { ReplaceImageOptions, RemoveImageOptions } from './imageedit.js';
```

`ImageInfo` is already exported (line 15), and the two methods ride on it.

- [ ] **Step 2: Verify the public surface compiles and builds**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 3: Document the API in `README.md`**

Three exact places, found by `grep -n "Images\\b" README.md`:

**(a) The feature bullet at line ~36**, which currently opens
`- **Image extraction** — \`page.Images\` enumerates embedded image XObjects…`.
Append to the end of that bullet:

```markdown
 Images can also be edited in place: `img.Replace(data)` swaps the picture for JPEG, PNG, BMP or TIFF bytes while keeping the placement, and `img.Remove()` drops the image from the page — every draw of it in the page's content and in the Form XObjects the page descends into, plus its `/XObject` resource entry. Both are scoped to the page the handle came from: an image shared with another page is copied rather than mutated on replace, and survives removal from one page while another still draws it, so a handle from `page.Images` never silently edits a page the caller was not looking at. The new image is stretched into the existing footprint, since the `cm` that sizes it lives in the content stream. `Remove({ sanitize: true })` additionally prunes every other resource name the page no longer references. Inline (`BI…EI`) images are not enumerated and so cannot be replaced or removed — redact their rectangle instead.
```

**(b) The `### Images` section at line ~1865.** After the existing `for (const
img of doc.Pages[0].Images)` example and before the `Decode()` paragraph, insert:

```markdown
Beyond reading, an image can be swapped or dropped in place:

\`\`\`ts
const img = doc.Pages[0].Images[0];
img.Replace(fs.readFileSync('new.png'));   // JPEG, PNG, BMP or TIFF
doc.Pages[0].Images[1].Remove();           // drops the draw and the resource entry
doc.Pages[0].Images[0].Remove({ sanitize: true }); // …and every other orphaned resource
\`\`\`

`Replace` keeps the placement: the new image is stretched into the footprint the
old one occupied, whatever its proportions, because the `cm` that sizes an image
lives in the content stream rather than in the XObject. It builds and validates
the new image before touching anything, so a call that throws leaves the document
byte-identical, and it builds the image dict fresh — a stale `/SMask` from the
old picture cannot survive, with `/OC` the one entry carried over. Pass
`{ format }` to override magic-byte detection and `{ page }` to pick an image
out of a multi-image TIFF.

Both methods are scoped to the page the handle came from. An image shared with
another page is copied rather than mutated on replace, and removing it from one
page leaves the other page still drawing it; the object itself is swept by
`Save()` once nothing points at it. Inline (`BI…EI`) images are not enumerated
by `page.Images`, so they cannot be replaced or removed — use `Redact` over
their rectangle.
```

**(c) The API overview table at line ~2165.** After the
`| \`image.RawData\` / \`image.Decode()\` | … |` row, add:

```markdown
| `image.Replace(data, options?)` | Swap the picture for JPEG/PNG/BMP/TIFF bytes, keeping its placement. Copy-on-write and scoped to the page the handle came from. `{ format }` overrides detection, `{ page }` picks a TIFF image |
| `image.Remove(options?)` | Drop the image from the page: every draw of it (page content and nested Form XObjects) plus its `/XObject` entry. `{ sanitize: true }` also prunes every other now-unreferenced resource name |
```

- [ ] **Step 4: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **Replace and remove an embedded image** — `ImageInfo.Replace(data)` swaps the
  picture for JPEG, PNG, BMP or TIFF bytes while keeping the placement, and
  `ImageInfo.Remove()` drops the image from the page: every draw of it in the
  page's content and in the Form XObjects the page descends into, plus its
  `/XObject` resource entry. Both are scoped to the page the handle came from.
  An image shared with another page is copied rather than mutated on replace,
  and survives removal from one page while another still draws it — so a handle
  from `page.Images` never silently edits a page the caller was not looking at.
  The new image is stretched into the existing footprint, since the `cm` that
  sizes it lives in the content stream. `Replace` builds and validates the new
  XObject before touching anything, so a rejected call leaves the document
  byte-identical, and it builds the image dict fresh — a stale `/SMask` from the
  old picture cannot survive, with `/OC` the one entry carried over.
  `Remove({ sanitize: true })` escalates to redaction's full prune of
  now-unreferenced resource names. Inline `BI…EI` images are not enumerated and
  so are out of scope. (10u9.4)
```

- [ ] **Step 5: Record the architecture in `CLAUDE.md`**

In the Architecture Overview, extend the `image.ts` / image-stack bullet with a
paragraph for the new module:

```markdown
- **imageedit.ts** — editing an embedded image in place, behind
  `ImageInfo.Replace` and `ImageInfo.Remove`. Object-graph and content-stream
  work only; no decoding.
  **Invariant:** it imports neither `redact.ts` nor `image.ts`. `redact.ts`
  imports `image.ts` for its decoder, so either edge closes a cycle back to
  `ImageInfo`, whose methods delegate here — which is why `imageCutSet` moved to
  `content.ts` and `sanitizeResources` to the leaf `resprune.ts` rather than
  being reached through `redact.ts`. It takes `doc`, `page` and the target
  `PdfStream` as plain arguments, so the scope walk is drivable from hand-built
  resource dicts.
  **Invariant:** `imageScopes` matches on stream IDENTITY, never on a resource
  name. `collectImages` descends into Form XObjects, so two forms may each hold
  an `Im0`; and one stream registered under two keys would be only
  half-handled by a name match. Identity is sound because `resolve` is a map
  lookup over a fully-parsed document.
  **Invariant:** both operations are scoped to the page the handle came from,
  because that is what `page.Images` already means. Replace is copy-on-write for
  the same reason — mutating the stream in place is Go's shape and would edit
  every page at once, which a per-page handle must not do silently. If the image
  was unshared the old object is orphaned and swept, so the file is the same size
  either way.
  **Invariant:** `Replace` builds the new XObject BEFORE any mutation, so a
  rejected call leaves the document byte-identical; and it builds the dict fresh,
  carrying over only `/OC`. Every other entry describes the samples being
  discarded — a stale `/SMask` would show the new picture through a stencil cut
  for the old one — while optional-content membership describes the slot.
  **Invariant:** `Remove` deletes resource entries AFTER the op edit. The form
  copy-on-write replaces a scope's `/Resources`, so a dict captured earlier is
  stale and deleting from it mutates an object the page no longer points at.
  **Invariant:** `RemoveImageOptions.sanitize` changes which `/Resources`
  entries survive, never which objects reach the file — `Save()` sweeps orphans
  either way. A test asserting only that the image is absent from the saved bytes
  therefore passes with the flag ignored; it is pinned by asserting an unrelated
  unreferenced `/ExtGState` BOTH ways.
- **resprune.ts** — `sanitizeResources` and its helpers, moved out of
  `redact.ts` so `imageedit.ts` can reach the prune without importing
  `redact.ts`. `redact.ts` re-exports it, so `redact.js` stays the import path it
  has always been. One owner: redaction and image removal must not disagree about
  what "unreferenced" means.
```

Also add a line to the `content.ts` description noting it now owns `imageCutSet`,
including the `gs` degradation recorded in `test/content-cutset.test.ts`.

- [ ] **Step 6: File the follow-up issues**

```bash
bd create "Remove an inline (BI…EI) image" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-10u9 \
  -d "10u9.4 shipped ImageInfo.Replace/Remove for image XObjects. An inline image has no /XObject entry, so collectImages never sees one and no ImageInfo for it can exist -- the refusal is structural rather than a check. redact.ts's removeImagesUnder already performs the op-list surgery; what is missing is an addressing scheme (a ContentAddr-shaped handle) for an image that lives in no object. Today the recipe is Redact over the image's rect."

bd create "imageCutSet: a gs between the q and the cm defeats the group cut" \
  -t bug -p 3 \
  -d "imageCutSet (src/content.ts) walks back over cm ops only, so 'q /GS0 gs 10 0 0 10 0 0 cm /Im0 Do Q' degrades to cutting the Do alone, leaving an inert 'q /GS0 gs ... cm Q'. Harmless (the Q restores what the q set) but it keeps the /GS0 reference alive, so a targeted Remove cannot orphan an ExtGState used only by the removed block. Pinned as current behaviour by test/content-cutset.test.ts. Fixing it means widening the walk-back to the state-only operators (gs, cm, cs/sc/scn, gs, w, ...) which changes redaction output too."
```

- [ ] **Step 7: Run the gates and close the issue**

Run: `npm run typecheck && npm test`
Expected: both green. Record the actual test counts in the commit body rather
than asserting success without them.

```bash
bd close aspose-pdf-foss-for-ts-10u9.4
```

- [ ] **Step 8: Commit and push**

```bash
git add src/index.ts README.md CHANGELOG.md CLAUDE.md .beads/
git commit -m "docs(10u9.4): README, changelog and architecture for image edit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **`markModified` is not needed explicitly.** `doc.allocObject` calls it, and
  both `replaceImage` (allocating the new XObject) and `removeImage` (through
  `ec.commit()`, which allocates fresh content streams) always allocate.
- **`Save()` is deterministic** for these fixtures — verified: two consecutive
  `Save()` calls on one `Document` produce identical bytes, and the classic
  writer emits `/ID` only when the trailer already carries one, which these
  fixtures do not. That is what makes the byte-identity assertion in Task 5
  sound.
- **`ensureOwnSubdict` replaces the sub-dict with a fresh copy on every call.**
  Calling it twice for two keys in the same scope is safe: the second copies from
  the first.
- **`page.Images` re-collects on every access**, so `doc.Pages[0].Images[0]`
  after a `Replace` is a *new* handle over the *new* stream. Tests rely on this
  rather than on a cached handle.
