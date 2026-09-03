# Reporting unrenderable constructs — design

**Issue:** `zch2.7` — Report unrenderable constructs in `skipped`, and still
emit their text.

**Goal:** make the rule `svgdraw.ts` sets true for HTML rendering: an element
we cannot render fully names itself in the report and still contributes what
it has. Today eight constructs are silent, one of them loses text outright.

## Why this is not a small addition

The issue reads as "add a few `skipped.push` calls". It is not, and the
measurement is what settles it. Probed against a live build:

| Input | What happens today | Reported? |
|---|---|---|
| `<td>outer <table>…INNER…</table></td>` | **`INNER` is lost entirely** — the text is `"outer"` | only as `table-cell-blocks`, which names the wrong thing |
| `<iframe>fallback</iframe>` | renders `"fallback"` as body text; browsers render **nothing** | no |
| `<input value=v>` | **draws nothing at all** | no |
| `<select>`, `<textarea>`, `<button>` | option text and textarea content leak into the flow | no |
| inline `<svg><text>T</text><circle/></svg>` | `"T"` leaks as body text; the graphic draws nothing | no |
| `display: inline-block` | silently laid out as inline | no |
| `vertical-align` | silently ignored | no |
| inline padding on a `<span>` | silently ignored | no |
| `position: absolute` | laid out in flow | **yes** — `unknown-property` |

Three of those are silent because the property is *computed and never read*:
`verticalAlign`, `paddingLeft`/`paddingRight` in the inline path, and
`inline-block` have **zero** consumers outside `cssprop.ts`'s table and the UA
sheet. They are silent by omission rather than by decision.

`position: absolute` is the one that works, and it works by accident: it is
not among the 43 longhands, so the cascade reports it as an unknown property.
Anything we *do* model and then ignore gets no such backstop.

## Decisions

Four were taken during brainstorming and are recorded here as decisions, not
options.

**1. `skipped` becomes a structured list rather than gaining a sibling.** A
string cannot say which element, why, or the difference between *dropped* and
*degraded*. The string form stays derivable via `describe()`. This is a
breaking change to a public field; nothing is published or tagged yet
(`package.json` is `0.1.0`), so this is the moment to take it.

**2. The leak policy is per element, by what the content MEANS.** HTML already
draws the distinction and we follow it rather than inventing a uniform rule:
`<object>`, `<video>`, `<audio>` and `<canvas>` children **are** fallback
content a browser renders when the thing cannot load, so they are kept;
`<iframe>` children are, in the spec's words, "ignored by conforming user
agents", so emitting them is a divergence and they are suppressed. A uniform
"never lose words" rule would render text no browser shows; a uniform
"suppress everything" rule would blank a page whose content sits in `<object>`
fallback, contradicting the epic's own rule.

**3. Inline `<svg>` is suppressed and reported, not rendered.** The importer
exists (`page.AddSVGObject`), and an injected `renderSvg` would mirror
`zch2.6`'s injected `resolveImage` one for one — but it pulls `svgembed.ts`,
intrinsic sizing from `width`/`height`/`viewBox`, and `svgdraw.ts`'s own
`skipped`/`rasterized` lists into this issue. Filed as `zch2.12`, which
depends on this one for the report vocabulary.

**4. Markdown keeps `skipped: string[]`.** `NotRendered.el` is an
`HtmlElement` and Markdown has `MdNode`; a shared type would carry a field
that is always `undefined` for half its callers, and a generic in the public
surface buys a field most callers only log. Markdown is `gl6o`'s epic.
**The asymmetry is deliberate — do not "fix" it.**

## Architecture

A new pure leaf, `src/htmlreport.ts`, over `htmldom.js` alone.

```ts
export interface NotRendered {
  /** null for a construct belonging to no element — an anonymous box. */
  el: HtmlElement | null;
  kind: 'dropped' | 'degraded';
  construct: string;
  /** The src, the property name, the declined value. */
  detail?: string;
}

/** The string form, for a caller that only logs. */
export function describe(r: NotRendered): string;

/** Whether an element's children reach the flow. `undefined` for an element
 *  the table does not name, whose caller default is `render`. */
export function contentPolicy(el: HtmlElement): 'render' | 'suppress' | undefined;
```

**Invariant: a pure leaf that never throws.** It imports `htmldom.js` for
types and nothing else — no `Document`, no PDF object module, no `node:`
import, and none of the four modules that consume it.

