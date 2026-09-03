# HTML5 Fragment Parsing and the `parseHtml` Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the HTML fragment parsing algorithm, turning on the last 196 vendored WPT cases (1,634 → 1,830), and export `parseHtml` from `src/index.ts`.

**Architecture:** No new module. `src/htmltree.ts`'s `TreeBuilder` gains an optional fragment context: a synthetic `html` root that is the whole stack of open elements, tokenizer priming from the context's name, and the fragment-case branches of `adjustedCurrentNode` and `resetInsertionMode` — two seams the preceding issues named deliberately so this one would not have to hunt call sites. `src/index.ts` gains one function and the types its return value needs.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-html5-fragment-parsing-design.md`](../specs/2026-08-27-html5-fragment-parsing-design.md)

**Issue:** `zch2.1.3.3`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **Nothing throws.** No `throw` in `src/htmldom.ts` or `src/htmltree.ts`. Every string is a valid HTML document.
- **Purity.** Neither may import `document.js`, `page.js`, or any PDF object module.
- **`parseHtml(src: string): HtmlDocument` is the whole public surface.** No options bag, no error list, no second entry. Parse errors stay on the tokenizer.
- **`parseHtmlFragment` is implemented, fully tested, and NOT re-exported from `src/index.ts`.**
- **The mutation helpers are NOT exported** — `appendChild`, `insertBefore`, `removeChild`, `createElement`, `createFragment`, `createText`, `createComment`, `createDoctype` all stay internal.
- **THE STANDING FENCE: all 1,634 cases green today must stay green.** Tasks 1 and 2 end by running `npx vitest run test/wpt-tree.test.ts` and expecting **1,634** unchanged. Task 3 raises it to 1,830.
- **Never edit a vendored expectation, and never move a case between buckets to make it green.** If a rule genuinely cannot be satisfied, stop and report it.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. The full suite takes ~100s, so run them as separate commands or the 2-minute default timeout kills them.
- **Writing files:** this Windows/Git Bash setup eats backslashes in heredocs *and* in `node -e` one-liners, even with a quoted delimiter — and backticks inside a double-quoted `git commit -m` trigger command substitution and silently delete a word. Use the Write/Edit tools for any file containing escapes, and `git commit -F -` with a quoted heredoc for any message containing backticks. If a shell command must emit a backslash, build it with `String.fromCharCode(92)`.
- **CHANGELOG.md** gets an `## [Unreleased]` entry only in the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/htmltree.ts` | **Modify.** `FragmentContext`, the `TreeBuilder` fragment constructor path, tokenizer priming, `adjustedCurrentNode`'s real definition, `resetInsertionMode`'s fragment branches, the form pointer, `parseHtmlFragment`. |
| `src/index.ts` | **Modify.** Export `parseHtml` and the node types. |
| `test/helpers/wpt-tree.ts` | **Modify.** Parse `fragmentContext` into `{ ns, name }`; add `serializeFragment`; retire the `fragment` bucket. |
| `test/htmltree.test.ts` | **Modify.** Hand-built fragment cases, copied from the corpus. |
| `test/wpt-tree-suite.test.ts` | **Modify.** Context parsing, `serializeFragment`, the four bucket counts. |
| `test/wpt-tree.test.ts` | **Modify.** Drive fragment cases through `parseHtmlFragment`. |
| `test/html-public-api.test.ts` | **Create.** What `index.ts` does and does not export. |
| `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md` | **Modify.** Final task. |

---

## Reference: what the corpus expects

A fragment expectation serializes the **root's children at depth 0** — no
document wrapper. The `#document-fragment` line is a bare name for an HTML
context and two space-separated words for a foreign one.

```
tests_innerHTML_1.dat#0   context "body"      <body><span>
| <span>

tests_innerHTML_1.dat#2   context "div"       <span><body>
| <span>

foreign-fragment.dat#0    context "svg path"  <nobr>X
| <nobr>
|   "X"

foreign-fragment.dat#4    context "svg path"  </path>X
| "X"
```

`foreign-fragment.dat#0` is the case that proves `adjustedCurrentNode`: with
the old alias, `<nobr>` is inserted by "in body" as an HTML element and the
`X` lands beside it rather than inside.

The 196 contexts, measured: **91** table-ish (`table` 12, `tbody` 20,
`thead` 2, `tfoot` 2, `tr` 15, `td` 19, `caption` 18, `colgroup` 3),
**67** foreign (32 `svg …`, 35 `math …`), **6** tokenizer-primed
(`textarea` 2, `style` 1, `plaintext` 1, `title` 1, `script` 1), **1**
`template`, and the rest ordinary (`div` 11, `html` 7, `body` 5, `select` 5,
`head` 1, `frameset` 2).

---

## Task 1: The context type, the loader's parse, and `serializeFragment`

Test-side only. Lands the vocabulary the parser will need, with the parser
unchanged, so the fence is unambiguous.

