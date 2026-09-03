# HTML5 Tree Construction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `htmltoken.ts`'s token stream into an HTML node tree — insertion modes, the stacks, the adoption agency algorithm, foster parenting — passing 1,328 vendored WPT tree-construction cases.

**Architecture:** Three pure leaves. `htmldom.ts` is a mutable node tree with parent pointers; `htmlstack.ts` is the stack of open elements and the active formatting elements, as pure list algorithms testable with no parser; `htmltree.ts` is the 22 non-template insertion modes that drive both, pulling tokens from `HtmlTokenizer` and steering it back through `setState`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-26-html5-tree-construction-design.md`](../specs/2026-08-26-html5-tree-construction-design.md)

**Issue:** `zch2.1.2`, under `zch2.1`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none.
- **ESM + NodeNext.** Every import specifier carries `.js`: `import { HtmlTokenizer } from './htmltoken.js'`.
- **Nothing throws.** Every string is a valid HTML document; the spec defines a recovery for every case. No `throw` in `src/htmldom.ts`, `src/htmlstack.ts` or `src/htmltree.ts`.
- **Purity.** None of the three may import `document.js`, `page.js`, or any PDF object module. `htmlstack.ts` must not import `htmltree.ts`.
- **Nothing is exported from `src/index.ts`.** `parseHtml` ships with `zch2.1.3`.
- **Spec names, verbatim.** An insertion mode is named as §13.2.6.4 names it (`InTableText`, `AfterAfterBody`).
- **Only `#document` is asserted.** Both `.dat` error sections are ignored — see the spec's reasoning.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. Target one file with `npx vitest run test/<name>.test.ts`. The full suite takes ~100s, so run typecheck and tests as separate commands or the 2-minute default timeout kills them.
- **CHANGELOG.md** gets an `## [Unreleased]` entry only in the final task; the rest is internal.

## File Structure

| File | Responsibility |
|---|---|
| `src/htmldom.ts` | **Create.** Node model: document, doctype, element, text, comment. Parent pointers, insert/remove/move. |
| `src/htmlstack.ts` | **Create.** Stack of open elements + scope predicates; active formatting elements + Noah's Ark + reconstruction. |
| `src/htmltree.ts` | **Create.** The 22 insertion modes, adoption agency, foster parenting, implied end tags, reset-the-insertion-mode, `parseHtml`. |
| `test/helpers/wpt-tree.ts` | **Create.** `.dat` reader, exact bucket classification, and the html5lib `\| ` tree serializer. |
| `test/fixtures/wpt/tree-construction/*.dat` | **Vendor.** 62 files from web-platform-tests. |
| `test/fixtures/wpt/PROVENANCE.md` | **Create.** Source, commit, hashes, bucket counts, exclusions, mutation results. |
| `test/wpt-tree-suite.test.ts` | **Create.** Loader/serializer tests — no parser. |
| `test/htmldom.test.ts` | **Create.** Node model unit tests. |
| `test/htmlstack.test.ts` | **Create.** Scope predicates and formatting-element algorithms, from hand-built lists. |
| `test/htmltree.test.ts` | **Create.** Hand-built parser tests for the silent-when-wrong rules. |
| `test/wpt-tree.test.ts` | **Create.** Drives the vendored corpus. |
| `test/fixtures/html5lib/PROVENANCE.md` | **Modify.** Cross-reference (already corrected when the spec landed; confirm only). |
| `CLAUDE.md`, `CHANGELOG.md` | **Modify.** Final task. |

---

## The `.dat` format, confirmed against the corpus

Do not write the reader from memory. These were measured across all 62 files:

**Case boundary** is a blank line immediately followed by `#data`. Not any blank line — `#data` payloads contain them. Not any `#`-prefixed line — payloads contain those too. The final case has no trailing blank line.

**Directive counts** across 1,936 cases: `#data` 1936, `#errors` 1936, `#document` 1936, `#new-errors` 292, `#document-fragment` 196, `#script-off` 28, `#script-on` 14.

**`#document` line shapes**, by frequency:

| Shape | Count | Meaning |
|---|---|---|
| `\|   <name>` | 9258 | element, two spaces of indent per depth after `\| ` |
| `\|     "text"` | 1582 | text node, in double quotes |
| `\| <!DOCTYPE html>` | 684 | doctype |
| `\|       name="value"` | 498 | an attribute of the element above, one per line |
| `\|     <!-- data -->` | 147 | comment |
| `\|     content` | 136 | a `<template>`'s content (foreign bucket) |
| `\|     <?target data?>` | 82 | processing instruction (excluded bucket) |
| a line with **no** `\| ` prefix | 40+ | **continuation of a multi-line text or comment node** |

**The continuation lines are the trap.** A text or comment node containing a newline serializes with its first line prefixed and the rest bare:

```
|     <!--  BAR --!
>BAZ -->
```

A reader that requires `| ` on every line silently drops those, and a serializer that escapes the newline produces a string that never matches. Both halves must carry the raw newline through.

## Bucket classification, exact

Applied in this order; the first match wins, and every case lands in exactly one bucket:

1. `#document-fragment` present → **fragment** (196)
2. `#script-on` present, or the file name starts with `scripted_` → **scripted** (14)
3. The expected tree matches `/^\| +<(svg|math) /m`, `/^\| +<template>/m` or `/^\| +content$/m` → **foreign** (319)
4. The expected tree matches `/^\| *<\?/m` → **processingInstruction** (79)
5. Otherwise → **inScope** (1,328)

`196 + 14 + 319 + 79 + 1328 = 1936`. All five counts are asserted.

---

## Task 1: Vendor the corpus and build its reader

Built and tested before the parser exists, against hand-built strings — the rule `zch2.1.1` Task 2 already set: a reader validated only through a parser cannot tell a reader bug from a parser bug.

**Files:**
- Vendor: `test/fixtures/wpt/tree-construction/*.dat` (62 files)
- Create: `test/fixtures/wpt/PROVENANCE.md`
- Create: `test/helpers/wpt-tree.ts`
- Test: `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Bucket = 'inScope' | 'fragment' | 'scripted' | 'foreign' | 'processingInstruction';
  export interface WptCase {
    file: string;
    index: number;          // 0-based within its file, for a stable test name
    data: string;           // the #data payload, newlines preserved, no trailing newline
    document: string;       // the #document payload, verbatim, no trailing newline
    fragmentContext?: string;
    bucket: Bucket;
  }
  export const DAT_FILES: string[];        // the 62, sorted
  export function loadWptCases(files?: string[]): WptCase[];   // every bucket
  export function casesInBucket(b: Bucket): WptCase[];
  ```

