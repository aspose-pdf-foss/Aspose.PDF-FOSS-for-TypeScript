# Trailer Rebuild (dxfk.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When no trailer survives anywhere in a damaged PDF, identify `/Root` and `/Info` from the recovered objects themselves and synthesize a trailer around them, so the file opens with the correct catalog, a walkable page tree and its original metadata.

**Architecture:** A new module `src/rebuild.ts` — the parsing half of recovery, paired with `recover.ts`'s pure byte sweep. It takes plain maps and callbacks and never touches a `Document`. `Document.Open`'s `xrefFailure` branch gains three steps: find `/Encrypt` by shape (for a provisional trailer), build once, then rebuild the real trailer from the parsed objects. `Document.build` gains `/ObjStm` expansion on the recovery path, without which no compressed file can reach its catalog at all.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-10-trailer-rebuild-design.md`
**Predecessor:** `docs/superpowers/specs/2026-08-07-xref-recovery-design.md` (`dxfk.1`, shipped)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension: `import { decodeObjStm } from './objstm.js'`.
- **`strict` TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green before any task is considered done.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.js`. This feature throws `PdfParseError` exclusively — the feature is supported, the file is damaged.
- **`src/rebuild.ts` must not import `./document.js`.** It receives maps and callbacks. That is what makes it unit-testable without building a PDF.
- **No behaviour change for any file that opens today.** Synthesis runs only where `Open` currently throws; `/ObjStm` expansion runs only on the recovery path and only adds entries the map did not have.
- **Run both gates before every commit:** `npm run typecheck` and `npm test`.
- **Commit messages** end with the trailer:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## Vocabulary you will need

From `src/xref.ts`:
```ts
export type XrefEntry =
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; streamObj: number; index: number };
```

From `src/types.ts` (all already used throughout `document.ts`): `PdfObject`, `PdfDict` (a `Map<string, PdfObject>` keyed without the leading `/`), `PdfStream` (`{ kind: 'stream'; dict: PdfDict; raw: Uint8Array }`), and the guards `isDict`, `isArray`, `isName`, `isRef`, `isStream`, plus the constructors `ref(num)` and `name(s)`.

From `src/objstm.ts`: `decodeObjStm(s: PdfStream): Map<number, PdfObject>` — keyed by object number, in the container's header order.

## File Structure

| File | Responsibility |
|---|---|
| `src/rebuild.ts` (create) | Everything that identifies structure by shape: `/ObjStm` expansion, `/Encrypt` discovery, catalog ranking, `/Info` scoring, trailer assembly. Pure functions over maps. |
| `src/document.ts` (modify) | Wiring only: call expansion inside `build`, call discovery + `rebuildTrailer` inside `Open`'s `xrefFailure` branch, carry `TrailerChoice` on `RecoveryReport`. |
| `src/index.ts` (modify) | Add `TrailerChoice` beside the existing `RecoveryReport` export. |
| `test/rebuild.test.ts` (create) | Unit tests on `rebuild.ts` alone — hand-built object maps and fake loaders. No PDF. |
| `test/trailer-rebuild.test.ts` (create) | Integration: damaged files that now open, `/Info` against a decoy, XMP fallback, encryption. |
| `test/xref-recovery.test.ts` (modify) | Two existing tests invert — they asserted the throw this issue removes. |
| `test/helpers/damage-pdf.ts` (modify) | One new damage function: append a second, complete catalog after `%%EOF`. |
| `README.md` (modify) | One sentence on trailer synthesis and the R ≤ 4 encrypted limitation. |

**Import style:** several tasks add exports to `src/rebuild.ts` and then import them in `test/rebuild.test.ts`. Extend the *existing* import statement for that module rather than adding a second one — the test snippets below show only the new specifier for brevity.

---

### Task 1: `expandObjectStreams`

The sweep finds an `/ObjStm` container (it has its own `N G obj` header) but never the objects inside it. This registers them.

**Files:**
- Create: `src/rebuild.ts`
- Create: `test/rebuild.test.ts`

**Interfaces:**
- Consumes: `XrefEntry` from `./xref.js`, `decodeObjStm` from `./objstm.js`.
- Produces: `expandObjectStreams(entries: Map<number, XrefEntry>, load: (num: number) => PdfObject): number[]` — mutates `entries` in place, returns the object numbers it added.

- [ ] **Step 1: Write the failing test**

Create `test/rebuild.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { expandObjectStreams } from '../src/rebuild.js';
import { XrefEntry } from '../src/xref.js';
import { PdfObject, PdfStream, PdfDict } from '../src/types.js';

/** A real /ObjStm stream holding `<< /A 1 >>` as object 7 and `42` as object 8. */
function objStm(): PdfStream {
  const payload = '<< /A 1 >> 42';
  const header = '7 0 8 10 '; // objNum offset pairs; offsets are into the payload
  const data = Buffer.from(header + payload, 'latin1');
  const raw = new Uint8Array(deflateSync(data));
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', { kind: 'name', name: 'ObjStm' }],
    ['N', 2],
    ['First', header.length],
    ['Filter', { kind: 'name', name: 'FlateDecode' }],
    ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}

describe('expandObjectStreams', () => {
  it('registers every object an /ObjStm declares as a compressed entry', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const added = expandObjectStreams(entries, () => objStm());

    expect(added.sort()).toEqual([7, 8]);
    expect(entries.get(7)).toEqual({ type: 'compressed', streamObj: 3, index: 0 });
    expect(entries.get(8)).toEqual({ type: 'compressed', streamObj: 3, index: 1 });
  });

  it('leaves a swept offset entry alone — it was found literally in the file', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
      [7, { type: 'offset', offset: 900, gen: 0 }],
    ]);
    const added = expandObjectStreams(entries, () => objStm());

    expect(added).toEqual([8]);
    expect(entries.get(7)).toEqual({ type: 'offset', offset: 900, gen: 0 });
  });

  it('skips a container that will not decode rather than throwing', () => {
    // Degrading a broken container per-object is dxfk.3, not this issue.
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const added = expandObjectStreams(entries, () => { throw new Error('boom'); });

    expect(added).toEqual([]);
    expect(entries.size).toBe(1);
  });

  it('ignores an object that is not an /ObjStm', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const added = expandObjectStreams(entries, () => new Map<string, PdfObject>([['Type', { kind: 'name', name: 'Catalog' }]]));

    expect(added).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rebuild.test.ts`
Expected: FAIL — `Failed to resolve import "../src/rebuild.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/rebuild.ts`:

