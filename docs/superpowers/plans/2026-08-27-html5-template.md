# HTML5 `<template>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse `<template>` — its content fragment, the "in template" insertion mode and the mode stack — turning on 110 more vendored WPT cases and taking the in-scope corpus from 1,524 to 1,634.

**Architecture:** No new module. `src/htmldom.ts` gains a fourth node kind, `HtmlFragment`, hung off `HtmlElement.content` — a real node rather than a second children array, because a template's content is not part of the document and `zch2.2`'s traversal must not walk it. `src/htmltree.ts` gains `Mode.InTemplate` (the 21st and last), a `templateModes` stack, the insertion-location redirect that routes every child of a template into its content, and the `template` branches of `reset the insertion mode` and `</template>`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-html5-template-design.md`](../specs/2026-08-27-html5-template-design.md)

**Issue:** `zch2.1.3.2`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **Nothing throws.** No `throw` in `src/htmldom.ts` or `src/htmltree.ts`. Every string is a valid HTML document.
- **Purity.** Neither may import `document.js`, `page.js`, or any PDF object module.
- **Nothing is exported from `src/index.ts`.** `parseHtml` ships with `zch2.1.3.3`.
- **Spec names, verbatim.** `InTemplate`, `templateModes`, `generateImpliedEndTagsThoroughly`.
- **Declarative shadow DOM and the insertion-target machinery are NOT implemented** — no flag, no stub, no dead code. Both are measured unreachable (zero corpus cases mention `shadowroot` or a `for` attribute on a template) and are documented as decisions in Task 5.
- **THE STANDING FENCE: all 1,524 cases green today must stay green.** Tasks 1 and 2 end by running `npx vitest run test/wpt-tree.test.ts` and expecting **1,524** unchanged. Task 4 raises it to 1,634.
- **Never edit a vendored expectation, and never move a case between buckets to make it green.** If a rule genuinely cannot be satisfied, stop and report it.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. The full suite takes ~100s, so run them as separate commands or the 2-minute default timeout kills them.
- **Writing files:** this Windows/Git Bash setup eats backslashes in heredocs *and* in `node -e` one-liners, even with a quoted delimiter — and backticks inside a double-quoted `git commit -m` trigger command substitution and silently delete a word. Use the Write/Edit tools for any file containing escapes, and `git commit -F -` with a quoted heredoc for any message containing backticks. If a shell command must emit a backslash, build it with `String.fromCharCode(92)`.
- **CHANGELOG.md** gets an `## [Unreleased]` entry only in the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/htmldom.ts` | **Modify.** `HtmlFragment`, `HtmlElement.content`, widened `HtmlParent`/`HtmlNode`, `createFragment`, `childrenOf`. |
| `src/htmltree.ts` | **Modify.** `Mode.InTemplate`, `templateModes`, the insertion-location redirect and the foster fix, in-head's `<template>`/`</template>`, `inTemplate()`, reset's `template` branch. |
| `test/helpers/wpt-tree.ts` | **Modify.** Serializer's `content` line; retire the `template` bucket. |
| `test/htmldom.test.ts` | **Modify.** The content fragment. |
| `test/wpt-tree-suite.test.ts` | **Modify.** Serializer cases; the five bucket counts. |
| `test/htmltree.test.ts` | **Modify.** Hand-built template cases, copied from the corpus. |
| `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md` | **Modify.** Final task. |

---

## Reference: what the corpus expects

Copied from the vendored files on 2026-08-27. `content` is a bare word at
depth + 1 — no angle brackets — and the template's children sit at depth + 2.

```
template.dat#0   <body><template>Hello</template>
| <html>
|   <head>
|   <body>
|     <template>
|       content
|         "Hello"

template.dat#3   <html><template>Hello</template>
| <html>
|   <head>
|     <template>
|       content
|         "Hello"
|   <body>

template.dat#8   <table><template></template></table>
| <html>
|   <head>
|   <body>
|     <table>
|       <template>
|         content

template.dat#33  <table><template><tr><template><td></template></tr></template></table>
| <html>
|   <head>
|   <body>
|     <table>
|       <template>
|         content
|           <tr>
|             <template>
|               content
|                 <td>

template.dat#45  <body><template><tr></tr><td></td></template>
| <html>
|   <head>
|   <body>
|     <template>
|       content
|         <tr>
|         <tr>
|           <td>
```

