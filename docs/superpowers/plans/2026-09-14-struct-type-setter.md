# Writable structure type (`q7hc.1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `StructElement`'s structure type writable, validate every type
against the standard set and the `/RoleMap` wherever one is written, and rewrite
the marked-content `BDC` tag behind a retyped element.

**Architecture:** A new pure leaf `structtype.ts` owns the standard-type set,
the RoleMap walk and the validator, because `struct.ts` imports `structwrite.ts`
by value and reaching back would close a value-import 2-cycle. `visitContent`
gains a `marked` event fired at a `BDC` carrying an `/MCID`, which is how
`structwrite.ts` locates the ops to rewrite through `EditableContent`'s existing
copy-on-write.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-14-struct-type-setter-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only; add no npm runtime dep.
- **ESM + NodeNext.** Every relative import specifier carries the `.js`
  extension (`import { x } from './structtype.js'`).
- **`npm run typecheck` and `npm test` must both be green before any task is
  considered done.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`,
  `InvalidPasswordError` from `errors.ts`. Argument rejection uses the built-in
  `TypeError` (wrong *kind* of thing) / `RangeError` (outside the allowed *set*)
  split this repo already follows in `formcreate.ts`.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing the issue id `q7hc.1` in parentheses at the
  end of the entry.
- **A new `src/*.ts` module earns an entry in CLAUDE.md's Source list when it
  lands,** not later. The sweep that checks this must print nothing:
  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
  done
  ```
- **Never edit `test/import-cycles.test.ts`'s `KNOWN` list to make a build
  green.** A new pair there means the edge you added closed a cycle; fix the
  edge.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/structtype.ts` | **Create.** Pure leaf: the standard-type set, `resolveRole`, `checkStructType`. Imports nothing. |
| `src/struct.ts` | **Modify.** Re-export the constant; `ResolveRole` delegates; `SetType` / `set Type`; pass the RoleMap to `createElement`. |
| `src/structwrite.ts` | **Modify.** `createElement` validates before allocating; new `retagContentItems` + `StructRetagResult`. |
| `src/text.ts` | **Modify.** `MarkedContentEvent` + `ContentVisitor.marked`, fired from the `BDC` branch. |
| `src/index.ts` | **Modify.** Export the `StructRetagResult` type. |
| `test/structtype.test.ts` | **Create.** Unit rules over the leaf; no PDF built. |
| `test/struct-retype.test.ts` | **Create.** Validation, `SetType`, the BDC rewrite, fail-open. |
| `test/helpers/build-nested-mc-pdf.ts` | **Create.** Hand-built tagged pages whose `BDC` sits inside a Form XObject, one of them shared by two pages. |
| `test/struct-ua.test.ts` | **Create.** The `/Alt`-clears-`IllustrationAlt` regression. |

---

### Task 1: The `structtype.ts` leaf

Moves the standard-type set and the RoleMap walk into a pure leaf and adds the
validator. **No behaviour change** — nothing calls `checkStructType` yet.

**Files:**
- Create: `src/structtype.ts`
- Modify: `src/struct.ts` (the `STANDARD_STRUCTURE_TYPES` block at lines 15-28,
  and `StructTreeRoot.ResolveRole` at lines 464-474)
- Modify: `CLAUDE.md` (Source list)
- Test: `test/structtype.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string>;
  export function resolveRole(role: string, roleMap: ReadonlyMap<string, string>): string;
  export function checkStructType(type: unknown, roleMap: ReadonlyMap<string, string>): string;
  ```
  `checkStructType` returns the type unchanged so a call site can write
  `name(checkStructType(type, roleMap))`.

- [ ] **Step 1: Write the failing test**

Create `test/structtype.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  STANDARD_STRUCTURE_TYPES, resolveRole, checkStructType,
} from '../src/structtype.js';

const NO_ROLES: ReadonlyMap<string, string> = new Map();

describe('structtype: the standard set', () => {
  it('holds the 49 PDF 1.7 standard structure types', () => {
    expect(STANDARD_STRUCTURE_TYPES.size).toBe(49);
    for (const t of ['Document', 'P', 'H1', 'TD', 'Span', 'Figure', 'Formula'])
      expect(STANDARD_STRUCTURE_TYPES.has(t)).toBe(true);
  });

  it('does not hold a name that merely looks like one', () => {
    expect(STANDARD_STRUCTURE_TYPES.has('H7')).toBe(false);
    expect(STANDARD_STRUCTURE_TYPES.has('Paragraph')).toBe(false);
  });
});

describe('structtype: resolveRole', () => {
  it('returns a standard type unchanged', () => {
    expect(resolveRole('P', NO_ROLES)).toBe('P');
  });

  it('follows a one-hop mapping', () => {
    expect(resolveRole('Subtitle', new Map([['Subtitle', 'P']]))).toBe('P');
  });

  it('follows a chain to the first standard type', () => {
    const rm = new Map([['Deck', 'Subtitle'], ['Subtitle', 'P']]);
    expect(resolveRole('Deck', rm)).toBe('P');
  });

  it('stops on an unmapped name rather than inventing one', () => {
    expect(resolveRole('Nonsense', NO_ROLES)).toBe('Nonsense');
  });

  // A self-referential or mutually-referential /RoleMap is a file we did not
  // write; it must terminate rather than hang.
  it('stops on a cycle', () => {
    expect(resolveRole('A', new Map([['A', 'B'], ['B', 'A']]))).toBe('A');
  });

  // A standard type SHADOWED by a RoleMap entry keeps its own meaning: the walk
  // tests the standard set first, so a file remapping /P cannot make every
  // paragraph in the document resolve somewhere else.
  it('prefers the standard set over a shadowing RoleMap entry', () => {
    expect(resolveRole('P', new Map([['P', 'Span']]))).toBe('P');
  });
});

describe('structtype: checkStructType', () => {
  it('accepts a standard type and returns it unchanged', () => {
    expect(checkStructType('H1', NO_ROLES)).toBe('H1');
  });

  it('accepts a custom type the RoleMap resolves', () => {
    expect(checkStructType('Subtitle', new Map([['Subtitle', 'P']]))).toBe('Subtitle');
  });

  it('rejects an unmapped custom type with a RangeError', () => {
    expect(() => checkStructType('Nonsense', NO_ROLES)).toThrow(RangeError);
    expect(() => checkStructType('Nonsense', NO_ROLES)).toThrow(/RegisterRole/);
  });

  it('rejects a custom type whose chain does not reach a standard type', () => {
    expect(() => checkStructType('Deck', new Map([['Deck', 'Subtitle']]))).toThrow(RangeError);
  });

  // Wrong KIND of thing, not a thing outside the allowed set — formcreate.ts's
  // split. An empty name is not a PDF name at all.
  it('rejects a non-string or empty type with a TypeError', () => {
    expect(() => checkStructType('', NO_ROLES)).toThrow(TypeError);
    expect(() => checkStructType(undefined, NO_ROLES)).toThrow(TypeError);
    expect(() => checkStructType(7 as unknown, NO_ROLES)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/structtype.test.ts`
Expected: FAIL — `Failed to resolve import "../src/structtype.js"`.

- [ ] **Step 3: Create the leaf**

Create `src/structtype.ts`:

```ts
/** What may be a structure type, and what a custom one resolves to.
 *
 *  **Invariant:** a pure LEAF importing NOTHING — a set, a map and a string —
 *  so every rule here is testable with no PDF built. It is a module rather
 *  than part of `struct.ts` because TWO consumers need it and neither may
 *  reach the other: `struct.ts` imports `structwrite.ts` by VALUE while
 *  `structwrite.ts` imports `StructElement` as a TYPE only, so a value import
 *  back would close the first `struct.ts` <-> `structwrite.ts` 2-cycle, which
 *  `test/import-cycles.test.ts` fences as a red build. The extraction
 *  `colornames.ts`, `preformat.ts`, `bordersides.ts`, `datauri.ts` and
 *  `langmatch.ts` each already made. */