```ts
// Rebuilding document structure from recovered objects: the parsing half of
// recovery, paired with recover.ts's pure byte sweep. Everything here
// identifies structure by *shape*, for a file that lost the references that
// would otherwise name it. Takes plain maps and callbacks and never touches a
// Document, so it is testable without building a PDF.

import { XrefEntry } from './xref.js';
import { PdfObject, isName, isStream } from './types.js';
import { decodeObjStm } from './objstm.js';

/** Register every object the /ObjStm containers in `entries` declare, mutating
 *  `entries` in place and returning the object numbers added.
 *
 *  A container carries its own `N G obj` header so the sweep finds it, but the
 *  objects inside carry none and are invisible to any byte scan. Without this,
 *  /Root is unreachable in every file Save({ compressed: true }) produced.
 *
 *  An existing `offset` entry always wins: it was found literally in the file,
 *  whereas the container's header is only a claim about what it holds. A
 *  container that will not decode is skipped, not fatal — degrading a broken
 *  container per-object is issue dxfk.3. */
export function expandObjectStreams(
  entries: Map<number, XrefEntry>,
  load: (num: number) => PdfObject,
): number[] {
  const added: number[] = [];
  for (const [num, e] of [...entries]) {
    if (e.type !== 'offset') continue;
    let contents: Map<number, PdfObject>;
    try {
      const s = load(num);
      if (!isStream(s)) continue;
      const t = s.dict.get('Type');
      if (!isName(t) || t.name !== 'ObjStm') continue;
      contents = decodeObjStm(s);
    } catch {
      continue;
    }
    let index = 0;
    for (const inner of contents.keys()) {
      if (!entries.has(inner)) {
        entries.set(inner, { type: 'compressed', streamObj: num, index });
        added.push(inner);
      }
      index++;
    }
  }
  return added;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rebuild.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/rebuild.ts test/rebuild.test.ts
git commit -m "$(cat <<'EOF'
feat(recover): register the objects an /ObjStm declares (dxfk.2)

A container has its own `N G obj` header so the sweep finds it; the
objects inside carry none. Not yet wired into Open.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Expand `/ObjStm` on the recovery path

Wiring Task 1 into `Document.build`. This alone fixes a live bug: `corruptStartxref` on a compressed file does not open today.

**Files:**
- Modify: `src/document.ts` — inside `Document.build`, between the `failed`/`repaired` declarations and the build loop (currently around line 649)
- Create: `test/trailer-rebuild.test.ts`

**Interfaces:**
- Consumes: `expandObjectStreams` from Task 1.
- Produces: no new signature. `build`'s existing `alternates` parameter is already the recovery-path signal — its doc comment says "it is only ever set on the recovery path" — so no new parameter is needed.

- [ ] **Step 1: Write the failing test**

Create `test/trailer-rebuild.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { corruptStartxref, destroyTrailer, corruptObjectBody } from './helpers/damage-pdf.js';

