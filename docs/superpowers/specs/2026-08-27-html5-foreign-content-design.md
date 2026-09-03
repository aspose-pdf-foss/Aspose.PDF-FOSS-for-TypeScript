# HTML5 foreign content — design

Issue: `zch2.1.3.1`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`
(HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-27.

`zch2.1.2` landed tree construction for HTML content: 1,317 of the vendored
WPT cases green, `parseHtml` deliberately unexported. This is the first of the
three pieces `zch2.1.3` was decomposed into, and it is the one that makes an
inline `<svg>` subtree parse into the SVG namespace instead of silently into
the HTML one — the reason the export was withheld.

Every number and every list below was read out of the current HTML Standard
(`html.spec.whatwg.org/multipage/parsing.html`, fetched 2026-08-27) or measured
against the vendored corpus. None is from memory. `zch2.1.2` shipped with two
claims that were from memory and both were wrong; that is the reason for the
rule.

## Why `zch2.1.3` was decomposed

The issue as filed bundled foreign content, `<template>` and fragment parsing —
515 cases across three mechanisms that share almost nothing. Measured against
the corpus:

| Piece | Cases | Issue |
|---|---|---|
| Foreign content only | 207 | `zch2.1.3.1` — this document |
| `<template>` only | 110 | `zch2.1.3.2` |
| Both foreign and template | 2 | `zch2.1.3.2` |
| Fragment (`#document-fragment`) | 196 | `zch2.1.3.3` |

The order is forced rather than chosen. Sixty-seven of the 196 fragment
contexts are `svg …` or `math …` and one is `template`, so fragment parsing
genuinely depends on both siblings and goes last. `zch2.1.2` at ~1,450 lines
was already the largest single task in this epic; 515 more cases in one change
would be a task nobody can gate in a single pass.

## Scope

**In:** the rules for parsing tokens in foreign content (§13.2.6.5), the
`math`/`svg` start tags in "in body", the integration-point predicates, the
four adjustment tables, the breakout list, namespaces in the node model and
the serializer, namespace-aware `special` and scope tests, the self-closing
flag, and the tokenizer's CDATA routing. 207 vendored cases green.

**Out, and tracked:** `<template>` (`zch2.1.3.2`); fragment parsing and the
`parseHtml` export (`zch2.1.3.3`); handing an SVG subtree to `svgdraw.ts`'s
importer (`zch2.4`/`zch2.5`, which own the mapping to `FlowElement[]` — this
issue only has to produce a subtree in the right namespace for them to find).

Nothing here produces PDF, and nothing here is reachable from `index.ts`.

## Modules

Three touched, one created.

- **`src/htmlforeign.ts`** — **new, a pure leaf** over `htmldom.js` for types
  alone. The four adjustment tables, the two integration-point predicates and
  the breakout list.
- **`src/htmldom.ts`** — gains a namespace on an element.
- **`src/htmlstack.ts`** — its scope terminators become namespace-aware.
- **`src/htmltree.ts`** — the dispatcher branch, the foreign token rules, and
  the `math`/`svg` start tags in "in body".

**Invariant: `htmlforeign.ts` is a leaf and holds only DATA and PREDICATES.**
The token rules stay in `htmltree.ts`, because they insert elements, pop the
stack and reconstruct formatting — moving them out needs either a wide seam of
injected callbacks or an import back that closes a cycle. What moves is
everything that can be asserted from a table entry with no parser in the
picture, which is the split `htmlcharref.ts` already makes against
`htmltoken.ts`.

The tables, with their measured sizes:

| Export | Entries | Example |
|---|---|---|
| `SVG_TAG_NAMES` | 37 | `foreignobject` → `foreignObject` |
| `SVG_ATTRS` | 58 | `attributename` → `attributeName` |
| `MATHML_ATTRS` | 1 | `definitionurl` → `definitionURL` |
| `FOREIGN_ATTRS` | 11 | `xlink:href` → the key `xlink href` |
| `FOREIGN_BREAKOUT` | 44 | `b, big, blockquote, … var` |

