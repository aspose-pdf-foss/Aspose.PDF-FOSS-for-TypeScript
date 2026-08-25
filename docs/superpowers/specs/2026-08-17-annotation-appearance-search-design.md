# Annotation appearance-text search (c3t7.6)

Search the text an annotation *draws* — a `/FreeText`'s visible words, a filled
form field's value — which `searchText` cannot see because `visitContent` walks
page content streams only.

## The prior question, settled

"Annotation text" names two different features:

- **(a) the `/Contents` string** — a note's body. Not drawn, so it has no glyphs
  and no geometry beyond the annotation's `/Rect`. Already reachable today as
  `Annotation.Contents` off `page.Annotations`.
- **(b) the text drawn inside an `/AP` appearance stream.** These are real
  glyphs with real geometry; `pagerender.ts`'s `interpret` composites them,
  which is how `ToImage`/`ToSvg`/`htmlfixed` get them.

**This issue ships (b).** It is the half that is real work and that a caller
cannot write for themselves. (a) is filed as a follow-up and argued on its own
merits.

## What the issue feared, and why (b) defuses it

The issue warned that an annotation match reaching `redactText` would "burn a
box over that whole area of the page, covering content that may be innocent".
That is true of reading (a), whose only geometry is the `/Rect`. Reading (b)
returns glyph boxes, which are tight.

It also holds — measured by reading `redactannots.ts:72` — that redaction
already deletes any annotation whose `/Rect` *intersects* a redaction rect, via
`removeCoveredAnnotations`. So redacting a `(b)` quad removes the annotation
whole. That is the honest answer rather than a defect: partial removal would
require content surgery on the `/AP` stream, and `EditableContent` cannot
address one.

## Shape

A separate entry point. `TextMatch` and all four of `searchText`'s consumers
(`Page.Search`, `replaceText`, `redactText`, `markRedactText`) are untouched and
byte-identical.

```ts
/** A match in the text an annotation's appearance stream draws. */
export interface AnnotationMatch {
  /** The annotation whose appearance drew the matched text. */
  annot: Annotation;
  /** The matched substring of that annotation's assembled appearance text. */
  text: string;
  /** Page-space boxes [x0,y0,x1,y1], one per line the match spans. */
  quads: Rect[];
}

export function searchAnnotations(
  doc: Document, page: Page, find: string | RegExp, opts?: SearchOptions,
): AnnotationMatch[];
```

Surfaced as `Page.SearchAnnotations(find, options?)`, and exported from
`index.ts` alongside the type.

`SearchOptions` is reused rather than duplicated, so `region` scopes annotation
search by the same centroid rule `searchText` and `extractTables` use — two
features answering "is this inside the region" differently is how a search and a
table extraction come to disagree about one page.

### Why no `hits: GlyphEvent[]`

`TextMatch.hits` exists for op provenance, and an `/AP` stream has none that
`ContentAddr` can express: its `path` is a chain of XObject resource names
descended from the page, and an appearance stream is reached through `/Annots`,
not `/Resources`. A fabricated path does not degrade quietly — it throws
`XObject /X not found` inside `EditableContent.cowXObject`.

So `ContentAddr` is left unchanged and `AnnotationMatch` carries no
`GlyphEvent`. If appearance-stream *replace* is ever wanted, it needs a new
address kind and is a new issue.

## Redacting annotation text

Reachable without touching redaction code:

```ts
const hits = page.SearchAnnotations('secret');
page.Redact(hits.flatMap(m => m.quads));
```

`RedactText`/`MarkRedactText` gain no annotation flag in this issue. Adding one
is a deliberate change to the most safety-critical code in the repo and would
need its own argument for what "redact this annotation's text" means when the
only available granularity is the whole annotation.

## The walk

`text.ts` gains one export, consumed only by `annotsearch.ts` and **not**
re-exported from `index.ts`. It knows nothing about annotations:

```ts
export function visitFormContent(
  doc: Document, stream: PdfStream, fallbackResources: PdfDict | undefined,
  base: Matrix, visitor: ContentVisitor,
): void;
```

**It must not be `visitAnnotationAppearance`.** `annotappearance.ts`
value-imports `placementMatrix` from `text.ts`, so a `text.ts` that imports
`isAnnotVisible`/`resolveAppearance` back closes a cycle. Annotation knowledge
therefore stays in `annotsearch.ts`, and `text.ts` keeps only the neutral
primitive — which is the split it already makes everywhere else.

`visitFormContent` walks one Form XObject exactly as `walkScope`'s own `Do`
case does, so `base` is what a `cm` would have been:

- `ctm = mul(stream /Matrix, base)`
- `resources = stream /Resources ?? fallbackResources`

A second placement rule is how a form comes to be measured in one place and
drawn in another, so the `Do` semantics are reused rather than restated.