- [ ] **Step 1: Vendor the fixtures**

```bash
mkdir -p test/fixtures/wpt/tree-construction
BASE=https://raw.githubusercontent.com/web-platform-tests/wpt/8f1efd278facb6c96d46c0cd92897a8a3faeaf29/html/syntax/parsing/resources
for f in adoption01 adoption02 blocks comments01 doctype01 domjs-unsafe entities01 entities02 \
         foreign-fragment html5test-com inbody01 isindex main-element math menuitem-element \
         namespace-sensitivity noscript01 pending-spec-changes-plain-text-unsafe pending-spec-changes \
         plain-text-unsafe processing-instructions quirks01 ruby scriptdata01 scripted_adoption01 \
         scripted_ark scripted_foster01 scripted_webkit01 search-element svg tables01 template \
         tests1 tests10 tests11 tests12 tests14 tests15 tests16 tests17 tests18 tests19 tests2 \
         tests20 tests21 tests22 tests23 tests24 tests25 tests26 tests3 tests4 tests5 tests6 \
         tests7 tests8 tests9 tests_innerHTML_1 tricky01 void-in-phrasing webkit01 webkit02; do
  curl -fsSL "$BASE/$f.dat" -o "test/fixtures/wpt/tree-construction/$f.dat" || echo "FAILED $f"
done
ls test/fixtures/wpt/tree-construction | wc -l   # expect 62
```

Then record hashes for the provenance table:

```bash
cd test/fixtures/wpt/tree-construction && sha256sum *.dat | sort
```

- [ ] **Step 2: Write the failing test**

Create `test/wpt-tree-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadWptCases, casesInBucket, DAT_FILES } from './helpers/wpt-tree.js';

describe('the WPT tree-construction loader', () => {
  it('declares 62 files', () => {
    expect(DAT_FILES.length).toBe(62);
  });

  // The five bucket counts are asserted so a case that migrates upstream
  // reddens the build rather than quietly shrinking what zch2.1.2 tests.
  it('classifies every case into exactly one bucket, with known counts', () => {
    const all = loadWptCases();
    expect(all.length).toBe(1936);
    expect(casesInBucket('fragment').length).toBe(196);
    expect(casesInBucket('scripted').length).toBe(14);
    expect(casesInBucket('foreign').length).toBe(319);
    expect(casesInBucket('processingInstruction').length).toBe(79);
    expect(casesInBucket('inScope').length).toBe(1328);
    const sum = (['fragment', 'scripted', 'foreign', 'processingInstruction', 'inScope'] as const)
      .reduce((n, b) => n + casesInBucket(b).length, 0);
    expect(sum).toBe(1936);
  });

  it('splits cases on a blank line followed by #data, not on any blank line', () => {
    const c = loadWptCases(['tests1.dat']);
    expect(c.length).toBe(112);
    expect(c[0]?.data).toBe('Test');
    expect(c[0]?.document).toBe('| <html>\n|   <head>\n|   <body>\n|     "Test"');
  });

  // A text or comment node containing a newline serializes with only its FIRST
  // line prefixed; the rest are bare. A reader that requires '| ' everywhere
  // silently drops them.
  it('keeps the continuation lines of a multi-line node', () => {
    const c = loadWptCases(['comments01.dat'])
      .find((x) => x.data === 'FOO<!-- BAR --!\n>BAZ');
    expect(c).toBeDefined();
    expect(c?.document).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     "FOO"\n|     <!--  BAR --!\n>BAZ -->',
    );
  });

  it('records a fragment context', () => {
    const c = casesInBucket('fragment')[0];
    expect(c?.fragmentContext).toBeTruthy();
  });

  it('rejects a file that is not in the declared list', () => {
    expect(() => loadWptCases(['nope.dat'])).toThrow(/not a declared/);
  });

  it('numbers cases within a file so a test name is stable', () => {
    const c = loadWptCases(['tests1.dat']);
    expect(c.map((x) => x.index).slice(0, 3)).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: FAIL — `./helpers/wpt-tree.js` does not exist.

- [ ] **Step 4: Write the reader**

Create `test/helpers/wpt-tree.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'wpt', 'tree-construction',
);

export const DAT_FILES = [
  'adoption01', 'adoption02', 'blocks', 'comments01', 'doctype01', 'domjs-unsafe',
  'entities01', 'entities02', 'foreign-fragment', 'html5test-com', 'inbody01', 'isindex',
  'main-element', 'math', 'menuitem-element', 'namespace-sensitivity', 'noscript01',
  'pending-spec-changes-plain-text-unsafe', 'pending-spec-changes', 'plain-text-unsafe',
  'processing-instructions', 'quirks01', 'ruby', 'scriptdata01', 'scripted_adoption01',
  'scripted_ark', 'scripted_foster01', 'scripted_webkit01', 'search-element', 'svg',
  'tables01', 'template', 'tests1', 'tests10', 'tests11', 'tests12', 'tests14', 'tests15',
  'tests16', 'tests17', 'tests18', 'tests19', 'tests2', 'tests20', 'tests21', 'tests22',
  'tests23', 'tests24', 'tests25', 'tests26', 'tests3', 'tests4', 'tests5', 'tests6',
  'tests7', 'tests8', 'tests9', 'tests_innerHTML_1', 'tricky01', 'void-in-phrasing',
  'webkit01', 'webkit02',
].map((n) => `${n}.dat`);

export type Bucket =
  | 'inScope' | 'fragment' | 'scripted' | 'foreign' | 'processingInstruction';

export interface WptCase {
  file: string;
  index: number;
  data: string;
  document: string;
  fragmentContext?: string;
  bucket: Bucket;
}

/** Split one .dat file into raw chunks. The boundary is a blank line
 *  IMMEDIATELY followed by '#data' — not any blank line, since payloads
 *  contain them, and not any '#' line, since payloads contain those too. */