**Files:**
- Modify: `src/htmltree.ts` (the `FragmentContext` type export only)
- Modify: `test/helpers/wpt-tree.ts`
- Test: `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: `HtmlNamespace`, `HtmlFragment`, `createFragment` (already present).
- Produces:
  ```ts
  // src/htmltree.ts
  export interface FragmentContext { name: string; ns?: HtmlNamespace; }

  // test/helpers/wpt-tree.ts
  export interface WptCase { /* … */ fragmentContext?: FragmentContext; }
  export function serializeFragment(frag: HtmlFragment): string;
  ```

`WptCase.fragmentContext` changes type from `string` to `FragmentContext`.
That is the point: 67 of the 196 contexts are foreign and a bare name cannot
carry them.

- [ ] **Step 1: Write the failing test**

Append to `test/wpt-tree-suite.test.ts`:

```ts
describe('the fragment context and its serialization', () => {
  // The .dat line is a bare name for an HTML context and two words for a
  // foreign one. 67 of the 196 are foreign, so a bare string cannot carry it.
  it('parses a bare context name as HTML', () => {
    const c = loadWptCases(['tests_innerHTML_1.dat'])[0];
    expect(c?.fragmentContext).toEqual({ name: 'body' });
  });

  it('parses a two-word context into a namespace and a name', () => {
    const c = loadWptCases(['foreign-fragment.dat'])[0];
    expect(c?.fragmentContext).toEqual({ name: 'path', ns: 'svg' });
  });

  it('parses a math context', () => {
    const c = loadWptCases(['foreign-fragment.dat'])
      .find((x) => x.fragmentContext?.ns === 'math');
    expect(c?.fragmentContext?.ns).toBe('math');
  });

  it('leaves fragmentContext absent on a document case', () => {
    expect(loadWptCases(['tests1.dat'])[0]?.fragmentContext).toBeUndefined();
  });

  // A fragment expectation has NO document wrapper: the root's children are
  // serialized at depth 0.
  it('serializes a fragment at depth zero', () => {
    const frag = createFragment();
    const span = createElement('span');
    appendChild(frag, span);
    appendChild(span, { kind: 'text', data: 'x', parent: null });
    expect(serializeFragment(frag)).toBe('| <span>\n|   "x"');
  });

  it('serializes an empty fragment as the empty string', () => {
    expect(serializeFragment(createFragment())).toBe('');
  });

  it('reproduces a vendored fragment expectation exactly', () => {
    const expected = loadWptCases(['tests_innerHTML_1.dat'])[0]?.document;
    const frag = createFragment();
    appendChild(frag, createElement('span'));
    expect(serializeFragment(frag)).toBe(expected);
  });
});
```

Add `serializeFragment` to that file's import list from
`./helpers/wpt-tree.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: FAIL — `serializeFragment` is not exported and `fragmentContext` is
still a string.

- [ ] **Step 3: Export the context type from `src/htmltree.ts`**

Add near the top of `src/htmltree.ts`, after the `Mode` enum:

```ts
/** A fragment parse's context element, as §13.4's "context". The namespace
 *  matters: 67 of the corpus's 196 fragment contexts are SVG or MathML, and a
 *  bare name cannot say which. */
export interface FragmentContext {
  name: string;
  ns?: HtmlNamespace;
}
```

- [ ] **Step 4: Parse the context and add the serializer**

In `test/helpers/wpt-tree.ts`, import the type and change the field:

```ts
import type { FragmentContext } from '../../src/htmltree.js';
```

```ts
export interface WptCase {
  file: string;
  index: number;
  data: string;
  document: string;
  fragmentContext?: FragmentContext;
  bucket: Bucket;
}
```

Add the parser above `loadWptCases`:

```ts
/** `#document-fragment` is a bare name for an HTML context (`td`) and two
 *  space-separated words for a foreign one (`svg path`, `math ms`). */
function parseFragmentContext(line: string): FragmentContext {
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 2 && (parts[0] === 'svg' || parts[0] === 'math')) {
    return { name: parts[1] as string, ns: parts[0] };
  }
  return { name: parts[0] as string };
}
```

and use it where the raw string was taken:

```ts
      const rawContext = s['document-fragment']?.join('\n');
      const fragmentContext = rawContext === undefined
        ? undefined : parseFragmentContext(rawContext);
```

leaving the spread that follows unchanged.

Add the serializer beside `serializeTree`, sharing nothing but the format:

```ts
/** A fragment expectation has NO document wrapper — the root's children are
 *  serialized at depth 0. Built by wrapping the fragment's children in a
 *  throwaway document so the one walk in serializeTree stays the only walk. */