`#33` is the nested-template case and the only thing in the corpus that can
tell a mode STACK from a single variable. `#45` shows the stack switching
twice within one template.

---

## Task 1: The content fragment in the node model

Lands the node kind with nothing using it, so the fence is unambiguous.

**Files:**
- Modify: `src/htmldom.ts`
- Modify: `test/helpers/wpt-tree.ts` (`serializeTree` only)
- Test: `test/htmldom.test.ts`, `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: `HtmlNamespace`, `createElement` (already present).
- Produces:
  ```ts
  export interface HtmlFragment {
    kind: 'fragment';
    children: HtmlNode[];
    parent: HtmlNode | null;
  }
  export interface HtmlElement { /* … */ content?: HtmlFragment; }
  export type HtmlNode =
    HtmlDocument | HtmlDoctype | HtmlElement | HtmlText | HtmlComment | HtmlFragment;
  export type HtmlParent = HtmlDocument | HtmlElement | HtmlFragment;
  export function createFragment(): HtmlFragment;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/htmldom.test.ts`:

```ts
describe('the template content fragment', () => {
  // A separate NODE, not a second children array: a template's content is not
  // part of the document, so zch2.2's traversal must not walk it, and
  // appendChild/removeChild need a real parent object to point at.
  it('creates a fragment that holds children like any parent', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    expect(frag.children).toEqual([el]);
    expect(el.parent).toBe(frag);
  });

  it('detaches from a fragment on a move, as from any parent', () => {
    const frag = createFragment();
    const doc = createDocument();
    const el = createElement('div');
    appendChild(frag, el);
    appendChild(doc, el);
    expect(frag.children).toEqual([]);
    expect(el.parent).toBe(doc);
  });

  it('removes a child of a fragment and clears its parent', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    removeChild(el);
    expect(frag.children).toEqual([]);
    expect(el.parent).toBeNull();
  });

  it('reports a fragment’s children through childrenOf', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    expect(childrenOf(frag)).toEqual([el]);
  });

  // Absent rather than empty on every other element: `content` present is how
  // the serializer and zch2.2 tell a template from anything else.
  it('leaves content absent on an ordinary element', () => {
    expect(createElement('div').content).toBeUndefined();
  });
});
```

Add `createFragment` to that file's import list from `../src/htmldom.js`.

Append to `test/wpt-tree-suite.test.ts`:

```ts
describe('template content in the serializer', () => {
  // template.dat#0. `content` is a BARE WORD at depth + 1 — no angle
  // brackets — and the template's children sit at depth + 2.
  it('writes a content fragment as a bare word one level in', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    appendChild(tmpl.content, { kind: 'text', data: 'Hello', parent: null });
    expect(serializeTree(doc)).toBe('| <template>\n|   content\n|     "Hello"');
  });

  it('writes an empty content fragment as the bare word alone', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    expect(serializeTree(doc)).toBe('| <template>\n|   content');
  });

  // A template's own children array stays empty and is NOT serialized — the
  // content fragment is the only place its children live.
  it('serializes the fragment rather than the element’s own children', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    appendChild(tmpl.content, createElement('span'));
    expect(serializeTree(doc)).toBe('| <template>\n|   content\n|     <span>');
  });
});
```

Add `createFragment` to that file's import list from `../src/htmldom.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/htmldom.test.ts test/wpt-tree-suite.test.ts`
Expected: FAIL — `createFragment` is not exported.

- [ ] **Step 3: Add the fragment to the node model**

In `src/htmldom.ts`, add after `HtmlComment`:

```ts
/** A template's content. A real node rather than a second children array on
 *  the element, for three reasons in order of what they cost when ignored:
 *  a template's content is NOT part of the document, so CSS must not match
 *  into it and zch2.2's traversal must not walk it — a separate node makes
 *  that structural rather than a rule every consumer has to remember;
 *  appendChild/insertBefore/removeChild need a real parent object to point at,
 *  or each would need a template special case; and it is the DOM's own shape,
 *  so the serializer's `content` line is a transcription rather than a
 *  synthesis. */