/** The PDF 1.7 standard structure types (grouping, block-level, inline-level,
 *  and illustration). Used by IsStandardType and to terminate RoleMap chains. */
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  // Grouping
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
  'TOCI', 'Index', 'NonStruct', 'Private',
  // Block-level
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  // Inline-level
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  // Illustration
  'Figure', 'Formula', 'Form',
]);

/** Follow the RoleMap chain from `role` to a standard structure type.
 *  Stops at the first standard type, at an unmapped name, or on a cycle.
 *
 *  **Invariant:** the standard set is tested BEFORE the map, so a file whose
 *  /RoleMap shadows a standard type cannot change what that type means. */
export function resolveRole(role: string, roleMap: ReadonlyMap<string, string>): string {
  let cur = role;
  const seen = new Set<string>();
  while (!STANDARD_STRUCTURE_TYPES.has(cur) && roleMap.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = roleMap.get(cur)!;
  }
  return cur;
}

/** Throw unless `type` is a standard structure type or the /RoleMap resolves it
 *  to one; returns it unchanged so a caller can write `name(checkStructType(…))`.
 *
 *  **Invariant:** this is `IsStandardType`'s question asked BEFORE the write
 *  instead of reported after it. Writing an arbitrary name is how a tree comes
 *  to fail PDF/UA in a way the author cannot see, and `RegisterRole` already
 *  exists for the case where a custom type is meant. */
export function checkStructType(
  type: unknown, roleMap: ReadonlyMap<string, string>,
): string {
  if (typeof type !== 'string' || type.length === 0)
    throw new TypeError('structure type must be a non-empty string');
  if (!STANDARD_STRUCTURE_TYPES.has(resolveRole(type, roleMap)))
    throw new RangeError(
      `structure type '${type}' is not a standard type and is not mapped by the `
      + '/RoleMap; map it first with StructTreeRoot.RegisterRole(custom, standard)');
  return type;
}
```

- [ ] **Step 4: Point `struct.ts` at the leaf**

In `src/struct.ts`, delete the whole `STANDARD_STRUCTURE_TYPES` declaration
(the comment block and `new Set([...])` at lines 15-28) and add, beside the
other imports:

```ts
import { STANDARD_STRUCTURE_TYPES, resolveRole } from './structtype.js';