export function serializeFragment(frag: HtmlFragment): string {
  const doc = createDocument();
  for (const child of frag.children) doc.children.push(child);
  return serializeTree(doc);
}
```

Add `createDocument` and the `HtmlFragment` type to that file's imports from
`../../src/htmldom.js`.

Note the children are pushed directly rather than through `appendChild`: that
would reparent them and destroy the very tree being serialized.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/wpt-tree-suite.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,634** — unchanged. Nothing in the parser has moved.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmltree.ts test/helpers/wpt-tree.ts test/wpt-tree-suite.test.ts
git commit -F - <<'MSG'
test(zch2.1.3.3): the fragment context type and serializeFragment

WptCase.fragmentContext stops being a raw string and becomes
{ name, ns? }. That is the point rather than tidiness: 67 of the corpus's 196
fragment contexts are `svg …` or `math …`, and a bare name cannot say which.

serializeFragment writes a fragment's children at depth 0, which is how the
corpus writes a fragment expectation — no document wrapper. It wraps them in
a throwaway document so serializeTree stays the only walk, and pushes them
directly rather than through appendChild, which would reparent them and
destroy the tree being serialized.

Test-side only; the 1,634 green WPT cases are untouched.
MSG
```

---

## Task 2: `adjustedCurrentNode` and `resetInsertionMode`'s fragment branches

Still inert — no fragment parse exists to set a context — so the fence holds
again. Separated from Task 3 because these are the two seams the preceding
issues named deliberately, and a reviewer can check them against the spec
without reading the fragment algorithm.

**Files:**
- Modify: `src/htmltree.ts`
- Test: `test/wpt-tree.test.ts` (fence only)

**Interfaces:**
- Consumes: `FragmentContext` (Task 1).
- Produces: no new exports. `TreeBuilder` gains a private
  `fragmentContextElement: HtmlElement | undefined`, undefined for a document
  parse.

- [ ] **Step 1: Add the field and give `adjustedCurrentNode` its real body**

In `src/htmltree.ts`, add beside the other `TreeBuilder` fields:

```ts
  /** §13.4's "fragment context element", undefined for a document parse. */
  private fragmentContextElement: HtmlElement | undefined;
```

Replace `adjustedCurrentNode` entirely:

```ts
  /** §13.2.4.2. The fragment context element when the stack of open elements
   *  holds exactly ONE element, and the current node otherwise.
   *
   *  This returned the current node from zch2.1.3.1 until fragments existed,
   *  named correctly on purpose so this issue would not have to find its call
   *  sites. The difference is the whole foreign-fragment group: with the
   *  alias, `<nobr>X` in an `svg path` context is inserted by "in body" as an
   *  HTML element instead of being parsed as foreign content. */
  private adjustedCurrentNode(): HtmlElement | undefined {
    if (this.fragmentContextElement !== undefined && this.open.items.length === 1) {
      return this.fragmentContextElement;
    }
    return this.open.current;
  }
```

- [ ] **Step 2: Give `resetInsertionMode` its fragment branches**

Three changes inside the existing loop, all from §13.2.6.2:

Replace the loop's first two lines:

```ts
    for (let i = this.open.items.length - 1; i >= 0; i--) {
      let node = this.open.items[i] as HtmlElement;
      const last = i === 0;
      // Fragment case: at the bottom of the stack the algorithm reasons about
      // the CONTEXT element, not the synthetic root.
      if (last && this.fragmentContextElement !== undefined) {
        node = this.fragmentContextElement;
      }
```

The `td`/`th` and `head` cases already read `if (!last)`, which is the
fragment-case guard the spec states, and need no change. The `html` case does:
with a fragment context the head element pointer is null, so it must not fall
into `BeforeHead` when the context says otherwise — leave it exactly as it is
and let the `last` fallthrough handle it, which is what the spec's final step
("If last is true, switch to in body") already does.

- [ ] **Step 3: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,634** — unchanged. `fragmentContextElement` is undefined
for every document parse, so both changes are unreachable. **If this is red,
one of them fires when it should not, and nothing later will make sense.**

- [ ] **Step 4: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmltree.ts
git commit -F - <<'MSG'
feat(zch2.1.3.3): the fragment-case branches of the two named seams

adjustedCurrentNode stops being an alias for the current node: it is the
fragment CONTEXT element when the stack of open elements holds exactly one.
zch2.1.3.1 named it correctly on purpose so this issue would not have to find
its call sites. The difference is the whole foreign-fragment group — with the
alias, <nobr>X in an "svg path" context is inserted by "in body" as an HTML
element instead of being parsed as foreign content.

resetInsertionMode reasons about the context element at the bottom of the
stack rather than the synthetic root. Its td/th and head cases already carried
the "and last is false" guard the spec states, so they needed no change.

Both are unreachable for a document parse, so the 1,634 green WPT cases
staying green is evidence neither fires when it should not.
MSG
```

---

## Task 3: The fragment parsing algorithm, and the corpus turned on

**Files:**
- Modify: `src/htmltree.ts`
- Modify: `test/helpers/wpt-tree.ts` (the bucket predicate)
- Test: `test/htmltree.test.ts`, `test/wpt-tree.test.ts`, `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  ```ts
  export function parseHtmlFragment(src: string, context: FragmentContext): HtmlFragment;
  ```
  Not re-exported from `src/index.ts`.

