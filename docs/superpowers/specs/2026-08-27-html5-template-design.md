# HTML5 `<template>` — design

Issue: `zch2.1.3.2`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`
(HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-27.

`zch2.1.3.1` landed foreign content: 1,524 of the vendored WPT cases green.
This is the second of `zch2.1.3`'s three pieces — the "in template" insertion
mode, the stack of template insertion modes, and a template's content
fragment, which is where its children actually go.

Every number and every rule below is read from the current HTML Standard
(`html.spec.whatwg.org/multipage/parsing.html`, fetched 2026-08-27) or measured
against the vendored corpus. That rule has now caught a wrong claim in each of
the two preceding designs, and a third in this one — see **Fixtures**.

## Scope

**In:** the "in template" insertion mode (§13.2.6.4.16), the template
insertion-mode stack, `<template>` and `</template>` in "in head", the content
fragment in `htmldom.ts` and its serialization, the insertion-location
redirect, the `template` branch of "reset the insertion mode appropriately",
and the first real caller of `generateImpliedEndTagsThoroughly`. 110 more
vendored cases green.

**Out, and tracked:** fragment parsing and the `parseHtml` export
(`zch2.1.3.3`); processing instructions (`zch2.9`); `<selectedcontent>`
(`4h3p`).

**Out, by decision rather than deferral** — see *What is deliberately absent*.

Nothing here produces PDF, and nothing here is reachable from `index.ts`.

## Modules

No new module. `htmldom.ts` gains a node kind, `htmltree.ts` gains a mode and
a stack, and the test helper's serializer gains one line. `htmlforeign.ts` and
`htmlstack.ts` are untouched.

That is worth stating because the two preceding issues each added a module and
the habit could carry: there is nothing here that is pure data or a pure
predicate, and the template rules are inseparable from the stack they operate.

## The node model: a real content fragment

```ts
export interface HtmlFragment {
  kind: 'fragment';
  children: HtmlNode[];
  parent: HtmlNode | null;
}
export interface HtmlElement {
  …
  /** A template's content. Present on a `template` element and nothing else. */
  content?: HtmlFragment;
}
```

**Invariant: a separate NODE, not a second children array on the element.**
Three reasons, in order of how much they cost when ignored:

1. **A template's content is not part of the document.** CSS does not match
   into it and `zch2.2`'s traversal must not walk it. A separate node makes
   that structural rather than a rule every future consumer has to remember.
2. `appendChild`, `insertBefore` and `removeChild` need a real parent object
   to point at. With a bare array they would each need a template special case.
3. It is the DOM's own shape, so the serializer's `content` line is a
   transcription rather than a synthesis.

`HtmlParent` widens to `HtmlDocument | HtmlElement | HtmlFragment`; `HtmlNode`
gains `HtmlFragment`. `childrenOf` returns a fragment's children.

**The serializer** emits `content` at depth + 1 with no angle brackets, and the
fragment's children at depth + 2 — verified, as before, by reproducing a
vendored `#document` byte for byte from a hand-built tree.

## The insertion-location redirect, which also fixes a live bug

`insertionLocation` takes the spec's two template clauses, and the second is a
defect in what `zch2.1.2` shipped:

- **After the foster-parenting block:** if the target is a template element,
  return its **content fragment**. That single clause is what routes every
  child of a template into the right place; everything else about template
  parsing follows from it.
- **Inside the foster-parenting block:** the spec searches for the last
  **template *or* table** in the stack of open elements, and if it finds a
  template, makes *that* the target — which then falls into the redirect
  above. Ours searches for the last table only.

**The second is a real bug today and is invisible today**, because a template
can never be on the stack until this issue lands. Stray content inside
`<template><table>` currently fosters past the template to whatever encloses
it. It is fixed here rather than filed, because this is the issue that makes it
reachable.

## The mode, and the stack

`Mode.InTemplate` is the 21st insertion mode, and `templateModes: Mode[]` is
the stack beside it. **With it, `htmltree.ts` implements all 21 modes
§13.2.6.4 defines** — `zch2.1.2`'s "20 non-template modes" becomes the whole
set, and the module header saying otherwise is corrected here.

