# Reporting text the resolved face cannot draw — design

**Issue:** `zch2.14` — text dropped for want of a glyph is lost silently, not
reported.

**Goal:** a caller who renders `При` with no registered font folder learns that
it did not draw. Today they get a blank page, an empty `skipped` and no reason.

## What the issue got right, and what it got wrong

**Right, and it is the whole motivation.** The loss is silent on every entry
point. Measured on a live build:

| call | `skipped` | page text |
|---|---|---|
| `AddMarkdown('При\n\nkept')` | `[]` | `"kept"` |
| `AddHtml('<p>При</p><p>kept</p>')` | `[]` | `"kept"` |
| `AddHtml('<p>alpha При omega</p>')` | `[]` | `"alpha  omega"` |

The third row is the failure that matters most: the page looks perfectly fine
and a word is gone.

**Right — the signal already exists.** `FontDriver.probe` was added for exactly
this question, and `stamp.ts` already computes the all-or-nothing answer in five
places (`nothingDrawable`, and four `driver.probe(text) === 0` early returns at
lines 1030, 1041, 1084 and 1109). They return empty instead of saying so.

**Wrong — this is not new ground.** The issue treated reporting as an open
question. The SVG importer has answered it since `svgdraw.ts:1514`:

```js
// Nothing drawn from characters that existed means the face could encode
// none of them: ink that should exist does not, so it is reported.
if (!drew && flat.chars.length > 0) t.skipped.add('text');
```

README documents it as a guarantee. HTML is the outlier, not the pioneer, so
this work matches an existing rule rather than inventing one — including the
construct NAME, `'text'`.

**Wrong — "`probe` is where the information is".** `probe` is the right
primitive for the all-or-nothing case and the WRONG one for the partial case.
The shaped driver's `probe` counts GLYPHS (`stamp.ts:607`), and Arabic
ligatures legitimately produce fewer glyphs than characters, so a count
comparison reports loss where the shaper did its job. The partial rule needs
the per-CHARACTER predicate underneath: `encodeWinAnsi(ch).length > 0` for a
Standard-14 face, `sfnt.cmapLookup(cp) !== undefined` for an embedded one.

**Not named, and it is the constraint that shaped the whole design.** The HTML
and Markdown reports are handed back at BUILD time; the text is dropped at
PAINT time.

```js
const r = flow.AddHtml(src);   // r.skipped returned HERE
flow.Render();                 // text is drawn — or silently isn't — HERE
```

A paint-time detector can never reach `AddHtml().skipped`. Detection therefore
has to happen where the runs are built, which is possible because `TextRun.font`
is already an `AuthoringFont` by then.

## Decisions

1. **Scope: HTML, Markdown and a Flow/page channel.** All three lose text and
   the first two already promise a report.
2. **Granularity: both cases, discriminated.** Nothing drew is `dropped`; some
   characters vanished is `degraded`. `zch2.7` built `NotRendered.kind` for
   exactly this distinction and nothing else in the epic uses it this cleanly.
3. **The Flow/page channel is an opt-in sink**, not a return-type change. Every
   `Flow.Add*` returns `this` for chaining, `Render()` returns `Page[]`,
   `AddText` returns `void` and `AddTextBlock` returns the remainder — there is
   no room anywhere, and a breaking change to three of the most-used methods in
   the library buys nothing a callback does not.
4. **Detection lives in the shared builders.** `cssflow.ts` and `mdflow.ts` both
   import `paragraph`, `heading`, `list` and `image` from `flow.js`, and
   `Flow.AddParagraph` IS `paragraph()`. CLAUDE.md's "ONE builder per construct"
   rule means one detection site serves all three producers.

## Architecture

### `textcoverage.ts` — a new pure leaf

One owner for "what of this text can this face not draw". It imports
`encoding.js`, `metrics.js` and `embeddedfont.js` for the two per-character
predicates and nothing else — no `Document`, no `Page`, no `stamp.js` — so
every rule is testable from a string and a font with no PDF built. It never
throws.

```ts
export interface Undrawable {
  /** The DISTINCT characters that will not draw, in first-appearance order.
   *  Distinct rather than every occurrence: a page of Cyrillic would otherwise
   *  put the whole page in a report field. Capped; the cap is the plan's. */
  lost: string;
  /** True when NOTHING drew: the block is blank, not merely thinner. */
  all: boolean;
}

export function coverageOf(
  content: FlowText, blockFont: AuthoringFont, shaped: boolean,
): Undrawable | undefined;
```

`undefined` means fully drawable — the common case and the cheap path.

**`content` is a `FlowText`, so it may be `TextRun[]`, and a run carries its
own `font`.** Each run is judged against its own face, falling back to
`blockFont` where the run states none — which is the rule `resolveRuns` already
applies, and a second rule here would let a run be reported against a face it is
not drawn in. `all` is therefore "no run drew anything", not "the first run
drew nothing".

**Invariant:** `stamp.ts`'s five existing all-or-nothing checks route through
this leaf. That is what makes "the painter and the reporter agree" structural
rather than aspirational, and it is the recurring two-answers-to-one-question
defect this repo keeps recording.

**Invariant:** the leaf takes the font, never a `FontDriver`. Driver selection
(`driverFor` / `effectiveShape` / `shapedDriver`) stays in `stamp.ts`, which
exports the rule so the builders pick the same face the painter will. A block
whose font is a default resolved later must go through `normalizeBlockOptions`,
or the reporter judges a different face than the painter draws.

### The sink

`FlowParagraphOptions` and the other builder option bags, plus
`TextBlockOptions` and `StampOptions`, gain:

```ts
onUndrawable?: (u: Undrawable) => void;
```