function chunksOf(text: string): string[] {
  return text.split(/\n\n(?=#data\n)/).filter((c) => c.startsWith('#data\n'));
}

/** Split a chunk into its directive sections. A section runs to the next line
 *  that is exactly '#' + a lowercase/hyphen word. */
function sectionsOf(chunk: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of chunk.split('\n')) {
    const m = /^#([a-z-]+)$/.exec(line);
    if (m !== null) { cur = m[1] as string; out[cur] = []; continue; }
    if (cur !== null) (out[cur] as string[]).push(line);
  }
  return out;
}

function classify(file: string, s: Record<string, string[]>, doc: string): Bucket {
  if (s['document-fragment'] !== undefined) return 'fragment';
  if (s['script-on'] !== undefined || file.startsWith('scripted_')) return 'scripted';
  if (/^\| +<(svg|math) /m.test(doc)) return 'foreign';
  if (/^\| +<template>/m.test(doc) || /^\| +content$/m.test(doc)) return 'foreign';
  // Excluded: WPT expects a ProcessingInstruction node here while our pinned
  // tokenizer oracle expects a bogus comment. See PROVENANCE.md and zch2.9.
  if (/^\| *<\?/m.test(doc)) return 'processingInstruction';
  return 'inScope';
}

export function loadWptCases(files?: string[]): WptCase[] {
  const want = files ?? DAT_FILES;
  const cases: WptCase[] = [];
  for (const file of want) {
    if (!DAT_FILES.includes(file)) throw new Error(`${file} is not a declared .dat file`);
    const text = readFileSync(join(DIR, file), 'utf8');
    let index = 0;
    for (const chunk of chunksOf(text)) {
      const s = sectionsOf(chunk);
      const data = (s['data'] ?? []).join('\n');
      const document = (s['document'] ?? []).join('\n').replace(/\n+$/, '');
      const fragmentContext = s['document-fragment']?.join('\n');
      cases.push({
        file, index: index++, data, document,
        ...(fragmentContext === undefined ? {} : { fragmentContext }),
        bucket: classify(file, s, document),
      });
    }
  }
  return cases;
}

export function casesInBucket(b: Bucket): WptCase[] {
  return loadWptCases().filter((c) => c.bucket === b);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: PASS, all 7 assertions. If a bucket count is off by a few, the corpus moved since this plan was written — do **not** edit the expected number to match. Re-derive the counts, confirm the classification rules still hold, and record the change in `PROVENANCE.md`.

- [ ] **Step 6: Write the provenance document**

Create `test/fixtures/wpt/PROVENANCE.md`, filling the hash table from Step 1:

```markdown
# WPT HTML tree-construction suite — provenance

The conformance corpus for the HTML parser's tree-construction stage, here to
validate `src/htmltree.ts` against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-26-html5-tree-construction-design.md`.

**Source:** <https://github.com/web-platform-tests/wpt>, `html/syntax/parsing/resources`
(BSD-3-Clause). Downloaded verbatim, not regenerated.

**Commit:** `8f1efd278facb6c96d46c0cd92897a8a3faeaf29`.

## Why not html5lib-tests

`test/fixtures/html5lib/` holds the *tokenizer* suite from html5lib-tests. The
tree-construction tests are **no longer there** — that repository's README
records that they "are now solely maintained on web-platform-tests", and the
`tree-construction/` directory has been removed. These fixtures are named for
who produced the bytes, so a different upstream gets a different directory.

| File | Bytes | SHA-256 |
|---|---|---|
| ... | ... | ... |

## Shape

A case is `#data` (input), `#errors`, optionally `#new-errors`, optionally
`#document-fragment` or `#script-on`/`#script-off`, then `#document` (the
expected tree). Cases are separated by a blank line immediately followed by
`#data`; the final case has no trailing blank line.

In `#document`, each node is `| ` then two spaces per depth. An element is
`<name>`, its attributes follow one per line sorted by name, text is in double
quotes, a comment is `<!-- data -->`, a doctype is `<!DOCTYPE name>`. A node
whose text contains a newline puts only its FIRST line behind `| `; the rest
are bare continuation lines.

## Buckets

1,936 cases, classified by the loader and asserted:

| Bucket | Cases | Status |
|---|---|---|
| In scope (`zch2.1.2`) | 1,328 | run |
| Fragment (`#document-fragment`) | 196 | `zch2.1.3` |
| Foreign content and `<template>` | 319 | `zch2.1.3` |
| Scripted (`#script-on`, `scripted_*.dat`) | 14 | excluded — the scripting flag is off |
| Processing instructions | 79 | excluded — see below |

## Exclusions

**Both error sections are ignored; only `#document` is asserted.** `#errors`
uses a vocabulary html5lib invented — `expected-doctype-but-got-chars` appears
nowhere in the HTML Standard — while `htmltoken.ts` guarantees error codes are
the spec's own names verbatim. Asserting it would mean maintaining a second,
non-spec error vocabulary beside the first. `#new-errors` is spec-coded but
sparse and mostly re-tests errors `zch2.1.1` already asserts.

**Processing instructions (79 cases).** WPT expects `<body><?something>` to
produce a real ProcessingInstruction node with no parse error; html5lib-tests'
tokenizer suite — our pin, and its master — expects a bogus comment plus
`unexpected-question-mark-instead-of-tag-name`, which `zch2.1.1` passes 100% of.
The two corpora are pinned to different spec eras and no single implementation
satisfies both today. Excluded by a predicate over the expected tree, not by
file name, so the ~45 cases in `processing-instructions.dat` that expect
comments are still run. Tracked as `zch2.9`.

## Mutation results

(Filled in by the final task.)
```

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npm test
git add test/fixtures/wpt test/helpers/wpt-tree.ts test/wpt-tree-suite.test.ts
git commit -m "test(zch2.1.2): vendor the WPT tree-construction corpus and its reader

Built and tested before the parser exists, against hand-built strings: the
.dat format's traps are its own, and a reader validated only through a
parser cannot tell a reader bug from a parser bug.

The case boundary is a blank line IMMEDIATELY followed by #data, because
payloads contain both blank lines and #-prefixed lines. A text or comment
node holding a newline puts only its first line behind '| ' and leaves the
rest bare, so a reader requiring the prefix everywhere drops them silently.

1,936 cases in five asserted buckets: 1,328 in scope, 196 fragment, 319
foreign, 14 scripted, 79 processing-instruction. The counts are asserted so a
case that migrates upstream reddens the build rather than quietly shrinking
what this issue tests."
```

---

## Task 2: The node model

**Files:**
- Create: `src/htmldom.ts`
- Test: `test/htmldom.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type HtmlNode = HtmlDocument | HtmlDoctype | HtmlElement | HtmlText | HtmlComment;
  export interface HtmlDocument { kind: 'document'; children: HtmlNode[]; parent: null; quirks: boolean; }
  export interface HtmlDoctype { kind: 'doctype'; name: string; publicId: string; systemId: string; parent: HtmlNode | null; }
  export interface HtmlElement { kind: 'element'; name: string; attrs: Map<string, string>; children: HtmlNode[]; parent: HtmlNode | null; }
  export interface HtmlText { kind: 'text'; data: string; parent: HtmlNode | null; }
  export interface HtmlComment { kind: 'comment'; data: string; parent: HtmlNode | null; }

  export function createDocument(): HtmlDocument;
  export function createElement(name: string, attrs?: Map<string, string>): HtmlElement;
  export function appendChild(parent: HtmlDocument | HtmlElement, child: HtmlNode): void;
  export function insertBefore(parent: HtmlDocument | HtmlElement, child: HtmlNode, ref: HtmlNode): void;
  export function removeChild(child: HtmlNode): void;
  export function childrenOf(n: HtmlNode): HtmlNode[];
  ```

`appendChild` and `insertBefore` **detach `child` from its current parent first**. The adoption agency moves live nodes, and a node reachable from two parents is a cycle waiting to hang the serializer.

- [ ] **Step 1: Write the failing test**

Create `test/htmldom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createDocument, createElement, appendChild, insertBefore, removeChild, childrenOf,
} from '../src/htmldom.js';

describe('the HTML node model', () => {
  it('appends and links the parent both ways', () => {
    const doc = createDocument();
    const html = createElement('html');
    appendChild(doc, html);
    expect(doc.children).toEqual([html]);
    expect(html.parent).toBe(doc);
  });

  // The adoption agency MOVES live nodes. A node reachable from two parents is
  // a cycle that hangs the serializer rather than failing an assertion.
  it('detaches from the old parent on a move', () => {
    const doc = createDocument();
    const a = createElement('a');
    const b = createElement('b');
    const t = createElement('i');
    appendChild(doc, a);
    appendChild(doc, b);
    appendChild(a, t);
    expect(a.children).toEqual([t]);
    appendChild(b, t);
    expect(a.children).toEqual([]);
    expect(b.children).toEqual([t]);
    expect(t.parent).toBe(b);
  });

  it('inserts before a reference child', () => {
    const doc = createDocument();
    const a = createElement('a');
    const b = createElement('b');
    const c = createElement('c');
    appendChild(doc, a);
    appendChild(doc, c);
    insertBefore(doc, b, c);
    expect(doc.children.map((n) => (n as { name: string }).name)).toEqual(['a', 'b', 'c']);
  });

  it('detaches on insertBefore too', () => {
    const doc = createDocument();
    const host = createElement('host');
    const moved = createElement('moved');
    const ref = createElement('ref');
    appendChild(doc, host);
    appendChild(host, moved);
    appendChild(doc, ref);
    insertBefore(doc, moved, ref);
    expect(host.children).toEqual([]);
    expect(doc.children.map((n) => (n as { name: string }).name)).toEqual(['host', 'moved', 'ref']);
  });

  it('removes a child and clears its parent', () => {
    const doc = createDocument();
    const a = createElement('a');
    appendChild(doc, a);
    removeChild(a);
    expect(doc.children).toEqual([]);
    expect(a.parent).toBeNull();
  });

  it('removing an unparented node is a no-op rather than a throw', () => {
    expect(() => removeChild(createElement('a'))).not.toThrow();
  });

  it('reports children of leaf kinds as empty', () => {
    expect(childrenOf({ kind: 'text', data: 'x', parent: null })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmldom.test.ts`
Expected: FAIL — `../src/htmldom.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/htmldom.ts` implementing the interface above. `appendChild` and `insertBefore` both begin with `removeChild(child)`. `removeChild` finds the node in `parent.children` by identity, splices it out and sets `parent = null`; with no parent it returns without doing anything.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmldom.test.ts`
Expected: PASS, all 7 assertions.

- [ ] **Step 5: Prove the detach load-bearing**

Delete the `removeChild(child)` call at the top of `appendChild` and run the file.
Expected: FAIL on "detaches from the old parent on a move" alone. Revert.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck
npx vitest run test/htmldom.test.ts
git add src/htmldom.ts test/htmldom.test.ts
git commit -m "feat(zch2.1.2): the HTML node model

Mutable with parent pointers, deliberately not an immutable AST like
mdast.ts: the adoption agency relocates live nodes and zch2.2's selector
matching needs ancestor and sibling traversal.

appendChild and insertBefore detach from the current parent first. A node
reachable from two parents is a cycle that hangs the serializer rather than
failing an assertion, which is a far worse failure than a wrong tree."
```

---

## Task 3: The tree serializer

Its own task because it is the oracle's other half, and because it can be verified against the vendored `#document` payloads without any parser at all: serializing a hand-built tree must reproduce a known case's expected text byte for byte.

**Files:**
- Modify: `test/helpers/wpt-tree.ts`
- Test: `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: `HtmlNode` and friends (Task 2); `WptCase` (Task 1).
- Produces: `export function serializeTree(doc: HtmlDocument): string;`

Written from the format description, **not** from whatever the DOM makes convenient — a serializer bent to fit our tree hides bugs in that tree.

The rules, all measured from the corpus:

- Every node emits `| ` + `'  '.repeat(depth)` + its body, where the document's children are depth 0.
- Element: `<name>`. Its attributes follow, each at depth + 1, as `name="value"`, **sorted by name**.
- Text: `"data"` — the raw data in double quotes, no escaping, newlines passed through literally.
- Comment: `<!-- data -->`.
- Doctype: `<!DOCTYPE name>` when there is no public or system id; otherwise `<!DOCTYPE name "publicId" "systemId">`.
- Lines are joined with `\n` and there is no trailing newline.

- [ ] **Step 1: Write the failing test**

Append to `test/wpt-tree-suite.test.ts`:

```ts
import { serializeTree } from './helpers/wpt-tree.js';
import { createDocument, createElement, appendChild } from '../src/htmldom.js';

describe('the html5lib tree serializer', () => {
  /** Build the tree tests1.dat case 0 expects, by hand. */
  function helloTree() {
    const doc = createDocument();
    const html = createElement('html');
    const head = createElement('head');
    const body = createElement('body');
    appendChild(doc, html);
    appendChild(html, head);
    appendChild(html, body);
    appendChild(body, { kind: 'text', data: 'Test', parent: null });
    return doc;
  }

  // The whole point: our serializer must reproduce a vendored expectation
  // byte for byte, from a tree we built by hand.
  it('reproduces a vendored #document exactly', () => {
    const expected = loadWptCases(['tests1.dat'])[0]?.document;
    expect(serializeTree(helloTree())).toBe(expected);
  });

  it('indents two spaces per depth after the pipe', () => {
    expect(serializeTree(helloTree())).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     "Test"',
    );
  });

  it('sorts attributes by name, one per line, indented one level past the element', () => {
    const doc = createDocument();
    const el = createElement('div', new Map([['z', '1'], ['a', '2']]));
    appendChild(doc, el);
    expect(serializeTree(doc)).toBe('| <div>\n|   a="2"\n|   z="1"');
  });

  it('quotes text without escaping and passes a newline through raw', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'text', data: 'a\nb"c', parent: null });
    expect(serializeTree(doc)).toBe('| "a\nb"c"');
  });

  it('writes a comment and a bare doctype', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'comment', data: ' x ', parent: null });
    appendChild(doc, { kind: 'doctype', name: 'html', publicId: '', systemId: '', parent: null });
    expect(serializeTree(doc)).toBe('| <!--  x  -->\n| <!DOCTYPE html>');
  });

  it('writes a doctype with public and system identifiers', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'doctype', name: 'html', publicId: 'P', systemId: 'S', parent: null });
    expect(serializeTree(doc)).toBe('| <!DOCTYPE html "P" "S">');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: FAIL — `serializeTree` is not exported.