export interface HtmlFragment {
  kind: 'fragment';
  children: HtmlNode[];
  parent: HtmlNode | null;
}
```

Add to `HtmlElement`, after `children`:

```ts
  /** Present on a `template` element and nothing else. */
  content?: HtmlFragment;
```

Widen the two unions and `childrenOf`:

```ts
export type HtmlNode =
  HtmlDocument | HtmlDoctype | HtmlElement | HtmlText | HtmlComment | HtmlFragment;

/** A node that can hold children. */
export type HtmlParent = HtmlDocument | HtmlElement | HtmlFragment;
```

```ts
export function childrenOf(n: HtmlNode): HtmlNode[] {
  return n.kind === 'document' || n.kind === 'element' || n.kind === 'fragment'
    ? n.children : [];
}
```

`removeChild` gates on the parent's kind and must learn the new one:

```ts
  if (parent.kind !== 'document' && parent.kind !== 'element'
    && parent.kind !== 'fragment') return;
```

And the constructor:

```ts
export function createFragment(): HtmlFragment {
  return { kind: 'fragment', children: [], parent: null };
}
```

`HtmlChild` is unchanged: a fragment is never anybody's child, exactly as a
document is not.

- [ ] **Step 4: Teach the serializer the `content` line**

In `test/helpers/wpt-tree.ts`, inside `serializeTree`'s `case 'element'`, after
the attribute loop and BEFORE `walk(n.children, depth + 1)`:

```ts
          if (n.content !== undefined) {
            lines.push(`| ${'  '.repeat(depth + 1)}content`);
            walk(n.content.children, depth + 2);
          }
```

Nothing else in the serializer changes. A fragment is reached only through
`n.content` above and is never anybody's child, so the switch's existing
`default: break;` already covers the kind — do not add a `case 'fragment':`
that walks its children, or a template's content would be emitted twice at the
wrong depth if a fragment ever did appear in a children array.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run test/htmldom.test.ts test/wpt-tree-suite.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,524** — unchanged. Nothing sets `content` yet.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmldom.ts test/helpers/wpt-tree.ts test/htmldom.test.ts test/wpt-tree-suite.test.ts
git commit -F - <<'MSG'
feat(zch2.1.3.2): the template content fragment

A real node rather than a second children array on the element. A template's
content is NOT part of the document, so CSS must not match into it and
zch2.2's traversal must not walk it — a separate node makes that structural
rather than a rule every future consumer has to remember. It also gives
appendChild/insertBefore/removeChild a real parent to point at, so none of
them needs a template special case, and it is the DOM's own shape, which
makes the serializer's `content` line a transcription rather than a synthesis.

`content` is absent rather than empty on every other element: present is how
the serializer tells a template from anything else. The 1,524 green WPT cases
stay green — nothing sets it yet.
MSG
```

---

## Task 2: The insertion-location redirect, and the foster-parenting fix

Still inert — nothing creates a template element — so the fence holds again.
This task is separated from Task 3 because it fixes a bug that exists today
and a reviewer could reasonably accept it while rejecting the mode.

**Files:**
- Modify: `src/htmltree.ts` (`insertionLocation` only)
- Test: `test/wpt-tree.test.ts` (fence only; no new assertions)

**Interfaces:**
- Consumes: `HtmlFragment`, `HtmlElement.content` (Task 1).
- Produces: no new exports. `insertionLocation`'s signature is unchanged.

The two spec clauses, from "the appropriate place for inserting a node":

1. **Inside the foster block**, the search is for the last **template *or*
   table** in the stack of open elements, not the last table. If it finds a
   template, `targetParent` becomes that template — which then falls into
   clause 2. **Ours searches for a table only, and that is a live bug**: stray
   content inside `<template><table>` fosters past the template to whatever
   encloses it. It is unreachable until a template can be on the stack, which
   is why it has never shown up.
2. **After the foster block**, if the target is a template element, the
   location is its **content fragment**, with no reference child. That one
   clause is what routes every child of a template into the right place.