It carries the leaf's own vocabulary and nothing HTML-shaped: the flow layer
must not import `htmlreport.ts`, and a hand-built caller has no `HtmlElement`
to be told about.

**Invariant:** `onUndrawable` is CONSUMED by whoever detects and is never
forwarded. The builder detects, then `flowTextBlock` paints through
`TextBlockOptions` and would fire a second time for the same block.
`paragraphOptions()` (flow.ts:253) copies an explicit whitelist of fields
rather than spreading, so this holds by construction — but it holds only as
long as that stays a whitelist.

**Invariant:** the sink fires from the builders (build time) and from
`stampText` / `stampTextBlock`, where the call IS the paint. It must NEVER fire
from `measureTextBlock` or `measureFlowText`, which the engine runs
speculatively many times per element.

### The three presentations

**Flow and page** get the raw `Undrawable`.

**HTML** gains a 20th construct. `Construct` gains `'text'`; `CONSTRUCTS` goes
19 to 20. `cssflow.ts` passes each builder a sink closing over that box's
element:

- nothing drew → `{ el, construct: 'text', kind: 'dropped', detail: lost }`
- some drew → the same record with `kind: 'degraded'`

Blame is at BLOCK granularity: a builder sees the `<p>`, not the `<span>`
inside it. That is the accepted cost of one detection site, and `detail`
carries the actionable half — which characters were lost.

The records land in the LOWERING phase, where `cssflow.ts` already runs, so the
documented phase-then-document-order rule holds unchanged.

**Markdown** gets two flat strings: `'text'` when nothing drew, `'text:partial'`
when characters were lost. `MarkdownResult.skipped` stays `string[]`, which
`zch2.7` kept flat on purpose. The two vocabularies are already disjoint —
`html_block` and `html_inline` exist in no `Construct` union — so this borrows
no HTML shape.

## The partial rule

Per character, through each driver's own predicate, never a glyph count. Two
exclusions, both required or the feature is noise rather than signal.

**Layout structure — `\n`, `\r`, `\t`.** Measured:

| input | codepoints | `probe` | |
|---|---|---|---|
| `"a\nb"` | 3 | 2 | would report |
| `"a\tb"` | 3 | 2 | would report |
| `"“curly”"` | 7 | 7 | fine |
| `"e" + U+0301` | 2 | 1 | GENUINE loss |
| `"alpha При omega"` | 15 | 12 | GENUINE loss |

Those three encode to nothing because they are layout structure rather than
ink. Without the exclusion every code block and every hard-broken paragraph in
every document carries a `degraded` record.

**A shaped block gets the all-or-nothing rule only.** A shaper legitimately
consumes joiners and format characters (ZWJ, ZWNJ, the bidi marks), so a
per-character scan reports loss where nothing was lost. Same instinct as the
existing "shaping stays single-run and throws with a run list" refusal.

The excluded set is small, explicit and asserted, so it cannot quietly grow
into "ignore anything inconvenient".

## Cost

The all-or-nothing check runs always — `stamp.ts` does it today, so that is a
redirect and not new work. **The partial scan runs only when a sink is
installed**, so a caller who asks for nothing pays one existing check per block
and no scan at all.

## Failure handling

The leaf never throws. A sink that throws PROPAGATES, matching `resolveImage`'s
documented rule that a throw from a caller's own callback is the caller's bug
rather than a missing resource. An unresolvable family is already reported
elsewhere and is not re-reported here.

## Known gap: table cells

**A table cell's text does not go through the shared builders.** `csstable.ts`
and `mdflow.ts` build cells with `TableBuilder.addCell`, and `tableauthor.ts`
measures and paints them through its own driver wrapper (`tableauthor.ts:202`,
which already carries `probe`). So a table full of Cyrillic stays silent under
this design as written.

Two ways to close it, and the choice belongs to whoever writes the plan:

- **In scope.** `addCell` gains the same `onUndrawable` and calls the same leaf.
  The wrapper already holds a driver, so this is small — but it widens the work
  to `tableauthor.ts` and `flowtable.ts`, which the three producers share with
  `page.AddTable`, a fourth caller with no report channel of its own.
- **Its own issue.** Ship the block path, and record the cell gap in CLAUDE.md
  and the README limitation so it is a stated boundary rather than a surprise.

Recommendation: **in scope**, because "a table full of Cyrillic is silent" is
the same defect this issue exists to close and shipping half of it invites a
re-file. `page.AddTable` gets the raw sink like any other page-level caller.

## Explicit non-goal

**No fallback face substitution.** We report that Times cannot draw `При`; we
do not go looking for a face that can. That is a much larger feature, and it
would change what documents RENDER rather than only what they say about
themselves.

## Testing

- `test/textcoverage.test.ts` — pure, from strings and fonts, no PDF built. The
  measured table above becomes the assertions, including `\n` and `\t` NOT
  reporting and a combining acute DOING so.
- A report test across all three entry points, mirroring
  `html-render.test.ts`'s existing "the three entry points agree" case: one
  source, the same records.
- **Fences that must not move:** `rich-runs-identity`, `html-identity`,
  `docx-flow-identity`, `markdown-export`. A document with no undrawable text
  must stay byte-identical, because the sink emits no operators. A red one
  there is information, not a chore.
- The vocabulary fence is already written: `htmlreport.test.ts:29` pins
  `CONSTRUCTS.length` and `htmlreport-render.test.ts:202` asserts every
  construct has a render case, so a half-landed vocabulary is a red build.
- Every new rule gets a mutation check. Anything that reddens nothing is
  RECORDED as uncovered rather than quietly kept.

## Module list

`textcoverage.ts` earns its CLAUDE.md entry when it lands, per the module-list
rule — not when someone next happens to touch the area.