Five start-tag groups redirect: four table-ish ones (`caption`/`colgroup`/
`tbody`/`tfoot`/`thead`, then `col`, then `tr`, then `td`/`th`) and a catch-all
"any other start tag" that goes to "in body". All five are mechanical — pop the
current template mode, push the corresponding one, switch, reprocess. That
repetition **is** the reason the stack exists: a template can nest inside a
table cell inside another template, and each level has to remember what it was
doing.

Two things the stack lights up that `zch2.1.2` deliberately left cold:

- **"Reset the insertion mode appropriately" gains its `template` branch**:
  a `template` on the stack means "switch to the current template insertion
  mode". `zch2.1.2` implemented every other branch and omitted this one.
- **`generateImpliedEndTagsThoroughly` gets its first caller.**
  `</template>` is the spec's ONLY call site. That function shipped in
  `zch2.1.2` unreached, documented as such, and measured as load-bearing by a
  mutation (83 cases redden if the thorough list is used everywhere). It stops
  being dead code here.

## What is deliberately absent

The spec's `<template>` start tag is fourteen steps, eleven of them
**declarative shadow DOM**; its `</template>` is six, one of them the
**insertion-target unwind** behind a template's `for` attribute. Neither is
implemented, neither gets a flag, and neither gets a stub.

**Declarative shadow DOM** is gated on the parser's *allow declarative shadow
roots*, which is false for any parser that is not a browser — and the spec's
own first sub-step then says "insert an HTML element for the token and
return", which is exactly the collapsed form. Shadow roots have no meaning in
a PDF.

**The insertion target** is null unless something reads a template's `for`
attribute, and nothing does.

Both are **measured unreachable, not assumed**: the corpus contains zero cases
mentioning `shadowroot` and zero mentioning a `for` attribute on a template.
Recorded in `CLAUDE.md` so the next reader sees a decision rather than an
oversight — the form the `htmldom.ts` and `htmlstack.ts` invariants already
take.

## Fixtures

The `template` bucket is **retired**, as `foreign` was in `zch2.1.3.1`. Its
predicate is deleted outright; there is no successor test.

| Bucket | Before | After |
|---|---|---|
| `inScope` | 1,524 | **1,634** |
| `template` | 112 | *retired* |
| `processingInstruction` | 86 | **88** |
| `fragment` | 196 | 196 |
| `scripted` | 14 | 14 |
| `selectedContent` | 4 | 4 |

**The 112 do not all become in-scope, and this design first claimed they
would.** Measured: 110 move to `inScope` and **two move to
`processingInstruction`** — `processing-instructions.dat#119`
(`<body><template><?something></template>`) and `#123` (`<template><?pi>`).
Both expect a real ProcessingInstruction node *inside* the template content,
so they are `zch2.9`'s disagreement and not this issue's work at all. The
template predicate was **masking** them; retiring it reveals them, and the PI
predicate claims them correctly with no change.

`1,634 + 88 + 196 + 14 + 4 = 1,936`. Five buckets, all asserted.

That the arithmetic had to be measured rather than reasoned is the third such
correction in three designs, which is why the practice is stated at the top of
each one.

## Testing

The pattern the two preceding issues set, unchanged. Hand-built node-model and
serializer cases; hand-built parser cases **copied from the corpus with their
case ids in comments**, never invented; then the 110 vendored cases turned on
with no allowlist. The standing fence is that all 1,524 cases green today stay
green.

### Mutations, named before the code

| Mutation | Expected to redden |
|---|---|
| The content fragment removed, children left on the element | nearly every `template.dat` case |
| The insertion-location template redirect dropped | the same, and it is the sharper test of the two |
| `template` removed from the foster-parenting search | the `<template><table>` cases |
| The mode stack made a single variable | the NESTED template cases — few, and recorded either way |
| "Reset the insertion mode"'s `template` branch dropped | the table-in-template cases |
| `generateImpliedEndTagsThoroughly` swapped for the ordinary variant | expected: few, possibly none — record it |

The last two are the ones to watch. `zch2.1.2` recorded a mutation that
reddened **nothing** ("original insertion mode is one variable"), and the
honest outcome there was to write down that the corpus does not cover it. The
same discipline applies to any of these that comes back empty.

## What is deliberately not here

`parseHtml` is still not exported from `index.ts`. `zch2.1.3.3` decides the
public entry point's shape along with fragment parsing, and nothing needs the
export before `zch2.4`.