// Re-exported so `index.ts` and every existing import path stay put. The local
// import above is separate and required: `export … from` creates no local
// binding, and `IsStandardType` reads the set directly.
export { STANDARD_STRUCTURE_TYPES } from './structtype.js';
```

Then replace `StructTreeRoot.ResolveRole`'s body (lines 464-474, the
`let cur = role;` walk) with a delegate, so there is one owner of the walk:

```ts
  /** Follow the RoleMap chain from `role` to a standard structure type.
   *  Stops at the first standard type, at an unmapped name, or on a cycle. */
  ResolveRole(role: string): string {
    return resolveRole(role, this.RoleMap);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/structtype.test.ts test/struct-write.test.ts test/import-cycles.test.ts`
Expected: PASS. `import-cycles` must still report exactly the same 15 pairs —
the leaf imports nothing, so it adds no cycle.

- [ ] **Step 6: Prove the delegate is load-bearing**

Temporarily change `struct.ts`'s `ResolveRole` to `return role;` and run
`npx vitest run test/struct-write.test.ts`. Expected: the `Subtitle` case
("registers a custom role resolved through RoleMap") FAILS. Restore the
delegate. If it stays green, say so in the commit — do not proceed as though
it were covered.

- [ ] **Step 7: Add the CLAUDE.md entry**

In CLAUDE.md's Source list, immediately after the `struct.ts`/`structwrite.ts`/
`structattr.ts`/`structpreserve.ts`/`autotag.ts` bullet, add:

```markdown
- **structtype.ts** — what may be a structure type, and what a custom one
  resolves to: `STANDARD_STRUCTURE_TYPES`, `resolveRole`, `checkStructType`.
  **Invariant:** a pure LEAF importing NOTHING, so every rule is testable with
  no PDF built. It is a module rather than a section of `struct.ts` because TWO
  consumers need it and neither may reach the other — `struct.ts` imports
  `structwrite.ts` by VALUE while `structwrite.ts` imports `StructElement` as a
  TYPE only, so a value import back would close the first
  `struct.ts` <-> `structwrite.ts` 2-cycle. The forcing argument behind
  `colornames.ts`, `preformat.ts`, `bordersides.ts` and `langmatch.ts`.
  `struct.ts` re-exports the constant, so `index.ts` and every internal import
  path are unchanged.
  **Invariant:** `resolveRole` tests the standard set BEFORE the RoleMap, so a
  file whose /RoleMap shadows a standard type cannot change what that type
  means document-wide.
```

Then run the module-doc sweep from Global Constraints and confirm it prints
nothing.

- [ ] **Step 8: Commit**

```bash
git add src/structtype.ts src/struct.ts test/structtype.test.ts CLAUDE.md
git commit -m "refactor(q7hc.1): extract structtype.ts, the leaf both struct writers need

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

No CHANGELOG entry: this is an internal refactor with no user-visible change.

---

### Task 2: Validate the type wherever an element is created

**Files:**
- Modify: `src/structwrite.ts` (`createElement`, lines 98-114)
- Modify: `src/struct.ts` (`StructElement.Append` ~line 369,
  `StructTreeRoot.Append` ~line 520)
- Modify: `CHANGELOG.md`
- Test: `test/struct-retype.test.ts`

**Interfaces:**
- Consumes: `checkStructType(type, roleMap)` from Task 1.
- Produces: `createElement(doc, type, roleMap, parentRef, parentK, opts?)` —
  the `roleMap: ReadonlyMap<string, string>` parameter is **new and third**;
  both call sites are in `struct.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/struct-retype.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('Append validates the structure type', () => {
  it('rejects an unmapped custom type from the root', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    expect(() => root.Append('Nonsense')).toThrow(RangeError);
  });

  it('rejects an unmapped custom type from an element', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    expect(() => sect.Append('Nonsense')).toThrow(RangeError);
  });

  it('accepts a type the RoleMap resolves', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    expect(root.Append('Subtitle').StandardType).toBe('P');
  });

  // formcreate.ts's rule, scaled to one element: a rejected call must leave the
  // document byte-identical. createElement allocates on its first statement, so
  // validating afterwards would strand an object in the map.
  it('leaves the document byte-identical when it rejects', () => {
    const doc = Document.Open(buildStampTarget());
    doc.CreateStructTree().Append('Sect');
    const before = doc.Save();
    expect(() => doc.GetStructTree()!.Append('Nonsense')).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-retype.test.ts`
Expected: FAIL — all three rejection cases, because `Append` returns an element
today instead of throwing.

- [ ] **Step 3: Validate inside `createElement`**

In `src/structwrite.ts`, add to the imports:

```ts
import { checkStructType } from './structtype.js';
```

and replace `createElement` with:

```ts
/** Allocate a new /StructElem under `parentRef`, append its ref to `parentK`,
 *  apply `opts`, and return the live dict + ref.
 *
 *  **Invariant:** the type is validated BEFORE anything is allocated, so a
 *  rejected call leaves the document byte-identical — `formcreate.ts`'s rule.
 *  It is checked here rather than at the two `Append` call sites because this
 *  is the allocation site, which makes that ordering structural rather than a
 *  thing each caller has to remember. */
export function createElement(
  doc: Document, type: string, roleMap: ReadonlyMap<string, string>,
  parentRef: PdfRef, parentK: PdfObject[], opts?: ElemOpts,
): { dict: PdfDict; ref: PdfRef } {
  checkStructType(type, roleMap);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('StructElem')],
    ['S', name(type)],
    ['P', parentRef],
    ['K', []],
  ]);
  applyElemOpts(dict, opts);
  const r = doc.allocObject(dict);
  parentK.push(r);
  doc.markModified();
  return { dict, ref: r };
}
```

- [ ] **Step 4: Pass the RoleMap at both call sites**

In `src/struct.ts`, `StructElement.Append`:

```ts
    const { dict, ref: r } = createElement(this.doc, type, this.Root.RoleMap, this.Ref, k, opts);
```

and `StructTreeRoot.Append`:

```ts
    const { dict, ref: r } = createElement(this.doc, type, this.RoleMap, this.Ref, k, opts);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/struct-retype.test.ts test/struct-write.test.ts`
Expected: PASS, **with `test/struct-write.test.ts` unedited** — its
`RegisterRole('Subtitle', 'P')` then `Append('Subtitle')` case is the fence
that a legitimate custom role still appends.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green. Every `Append` in `src/` and `test/` uses a standard type or a
registered role, so nothing should move. **If a test goes red, do not relax the
validator** — report which call site appends an unmapped type; that is a real
finding about our own output.

- [ ] **Step 7: Update CHANGELOG.md**

Under `## [Unreleased]`, in a `### Changed` section (create it if absent):

```markdown
- **BREAKING: a structure type is now validated where it is written.**
  `StructTreeRoot.Append`, `StructElement.Append` and the new
  `StructElement.SetType` reject a type that is neither one of the 49 standard
  structure types nor mapped to one through the struct root's `/RoleMap`,
  throwing `RangeError`. Previously any name whatever was accepted and written
  to `/S`, and the document then failed `ValidatePdfUa`'s `StandardType` rule
  with nothing at the call site to say so — a tree that looks tagged and is not
  conformant. Map a deliberate custom type first with
  `RegisterRole(custom, standard)`, which is what it is for. The check runs
  before anything is allocated, so a rejected call leaves the document
  byte-identical. (`q7hc.1`)
```

- [ ] **Step 8: Commit**

```bash
git add src/structwrite.ts src/struct.ts test/struct-retype.test.ts CHANGELOG.md
git commit -m "feat(q7hc.1)!: validate a structure type against the /RoleMap when it is written

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: A `marked` event on `visitContent`

Surfaces the address of every `BDC` that opens a structure content item, so one
walker stays the owner of "where is this MCID marked". **No consumer yet.**

**Files:**
- Modify: `src/text.ts` (`ContentVisitor` at lines 355-360; the `BDC` case at
  lines 653-661)
- Modify: `CLAUDE.md` (the `text.ts` bullet)
- Test: `test/struct-retype.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `ContentAddr` from `editcontent.ts` (already imported by `text.ts`).
- Produces:
  ```ts
  export interface MarkedContentEvent {
    addr: ContentAddr;   // where the BDC op sits
    tag: string;         // the BDC tag operand, e.g. 'P'
    mcid: number;        // always present — the event fires only when one resolves
    properties?: PdfDict; // the resolved property list
  }
  // on ContentVisitor:
  marked?(e: MarkedContentEvent): void;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/struct-retype.test.ts`:

```ts
import { visitContent, type MarkedContentEvent } from '../src/text.js';

describe('visitContent: the marked event', () => {
  it('reports the tag, MCID and address of a structure content item', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const seen: MarkedContentEvent[] = [];
    visitContent(doc, page, { marked(e) { seen.push(e); } });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].tag).toBe('P');
    expect(seen[0].mcid).toBe(0);
    expect(seen[0].addr.path).toEqual([]);
    expect(typeof seen[0].addr.opIndex).toBe('number');
  });

  // The narrowing is what keeps the event meaning one thing. An /Artifact BDC
  // carries no /MCID, so `marked` and `artifact` provably cannot both fire for
  // one op — no consumer has to disambiguate them.
  it('does not fire for an artifact BDC, which carries no MCID', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.Graphics()
      .BeginArtifact()
      .setFillColor([0, 0, 0]).rect(10, 10, 20, 20).fill()
      .EndMarkedContent()
      .apply();

    const marks: MarkedContentEvent[] = [];
    let artifacts = 0;
    visitContent(doc, page, { marked(e) { marks.push(e); }, artifact() { artifacts++; } });

    expect(artifacts).toBeGreaterThan(0);
    expect(marks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-retype.test.ts`
Expected: FAIL — `MarkedContentEvent` is not exported from `text.ts`.

- [ ] **Step 3: Add the event type and the visitor slot**

In `src/text.ts`, above `ContentVisitor`:

```ts
/** A `BDC` that opens a STRUCTURE CONTENT ITEM — a marked-content sequence
 *  whose property list carries an /MCID.
 *
 *  Fired at the OPENING op, as `ArtifactEvent` is, which is what makes a
 *  sequence enclosing no ink reportable at all.
 *
 *  **Invariant:** it fires ONLY when an /MCID resolves. The walker already
 *  computes `mcidFromProps` in this branch, so the narrowing costs nothing —
 *  and it means the event has exactly one meaning rather than overlapping the
 *  `artifact` channel, since an `/Artifact` BDC carries no /MCID and the two
 *  provably cannot both fire for one op. */
export interface MarkedContentEvent {
  /** Where the BDC op sits. */
  addr: ContentAddr;
  /** The tag operand — `/P` in `/P <</MCID 0>> BDC`. This is the name a
   *  retyping edit rewrites; nothing in this library READS it, which is why a
   *  test for such an edit must assert emitted bytes. */
  tag: string;
  /** The /MCID the property list carries. */
  mcid: number;
  /** The property list: the BDC's inline dict, or the dict its name resolved to
   *  through /Resources /Properties. */
  properties?: PdfDict;
}
```

and add the slot to `ContentVisitor`:

```ts
export interface ContentVisitor {
  glyph?(e: GlyphEvent): void;
  image?(e: ImageEvent): void;
  path?(e: PathEvent): void;
  artifact?(e: ArtifactEvent): void;
  marked?(e: MarkedContentEvent): void;
}
```

- [ ] **Step 4: Fire it from the `BDC` branch**

In `walkScope`'s `case 'BDC':`, replace the existing block with:

```ts
        case 'BDC': {
          mcidStack.push(activeMcid); artifactStack.push(artScope);
          oc.bdc(op.operands[0], op.operands[1], properties);
          if (isArtifactTag(op.operands[0]))
            artScope = openArtifact(ctx, addr, op.operands[1], properties, artScope);
          const m = mcidFromProps(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) {
            activeMcid = m;
            if (ctx.visitor.marked) {
              const tagOp = op.operands[0];
              let d: PdfObject | undefined = op.operands[1];
              if (isName(d)) d = properties?.get(d.name);
              const props = ctx.doc.resolve(d);
              ctx.visitor.marked({
                addr, mcid: m,
                tag: isName(tagOp) ? tagOp.name : '',
                properties: isDict(props) ? props : undefined,
              });
            }
          }
          break;
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/struct-retype.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: green. Adding an optional visitor slot nobody implements cannot move
any existing behaviour; a red test here means the `BDC` branch was changed
rather than extended.

- [ ] **Step 7: Document the invariant**

In CLAUDE.md, in the `text.ts` paragraph that already documents
`ContentWalkOptions.skipHidden` and `ArtifactEvent`, add:

```markdown
  **Invariant (`q7hc.1`):** `ContentVisitor.marked` fires at a `BDC` whose
  property list resolves an `/MCID` — a STRUCTURE CONTENT ITEM opening — and at
  no other op. The walker already computes `mcidFromProps` there, so the
  narrowing costs nothing, and it keeps the event from overlapping the
  `artifact` channel: an `/Artifact` BDC carries no `/MCID`, so the two
  provably cannot both fire for one op. It exists so ONE walker owns "where is
  this MCID marked" — `structwrite.ts`'s retag would otherwise need a second
  content walker that re-derived `/Resources` inheritance and Form XObject
  descent, which is how two walkers come to disagree about one page.
```

- [ ] **Step 8: Commit**

```bash
git add src/text.ts test/struct-retype.test.ts CLAUDE.md
git commit -m "feat(q7hc.1): report a structure content item's BDC address from visitContent

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

No CHANGELOG entry: `ContentVisitor` is internal — `index.ts` does not export it.

---

### Task 4: `SetType`, `set Type`, and the top-level BDC rewrite

**Files:**
- Modify: `src/structwrite.ts` (add `StructRetagResult` + `retagContentItems`)
- Modify: `src/struct.ts` (`SetType` / `set Type` beside the text setters at
  lines 372-384)
- Modify: `src/index.ts` (line 75, the `export type` from `./struct.js`)
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`
- Test: `test/struct-retype.test.ts`

**Interfaces:**
- Consumes: `checkStructType` (Task 1), `ContentVisitor.marked` +
  `MarkedContentEvent` (Task 3), `EditableContent` (existing).
- Produces:
  ```ts
  // structwrite.ts
  export interface StructRetagResult { retagged: number; unreachable: number }
  export function retagContentItems(
    doc: Document, element: StructElement, type: string,
  ): StructRetagResult;
  // struct.ts, on StructElement
  SetType(type: string): StructRetagResult;
  set Type(v: string);   // getter stays `get Type(): string`
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/struct-retype.test.ts`:

```ts
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

/** The concatenated text of every content stream of page 0. */
function pageText(doc: Document, pageIndex = 0): string {
  const c = doc.resolve(doc.Pages[pageIndex].Dict.get('Contents'));
  const streams = isStream(c) ? [c] : (c as unknown[]).map((e) => doc.resolve(e as never));
  return streams
    .filter(isStream)
    .map((s) => new TextDecoder().decode(inflateStream(s)))
    .join('\n');
}

describe('StructElement.SetType', () => {
  it('writes /S and reports what it retagged', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const r = el.SetType('H2');
    expect(el.Type).toBe('H2');
    expect(r.retagged).toBe(1);
    expect(r.unreachable).toBe(0);
  });

  // MEASURED: nothing in this library reads a BDC tag name — text.ts reads the
  // operand's /MCID and only ever compares the tag against /Artifact. So a test
  // that retags and re-reads `Type` passes with the whole rewrite deleted. The
  // assertion has to be on emitted bytes.
  it('rewrites the BDC tag in the page content stream', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(pageText(doc)).toMatch(/\/P\s*<<\s*\/MCID 0/);

    el.SetType('H2');
    const after = pageText(doc);
    expect(after).toMatch(/\/H2\s*<<\s*\/MCID 0/);
    expect(after).not.toMatch(/\/P\s*<<\s*\/MCID 0/);
  });

  it('rejects an unmapped custom type and leaves /S alone', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(() => el.SetType('Nonsense')).toThrow(RangeError);
    expect(el.Type).toBe('P');
  });

  it('accepts a type the RoleMap resolves', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    const el = root.Append('P');
    el.SetType('Subtitle');
    expect(el.Type).toBe('Subtitle');
    expect(el.StandardType).toBe('P');
  });

  it('retags nothing, and reports nothing, for an element with no content', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(el.SetType('Div')).toEqual({ retagged: 0, unreachable: 0 });
  });

  // The setter is a thin wrapper over SetType so the two cannot drift.
  it('the property setter does the same work and discards the report', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Type = 'H3';
    expect(el.Type).toBe('H3');
    expect(pageText(doc)).toMatch(/\/H3\s*<<\s*\/MCID 0/);
  });

  it('the property setter rejects an unmapped type too', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(() => { el.Type = 'Nonsense'; }).toThrow(RangeError);
  });

  it('retypes only this element, never its children', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const parent = doc.CreateStructTree().Append('Sect');
    const child = parent.Append('P');
    child.MarkContent(page, [0, 0, 1000, 1000]);
    parent.SetType('Div');
    expect(child.Type).toBe('P');
    expect(pageText(doc)).toMatch(/\/P\s*<<\s*\/MCID 0/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-retype.test.ts`
Expected: FAIL — `el.SetType is not a function`.

- [ ] **Step 3: Implement `retagContentItems`**

In `src/structwrite.ts`, add `isName` to the `types.js` import if it is not
already there (it is), and append:

```ts
/** What a retag reached, and what it could not.
 *
 *  `unreachable` counts marked-content items whose BDC the content walk cannot
 *  address: an item whose /Pg does not resolve to a page, and a BDC inside a
 *  tiling pattern, a Type 3 /CharProcs or an annotation appearance — none of
 *  which `ContentAddr`'s XObject-name chain can name (the `85l8.6` limit). */
export interface StructRetagResult { retagged: number; unreachable: number }

/** Rewrite the BDC tag of `element`'s OWN marked-content items to `type`.
 *
 *  **Invariant:** it FAILS OPEN. An item the walk cannot address keeps its
 *  stale tag, counts into `unreachable`, and never throws — a stale tag name is
 *  a cosmetic divergence nothing in this library READS (`text.ts` reads the
 *  operand's /MCID and compares the tag only against /Artifact), so it must not
 *  cost the caller the retag they asked for. /S is written either way.
 *
 *  **Invariant:** only this element's own content items. Children carry their
 *  own types and their own BDCs.
 *
 *  **Invariant:** every address is collected BEFORE any edit, which is sound
 *  only because the rewrite REPLACES an op and never inserts or deletes one —
 *  so no opIndex moves under a later edit. `markContentRegion` cannot take this
 *  shortcut, which is why it comments on span ordering and this does not. */
export function retagContentItems(
  doc: Document, element: StructElement, type: string,
): StructRetagResult {
  const byPage = new Map<Page, Set<number>>();
  let unreachable = 0;
  for (const item of element.ContentItems) {
    if (item.kind !== 'mcid') continue;   // an OBJR carries no BDC
    if (!item.page) { unreachable++; continue; }
    let s = byPage.get(item.page);
    if (!s) { s = new Set<number>(); byPage.set(item.page, s); }
    s.add(item.mcid);
  }

  let retagged = 0;
  for (const [page, want] of byPage) {
    const hits: { addr: ContentAddr; mcid: number }[] = [];
    // No ContentWalkOptions: skipHidden keeps its `false` default, so content
    // the current optional-content configuration hides is still retagged. An
    // EDIT consumer must see what the file contains (q1g2.3).
    visitContent(doc, page, {
      marked(e) { if (want.has(e.mcid)) hits.push({ addr: e.addr, mcid: e.mcid }); },
    });

    const found = new Set(hits.map((h) => h.mcid));
    for (const m of want) if (!found.has(m)) unreachable++;
    if (hits.length === 0) continue;

    // Group by scope so each op list is read once and written once.
    //
    // `indices` is a SET, not an array: a Form XObject drawn TWICE is walked
    // twice and yields the same address both times (same path, same opIndex),
    // so a list would rewrite one op twice and report `retagged: 2` for a
    // single BDC. `EditableContent` keys its clone cache by path, so the
    // second write already hits the cached clone — the count is the only thing
    // that can go wrong, and it is what the caller reads.
    const ec = new EditableContent(doc, page);
    const scopes = new Map<string, { addr: ContentAddr; indices: Set<number> }>();
    for (const h of hits) {
      const key = `${h.addr.path.join('\0')}${h.addr.streamIndex}`;
      const hit = scopes.get(key);
      if (hit) hit.indices.add(h.addr.opIndex);
      else scopes.set(key, { addr: h.addr, indices: new Set([h.addr.opIndex]) });
    }
    for (const { addr, indices } of scopes.values()) {
      const top = addr.path.length === 0;
      const ops = [...(top ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path))];
      for (const i of indices) {
        const op = ops[i];
        if (!op || op.operator !== 'BDC') continue;   // defensive; the walk just read it
        ops[i] = { operator: 'BDC', operands: [name(type), op.operands[1]] };
        retagged++;
      }
      if (top) ec.setTopOps(addr.streamIndex, ops);
      else ec.setXobjectOps(addr.path, ops);
    }
    ec.commit();
  }
  return { retagged, unreachable };
}
```

- [ ] **Step 4: Add `SetType` and `set Type` to `StructElement`**

In `src/struct.ts`, add `retagContentItems` and `type StructRetagResult` to the
existing `./structwrite.js` import, add `checkStructType` to the
`./structtype.js` import Task 1 created, and re-export the result type beside
the constant:

```ts
export type { StructRetagResult } from './structwrite.js';
```

and add, immediately after the six text setters:

```ts
  /** Change this element's structure type, rewriting the BDC tag of its own
   *  marked content to match, and report what the rewrite reached.
   *
   *  Throws `TypeError` for a non-string or empty type and `RangeError` for one
   *  that is neither standard nor mapped by the /RoleMap — map it first with
   *  `StructTreeRoot.RegisterRole`.
   *
   *  **Invariant:** `set Type` is a thin wrapper over this, discarding the
   *  report. A property setter cannot report what the surgery could not reach,
   *  and one implementation behind both is what keeps them from drifting —
   *  the `ToMarkdown` / `ToMarkdownAssets` pairing. */
  SetType(type: string): StructRetagResult {
    checkStructType(type, this.Root.RoleMap);
    this.Dict.set('S', name(type));
    this.doc.markModified();
    return retagContentItems(this.doc, this, type);
  }

  set Type(v: string) { this.SetType(v); }
```

`name` is already imported by `struct.ts`. The existing `get Type(): string`
stays exactly as it is — the accessor pair must agree on `string`.

- [ ] **Step 5: Export the type**

In `src/index.ts`, change line 75 to:

```ts
export type { ContentItem, StructRetagResult } from './struct.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/struct-retype.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove the rewrite is load-bearing**

Temporarily make `retagContentItems` `return { retagged: 0, unreachable: 0 };`
on its first line and run `npx vitest run test/struct-retype.test.ts`.
Expected: the two byte-asserting cases ("rewrites the BDC tag in the page
content stream", "the property setter does the same work…") FAIL, and the
`el.Type` cases stay GREEN — which is the measured claim that structure
round-tripping cannot see this. Restore the body and record the numbers in the
commit message.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: green.

- [ ] **Step 9: Update CHANGELOG.md and README.md**

In `CHANGELOG.md` under `## [Unreleased]`, in `### Added`:

```markdown
- **A structure element's type is writable.** `StructElement.SetType(type)`
  changes `/S` and rewrites the marked-content `BDC` tag behind that element's
  own content, returning `{ retagged, unreachable }`; `element.Type = 'H2'` is
  the same operation with the report discarded. Retyping is the commonest
  repair after supplying an `/Alt` — `AutoTag` is documented as a starting
  point a human refines, and until now an element it typed wrongly could not be
  corrected through the public API at all. The rewrite fails open: a `BDC` the
  content walk cannot address (inside a tiling pattern, a Type 3 `/CharProcs`
  or an annotation appearance) keeps its stale tag and is counted in
  `unreachable` rather than throwing, because the tag name is advisory — the
  `/MCID` is what binds content to the tree. (`q7hc.1`)
```

In `README.md`, in the **Tagged-PDF structure authoring** bullet (around line
198), extend the setter list sentence: after
`` `Alt` / `ActualText` / `Lang` / `Title` / `Expansion` / `ID` `` add
`` , `SetType(type)` / `Type =` for the structure type itself (validated against
the standard types and the `/RoleMap`, and rewriting the marked-content tag
behind the element) ``. Then add a row to the **Forms / Text / …** API
Reference table that covers `StructElement` — find it with
`grep -n 'StructElement' README.md`. Then add a row to the types table between
`StructElement` (README.md:2786) and `StructTreeRoot` (:2787) — that is the
alphabetical run those two already sit in; do not re-sort the table, whose rows
are several concatenated runs rather than one sorted list:

```markdown
| `StructRetagResult` | What a structure-type change reached: the marked-content tags it rewrote, and those it could not address. |
```

- [ ] **Step 10: Document the invariants in CLAUDE.md**

In the `struct.ts` / `structwrite.ts` bullet, add:

```markdown
  **Invariant (`q7hc.1`):** a structure type is validated wherever it is
  WRITTEN — both `Append`s and `SetType` — through `structtype.ts`'s
  `checkStructType`, and inside `createElement`, which is the ALLOCATION site,
  so "a rejected call leaves the document byte-identical" is structural rather
  than a thing each caller remembers.
  **Invariant (`q7hc.1`):** `SetType` rewrites the BDC tag of the element's OWN
  content items and FAILS OPEN — an item the walk cannot address keeps its
  stale tag and is counted in `unreachable`. **Note, measured, and it is why
  the tests assert emitted BYTES:** nothing in this library READS a BDC tag
  name — `text.ts` reads the operand's `/MCID` and compares the tag only
  against `/Artifact` — so a test that retags and re-reads `Type` passes with
  the whole rewrite deleted. Verified: neutering `retagContentItems` reddens
  exactly the two byte-asserting cases and leaves every `el.Type` case green.
  **Invariant (`q7hc.1`):** addresses are collected BEFORE any edit, which is
  sound only because the rewrite REPLACES an op and never inserts or deletes
  one, so no `opIndex` moves under a later edit.
```

- [ ] **Step 11: Commit**

```bash
git add src/structwrite.ts src/struct.ts src/index.ts \
        test/struct-retype.test.ts CHANGELOG.md README.md CLAUDE.md
git commit -m "feat(q7hc.1): StructElement.SetType, rewriting the marked-content tag

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The nested Form XObject, and the copy-on-write it forces

Measured: **every MCID-bearing BDC this library authors is at page top level** —
`markContentRegion` wraps top-level spans, and `flatten.ts` appends its
`/<tag> <</MCID n>> BDC` to page content rather than writing it into the form it
draws. So Task 4's rewrite covers the nested path by reasoning alone until this
fixture exists.

**Files:**
- Create: `test/helpers/build-nested-mc-pdf.ts`
- Test: `test/struct-retype.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `SetType` (Task 4).
- Produces:
  ```ts
  export function buildNestedMcPdf(): Uint8Array;   // one page, BDC inside /Fm0
  export function buildSharedFormMcPdf(): Uint8Array; // two pages sharing /Fm0
  ```

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-nested-mc-pdf.ts`:

```ts
// Tagged pages whose structure content item's BDC sits INSIDE a Form XObject.
//
// Raw content streams rather than the authoring API, because nothing this
// library writes puts an MCID-bearing BDC inside a form: markContentRegion
// wraps TOP-LEVEL spans, and flatten.ts appends its own BDC to page content
// rather than into the form it draws. So the nested path — and the
// copy-on-write it forces — is reached by no fixture built the ordinary way.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string, extra = ''): string {
  return `<< ${extra} /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

const FORM_BODY = '/P << /MCID 0 >> BDC 0 0 1 rg 0 0 20 20 re f EMC';

/** One tagged page. Its only structure content item is an MCID-bearing BDC
 *  inside /Fm0, so retyping the element must reach into the form. */
export function buildNestedMcPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>';
  objects[4] = streamObj('q 1 0 0 1 10 10 cm /Fm0 Do Q');
  objects[5] = streamObj(FORM_BODY, '/Type /XObject /Subtype /Form /BBox [0 0 20 20]');
  objects[6] = '<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R /ParentTreeNextKey 1 >>';
  objects[7] = '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>';
  objects[8] = '<< /Nums [0 [7 0 R]] >>';
  return assemble(objects, 8, 1);
}

/** TWO tagged pages whose /Fm0 is the SAME form object, each with its own
 *  /StructParents key and its own element mapping MCID 0. Retyping page 0's
 *  element must copy-on-write the form and leave page 1 pointing at the
 *  original — the COW this feature forces, and the one shape where a rewrite
 *  in place would silently retag another page's content. */
export function buildSharedFormMcPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /StructParents 1 '
    + '/Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>';
  objects[5] = streamObj('q 1 0 0 1 10 10 cm /Fm0 Do Q');
  objects[6] = streamObj(FORM_BODY, '/Type /XObject /Subtype /Form /BBox [0 0 20 20]');
  objects[7] = '<< /Type /StructTreeRoot /K [8 0 R 9 0 R] /ParentTree 10 0 R '
    + '/ParentTreeNextKey 2 >>';
  objects[8] = '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>';
  objects[9] = '<< /Type /StructElem /S /P /P 7 0 R /Pg 4 0 R /K 0 >>';
  objects[10] = '<< /Nums [0 [8 0 R] 1 [9 0 R]] >>';
  return assemble(objects, 10, 1);
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/struct-retype.test.ts`:

```ts
import { buildNestedMcPdf, buildSharedFormMcPdf } from './helpers/build-nested-mc-pdf.js';
import { isDict } from '../src/types.js';

/** The decoded content of the Form XObject named `nm` in page `pageIndex`. */
function formText(doc: Document, pageIndex: number, nm: string): string {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('page has no /Resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('page has no /XObject');
  const s = doc.resolve(xo.get(nm));
  if (!isStream(s)) throw new Error(`/${nm} is not a stream`);
  return new TextDecoder().decode(inflateStream(s));
}

describe('SetType reaches a BDC inside a Form XObject', () => {
  it('rewrites the tag in the form, not the page', () => {
    const doc = Document.Open(buildNestedMcPdf());
    const el = doc.GetStructTree()!.Children[0];
    expect(el.Type).toBe('P');
    expect(formText(doc, 0, 'Fm0')).toMatch(/\/P\s*<<\s*\/MCID 0/);

    const r = el.SetType('H1');
    expect(r).toEqual({ retagged: 1, unreachable: 0 });

    const form = formText(doc, 0, 'Fm0');
    expect(form).toMatch(/\/H1\s*<<\s*\/MCID 0/);
    expect(form).not.toMatch(/\/P\s*<<\s*\/MCID 0/);
    // The page's own content is untouched: only the form held the BDC.
    expect(pageText(doc)).toMatch(/\/Fm0 Do/);
  });

  it('survives a save/reopen', () => {
    const doc = Document.Open(buildNestedMcPdf());
    doc.GetStructTree()!.Children[0].SetType('H1');
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children[0].Type).toBe('H1');
    expect(formText(re, 0, 'Fm0')).toMatch(/\/H1\s*<<\s*\/MCID 0/);
  });

  // The COW this feature forces. A form shared by two pages is cloned for the
  // page being edited; the other page keeps the original. Rewriting in place
  // would silently retag content belonging to a different element.
  it('copies a shared form on write and leaves the other page alone', () => {
    const doc = Document.Open(buildSharedFormMcPdf());
    const [a, b] = doc.GetStructTree()!.Children;
    expect(a.Type).toBe('P');
    expect(b.Type).toBe('P');

    a.SetType('H1');

    expect(formText(doc, 0, 'Fm0')).toMatch(/\/H1\s*<<\s*\/MCID 0/);
    expect(formText(doc, 1, 'Fm0')).toMatch(/\/P\s*<<\s*\/MCID 0/);
    expect(b.Type).toBe('P');
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run test/struct-retype.test.ts`
Expected: PASS — Task 4's implementation already handles the nested path
through `ec.xobjectOps` / `ec.setXobjectOps`. **If it fails, the bug is real
and this fixture is what found it** — fix `retagContentItems`, not the fixture.

- [ ] **Step 4: Prove the nested branch is load-bearing**

Temporarily replace `retagContentItems`'s XObject branch so it always uses the
top-level path:

```ts
      const ops = [...ec.topOps(addr.streamIndex)];
      // …
      ec.setTopOps(addr.streamIndex, ops);
```

Run `npx vitest run test/struct-retype.test.ts`. Expected: the three nested
cases FAIL and the Task 4 cases stay GREEN. Restore the branch.

- [ ] **Step 5: Prove the COW case is load-bearing on its own**

Confirm that the shared-form case is the only one that can see the copy: it is
the only fixture with two pages pointing at one form. Record in the commit
message that the other two nested cases pass under a rewrite-in-place build.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 7: Document what the fixture exists for**

Extend the `q7hc.1` note in CLAUDE.md's `struct.ts` bullet:

```markdown
  **Note, measured:** EVERY MCID-bearing BDC this library authors is at page
  TOP LEVEL — `markContentRegion` wraps top-level spans and `flatten.ts`
  appends its own BDC to page content rather than into the form it draws — so
  the nested path and its copy-on-write are reached by no fixture built the
  ordinary way. `build-nested-mc-pdf.ts` is hand-built for exactly that, and
  its SHARED-form case is the only shape in the suite that can see the COW: a
  rewrite in place there would silently retag a second page's content.
```

- [ ] **Step 8: Commit**

```bash
git add test/helpers/build-nested-mc-pdf.ts test/struct-retype.test.ts CLAUDE.md
git commit -m "test(q7hc.1): retag a BDC inside a Form XObject, and pin the copy-on-write

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The `/Alt` regression, and the fail-open count

Covers the half of the acceptance criterion that already passes — measured, and
asserted by nothing in the suite today — plus the `unreachable` path.

**Files:**
- Create: `test/struct-ua.test.ts`
- Test: `test/struct-retype.test.ts` (append the fail-open case)

**Interfaces:**
- Consumes: `SetType` (Task 4). Produces nothing.

- [ ] **Step 1: Write the `/Alt` regression test**

Create `test/struct-ua.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

// ValidationReport.Issues is a ValidationIssue[] with a `rule` string
// (src/validation.ts) — no cast needed.
const altFindings = (doc: Document): string[] =>
  doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'IllustrationAlt').map((i) => i.message);

describe('PDF/UA: supplying an /Alt clears IllustrationAlt', () => {
  // q7hc's headline claim — "AutoTag is a starting point a human refines" —
  // asserted end to end. The setter has shipped since 7dd8750d; nothing in the
  // suite pinned the effect on the validator, so a future change could have
  // taken it away silently.
  it('clears the finding for a /Figure', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    expect(altFindings(doc)).toEqual(['Figure element has no /Alt or /ActualText.']);

    fig.Alt = 'a picture of a cat';
    expect(altFindings(doc)).toEqual([]);
  });

  it('accepts /ActualText instead of /Alt', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.ActualText = 'Q3 revenue';
    expect(altFindings(doc)).toEqual([]);
  });

  // Whitespace is not a description. The rule trims, and this pins it.
  it('does not accept whitespace as a description', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.Alt = '   ';
    expect(altFindings(doc)).toHaveLength(1);
  });

  it('clears again after the /Alt is removed and re-supplied', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.Alt = 'a chart';
    expect(altFindings(doc)).toEqual([]);
    fig.Alt = undefined;
    expect(altFindings(doc)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/struct-ua.test.ts`
Expected: PASS immediately — this is a regression test for shipped behaviour,
not a new feature. If it fails, that is a real finding: report it.

- [ ] **Step 3: Write the fail-open test**

Append to `test/struct-retype.test.ts`:

```ts
describe('SetType fails open', () => {
  // An element whose content item names a page that does not resolve. /S is
  // still written; the item is counted rather than throwing, because a stale
  // tag name is cosmetic and must not cost the caller the retag.
  it('counts an unresolvable content item and still writes /S', () => {
    const doc = Document.Open(buildNestedMcPdf());
    const el = doc.GetStructTree()!.Children[0];
    el.Dict.delete('Pg');          // the item can no longer name a page

    const r = el.SetType('H1');
    expect(el.Type).toBe('H1');
    expect(r.retagged).toBe(0);
    expect(r.unreachable).toBe(1);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run test/struct-retype.test.ts`
Expected: PASS. If `unreachable` comes back 0, `ContentItems` is resolving the
page some other way — read `StructElement.Page` and pick a shape that genuinely
cannot resolve (for example, point `/Pg` at a non-page object) rather than
relaxing the assertion.

- [ ] **Step 5: Prove fail-open is load-bearing**

Temporarily make `retagContentItems` throw instead of counting:

```ts
    if (!item.page) throw new Error('unreachable content item');
```

Run `npx vitest run test/struct-retype.test.ts`. Expected: the fail-open case
FAILS. Restore the count.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add test/struct-ua.test.ts test/struct-retype.test.ts
git commit -m "test(q7hc.1): pin /Alt clearing IllustrationAlt, and the fail-open retag

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Close out

- [ ] **Step 1: Run the full gates**

```bash
npm run typecheck && npm test
```
Both must be green.

- [ ] **Step 2: Run the module-doc sweep**

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```
Expected: prints nothing.

- [ ] **Step 3: Confirm the cycle baseline did not move**

```bash
npx vitest run test/import-cycles.test.ts
```
Expected: PASS with the same 15 pairs. `KNOWN` must be unedited —
`git diff --stat main -- test/import-cycles.test.ts` should show no change.

- [ ] **Step 4: Close the issue and push**

```bash
bd update q7hc.1 --status closed
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

- [ ] **Step 5: Hand off**

Report: what shipped, the measured mutation results from Tasks 1, 4, 5 and 6,
and that `q7hc.2` (`StructElement.Remove()`) is the next P1 in the epic —
noting that `retagContentItems`' scope walk is the nearest precedent for its
`/ParentTree` release.

---

## Notes for the implementer

**The issue text is partly stale, and the spec says why.** `q7hc.1` claims
`Alt`, `ActualText` and `Lang` are read-only. They are not — those setters
shipped in `7dd8750d` (2026-06-25) and README documents them. Do not
re-implement them. Task 6 adds the regression test they never had.

**Do not make `import-cycles.test.ts` green by editing it.** Its `KNOWN` list is
a baseline; a 16th pair means the edge you added closed a cycle. The whole
reason `structtype.ts` exists is to avoid one.

**Assert emitted bytes, not round-tripped structure, for the rewrite.** Measured
and restated here because it is the single easiest thing to get wrong in this
plan: nothing in this library reads a BDC tag name, so a test built on
`el.Type` passes with the rewrite deleted.

**`test/struct-retype.test.ts` grows across four tasks.** Each task quotes the
`import` lines it needs beside the `describe` it adds; collect them all at the
top of the file as you go, in the order the existing test files use (vitest,
then `../src/…`, then `./helpers/…`). Import declarations are hoisted, so a
stray one mid-file still runs — it just reads badly.

**`STANDARD_STRUCTURE_TYPES.size` is 49**, measured against the live set, not
the 46 an eyeball count of the four comment groups suggests. If Task 1's size
assertion fails, you dropped a name in the move — diff the set against
`git show HEAD:src/struct.ts` rather than adjusting the number.