`annotsearch.ts` then supplies the annotation half: `isAnnotVisible` then
`resolveAppearance`, passing `ap.place` as `base` and `page.Resources` as the
fallback. `ap.place` already maps the `/Matrix`-transformed `/BBox` onto
`/Rect` (32000-1 §12.5.5), so `visitFormContent` re-applying `/Matrix` is not a
double-apply — the same note `pagerender.ts`'s `drawAnnots` carries. Using
`isAnnotVisible`/`resolveAppearance` rather than reading `/AP` directly is what
makes search agree with `ToImage`, `ToSvg` and `flatten.ts` about exactly which
annotations draw.

`visitContent` walks in page space (base `IDENTITY`) and `/Rect` is in page
space, so the emitted quads are directly comparable with `searchText`'s and
with `region`.

**Invariant: no `GlyphEvent` from this walk escapes `annotsearch.ts`.**
`GlyphEvent.addr` has no honest value on an appearance stream — it is left as
`{ path: [], streamIndex: 0 }`, which names the page's first content stream and
is a lie any consumer would act on. `AnnotationMatch` deliberately carries none,
and neither `visitFormContent` nor `searchAnnotations`' internals are reachable
from `index.ts` in a way that hands one out. Recorded at both ends.

`findRanges` and `buildMatch` are exported from `textedit.ts` and shared, so
the RegExp always-global rule and the per-line quad union each have one owner.
`annotsearch.ts` takes `buildMatch`'s result and drops its `hits` at that
boundary — the single point where a `GlyphEvent` stops travelling.

## Assembly

**Invariant: one `layoutLines` assembly per annotation, never one for the
page.** `layoutLines` groups runs by Y and orders them by X, so a note drawn
over a paragraph shares its Y band. A single assembly would interleave the
note's words into the paragraph's line, and a query spanning a page word and an
annotation word would match across the two — a phantom match, not a feature.
The same rule excludes matches spanning two annotations.

Results come back in `/Annots` order, reading order within each annotation.

Each annotation gets its own `try`/`catch`, mirroring `drawAnnots`: a malformed
appearance costs only itself and does not drop the annotations after it.

An annotation with no usable `/AP` yields nothing, since `resolveAppearance`
returns `undefined`. A `/Redact` mark needs no special case: its appearance
outlines the quads and fills nothing, so it draws no glyphs.

## Module placement

New module `src/annotsearch.ts`. `textedit.ts` is content-stream search and
edit; this is `/Annots` object-graph work that happens to end in a search — the
same split `redactannots.ts` makes against `redact.ts`. It also holds
`textedit.ts` free of a dependency on `annotation.ts`, the way `runlink.ts`
holds `stamp.ts`'s dependency on that module to one symbol.

Verified no cycle: `annotation.ts`'s value imports reach `appearance.ts`,
`flatten.ts`, `formremove.ts`, `structwrite.ts`, `outline.ts`, `actions.ts`,
`ocg.ts` and `imageembed.ts`, none of which import `textedit.ts` or
`annotsearch.ts`.

## Tests

`test/annot-search.test.ts` over a new `test/helpers/build-annot-text-pdf.ts`
building one page carrying: page content text; a `/FreeText` whose `/AP` draws
known words; a filled widget; a hidden annotation; a `/Popup`; and one
annotation with a deliberately malformed appearance.

- Text drawn **only** inside an `/AP` is found by `SearchAnnotations`.
- Both directions of the split: page text is not returned by
  `SearchAnnotations`, and `/AP` text is still not returned by `Search`.
- Quads are glyph boxes — inside the `/Rect` and asserted strictly **smaller**
  than it, not merely contained. Containment alone passes for a `/Rect`-sized
  quad, which is the shape this design exists to avoid.
- **Interleaving.** An annotation positioned so its appearance text shares a Y
  band with page text; a query spanning a page word and an annotation word
  matches nothing, from either entry point. This is the test that pins the
  per-annotation assembly, and it will be proved load-bearing by collapsing the
  code to a shared assembly and confirming it goes red.
- An `/AP` stream with a non-identity `/Matrix` places its quads correctly.
- Hidden, NoView and `/Popup` annotations are skipped.
- A malformed appearance does not drop the annotations after it.
- `region` filters appearance glyphs by centroid, with the in-region prefix
  still matching — the companion assertion `test/search-region.test.ts` already
  uses to prove the glyphs were not simply all excluded.

`npm run typecheck` and the full suite are the fence for the claim that
`searchText` and its four consumers are untouched.

## Documentation

- `README.md` API overview: `Page.SearchAnnotations`.
- `CLAUDE.md`: an `annotsearch.ts` entry carrying the two invariants — no
  `GlyphEvent` escapes, and one assembly per annotation.
- A follow-up bd issue for reading (a), `/Contents` search.

## Out of scope

- Region scoping of `searchText` (c3t7.2, closed).
- Replacing text inside an appearance stream.
- An annotation flag on `RedactText`/`MarkRedactText`.
- Reading (a), `/Contents` search.