- [ ] **Step 3: Implement `serializeTree`**

Add to `test/helpers/wpt-tree.ts`, importing the node types from `../../src/htmldom.js`. Walk depth-first, emitting one line per node and one per attribute.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: PASS, all 13 assertions.

- [ ] **Step 5: Prove the attribute sort load-bearing**

Remove the sort and run the file.
Expected: FAIL on the attribute case alone. Revert.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
npx vitest run test/wpt-tree-suite.test.ts
git add test/helpers/wpt-tree.ts test/wpt-tree-suite.test.ts
git commit -m "test(zch2.1.2): the html5lib tree serializer

The oracle's other half, written from the format description rather than
from whatever our DOM makes convenient — a serializer bent to fit the tree
hides bugs in that tree. Verified by reproducing a vendored #document byte
for byte from a hand-built tree, before any parser exists to produce one."
```

---

## Task 4: The stacks

Pure list algorithms, testable from hand-built element lists with no parser and no document.

**Files:**
- Create: `src/htmlstack.ts`
- Test: `test/htmlstack.test.ts`

**Interfaces:**
- Consumes: `HtmlElement` (Task 2).
- Produces:
  ```ts
  export type ScopeKind = 'default' | 'listItem' | 'button' | 'table' | 'select';
  export class OpenElements {
    readonly items: HtmlElement[];
    get current(): HtmlElement | undefined;
    push(el: HtmlElement): void;
    pop(): HtmlElement | undefined;
    popUntilName(name: string): void;      // pops THROUGH the first match
    popUntilOneOf(names: string[]): void;
    remove(el: HtmlElement): void;
    contains(el: HtmlElement): boolean;
    hasInScope(name: string, kind?: ScopeKind): boolean;
    indexOf(el: HtmlElement): number;
  }
  /** A marker in the active-formatting list; null is the marker. */
  export type FormattingEntry = HtmlElement | null;
  export class ActiveFormatting {
    readonly items: FormattingEntry[];
    push(el: HtmlElement): void;            // applies the Noah's Ark clause
    pushMarker(): void;
    clearToLastMarker(): void;
    remove(el: HtmlElement): void;
    contains(el: HtmlElement): boolean;
    lastBetweenMarkerAndEnd(name: string): HtmlElement | undefined;
  }
  export function sameFormattingElement(a: HtmlElement, b: HtmlElement): boolean;
  ```

Three rules that are silent when wrong:

- **The five scopes are five different lists**, not one. `default` stops at `applet, caption, html, table, td, th, marquee, object, template`; `listItem` adds `ol, ul`; `button` adds `button`; `table` is only `html, table, template`; `select` is *inverted* — everything except `optgroup, option` terminates it. Using plain scope where `button` scope belongs changes when `<p>` auto-closes, which is one of the commonest shapes in real HTML.
- **`popUntilName` pops THROUGH the match**, not up to it.
- **The Noah's Ark clause** keeps at most three entries with the same name, namespace and attribute set; on the fourth, the earliest is removed. Miss it and deeply nested repeated formatting grows the list without bound but still renders — it is a correctness rule with no visible symptom.

- [ ] **Step 1: Write the failing test**

Create `test/htmlstack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { OpenElements, ActiveFormatting, sameFormattingElement } from '../src/htmlstack.js';
import { createElement } from '../src/htmldom.js';

