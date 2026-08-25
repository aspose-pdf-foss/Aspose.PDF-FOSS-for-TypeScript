# Redaction overlay content is tagged

Closes `nmjf`. The marker box and overlay text a redaction paints are untagged
content, which a tagged document should not carry.

## What is actually measurable

`ValidatePdfUa` on a tagged document, before and after:

| | Issues |
|---|---|
| Baseline (tagged, no redaction) | 3 errors — `DocumentTitle`, `DisplayDocTitle`, `NaturalLanguage`, all pre-existing fixture gaps |
| After `Redact` — marker box only | **identical 3.** No `UntaggedContent`. |
| After `ApplyRedactions` — overlay text | the same 3 **+ `[warning] UntaggedContent`** |

This splits the issue in two, and one half is not what it appears:

- **The overlay text is the measurable defect**, reported at `warning` severity.
- **The marker box is not measurable.** The `UntaggedContent` rule
  (`structvalidate.ts`) walks `glyph` and `image` events only, so a `re f` path
  fill is invisible to it. The box is untagged in principle but our own validator
  has a blind spot for paths.

**Root cause:** `paintRedactOverlay` calls `stampText` with neither `artifact`
nor `tag`. The option already exists — `tocrender.ts` passes `artifact: true`
for TOC leader dots, so a screen reader does not read a run of dots aloud.

## The decision

The overlay text is **tagged**, not artifacted.

`REDACTED` is information a reader needs. Marking it an `/Artifact` would silence
the warning by declaring the text decorative, so assistive technology skips it:
where a sighted reader sees `REDACTED`, a screen-reader user would hear nothing
and could not tell the region had been redacted at all. That trades a warning for
a real accessibility loss. The content is made correct instead of hidden.

The marker box **is** artifacted — a solid fill rectangle is decoration by
definition, which is exactly what `/Artifact` means.

Both apply only when the document is tagged. `doc.GetStructTree()` returns
`StructTreeRoot | null`, and null is the whole switch: an untagged document has
no tree to attach to, and emitting an `/MCID` with no `/StructTreeRoot` would be
worse than leaving the content plain. Untagged output stays byte-identical.

## The box, and a duplication this removes

`paintRedactOverlay` inlines its own `PageGraphics` fill whose geometry is
character-for-character what `paintRedactionBoxes` already does, and
`paintRedactionBoxes(doc, page, rects, color)` already takes a colour. So
`paintRedactOverlay` delegates its fill to it.

The artifact wrapping then lives in exactly one place and both redaction paths
get it. This is a simplification, not an addition: the alternative is teaching
two functions the same new rule.

One small addition is needed. `PageGraphics.BeginMarkedContent(tag, mcid)` emits
`/<tag> <</MCID n>> BDC`, and an artifact is `/Artifact BMC` — no dictionary, and
`BMC` rather than `BDC`. So:

```ts
/** Begin an artifact sequence: `/Artifact BMC`, marking following ops as
 *  content that belongs to no structure element. Pair with EndMarkedContent. */
BeginArtifact(): this
```

It pairs with the existing `EndMarkedContent()`, the same shape as
`BeginLayer`/`EndLayer`.

## The text

When the document is tagged, `paintRedactOverlay` appends a `/P` and passes it as
`stampText`'s existing `tag` option; `markContent` then emits
`/P <</MCID n>> BDC … EMC` and registers the MCID. One `/P` per region that
carries overlay text.

`/P` rather than the `/Span` the issue proposed: `/Span` is inline-level content
that PDF/UA expects inside a block-level parent, so a bare `/Span` at the top of
the tree would silence our warning while creating a subtler structural problem.
The overlay genuinely is a short standalone paragraph replacing removed content.

It attaches to `root.Children[0]` when the root has a child — typically the
`/Document` element `AutoTag` creates — and to the root itself otherwise, so the
result is `/Document > /P` rather than a `/P` sitting beside `/Document`.

## The /RO branch

`paintOverlayForm` short-circuits the whole overlay when a mark carries an `/RO`
form, appending `q <matrix> cm /Fm Do Q`. That is untagged content too, and if the
form draws text its glyphs trigger the same rule.

It is tagged as a `/P`, exactly like the overlay text it stands in for. `/RO` *is*
the overlay — §12.5.6.23 gives it precedence over `/IC` and `/OverlayText`
precisely because it plays that role — so it gets that role's treatment.

We did not author the form and cannot inspect what it means, which leaves three
imperfect options: leave it untagged (a guaranteed violation), artifact it (hides
whatever it says), or tag it `/P` (claims it is a paragraph, which may
over-describe a purely graphical overlay). Over-describing is the mildest of the
three, and it is the only one that keeps a screen-reader user informed that
something was redacted here.

## Errors

No new error paths, and no new throws. An untagged document takes the unchanged
path. A tagged document whose root has no children appends at the root. Nothing
here can fail in a way that should abort a redaction.

## Testing

Red-before-green is established by measurement rather than a mutation check:
`UntaggedContent` fires today on a tagged document after `ApplyRedactions` with
overlay text, and the test asserts it no longer does.

1. Tagged document, `ApplyRedactions` with overlay text: `ValidatePdfUa` reports
   no `UntaggedContent`, and the three pre-existing issues are **unchanged**.
   Asserting the full issue set matters — a change that silenced unrelated rules
   would be a regression wearing a fix's clothes.
2. The overlay is genuinely reachable: the structure tree contains a `/P` whose
   text is `REDACTED`, under the `/Document` element rather than beside it.
3. Tagged document, `Redact`: the page content stream contains `/Artifact BMC`
   around the marker fill. Asserted on the stream, because `UntaggedContent`
   ignores path fills and cannot observe this either way.
4. A mark carrying an `/RO` form: the `Do` is wrapped in a `/P` marked-content
   sequence, and `ValidatePdfUa` reports no `UntaggedContent`.
5. Untagged document: neither `BDC` nor `BMC` is emitted, for both `Redact` and
   `ApplyRedactions`.
6. The whole existing redaction suite passes, which is what proves the
   `paintRedactionBoxes` delegation did not alter untagged output.

## Not in scope

The `UntaggedContent` rule ignores path fills. That blind spot is the deeper
reason the marker box went unnoticed, and it is arguably its own bug — but
teaching the rule to walk paths would light up every feature that draws one:
watermarks, tables, barcodes, SVG import, `PageGraphics` authoring generally.
That is a validator change with a blast radius far beyond redaction, so it gets
its own issue rather than riding along here.