**Invariant: it is `html*` rather than `css*` despite the CSS stack being its
only consumer.** It is keyed on HTML element names and encodes HTML's own
content models; it sits beside `htmllang.ts`, the existing precedent for an
HTML fact as a pure leaf. Naming it `cssreport.ts` would say the policy is a
CSS one, and the next person would look for it in the cascade.

**Why a module of its own rather than a section of `cssprop.ts`:** two
consumers need the policy and neither may import the other. `cssbox.ts` must
not descend into an `<iframe>` when generating boxes, and `cssinline.ts` has
its own separate `visit` walk that must not either. That is the same forcing
argument behind `colornames.ts`, `preformat.ts` and `bordersides.ts`.

**Only two kinds.** A third, `leaked`, was considered and dropped: once the
per-element policy is in place nothing leaks knowingly, so no site could
produce one, and a kind nobody emits is a case every consumer switches on for
nothing.

## Data flow

The report threads exactly as `unsupported` already does, and for the same
reason — both are lists a pure leaf may append to without knowing who reads
them.

```
computeStyles ──unsupported──┐
                             │
buildBoxes ──boxes, report───┼──> lowerHtml ──> CssFlowResult
   ├── cssbox.ts    (suppression, inline-block)
   └── cssinline.ts (vertical-align, inline padding, fragment href)
                             │
mapSiblings ──report─────────┘
   ├── cssflow.ts   (float, image, input value)
   └── csstable.ts  (nested table, cell blocks)
```

`buildBoxes` returns `{ boxes, unsupported, report }`; `lowerHtml` puts that
same array into `Ctx`, so the flow phase appends to it. One array, no merge
step that could reorder or lose a record.

**Ordering is by PHASE, then document order within a phase.** Box building and
lowering each walk the whole tree, so a box-phase record precedes every
flow-phase record regardless of source position. Today's `skipped` documents
one global document order and `test/cssflow-report.test.ts` asserts it; that
test survives, because all three of its records are flow-phase. A true global
order would need a preorder index on every element carried on every record —
cheap during `computeStyles`'s existing walk, but a guarantee no caller has
asked for. **Recorded as a decision so it is not read as an oversight**, and
the retrofit is named here in case one is ever wanted.

## The inventory

This table *is* the feature. Every row is a case in the sweep test.

| Construct | Change | Kind | Owner |
|---|---|---|---|
| nested `<table>` in a cell | flatten its cells' text into the outer cell | `degraded` | `csstable.ts` |
| `<iframe>` children | suppress | `dropped` | `htmlreport.ts` policy |
| inline `<svg>` / `<math>` | suppress | `dropped` | `htmlreport.ts` policy |
| `<object>`/`<video>`/`<audio>`/`<canvas>` children | keep — real fallback content | `degraded` | `htmlreport.ts` policy |
| `<input value=v>` | **draw the value as text** — but see the two refusals below | `degraded` | `cssinline.ts` |
| `<select>` | keep the SELECTED option's text only | `degraded` | `cssinline.ts` |
| `<textarea>`/`<button>` | keep the text | `degraded` | `htmlreport.ts` policy |
| `display: inline-block` | unchanged (laid out as inline) | `degraded` | `cssbox.ts` |
| `vertical-align` | unchanged (ignored) | `degraded` | `cssinline.ts` |
| inline padding / margin | unchanged (ignored) | `degraded` | `cssinline.ts` |
| `float: left`/`right` | unchanged | `degraded` | `cssflow.ts` |
| image sharing a line with text | unchanged | `dropped` | `cssflow.ts` |
| image the resolver declines | unchanged | `dropped` | `cssflow.ts` |
| cell holding block content | unchanged | `degraded` | `csstable.ts` |
| fragment-only `href` | **moves off `unsupported`** | `degraded` | `cssinline.ts` |

**The nested table is a regression, not a gap.** `csstable.ts`'s `collectBox`
returns early for `kind === 'table'`, so a table inside a cell contributes
nothing at all. It shipped in `zch2.6` and violates this issue's own rule. A
cell takes `string | TextRun[]`, so the inner table cannot be a table — its
cell texts flatten into the outer cell, separated as `flattenRuns` already
separates sibling blocks.

