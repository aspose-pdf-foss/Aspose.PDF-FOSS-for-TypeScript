# flow.AddHtml, page.AddHtml, doc.AddHtml — design

Issue: `zch2.5`, under epic `zch2` (HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-31.

`zch2.1` closed with an HTML5 parser, `zch2.2` with a CSS front end, `zch2.3`
with a box model and `zch2.4` with the mapper that lowers a box tree to
`FlowElement[]`. None of them is reachable from `src/index.ts`. This is the
issue that makes the epic usable, and it is the **first public API** the epic
ships.

The issue text is short and is the whole specification:

> Three entry points over the one mapper, the shape `AddMarkdown` already has.
> Assert it by rendering one source through all three and comparing extracted
> text.

Every number and signature below is measured against the code rather than
recalled. That practice corrected the predecessor design and it corrects one
of `zch2.4`'s own test assumptions here.

## What already exists, and what is left

```
parseHtml                 HtmlDocument           zch2.1  ✓ public
  ↓
buildBoxes                BoxNode tree           zch2.3  ✓
  ↓
cssflow.lowerHtml         FlowElement[]          zch2.4  ✓
  ↓
THIS ISSUE                three entry points     zch2.5
  ↓
flow.ts / flowplace.ts    stacks and paginates
```

`cssflow.ts`'s function is already written and tested. What is missing is a
`FamilyResolver` that is not a test stub, and the three methods.

### One rename, and it is worth making now

`cssflow.ts` currently exports **`htmlFlowElements`**, and this issue's public
entry is **`htmlElements`** — two names one word apart, in modules named
`cssflow.ts` and `htmlflow.ts`. That is a permanent trap for a reader, and the
compiler cannot catch a call to the wrong one because both take an HTML
document and return flow elements.

So `cssflow.ts`'s export is renamed to **`lowerHtml`**: short, unmistakable,
and "lowering" is already the word this epic's specs and `CLAUDE.md` use for
what it does. It shipped hours ago, nothing outside the repo can depend on it,
and `index.ts` never exported it — so the rename costs three call sites and
one `CLAUDE.md` line. The public name stays `htmlElements`, mirroring
`markdownElements`.

## The font bridge, which every module below deferred here

`cssbox.ts`, `cssinline.ts`, `cssresolve.ts` and `cssflow.ts` all take
`resolveFamily` as an **argument** and each records the same reason:
`ComputedStyle.fontFamily` is a list of NAMES and `TextRun.font` is an
`AuthoringFont`, and bridging them needs `Document.LoadFontByName`, which a
pure leaf may not import. `zch2.5` is where that seam is finally filled.

```
font-family: Arial, Helvetica, sans-serif
  ├─ the named entries  → doc.LoadFontFamily(['Arial', 'Helvetica'])
  │     └─ a hit        → mdstyle.resolveFamily(thatFamily)
  └─ else the first generic
        serif → Times · sans-serif → Helvetica · monospace → Courier
```

**`LoadFontFamily` is reused rather than reimplemented, and it fits exactly.**
It already takes a `string[]` and walks the family chain, and it already
returns `{ regular, bold?, italic?, boldItalic? }` — structurally identical to
`MarkdownFontFamily`, which is not a coincidence: its own documentation says
the result is "ready to hand to `AddMarkdown({ style: { font } })`". Feeding
it to `mdstyle.resolveFamily` keeps ONE owner for the rule that an unstated
face falls back to `regular`.

**Memoized on the joined family list**, because `buildBoxes` asks once per
element. Underneath, `LoadFontByName`'s own `path#faceIndex` memo means two
families resolving to one file share a handle and nothing is embedded twice.

### Two consequences worth stating

**A plain `<p>` renders in Times, not Helvetica.** The UA sheet declares
`html { font-family: serif }` (`cssua.ts:28`) and `font-family` inherits, so
`serif` is what an unstyled document computes. This is browser-correct.
`zch2.4`'s tests all used a stub resolver returning Helvetica for every list,
so the real default will look like a regression to anyone reading those.

**A named family that resolves to nothing, in a list with no generic, falls
back to sans-serif.** `font-family: Garamond` alone admits no principled
answer. The alternative is a name→class lookup table, which can never be
complete and is the shape this repo rejects elsewhere — `rebuild.ts` records
the same reasoning about identifying `/Info` by an exclusion list. Stated
rather than guessed at, and the fixture asserts it directly so it stays a
decision.

## The one divergence from `markdownElements`, and it is forced

`markdownElements(src, options)` takes neither a `Document` nor a width.
`htmlElements` needs both:

- **A `Document`**, because the resolver calls `LoadFontFamily`. Markdown
  needs none: its styling is caller-supplied `AuthoringFont`s.
- **A width**, because `zch2.4` resolves boxes at BUILD time — three call
  sites read `spaceBefore` before `place()` runs, so a gap computed later can
  never reach the engine. A Markdown element carries no resolved geometry and
  is width-independent until it places.

```ts
export function htmlElements(
  doc: Document,
  src: string | HtmlDocument,
  width: number,
  options?: HtmlFlowOptions,
): HtmlElements;
```

The width is a positional argument rather than an option so that **no caller
of the three entry points passes one at all**: `flow` supplies
`this.geometry.columnWidth`, `page` supplies `rect[2]`, and `doc` builds a
`Flow` and delegates. A width in the shared options bag could be passed twice
and disagree.

## Naming: NOT `HtmlOptions`

`html.ts` already exports `HtmlOptions` for `ToHtml`, the opposite direction.
The new names are `HtmlFlowOptions`, `HtmlFlowResult`, `HtmlElements` and
`AddHtmlResult` — measured as unused today. `mdexport.ts` records exactly this
hazard for `MarkdownExportOptions` against `MarkdownOptions`, and notes that
the collision is caught at compile time only because both are exported from
`index.ts`. `AddHtml` rather than `AddHTML` matches `ToHtml` and the issue's
own title.

## The three entry points

```ts
// flow.ts — mirrors AddMarkdown: returns a REPORT, not `this`, because a
// caller cannot otherwise tell a dropped table from an empty document.
AddHtml(src: string | HtmlDocument, options?: HtmlFlowOptions): HtmlFlowResult;

// page.ts — lay into a rect; remainder continues via placeElements.
AddHtml(
  src: string | HtmlDocument,
  rect: [number, number, number, number],
  options?: HtmlFlowOptions & { paragraphSpacing?: number; structParent?: StructElement },
): AddHtmlResult;

// document.ts — NewFlow + AddHtml + Render in one call.
AddHtml(
  src: string | HtmlDocument,
  options?: HtmlFlowOptions & FlowOptions & { title?: string },
): { pages: Page[]; skipped: string[]; unsupported: UnsupportedDeclaration[] };
```

`src` accepts a pre-parsed `HtmlDocument` as well as a string, exactly as
`AddMarkdown` accepts an `MdDocument`. `parseHtml` is already public;
`parseHtmlFragment` deliberately is not, and nothing here changes that.

### `paragraphSpacing` is 0 by default, and that matters

`zch2.4`'s contract is that the whole collapsed gap lives in `spaceBefore`
with `paragraphSpacing: 0`, since `flow.ts` ADDS
`spaceAfter + paragraphSpacing + spaceBefore`. Measured: `normalizeFlowOptions`
defaults `paragraphSpacing` to 0 and `page.AddMarkdown`'s own option defaults
to 0, so the contract holds for every caller who says nothing. A caller who
sets a non-zero value on the flow gets it added between every HTML element as
well — their statement, documented rather than overridden, because silently
zeroing a flow-level setting for one kind of content is worse than obeying it.

## Body margins are honoured

`body { margin: 8px }` = 6pt, so content sits 6pt in from the column or rect
edge. An author who wants edge-to-edge writes `body { margin: 0 }` — what they
would write for a browser. Zeroing the root box's margins instead would be a
special case the box model has no notion of, and it would make our rendering
disagree with every other renderer fed the same source.

## `<title>`

**`doc.AddHtml` uses the document's `<title>` when the caller gives no
explicit `title` option.** An explicit option always wins; an empty or absent
`<title>` changes nothing.

This diverges from `doc.AddMarkdown`, deliberately. Markdown has no title
construct, so that method can only take one as an option — but an HTML
document *states* its title, so carrying it into `/Info /Title`, XMP
`dc:title` and `/ViewerPreferences /DisplayDocTitle` is reading the document
rather than inventing a fact. All three are written together, through the same
`SetMetadata` + `DisplayDocTitle` pair `doc.AddMarkdown` uses: a title without
the flag satisfies neither PDF/UA nor the caller's intent.

It applies to `doc.AddHtml` alone. `Flow.AddHtml` and `Page.AddHtml` append to
a document whose title is someone else's business — `doc.AddMarkdown`'s own
stated rule, and the reason it is the only one of the three that accepts
`title` at all.

## Modules

**`cssfont.ts`** — the `FamilyResolver` bridge: the generic table, the
`LoadFontFamily` chain, the fallback rule, the memo. Its own module because
these are the substantive decisions of this issue and each is testable on its
own, while `htmlflow.ts` is otherwise wiring. It imports `Document` (for
`LoadFontFamily`) and `mdstyle.js`, so it is not a pure leaf and must not
pretend to be.

**`htmlflow.ts`** — `htmlElements` plus the option and result types. Imports
`cssflow.js` and `cssfont.js`. `mdflow.ts`'s counterpart, and like it, imported
by all three entry points so there is one implementation.

`flow.ts`, `page.ts` and `document.ts` gain one method each and nothing else.

## What this ships publicly

Exported from `index.ts`, mirroring Markdown's surface:

```ts
export { htmlElements } from './htmlflow.js';
export type {
  HtmlFlowOptions, HtmlFlowResult, HtmlElements, AddHtmlResult,
} from './htmlflow.js';
```

`htmlElements` is public for the reason `markdownElements` is: a caller
driving `placeElements` itself over their own rects has no other route.

Unlike `zch2.2`, `zch2.3` and `zch2.4`, this issue **earns a `CHANGELOG.md`
entry and a README update** — it is the first public API in the epic, and the
`Features` and `Limitations` sections both move.

## Testing

**The acceptance test the issue names:** render one source through all three
entry points and compare extracted text. That is what makes "three entry
points, one implementation" a fact rather than an aspiration.
`test/markdown-render.test.ts` already does exactly this for `AddMarkdown` —
"the three entry points agree", normalizing whitespace and comparing
`page.GetText()`, with `page.AddMarkdown` given the same 72pt content box a
default A4 flow uses. The HTML case is written against that shape, including
its companion `public surface` case, which asserts the package root exports
each function by name.

Beyond it, hand-built cases per rule, each **mutation-checked**: break the
path, confirm which cases redden, record any rule the suite cannot see in
`CLAUDE.md` rather than dropping it. The font bridge is tested against
registered fixture fonts (`test/fixtures/fonts/`) for the `LoadFontFamily`
half and against the Standard-14 names for the generic half.

### Mutations, named before the code

1. Return Helvetica for `serif` → the Times-by-default case reddens.
2. Ignore registered families, always use generics → the registered-family
   case reddens.
3. Drop the resolver memo → a COST rule; expected to redden nothing, and to be
   recorded as uncovered if so.
4. Pass `rect[3]` (height) where `rect[2]` (width) belongs in `page.AddHtml` →
   the rect-width case reddens.
5. Use the flow's `columnHeight` instead of `columnWidth` → the multi-column
   case reddens.
6. Drop the `<title>` default → the title case reddens; the explicit-`title`
   case stays green, which is what shows the two are separable.
7. Let an explicit `title` lose to `<title>` → the precedence case reddens.
8. Apply the `<title>` default in `flow.AddHtml` too → the
   "appending does not relabel the document" case reddens.
9. Zero the root box's margins → the body-margin case reddens.
10. Fall back to Times rather than Helvetica for an unresolvable named family
    → the no-generic case reddens.

`npm run typecheck` and `npm test` both green before the issue closes.

## The honest note this work carries forward

The three-entry-point equivalence test compares **extracted text**, not
geometry. It proves the three share a mapper; it says nothing about whether
the mapping is *right*, which is `zch2.4`'s question and is held there by
hand-built cases and mutations with no oracle at all.

Nothing in this issue narrows that gap. Tables, images and float placement all
still name themselves in `skipped` — `zch2.6` and `zch2.10` — so the first
document a user renders will report constructs it did not draw. That is the
intended state, and `zch2.7` is the issue that formalizes the reporting; but
it means "HTML to PDF" is usable rather than complete when this lands, and the
README must say which constructs are missing rather than implying otherwise.