describe('object-stream expansion on the recovery path', () => {
  it('reaches a catalog that lives inside an /ObjStm', () => {
    // /Root, /Pages and the page dict are all inside an /ObjStm, which carries
    // no `N G obj` header of its own. Without expansion the merged entry map
    // has only the container, and /Root resolves to null.
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    const doc = Document.Open(corruptStartxref(compressed));

    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery?.reason).toBe('startxref-unreadable');
  });

  it('still opens a healthy compressed file without sweeping', () => {
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    expect(Document.Open(compressed).recovery).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: the first test FAILS with `PdfParseError: catalog (Root) is not a dict`. The second passes already. If the first test passes, stop — the fixture is not actually damaged, and the assertion is worthless.

- [ ] **Step 3: Write the implementation**

In `src/document.ts`, add to the import from `./rebuild.js` at the top of the file:

```ts
import { expandObjectStreams } from './rebuild.js';
```

Then in `Document.build`, find these two lines (they sit immediately after the `parseEntry` closure and immediately before the `for (const num of entries.keys())` loop):

```ts
    const failed = new Set<number>();
    const repaired: number[] = [];
```

and insert directly after them:

```ts
    // Recovery path only (`alternates` is set nowhere else): an /ObjStm
    // container has its own `N G obj` header so the sweep finds it, but the
    // objects inside carry none. Register them before the build loop, or /Root
    // is unreachable in every compressed file. This must come *after* the
    // decryptor exists — an /ObjStm payload is encrypted — and parseEntry is
    // the loader that decrypts, which is why it is called here and not earlier.
    if (alternates) repaired.push(...expandObjectStreams(entries, parseEntry));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. `test/xref-recovery.test.ts` in particular must still be entirely green — nothing there changes yet.

- [ ] **Step 6: Commit**

```bash
git add src/document.ts test/trailer-rebuild.test.ts
git commit -m "$(cat <<'EOF'
fix(recover): expand /ObjStm containers when rebuilding an entry map (dxfk.2)

A compressed file whose xref cannot be read had no route to its catalog:
the sweep finds the container, nothing registered its contents, and
/Root resolved to null. Expansion runs after the decryptor, since an
/ObjStm payload is encrypted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `chooseCatalog`

Rank the `/Type /Catalog` candidates. Validated first, then latest.

**Files:**
- Modify: `src/rebuild.ts`
- Modify: `test/rebuild.test.ts`

**Interfaces:**
- Produces:
  - `chooseCatalog(objects: Map<number, PdfObject>, entries: Map<number, XrefEntry>): { root: number; candidates: number[] } | undefined` — `candidates` is every catalog found, ascending by file offset.
  - Module-private `offsetOf(num, entries): number` and `deref(objects, o): PdfObject`, reused by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `test/rebuild.test.ts`:

```ts
import { chooseCatalog } from '../src/rebuild.js';

const nm = (s: string): PdfObject => ({ kind: 'name', name: s });
const rf = (n: number): PdfObject => ({ kind: 'ref', num: n, gen: 0 });

/** A catalog at `num` pointing at `pagesNum`, plus optionally a valid page tree. */
function catalogModel(specs: Array<{ num: number; pages: number; validTree: boolean; offset: number }>) {
  const objects = new Map<number, PdfObject>();
  const entries = new Map<number, XrefEntry>();
  for (const s of specs) {
    objects.set(s.num, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(s.pages)]]));
    entries.set(s.num, { type: 'offset', offset: s.offset, gen: 0 });
    if (s.validTree) {
      objects.set(s.pages, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]]));
      entries.set(s.pages, { type: 'offset', offset: s.offset + 1, gen: 0 });
    }
  }
  return { objects, entries };
}

describe('chooseCatalog', () => {
  it('returns undefined when there is no catalog', () => {
    expect(chooseCatalog(new Map(), new Map())).toBeUndefined();
  });

  it('picks the highest-offset catalog when several are walkable', () => {
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: true, offset: 100 },
      { num: 9, pages: 10, validTree: true, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)).toEqual({ root: 9, candidates: [1, 9] });
  });

  it('prefers a walkable catalog over a later broken one', () => {
    // The tail-truncation case: the newest catalog is precisely the broken one.
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: true, offset: 100 },
      { num: 9, pages: 10, validTree: false, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(1);
  });

  it('falls back to highest offset when no catalog is walkable', () => {
    // Partial salvage beats throwing: the damage rides in doc.recovery.
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: false, offset: 100 },
      { num: 9, pages: 10, validTree: false, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(9);
  });

  it('ranks a compressed catalog by its container offset', () => {
    const objects = new Map<number, PdfObject>([
      [1, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)]])],
      [2, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]])],
      [9, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)]])],
    ]);
    const entries = new Map<number, XrefEntry>([
      [1, { type: 'offset', offset: 100, gen: 0 }],
      [2, { type: 'offset', offset: 200, gen: 0 }],
      [5, { type: 'offset', offset: 9000, gen: 0 }],          // the container
      [9, { type: 'compressed', streamObj: 5, index: 0 }],    // catalog inside it
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rebuild.test.ts`
Expected: FAIL — `chooseCatalog` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/rebuild.ts` (and extend the `./types.js` import to `PdfObject, PdfDict, isDict, isName, isRef, isStream`):

```ts
/** Resolve one level against a recovered object map; a dangling ref is null. */
function deref(objects: Map<number, PdfObject>, o: PdfObject | undefined): PdfObject {
  if (o === undefined) return null;
  return isRef(o) ? objects.get(o.num) ?? null : o;
}

/** File offset of an object, following a compressed one to its container.
 *  -1 when unknown, which sorts below every real offset. */
function offsetOf(num: number, entries: Map<number, XrefEntry>): number {
  const e = entries.get(num);
  if (!e) return -1;
  if (e.type === 'offset') return e.offset;
  const c = entries.get(e.streamObj);
  return c && c.type === 'offset' ? c.offset : -1;
}

/** Identify the document catalog among recovered objects.
 *
 *  Validated first, then latest: keep the candidates whose /Pages resolves to a
 *  /Type /Pages, and among those take the highest file offset — last-wins, as
 *  dxfk.1 does for duplicate candidates, matching append-only incremental
 *  updates. Validation earns its cost on a tail-truncated file, where the
 *  *newest* catalog is precisely the broken one.
 *
 *  With nothing walkable, fall back to plain highest-offset rather than
 *  failing: a document with a damaged page tree should still open, carrying the
 *  damage in doc.recovery. Partial salvage beats nothing. */
export function chooseCatalog(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
): { root: number; candidates: number[] } | undefined {
  const candidates: number[] = [];
  for (const [num, o] of objects) {
    if (!isDict(o)) continue;
    const t = o.get('Type');
    if (isName(t) && t.name === 'Catalog') candidates.push(num);
  }
  if (candidates.length === 0) return undefined;

  const walkable = candidates.filter((n) => {
    const pages = deref(objects, (objects.get(n) as PdfDict).get('Pages'));
    if (!isDict(pages)) return false;
    const t = pages.get('Type');
    return isName(t) && t.name === 'Pages';
  });
  const byOffset = (a: number, b: number) => offsetOf(a, entries) - offsetOf(b, entries);
  const pool = (walkable.length > 0 ? walkable : candidates).slice().sort(byOffset);
  return { root: pool[pool.length - 1], candidates: candidates.slice().sort(byOffset) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rebuild.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/rebuild.ts test/rebuild.test.ts
git commit -m "$(cat <<'EOF'
feat(recover): rank /Type /Catalog candidates, validated then latest (dxfk.2)

A walkable /Pages wins over a later broken one - on a tail-truncated
file the newest catalog is exactly the damaged copy. With none walkable,
fall back to highest offset rather than throwing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `chooseInfo`

`/Info` has no `/Type`. The decisive signal is structural: a valid document never reaches `/Info` from the catalog graph.

**Files:**
- Modify: `src/rebuild.ts`
- Modify: `test/rebuild.test.ts`

**Interfaces:**
- Consumes: `offsetOf` and `deref` from Task 3.
- Produces: `chooseInfo(objects: Map<number, PdfObject>, entries: Map<number, XrefEntry>, root: number): number | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `test/rebuild.test.ts`:

```ts
import { chooseInfo } from '../src/rebuild.js';

describe('chooseInfo', () => {
  /** Catalog 1 -> Outlines 3 -> item 4, which has /Title and no /Type. */
  function modelWithOutline(extra: Array<[number, PdfObject]> = []) {
    const objects = new Map<number, PdfObject>([
      [1, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)], ['Outlines', rf(3)]])],
      [2, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]])],
      [3, new Map<string, PdfObject>([['Type', nm('Outlines')], ['First', rf(4)]])],
      [4, new Map<string, PdfObject>([['Title', { kind: 'string', bytes: new Uint8Array([65]) }], ['Parent', rf(3)]])],
      ...extra,
    ]);
    const entries = new Map<number, XrefEntry>();
    for (const n of objects.keys()) entries.set(n, { type: 'offset', offset: n * 100, gen: 0 });
    return { objects, entries };
  }

  it('does not mistake an outline item for /Info', () => {
    // Object 4 has /Title and no /Type - a key-set test alone matches it. It is
    // reachable from /Root, which is what rules it out.
    const { objects, entries } = modelWithOutline();
    expect(chooseInfo(objects, entries, 1)).toBeUndefined();
  });

  it('finds an unreachable dict carrying /Info keys', () => {
    const info: PdfObject = new Map<string, PdfObject>([
      ['Producer', { kind: 'string', bytes: new Uint8Array([80]) }],
      ['Title', { kind: 'string', bytes: new Uint8Array([84]) }],
    ]);
    const { objects, entries } = modelWithOutline([[9, info]]);
    expect(chooseInfo(objects, entries, 1)).toBe(9);
  });

  it('prefers the candidate carrying more /Info keys', () => {
    const thin: PdfObject = new Map<string, PdfObject>([['Title', { kind: 'string', bytes: new Uint8Array([84]) }]]);
    const rich: PdfObject = new Map<string, PdfObject>([
      ['Producer', { kind: 'string', bytes: new Uint8Array([80]) }],
      ['Creator', { kind: 'string', bytes: new Uint8Array([67]) }],
      ['CreationDate', { kind: 'string', bytes: new Uint8Array([68]) }],
    ]);
    // `thin` sits at the higher offset, so a pure last-wins rule would pick it.
    const { objects, entries } = modelWithOutline([[8, rich], [9, thin]]);
    expect(chooseInfo(objects, entries, 1)).toBe(8);
  });

  it('rejects a dict that declares a /Type', () => {
    const typed: PdfObject = new Map<string, PdfObject>([
      ['Type', nm('Annot')],
      ['Title', { kind: 'string', bytes: new Uint8Array([84]) }],
    ]);
    const { objects, entries } = modelWithOutline([[9, typed]]);
    expect(chooseInfo(objects, entries, 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rebuild.test.ts`
Expected: FAIL — `chooseInfo` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/rebuild.ts` (extend the `./types.js` import with `isArray` and `ref`):

```ts
/** The eight standard /Info entries (32000-1 14.3.3). A candidate must carry at
 *  least one; how many it carries is its score. */
const INFO_KEYS = [
  'Producer', 'Creator', 'CreationDate', 'ModDate',
  'Title', 'Author', 'Subject', 'Keywords',
] as const;

/** Object numbers reachable from `start` by following every ref in the graph. */
function reachableFrom(objects: Map<number, PdfObject>, start: number): Set<number> {
  const seen = new Set<number>();
  const stack: PdfObject[] = [ref(start)];
  while (stack.length > 0) {
    const o = stack.pop() as PdfObject;
    if (isRef(o)) {
      if (seen.has(o.num)) continue;
      seen.add(o.num);
      const v = objects.get(o.num);
      if (v !== undefined) stack.push(v);
    } else if (isArray(o)) {
      for (const v of o) stack.push(v);
    } else if (isDict(o)) {
      for (const v of o.values()) stack.push(v);
    } else if (isStream(o)) {
      for (const v of o.dict.values()) stack.push(v);
    }
  }
  return seen;
}

/** Identify the /Info dict among recovered objects.
 *
 *  /Info has no /Type, so it must be matched on shape - but the decisive signal
 *  is structural rather than lexical: a valid document never reaches /Info from
 *  the catalog graph, since it hangs off the trailer alone. That is what stops
 *  an outline item from winning, which carries /Title and no /Type and which a
 *  key-set test alone matches. An exclusion list of other-dict shapes would
 *  have to stay ahead of every construct in the format; reachability does not.
 *
 *  Among the unreachable, rank by how many /Info keys the dict carries, then by
 *  highest file offset. */
export function chooseInfo(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
  root: number,
): number | undefined {
  const reachable = reachableFrom(objects, root);
  let best: { num: number; score: number; offset: number } | undefined;
  for (const [num, o] of objects) {
    if (reachable.has(num) || !isDict(o) || o.has('Type')) continue;
    let score = 0;
    for (const k of INFO_KEYS) if (o.has(k)) score++;
    if (score === 0) continue;
    const offset = offsetOf(num, entries);
    if (!best || score > best.score || (score === best.score && offset > best.offset)) {
      best = { num, score, offset };
    }
  }
  return best?.num;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rebuild.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/rebuild.ts test/rebuild.test.ts
git commit -m "$(cat <<'EOF'
feat(recover): identify /Info by unreachability from /Root (dxfk.2)

/Info has no /Type and an outline item has /Title and no /Type either,
so a key-set test alone matches the wrong dict. A valid document never
reaches /Info from the catalog graph - that is the discriminator.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `rebuildTrailer`, and the inversion

Assemble the trailer and wire synthesis into `Open`. Two existing tests in `xref-recovery.test.ts` assert the throw this task removes; both invert here.

**Files:**
- Modify: `src/rebuild.ts`
- Modify: `src/document.ts` — `RecoveryReport` (around line 159), `Open`'s `xrefFailure` branch (around lines 436–455), `recoverTrailer` (around lines 516–543)
- Modify: `test/xref-recovery.test.ts` — the two inverting tests
- Modify: `test/trailer-rebuild.test.ts`

**Interfaces:**
- Consumes: `chooseCatalog` (Task 3), `chooseInfo` (Task 4).
- Produces:
  ```ts
  export interface TrailerChoice {
    root: number;
    rootCandidates: number[];
    info?: number;
    infoSource?: 'info-dict' | 'xmp';
  }
  export function rebuildTrailer(
    objects: Map<number, PdfObject>,
    entries: Map<number, XrefEntry>,
    encrypt: { num: number } | undefined,
  ): { trailer: PdfDict; chosen: TrailerChoice };
  ```
  and on `RecoveryReport`, a new optional `trailer?: TrailerChoice`.
- Changed: `Document.recoverTrailer` returns `PdfDict | undefined` and no longer throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/trailer-rebuild.test.ts`:

```ts
describe('trailer synthesis', () => {
  it('opens a file whose trailer keyword is destroyed', () => {
    const good = buildClassicPdf(2, { info: { Title: 'Original', Producer: 'Builder' } });
    const doc = Document.Open(destroyTrailer(good));

    expect(doc.Pages.length).toBe(2);
    expect(doc.Pages[0].GetText()).toBe(Document.Open(good).Pages[0].GetText());
    expect(doc.GetMetadata().title).toBe('Original');
    expect(doc.GetMetadata().producer).toBe('Builder');
  });

  it('reports which objects it chose', () => {
    const good = buildClassicPdf(1, { info: { Title: 'Original' } });
    const doc = Document.Open(destroyTrailer(good));

    expect(doc.recovery!.trailer).toEqual({
      root: 1, rootCandidates: [1], info: 5, infoSource: 'info-dict',
    });
  });

  it('throws with a distinct message when no catalog survives', () => {
    // Object 1 is the catalog; corrupting its body in place means it never
    // parses, so there is no /Type /Catalog anywhere to synthesize around.
    const pdf = corruptStartxref(corruptObjectBody(buildClassicPdf(2), 1));
    expect(() => Document.Open(pdf)).toThrow(/no \/Type \/Catalog object found/);
  });

  it('prefers a surviving trailer over synthesis', () => {
    // The trailer keyword is intact here, so recoverTrailer wins and nothing is
    // synthesized. Red if synthesis is ever tried first.
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    expect(doc.recovery).toBeDefined();
    expect(doc.recovery!.trailer).toBeUndefined();
  });
});
```

> **Note on `info: 5`:** `buildClassicPdf(1, { info })` lays out 1=Catalog, 2=Pages, 3=Page, 4=Contents, 5=Info. If the builder's layout differs, read the number off the failure and correct the expectation — but keep the assertion exact, not `expect.any(Number)`. The point of the test is that the choice is deterministic.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: the four new tests FAIL — the first three with `PdfParseError: objects found but no trailer with a /Root`, the fourth because `recovery!.trailer` does not exist yet (it will actually pass, since `undefined === undefined`; that is fine, it is a guard test).

- [ ] **Step 3: Add `rebuildTrailer` to `src/rebuild.ts`**

Extend the imports with `PdfParseError` from `./errors.js`, then append:

```ts
/** What trailer synthesis chose. Surfaced verbatim as RecoveryReport.trailer,
 *  rather than re-declared there, so the two spellings cannot drift. */
export interface TrailerChoice {
  root: number;
  /** Every /Type /Catalog found, ascending by offset, so a caller can see the
   *  ambiguity: "one catalog, obvious" reads differently from "three, we took
   *  the last". */
  rootCandidates: number[];
  info?: number;
  infoSource?: 'info-dict' | 'xmp';
}

/** Synthesize a trailer for a file that has none left anywhere.
 *
 *  Throws PdfParseError when no catalog exists. That is a *third* message
 *  alongside dxfk.1's two, not a replacement: 'no indirect objects found' still
 *  fires first on an empty sweep, and the three form a ladder - nothing in the
 *  file, objects but no catalog, catalog found. */
export function rebuildTrailer(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
  encrypt: { num: number } | undefined,
): { trailer: PdfDict; chosen: TrailerChoice } {
  const cat = chooseCatalog(objects, entries);
  if (!cat) throw new PdfParseError('no /Type /Catalog object found');

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(cat.root)]]);
  if (encrypt) trailer.set('Encrypt', ref(encrypt.num));
  const chosen: TrailerChoice = { root: cat.root, rootCandidates: cat.candidates };

  const info = chooseInfo(objects, entries, cat.root);
  if (info !== undefined) {
    trailer.set('Info', ref(info));
    chosen.info = info;
    chosen.infoSource = 'info-dict';
  }
  return { trailer, chosen };
}
```

- [ ] **Step 4: Make `recoverTrailer` return `undefined` instead of throwing**

In `src/document.ts`, replace the `throw new PdfParseError(...)` at the end of `recoverTrailer` with `return undefined;`, and change the return type. The whole method becomes:

```ts
  /** Find a trailer that still exists in the file: a `trailer` keyword first,
   *  then the dict of a /Type /XRef stream — the only route for an xref-stream
   *  file, which has no `trailer` keyword anywhere. Returns undefined when
   *  neither survives, which is the case trailer synthesis handles. */
  private static recoverTrailer(
    buf: Uint8Array, sweep: SweepResult, entries: Map<number, XrefEntry>,
  ): PdfDict | undefined {
    for (const at of sweep.trailerOffsets) {
      try {
        const d = new ObjectParser(new Lexer(buf, at)).parseObject();
        if (isDict(d) && d.get('Root') !== undefined) return d;
      } catch { /* try the next one */ }
    }
    for (const e of entries.values()) {
      if (e.type !== 'offset') continue;
      try {
        const v = new ObjectParser(new Lexer(buf, e.offset)).parseIndirectObject().value;
        if (!isStream(v)) continue;
        const t = v.dict.get('Type');
        if (isName(t) && t.name === 'XRef' && v.dict.get('Root') !== undefined) return v.dict;
      } catch { /* try the next one */ }
    }
    return undefined;
  }
```

- [ ] **Step 5: Add the report field**

In `src/document.ts`, add to `RecoveryReport` (after `lost`):

```ts
  /** Present only when no trailer survived and one was rebuilt from the
   *  objects; describes what synthesis chose. */
  trailer?: TrailerChoice;
```

and extend the `./rebuild.js` import:

```ts
import { expandObjectStreams, rebuildTrailer, TrailerChoice } from './rebuild.js';
```

- [ ] **Step 6: Wire synthesis into `Open`**

Replace the whole `if (xrefFailure) { ... }` block in `Document.Open` with:

```ts
    if (xrefFailure) {
      const sweep = sweepObjects(buf);
      // dxfk.1's first message, preserved: "nothing in the file" and "objects
      // but no catalog" mean very different things to a caller.
      if (sweep.candidates.size === 0) throw new PdfParseError('no indirect objects found');
      const merged = new Map<number, XrefEntry>();
      for (const [num, list] of sweep.candidates) {
        const c = list[list.length - 1];
        merged.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
      }
      // A surviving trailer always wins; synthesis runs only when there is none.
      const existing = Document.recoverTrailer(buf, sweep, merged);
      // The trailer's only role inside build() is /Encrypt and /ID, so an empty
      // provisional is enough to parse the whole document and assemble the real
      // trailer afterwards from what that one pass produced.
      const provisional: PdfDict = existing ?? new Map<string, PdfObject>();
      const pass = Document.build(buf, merged, provisional, opts, sweep.candidates);
      let trailer = existing;
      if (!trailer) {
        const rebuilt = rebuildTrailer(pass.objects, merged, undefined);
        trailer = rebuilt.trailer;
        xrefFailure.trailer = rebuilt.chosen;
      }
      xrefFailure.repaired = [...merged.keys()];
      xrefFailure.lost = [...pass.failed];
      const doc = new Document(pass.objects, trailer);
      doc.originalBytes = buf;
      doc.permissions = pass.permissions;
      doc.recovery = xrefFailure;
      return doc;
    }
```

- [ ] **Step 7: Run the new tests**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Invert the two tests that asserted the old throw**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: FAIL — two tests. Both asserted behaviour this issue deliberately removes.

In `test/xref-recovery.test.ts`, replace:

```ts
  it('refuses a file with no trailer anywhere, leaving synthesis to dxfk.2', () => {
    // destroyTrailer removes the keyword itself, so there is nothing to recover:
    // rebuilding /Root by finding the /Type /Catalog object is out of scope here.
    expect(() => Document.Open(destroyTrailer(buildClassicPdf(2))))
      .toThrow(/no trailer with a \/Root/);
  });
```

with:

```ts
  it('synthesizes a trailer when the keyword itself is gone (dxfk.2)', () => {
    // destroyTrailer removes the keyword, so nothing survives to recover and
    // /Root is rebuilt by finding the /Type /Catalog object.
    const doc = Document.Open(destroyTrailer(buildClassicPdf(2)));
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery!.trailer!.root).toBe(1);
  });
```

and in the `strictness` block replace:

```ts
  it('still throws when the damage leaves no trailer at all', () => {
    expect(() => Document.Open(truncateTail(buildClassicPdf(2), 40))).toThrow(PdfParseError);
  });
```

with:

```ts
  it('salvages a tail-truncated file by synthesizing a trailer', () => {
    // The xref, the trailer and the tail of the file are gone; every object
    // survives, so synthesis reaches the catalog.
    const doc = Document.Open(truncateTail(buildClassicPdf(2), 40));
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery!.trailer!.root).toBe(1);
  });
```

> If `truncateTail(…, 40)` leaves enough of the trailer dict to parse, `recovery!.trailer` is undefined and this fails. In that case raise the byte count until the `trailer` dict no longer parses (try 60, then 80) — do **not** weaken the assertion. Confirm the file is still genuinely damaged by checking `doc.recovery` is defined.

- [ ] **Step 9: Add the multi-catalog damage helper**

The acceptance criterion is that a multi-candidate choice is deterministic, which needs a fixture with more than one catalog. Append to `test/helpers/damage-pdf.ts`:

```ts
/** Append a second, complete catalog after %%EOF, as an incremental update
 *  would. The sweep finds both; `pagesNum` decides whether the new one has a
 *  walkable page tree. */
export function appendCatalog(
  pdf: Uint8Array, objNum: number, pagesNum: number,
): Uint8Array {
  return asBytes(
    `${asText(pdf)}\n${objNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`,
  );
}
```

- [ ] **Step 10: Write the multi-catalog and decoy tests**

Append to `test/trailer-rebuild.test.ts`, extending its imports with `appendCatalog` from `./helpers/damage-pdf.js`:

```ts
describe('several catalog candidates', () => {
  it('takes the latest one when both are walkable', () => {
    // Object 2 is the page tree in buildClassicPdf, so catalog 99 is walkable
    // and sits at a higher offset than catalog 1.
    const pdf = destroyTrailer(appendCatalog(buildClassicPdf(2), 99, 2));
    const doc = Document.Open(pdf);

    expect(doc.recovery!.trailer!.root).toBe(99);
    expect(doc.recovery!.trailer!.rootCandidates).toEqual([1, 99]);
    expect(doc.Pages.length).toBe(2);
  });

  it('takes the earlier walkable one when the latest points nowhere', () => {
    // Object 77 does not exist, so catalog 99 has no page tree. The
    // tail-truncation case: the newest catalog is the broken one.
    const pdf = destroyTrailer(appendCatalog(buildClassicPdf(2), 99, 77));
    const doc = Document.Open(pdf);

    expect(doc.recovery!.trailer!.root).toBe(1);
    expect(doc.recovery!.trailer!.rootCandidates).toEqual([1, 99]);
    expect(doc.Pages.length).toBe(2);
  });
});

describe('/Info against a real outline', () => {
  it('does not mistake an outline item for /Info', () => {
    // An outline item carries /Title and no /Type, so a key-set test alone
    // matches it. It is reachable from /Root, which is what rules it out.
    const src = Document.Open(buildClassicPdf(1, { info: { Title: 'The Document' } }));
    src.SetOutlines([{ Title: 'Chapter One' }, { Title: 'Chapter Two' }]);
    const doc = Document.Open(destroyTrailer(src.Save()));

    expect(doc.GetMetadata().title).toBe('The Document');
    expect(doc.recovery!.trailer!.infoSource).toBe('info-dict');
  });
});
```

- [ ] **Step 11: Run the new tests**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 12: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 13: Commit**

```bash
git add src/rebuild.ts src/document.ts test/trailer-rebuild.test.ts test/xref-recovery.test.ts test/helpers/damage-pdf.ts
git commit -m "$(cat <<'EOF'
feat(open): synthesize a trailer when none survives in the file (dxfk.2)

A file whose trailer keyword is destroyed now opens: /Root comes from
the /Type /Catalog object and /Info from the unreachable dict carrying
metadata keys. doc.recovery.trailer reports both choices and every
catalog candidate considered.

recoverTrailer returns undefined instead of throwing; 'no indirect
objects found' moves up to Open so an empty sweep still says that rather
than 'no catalog'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: XMP fallback for `/Info`

When no dict scores, recover metadata from the `/Root /Metadata` packet instead.

**Files:**
- Modify: `src/rebuild.ts`
- Modify: `test/trailer-rebuild.test.ts`

**Interfaces:**
- Consumes: `readXmp` from `./xmp.js`, `mirrorXmpToMeta` from `./xmp.js`, `applyUpdate` from `./metadata.js`, `inflateStream` from `./flate.js`.
- Produces: no new export. `rebuildTrailer` may now allocate one new object (the synthesized `/Info` dict) into `objects`, and sets `chosen.infoSource = 'xmp'`.

- [ ] **Step 1: Write the failing test**

Append to `test/trailer-rebuild.test.ts`:

```ts
describe('/Info recovered from XMP', () => {
  it('falls back to the /Root /Metadata packet when no /Info dict survives', () => {
    const src = Document.Open(buildClassicPdf(1));
    src.SetXmp({ title: 'From XMP', producer: 'XMP Producer' });
    // SetXmp mirrors into /Info; unlink it so only the XMP packet carries the
    // metadata. Save()'s mark-sweep then drops the orphaned dict.
    src.trailer.delete('Info');
    const pdf = src.Save();

    const doc = Document.Open(destroyTrailer(pdf));
    expect(doc.recovery!.trailer!.infoSource).toBe('xmp');
    expect(doc.GetMetadata().title).toBe('From XMP');
    expect(doc.GetMetadata().producer).toBe('XMP Producer');
  });

  it('leaves /Info absent when there is neither a dict nor XMP', () => {
    const doc = Document.Open(destroyTrailer(buildClassicPdf(1)));
    expect(doc.recovery!.trailer!.info).toBeUndefined();
    expect(doc.recovery!.trailer!.infoSource).toBeUndefined();
    expect(doc.GetMetadata().title).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: the first FAILS (`infoSource` is undefined); the second passes already.

- [ ] **Step 3: Write the implementation**

In `src/rebuild.ts`, add the imports:

```ts
import { readXmp, mirrorXmpToMeta } from './xmp.js';
import { applyUpdate } from './metadata.js';
import { inflateStream } from './flate.js';
```

Add the helper:

```ts
/** Build an /Info dict from the catalog's XMP packet, for a document that lost
 *  its /Info entirely. Reuses the mirror xmp.ts already applies for SetXmp, so
 *  this introduces no second mapping of the shared fields. Undefined when there
 *  is no packet, it will not decode, or it carries none of the shared fields. */
function infoFromXmp(
  objects: Map<number, PdfObject>, root: number,
): PdfDict | undefined {
  const catalog = objects.get(root);
  if (!isDict(catalog)) return undefined;
  const md = deref(objects, catalog.get('Metadata'));
  if (!isStream(md)) return undefined;
  const info: PdfDict = new Map<string, PdfObject>();
  try {
    applyUpdate(info, mirrorXmpToMeta(readXmp(inflateStream(md))));
  } catch {
    return undefined;
  }
  return info.size > 0 ? info : undefined;
}
```

Then in `rebuildTrailer`, replace the `/Info` block with:

```ts
  const info = chooseInfo(objects, entries, cat.root);
  if (info !== undefined) {
    trailer.set('Info', ref(info));
    chosen.info = info;
    chosen.infoSource = 'info-dict';
  } else {
    const fromXmp = infoFromXmp(objects, cat.root);
    if (fromXmp) {
      let num = 0;
      for (const n of objects.keys()) if (n > num) num = n;
      num += 1;
      objects.set(num, fromXmp);
      trailer.set('Info', ref(num));
      chosen.info = num;
      chosen.infoSource = 'xmp';
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/trailer-rebuild.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full suite, typecheck, commit**

```bash
npm run typecheck && npm test
git add src/rebuild.ts test/trailer-rebuild.test.ts
git commit -m "$(cat <<'EOF'
feat(recover): rebuild /Info from the XMP packet when no dict survives (dxfk.2)

Reuses the readXmp -> mirrorXmpToMeta -> applyUpdate chain SetXmp
already applies, so no second mapping of the shared fields enters the
codebase. Reported as infoSource: 'xmp'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Encryption without a trailer

A lost trailer takes `/Encrypt` and `/ID` with it. The reference is recoverable by shape; whether `/ID` matters depends on the handler.

**Files:**
- Modify: `src/rebuild.ts`
- Modify: `src/document.ts` — `Open`'s `xrefFailure` branch
- Modify: `test/rebuild.test.ts`, `test/trailer-rebuild.test.ts`

**Interfaces:**
- Produces: `findEncryptDict(entries: Map<number, XrefEntry>, loadRaw: (num: number) => PdfObject): { num: number; dict: PdfDict } | undefined`.
- Changed: `rebuildTrailer`'s third argument is now supplied (it has accepted `encrypt` since Task 5 and has been passed `undefined` until now).

- [ ] **Step 1: Write the failing tests**

Append to `test/rebuild.test.ts`:

```ts
import { findEncryptDict } from '../src/rebuild.js';

describe('findEncryptDict', () => {
  const standard = (r: number): PdfObject => new Map<string, PdfObject>([
    ['Filter', nm('Standard')], ['V', 5], ['R', r],
    ['O', { kind: 'string', bytes: new Uint8Array(48) }],
    ['U', { kind: 'string', bytes: new Uint8Array(48) }],
    ['P', -4],
  ]);

  it('finds a standard-handler dict by shape', () => {
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => standard(6))!.num).toBe(7);
  });

  it('finds an Adobe.PubSec dict', () => {
    const pubsec: PdfObject = new Map<string, PdfObject>([
      ['Filter', nm('Adobe.PubSec')], ['Recipients', []],
    ]);
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => pubsec)!.num).toBe(7);
  });

  it('ignores a dict that declares a /Type', () => {
    const decoy: PdfObject = new Map<string, PdfObject>([['Type', nm('Filespec')], ['Filter', nm('Standard')]]);
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => decoy)).toBeUndefined();
  });

  it('survives an object that will not parse', () => {
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => { throw new Error('boom'); })).toBeUndefined();
  });
});
```

Append to `test/trailer-rebuild.test.ts`:

```ts
describe('encrypted documents with no trailer', () => {
  it('recovers an AES-256 document — R6 derives its key without /ID', () => {
    const enc = Document.Open(buildClassicPdf(1))
      .Save({ encrypt: { algorithm: 'aes256', userPassword: 'pw' } });
    const doc = Document.Open(destroyTrailer(enc), { password: 'pw' });

    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery!.trailer!.root).toBeGreaterThan(0);
  });

  it('refuses AES-128, naming /ID rather than reporting a wrong password', () => {
    const enc = Document.Open(buildClassicPdf(1))
      .Save({ encrypt: { algorithm: 'aes128', userPassword: 'pw' } });

    // The regression this message exists to prevent: fileKeyR234 hashes id0, so
    // an empty one fails /U validation and InvalidPasswordError is thrown for a
    // correct password, sending the caller hunting in the wrong place.
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .toThrow(/\/ID was lost with the trailer/);
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .not.toThrow(InvalidPasswordError);
  });

  it('refuses RC4 the same way', () => {
    const enc = Document.Open(buildClassicPdf(1))
      .Save({ encrypt: { algorithm: 'rc4', userPassword: 'pw' } });
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .toThrow(/\/ID was lost with the trailer/);
  });
});
```

and extend that file's imports:

```ts
import { InvalidPasswordError } from '../src/errors.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rebuild.test.ts test/trailer-rebuild.test.ts`
Expected: FAIL — `findEncryptDict` is not exported; the AES-256 test fails because the streams are never decrypted; the AES-128 and RC4 tests fail with `InvalidPasswordError`.

- [ ] **Step 3: Add `findEncryptDict` to `src/rebuild.ts`**

```ts
/** Find the /Encrypt dict by shape, for a file that lost the reference to it
 *  with its trailer. It is never itself encrypted, so `loadRaw` need not
 *  decrypt — and it is never inside an /ObjStm, so only offset entries are
 *  scanned. Requiring the handler's own keys keeps an unrelated dict carrying a
 *  /Filter (a stream dict, a filespec) from matching. */
export function findEncryptDict(
  entries: Map<number, XrefEntry>,
  loadRaw: (num: number) => PdfObject,
): { num: number; dict: PdfDict } | undefined {
  for (const [num, e] of entries) {
    if (e.type !== 'offset') continue;
    let d: PdfObject;
    try {
      d = loadRaw(num);
    } catch {
      continue;
    }
    if (!isDict(d) || d.has('Type')) continue;
    const f = d.get('Filter');
    if (!isName(f)) continue;
    if (f.name === 'Standard') {
      if (['V', 'R', 'O', 'U', 'P'].every((k) => d.has(k))) return { num, dict: d };
    } else if (f.name === 'Adobe.PubSec') {
      if (d.has('Recipients') || d.has('CF')) return { num, dict: d };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Wire it into `Open`**

Extend the `./rebuild.js` import with `findEncryptDict`. In the `xrefFailure` branch, replace the three lines from `const existing = …` through `const pass = …` with:

```ts
      // A surviving trailer always wins; synthesis runs only when there is none.
      const existing = Document.recoverTrailer(buf, sweep, merged);
      // With no trailer there is no /Encrypt reference and no /ID. The dict is
      // findable by shape; /ID is not findable at all, and whether that is fatal
      // depends on the handler: R>=5 (AES-256) and PubSec derive their key
      // without it, R<=4 hashes it into the key and cannot.
      let encrypt: { num: number; dict: PdfDict } | undefined;
      if (!existing) {
        encrypt = findEncryptDict(merged, (n) => {
          const e = merged.get(n);
          if (!e || e.type !== 'offset') return null;
          return new ObjectParser(new Lexer(buf, e.offset)).parseIndirectObject().value;
        });
        const filter = encrypt?.dict.get('Filter');
        const R = encrypt?.dict.get('R');
        if (isName(filter) && filter.name === 'Standard' && typeof R === 'number' && R <= 4) {
          throw new PdfParseError(
            `cannot recover an encrypted document (revision ${R}): /ID was lost with `
            + 'the trailer and is required to derive the file key',
          );
        }
      }
      const provisional: PdfDict = existing ?? new Map<string, PdfObject>();
      if (encrypt) provisional.set('Encrypt', ref(encrypt.num));
      const pass = Document.build(buf, merged, provisional, opts, sweep.candidates);
```

and change the `rebuildTrailer` call from `rebuildTrailer(pass.objects, merged, undefined)` to:

```ts
        const rebuilt = rebuildTrailer(pass.objects, merged, encrypt);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/rebuild.test.ts test/trailer-rebuild.test.ts`
Expected: PASS, 17 + 14 tests.

- [ ] **Step 6: Run the full suite, typecheck, commit**

```bash
npm run typecheck && npm test
git add src/rebuild.ts src/document.ts test/rebuild.test.ts test/trailer-rebuild.test.ts
git commit -m "$(cat <<'EOF'
feat(recover): recover /Encrypt by shape; gate the revisions that need /ID (dxfk.2)

A lost trailer takes the /Encrypt reference and /ID with it. The dict is
findable by shape. fileKeyR56 takes no id0, so AES-256 and PubSec
recover fully; R<=4 hashes it into the key and now fails naming /ID
instead of reporting a wrong password for a correct one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Exports, docs, and mutation verification

Prove the new assertions are load-bearing, then close the issue. Per CLAUDE.md: a fixture usually passes on the first run, and that is not evidence.

**Files:**
- Modify: `src/index.ts` (around line 11)
- Modify: `README.md`

- [ ] **Step 1: Export `TrailerChoice`**

In `src/index.ts`, find the existing export line containing `RecoveryReport` and add `TrailerChoice` beside it:

```ts
  PubSecRecipient, RecoveryReport, TrailerChoice,
```

`TrailerChoice` is declared in `rebuild.ts` and re-exported through `document.ts`; confirm `document.ts` re-exports it (`export type { TrailerChoice } from './rebuild.js';` near the `RecoveryReport` declaration) so the `index.ts` specifier resolves. Run `npm run typecheck` and fix the specifier if it does not.

- [ ] **Step 2: Update the README**

Find the recovery paragraph added by `dxfk.1` (search for `doc.recovery`) and append:

```markdown
When no trailer survives anywhere in the file, `Open` rebuilds one: `/Root` is
the `/Type /Catalog` object with a walkable `/Pages` at the highest file offset,
and `/Info` is the metadata-bearing dict the catalog graph does not reach (or,
failing that, the XMP packet). `doc.recovery.trailer` reports both choices and
every catalog candidate considered. An encrypted document is the one case that
cannot be recovered this way: the trailer carried `/ID`, and RC4 and AES-128
hash it into the file key. AES-256 and certificate-based encryption derive their
keys without it and recover normally.
```

- [ ] **Step 3: Verify each new path is load-bearing**

For each mutation below, apply it, run the named test, confirm **RED**, then revert. Record the results — a mutation that stays green means the test is not testing what it claims.

| Mutation | Test that must go red |
|---|---|
| In `expandObjectStreams`, `return []` immediately | `trailer-rebuild.test.ts` → "reaches a catalog that lives inside an /ObjStm" |
| In `chooseCatalog`, drop the `walkable` filter (always use `candidates`) | `rebuild.test.ts` → "prefers a walkable catalog over a later broken one" |
| In `chooseInfo`, replace `reachable.has(num)` with `false` | `rebuild.test.ts` → "does not mistake an outline item for /Info" |
| In `chooseInfo`, return the first match instead of the highest score | `rebuild.test.ts` → "prefers the candidate carrying more /Info keys" |
| In `rebuildTrailer`, skip the `infoFromXmp` branch | `trailer-rebuild.test.ts` → "falls back to the /Root /Metadata packet" |
| In `chooseCatalog`, take `pool[0]` instead of the last | `trailer-rebuild.test.ts` → "takes the latest one when both are walkable" |
| In `Open`, drop the `R <= 4` guard | `trailer-rebuild.test.ts` → "refuses AES-128, naming /ID" |
| In `Open`, remove the `sweep.candidates.size === 0` guard | the empty-sweep test added in the next step |

The last row needs a test that does not exist yet — `dxfk.1` asserted that message from inside `recoverTrailer`, which no longer throws. Add it to `test/trailer-rebuild.test.ts` before running the mutation:

```ts
describe('the error ladder', () => {
  it('says nothing was found, not that no catalog was found', () => {
    // Three distinct messages: nothing in the file, objects but no catalog,
    // catalog found. Collapsing the first two tells a caller with a truncated
    // download the same thing as a caller with a shredded catalog.
    expect(() => Document.Open(new Uint8Array([0x25, 0x50, 0x44, 0x46])))
      .toThrow(/no indirect objects found/);
  });
});
```

- [ ] **Step 4: Confirm the damaged fixtures are genuinely damaged**

For each fixture used in `trailer-rebuild.test.ts`, `git stash` the `src/` changes and confirm the original `Document.Open` throws on it. A synthesis test that passes because a trailer was still findable is the easy accident here.

```bash
git stash push src/
npx vitest run test/trailer-rebuild.test.ts   # expect failures on every new test
git stash pop
```

- [ ] **Step 5: Final gates**

```bash
npm run typecheck && npm test && npm run build
```
Expected: all three green.

- [ ] **Step 6: Commit and close the issue**

```bash
git add src/index.ts README.md
git commit -m "$(cat <<'EOF'
docs(recover): document trailer synthesis; export TrailerChoice (dxfk.2)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
bd close aspose-pdf-foss-for-ts-dxfk.2
git pull --rebase && git push && git status
```

`git status` must report the branch up to date with origin. Per CLAUDE.md, the work is not complete until the push succeeds.