`MATHML_ATTRS` having exactly one entry is not an error and is recorded here
because it reads like one: §13.2.6.5 defines "adjust MathML attributes" as a
table of one row. It ships as a table anyway, so the three adjust functions
have one shape.

## The node model

`HtmlElement` gains `ns: HtmlNamespace`, a three-value union
(`'html' | 'svg' | 'math'`) rather than a namespace URI. Every comparison in
the parser is against one of three constants, and the serializer wants the
short spelling anyway; a URI would be a long string compare everywhere and a
map back to `svg`/`math` at the end.

`createElement(name, attrs?, ns?)` defaults `ns` to `'html'`. **That default is
the fence**: every existing call site is unchanged, so "the 1,317 cases that
were green stay byte-identical" is something the suite actually checks rather
than something we hope.

### Attributes stay `Map<string, string>`

"Adjust foreign attributes" rewrites the **key**: `xlink:href` becomes
`xlink href`. The serializer then needs no change at all — including its sort,
which already produces the corpus's order — and every `attrs.get('type')` in
`htmltree.ts` keeps working.

**This is sound rather than merely convenient.** An attribute name can never
contain a space: whitespace terminates the name in the tokenizer, so no
document can produce a literal attribute called `xlink href` that would collide
with an adjusted one. The rule to document is one line — an attribute whose
name contains a space is a namespaced one — and it is exactly what the
html5lib format displays.

What this gives up, deliberately: a CSS `[xlink|href]` selector could not be
answered without upgrading the representation. Nothing in this repo branches on
an attribute's namespace, and `zch2.2` can upgrade it if it ever needs to.

### The serializer

`serializeTree` is test-only and lives in `test/helpers/wpt-tree.ts`; nothing
in `src/` may import it, the rule `test/helpers/md-html.ts` already sets. An
element emits `<svg svg>` / `<math math>` / `<div>` — the namespace prefix plus
a space, empty for HTML. Attributes are untouched. Both halves are
verified the way `zch2.1.2` verified the original: by reproducing a vendored
`#document` byte for byte from a hand-built tree.

## The tokenizer seam

`markup declaration open` routes `<![CDATA[` to the CDATA section state only
when the adjusted current node is not an HTML element; otherwise it is a bogus
comment plus `cdata-in-html-content`. `zch2.1.1` implemented the second half
and left the first marked in a comment. Its CDATA states already exist and
already pass their own tokenizer cases — nothing in the state machine changes.

`HtmlTokenizer`'s constructor takes an options object with one member:

```ts
new HtmlTokenizer(src, { adjustedCurrentNodeIsForeign?: () => boolean })
```

**Invariant: it is a CALLBACK asked at the moment of the decision, never a flag
kept in sync.** The stack changes between tokens, and a cached answer stays
right until a `<svg>` opens mid-stream — at which point it is wrong for exactly
the documents this feature exists for. Pull matches the seam the tokenizer
already is (`next`/`setState`), and it is the shape `glyphprogram.ts` and
`dfont.ts` already use for a dependency they must not import.

The default is `() => false`, so `zch2.1.1`'s 7,032 tokenizer cases are
untouched and `cdata-in-html-content` still fires for HTML content.

## Tree construction

### The dispatcher

§13.2.6 puts a branch **before** the insertion-mode switch. HTML rules apply
when the stack is empty, when the adjusted current node is an HTML element, at
a MathML text integration point (for a character token, or a start tag that is
not `mglyph`/`malignmark`), at an `annotation-xml` whose start tag is `svg`, at
an HTML integration point (character or start tag), or at EOF. Otherwise the
foreign rules run.

`adjustedCurrentNode()` lands now, named as the spec names it, even though it
equals the current node until `zch2.1.3.3` gives it a fragment context. Naming
it correctly now is what stops `.3.3` from having to find every call site.

An HTML integration point is an `annotation-xml` whose **start tag** carried
`encoding="text/html"` or `"application/xhtml+xml"`, case-insensitively. We
store the token's attributes on the element, so the predicate reads the element
and needs no separate record — worth stating, because the spec's wording is
about the token and invites keeping a side table.