### What to implement

`TreeBuilder`'s constructor takes an optional context. When present, §13.4:

1. Create the context element (`createElement(context.name, undefined, context.ns ?? 'html')`)
   and store it as `fragmentContextElement`.
2. Create a synthetic `html` root, append it to the document, and push it as
   the ONLY element on the stack of open elements.
3. Prime the tokenizer from `context.name`:

   | Context | State |
   |---|---|
   | `title`, `textarea` | `RCDATA` |
   | `style`, `xmp`, `iframe`, `noembed`, `noframes` | `RAWTEXT` |
   | `script` | `ScriptData` |
   | `plaintext` | `PLAINTEXT` |
   | anything else | leave in `Data` |

   `noscript` is deliberately absent: it takes RAWTEXT only when scripting is
   enabled, and ours is off.
4. If `context.name` is `template` in the HTML namespace, push `Mode.InTemplate`
   onto `templateModes`.
5. `resetInsertionMode()`.
6. Set `formElement` to the nearest `form` at or above the context, walking
   `parent` pointers. **A `.dat` context is synthesized with no ancestors, so
   this always finds nothing** — implemented because the algorithm says so and
   recorded as uncovered.

`parseFragment()` runs the same loop as `parse()` and returns the root's
children as an `HtmlFragment`.

- [ ] **Step 1: Write the failing hand-built test**

Append to `test/htmltree.test.ts`. Every expectation is copied from the corpus
with its case id:

```ts
describe('fragment parsing', () => {
  const frag = (src: string, context: FragmentContext) =>
    serializeFragment(parseHtmlFragment(src, context));

  // tests_innerHTML_1.dat#0 — a <body> start tag inside a body context is
  // ignored, and the output has no document wrapper.
  it('parses into a body context', () => {
    expect(frag('<body><span>', { name: 'body' })).toBe('| <span>');
  });

  // tests_innerHTML_1.dat#2
  it('ignores a stray body tag in a div context', () => {
    expect(frag('<span><body>', { name: 'div' })).toBe('| <span>');
  });

  // foreign-fragment.dat#0 — THE case that proves adjustedCurrentNode. In an
  // SVG context the foreign rules run, so <nobr> breaks out and takes the X
  // with it; with the old alias it is an HTML element and the X lands beside.
  it('parses into an svg context as foreign content', () => {
    expect(frag('<nobr>X', { name: 'path', ns: 'svg' })).toBe('| <nobr>\n|   "X"');
  });

  // foreign-fragment.dat#4 — the context's own end tag closes nothing,
  // because the context element is not on the stack.
  it('ignores the context element’s own end tag', () => {
    expect(frag('</path>X', { name: 'path', ns: 'svg' })).toBe('| "X"');
  });

  // The tokenizer priming table: a title context is RCDATA, so a tag inside
  // it is text rather than markup.
  it('primes the tokenizer from the context name', () => {
    expect(frag('<p>', { name: 'title' })).toBe('| "<p>"');
  });

  it('never throws on any context', () => {
    // Typed explicitly: a bare array literal mixing entries with and without
    // `ns` widens it to `string`, which is not assignable to HtmlNamespace.
    const contexts: FragmentContext[] = [
      { name: 'td' }, { name: 'html' }, { name: 'template' },
      { name: 'select' }, { name: 'svg', ns: 'svg' }, { name: 'ms', ns: 'math' },
    ];
    for (const ctx of contexts) {
      expect(() => parseHtmlFragment('<div>x</div>', ctx)).not.toThrow();
    }
  });
});
```

Add to that file's imports:

```ts
import { parseHtml, parseHtmlFragment } from '../src/htmltree.js';
import type { FragmentContext } from '../src/htmltree.js';
import { serializeTree, serializeFragment } from './helpers/wpt-tree.js';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltree.test.ts`
Expected: FAIL — `parseHtmlFragment` is not exported.

- [ ] **Step 3: Implement the algorithm**

In `src/htmltree.ts`, change the constructor and add the two methods. Run
`npx vitest run test/htmltree.test.ts` as each piece lands.