- [ ] **Step 1: Rewrite `insertionLocation`**

Replace the whole method in `src/htmltree.ts` with:

```ts
  /** "The appropriate place for inserting a node". Two rules that are each
   *  invisible when wrong:
   *
   *  Foster parenting is why this is not simply "the current node": stray
   *  content in a table lands BEFORE the table, never inside it, and wrong it
   *  still displays. The search is for the last TEMPLATE OR TABLE — a
   *  table-only search fosters past an enclosing template, which was a live
   *  bug from zch2.1.2 until templates made it reachable.
   *
   *  And a template's children go in its CONTENT FRAGMENT, never among its own
   *  children. That single clause is what makes template parsing work at all. */
  private insertionLocation(overrideTarget?: HtmlElement): InsertLocation {
    const target = overrideTarget ?? this.open.current;
    if (target === undefined) return { parent: this.document };

    const fosterable = target.ns === 'html'
      && (target.name === 'table' || target.name === 'tbody'
        || target.name === 'tfoot' || target.name === 'thead' || target.name === 'tr');
    if (!this.fosterParenting || !fosterable) return this.underTemplate(target);

    let last: HtmlElement | undefined;
    let lastIndex = -1;
    for (let i = this.open.items.length - 1; i >= 0; i--) {
      const el = this.open.items[i] as HtmlElement;
      if (el.ns === 'html' && (el.name === 'template' || el.name === 'table')) {
        last = el;
        lastIndex = i;
        break;
      }
    }
    if (last === undefined) {
      const root = this.open.items[0];
      return root === undefined ? { parent: this.document } : this.underTemplate(root);
    }
    if (last.name === 'template') return this.underTemplate(last);

    const parent = last.parent;
    if (parent !== null && (parent.kind === 'element' || parent.kind === 'document')) {
      return { parent, before: last };
    }
    const above = this.open.items[lastIndex - 1];
    return above === undefined ? { parent: this.document } : this.underTemplate(above);
  }

  /** The last clause of "the appropriate place for inserting a node": a
   *  template's children go in its CONTENT FRAGMENT. Its own children array
   *  stays empty for the life of the parse. */
  private underTemplate(el: HtmlElement): InsertLocation {
    if (el.ns === 'html' && el.name === 'template' && el.content !== undefined) {
      return { parent: el.content };
    }
    return { parent: el };
  }
```

The template test is factored into `underTemplate` rather than run once at the
end, because the foster block has four exits and three of them can land on a
template. Writing it once at the end would need `target` to be reassignable
across those exits, which forces a cast — the foster block's
"`last`'s parent" exit legitimately yields a **document**, and a document is
not an `HtmlElement`.

- [ ] **Step 2: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,524** — unchanged. No template element exists yet, so the
new clauses are unreachable and the rewrite must be behaviour-preserving. **If
this is red, the rewrite changed foster parenting for tables and nothing later
in this plan will make sense.**

- [ ] **Step 3: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmltree.ts
git commit -F - <<'MSG'
feat(zch2.1.3.2): the insertion-location template redirect

Two clauses from "the appropriate place for inserting a node". A template's
children go in its CONTENT FRAGMENT, never among its own children — that one
clause is what makes template parsing work at all.

And the foster-parenting search is for the last TEMPLATE OR TABLE on the
stack, not the last table. Ours searched for a table only, which fosters
stray content past an enclosing template to whatever encloses THAT: a live
bug shipped in zch2.1.2, invisible because a template could never be on the
stack until now. Fixed here rather than filed, because this is the issue that
makes it reachable.

Still inert: no template element exists yet, so the 1,524 green WPT cases
staying green is evidence the rewrite preserved table foster parenting.
MSG
```

---

## Task 3: The mode, the stack, and the corpus turned on

**Files:**
- Modify: `src/htmltree.ts`
- Modify: `test/helpers/wpt-tree.ts` (the bucket predicate)
- Test: `test/htmltree.test.ts`, `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: no new exports.

### What to implement

**`Mode.InTemplate`**, added to the enum after `InCell`, and
`private templateModes: Mode[] = [];` beside `originalMode`.

