# Reporting unrenderable constructs — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the rule `svgdraw.ts` sets true for HTML rendering — an element
we cannot render fully names itself in a structured report and still
contributes what it has. Eight constructs are silent today and one loses text
outright.

**Architecture:** a new pure leaf `src/htmlreport.ts` owns the `NotRendered`
record, the construct vocabulary and the per-element content policy. Four
modules consume it — `cssbox.ts`, `cssinline.ts`, `csstable.ts`, `cssflow.ts`
— and it consumes none of them. `skipped` changes from `string[]` to
`NotRendered[]` on the HTML path only; Markdown keeps its strings.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, no runtime
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-unrenderable-construct-reporting-design.md`
— read it first. Its "Why this is not a small addition" table is the measured
starting state and its "inventory" table is the deliverable.

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every import specifier carries a `.js` extension.
- **`src/htmlreport.ts` is a PURE LEAF.** It imports `htmldom.js` for types
  and NOTHING else — no `Document`, no PDF object module, no `node:` import,
  and none of its four consumers. It never throws.
- **Markdown is not touched.** `mdflow.ts`, `mdruns.ts` and
  `MarkdownResult.skipped` keep `string[]`. This asymmetry is a recorded
  decision, not an oversight — see the spec's decision 4.
- **Only two rows change what the PDF contains:** `<input value>` starts
  drawing, `<iframe>`/`<svg>`/`<math>` stop. Everything else is report-only.
- **`test/html-identity.test.ts`, `test/rich-runs-identity.test.ts` and
  `test/docx-flow-identity.test.ts` are FENCES, not goldens.** If one goes
  red, STOP and investigate. Measured: no existing test renders an
  `<iframe>`, an inline `<svg>` or a form control through `AddHtml`.
- **Run `npm run typecheck` and `npm test` before the final commit.**
- **Mutation-check every rule** (Task 10). A mutation that reddens nothing is
  recorded in `CLAUDE.md` as uncovered, not quietly kept.

## File structure

| File | Responsibility |
|---|---|
| `src/htmlreport.ts` *(new)* | The record, the kinds, the construct vocabulary, `describe`, `elementPolicy`, `selectedOptionText`. Pure leaf. |
| `src/cssbox.ts` | Applies the policy to a BLOCK-level replaced element; reports `inline-block`; threads `report` out of `buildBoxes`. |
| `src/cssinline.ts` | Applies the policy to an INLINE one (the common case); `<input>`/`<select>` text; `vertical-align`; inline padding; the fragment `href` moves here off `unsupported`. |
| `src/csstable.ts` | Flattens a nested table instead of losing it; the cell-blocks record. |
| `src/cssflow.ts` | Its three string pushes become records; `CssFlowResult.skipped` retypes. |
| `src/htmlflow.ts`, `src/flow.ts`, `src/page.ts`, `src/document.ts`, `src/index.ts` | The public surface retypes and re-exports. |

**Why a leaf rather than a section of `cssprop.ts`:** two consumers need the
policy and neither may import the other. `cssbox.ts` must not descend into a
block-level `<iframe>`, and `cssinline.ts` has its own separate `visit` walk
that must not descend into an inline one. That is the forcing argument behind
`colornames.ts`, `preformat.ts` and `bordersides.ts`.

**One refinement of the spec's sketch, made deliberately.** The spec sketched
`contentPolicy(el): 'render' | 'suppress' | undefined`. This plan uses
`elementPolicy(el): ElementPolicy | undefined`, returning content disposition,
kind and construct together. A single call must answer both "do I descend?"
and "how is this reported?", and two lookups is two chances for the answers to
disagree about one element.

---

### Task 1: `htmlreport.ts` — the leaf

**Files:**
- Create: `src/htmlreport.ts`
- Test: `test/htmlreport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Construct =
    | 'iframe' | 'svg' | 'math'
    | 'object' | 'video' | 'audio' | 'canvas'
    | 'input' | 'select' | 'textarea' | 'button'
    | 'inline-block' | 'vertical-align' | 'inline-box'
    | 'float' | 'image' | 'table' | 'table-cell-blocks' | 'link';
  export const CONSTRUCTS: readonly Construct[];
  export interface NotRendered {
    el: HtmlElement | null;
    kind: 'dropped' | 'degraded';
    construct: Construct;
    detail?: string;
  }
  export interface ElementPolicy {
    content: 'render' | 'suppress';
    kind: 'dropped' | 'degraded';
    construct: Construct;
  }
  export function describe(r: NotRendered): string;
  export function elementPolicy(el: HtmlElement): ElementPolicy | undefined;
  export function selectedOptionText(el: HtmlElement): string | undefined;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/htmlreport.test.ts`:

```ts
import { describe as suite, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import {
  CONSTRUCTS, HTML_POLICY_SIZE, describe, elementPolicy, selectedOptionText,
} from '../src/htmlreport.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** The first element named `name` anywhere in a parsed source. */
function el(src: string, name: string): HtmlElement {
  const seek = (ns: HtmlNode[]): HtmlElement | undefined => {
    for (const n of ns) {
      if (n.kind !== 'element') continue;
      if (n.name === name) return n;
      const hit = seek(n.children);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const hit = seek(parseHtml(`<!doctype html>${src}`).children);
  if (hit === undefined) throw new Error(`no <${name}>`);
  return hit;
}

suite('the construct vocabulary', () => {
  it('has exactly 19 entries', () => {
    // Asserted by SIZE so a half-filled table is a red build rather than a
    // silently unreported element — htmlforeign.ts's pattern with its five
    // asserted table sizes.
    expect(CONSTRUCTS.length).toBe(19);
  });

  it('has no duplicates', () => {
    expect(new Set(CONSTRUCTS).size).toBe(CONSTRUCTS.length);
  });

  it('has exactly 7 entries in the element policy table', () => {
    // The SECOND size assertion, and the more important of the two: a
    // half-transcribed policy table is an element that silently renders as
    // though HTML said nothing about it.
    expect(HTML_POLICY_SIZE).toBe(7);
    for (const name of ['iframe', 'object', 'video', 'audio', 'canvas',
      'textarea', 'button']) {
      expect(elementPolicy(el(`<${name}></${name}>`, name)), name).toBeDefined();
    }
  });
});

suite('describe', () => {
  it('is the construct alone when there is no detail', () => {
    expect(describe({ el: null, kind: 'dropped', construct: 'iframe' }))
      .toBe('iframe');
  });

  it('joins the detail with a colon, the old string form', () => {
    // The pre-zch2.7 strings were 'image:pic.png' and 'float:left'; a caller
    // that only logs keeps getting exactly those.
    expect(describe({
      el: null, kind: 'dropped', construct: 'image', detail: 'pic.png',
    })).toBe('image:pic.png');
    expect(describe({
      el: null, kind: 'degraded', construct: 'float', detail: 'left',
    })).toBe('float:left');
  });
});

suite('elementPolicy', () => {
  it('suppresses an iframe, which HTML says is ignored', () => {
    expect(elementPolicy(el('<iframe>fb</iframe>', 'iframe')))
      .toEqual({ content: 'suppress', kind: 'dropped', construct: 'iframe' });
  });

  it('suppresses inline svg and math by NAMESPACE, not by tag name', () => {
    // <svg> puts its whole subtree in the svg namespace, so keying on the
    // namespace catches a subtree whose root was spelled some other way and
    // cannot be fooled by an HTML element that happens to be called `svg`.
    expect(elementPolicy(el('<svg><circle/></svg>', 'svg'))?.content)
      .toBe('suppress');
    expect(elementPolicy(el('<math><mi>x</mi></math>', 'math'))?.content)
      .toBe('suppress');
  });

  it('KEEPS the children of object, video, audio and canvas', () => {
    // These children ARE fallback content a browser renders when the thing
    // cannot load. Suppressing them would blank a page whose content sits in
    // <object> fallback.
    for (const name of ['object', 'video', 'audio', 'canvas']) {
      const p = elementPolicy(el(`<${name}>fb</${name}>`, name));
      expect(p?.content, name).toBe('render');
      expect(p?.kind, name).toBe('degraded');
    }
  });

  it('keeps a textarea and a button, whose text is what a browser draws', () => {
    expect(elementPolicy(el('<textarea>t</textarea>', 'textarea'))?.content)
      .toBe('render');
    expect(elementPolicy(el('<button>Go</button>', 'button'))?.content)
      .toBe('render');
  });

  it('names NO policy for input or select, which cssinline.ts owns', () => {
    // Their text is SELECTED rather than kept or suppressed, so a policy
    // entry would be a second statement about them that could drift.
    expect(elementPolicy(el('<input>', 'input'))).toBeUndefined();
    expect(elementPolicy(el('<select><option>a</select>', 'select')))
      .toBeUndefined();
  });

  it('names no policy for an ordinary or unknown element', () => {
    // An element the table does not name keeps its children and earns no
    // record — what a browser does, so correct rather than a gap.
    expect(elementPolicy(el('<p>x</p>', 'p'))).toBeUndefined();
    expect(elementPolicy(el('<my-widget>x</my-widget>', 'my-widget')))
      .toBeUndefined();
  });

  it('does not mistake an SVG-namespaced <a> for an HTML one', () => {
    // Namespace-keyed, so it must not fire on the HTML elements that share a
    // name with an SVG one.
    expect(elementPolicy(el('<a href=x>t</a>', 'a'))).toBeUndefined();
  });
});

suite('selectedOptionText', () => {
  it('takes the option carrying `selected`', () => {
    expect(selectedOptionText(el(
      '<select><option>a<option selected>b<option>c</select>', 'select')))
      .toBe('b');
  });

  it('falls back to the FIRST option when none is selected', () => {
    // What a browser shows in a closed control.
    expect(selectedOptionText(el(
      '<select><option>a<option>b</select>', 'select'))).toBe('a');
  });

  it('finds an option nested in an optgroup', () => {
    expect(selectedOptionText(el(
      '<select><optgroup><option>a<option selected>b</optgroup></select>',
      'select'))).toBe('b');
  });

  it('is undefined for a select with no options', () => {
    expect(selectedOptionText(el('<select></select>', 'select')))
      .toBeUndefined();
  });

  it('trims and collapses the option text', () => {
    expect(selectedOptionText(el(
      '<select><option>\n  a  b \n</select>', 'select'))).toBe('a b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlreport.test.ts`
Expected: FAIL — `Failed to load url ../src/htmlreport.js`.

- [ ] **Step 3: Create the module**

Create `src/htmlreport.ts`:

```ts
/** What an HTML document asked for that we could not fully draw.
 *
 *  Invariant: a PURE LEAF over htmldom.js. It imports nothing else — no
 *  Document, no PDF object module, no `node:` import, and none of its four
 *  consumers (cssbox.ts, cssinline.ts, csstable.ts, cssflow.ts). It never
 *  throws. That is what lets every rule here be tested from a parsed string
 *  with no PDF built at all.
 *
 *  Invariant: it is `html*` rather than `css*` despite the CSS stack being
 *  its only consumer. It is keyed on HTML element names and encodes HTML's
 *  own content models, and it sits beside htmllang.ts — the existing
 *  precedent for an HTML fact as a pure leaf. Naming it cssreport.ts would
 *  say the policy is a CSS one and send the next reader to the cascade.
 *
 *  Invariant: a module of its own rather than a section of cssprop.ts,
 *  because TWO consumers need the policy and neither may import the other.
 *  cssbox.ts must not descend into a block-level <iframe>; cssinline.ts has
 *  its own separate `visit` walk and must not descend into an inline one.
 *  The forcing argument behind colornames.ts, preformat.ts and
 *  bordersides.ts.
 *
 *  Invariant: TWO kinds, not three. A `leaked` kind was considered and
 *  dropped: once the per-element policy is in place nothing leaks knowingly,
 *  so no site could produce one, and a kind nobody emits is a case every
 *  consumer switches on for nothing. */

import type { HtmlElement, HtmlNode } from './htmldom.js';

/** Every construct this stack can report. A closed vocabulary rather than a
 *  free string, so a typo is a compile error and the set can be asserted by
 *  SIZE — a half-filled table is then a red build rather than a silently
 *  unreported element. */
export type Construct =
  // Replaced elements and foreign content.
  | 'iframe' | 'svg' | 'math'
  | 'object' | 'video' | 'audio' | 'canvas'
  // Form controls.
  | 'input' | 'select' | 'textarea' | 'button'
  // Properties computed and not read.
  | 'inline-block' | 'vertical-align' | 'inline-box'
  // Layout constructs.
  | 'float' | 'image' | 'table' | 'table-cell-blocks' | 'link';

export const CONSTRUCTS: readonly Construct[] = [
  'iframe', 'svg', 'math',
  'object', 'video', 'audio', 'canvas',
  'input', 'select', 'textarea', 'button',
  'inline-block', 'vertical-align', 'inline-box',
  'float', 'image', 'table', 'table-cell-blocks', 'link',
];

/** One thing a document asked for that did not render as specified.
 *
 *  `dropped` means nothing was drawn for it; `degraded` means something was,
 *  but not what the source said. A caller can act on the difference — a
 *  dropped construct may need the source changing, a degraded one may not. */
export interface NotRendered {
  /** null for a construct belonging to no element — an anonymous box. */
  el: HtmlElement | null;
  kind: 'dropped' | 'degraded';
  construct: Construct;
  /** The src, the property name, the declined value. */
  detail?: string;
}

/** What happens to an element's children, and how the element is reported. */
export interface ElementPolicy {
  /** Do this element's children reach the flow? */
  content: 'render' | 'suppress';
  kind: 'dropped' | 'degraded';
  construct: Construct;
}

/** The string form a caller that only logs wants — and exactly the strings
 *  `skipped` carried before zch2.7 made it structured. */
export function describe(r: NotRendered): string {
  return r.detail === undefined ? r.construct : `${r.construct}:${r.detail}`;
}

/** Elements whose children HTML itself treats specially. Keyed by tag name,
 *  HTML namespace only — the two foreign namespaces are answered separately,
 *  below, because a whole SUBTREE is foreign rather than one element.
 *
 *  Note what is NOT here: `input` and `select`, whose text is SELECTED rather
 *  than kept or suppressed, so cssinline.ts owns them outright. An entry for
 *  them would be a second statement about one element that could drift from
 *  the first. */
const HTML_POLICY: Readonly<Record<string, ElementPolicy>> = {
  // "Content that is ignored by conforming user agents" — HTML's own words.
  // Emitting it is a divergence from every browser, not a mercy.
  iframe: { content: 'suppress', kind: 'dropped', construct: 'iframe' },
  // Fallback content a browser DOES render when the thing cannot load.
  // Suppressing it would blank a page whose content sits in <object>.
  object: { content: 'render', kind: 'degraded', construct: 'object' },
  video: { content: 'render', kind: 'degraded', construct: 'video' },
  audio: { content: 'render', kind: 'degraded', construct: 'audio' },
  canvas: { content: 'render', kind: 'degraded', construct: 'canvas' },
  // A textarea's text and a button's caption ARE what a browser draws.
  textarea: { content: 'render', kind: 'degraded', construct: 'textarea' },
  button: { content: 'render', kind: 'degraded', construct: 'button' },
};

/** Asserted so a half-transcribed table is a red build. */
export const HTML_POLICY_SIZE = 7;

/** How an element's content is treated, or undefined for one the table does
 *  not name — whose caller default is `render` with no record. An unknown or
 *  custom element keeps its children and earns nothing, which is what a
 *  browser does. */
export function elementPolicy(el: HtmlElement): ElementPolicy | undefined {
  // By NAMESPACE, because a whole subtree is foreign rather than one element,
  // and because keying on the tag name would fire on an HTML element that
  // merely shares a name with an SVG one.
  if (el.ns === 'svg') return { content: 'suppress', kind: 'dropped', construct: 'svg' };
  if (el.ns === 'math') return { content: 'suppress', kind: 'dropped', construct: 'math' };
  return Object.prototype.hasOwnProperty.call(HTML_POLICY, el.name)
    ? HTML_POLICY[el.name] : undefined;
}

/** The text of the `<option>` a closed `<select>` would show: the one
 *  carrying `selected`, else the first. Undefined when it has none.
 *
 *  Only ONE option, and that is the whole point: emitting every option turns
 *  a three-choice dropdown into three lines of body text — a document that
 *  looks plausible and says something the source does not. */
export function selectedOptionText(el: HtmlElement): string | undefined {
  const options: HtmlElement[] = [];
  const walk = (ns: HtmlNode[]): void => {
    for (const n of ns) {
      if (n.kind !== 'element') continue;
      if (n.ns === 'html' && n.name === 'option') options.push(n);
      else walk(n.children);       // an <optgroup>, or anything else wrapping
    }
  };
  walk(el.children);
  const chosen = options.find((o) => o.attrs.has('selected')) ?? options[0];
  if (chosen === undefined) return undefined;
  let text = '';
  const gather = (ns: HtmlNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'text') text += n.data;
      else if (n.kind === 'element') gather(n.children);
    }
  };
  gather(chosen.children);
  return text.replace(/\s+/g, ' ').trim();
}
```

`Object.prototype.hasOwnProperty.call` rather than `in`, the rule
`predefcmap.ts` records: the name comes from a document, so
`<constructor>` would otherwise find `Object.prototype.constructor` and be
treated as a policy that exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlreport.test.ts`
Expected: typecheck clean; PASS, 17 tests (2 + 1 vocabulary, 2 describe, 7 elementPolicy, 5 selectedOptionText).

- [ ] **Step 5: Commit**

```bash
git add src/htmlreport.ts test/htmlreport.test.ts
git commit -m "feat(zch2.7): the unrenderable-construct report vocabulary"
```

---

### Task 2: retype `skipped` end to end, changing no behaviour

This is the type migration and nothing else: every EXISTING report site emits
a record instead of a string, and the public surface follows. No new construct
is reported. The suite must be green at the end of this task.

**Files:**
- Modify: `src/cssflow.ts` (`Ctx`, `CssFlowResult`, three push sites)
- Modify: `src/csstable.ts` (`TableMapCtx`, one push site)
- Modify: `src/htmlflow.ts` (`HtmlFlowResult.skipped`)
- Modify: `src/document.ts` (`AddHtml`'s inline return type)
- Modify: `src/index.ts` (export the new types)
- Modify: `test/cssflow-report.test.ts`, `test/cssflow.test.ts`,
  `test/htmlflow.test.ts`, `test/html-render.test.ts`

**Interfaces:**
- Consumes: `NotRendered`, `describe` from `./htmlreport.js`.
- Produces: `CssFlowResult.skipped: NotRendered[]`,
  `HtmlFlowResult.skipped: NotRendered[]`.

- [ ] **Step 1: Retype the two Ctx objects and the four push sites**

In `src/cssflow.ts`, add the import and retype:

```ts
import type { NotRendered } from './htmlreport.js';
```

`CssFlowResult.skipped` becomes `NotRendered[]`, with the doc comment:

```ts
  /** Every construct that did not render as the source specified, in report
   *  order. `kind` separates `dropped` (nothing drawn) from `degraded`
   *  (drawn, but not as specified); `htmlreport.describe` gives the flat
   *  string form for a caller that only logs.
   *
   *  ORDER is by PHASE, then document order within a phase: everything found
   *  while BUILDING boxes precedes everything found while LOWERING them,
   *  because each walks the whole tree. A single global document order would
   *  need a preorder index on every element carried on every record, for a
   *  guarantee no caller has asked for. */
  skipped: NotRendered[];
```

`Ctx.skipped` becomes `NotRendered[]`. The three push sites become:

```ts
  // float, in mapBox
  if (box.float !== 'none')
    c.skipped.push({ el: box.el, kind: 'degraded', construct: 'float', detail: box.float });
```

```ts
  // atomics, in mapBox's inline branch AND in mapList — both sites identically
    for (const a of box.content.atomics)
      c.skipped.push({
        el: a.el, kind: 'dropped', construct: 'image',
        detail: a.el.attrs.get('src') ?? '',
      });
```

In `src/csstable.ts`, `TableMapCtx.skipped` becomes `NotRendered[]` (import
the type from `./htmlreport.js`) and its push becomes:

```ts
        c.skipped.push({
          el: cell.el, kind: 'degraded', construct: 'table-cell-blocks',
        });
```

- [ ] **Step 2: Retype the public surface**

`src/htmlflow.ts` — import `NotRendered` and retype `HtmlFlowResult.skipped`
with the same doc comment as `CssFlowResult.skipped` above.

`src/document.ts` — `AddHtml`'s inline return type becomes:

```ts
  ): { pages: Page[]; skipped: NotRendered[]; unsupported: UnsupportedDeclaration[] } {
```

with `import type { NotRendered } from './htmlreport.js';` added. `flow.ts`
and `page.ts` need no signature change — they return `HtmlFlowResult` and
`AddHtmlResult`, which pick the field up — but check their doc comments for
the phrase "a table" and correct it, since a table renders now.

`src/index.ts` — beside the existing `htmlflow.js` exports:

```ts
export { describe as describeNotRendered, CONSTRUCTS } from './htmlreport.js';
export type { NotRendered, Construct, ElementPolicy } from './htmlreport.js';
```

`describe` is renamed on export because the bare name collides with vitest's
and with any caller's own; `describeNotRendered` says what it describes.

- [ ] **Step 3: Add a test helper and update the four test files**

The assertions read best against the flat strings, so add this helper at the
top of `test/cssflow-report.test.ts`, `test/cssflow.test.ts`,
`test/htmlflow.test.ts` and `test/html-render.test.ts` (each file gets its own
copy — they share no helper module today):

```ts
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';

/** The report as the flat strings, which is what most assertions want. */
const names = (skipped: NotRendered[]): string[] => skipped.map(describeReport);
```

Then mechanically:

- `expect(skipped).toContain('float:left')` → `expect(names(skipped)).toContain('float:left')`
- `expect(skipped).toEqual([])` → `expect(names(skipped)).toEqual([])`
- `expect(skipped).toEqual(['image:a.png', 'float:left', 'image:b.png'])` → wrap in `names(...)`
- `skipped.some((s) => s.startsWith('image:'))` → `names(skipped).some(...)`
- `expect(skipped).toContain('table-cell-blocks')` → wrap in `names(...)`
- `expect(skipped).not.toContain('table')` → `expect(names(skipped)).not.toContain('table')`

Add ONE new case to `test/cssflow-report.test.ts` proving the structure is
real rather than a string in a wrapper:

```ts
  it('carries the ELEMENT and the kind, not just a name', () => {
    // The whole reason skipped is structured: a caller can reach the source
    // element and can tell a dropped construct from a degraded one.
    const { skipped } = map('<div style="float:left">s</div>');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].construct).toBe('float');
    expect(skipped[0].kind).toBe('degraded');
    expect(skipped[0].detail).toBe('left');
    expect(skipped[0].el?.name).toBe('div');
  });
```

- [ ] **Step 4: Run the suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all 540 files green. Nothing about rendering
changed in this task, so a red identity fence means the retype leaked into
behaviour — STOP and investigate.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "refactor(zch2.7): skipped becomes a structured report"
```

---

### Task 3: thread `report` into the box phase

Plumbing only — the list reaches `cssbox.ts` and `cssinline.ts` and nothing
pushes to it yet. Green at the end.

**Files:**
- Modify: `src/cssbox.ts` (`buildBoxes` return, `contentOf`, `anonCell`)
- Modify: `src/cssinline.ts` (`inlineContentOf` signature)
- Modify: `src/cssflow.ts` (`lowerHtml` wiring)

**Interfaces:**
- Produces:
  ```ts
  export function buildBoxes(
    root: HtmlDocument, resolveFamily: FamilyResolver,
  ): { boxes: BoxNode[]; unsupported: UnsupportedDeclaration[]; report: NotRendered[] };

  export function inlineContentOf(
    nodes: HtmlNode[],
    parentStyle: ComputedStyle,
    styles: Map<HtmlElement, ComputedStyle>,
    resolveFamily: FamilyResolver,
    unsupported: UnsupportedDeclaration[],
    report: NotRendered[],
  ): InlineContent;
  ```

- [ ] **Step 1: Widen `inlineContentOf`**

In `src/cssinline.ts`, add `report: NotRendered[]` as the SIXTH parameter,
with `import type { NotRendered } from './htmlreport.js';`. Nothing pushes to
it yet.

Positional rather than an options bag, because `unsupported` is already
positional there and mixing the two styles in one signature is worse than
either.

- [ ] **Step 2: Thread it through `cssbox.ts`**

In `src/cssbox.ts`, `buildBoxes` creates the array and returns it:

```ts
  const { styles, unsupported } = computeStyles(root);
  const report: NotRendered[] = [];
```

and its three `inlineContentOf` call sites — the one in `contentOf`'s inline
branch, the one in `contentOf`'s `flush`, and the one in `anonCell` — each
gain `report` as the sixth argument. The return becomes
`{ boxes, unsupported, report }`.

- [ ] **Step 3: Wire it in `cssflow.ts`**

```ts
  const { boxes, unsupported, report } = buildBoxes(root, options.resolveFamily);
  const c: Ctx = { skipped: report, unsupported, resolveImage: options.resolveImage };
```

The SAME array, so the flow phase appends to what the box phase produced.
`lowerHtml` returns `skipped: c.skipped`, which is that array.

- [ ] **Step 4: Check for other callers**

Run: `grep -rn "inlineContentOf" src test`
Every call site must pass six arguments. If a test calls it directly, update
it; if none does, say so in the commit message.

- [ ] **Step 5: Run the suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all green. Pure plumbing.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "refactor(zch2.7): thread the report list into the box phase"
```

---

### Task 4: the suppression policy

**Files:**
- Modify: `src/cssinline.ts` (`visit`)
- Modify: `src/cssbox.ts` (`boxFor`)
- Test: `test/htmlreport-render.test.ts` *(new)*

**Interfaces:**
- Consumes: `elementPolicy`, `NotRendered` from `./htmlreport.js`.

- [ ] **Step 1: Write the failing test**

Create `test/htmlreport-render.test.ts`:

```ts
import { describe as suite, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { htmlElements } from '../src/htmlflow.js';
import { placeElements } from '../src/flowplace.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { HtmlFlowOptions } from '../src/htmlflow.js';

function render(src: string, width = 400, options: HtmlFlowOptions = {}) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements, skipped, unsupported } = htmlElements(doc, src, width, options);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return {
    page, skipped, unsupported,
    text: page.GetText(),
    names: skipped.map(describeReport),
  };
}

suite('suppression (zch2.7)', () => {
  it("suppresses an iframe's children and keeps the text around it", () => {
    // Asserted POSITIVELY: `not.toContain('fb')` also passes when the whole
    // document failed to render, so the surrounding text must be present too.
    const r = render('<p>before</p><iframe>fb</iframe><p>after</p>');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.text).not.toContain('fb');
    expect(r.names).toContain('iframe');
    expect(r.skipped.find((s) => s.construct === 'iframe')?.kind).toBe('dropped');
  });

  it('suppresses inline svg, whose text was leaking into the flow', () => {
    const r = render('<p>before</p><svg><text>SVGTEXT</text></svg><p>after</p>');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.text).not.toContain('SVGTEXT');
    expect(r.names).toContain('svg');
  });

  it('suppresses inline math', () => {
    const r = render('<p>a</p><math><mi>MATHTEXT</mi></math><p>b</p>');
    expect(r.text).toContain('a');
    expect(r.text).not.toContain('MATHTEXT');
    expect(r.names).toContain('math');
  });

  it('KEEPS object, video, audio and canvas fallback, and reports it', () => {
    // The exact opposite assertion on the same shape as the iframe case
    // above, which is what stops "suppress" and "keep" collapsing into one
    // rule that happens to satisfy both tests.
    for (const name of ['object', 'video', 'audio', 'canvas']) {
      const r = render(`<p>x</p><${name}>KEPT</${name}>`);
      expect(r.text, name).toContain('KEPT');
      expect(r.names, name).toContain(name);
      expect(r.skipped.find((s) => s.construct === name)?.kind, name)
        .toBe('degraded');
    }
  });

  it('suppresses a BLOCK-level iframe too, through the other walk', () => {
    // cssbox.ts and cssinline.ts have separate walks. An iframe is inline by
    // default so cssinline sees it; display:block routes it to cssbox, and a
    // policy applied in only one of the two is silent for the other.
    const r = render('<p>before</p><iframe style="display:block">fb</iframe>');
    expect(r.text).toContain('before');
    expect(r.text).not.toContain('fb');
    expect(r.names).toContain('iframe');
  });

  it('reports a suppressed element exactly ONCE', () => {
    const r = render('<iframe>fb</iframe>');
    expect(r.names.filter((n) => n === 'iframe')).toHaveLength(1);
  });

  it('leaves an unknown element alone, with no record', () => {
    const r = render('<my-widget>custom</my-widget>');
    expect(r.text).toContain('custom');
    expect(r.names).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: FAIL — iframe/svg/math text is still rendered and nothing is
reported.

- [ ] **Step 3: Apply the policy in `cssinline.ts`**

In `visit`, immediately AFTER the `display: none` check and BEFORE the `br`
branch:

```ts
    // What HTML says about this element's children. Applied here AND in
    // cssbox.ts's boxFor, because the two walks are separate: an element is
    // inline by default and reaches this one, but `display: block` routes it
    // to the other, and a policy applied in only one is silent for the other.
    const policy = elementPolicy(n);
    if (policy !== undefined) {
      report.push({ el: n, kind: policy.kind, construct: policy.construct });
      if (policy.content === 'suppress') return;
    }
```

with `import { elementPolicy } from './htmlreport.js';`.

- [ ] **Step 4: Apply the policy in `cssbox.ts`**

In `boxFor`, after the `display: none` guard and BEFORE the
`TABLE_DISPLAYS` branch:

```ts
    const policy = elementPolicy(el);
    if (policy !== undefined) {
      report.push({ el, kind: policy.kind, construct: policy.construct });
      if (policy.content === 'suppress') {
        // A BOX with no content rather than no box: the element is still a
        // replaced box that occupies its margins, unlike `display: none`.
        // cssmargin.ts's isEmpty then treats it as an empty block, which is
        // what a browser does with an iframe it cannot load.
        return {
          kind: 'block', el, style, float, clear,
          content: { kind: 'inline', runs: [], atomics: [] },
        };
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlreport-render.test.ts`
Expected: typecheck clean; PASS, 7 tests.

- [ ] **Step 6: Run the fences**

Run: `npx vitest run test/html-identity.test.ts test/rich-runs-identity.test.ts test/docx-flow-identity.test.ts`
Expected: PASS. No fixture in any of them renders an iframe, an inline svg or
a form control.

- [ ] **Step 7: Commit**

```bash
git add src/cssinline.ts src/cssbox.ts test/htmlreport-render.test.ts
git commit -m "feat(zch2.7): suppress iframe and foreign content, and report it"
```

---

### Task 5: form controls

**Files:**
- Modify: `src/cssinline.ts` (`visit`)
- Test: `test/htmlreport-render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/htmlreport-render.test.ts`:

```ts
suite('form controls (zch2.7)', () => {
  it("draws an input's value, which used to vanish entirely", () => {
    const r = render('<p>a</p><input value="VALUE">');
    expect(r.text).toContain('VALUE');
    expect(r.names).toContain('input:text');
    expect(r.skipped.find((s) => s.construct === 'input')?.kind).toBe('degraded');
  });

  it('draws NOTHING for a password input', () => {
    // CLAUDE.md records under formfield.ts that a password field's value must
    // never reach a content stream: flattening bakes the plaintext into
    // permanent page content where no viewer will ever mask it again. An HTML
    // password value is the same disclosure by a different route.
    const r = render('<p>a</p><input type="password" value="hunter2">');
    expect(r.text).toContain('a');
    expect(r.text).not.toContain('hunter2');
    expect(r.names).toContain('input:password');
    expect(r.skipped.find((s) => s.construct === 'input')?.kind).toBe('dropped');
  });

  it('draws nothing for a hidden input', () => {
    const r = render('<p>a</p><input type="hidden" value="SECRET">');
    expect(r.text).not.toContain('SECRET');
    expect(r.names).toContain('input:hidden');
  });

  it('draws ONLY the selected option of a select', () => {
    // Emitting every option turns a three-choice dropdown into three lines of
    // body text — a document that looks plausible and says something the
    // source does not.
    const r = render('<select><option>ALPHA<option selected>BRAVO</select>');
    expect(r.text).toContain('BRAVO');
    expect(r.text).not.toContain('ALPHA');
    expect(r.names).toContain('select');
  });

  it("keeps a textarea's text and a button's caption", () => {
    const r = render('<textarea>TA</textarea><button>GO</button>');
    expect(r.text).toContain('TA');
    expect(r.text).toContain('GO');
    expect(r.names).toContain('textarea');
    expect(r.names).toContain('button');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: FAIL on the input cases (nothing drawn, nothing reported) and the
select case (both options drawn).

- [ ] **Step 3: Implement**

In `src/cssinline.ts`'s `visit`, immediately after the `img` branch and
BEFORE the generic `policy` block from Task 4 — so these two never take a
policy record as well as their own:

```ts
    if (n.ns === 'html' && n.name === 'input') {
      // A browser draws the VALUE in the box, and today we draw nothing at
      // all. Two refusals: `hidden` is hidden by definition, and `password`
      // must never reach a content stream — CLAUDE.md records that rule under
      // formfield.ts, because flattening bakes the plaintext into permanent
      // page content where no viewer will ever mask it again.
      const type = (n.attrs.get('type') ?? 'text').toLowerCase();
      const secret = type === 'hidden' || type === 'password';
      report.push({
        el: n, kind: secret ? 'dropped' : 'degraded',
        construct: 'input', detail: type,
      });
      if (secret) return;
      push(n.attrs.get('value') ?? '', { style: st, link: s.link }, n);
      return;
    }
    if (n.ns === 'html' && n.name === 'select') {
      report.push({ el: n, kind: 'degraded', construct: 'select' });
      push(selectedOptionText(n) ?? '', { style: st, link: s.link }, n);
      return;
    }
```

Add `selectedOptionText` to the `htmlreport.js` import. Note both branches
`return`, so a `<select>`'s children are never visited — which is how its
unselected options are suppressed without a policy entry.

`push('')` is a no-op (`if (text === '') return`), so an input with no value
and a select with no options draw nothing and need no guard.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlreport-render.test.ts`
Expected: typecheck clean; PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cssinline.ts test/htmlreport-render.test.ts
git commit -m "feat(zch2.7): draw an input value and a select's chosen option"
```

---

### Task 6: the three properties computed and never read

**Files:**
- Modify: `src/cssinline.ts` (`visit`)
- Test: `test/htmlreport-render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/htmlreport-render.test.ts`:

```ts
suite('properties computed and never read (zch2.7)', () => {
  it('reports inline-block, which is laid out as inline', () => {
    const r = render('<span style="display:inline-block;width:50px">ib</span>');
    expect(r.text).toContain('ib');
    expect(r.names).toContain('inline-block');
  });

  it('reports vertical-align, which is ignored', () => {
    // It IS a computed longhand, so the cascade's unknown-property backstop
    // never fires for it — it has zero consumers outside cssprop.ts's table.
    const r = render('<p>x<span style="vertical-align:super">s</span></p>');
    expect(r.names).toContain('vertical-align:super');
  });

  it('does NOT report vertical-align: baseline, the initial value', () => {
    // Every element computes one, so reporting the initial would put a record
    // on every element in every document and make the report unreadable.
    expect(render('<p>plain</p>').names).toEqual([]);
  });

  it('reports padding on an INLINE box, which is ignored', () => {
    const r = render('<p>x<span style="padding:20px">p</span>y</p>');
    expect(r.names).toContain('inline-box:padding');
  });

  it('does NOT report padding on a BLOCK box, where it is applied', () => {
    // cssresolve.ts turns a block's padding into real insets, so a record
    // there would be false.
    expect(render('<p style="padding:20px">x</p>').names).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: FAIL on the three positive cases; the two negative ones pass
already.

- [ ] **Step 3: Implement**

In `src/cssinline.ts`'s `visit`, after the generic `policy` block and before
the `href` handling:

```ts
    // Three properties this stack COMPUTES and never reads. They get no
    // backstop from the cascade's unknown-property report, which fires only
    // for a name outside the 43 longhands — so without these they are silent
    // by omission rather than by decision.
    //
    // `visit` is reached only for non-block-level nodes (contentOf routes
    // block-level children to boxFor), so no display check is needed here:
    // whatever arrives is an inline-level box whose padding is ignored.
    if (st.display === 'inline-block')
      report.push({ el: n, kind: 'degraded', construct: 'inline-block' });
    if (st.verticalAlign !== 'baseline') {
      report.push({
        el: n, kind: 'degraded', construct: 'vertical-align',
        detail: st.verticalAlign,
      });
    }
    if (hasInlineBox(st))
      report.push({ el: n, kind: 'degraded', construct: 'inline-box', detail: 'padding' });
```

and, above `inlineContentOf`:

```ts
/** Does this inline box state padding a browser would paint and we ignore?
 *
 *  The INITIAL value is 0 on every side, so only a stated one reports —
 *  otherwise every element in every document earns a record and the report
 *  stops being read. A percentage resolves against a containing block this
 *  module does not have, so `fixedPx` returning undefined counts as stated:
 *  we ignore it either way. */
function hasInlineBox(st: ComputedStyle): boolean {
  for (const v of [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft]) {
    const px = fixedPx(v);
    if (px === undefined || px !== 0) return true;
  }
  return false;
}
```

with `import { fixedPx } from './cssvalue.js';` added.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlreport-render.test.ts`
Expected: typecheck clean; PASS, 17 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: green. If a CSS test that styles a `<span>` with padding now trips
an unexpected record, that is the rule working — update the assertion, do not
weaken the rule.

- [ ] **Step 6: Commit**

```bash
git add src/cssinline.ts test/htmlreport-render.test.ts
git commit -m "feat(zch2.7): report inline-block, vertical-align and inline padding"
```

---

### Task 7: the fragment href moves off `unsupported`

**Files:**
- Modify: `src/cssinline.ts` (the `href` block)
- Modify: `test/htmlflow.test.ts` (the zch2.6 fragment case)

- [ ] **Step 1: Update the existing test**

`test/htmlflow.test.ts` has a zch2.6 case asserting the fragment href on
`unsupported`. Replace its two assertions:

```ts
  it('emits NO annotation for a fragment-only href, and reports it', () => {
    // A /URI action pointing at "#intro" is a link that looks clickable and
    // does nothing in a viewer. Resolving one needs an id-to-destination map
    // built after placement, which is a follow-up.
    //
    // zch2.6 parked this on `unsupported` as `unparsable-value` and recorded
    // that zch2.7 could widen it. It moved: a link we DECLINED to make is a
    // construct we did not render, not a declaration we could not parse.
    const { skipped, unsupported } = render('<p><a href="#intro">jump</a></p>');
    expect(annots('<p><a href="#intro">jump</a></p>').length).toBe(0);
    expect(skipped.map(describeReport)).toContain('link:#intro');
    expect(skipped.find((s) => s.construct === 'link')?.kind).toBe('degraded');
    expect(unsupported.some((u) => u.property === 'href')).toBe(false);
  });
```

Add `import { describe as describeReport } from '../src/htmlreport.js';` if
Task 2 did not already add it to this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: FAIL — the record is on `unsupported`, not `skipped`.

- [ ] **Step 3: Implement**

In `src/cssinline.ts`, replace the `unsupported.push` in the fragment branch:

```ts
    const fragment = rawHref !== undefined && rawHref.startsWith('#');
    if (fragment) {
      report.push({
        el: n, kind: 'degraded', construct: 'link', detail: rawHref,
      });
    }
```

and delete the stale "zch2.7 can widen it if it wants to" sentence from the
comment above it, replacing it with a note that it did.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cssinline.ts test/htmlflow.test.ts
git commit -m "feat(zch2.7): a fragment href is a construct, not a bad value"
```

---

### Task 8: the nested table stops losing its text

**Files:**
- Modify: `src/csstable.ts` (`flattenRuns`, `collectBox`)
- Test: `test/csstable.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/csstable.test.ts`:

```ts
describe('a nested table (zch2.7)', () => {
  it('flattens the inner cells rather than losing them', () => {
    // A REGRESSION against this epic's own rule, shipped in zch2.6:
    // collectBox returned early for a table box, so `INNER` reached no
    // output at all. A cell takes `string | TextRun[]`, so the inner table
    // cannot BE a table here — its cells' text flattens into the outer cell.
    const { t } = build('<table><tr><td>outer'
      + '<table><tr><td>INNER</td></tr></table>'
      + '</td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    const joined = typeof runs === 'string' ? runs : runs.map((r) => r.text).join('');
    expect(joined).toContain('outer');
    expect(joined).toContain('INNER');
  });

  it('reports the nested table as degraded', () => {
    const { c } = build('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>');
    expect(c.skipped.map((s) => s.construct)).toContain('table');
    expect(c.skipped.find((s) => s.construct === 'table')?.kind).toBe('degraded');
  });

  it('keeps every cell of a multi-cell inner table', () => {
    const { t } = build('<table><tr><td>'
      + '<table><tr><td>ONE</td><td>TWO</td></tr></table>'
      + '</td></tr></table>');
    const runs = t!.rows[0].cells[0].text;
    const joined = typeof runs === 'string' ? runs : runs.map((r) => r.text).join('');
    expect(joined).toContain('ONE');
    expect(joined).toContain('TWO');
  });
});
```

The `ctx()` helper at the top of that file must have its `skipped` retyped
from `string[]` to `NotRendered[]`:

```ts
import type { NotRendered } from '../src/htmlreport.js';
// …
  skipped: [] as NotRendered[],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/csstable.test.ts`
Expected: FAIL — `INNER` is absent and no `table` record exists.

- [ ] **Step 3: Implement**

In `src/csstable.ts`, both functions take the context so `collectBox` can
report:

```ts
function flattenRuns(
  content: TableCellBox['content'], out: TextRun[], c: TableMapCtx,
): void {
  if (content.kind === 'inline') { out.push(...content.runs); return; }
  for (const child of content.children) {
    if (out.length > 0) out.push({ ...out[out.length - 1], text: '\n' });
    collectBox(child, out, c);
  }
}

function collectBox(b: BoxNode, out: TextRun[], c: TableMapCtx): void {
  if (b.kind === 'table') {
    // A nested table cannot BE a cell — addCell takes `string | TextRun[]` —
    // so its cells' text flattens into the outer cell rather than being lost.
    // It WAS lost from zch2.6 until zch2.7, which is a regression against
    // this epic's own rule that a construct we cannot render still
    // contributes what it has.
    c.skipped.push({ el: b.el, kind: 'degraded', construct: 'table' });
    for (const row of b.rows) {
      for (const cell of row.cells) {
        if (out.length > 0) out.push({ ...out[out.length - 1], text: '\n' });
        flattenRuns(cell.content, out, c);
      }
    }
    return;
  }
  flattenRuns(b.content, out, c);
}
```

and its two call sites in `buildTable` pass `c`:

```ts
      flattenRuns(cell.content, runs, c);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/csstable.test.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 5: Add the end-to-end case**

Append to `test/htmlreport-render.test.ts`:

```ts
suite('a nested table end to end (zch2.7)', () => {
  it('draws the inner table\'s text inside the outer cell', () => {
    const r = render('<table><tr><td>outer'
      + '<table><tr><td>INNER</td></tr></table></td></tr></table>');
    expect(r.text).toContain('outer');
    expect(r.text).toContain('INNER');
    expect(r.names).toContain('table');
  });
});
```

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/csstable.ts test/csstable.test.ts test/htmlreport-render.test.ts
git commit -m "fix(zch2.7): a nested table's text no longer vanishes"
```

---

### Task 9: the inventory sweep

One test that walks the whole inventory, so a construct cannot be silently
forgotten — `test/flow-tagging.test.ts`'s shape.

**Files:**
- Modify: `test/htmlreport-render.test.ts`

- [ ] **Step 1: Write the sweep**

Append to `test/htmlreport-render.test.ts`:

```ts
suite('the inventory sweep (zch2.7)', () => {
  /** One source per construct, and the kind it must report.
   *
   *  This table IS the feature. A construct that stops reporting, or reports
   *  the wrong kind, reddens here whatever else stays green. */
  const CASES: [construct: string, kind: string, src: string][] = [
    ['iframe', 'dropped', '<iframe>fb</iframe>'],
    ['svg', 'dropped', '<svg><text>t</text></svg>'],
    ['math', 'dropped', '<math><mi>x</mi></math>'],
    ['object', 'degraded', '<object>fb</object>'],
    ['video', 'degraded', '<video>fb</video>'],
    ['audio', 'degraded', '<audio>fb</audio>'],
    ['canvas', 'degraded', '<canvas>fb</canvas>'],
    ['input', 'degraded', '<input value="v">'],
    ['select', 'degraded', '<select><option>a</select>'],
    ['textarea', 'degraded', '<textarea>t</textarea>'],
    ['button', 'degraded', '<button>b</button>'],
    ['inline-block', 'degraded', '<span style="display:inline-block">x</span>'],
    ['vertical-align', 'degraded', '<p>x<span style="vertical-align:super">s</span></p>'],
    ['inline-box', 'degraded', '<p>x<span style="padding:9px">s</span></p>'],
    ['float', 'degraded', '<div style="float:left">s</div>'],
    ['image', 'dropped', '<p>t <img src="a.png"> t</p>'],
    ['table', 'degraded',
      '<table><tr><td><table><tr><td>i</td></tr></table></td></tr></table>'],
    ['table-cell-blocks', 'degraded',
      '<table><tr><td><p>a</p><p>b</p></td></tr></table>'],
    ['link', 'degraded', '<p><a href="#f">j</a></p>'],
  ];

  it('covers every construct in the vocabulary', () => {
    // The sweep and the vocabulary must not drift: a construct added to one
    // and not the other is exactly the silent gap this issue exists to close.
    expect(new Set(CASES.map((c) => c[0])))
      .toEqual(new Set(CONSTRUCTS));
  });

  for (const [construct, kind, src] of CASES) {
    it(`reports ${construct} as ${kind}`, () => {
      const r = render(src);
      const hit = r.skipped.find((s) => s.construct === construct);
      expect(hit, `no ${construct} record in ${JSON.stringify(r.names)}`)
        .toBeDefined();
      expect(hit!.kind).toBe(kind);
    });
  }

  it('reports NOTHING for a document that renders whole', () => {
    // The other half: a report that fires on ordinary markup is a report
    // nobody reads.
    const r = render('<h1>T</h1><p>Body <b>bold</b> and '
      + '<a href="https://e.example">a link</a>.</p>'
      + '<ul><li>one</li><li>two</li></ul>'
      + '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    expect(r.names).toEqual([]);
  });
});
```

Add `CONSTRUCTS` to the `htmlreport.js` import at the top of the file.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: PASS. Tasks 4-8 already made every row work; this is the guard that
they stay working. If the "renders whole" case fails, a rule is firing on
ordinary markup — fix the rule, not the fixture.

- [ ] **Step 3: Commit**

```bash
git add test/htmlreport-render.test.ts
git commit -m "test(zch2.7): sweep every construct in the vocabulary"
```

---

### Task 10: mutation sweep

Reuse the harness from `zch2.6` (a throwaway script in the session
scratchpad, not `scripts/`):

```js
// mutate.mjs — apply one mutation, run tests, report which redden, restore.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [, , srcPath, testPath, specPath] = process.argv;
const MUTATIONS = JSON.parse(readFileSync(specPath, 'utf8'));
const original = readFileSync(srcPath, 'utf8');
for (const m of MUTATIONS) {
  if (!original.includes(m.find)) { console.log(`!! ${m.name}: FIND NOT PRESENT`); continue; }
  writeFileSync(srcPath, original.replace(m.find, m.replace));
  let out = '';
  try {
    out = execSync(`npx vitest run ${testPath} --reporter=json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = e.stdout ?? ''; }
  let failed;
  try {
    failed = JSON.parse(out.slice(out.indexOf('{'))).testResults
      .flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed')
      .map((a) => a.title);
  } catch { failed = ['<<could not parse reporter output>>']; }
  console.log(`\n== ${m.name}`);
  console.log(failed.length === 0 ? '   NOTHING REDDENED' : failed.map((t) => `   red: ${t}`).join('\n'));
}
writeFileSync(srcPath, original);
console.log('\nrestored');
```

Test target throughout:
`test/htmlreport.test.ts test/htmlreport-render.test.ts test/csstable.test.ts test/cssflow.test.ts test/cssflow-report.test.ts test/htmlflow.test.ts`

- [ ] **Step 1: Mutate `src/htmlreport.ts`**

| Mutation | Must redden |
|---|---|
| `elementPolicy` returns `render` for `iframe` | the iframe suppression case |
| `elementPolicy` returns `suppress` for `object` | the fallback-kept case |
| the `el.ns === 'svg'` branch is removed | the inline-svg case |
| `selectedOptionText` returns every option joined | the select case |
| `selectedOptionText` ignores `selected` and takes the first | the selected-option case |
| `describe` drops the detail | every `names` assertion carrying one |
| `HTML_POLICY` uses `in` instead of `hasOwnProperty` | expected to redden NOTHING — **record as uncovered**; no fixture names an element called `constructor` |

- [ ] **Step 2: Mutate `src/cssinline.ts`**

| Mutation | Must redden |
|---|---|
| the policy block never returns on `suppress` | the iframe and svg cases |
| the policy block is deleted entirely | iframe, svg, math, object, textarea, button |
| `secret` drops `password` | the password case |
| `secret` drops `hidden` | the hidden case |
| the input branch pushes no text | the input-value case |
| the select branch visits children instead of returning | the "only the selected option" case |
| `verticalAlign !== 'baseline'` becomes `!== 'x'` | the baseline case (a record on every element) |
| `hasInlineBox` returns false always | the inline padding case |
| the fragment href reports on `unsupported` again | the fragment case |

- [ ] **Step 3: Mutate `src/cssbox.ts` and `src/csstable.ts`**

| Mutation | Must redden |
|---|---|
| `boxFor`'s policy block is deleted | the block-level iframe case |
| `boxFor`'s suppress branch returns the ordinary box | the block-level iframe case |
| `collectBox` returns early for a table again | the nested-table cases |
| `collectBox` pushes no `table` record | the nested-table report case |

- [ ] **Step 4: Record the results and close real gaps**

Any mutation that SHOULD redden and does not means the test is not
load-bearing: add the case, then re-run. Any expected to redden nothing goes
into `CLAUDE.md` in Task 11 as an explicitly uncovered rule.

- [ ] **Step 5: Commit**

```bash
git add test
git commit -m "test(zch2.7): close the gaps the mutation sweep found"
```

---

### Task 11: documentation

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: CLAUDE.md**

Add an `htmlreport.ts` entry to the Source list carrying, as invariants: that
it is a pure leaf over `htmldom.js` that never throws; that it is `html*`
rather than `css*` because it is keyed on HTML element names and sits beside
`htmllang.ts`; that it exists as a module because TWO walks need the policy
and neither may import the other; that there are TWO kinds because a third
nobody can emit is a case every consumer switches on for nothing; that the
policy is keyed by NAMESPACE for foreign content and by tag name for HTML;
that `input` and `select` are deliberately absent from the policy table
because `cssinline.ts` owns them; and that `<select>` emits ONE option
because emitting all of them says something the source does not.

Add to the `cssinline.ts` entry: the password/hidden refusal and its
cross-reference to `formfield.ts`'s recorded rule; that `visit` is reached
only for non-block-level nodes, which is why the three property reports need
no display check; and that the fragment href MOVED from `unsupported` to the
report, superseding the note zch2.6 left there.

Add to the `cssflow.ts` entry: that `skipped` is now `NotRendered[]`, and the
PHASE ordering rule with its reason.

Add to the `csstable.ts` entry: that a nested table flattens rather than
vanishing, and that it vanished from zch2.6 to zch2.7.

Then run the module sweep:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected output: the five pre-existing entries (`colorkey.ts`, `errors.ts`,
`formremove.ts`, `htmlforms.ts`, `tabletag.ts`) and NOTHING else.

- [ ] **Step 2: CHANGELOG.md**

Under `## [Unreleased]` → `### Added`, newest first. Lead with the BREAKING
shape change, since `skipped` is a public field: say that it is now
`NotRendered[]` and that `describeNotRendered` recovers the old strings. Then
what a user gets — eight constructs that were silent now report, a nested
table stops losing its text, an `<input>`'s value is drawn, and an
`<iframe>`'s and an inline `<svg>`'s content stop being drawn because no
browser draws them. Say the limits (inline SVG rendering is `zch2.12`, form
controls are not real widgets, `inline-block`/`vertical-align`/inline padding
are reported rather than implemented). Cite `(zch2.7)`.

- [ ] **Step 3: README.md**

In the "HTML rendering is a documented subset" paragraph, replace the list of
silent gaps with the report: say that everything not rendered names itself in
`skipped` with an element pointer and a `dropped`/`degraded` kind, and that
`<iframe>` and inline `<svg>` content is deliberately not drawn. In the
feature bullet, note the `skipped` shape so a caller knows to read `.construct`
rather than a string.

- [ ] **Step 4: Verify everything**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean, all files green, `dist/index.js` produced.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(zch2.7): CHANGELOG, README and CLAUDE.md for the report"
```

- [ ] **Step 6: Close and push**

```bash
bd close zch2.7 --reason "<what shipped, the limits, the mutation results>"
git add -A .beads && git commit -m "chore(beads): close zch2.7"
git checkout main && git merge --ff-only <branch> && git push origin main
git status -sb   # MUST show main...origin/main with no ahead/behind
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: the leaf and its
vocabulary to Task 1; the `skipped` retype (decision 1) to Task 2; the
threading to Task 3; the per-element leak policy (decision 2) to Tasks 4 and
5; the three computed-and-unread properties to Task 6; the fragment href to
Task 7; the nested-table regression to Task 8; the sweep, the size assertion
and the positive-suppression rule to Tasks 1 and 9; the mutation sweep to
Task 10; documentation to Task 11. Decision 3 (inline SVG deferred) is
realised as Task 4's suppression plus the already-filed `zch2.12`. Decision 4
(Markdown untouched) is a global constraint and appears in no task, which is
correct — it is a prohibition, not work.

**Two refinements of the spec, both deliberate and both flagged in place.**
`contentPolicy` became `elementPolicy` returning content-plus-kind-plus-
construct, because one call must answer "descend?" and "how reported?"
together. And `construct` is a closed union rather than `string`, which is
what makes the spec's own "asserted by SIZE" requirement expressible.

**Type consistency.** `NotRendered`, `ElementPolicy`, `Construct`,
`CONSTRUCTS`, `describe`, `elementPolicy` and `selectedOptionText` are defined
in Task 1 and used with those exact names in Tasks 2-9. `report` is the
parameter name in `cssbox.ts`/`cssinline.ts` while the same array is
`Ctx.skipped` in `cssflow.ts` and `TableMapCtx.skipped` in `csstable.ts` —
deliberate, because the public field is `skipped` and the internal one says
what it is; Task 3 Step 3 is where the two names meet, on one line.

**One thing the plan does NOT do, named so it is not read as an oversight.**
`AddHtmlResult` and `HtmlElements` in `htmlflow.ts` extend `HtmlFlowResult`,
so they pick the retype up for free and appear in no task's file list.