```ts
  constructor(src: string, context?: FragmentContext) {
    this.tokenizer = new HtmlTokenizer(src, {
      adjustedCurrentNodeIsForeign: () => {
        const node = this.adjustedCurrentNode();
        return node !== undefined && node.ns !== 'html';
      },
    });
    if (context !== undefined) this.setUpFragment(context);
  }

  /** §13.4 steps 2 through 12. The context element is NEVER pushed onto the
   *  stack — the synthetic root is the whole stack — which is why the
   *  context's own end tag closes nothing. */
  private setUpFragment(context: FragmentContext): void {
    this.fragmentContextElement =
      createElement(context.name, undefined, context.ns ?? 'html');
    const root = createElement('html');
    appendChild(this.document, root);
    this.open.push(root);

    if (context.ns === undefined) {
      switch (context.name) {
        case 'title': case 'textarea':
          this.tokenizer.setState(TokenizerState.RCDATA); break;
        case 'style': case 'xmp': case 'iframe': case 'noembed': case 'noframes':
          this.tokenizer.setState(TokenizerState.RAWTEXT); break;
        case 'script':
          this.tokenizer.setState(TokenizerState.ScriptData); break;
        case 'plaintext':
          this.tokenizer.setState(TokenizerState.PLAINTEXT); break;
        // `noscript` is deliberately absent: it takes RAWTEXT only when
        // scripting is ENABLED, and ours is off.
        default: break;
      }
      if (context.name === 'template') this.templateModes.push(Mode.InTemplate);
    }

    this.resetInsertionMode();

    // Unreachable from the corpus: a .dat context element is synthesized with
    // no ancestors, so this always finds nothing. Implemented because §13.4
    // says so and a caller passing a real element would need it.
    for (let n: HtmlNode | null = this.fragmentContextElement; n !== null; n = n.parent) {
      if (n.kind === 'element' && n.ns === 'html' && n.name === 'form') {
        this.formElement = n;
        break;
      }
    }
  }

  parseFragment(): HtmlFragment {
    this.parse();
    const root = this.open.items[0] ?? this.document.children[0];
    const frag = createFragment();
    if (root !== undefined && (root.kind === 'element' || root.kind === 'document')) {
      for (const child of [...root.children]) {
        appendChild(frag, child as HtmlChild);
      }
    }
    return frag;
  }
```

`parse()` returns the document and is reused unchanged — `parseFragment`
ignores that return value and reads the root instead. Note `this.open.items[0]`
survives the parse: the html element is never popped.

Then the entry point, beside `parseHtml`:

```ts
/** §13.4. Implemented and fully tested but NOT re-exported from index.ts:
 *  nothing in this epic can call it, since zch2.5's entry points take a PDF
 *  target rather than an HTML element and so have no context to pass. */
export function parseHtmlFragment(src: string, context: FragmentContext): HtmlFragment {
  return new TreeBuilder(src, context).parseFragment();
}
```

Add `HtmlFragment` and `HtmlChild` to the type import from `./htmldom.js` if
not already there, and `createFragment` to the value import.

- [ ] **Step 4: Run the hand-built test to verify it passes**

Run: `npx vitest run test/htmltree.test.ts`
Expected: PASS.

- [ ] **Step 5: Retire the fragment bucket and drive fragment cases**

In `test/helpers/wpt-tree.ts`, DELETE the fragment line from `classify` — there
is no successor test — and drop `'fragment'` from the `Bucket` union:

```ts
export type Bucket =
  | 'inScope' | 'scripted' | 'processingInstruction' | 'selectedContent';
```

`classify` keeps its `s` parameter for the `script-on` test, so its signature
does not change.

In `test/wpt-tree.test.ts`, route a case by whether it has a context:

```ts
import { describe, it, expect } from 'vitest';
import { casesInBucket, serializeTree, serializeFragment } from './helpers/wpt-tree.js';
import { parseHtml, parseHtmlFragment } from '../src/htmltree.js';

describe('WPT tree construction', () => {
  // There is no allowlist: every in-scope case runs. The bucket counts are
  // asserted in test/wpt-tree-suite.test.ts, so a case cannot be reclassified
  // to dodge a failure. A case with a #document-fragment context is a FRAGMENT
  // parse and serializes with no document wrapper.
  for (const c of casesInBucket('inScope')) {
    it(`${c.file}#${c.index}: ${JSON.stringify(c.data).slice(0, 60)}`, () => {
      const got = c.fragmentContext === undefined
        ? serializeTree(parseHtml(c.data))
        : serializeFragment(parseHtmlFragment(c.data, c.fragmentContext));
      expect(got).toBe(c.document);
    });
  }
});
```

Update `test/wpt-tree-suite.test.ts`'s counts:

```ts
    expect(all.length).toBe(1936);
    expect(casesInBucket('scripted').length).toBe(14);
    expect(casesInBucket('selectedContent').length).toBe(4);
    expect(casesInBucket('processingInstruction').length).toBe(88);
    expect(casesInBucket('inScope').length).toBe(1830);
    const sum = (['scripted', 'selectedContent', 'processingInstruction', 'inScope'] as const)
      .reduce((n, b) => n + casesInBucket(b).length, 0);
    expect(sum).toBe(1936);
```

`casesInBucket('fragment')` is called in exactly TWO places in that file and
both must go, or the build fails on the narrowed `Bucket` union. The first is
the count assertion above. The second is "records a fragment context", which
becomes:

```ts
  it('records a fragment context', () => {
    const c = casesInBucket('inScope').find((x) => x.fragmentContext !== undefined);
    expect(c?.fragmentContext?.name).toBeTruthy();
  });