**In-head's `<template>` start tag** (the collapsed form — the spec's other
eleven steps are declarative shadow DOM, which is off):

1. Insert a marker in the list of active formatting elements.
2. `framesetOk = false`.
3. Switch the insertion mode to `InTemplate`.
4. Push `InTemplate` onto `templateModes`.
5. Insert an HTML element for the token, and give it a content fragment.

**In-head's `</template>` end tag** (collapsed: the insertion-target unwind
needs a `for` attribute nobody reads):

1. If there is no `template` on the stack of open elements, ignore the token.
2. Otherwise: generate all implied end tags **thoroughly**; pop through the
   `template`; clear the active formatting elements to the last marker; pop
   `templateModes`; reset the insertion mode appropriately.

**`inTemplate(t)`**, §13.2.6.4.16:

| Token | Action |
|---|---|
| character, comment, doctype | process with "in body" |
| start `base`,`basefont`,`bgsound`,`link`,`meta`,`noframes`,`script`,`style`,`template`,`title`; end `template` | process with "in head" |
| start `caption`,`colgroup`,`tbody`,`tfoot`,`thead` | pop `templateModes`, push `InTable`, switch to `InTable`, reprocess |
| start `col` | same, with `InColumnGroup` |
| start `tr` | same, with `InTableBody` |
| start `td`,`th` | same, with `InRow` |
| any other start tag | same, with `InBody` |
| any other end tag | ignore |
| EOF | if no `template` on the stack, stop parsing; otherwise pop through the `template`, clear to the last marker, pop `templateModes`, reset the insertion mode, and **reprocess** |

**`resetInsertionMode` gains its `template` branch**, before the `head` case:

```ts
        case 'template': {
          const mode = this.templateModes[this.templateModes.length - 1];
          if (mode !== undefined) { this.mode = mode; return; }
          break;
        }
```

**The module header** says "The 20 non-template modes are here" — with this
task there are 21 and it is the complete set §13.2.6.4 defines. Correct it.

- [ ] **Step 1: Write the failing hand-built test**

Append to `test/htmltree.test.ts`. Every expectation is **copied from the
corpus with its case id**; none is invented:

```ts
describe('template', () => {
  // template.dat#0 — `content` is a bare word at depth + 1, the children at
  // depth + 2. A template's own children array stays empty.
  it('puts a template’s children in its content fragment', () => {
    expect(tree('<body><template>Hello</template>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <template>\n|       content\n|         "Hello"',
    );
  });

  // template.dat#3 — a template before <body> stays in <head>.
  it('keeps a template in head when that is where it opened', () => {
    expect(tree('<html><template>Hello</template>')).toBe(
      '| <html>\n|   <head>\n|     <template>\n|       content\n|         "Hello"\n|   <body>',
    );
  });

  // template.dat#8 — a template inside a table is NOT foster-parented out.
  it('leaves a template inside a table', () => {
    expect(tree('<table><template></template></table>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <template>\n|         content',
    );
  });

  // template.dat#33 — the ONLY corpus case that can tell a mode STACK from a
  // single variable: the inner template must restore the outer one's mode.
  it('nests templates, restoring the outer mode', () => {
    expect(tree('<table><template><tr><template><td></template></tr></template></table>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <template>\n|         content\n|           <tr>\n|             <template>\n|               content\n|                 <td>',
    );
  });

  // template.dat#45 — the stack switching twice inside one template.
  it('switches template mode per table construct', () => {
    expect(tree('<body><template><tr></tr><td></td></template>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <template>\n|       content\n|         <tr>\n|         <tr>\n|           <td>',
    );
  });

  it('never throws on template input', () => {
    for (const s of ['<template>', '</template>', '<template><template>',
      '<table><template><td>', '<template></body></template>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltree.test.ts`
Expected: FAIL — a template currently parses as an ordinary element with its
children among its own, so no `content` line appears.

- [ ] **Step 3: Implement the mode and the stack**

Work in `src/htmltree.ts`, running `npx vitest run test/htmltree.test.ts` as
each rule lands. Land them in this order, which is the order they unblock each
other: the enum member and the stack field; in-head's `<template>`; the
`resetInsertionMode` branch; `inTemplate`; in-head's `</template>`; the EOF
case.