**Two refusals on `<input>`, and the second is forced by an existing
invariant.** `type=hidden` draws nothing — it is hidden by definition, and
drawing it would put content on the page that no browser shows. `type=password`
draws nothing either: `CLAUDE.md` records, under `formfield.ts`, that "a
password field's value must never reach a content stream", because flattening
bakes the plaintext into permanent page content where no viewer will ever mask
it again. That rule was written for AcroForm fields and applies verbatim here —
an HTML password value reaching a content stream is the same disclosure by a
different route. Both are reported `dropped`, not `degraded`: nothing is drawn.

**`<select>` keeps only the selected option.** A browser draws the closed
control showing one option, so emitting every option's text turns a
three-choice dropdown into three lines of body text — a plausible-looking
document that says something the source does not. The selected option is the
one carrying `selected`, else the first; `choiceopt.ts` already owns that rule
for the PDF direction and is the precedent, though it shares no code (it reads
`/Opt`, not a DOM).

**The fragment href moves by invitation.** `zch2.6` parked it on `unsupported`
as `unparsable-value` and recorded in `cssinline.ts` that "`zch2.7` can widen
it if it wants to". A link we declined to make is a construct we did not
render, not a declaration we could not parse.

**Two rows change what the PDF contains** — `<input value>` starts drawing,
`<iframe>` and inline `<svg>` stop. Every other row is report-only.

## Error handling

Nothing here throws, and nothing guesses.

- `contentPolicy` returns `undefined` for an element it does not name, and the
  caller's default is `render`. An unknown or custom element (`<my-widget>`)
  keeps its children and earns no record — which is what a browser does, so it
  is correct rather than a gap.
- A construct the table does not name is **not** reported. A record a caller
  cannot act on is noise, and noise is what makes a report stop being read.
- Suppression removes a subtree from the box tree; it does not mark it hidden.
  A suppressed subtree must not reach `zch2.4`, must not consume a margin and
  must not take part in margin collapsing — the rule `display: none` already
  follows in `cssbox.ts`.

## Testing

**There is no oracle, and that is inherited rather than new.** `zch2.3`'s
headless-Chrome corpus measures used widths and collapsed gaps; a browser has
no opinion about a list of things we failed to draw, and `getComputedStyle`
cannot see which builder a box went through. Every rule here is held by a
hand-built case and a mutation, as `zch2.4` and `zch2.6` are.

Three things done deliberately:

- **A sweep over the whole inventory**, one case per row, asserting the
  construct *and* the kind — the shape `test/flow-tagging.test.ts` uses so a
  construct cannot be silently forgotten.
- **The construct vocabulary is asserted by SIZE**, so a half-filled policy
  table is a red build rather than a silently unreported element.
  `htmlforeign.ts`'s pattern with its five asserted table sizes.
- **Suppression is asserted POSITIVELY.** `expect(text).not.toContain('fb')`
  also passes when the whole document failed to render, so each suppression
  case asserts the surrounding text IS present and the record exists. The
  `<object>` row asserts the exact opposite on the same shape, which is what
  keeps "suppress" and "keep" from collapsing into one rule.

**Fences.** `html-identity`, `rich-runs-identity` and `docx-flow-identity`
must not move. Measured: no existing test in the repo renders an `<iframe>`,
an inline `<svg>` or a form control through `AddHtml` — the only `<svg>` uses
in the CSS stack are in `cssselect-*`, which match the DOM rather than boxes,
and `html-forms`/`html`/`html-raster-backdrop` are `ToHtml`, the opposite
direction. `test/cssflow-report.test.ts` moves wholesale, since it asserts the
string shape this issue replaces.

**Mutation sweep**, as every issue in this epic has run: every rule proved
load-bearing, and anything that reddens nothing recorded in `CLAUDE.md` as
uncovered rather than quietly kept.

## Out of scope, each tracked

- **Rendering inline SVG** — decision 3 above; `zch2.12`.
- **Rendering form controls as real widgets.** `htmlforms.ts` converts a PDF
  widget to HTML, the opposite direction; authoring an AcroForm field from
  HTML is a feature, not a report.
- **`inline-block`, `vertical-align` and inline padding as rendering.** This
  issue makes them reportable; making them work is layout, and the first two
  need `zch2.11`'s inline-atomic machinery.
- **Float placement** — `zch2.10`.
- **Markdown's report shape** — decision 4 above.