```

**Unlike the two preceding retirements, nothing is masked**: all 196 fragment
cases become in-scope, none falls through to another predicate. Measured.

- [ ] **Step 6: Turn on the corpus and drive it green**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: 1,830 cases collected. Fix `src/htmltree.ts` until all pass.

**Never edit a vendored expectation, and never move a case into another bucket
to make it green.** If the corpus contradicts this plan about the spec, the
corpus wins and the contradiction gets recorded — `zch2.1.2`'s `select`
finding, `zch2.1.3.1`'s `popUntilName` finding and `zch2.1.3.2`'s three
findings all arrived that way.

To read a real expectation rather than guess one, create this scratch file and
delete it in Step 7:

```ts
// test/_show.test.ts — SCRATCH, delete before committing.
import { it } from 'vitest';
import { parseHtml, parseHtmlFragment } from '../src/htmltree.js';
import { serializeTree, serializeFragment, loadWptCases } from './helpers/wpt-tree.js';

it('show', () => {
  for (const spec of (process.env.SHOW ?? '').split(',').filter((s) => s !== '')) {
    const [f, i] = spec.split('#');
    const c = loadWptCases([f as string])[Number(i)];
    if (c === undefined) { console.log(`${spec}: no such case`); continue; }
    const got = c.fragmentContext === undefined
      ? serializeTree(parseHtml(c.data))
      : serializeFragment(parseHtmlFragment(c.data, c.fragmentContext));
    console.log(`=== ${spec}  ctx=${JSON.stringify(c.fragmentContext)}`);
    console.log('IN  : ' + JSON.stringify(c.data));
    console.log('WANT:\n' + c.document);
    console.log('GOT :\n' + got);
  }
});
```

- [ ] **Step 7: Delete the scratch file and commit**

```bash
rm -f test/_show.test.ts
npm run typecheck
npm test
git add src/htmltree.ts test/helpers/wpt-tree.ts test/htmltree.test.ts test/wpt-tree.test.ts test/wpt-tree-suite.test.ts
git commit -F - <<'MSG'
feat(zch2.1.3.3): fragment parsing, and 1,830 WPT cases green

§13.4: a context element that is NEVER pushed onto the stack, a synthetic
html root that is the whole stack, tokenizer priming from the context's name,
the template-context push, and the form element pointer.

The context element not being on the stack is what makes its own end tag
close nothing, which foreign-fragment.dat#4 asserts directly.

The form-pointer walk is UNREACHABLE from this corpus: a .dat context element
is synthesized with no ancestors, so it always finds nothing. Implemented
because §13.4 says so; recorded as uncovered rather than left to look tested.

The fragment bucket is retired, the third and last exclusion this epic
removes. Unlike the foreign and template retirements nothing is masked — all
196 become in-scope. 1,634 -> 1,830, four buckets, all asserted.
MSG
```

---

## Task 4: The public export

Its own task because it is the one thing here a reviewer might want to reject
independently: it is the parser's first public commitment.

**Files:**
- Modify: `src/index.ts`
- Test: `test/html-public-api.test.ts`

**Interfaces:**
- Consumes: `parseHtml` (already exported from `src/htmltree.ts`).
- Produces: `parseHtml` and the node types, from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/html-public-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('the public HTML parser surface', () => {
  it('exports parseHtml', () => {
    expect(typeof api.parseHtml).toBe('function');
  });

  it('parses a document through the public entry', () => {
    const doc = api.parseHtml('<p>hi');
    expect(doc.kind).toBe('document');
    const html = doc.children[0];
    expect(html?.kind).toBe('element');
  });

  // The signature is the tree alone. Parse errors stay on the tokenizer:
  // every HTML string is a valid document by construction, so an error is
  // never actionable for a caller rendering a PDF, and the list a caller CAN
  // act on is zch2.7's. Widening later is additive; narrowing is not.
  it('returns the document itself rather than a result object', () => {
    const doc = api.parseHtml('');
    expect(doc.kind).toBe('document');
    expect((doc as unknown as { errors?: unknown }).errors).toBeUndefined();
  });

  // Deliberately absent, each for its own reason recorded in CLAUDE.md.
  it('does not export the fragment entry or the mutation helpers', () => {
    for (const name of ['parseHtmlFragment', 'appendChild', 'insertBefore',
      'removeChild', 'createElement', 'createFragment', 'createDocument',
      'createText', 'createComment', 'createDoctype', 'HtmlTokenizer']) {
      expect(api).not.toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/html-public-api.test.ts`
Expected: FAIL — `api.parseHtml` is undefined.

- [ ] **Step 3: Add the exports**

Append to `src/index.ts`:

```ts
// ---- HTML parsing (zch2.1) ------------------------------------------------
//
// parseHtml alone. parseHtmlFragment is implemented and fully tested but not
// exported: nothing in this epic can call it, since zch2.5's entry points take
// a PDF target rather than an HTML element and so have no context to pass.
// The mutation helpers stay internal too — a caller reading a parse result
// does not need them, and exporting them would commit this library to a
// DOM-editing API before anyone has asked for one.
export { parseHtml } from './htmltree.js';
export type {
  HtmlNode, HtmlDocument, HtmlElement, HtmlFragment,
  HtmlText, HtmlComment, HtmlDoctype, HtmlNamespace,
} from './htmldom.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/html-public-api.test.ts`
Expected: PASS, all 4 assertions.

- [ ] **Step 5: Confirm the build resolves the new export**

Run: `npm run build`
Expected: clean. Then confirm the emitted entry names it:

```bash
grep -c "parseHtml" dist/index.js dist/index.d.ts
```
Expected: at least 1 in each. The build is `src`-only through
`tsconfig.build.json`; if it emits `dist/src/index.js` instead, the wrong
tsconfig was used — see CLAUDE.md's "Two tsconfigs" note.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/index.ts test/html-public-api.test.ts
git commit -F - <<'MSG'
feat(zch2.1.3.3): export parseHtml

The parser's first public commitment, withheld by zch2.1.2, zch2.1.3.1 and
zch2.1.3.2 in turn until the tree was right.

parseHtml(src): HtmlDocument and the node types, and nothing else. No options
bag, no error list, no second entry: parse errors stay on the tokenizer,
because every HTML string is a valid document by construction and the list a
caller can act on is zch2.7's. Widening a return type later is additive;
narrowing is not.

parseHtmlFragment and the mutation helpers stay internal, asserted by name so
the absence is a decision the suite enforces rather than an oversight.
MSG
```

---

## Task 5: Mutations, docs, and close

**Files:**
- Modify: `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Run the mutations and record what actually reddens**

Run each against
`npx vitest run test/wpt-tree.test.ts test/htmltree.test.ts test/wpt-tree-suite.test.ts test/html-public-api.test.ts`,
note the count and the files, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | `adjustedCurrentNode` reverted to `return this.open.current` | the 67 foreign-context cases |
| 2 | The tokenizer priming switch emptied | the 6 primed contexts |
| 3 | The template-context push dropped | the 1 `template` context case |
| 4 | `resetInsertionMode`'s context substitution dropped | the 91 table-ish contexts |
| 5 | The synthetic root created with `context.name` instead of `html` | broad |
| 6 | The form-pointer walk deleted | expected: **NOTHING** — record it |

- [ ] **Step 2: Write the results into PROVENANCE.md**

Append a `### zch2.1.3.3` subsection under `## Mutation results` with the
observed file names and counts, **not the predictions**. Update the `## Buckets`
table to the four new counts. A mutation that reddens nothing is the important
result — `zch2.1.2` recorded one, `zch2.1.3.1` one that reddened a single case,
`zch2.1.3.2` another that reddened nothing.

- [ ] **Step 3: Update CLAUDE.md**

The `htmldom.ts`/`htmlstack.ts`/`htmlforeign.ts`/`htmltree.ts` entry gains
these, and its case counts go from 1,634 to 1,830:

```markdown
  **Invariant:** `adjustedCurrentNode` is the fragment CONTEXT element when the
  stack of open elements holds exactly one, and the current node otherwise. It
  returned the current node from `zch2.1.3.1` until `zch2.1.3.3`, named
  correctly on purpose so fragments would not have to find its call sites —
  and the difference is the whole 67-case foreign-fragment group: with the
  alias, `<nobr>X` in an `svg path` context is inserted by "in body" as an
  HTML element instead of being parsed as foreign content.
  **Invariant:** the fragment context element is NEVER pushed onto the stack of
  open elements — the synthetic `html` root is the whole stack. That is what
  makes the context's own end tag close nothing, which
  `foreign-fragment.dat#4` asserts directly.
  **Invariant:** `parseHtml(src): HtmlDocument` is the whole public surface,
  and `parseHtmlFragment` is implemented, fully tested and NOT exported —
  nothing in this epic can call it, since `zch2.5`'s entry points take a PDF
  target rather than an HTML element and so have no context to pass. The
  mutation helpers stay internal for the same class of reason: exporting them
  would commit this library to a DOM-editing API before anyone has asked for
  one. `test/html-public-api.test.ts` asserts the absences BY NAME, so they are
  a decision the suite enforces rather than an oversight.
  **Invariant:** `parseHtml` returns the tree alone, never a result object with
  an error list. Every HTML string is a valid document by construction, so a
  parse error is never actionable for a caller rendering a PDF; the list a
  caller CAN act on is `zch2.7`'s "what could not be rendered". Widening a
  return type later is additive, narrowing is not.
  **Note:** §13.4's form-element-pointer walk is implemented and UNREACHABLE
  from the corpus — a `.dat` context element is synthesized with no ancestors,
  so it always finds nothing. Recorded as uncovered rather than left to look
  tested.