### Two traps

**`special` and the scope terminators must become namespace-aware.** The
special category and the scope lists both gained MathML `mi/mo/mn/ms/mtext/
annotation-xml` and SVG `foreignObject/desc/title`. An SVG `title` is special
*and* an HTML `<title>` is special — but MathML `mi` is special while an HTML
`<mi>` is not, and an HTML `<desc>` is not. A name-only `SPECIAL.has(name)` is
wrong in both directions and silently: it makes the adoption agency choose the
wrong furthest block, which yields a mis-nested tree that still renders.
`htmlstack.ts`'s scope search has the identical problem and is fixed the same
way, by keying on `(ns, name)`.

**The self-closing flag gets read for the first time.** `zch2.1.2` ignored it
entirely, correctly — no HTML element's parsing depends on it. In foreign
content a self-closing start tag inserts and pops immediately, so `<svg/>` is
an empty element while `<svg>` swallows the rest of the document. This is the
one place in the parser where that flag changes a tree.

### Element creation in foreign content

An element created while the foreign rules are running takes the **adjusted
current node's** namespace, not a namespace derived from its own name. That is
what makes `<svg><g>` put `g` in the SVG namespace without a table of SVG
element names, and what makes an unknown element inside `<math>` MathML.

## Fixtures

The `foreign` bucket is **retired, not split**. Its svg/math predicate goes
away entirely — those cases now run — and what is left of it is the `template`
predicate, which keeps the 110 template-only cases and, because it is now the
only test of the two, the 2 that are both. There are still six buckets:

| Bucket | Before | After |
|---|---|---|
| `inScope` | 1,317 | **1,524** |
| `foreign` | 319 | *retired* |
| `template` | — | 112 |
| `fragment` | 196 | 196 |
| `processingInstruction` | 86 | 86 |
| `selectedContent` | 4 | 4 |
| `scripted` | 14 | 14 |

`1,524 + 112 + 196 + 86 + 4 + 14 = 1,936`, and all six counts are asserted as
they are today. Measured, not predicted — the first draft of this table said
the foreign bucket kept its 207 and summed to 2,143.

The split stays a computed predicate over the expected tree, never a file list,
and `template.dat` is exactly why: it holds 112 cases, of which **109** are
template cases and three are not (two ordinary, one fragment) — while three of
the 112 template cases live in other files.

## Testing

The pattern `zch2.1.2` set, unchanged. Hand-built cases in
`test/htmlforeign.test.ts` for the tables and predicates, driven from element
literals with no parser; hand-built parser cases in `test/htmltree.test.ts`
**copied from the corpus with their case ids in comments**, never invented; and
the 207 vendored cases turned on with no allowlist.

### Mutations, named before the code

Each run against the corpus and the unit files, recorded in
`test/fixtures/wpt/PROVENANCE.md` with **observed** counts:

| Mutation | Expected to redden |
|---|---|
| `SVG_TAG_NAMES` neutered, so tag case is not fixed | `tests10`, `svg` |
| Integration points forced false — never return to HTML rules | the `foreignObject` and `annotation-xml` cases |
| `FOREIGN_BREAKOUT` emptied | `tests10`, `tests11` |
| Self-closing ignored in foreign content | the `<svg/>` cases |
| The CDATA callback forced false | `tests10`'s `<![CDATA[` cases |
| `special` and scope made namespace-blind | expected: few, possibly none — record it either way |

The last one is the one to watch. If a namespace-blind `special` reddens
nothing, that is the `zch2.1.2` "original insertion mode is one variable"
result again — a rule held by the spec and not by this suite — and it gets
written down as uncovered rather than left to be discovered.

**The standing fence:** all 1,317 cases that are green today must stay green.
That is what the `ns` default and the tokenizer's default callback exist for,
and a red one there is information rather than a chore.

## What is deliberately not here

`parseHtml` is still not exported from `index.ts`. Foreign content fixes the
namespace, but a caller cannot usefully parse an HTML fragment yet, and
`zch2.1.3.3` is where the public entry point and its shape get decided.
