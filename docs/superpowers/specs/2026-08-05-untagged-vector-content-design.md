# Untagged vector content is detected, and our producers can conform

Closes `hdsx`. `structvalidate.ts`'s `UntaggedContent` rule walks glyph and image
events only, so vector content drawn straight into a page is never flagged
however untagged it is.

## What is actually broken

`ContentVisitor` already declares `path?(e: PathEvent): void`, so the walker
surfaces path events. But `PathEvent` carries **no `mcid` and no `artifact`**,
unlike `GlyphEvent` and `ImageEvent` — so the rule could not subscribe even if it
wanted to. There is nothing to test.

`flushPath` is a closure inside `walkScope` with `activeMcid` and `inArtifact`
already in scope, so populating the event is contained.

## Blast radius, measured

Instrumenting the walker and running each producer through it:

| Producer | untagged paths | fires `UntaggedContent` **today** |
|---|---|---|
| `PageGraphics` fill | 1 | no |
| `AddBarcode` | 1 | no |
| `AddSVGObject` | 2 | no |
| `AddTable` (borders) | 1 | **yes** — via its untagged cell *text* |
| `AddWatermark` | 0 | **yes** — via its untagged text |
| `AddHeaderFooter` | 0 | no |
| `AddSquare` annotation `/AP` | 0 | no |
| Redaction marker box *(control)* | 0 (1 artifact) | no |

Three findings shaped this design:

- **Only three producers gain a new report**: `PageGraphics`, `AddBarcode`,
  `AddSVGObject`. Watermarks and header/footer draw text, not paths. Annotation
  `/AP` forms are not page content, so the walker never reaches them.
- **`AddTable` already fires**, for a reason unrelated to paths: its cell text is
  untagged. Artifacting its borders would not silence it. What it needs is tagged
  table authoring, which is a feature, not this fix — filed separately.
- The redaction marker box reads as `artifact`, confirming both that the
  instrumentation was correct and that `nmjf`'s wrapping works.

## The walker and the rule

`PathEvent` gains:

```ts
  /** The innermost active marked-content MCID when this path was painted,
   *  or undefined outside any MCID-bearing marked-content sequence. */
  mcid?: number;
  /** True when this path was painted inside an /Artifact marked-content scope. */
  artifact?: boolean;
```

populated in `flushPath` exactly as `emitGlyphs` and `emitImage` already do.

`UntaggedContent` then subscribes a `path` callback identical to its glyph and
image ones. Its message becomes "Page has visible content (text, image or vector)
that is neither tagged nor marked as an artifact" — "text or image" is about to
be wrong. Severity stays `warning`.

## Marking options for barcode and SVG

Both gain the same three-way vocabulary, resolved in this precedence:

| Option | Effect |
|---|---|
| `tag?: StructElement` | Tag into the caller's own element (`AddBarcode` has this today; `AddSVGObject` gains it) |
| `alt?: string` | Create a `/Figure` carrying that `/Alt` and tag into it |
| `artifact?: boolean` | Wrap as `/Artifact BMC … EMC` |
| none of them | Unchanged output — untagged, and the validator now reports it |

**The default is deliberately "nothing".** Only the caller knows whether a
graphic is meaningful or decorative. Artifacting by default would declare a
barcode decorative and hide the data it encodes from assistive technology — the
same trap rejected for the redaction overlay text in `nmjf`. Auto-tagging as a
`/Figure` without an `/Alt` would merely trade `UntaggedContent` for
`IllustrationAlt`, leaving the document failing and the caller with the same work
to do, while silently mutating a structure tree nobody asked it to touch.

Emitting nothing keeps every existing caller's output byte-identical and makes
the new warning accurate rather than a false negative.

`tag` and `alt` are not contradictory — `alt` is the ergonomic shorthand for
"make me a `/Figure`", and `tag` says which element to use. When both are given,
**`tag` wins and `alt` is ignored**: the caller supplied a specific element, and
quietly re-parenting their content under a fresh `/Figure` would be the more
surprising reading.

`artifact: true` combined with `tag` or `alt` throws `TypeError`. Those *are*
contradictory claims about the same content, and silently honouring one would
hide the caller's mistake.

The `/Figure` that `alt` creates attaches under `root.Children[0]` when the root
has a child — the `/Document` element `AutoTag` and `CreateStructTree` produce —
and under the root otherwise. The same placement `nmjf` established for the
redaction `/P`.

`barcodeplace.ts` already ends with the exact
`wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)`
pattern, so the new options slot in beside it rather than replacing anything.

### Why SVG gets `tag` as well

Not for symmetry with the barcode. Without it, `alt` can only auto-place the
`/Figure` at the top of the tree, which is wrong for any document with real
sectioning. The barcode's existing `tag` option is the precedent that callers
need to choose the parent.

## PageGraphics

No code change. It is the low-level authoring primitive, and the caller already
has `BeginArtifact()` and `BeginMarkedContent()`. A new warning for direct
`PageGraphics` use is correct and actionable; the README says so where it
documents the class.

## Errors

| Case | Behaviour |
|---|---|
| `artifact: true` with `tag` or `alt` | `TypeError`; nothing drawn, nothing allocated |
| `alt` that is not a string | `TypeError`; nothing drawn |
| `alt` on an untagged document | The `/Figure` cannot be created — `doc.GetStructTree()` is null, so the drawing is emitted unmarked, as if no option were given. No throw: a caller passing `alt` to an untagged document has made a harmless request we cannot honour, and failing the draw would be worse than ignoring the hint. |
| `artifact: true` on an untagged document | Honoured — `/Artifact BMC … EMC` is valid in any document and needs no structure tree. This is deliberately *not* symmetric with `alt`: `alt` cannot be honoured without a tree, whereas `artifact` can, and the caller asked for it explicitly. |

## Testing

1. `PathEvent` carries `mcid` inside a `BDC` scope and `artifact` inside a `BMC`
   scope — asserted directly against `visitContent`, since that is the new
   contract the rule depends on.
2. `UntaggedContent` fires for an untagged `PageGraphics` fill on a tagged page,
   and is silent when the same fill is wrapped in `BeginArtifact()`.
3. Barcode: each of the four option cases, asserting both the emitted content
   stream and the resulting `ValidatePdfUa` issue set.
4. SVG: the same four cases.
5. `artifact` combined with `alt` throws and leaves the document unchanged.
6. `alt` on an untagged document draws unmarked and does not throw.
7. The redaction marker box still reads as an artifact — a regression guard on
   `nmjf`, and the one producer already doing this correctly.
8. The full suite. The probe sampled eight producers; the suite covers far more
   fixtures, and this rule change can surface a producer nobody enumerated.

Assertion 8 is the one that matters most here. A rule that reports more will
change results for fixtures across the whole suite, and the sampling in this
document is evidence, not proof.

## Filed separately

Tagged table authoring — `/Table` → `/TR` → `/TD` with borders and backgrounds as
artifacts — which is what `AddTable` actually needs. It is a feature comparable
to `flow.ts`'s `{ tagged: true }` mode, and folding it in here would smuggle a
substantial design past the attention it deserves.
