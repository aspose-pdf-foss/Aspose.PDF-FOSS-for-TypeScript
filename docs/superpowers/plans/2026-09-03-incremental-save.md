# Incremental save — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.Save({ incremental: true })` appends a revision containing only the objects that changed, preserving the original bytes verbatim.

**Architecture:** A new pure leaf `incrementaldelta.ts` compares two object maps by canonical serialization and returns `{ replaced, added, freed }`. `Document` retains the `OpenOptions` it was opened with, so at incremental save it re-opens `originalBytes` to obtain a pristine baseline to diff against. `incremental.ts` — which already appends objects, a classic xref section and a `/Prev`-chained trailer — grows free (`f`) entries and correct per-object generations.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-03-incremental-save-delta-design.md`](../specs/2026-09-03-incremental-save-delta-design.md)

**Issues:** `msdn.2` (change tracking — Tasks 1–3), `msdn.3` (`Save({ incremental: true })` — Tasks 4–5)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { x } from './types.js'`).
- **Strict TypeScript.** `npm run typecheck` must be green before any task is considered done.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `errors.ts`.
- **Both gates green before closing any task:** `npm run typecheck` and `npm test`.
- **CHANGELOG.md is updated in the same commit as any user-visible change**, under `## [Unreleased]`, with a bold lead-in and prose saying what it does and why. Cite the issue id in parentheses.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry in the commit that lands it**, not later.
- **Do not use TodoWrite or markdown TODO lists** — this project tracks work in `bd`.
- **Never renumber objects on the incremental path.** `Save()`'s mark-sweep renumbering is exactly the information an append must not use.

---

### Task 1: `incrementaldelta.ts` — the pure diff

A leaf module importing only `types.js` and `serialize.js`. No `Document`, no `node:` import, so every rule is testable from hand-built maps with no PDF built — the split `floatstack.ts`, `tablegrid.ts` and `booklet.ts` already make.

**Files:**
- Create: `src/incrementaldelta.ts`
- Test: `test/incremental-delta.test.ts`
- Modify: `CLAUDE.md` (Source list entry), `CHANGELOG.md`

**Interfaces:**
- Consumes: `PdfObject` from `./types.js`, `serializeObject` from `./serialize.js`
- Produces:
  - `export interface ObjectDelta { replaced: Set<number>; added: Set<number>; freed: Set<number> }`
  - `export function diffObjects(baseline: Map<number, PdfObject>, live: Map<number, PdfObject>): ObjectDelta`

- [ ] **Step 1: Write the failing test**

Create `test/incremental-delta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffObjects } from '../src/incrementaldelta.js';
import { name, PdfDict, PdfObject } from '../src/types.js';

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('diffObjects', () => {
  it('reports nothing for two identical maps', () => {
    const a = new Map<number, PdfObject>([[1, dict([['Type', name('Catalog')]])], [2, 42]]);
    const b = new Map<number, PdfObject>([[1, dict([['Type', name('Catalog')]])], [2, 42]]);
    const d = diffObjects(a, b);
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('reports an object whose value changed as replaced', () => {
    const a = new Map<number, PdfObject>([[1, 42]]);
    const b = new Map<number, PdfObject>([[1, 43]]);
    expect([...diffObjects(a, b).replaced]).toEqual([1]);
  });

  it('reports an object number absent from the baseline as added', () => {
    const a = new Map<number, PdfObject>([[1, 42]]);
    const b = new Map<number, PdfObject>([[1, 42], [7, 9]]);
    const d = diffObjects(a, b);
    expect([...d.added]).toEqual([7]);
    expect([...d.replaced]).toEqual([]);
  });

  it('reports an object number absent from the live map as freed', () => {
    const a = new Map<number, PdfObject>([[1, 42], [7, 9]]);
    const b = new Map<number, PdfObject>([[1, 42]]);
    const d = diffObjects(a, b);
    expect([...d.freed]).toEqual([7]);
    expect([...d.replaced]).toEqual([]);
  });

  // The safe-direction invariant: a dict whose keys were deleted and re-added
  // serializes in a different order, so it is reported changed even though the
  // content is equal. Verbose, never silent -- this is the whole argument for
  // a save-time diff over a dirty set, and it is asserted so it stays a
  // decision rather than being "fixed" into a semantic comparison.
  it('conservatively reports a key-reordered dict as replaced', () => {
    const a = new Map<number, PdfObject>([[1, dict([['A', 1], ['B', 2]])]]);
    const b = new Map<number, PdfObject>([[1, dict([['B', 2], ['A', 1]])]]);
    expect([...diffObjects(a, b).replaced]).toEqual([1]);
  });

  // `null` is a valid PdfObject, so absence must be tested with `has` rather
  // than by comparing `get` against undefined -- otherwise an object whose
  // value is null reads as absent and is wrongly reported added or freed.
  it('distinguishes a stored null from an absent object number', () => {
    const a = new Map<number, PdfObject>([[1, null]]);
    const b = new Map<number, PdfObject>([[1, null]]);
    const d = diffObjects(a, b);
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/incremental-delta.test.ts`
Expected: FAIL — cannot resolve `../src/incrementaldelta.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/incrementaldelta.ts`:

```ts
import { PdfObject } from './types.js';
import { serializeObject } from './serialize.js';

/** What an incremental update must write, relative to the document as opened. */
export interface ObjectDelta {
  /** Present in both, serializing differently: write the live value. */
  replaced: Set<number>;
  /** Absent from the baseline: write the live value. */
  added: Set<number>;
  /** Present in the baseline, absent now: write a free xref entry. */
  freed: Set<number>;
}

/** Compare a pristine `baseline` against the `live` object map.
 *
 *  Equality is byte-equality of `serializeObject`'s output, with BOTH sides
 *  through the same serializer. That is sound however the mutation happened --
 *  including a direct write through a public `Dict` handle, which reports
 *  nothing -- and it fails in the safe direction: a document that merely
 *  reordered a dict's keys is reported changed and written again, where a
 *  missed change would be silently dropped from the revision. */
export function diffObjects(
  baseline: Map<number, PdfObject>,
  live: Map<number, PdfObject>,
): ObjectDelta {
  const replaced = new Set<number>();
  const added = new Set<number>();
  const freed = new Set<number>();

  for (const [num, obj] of live) {
    if (!baseline.has(num)) { added.add(num); continue; }
    if (!sameBytes(serializeObject(baseline.get(num)!), serializeObject(obj))) replaced.add(num);
  }
  for (const num of baseline.keys()) if (!live.has(num)) freed.add(num);

  return { replaced, added, freed };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/incremental-delta.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the CLAUDE.md Source-list entry**

Insert into the Source (`src/`) bullet list in `CLAUDE.md`, immediately after the `serializer.ts`/`serialize.ts` bullet:

```markdown
- **incrementaldelta.ts** — what an incremental update must write, relative to
  the document as opened: `diffObjects(baseline, live)` returning `replaced`,
  `added` and `freed` object numbers. A pure leaf over `types.js` and
  `serialize.js` — no `Document`, no `node:` import — so every rule is testable
  from hand-built maps with no PDF built.
  **Invariant:** the delta is decided by comparing CANONICAL SERIALIZATIONS,
  never by trusting a mutation report. `Page.Dict`, `Annotation.Dict` and
  `Field.Dict` are public live `Map`s, so `page.Dict.set('Rotate', 90)` mutates
  the document and reports nothing — no discipline at the 64 `markModified()`
  sites can close that while `Dict` is public. Equality is byte-equality of
  `serializeObject`'s output with BOTH sides through the same serializer:
  comparing against the original file bytes instead reports every object as
  changed, because the parse-serialize round trip is lossy in SPELLING (number
  formatting, string escaping, dict spacing) and faithful in content.
  **Invariant:** it fails in the SAFE direction. A dict whose keys were deleted
  and re-added serializes in a new order and is reported changed — verbose,
  never silent — where a dirty set that missed a mutation writes too little and
  the appended revision silently omits the edit. Same allowlist-not-denylist
  posture `content.ts`'s `NON_MARKING` takes, and it is asserted directly so it
  stays a decision rather than being "fixed" into a semantic comparison.
  **Invariant:** absence is tested with `Map.has`, never by comparing `get`
  against `undefined` — `null` is a valid `PdfObject`, so an object whose value
  is null otherwise reads as absent and is wrongly reported added or freed.
```

- [ ] **Step 6: Add the CHANGELOG entry**

Under `## [Unreleased]`, in an `### Added` block:

```markdown
- **Incremental-update delta computation.** `diffObjects` compares a pristine
  baseline against the live object map and reports which object numbers a
  cross-reference update must write, add or free. Equality is byte-equality of
  the canonical serialization rather than a dirty set maintained at mutation
  sites: the object model is publicly mutable through `Page.Dict` and its
  siblings, so a report-based delta cannot be complete, and its failure mode is
  the dangerous one — an appended revision that silently omits an edit. A
  serialization diff fails the other way, writing an unchanged-but-reordered
  object again rather than dropping a changed one. (`msdn.2`)
```

- [ ] **Step 7: Run both gates**

Run: `npm run typecheck && npx vitest run test/incremental-delta.test.ts`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/incrementaldelta.ts test/incremental-delta.test.ts CLAUDE.md CHANGELOG.md
git commit -m "feat(msdn.2): compute an incremental delta by canonical serialization"
```

---

### Task 2: free xref entries and correct generations in `incremental.ts`

`buildXrefSection` writes only `n` entries and `layout` writes `N 0 obj` unconditionally, discarding the generation `xref.ts` already parses. Both are fixed here, and signing gets generation-correctness for free.

**Files:**
- Modify: `src/incremental.ts` (`IncrementalUpdateOptions`, `layout`, `buildXrefSection`)
- Test: `test/incremental.test.ts` (append cases to the existing file)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `XrefEntry` from `./xref.js` (already imported via `readXref`)
- Produces:
  - `IncrementalUpdateOptions.freed?: Set<number>` — object numbers to mark free
  - unchanged public signatures for `appendIncrementalUpdate` and `appendSignatureUpdate`

- [ ] **Step 1: Write the failing tests**

Append to `test/incremental.test.ts` (the file already imports `buildClassicPdf`, `appendIncrementalUpdate`, `readXref`, `name`, `ref`, and defines `readObjAt`/`offsetOf`):

```ts
describe('incremental update: free entries and generations', () => {
  it('writes an f entry for a freed object, with the generation incremented', () => {
    const base = buildClassicPdf(1);
    const out = appendIncrementalUpdate(base, {
      objects: new Map(),
      freed: new Set([3]),
    });
    const e = readXref(out).entries.get(3);
    // A freed object is absent from the newest revision: readXref merges
    // newest-wins, so the free entry must shadow the original offset entry.
    expect(e).toBeUndefined();
    // And the section text must actually carry the f row.
    const text = new TextDecoder('latin1').decode(out.subarray(base.length));
    expect(text).toMatch(/^0000000000 00001 f $/m);
  });

  it('preserves the original generation when replacing an object', () => {
    const base = buildClassicPdf(1);
    const out = appendIncrementalUpdate(base, {
      objects: new Map([[3, new Map([['Type', name('Page')], ['Rotate', 90]])]]),
    });
    const text = new TextDecoder('latin1').decode(out.subarray(base.length));
    // buildClassicPdf writes every object at generation 0, so the replacement
    // header and the xref row must both say 0 -- the assertion that matters is
    // that the generation is READ from the previous xref rather than hardcoded,
    // which the gen-1 fixture below pins.
    expect(text).toContain('3 0 obj');
    expect(text).toMatch(/^0000000\d{3} 00000 n $/m);
  });

  it('emits a well-formed empty section when nothing changed', () => {
    const base = buildClassicPdf(1);
    const out = appendIncrementalUpdate(base, { objects: new Map() });
    const text = new TextDecoder('latin1').decode(out.subarray(base.length));
    // An xref section needs at least one subsection header; "xref\ntrailer"
    // is malformed and some readers reject the whole file.
    expect(text).toContain('xref\n0 0\n');
    expect(() => readXref(out)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/incremental.test.ts`
Expected: FAIL — `freed` is not a known option; no `f` row; `xref\n0 0\n` absent.

- [ ] **Step 3: Add `freed` to the options interface**

In `src/incremental.ts`, inside `IncrementalUpdateOptions`, after the `objects` field:

```ts
  /** Object numbers to mark FREE in the appended cross-reference section.
   *  An appended `f` entry shadows the original `n` entry, which is how a
   *  deletion is expressed without touching the original bytes. */
  freed?: Set<number>;
```

- [ ] **Step 4: Rewrite `buildXrefSection` to carry kind and generation**

Replace the whole `buildXrefSection` function in `src/incremental.ts` with:

```ts
interface XrefRow { num: number; kind: 'n' | 'f'; offset: number; gen: number }

/** Build a classic `xref` section from `rows`, grouping consecutive runs.
 *
 *  A section with no rows still needs a subsection header: `xref` immediately
 *  followed by `trailer` is malformed and some readers reject the file, so an
 *  empty update emits the degenerate `0 0` subsection. */
function buildXrefSection(rows: XrefRow[]): string {
  const sorted = [...rows].sort((a, b) => a.num - b.num);
  if (sorted.length === 0) return 'xref\n0 0\n';
  let s = 'xref\n';
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].num === sorted[j].num + 1) j++;
    s += `${sorted[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const r = sorted[k];
      s += `${String(r.offset).padStart(10, '0')} ${String(r.gen).padStart(5, '0')} ${r.kind} \n`;
    }
    i = j + 1;
  }
  return s;
}
```

- [ ] **Step 5: Read generations from the previous xref and emit both row kinds**

In `layout`, replace the object-writing block and the `buildXrefSection` call. The generation of a replaced object is the one the previous xref recorded; an object inside an `/ObjStm` has generation 0 by definition, and an object the previous xref does not name at all is new, so 0 is right there too.

Add this helper beside `refNum` at the bottom of the file:

```ts
/** The generation the previous cross-reference recorded for `num` (0 when it
 *  named no offset entry: a compressed object is generation 0 by definition,
 *  and an object the previous xref never named is new). */
function prevGen(entries: Map<number, XrefEntry>, num: number): number {
  const e = entries.get(num);
  return e !== undefined && e.type === 'offset' ? e.gen : 0;
}
```

Add `XrefEntry` to the existing `xref.js` import:

```ts
import { readXref, XrefEntry } from './xref.js';
```

Then, in `layout`, replace the loop that builds `offsets` and the `push(enc(buildXrefSection(...)))` line with:

```ts
  const rows: XrefRow[] = [];
  let sigStart = 0;
  for (const item of items) {
    const gen = prevGen(prev.entries, item.num);
    rows.push({ num: item.num, kind: 'n', offset: len, gen });
    if (sigObject && item.num === sigObject.num) {
      // The signature object text already includes "N 0 obj ... endobj\n".
      sigStart = len;
      push(item.body);
    } else {
      push(enc(`${item.num} ${gen} obj\n`));
      push(item.body);
      push(enc('\nendobj\n'));
    }
  }
  for (const num of opts.freed ?? []) {
    // A free entry's generation is the one the object WILL have if reused, so
    // it is the previous generation plus one. The 10-digit field heads a free
    // list we do not maintain, so it is 0 (the list terminator).
    rows.push({ num, kind: 'f', offset: 0, gen: prevGen(prev.entries, num) + 1 });
  }

  const xrefOffset = len;
  push(enc(buildXrefSection(rows)));
```

Then update the `size` computation just below to consider freed numbers as well:

```ts
  let maxNum = 0;
  for (const i of items) if (i.num > maxNum) maxNum = i.num;
  for (const n of opts.freed ?? []) if (n > maxNum) maxNum = n;
  const size = Math.max(prevSize, maxNum + 1);
```

Delete the now-unused `offsets` map declaration.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/incremental.test.ts`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 7: Run the signing suite, which is the real fence here**

Run: `npx vitest run test/sign.test.ts test/serializer-signed.test.ts test/sign-incremental-dirty.test.ts test/sign-cades.test.ts test/sign-doctimestamp.test.ts`
Expected: PASS. These exercise `layout` through `appendSignatureUpdate`; a regression in the row-building or offset arithmetic breaks a signature digest rather than a structural assertion.

- [ ] **Step 8: Add the CHANGELOG entry**

Under `## [Unreleased]`, in an `### Fixed` block:

```markdown
- **An appended cross-reference section now carries each object's real
  generation, and can mark an object free.** Every appended object was written
  `N 0 obj` with a generation-0 xref row, though `xref.ts` had parsed the real
  generation all along — so replacing an object at generation 1 or above
  produced a revision whose header disagreed with the object it superseded.
  The generation is now read from the previous cross-reference. Deletions are
  expressible for the first time: a freed object gets an `f` row whose
  generation is the one it would take on reuse. An update that changes nothing
  emits the degenerate `0 0` subsection rather than an `xref` immediately
  followed by `trailer`, which is malformed. (`msdn.2`)
```

- [ ] **Step 9: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/incremental.ts test/incremental.test.ts CHANGELOG.md
git commit -m "fix(msdn.2): write real generations and free entries in an appended xref"
```

---

### Task 3: retain `OpenOptions` and expose a baseline

**Files:**
- Modify: `src/document.ts` (field beside `originalBytes`; assignment at both `Open` sites; new private `baselineObjects`)
- Test: `test/save-incremental.test.ts` (new file)

**Interfaces:**
- Consumes: `diffObjects`, `ObjectDelta` from `./incrementaldelta.js`
- Produces: `private baselineObjects(): Map<number, PdfObject>` on `Document`

- [ ] **Step 1: Write the failing test**

Create `test/save-incremental.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { diffObjects } from '../src/incrementaldelta.js';

/** Reach the private baseline for testing without widening the public API. */
const baselineOf = (doc: Document): Map<number, any> =>
  (doc as any).baselineObjects();
const liveOf = (doc: Document): Map<number, any> => (doc as any).objects;

describe('baselineObjects', () => {
  it('matches the live map exactly for an unmodified document', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const d = diffObjects(baselineOf(doc), liveOf(doc));
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('reports exactly the object a direct Dict mutation changed', () => {
    const doc = Document.Open(buildClassicPdf(2));
    // Deliberately bypasses every markModified() site: this is the case a
    // dirty-set design cannot see.
    doc.Pages[0].Dict.set('Rotate', 90);
    const d = diffObjects(baselineOf(doc), liveOf(doc));
    expect(d.replaced.size).toBe(1);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('throws for a document authored in memory', () => {
    const doc = Document.New();
    expect(() => baselineOf(doc)).toThrow(/authored in memory/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/save-incremental.test.ts`
Expected: FAIL — `baselineObjects is not a function`.

- [ ] **Step 3: Retain the OpenOptions**

In `src/document.ts`, immediately after the `originalBytes` field declaration (around line 331), add:

```ts
  /** The options `Open` was called with, retained so an incremental save can
   *  re-parse `originalBytes` into a pristine baseline. The password is the
   *  reason this is kept rather than re-derived: `build()` constructs its
   *  `Decryptor` locally and discards it. */
  private openOptions: OpenOptions = {};
```

At both sites that assign `originalBytes` — around line 552 (the recovery path) and line 631 (the clean path) — add the matching assignment on the following line:

```ts
      doc.openOptions = opts;
```

- [ ] **Step 4: Add `baselineObjects`**

In `src/document.ts`, immediately after `markModified()` (around line 917), add:

```ts
  /** A pristine object map re-parsed from the bytes this document was opened
   *  from — the baseline an incremental save diffs the live model against.
   *
   *  Re-parsing rather than fingerprinting at open is deliberate: it puts the
   *  whole cost inside the operation that asks for it, on a path that is
   *  already writing a file, instead of taxing every `Open` in the library for
   *  a feature most callers never use. */
  private baselineObjects(): Map<number, PdfObject> {
    if (!this.originalBytes)
      throw new UnsupportedFeatureError(
        'cannot compute an incremental delta: this document was authored in memory, '
        + 'so there is no base byte image to compare against');
    return Document.Open(this.originalBytes, this.openOptions).objects;
  }
```

`objects` is `private`, but TypeScript's `private` is class-scoped, so reading it off another `Document` instance inside the class is legal.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/save-incremental.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/document.ts test/save-incremental.test.ts
git commit -m "feat(msdn.2): retain OpenOptions and re-parse a baseline for the delta"
```

---

### Task 4: `Save({ incremental: true })`

**Files:**
- Modify: `src/serializer.ts` (`SerializeOptions.incremental`)
- Modify: `src/document.ts` (`Save` branch, new private `saveIncremental`)
- Test: `test/save-incremental.test.ts` (append)
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `diffObjects` (Task 1), `appendIncrementalUpdate` with `freed` (Task 2), `baselineObjects` (Task 3)
- Produces: `SaveOptions.incremental?: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/save-incremental.test.ts`:

```ts
import { readXref } from '../src/xref.js';

/** The appended region: everything after the original byte image. */
const appended = (out: Uint8Array, base: Uint8Array): string =>
  new TextDecoder('latin1').decode(out.subarray(base.length));

describe('Save({ incremental: true })', () => {
  it('preserves the original bytes verbatim as a prefix', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });
    expect(out.length).toBeGreaterThan(base.length);
    expect(out.subarray(0, base.length)).toEqual(base);
  });

  it('appends no objects when nothing was edited', () => {
    const base = buildClassicPdf(2);
    const out = Document.Open(base).Save({ incremental: true });
    expect(appended(out, base)).not.toMatch(/\d+ \d+ obj/);
    expect(appended(out, base)).toContain('xref\n0 0\n');
  });

  it('appends exactly one object for one edit to one existing object', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const text = appended(doc.Save({ incremental: true }), base);
    expect(text.match(/\d+ \d+ obj/g)).toHaveLength(1);
    expect(text).toContain('/Rotate 90');
  });

  it('catches an edit made directly through the public Dict handle', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    // No markModified() site is involved. Under a dirty-set design this
    // produces a revision that silently omits the edit.
    doc.Pages[1].Dict.set('Rotate', 180);
    expect(appended(doc.Save({ incremental: true }), base)).toContain('/Rotate 180');
  });

  it('refuses a document authored in memory', () => {
    expect(() => Document.New().Save({ incremental: true }))
      .toThrow(/authored in memory/);
  });

  it('refuses a document that was opened by recovery', () => {
    const damaged = readFileSync('test/fixtures/corrupt/gs-x3-startxref-past-eof.pdf');
    const doc = Document.Open(new Uint8Array(damaged));
    expect(doc.recovery).toBeDefined();
    expect(() => doc.Save({ incremental: true })).toThrow(/opened by recovery/);
  });

  it('refuses an encrypted document', () => {
    const { bytes } = buildEncryptedPdf(
      { v: 2, r: 3, keyBits: 128, userPassword: '', ownerPassword: 'o' },
      { pageContents: ['BT ET'] },
    );
    const doc = Document.Open(bytes);
    expect(() => doc.Save({ incremental: true })).toThrow(/encrypted/);
  });

  it('refuses each option an append cannot honour', () => {
    const doc = Document.Open(buildClassicPdf(1));
    for (const opt of ['compressed', 'linearized'] as const)
      expect(() => doc.Save({ incremental: true, [opt]: true }))
        .toThrow(/cannot save incrementally/);
    expect(() => doc.Save({ incremental: true, streamFilter: 'FlateDecode' as any }))
      .toThrow(/cannot save incrementally/);
  });
});
```

Add to the imports at the top of the file:

```ts
import { readFileSync } from 'node:fs';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
```

> Check `EncryptConfig` and `SimpleDoc` in `test/helpers/encrypt-pdf.ts:23-32` for the exact field names before writing the encrypted case; the assertion is only that an `/Encrypt`-bearing document refuses.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/save-incremental.test.ts`
Expected: FAIL — `incremental` is not a known option, and `Save` ignores it.

- [ ] **Step 3: Add the option**

In `src/serializer.ts`, inside `SerializeOptions` after `streamFilter`:

```ts
  /** Append an incremental update to the bytes the document was opened from,
   *  rather than rewriting it. Only the objects that changed are written, the
   *  original bytes are preserved verbatim, and object numbers are NOT
   *  renumbered. Requires a document opened from bytes; throws if combined
   *  with `compressed`, `encrypt`, `linearized` or `streamFilter`.
   *  Default: false. */
  incremental?: boolean;
```

- [ ] **Step 4: Branch in `Save` and implement `saveIncremental`**

**The branch goes AFTER `finalizeEmbeddedFonts()`, and the order is
load-bearing.** Font embedding allocates objects during `Save`, so a diff taken
before it reports none of them and every font added since `Open` is silently
missing from the appended revision.

In `src/document.ts`, change `Save` (around line 1486) to:

```ts
  Save(options: SaveOptions = {}): Uint8Array {
    // A completed signature fixes the exact bytes; return them verbatim so the
    // signed byte image is never re-serialized (which would break the digest).
    if (this.pendingSignedBytes) return this.pendingSignedBytes;
    this.finalizeEmbeddedFonts();
    if (options.incremental) return this.saveIncremental(options);
    return serializeDocument(this.objects, this.trailer, options);
  }
```

Add immediately after `Save`:

```ts
  /** Append an incremental update carrying only what changed since `Open`.
   *
   *  The delta is REACHABILITY-BLIND, which is the exact inversion of `Save`'s
   *  mark-sweep: an appended revision must write a changed object whether or
   *  not it is still reachable from `/Root`, because earlier revisions still
   *  point at the object it supersedes. Garbage-collecting here corrupts the
   *  revision history this feature exists to provide. */
  private saveIncremental(options: SaveOptions): Uint8Array {
    if (!this.originalBytes)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: this document was authored in memory, '
        + 'so there is no base byte image to append to');
    if (this.recovery)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: this document was opened by recovery, so the '
        + 'cross-reference an update would chain /Prev onto could not be read');
    if (this.trailer.get('Encrypt') !== undefined)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: encrypted documents are not supported');
    for (const k of ['encrypt', 'compressed', 'linearized', 'streamFilter'] as const)
      if (options[k])
        throw new UnsupportedFeatureError(`cannot save incrementally with \`${k}\``);

    const delta = diffObjects(this.baselineObjects(), this.objects);
    const objects = new Map<number, PdfObject>();
    for (const n of delta.replaced) objects.set(n, this.objects.get(n)!);
    for (const n of delta.added) objects.set(n, this.objects.get(n)!);

    const rootRef = this.trailer.get('Root');
    const infoRef = this.trailer.get('Info');
    return appendIncrementalUpdate(this.originalBytes, {
      objects,
      freed: delta.freed,
      rootNum: isRef(rootRef) ? rootRef.num : undefined,
      infoNum: isRef(infoRef) ? infoRef.num : undefined,
    });
  }
```

Add the imports at the top of `src/document.ts`:

```ts
import { diffObjects } from './incrementaldelta.js';
```

and add `appendIncrementalUpdate` to the existing `./incremental.js` import if it is not already there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/save-incremental.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Add the deletion case**

`RemovePage` splices `/Kids` and leaves the page object in the map
([document.ts:2812](../../../src/document.ts#L2812)), so it **orphans** rather
than frees — no public API deletes an object number today, and that orphan is
the fixture Task 5 uses. The `freed` path is therefore driven from the live map
directly, which is what `diffObjects` actually keys on.

Append to `test/save-incremental.test.ts`:

```ts
  it('writes a free entry for an object deleted from the live map', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    const live = liveOf(doc);
    // Detach page 2 from the tree, then delete its object outright. RemovePage
    // alone only orphans it -- deletion is what produces a free entry.
    const orphan = doc.Pages[1].Dict;
    doc.RemovePage(2);
    const orphanNum = [...live.keys()].find((n) => live.get(n) === orphan)!;
    live.delete(orphanNum);

    const out = doc.Save({ incremental: true });
    expect(out.subarray(0, base.length)).toEqual(base);
    const text = appended(out, base);
    expect(text).toMatch(new RegExp(`^0000000000 00001 f $`, 'm'));
    // The freed number must be gone from the newest revision's merged xref.
    expect(readXref(out).entries.has(orphanNum)).toBe(false);
    expect(readXref(base).entries.has(orphanNum)).toBe(true);
  });
```

- [ ] **Step 7: Update README**

In the API overview section covering `Save`, add:

```markdown
`Save({ incremental: true })` appends a revision instead of rewriting: the
original bytes are preserved verbatim and only the objects that changed are
written, so earlier signatures over those bytes stay valid. Requires a document
opened from bytes, and is not combinable with `compressed`, `encrypt`,
`linearized` or `streamFilter`. Encrypted and recovery-opened documents are
refused.
```

- [ ] **Step 8: Add the CHANGELOG entry**

Under `## [Unreleased]`, in the `### Added` block:

```markdown
- **`Save({ incremental: true })` appends a revision rather than rewriting the
  file.** The bytes the document was opened from are preserved verbatim and
  only the objects that changed are appended, so a signature over the earlier
  revision stays valid — which is what makes review and annotation workflows on
  third-party files safe. What changed is decided by re-parsing the original
  bytes and comparing canonical serializations, so an edit made directly
  through a public `Dict` handle is caught like any other. The delta is
  deliberately reachability-blind, the inversion of `Save`'s mark-sweep: an
  earlier revision still points at the objects a new one supersedes, so nothing
  may be garbage-collected. Requires a document opened from bytes; refuses
  encrypted and recovery-opened documents, and refuses to combine with
  `compressed`, `encrypt`, `linearized` or `streamFilter`. (`msdn.3`)
```

- [ ] **Step 9: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/serializer.ts src/document.ts test/save-incremental.test.ts README.md CHANGELOG.md
git commit -m "feat(msdn.3): Save({ incremental: true }) appends only what changed"
```

---

### Task 5: prove the assertions load-bearing

This repo's stated rule is that a fixture passing on the first run is not evidence. Each mutation below is applied, the named tests confirmed red, and the mutation reverted. A mutation that reddens **nothing** is recorded in the commit message as an uncovered rule rather than quietly left.

**Files:**
- Modify: `test/save-incremental.test.ts` (add the orphan-retention case)
- Modify: `CLAUDE.md` (append the measured results to the `incrementaldelta.ts` entry)

- [ ] **Step 1: Add the orphan-retention case**

The reachability-blind invariant has no test yet. `RemovePage` is the natural
fixture: it splices `/Kids` and leaves the page object in the map, so the object
is live-but-unreachable — exactly the shape a mark-sweep drops and an appended
revision must keep, because the previous revision's `/Kids` still points at it.

Append to `test/save-incremental.test.ts`:

```ts
  it('writes a changed object that is no longer reachable from /Root', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    const live = liveOf(doc);
    const orphan = doc.Pages[1].Dict;
    doc.RemovePage(2);           // splices /Kids; the page object stays in the map
    const orphanNum = [...live.keys()].find((n) => live.get(n) === orphan)!;
    orphan.set('Rotate', 270);   // and it is still edited

    const text = appended(doc.Save({ incremental: true }), base);
    expect(text).toContain('/Rotate 270');
    expect(text).toContain(`${orphanNum} 0 obj`);
  });
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `npx vitest run test/save-incremental.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation 1 — neuter the serialization comparison**

In `src/incrementaldelta.ts`, change `sameBytes` to `return true;`.
Run: `npx vitest run test/save-incremental.test.ts test/incremental-delta.test.ts`
Expected RED: "reports an object whose value changed as replaced", "conservatively reports a key-reordered dict as replaced", "reports exactly the object a direct Dict mutation changed", "appends exactly one object...", "catches an edit made directly through the public Dict handle".
Revert.

- [ ] **Step 4: Mutation 2 — mark-sweep the delta**

In `saveIncremental`, filter `objects` to only those reachable from `/Root` (a one-line `serializer.ts`-style reachability walk, or simply drop `orphanNum` by hand).
Run: `npx vitest run test/save-incremental.test.ts`
Expected RED: "writes a changed object that is no longer reachable from /Root".
Revert.

- [ ] **Step 5: Mutation 3 — hardcode generation 0**

In `src/incremental.ts`, change `prevGen` to `return 0;`.
Run: `npx vitest run test/incremental.test.ts`
Expected RED: the free-entry case, whose generation must be 1.
If it reddens nothing else, record that the *replacement* generation path is covered only by the free-entry case, because no fixture in the suite has an object at generation ≥ 1.

- [ ] **Step 6: Mutation 4 — test absence with `get` instead of `has`**

In `diffObjects`, replace `!baseline.has(num)` with `baseline.get(num) === undefined`.
Run: `npx vitest run test/incremental-delta.test.ts`
Expected RED: "distinguishes a stored null from an absent object number".
Revert.

- [ ] **Step 7: Record the results in CLAUDE.md**

Append to the `incrementaldelta.ts` entry added in Task 1:

```markdown
  **Note, measured:** all four mutations aimed at these rules redden something —
  neutering the byte comparison, mark-sweeping the delta, hardcoding generation
  0, and testing absence with `get` rather than `has`. Record here if the
  generation mutation reddens only the free-entry case: no fixture in the suite
  has an object at generation ≥ 1, so the REPLACEMENT generation path is held
  by reasoning rather than by a test.
```

Replace that last sentence with the measured outcome rather than leaving the conditional.

- [ ] **Step 8: Run both gates and commit**

```bash
npm run typecheck && npm test
git add test/save-incremental.test.ts CLAUDE.md
git commit -m "test(msdn.3): pin reachability-blindness and record the mutation sweep"
```

- [ ] **Step 9: Close the issues**

```bash
bd close aspose-pdf-foss-for-ts-msdn.2
bd close aspose-pdf-foss-for-ts-msdn.3
```

---

## Not in this plan

- **`msdn.5`** (verify earlier signatures survive an incremental edit) is the external anchor the spec names and is its own issue; it depends on Task 4 landing.
- **`msdn.4`** (`doc.hasIncrementalUpdates` and revision enumeration) is independent of the delta and unblocked already.
- **`x8kx`** (`incremental.ts` appends plaintext objects into an encrypted document) is a live defect in shipped signing. Task 4 refuses encrypted documents on the strength of it; fixing it is separate and should probably come first.
- **A qpdf-checked golden**, which the spec names as the only anchor in CI capable of calling our append malformed. Worth its own issue once Task 4 lands.
- **Delta minimization** beyond "unchanged objects are not written", and compressed appended sections.
