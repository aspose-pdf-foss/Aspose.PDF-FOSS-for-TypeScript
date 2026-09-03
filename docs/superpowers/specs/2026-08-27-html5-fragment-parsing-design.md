# HTML5 fragment parsing, and the `parseHtml` export — design

Issue: `zch2.1.3.3`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`
(HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-27.

The last of `zch2.1.3`'s three pieces, and the one that makes the parser
reachable: the HTML fragment parsing algorithm (§13.4), the fragment-case
branches the preceding issues left as named seams, and `parseHtml` in
`index.ts`.

Every number and every rule below is read from the current HTML Standard
(`html.spec.whatwg.org/multipage/parsing.html`, fetched 2026-08-27) or measured
against the vendored corpus. That practice has caught a wrong claim in each of
the three preceding designs. **This time the arithmetic was measured before
being written and came out as predicted** — recorded because a run of
corrections that stops is worth as much as one that continues.

## Scope

**In:** the fragment parsing algorithm, the context element and the synthetic
root, tokenizer priming from the context's name, `adjustedCurrentNode`'s real
definition, `resetInsertionMode`'s fragment-case branches, the form element
pointer, the `fragment` bucket's retirement, and `parseHtml` exported from
`index.ts`. 196 more vendored cases green, taking the suite to **1,830 of
1,936**.

**Out, and tracked:** processing instructions (`zch2.9`), `<selectedcontent>`
(`4h3p`), the scripting flag (`6t2v.2`), character-encoding detection from
bytes (`zch2.8`). Handing an SVG subtree to `svgdraw.ts` is `zch2.4`/`zch2.5`.

**Out, by decision:** `parseHtmlFragment` is implemented and tested but **not
exported** — see *Public surface*.

Nothing here produces PDF.

## Public surface

`src/index.ts` gains one function and the types its return value needs:

```ts
export { parseHtml } from './htmltree.js';
export type {
  HtmlNode, HtmlDocument, HtmlElement, HtmlFragment,
  HtmlText, HtmlComment, HtmlDoctype, HtmlNamespace,
} from './htmldom.js';
```

**Invariant: the signature is `parseHtml(src: string): HtmlDocument`.** No
options bag, no error list, no second entry.

Parse errors stay on the tokenizer, where `zch2.1.1`'s tests already assert
them with spec-coded names and positions. Every HTML string is a valid
document by construction, so an error is never actionable for a caller
rendering a PDF — a page of real-world HTML routinely carries dozens that
change nothing about the output. The list a caller *can* act on is
"what could not be rendered", which is `zch2.7`'s and a different list
entirely. Widening a return type later is additive; narrowing is not.

**Invariant: the mutation helpers are NOT exported.** `appendChild`,
`insertBefore`, `removeChild` and `createElement` stay internal. A caller
reading a parse result does not need them, and exporting them commits this
library to a DOM-editing API before anyone has asked for one.

**Invariant: `parseHtmlFragment` is implemented, fully tested and unexported.**
It has to exist — the 196 fragment cases are 10% of the corpus and the best
available evidence the parser is right — but nothing in this epic can call it.
`zch2.5`'s entry points (`flow.AddHtml`, `page.AddHtml`, `doc.AddHtml`) take a
PDF target, not an HTML element, so there is no context element to pass;
`page.AddHtml('<b>hi</b>')` is a document parse. Exported when a caller
appears, the rule `inlineimage.ts`'s deliberately-absent `Replace` already
sets.

## Fragment parsing

`parseHtmlFragment(src, context)` where `context` is `{ name: string; ns?:
HtmlNamespace }`, following §13.4:

1. A fresh document; the context document's quirks mode is not available to us
   and is left at the default.
2. A synthetic `html` **root**, appended to the document, and the stack of open
   elements set up to contain **just that root**.
3. The tokenizer primed from the context's name:

   | Context | State |
   |---|---|
   | `title`, `textarea` | RCDATA |
   | `style`, `xmp`, `iframe`, `noembed`, `noframes` | RAWTEXT |
   | `script` | script data |
   | `plaintext` | PLAINTEXT |
   | anything else | data (unchanged) |

   `noscript` is absent from that table on purpose: it takes RAWTEXT only when
   scripting is *enabled*, and ours is off, so it falls to the default. No
   corpus case uses a `noscript` context.
4. If the context is a `template`, push `InTemplate` onto the template
   insertion-mode stack.
5. Reset the insertion mode appropriately — which now consults the context.
6. Set the form element pointer to the nearest `form` at or above the context.
7. Parse, then return the root's children as an `HtmlFragment`.

### Two seams that stop being aliases

**`adjustedCurrentNode` becomes real.** It has returned the current node since
`zch2.1.3.1`, which named it correctly on purpose so this issue would not have
to find its call sites. Its actual definition: the **fragment context element**
when the stack of open elements holds exactly one element, and the current node
otherwise. That is what makes `<nobr>X` in an `svg path` context parse as
foreign content instead of HTML — with the alias it parses as HTML and the
whole 67-case foreign-context group is wrong.

**`resetInsertionMode` gains its fragment-case branches.** The `last` node
becomes the context element rather than the root, and the `td`/`th`, `head`,
`html` and `frameset` clauses start taking their other path. `zch2.1.2`
implemented the non-fragment half and the branches have been dead since.

### The form element pointer is unreachable, and that is recorded

Step 6 walks from the context up its ancestor chain. A `.dat` context element
is **synthesized with no ancestors**, so the walk always finds nothing and the
pointer keeps its initial `null`. It is implemented because the algorithm says
so and because a future caller passing a real element would need it; it is
recorded as uncovered rather than left to look tested.

## Fixtures

The `fragment` bucket is **retired** — the third and last exclusion this epic
removes, after `foreign` in `zch2.1.3.1` and `template` in `zch2.1.3.2`.

| Bucket | Before | After |
|---|---|---|
| `inScope` | 1,634 | **1,830** |
| `fragment` | 196 | *retired* |
| `processingInstruction` | 88 | 88 |
| `scripted` | 14 | 14 |
| `selectedContent` | 4 | 4 |

**Measured, and unlike the two preceding retirements nothing is masked**: all
196 become in-scope, none falls through to another predicate.
`1,830 + 88 + 14 + 4 = 1,936`. Four buckets, all asserted.

Two test-side changes follow:

- `WptCase.fragmentContext` is currently the raw `.dat` string — `td`,
  `svg path`, `math ms`. It gains a parse into `{ ns, name }`. The corpus's
  67 foreign contexts and 1 template context are exactly why this cannot stay
  a bare name.
- `serializeFragment(frag)` joins `serializeTree`, walking a fragment's
  children at **depth 0**. That is how the corpus writes a fragment
  expectation: `| <span>`, not a document wrapper.

## Testing

The pattern the three preceding issues set. Hand-built cases for the context
parse, the priming table and `serializeFragment`; hand-built parser cases
**copied from the corpus with their case ids**; then the 196 vendored cases
turned on with no allowlist. The standing fence is that all 1,634 cases green
today stay green.

### Mutations, named before the code

| Mutation | Expected to redden |
|---|---|
| `adjustedCurrentNode` reverted to the current node | the 67 foreign-context cases |
| The tokenizer priming table emptied | the 6 cases whose context is `title`, `textarea`, `style`, `script` or `plaintext` |
| The template-context push dropped | the one `template` context case |
| `resetInsertionMode`'s fragment branches dropped | the table-context cases, 91 of the 196 |
| The synthetic root named for the context instead of `html` | broad — a smoke test more than a rule |
| The form-pointer walk deleted | expected: **NOTHING** — record it |

The last one is named as expected-empty rather than discovered so, because the
reasoning above already establishes it. `zch2.1.2` recorded one mutation that
reddened nothing, `zch2.1.3.1` one that reddened a single case and
`zch2.1.3.2` another that reddened nothing; the discipline is to write the
zero down, not to avoid it.

## What this closes

With this, `zch2.1.3` and `zch2.1` are both complete: the tokenizer
(`zch2.1.1`), tree construction (`zch2.1.2`), foreign content
(`zch2.1.3.1`), `<template>` (`zch2.1.3.2`) and fragments. `zch2.3` (the box
model) unblocks, and `parseHtml` is finally something `zch2.4` can call.