```

Then run the repo's own sweep and confirm it names no new gap:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Also update the fixture-table row's "1,634 run here" to "1,830 run here" and
its bucket count from five to four.

- [ ] **Step 4: Add the README entry**

`README.md` is user-facing and `parseHtml` is now public API, so it earns a
line. Add to the Features list and, under the API overview, a short block:

```markdown
### HTML

`parseHtml(src)` parses a string as a full HTML document and returns the node
tree, following the WHATWG HTML Standard's tokenizer and tree-construction
stages. It never throws: every string is a valid HTML document, and the spec
defines a recovery for every parse error.

```ts
import { parseHtml } from '@asposefoss/pdf';

const doc = parseHtml('<p>Hello<p>World');
```

Anchored by 1,830 of web-platform-tests' 1,936 tree-construction cases. Not
yet connected to PDF output — rendering HTML into a page is in progress.
```

- [ ] **Step 5: Add the CHANGELOG entry**

Under `## [Unreleased]`, in **Added**, above the `<template>` entry:

```markdown
- **HTML5 fragment parsing, and `parseHtml` is now public API** — the first
  reachable piece of the HTML parser. `parseHtml(src)` takes a string and
  returns the node tree, following the WHATWG tokenizer and tree-construction
  stages; it never throws, because every string is a valid HTML document and
  the spec defines a recovery for every parse error. **1,830 of the 1,936
  vendored web-platform-tests cases now run, all green**, up from 1,634 — the
  remainder are the scripting flag, processing instructions and
  `<selectedcontent>`, each excluded by a computed predicate and recorded with
  its reason. The fragment algorithm itself (§13.4) is implemented and fully
  tested but deliberately not exported: nothing can call it yet, because the
  entry points that will render HTML take a PDF target rather than an HTML
  element and so have no context element to pass. The return type is the tree
  alone rather than a result object carrying parse errors — those are never
  actionable for a caller rendering a PDF, and widening a return type later is
  additive where narrowing is not. (`zch2.1.3.3`)
```

- [ ] **Step 6: Run the gates, commit, close, push**

```bash
npm run typecheck
npm test
npm run build
git add -A src test docs CLAUDE.md CHANGELOG.md README.md
git commit -F - <<'MSG'
feat(zch2.1.3.3): mutations recorded, docs, close

Six mutations run and recorded in PROVENANCE.md with observed counts rather
than predictions; any that reddened nothing are written down as uncovered.

README gains an HTML section: parseHtml is public API now, so it is
user-facing and CLAUDE.md's docs rule applies.
MSG
bd close aspose-pdf-foss-for-ts-zch2.1.3.3
bd close aspose-pdf-foss-for-ts-zch2.1.3
bd close aspose-pdf-foss-for-ts-zch2.1
bd export -o .beads/issues.jsonl
git add .beads && git commit -F - <<'MSG'
chore(beads): close zch2.1.3.3, zch2.1.3 and zch2.1
MSG
git pull --rebase && git push && git status -sb
```

`git status` must show the branch up to date with origin.

**Closing the two parents is deliberate**: `zch2.1.3` has no work of its own
beyond its three children, and `zch2.1` none beyond its three. Check each with
`bd show` before closing — if either has acquired an open child, close only
what is actually done and say so.

---

## Self-review

**Spec coverage.** The public surface and its three "not exported" rules →
Task 4; the fragment algorithm's steps 1–7 → Task 3; `adjustedCurrentNode`'s
real definition and `resetInsertionMode`'s fragment branches → Task 2; the
context parse and `serializeFragment` → Task 1; the bucket retirement and its
"nothing is masked" measurement → Task 3 Step 5; the form pointer's
unreachability → Task 3 Step 3 and Task 5 Step 3; the six named mutations →
Task 5 Step 1.

**Three things the plan settles that the spec did not:**

1. **`serializeFragment` wraps the children in a throwaway document** rather
   than duplicating the walk, and pushes them **directly** rather than through
   `appendChild` — which would reparent them and destroy the tree being
   serialized. That is a trap the spec's one-line description hides.
2. **The export gets its own task.** It is the parser's first public
   commitment and the one change here a reviewer might reject independently of
   the parsing work.
3. **The absences are asserted by name** in `test/html-public-api.test.ts`, so
   "we deliberately did not export `parseHtmlFragment`" is enforced by the
   suite rather than only written down.

**Known soft spot, flagged rather than hidden:** mutation 6 is expected to
redden nothing, and unlike the previous issues' empty mutations this one is
*known* to be uncoverable in advance — a `.dat` context element has no
ancestors, so no vendored case can reach the walk. It is still run and
recorded, but the result carries no information about the implementation. If a
future caller passes a real element, that code path has never been executed.