To read a real expectation rather than guess one, create this scratch file and
delete it in Step 7:

```ts
// test/_show.test.ts — SCRATCH, delete before committing.
import { it } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { serializeTree, loadWptCases } from './helpers/wpt-tree.js';

it('show', () => {
  for (const spec of (process.env.SHOW ?? '').split(',').filter((s) => s !== '')) {
    const [f, i] = spec.split('#');
    const c = loadWptCases([f as string])[Number(i)];
    if (c === undefined) { console.log(`${spec}: no such case`); continue; }
    console.log(`=== ${spec}`);
    console.log('IN  : ' + JSON.stringify(c.data));
    console.log('WANT:\n' + c.document);
    console.log('GOT :\n' + serializeTree(parseHtml(c.data)));
  }
});
```

Run it as `SHOW="template.dat#33" npx vitest run test/_show.test.ts`.

- [ ] **Step 4: Run the hand-built test to verify it passes**

Run: `npx vitest run test/htmltree.test.ts`
Expected: PASS.

- [ ] **Step 5: Retire the template bucket**

In `test/helpers/wpt-tree.ts`, DELETE the template line from `classify`
outright — there is no successor test — and drop `'template'` from the
`Bucket` union:

```ts
export type Bucket =
  | 'inScope' | 'fragment' | 'scripted' | 'processingInstruction' | 'selectedContent';
```

Update `test/wpt-tree-suite.test.ts`:

```ts
    expect(all.length).toBe(1936);
    expect(casesInBucket('fragment').length).toBe(196);
    expect(casesInBucket('scripted').length).toBe(14);
    expect(casesInBucket('selectedContent').length).toBe(4);
    expect(casesInBucket('processingInstruction').length).toBe(88);
    expect(casesInBucket('inScope').length).toBe(1634);
    const sum = (['fragment', 'scripted', 'selectedContent',
      'processingInstruction', 'inScope'] as const)
      .reduce((n, b) => n + casesInBucket(b).length, 0);
    expect(sum).toBe(1936);
```

**The 112 template cases do NOT all become in-scope. 110 do; two become
processing-instruction cases** — `processing-instructions.dat#119` and `#123`,
which expect a real ProcessingInstruction node *inside* template content and
so belong to `zch2.9`'s exclusion. The template predicate was masking them.
Add an assertion so that stays visible rather than being rediscovered:

```ts
  // The template bucket was MASKING two processing-instruction cases: both
  // expect a real PI node inside template content, which is zch2.9's
  // disagreement and not this issue's work. Retiring the template predicate
  // reveals them and the PI predicate claims them with no change.
  it('claims the two template cases that are really PI cases', () => {
    const pi = casesInBucket('processingInstruction').map((c) => `${c.file}#${c.index}`);
    expect(pi).toContain('processing-instructions.dat#119');
    expect(pi).toContain('processing-instructions.dat#123');
  });
```

- [ ] **Step 6: Turn on the corpus and drive it green**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: 1,634 cases collected. Fix `src/htmltree.ts` until all pass.

**Never edit a vendored expectation, and never move a case into another bucket
to make it green.** If a rule genuinely cannot be satisfied, stop and report
it. If the corpus contradicts this plan about the spec, the corpus wins and
the contradiction gets recorded — `zch2.1.2`'s `select` finding and
`zch2.1.3.1`'s `popUntilName` finding both arrived that way.

- [ ] **Step 7: Delete the scratch file and commit**

```bash
rm -f test/_show.test.ts
npm run typecheck
npm test
git add src/htmltree.ts test/helpers/wpt-tree.ts test/htmltree.test.ts test/wpt-tree-suite.test.ts
git commit -F - <<'MSG'
feat(zch2.1.3.2): the in-template mode, the mode stack, 1,634 WPT cases green

Mode.InTemplate is the 21st insertion mode, and with it htmltree.ts
implements every mode §13.2.6.4 defines — the header's "20 non-template
modes" is corrected.