function stackOf(...names: string[]): OpenElements {
  const s = new OpenElements();
  for (const n of names) s.push(createElement(n));
  return s;
}

describe('the stack of open elements', () => {
  it('reports the current node as the last pushed', () => {
    expect(stackOf('html', 'body', 'p').current?.name).toBe('p');
    expect(new OpenElements().current).toBeUndefined();
  });

  // Pops THROUGH the match, not up to it.
  it('popUntilName pops the match too', () => {
    const s = stackOf('html', 'body', 'div', 'p', 'span');
    s.popUntilName('div');
    expect(s.items.map((e) => e.name)).toEqual(['html', 'body']);
  });

  it('finds an element in the default scope', () => {
    expect(stackOf('html', 'body', 'div', 'p').hasInScope('div')).toBe(true);
  });

  it('stops the default scope at a table', () => {
    expect(stackOf('html', 'body', 'div', 'table', 'td', 'p').hasInScope('div')).toBe(false);
  });

  // Using plain scope where button scope belongs changes when <p> auto-closes.
  it('distinguishes button scope from the default', () => {
    const s = stackOf('html', 'body', 'p', 'button', 'span');
    expect(s.hasInScope('p', 'default')).toBe(true);
    expect(s.hasInScope('p', 'button')).toBe(false);
  });

  it('distinguishes list-item scope from the default', () => {
    const s = stackOf('html', 'body', 'li', 'ul', 'span');
    expect(s.hasInScope('li', 'default')).toBe(true);
    expect(s.hasInScope('li', 'listItem')).toBe(false);
  });

  it('limits table scope to html, table and template', () => {
    const s = stackOf('html', 'table', 'tbody', 'tr', 'td', 'div');
    expect(s.hasInScope('tbody', 'table')).toBe(true);
    expect(s.hasInScope('div', 'table')).toBe(true);
  });

  // Select scope is INVERTED: everything except optgroup/option terminates it.
  it('inverts select scope', () => {
    expect(stackOf('html', 'select', 'optgroup', 'option').hasInScope('select', 'select')).toBe(true);
    expect(stackOf('html', 'select', 'div').hasInScope('select', 'select')).toBe(false);
  });

  it('removes an element from the middle', () => {
    const s = stackOf('html', 'body', 'div', 'p');
    const div = s.items[2] as { name: string };
    s.remove(div as never);
    expect(s.items.map((e) => e.name)).toEqual(['html', 'body', 'p']);
  });
});