The stack is what a single variable cannot be: a template can nest inside a
table cell inside another template, and each level has to remember what it
was doing. template.dat#33 is the only corpus case that can tell the two
apart.

It also lights up two things zch2.1.2 left cold: reset-the-insertion-mode
gains its template branch, and generateImpliedEndTagsThoroughly gets its
first caller — </template> is the spec's only call site, which is why that
function shipped unreached and documented as such.

The template bucket is RETIRED, its predicate deleted outright. Its 112 cases
do not all become in-scope: 110 do and TWO are really processing-instruction
cases the template predicate was masking, now claimed by the PI predicate
with no change. 1,524 -> 1,634 in scope, five buckets, all asserted.
MSG
```

---

## Task 4: Mutations, docs, and close

**Files:**
- Modify: `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Run the mutations and record what actually reddens**

Run each against
`npx vitest run test/wpt-tree.test.ts test/htmltree.test.ts test/htmldom.test.ts test/wpt-tree-suite.test.ts`,
note the count and the files, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | The content fragment never created (children land on the element) | nearly every `template.dat` case |
| 2 | The insertion-location template redirect dropped | the same, and the sharper of the two |
| 3 | `template` removed from the foster-parenting search | the `<template><table>` cases |
| 4 | `templateModes` made a single variable rather than a stack | `template.dat#33` — possibly it alone |
| 5 | `resetInsertionMode`'s `template` branch dropped | the table-in-template cases |
| 6 | `generateImpliedEndTagsThoroughly` swapped for the ordinary variant | possibly NOTHING — record it if so |

- [ ] **Step 2: Write the results into PROVENANCE.md**

Append a `### zch2.1.3.2` subsection under `## Mutation results` with the
observed file names and counts, **not the predictions**. A mutation that
reddens nothing is the important result: it means the corpus does not cover
that rule, and it is recorded as an uncovered gap rather than left to be
discovered — `zch2.1.2` recorded exactly one such ("original insertion mode is
one variable") and `zch2.1.3.1` recorded one that reddened a single case.

Update the `## Buckets` table to the five new counts, and add the
template-masking finding to `## Exclusions` under the processing-instruction
entry:

```markdown
Two of the 86 arrive only with `zch2.1.3.2`, which retired the `template`
bucket: `processing-instructions.dat#119` and `#123` expect a real PI node
INSIDE template content, so the template predicate was matching them first.
Retiring it revealed them and the PI predicate claimed them with no change,
taking the exclusion to 88.
```

- [ ] **Step 3: Update the CLAUDE.md source-list entry**

The `htmldom.ts`/`htmlstack.ts`/`htmlforeign.ts`/`htmltree.ts` entry gains
these, and its case counts go from 1,524 to 1,634:

```markdown
  **Invariant:** a template's children live in its `content` FRAGMENT, never
  among its own children, and the fragment is a real node rather than a second
  array. A template's content is not part of the document — CSS must not match
  into it and `zch2.2`'s traversal must not walk it — so a separate node makes
  that structural rather than a rule every consumer has to remember, and it
  gives `appendChild`/`removeChild` a real parent to point at. `content` is
  ABSENT rather than empty on every other element.
  **Invariant:** foster parenting searches for the last TEMPLATE OR TABLE on
  the stack, not the last table. A table-only search fosters stray content
  past an enclosing template to whatever encloses THAT — a live bug from
  `zch2.1.2` until `zch2.1.3.2` made it reachable.
  **Invariant:** "original insertion mode" is ONE variable but the TEMPLATE
  insertion mode is a STACK, and the difference is real: a template can nest
  inside a table cell inside another template, and each level has to remember
  what it was doing. `template.dat#33` is the only vendored case that can tell
  the two apart.
  **Note:** with `InTemplate`, `htmltree.ts` implements all 21 modes
  §13.2.6.4 defines, and `generateImpliedEndTagsThoroughly` — which shipped
  unreached in `zch2.1.2` — has its one and only caller in `</template>`.
  **Note on two spec branches deliberately absent:** the `<template>` start
  tag is fourteen steps, eleven of them DECLARATIVE SHADOW DOM, gated on a
  parser flag that is false for anything that is not a browser — and the
  spec's own first sub-step then says "insert an HTML element for the token
  and return", which is the collapsed form we write. `</template>`'s
  INSERTION-TARGET unwind is null unless something reads a template's `for`
  attribute, and nothing does. Both measured unreachable: the corpus contains
  zero cases mentioning either. Neither gets a flag or a stub.
```

Then run the repo's own sweep and confirm it names no new gap:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Also update the fixture-table row's "1,524 run here" to "1,634 run here".

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## [Unreleased]`, in **Added**, above the foreign-content entry:

```markdown
- **HTML5 `<template>`**, the last insertion mode the parser was missing. The
  "in template" mode (HTML Standard §13.2.6.4.16) and the stack of template
  insertion modes beside it, plus a template's content fragment — a real node
  in the tree rather than an extra children array, because a template's
  content is deliberately not part of the document and nothing that walks the
  document should walk it. **1,634 of the 1,936 vendored web-platform-tests
  cases now run, all green**, up from 1,524, and `htmltree.ts` now implements
  every one of the 21 insertion modes the spec defines. It also fixes a defect
  shipped in `zch2.1.2` and invisible until now: foster parenting searched the
  stack for the last *table* where the spec says the last *template or table*,
  so stray content inside `<template><table>` fostered past the template
  entirely. Two spec branches are deliberately absent and documented as
  decisions rather than gaps — declarative shadow DOM, which is gated on a
  parser flag no non-browser sets, and the insertion-target machinery behind a
  template's `for` attribute, which nothing reads; the corpus contains zero
  cases touching either. Still not reachable from public API — `parseHtml`
  ships with fragment parsing in `zch2.1.3.3`. (`zch2.1.3.2`)
```

- [ ] **Step 5: Run the gates, commit, close, push**

```bash
npm run typecheck
npm test
git add -A src test docs CLAUDE.md CHANGELOG.md
git commit -F - <<'MSG'
feat(zch2.1.3.2): mutations recorded, docs, close

Six mutations run and recorded in PROVENANCE.md with observed counts rather
than predictions; any that reddened nothing are written down as uncovered.
MSG
bd close aspose-pdf-foss-for-ts-zch2.1.3.2
bd export -o .beads/issues.jsonl
git add .beads && git commit -F - <<'MSG'
chore(beads): close zch2.1.3.2
MSG
git pull --rebase && git push && git status -sb
```

`git status` must show the branch up to date with origin.

---

## Self-review

**Spec coverage.** The content fragment as a real node, and its serialization
→ Task 1; the insertion-location redirect and the foster-parenting fix →
Task 2; `Mode.InTemplate`, the stack, in-head's two tags, `inTemplate`, the
reset branch and the first caller of the thorough variant → Task 3; the
bucket retirement, the corrected arithmetic and the two masked PI cases →
Task 3 Step 5; the two deliberately-absent spec branches → Task 4 Step 3; the
six named mutations → Task 4 Step 1.

**Three things the plan settles that the spec did not:**

1. **The foster fix is its own task**, ahead of the mode. It is a bug that
   exists today, so a reviewer can accept it while rejecting the mode — and
   isolating it is what makes "the 1,524 stayed green" evidence that the
   `insertionLocation` rewrite preserved table foster parenting, rather than
   evidence tangled with a hundred new cases.
2. **`HtmlChild` does not widen.** A fragment is never anybody's child,
   exactly as a document is not, so `appendChild(frag, x)` typechecks while
   `appendChild(x, frag)` does not.
3. **The two masked PI cases get their own assertion**, so the finding stays
   visible in the suite rather than only in a provenance document.

**Known soft spot, flagged rather than hidden:** mutations 4 and 6 are the
likely-empty ones. The mode stack is pinned by a single vendored case
(`template.dat#33`), so if mutation 4 reddens only that one, the stack's
justification rests on one case plus the spec — say so in PROVENANCE. Mutation
6 may redden nothing at all, since `generateImpliedEndTagsThoroughly`'s extra
names are the table-section tags and a `</template>` rarely has one open;
`zch2.1.2` already measured that using the thorough list EVERYWHERE reddens 83
cases, which is a different claim from this one.