describe('the list of active formatting elements', () => {
  it('clears to the last marker, keeping what precedes it', () => {
    const f = new ActiveFormatting();
    f.push(createElement('b'));
    f.pushMarker();
    f.push(createElement('i'));
    f.push(createElement('u'));
    f.clearToLastMarker();
    expect(f.items.length).toBe(1);
    expect((f.items[0] as { name: string }).name).toBe('b');
  });

  // Noah's Ark: at most three equal entries. Missing it grows the list without
  // bound and still renders correctly, so nothing visible reveals it.
  it('keeps at most three equal entries', () => {
    const f = new ActiveFormatting();
    for (let i = 0; i < 5; i++) f.push(createElement('b', new Map([['x', '1']])));
    expect(f.items.length).toBe(3);
  });

  it('counts equality by name and attributes, so a differing attribute is not equal', () => {
    const f = new ActiveFormatting();
    for (let i = 0; i < 4; i++) f.push(createElement('b', new Map([['x', String(i)])]));
    expect(f.items.length).toBe(4);
    expect(sameFormattingElement(
      createElement('b', new Map([['x', '1']])),
      createElement('b', new Map([['x', '1']])),
    )).toBe(true);
    expect(sameFormattingElement(
      createElement('b', new Map([['x', '1']])),
      createElement('b', new Map([['x', '2']])),
    )).toBe(false);
  });

  it('does not look past a marker for the last entry of a name', () => {
    const f = new ActiveFormatting();
    const early = createElement('b');
    f.push(early);
    f.pushMarker();
    expect(f.lastBetweenMarkerAndEnd('b')).toBeUndefined();
    const late = createElement('b');
    f.push(late);
    expect(f.lastBetweenMarkerAndEnd('b')).toBe(late);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmlstack.test.ts`
Expected: FAIL — `../src/htmlstack.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/htmlstack.ts`. The scope terminator sets, transcribed from §13.2.4.2:

```ts
const BASE_SCOPE = [
  'applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template',
];
const SCOPE_STOPPERS: Record<ScopeKind, string[]> = {
  default: BASE_SCOPE,
  listItem: [...BASE_SCOPE, 'ol', 'ul'],
  button: [...BASE_SCOPE, 'button'],
  table: ['html', 'table', 'template'],
  select: [],   // inverted — see hasInScope
};
```

`hasInScope` walks the stack from the top: a match returns true; for `select`, anything **other than** `optgroup`/`option` returns false; otherwise a name in the stopper list returns false.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmlstack.test.ts`
Expected: PASS, all 13 assertions.

- [ ] **Step 5: Prove three rules load-bearing**

Make `hasInScope` ignore its `kind` and always use `default`; run the file.
Expected: FAIL on the button, list-item and select cases. Revert.

Make `popUntilName` stop *before* the match; run the file.
Expected: FAIL on that case alone. Revert.

Delete the Noah's Ark clause; run the file.
Expected: FAIL on "keeps at most three equal entries" alone. Revert.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
npx vitest run test/htmlstack.test.ts
git add src/htmlstack.ts test/htmlstack.test.ts
git commit -m "feat(zch2.1.2): the stacks and their scope predicates

Its own module because these are pure list algorithms, testable from
hand-built element lists with no parser and no document — the split
floatstack.ts makes against floatbox.ts.

Three rules asserted alone because each is silent when wrong: the five scopes
are five different terminator lists and select scope is INVERTED; popUntilName
pops through the match rather than up to it; and Noah's Ark caps equal entries
at three, which has no visible symptom at all when missed."
```

---

## Task 5: The insertion modes, and the corpus turned on

The largest task. It lands the parser and drives the vendored corpus to green.

**Files:**
- Create: `src/htmltree.ts`
- Test: `test/htmltree.test.ts`, `test/wpt-tree.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `HtmlTokenizer`, `HtmlToken`, `TokenizerState` from `./htmltoken.js`.
- Produces:
  ```ts
  export function parseHtml(src: string): HtmlDocument;
  ```
  Not exported from `src/index.ts`.

Implement §13.2.6.4's insertion modes, all but "in template":

`Initial`, `BeforeHtml`, `BeforeHead`, `InHead`, `InHeadNoscript`, `AfterHead`, `InBody`, `Text`, `InTable`, `InTableText`, `InCaption`, `InColumnGroup`, `InTableBody`, `InRow`, `InCell`, `InSelect`, `InSelectInTable`, `AfterBody`, `InFrameset`, `AfterFrameset`, `AfterAfterBody`, `AfterAfterFrameset`.

Plus §13.2.6.4.7 (adoption agency), §13.2.6.1's "appropriate place for inserting a node" including foster parenting, "generate implied end tags" in both forms, and "reset the insertion mode appropriately".

- [ ] **Step 1: Write the failing hand-built test**

Create `test/htmltree.test.ts`. These cover the silent-when-wrong rules directly, so a corpus failure has a smaller companion that names the rule:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { serializeTree } from './helpers/wpt-tree.js';

const tree = (src: string) => serializeTree(parseHtml(src));

// Every expectation below is COPIED FROM THE CORPUS, with its source case
// named. None is derived by hand: an invented expectation in a plan sends the
// implementer chasing a tree the oracle never asked for. The file#index
// comments are how a failure here is traced back to the vendored case.
describe('tree construction', () => {
  // tests1.dat#0
  it('synthesizes html, head and body', () => {
    expect(tree('Test')).toBe('| <html>\n|   <head>\n|   <body>\n|     "Test"');
  });

  // tests1.dat#1
  it('auto-closes a p at a block start tag', () => {
    expect(tree('<p>One<p>Two')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <p>\n|       "One"\n|     <p>\n|       "Two"',
    );
  });

  // adoption01.dat#0. Wrong, the tree is merely mis-nested and still renders —
  // which is why the algorithm has a name rather than being "handle misnested
  // tags". Note the <a> is CLONED into the <p>: that clone is the algorithm's
  // whole observable effect here.
  it('runs the adoption agency on misnested formatting', () => {
    expect(tree('<a><p></a></p>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <a>\n|     <p>\n|       <a>',
    );
  });

  // adoption01.dat#5 — foster parenting AND the adoption agency together.
  // Everything lands BEFORE the <table>, never inside it.
  it('foster-parents stray content out of a table', () => {
    expect(tree('<table><a>1<p>2</a>3</p>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <a>\n|       "1"\n|     <p>\n|       <a>\n|         "2"\n|       "3"\n|     <table>',
    );
  });

  // tables01.dat#0 — the implied tbody/tr around a bare <th>.
  it('synthesizes tbody and tr around a bare th', () => {
    expect(tree('<table><th>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <tbody>\n|         <tr>\n|           <th>',
    );
  });

  // tests1.dat#25 — the <b> re-opens inside the <div>, which is reconstruction
  // doing its job; without it the second <b> is simply absent.
  it('reconstructs active formatting elements', () => {
    expect(tree('<p><b><div><marquee></p></b></div>X')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <p>\n|       <b>\n|     <div>\n|       <b>\n|         <marquee>\n|           <p>\n|           "X"',
    );
  });

  // html5test-com.dat#5
  it('keeps a doctype', () => {
    expect(tree('<!DOCTYPE html>')).toBe(
      '| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>',
    );
  });

  // comments01.dat#15 — <title> is RCDATA, so its content is text.
  it('drives the tokenizer into RCDATA for title', () => {
    expect(tree('<html><!-- comment --><title>Comment before head</title>')).toBe(
      '| <html>\n|   <!--  comment  -->\n|   <head>\n|     <title>\n|       "Comment before head"\n|   <body>',
    );
  });

  // tests1.dat#26 — <script> is RAWTEXT and <title> RCDATA; the tags inside
  // both are text, and the </div> after the script closes nothing.
  it('drives the tokenizer into RAWTEXT for script', () => {
    expect(tree('<script><div></script></div><title><p></title><p><p>')).toBe(
      '| <html>\n|   <head>\n|     <script>\n|       "<div>"\n|     <title>\n|       "<p>"\n|   <body>\n|     <p>\n|     <p>',
    );
  });

  it('never throws, on any input', () => {
    for (const s of ['', '<', '</>', '<!', '</p>', '<table><td>', '<b><i></b></i>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltree.test.ts`
Expected: FAIL — `../src/htmltree.js` does not exist.

- [ ] **Step 3: Implement the insertion modes**

Create `src/htmltree.ts`. Build it mode by mode, running `npx vitest run test/htmltree.test.ts` as each rule lands. The state a parser carries:

```ts
  private mode: InsertionMode = InsertionMode.Initial;
  /** ONE variable, not a stack — the spec says so, and a stack behaves
   *  identically until a document nests the constructs that expose it. */
  private originalMode: InsertionMode = InsertionMode.Initial;
  private readonly open = new OpenElements();
  private readonly formatting = new ActiveFormatting();
  private headElement: HtmlElement | undefined;
  private formElement: HtmlElement | undefined;
  private framesetOk = true;
  /** Buffered characters for InTableText. */
  private pendingTableChars: string[] = [];
  private pendingTableCharsNonWhitespace = false;
```

- [ ] **Step 4: Run the hand-built test to verify it passes**

Run: `npx vitest run test/htmltree.test.ts`
Expected: PASS, all 10 assertions.

- [ ] **Step 5: Turn on the vendored corpus**

Create `test/wpt-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { casesInBucket, serializeTree } from './helpers/wpt-tree.js';
import { parseHtml } from '../src/htmltree.js';

describe('WPT tree construction', () => {
  // There is no allowlist: every in-scope case runs. The bucket counts are
  // asserted in test/wpt-tree-suite.test.ts.
  for (const c of casesInBucket('inScope')) {
    it(`${c.file}#${c.index}: ${JSON.stringify(c.data).slice(0, 60)}`, () => {
      expect(serializeTree(parseHtml(c.data))).toBe(c.document);
    });
  }
});
```

Run: `npx vitest run test/wpt-tree.test.ts`

Fix `src/htmltree.ts` until all 1,328 pass. **Never edit a vendored expectation, and never move a case into another bucket to make it green** — the buckets are defined by the classification rules in Task 1, and changing one to dodge a failure is the silent-skip failure mode this whole design guards against. If a rule genuinely cannot be satisfied, stop and report it rather than reclassifying.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmltree.ts test/htmltree.test.ts test/wpt-tree.test.ts
git commit -m "feat(zch2.1.2): the insertion modes, and 1,328 WPT cases green

The 22 non-template insertion modes, the adoption agency, foster parenting,
implied end tags and reset-the-insertion-mode, over the stacks from
htmlstack.ts and the tokenizer's pull model.

No allowlist: every in-scope case runs, and the bucket counts are asserted
separately, so a case cannot be reclassified to dodge a failure."
```

---

## Task 6: Mutations, docs, and close

**Files:**
- Modify: `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Run the mutations and record what actually reddens**

Run each against `npx vitest run test/wpt-tree.test.ts test/htmltree.test.ts test/htmlstack.test.ts`, note which files and how many cases, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | Adoption agency reduced to a plain pop of the formatting element | `adoption01`, `adoption02`, `tricky01` |
| 2 | Foster parenting appends into the table instead of before it | `tables01` and the table cases in `tests*` |
| 3 | Reconstruction skipped before inserting text | the formatting cases in `tests1`/`tests2` |
| 4 | `hasInScope` ignores `kind` and always uses `default` | the `<p>` auto-close cases |
| 5 | `originalMode` made a stack rather than one variable | possibly NOTHING — record it if so |
| 6 | Implied end tags always use the "thoroughly" variant | the `</p>` and table-cell cases |

- [ ] **Step 2: Write the results into PROVENANCE.md**

Fill `## Mutation results` with the observed file names and counts, not the predictions. **A mutation that reddens nothing is the important result** — it means the corpus does not cover that rule, and it is recorded as an uncovered gap rather than left to be discovered.

- [ ] **Step 3: Add the CLAUDE.md source-list entry**

Insert immediately after the `htmltoken.ts` / `htmlcharref.ts` entry:

```markdown
- **htmldom.ts**, **htmlstack.ts**, **htmltree.ts** — HTML5 tree construction
  (HTML Standard §13.2.6), the half that turns `htmltoken.ts`'s token stream
  into a node tree. `htmldom.ts` is the node model, `htmlstack.ts` the stack of
  open elements and the active formatting elements, `htmltree.ts` the 22
  non-template insertion modes plus the adoption agency, foster parenting and
  implied end tags. Note the direction against `htmlsemantic.ts`, which is
  PDF→HTML. Nothing here produces PDF, and `parseHtml` is NOT exported from
  `index.ts` — that waits for `zch2.1.3`, because without foreign content an
  inline `<svg>` parses into the HTML namespace and is silently wrong.
  **Invariant:** all three are pure leaves and none throws — `htmlstack.ts` in
  particular must not import `htmltree.ts`, which is what keeps every scope
  predicate assertable from a hand-built element list.
  **Invariant:** `htmldom.ts`'s `appendChild` and `insertBefore` DETACH from the
  current parent first. The adoption agency moves live nodes, and a node
  reachable from two parents is a cycle that hangs the serializer rather than
  failing an assertion.
  **Invariant:** the five scopes are five different terminator lists, and
  `select` scope is INVERTED — everything except `optgroup`/`option` ends it.
  Using plain scope where BUTTON scope belongs changes when `<p>` auto-closes,
  which is one of the commonest shapes in real HTML.
  **Invariant:** foster parenting inserts BEFORE the table, never into it.
  Wrong, stray content lands inside the table and still displays.
  **Invariant:** "original insertion mode" is ONE variable, not a stack. A stack
  behaves identically until a document nests the constructs that expose it.
  **Note on the oracle, and it is NOT html5lib-tests:** anchored by
  web-platform-tests' `html/syntax/parsing/resources`, because html5lib-tests
  no longer carries tree-construction at all — its README records that the
  tests "are now solely maintained on web-platform-tests". Vendored under
  `test/fixtures/wpt/`, a separate directory because these fixtures are named
  for who produced the bytes. 1,328 of 1,936 cases run; the rest are fragment
  and foreign (`zch2.1.3`), scripted (the flag is off), or processing
  instructions — where the two vendored corpora genuinely disagree and we
  follow the tokenizer's (`zch2.9`).
```

Then run the repo's own sweep and confirm it names none of the three:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 4: Add the fixture-table row**

`CLAUDE.md`'s real-world fixture table gains:

```markdown
| `fixtures/wpt/` | `PROVENANCE.md` | The HTML tree-construction corpus, from web-platform-tests — html5lib-tests no longer carries it. 1,936 cases in five asserted buckets, 1,328 run here. Records a live disagreement between two upstreams over processing instructions, where our tokenizer follows its own pinned oracle |
```

- [ ] **Step 5: Add the CHANGELOG entry**

Under `## [Unreleased]`, in **Added**:

```markdown
- **HTML5 tree construction**, the second piece of HTML→PDF conversion
  (`zch2.1.2`). The 22 non-template insertion modes, the stack of open elements
  with its five distinct scope predicates, the active formatting elements with
  the Noah's Ark clause, the adoption agency algorithm that rescues misnested
  markup, and foster parenting — over the tokenizer that landed in `zch2.1.1`.
  Anchored by **1,328 web-platform-tests cases**, all green. The corpus is
  WPT's rather than html5lib's because html5lib-tests no longer carries
  tree-construction at all: its README records that the tests "are now solely
  maintained on web-platform-tests", which the original issue text did not
  know. Still not reachable from public API — `parseHtml` ships with foreign
  content in `zch2.1.3`, because without it an inline `<svg>` parses into the
  HTML namespace and produces a tree that is wrong silently rather than
  loudly. (`zch2.1.2`)
```

- [ ] **Step 6: Run the gates, commit, close, push**

```bash
npm run typecheck
npm test
git add -A src test docs CLAUDE.md CHANGELOG.md
git commit -m "feat(zch2.1.2): mutations recorded, docs, close

Six mutations run and recorded in PROVENANCE.md with observed counts rather
than predictions; any that reddened nothing are written down as uncovered."
bd close aspose-pdf-foss-for-ts-zch2.1.2
bd export -o .beads/issues.jsonl
git add .beads && git commit -m "chore(beads): close zch2.1.2"
git pull --rebase && git push && git status -sb
```

`git status` must show the branch up to date with origin.

---

## Self-review

**Spec coverage.** Fixture sourcing from WPT and the new directory → Task 1; the five buckets computed and asserted → Task 1; the errors decision → Task 1 (the reader never exposes them) and recorded in PROVENANCE; the PI exclusion → Task 1's `classify`; `htmldom.ts` mutable with parent pointers → Task 2; the serializer written from the format description → Task 3; `htmlstack.ts` as pure list algorithms and the five scopes → Task 4; the 22 insertion modes, adoption agency, foster parenting, implied end tags, reset-the-insertion-mode, the tokenizer seam → Task 5; nothing exported → Task 5's Produces block and the CLAUDE.md entry; the six mutations → Task 6.

**Two things the plan settles that the spec did not:**

1. **The serializer gets its own task**, before the parser exists, verified by reproducing a vendored `#document` byte for byte from a hand-built tree. The spec called it "the oracle's other half" without saying how it could be trusted; this is how.
2. **`appendChild`/`insertBefore` detach first.** The spec said the model is mutable; it did not say what happens on a move, and the adoption agency does nothing but move nodes.

**Known soft spot, flagged rather than hidden:** Task 5 is much larger than the others and its Step 3 is "build it mode by mode" rather than a literal transcription of 22 modes. That is deliberate — writing 22 insertion modes out longhand here would be the implementation, not a plan for it — but it means Task 5 is the one task a reviewer cannot gate in a single pass. Its Step 5 is the real gate: 1,328 vendored cases, no allowlist.
