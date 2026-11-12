# Opt-in PDF/A-1 transparency flattening

Issue: `aspose-pdf-foss-for-ts-nh1t.2`. Continue the user's delegated design and
inline implementation workflow without further design questions.

## Approach

Add `ConvertToPdfA('1b', { flattenTransparency: true })` and the same option on
ConvertToPdfAAsync. An object `{ dpi }` selects resolution; default 150, positive
and at most 1200. Omission/false preserves current unresolved reporting.
`preserve: ['transparency']` wins. Other PDF/A parts do not rasterize.

The flattening region is the complete affected page. Local raster patches would
preserve more vector content but need exact overlap, clipping and backdrop
analysis; treating an arbitrary form as an isolated bitmap changes blending.
Full affected pages are the conservative implementer's choice. Opaque pages
remain untouched by this pass. This is lossy in resolution and vector editing,
even though the stored RGB samples use lossless Flate compression.

Render the original content BEFORE conversion's existing passes change color,
groups or font programs, using the software renderer and white page backdrop.
Do not bake annotations; they remain interactive and cannot be painted twice.
Page-resource transparency (constant alpha, blend modes, image masks, nested
groups/patterns) is conservatively detected by pdfatransparency.ts. Annotation-
only transparency remains for the existing conversion rules to report/remediate.
Signed documents and tagged pages (StructParents or marked-content IDs) are
left unchanged by flattening: preserving signatures and structure associations
takes priority over claiming a conversion succeeded.

Final review also pins vertical-writing refusal: the existing glyphless font
is Identity-H, which cannot preserve Identity-V selection geometry. Likewise,
preserved optional-content layers and reachable PostScript resources prevent
flattening that would discard them. Three regressions failed before these
guards were added. This is a conservative scope ruling, not a successful
remediation of those pages; transparency remains unresolved.

Resumed review also found annotation appearances that inherit page resources.
Decline those pages (including indirect appearance states) instead of replacing
their fallback context or mutating shared appearances. A rotated zero-width
combining glyph must retain its angle: text matrices carry the original axis,
while horizontal text scaling carries the signed pen advance, including zero.

## Text and geometry

Extract original glyph events before replacement. Emit their Unicode and
positions through a per-page glyphless embedded Identity-H font with ToUnicode
and render mode 3. Preserve pen spans, text orientation and baseline positions,
including text in forms and already invisible text. No OCR, font substitution
for extraction, or visible duplicate text. Text decoding has the same limits as
the existing extraction API; it cannot invent Unicode absent from the input.

Map the opaque RGB image back through the inverse of renderPageRgb's device
matrix. Keep the page dictionary, CropBox, MediaBox, Rotate, destinations and
annotations. Tag RGB samples with an sRGB ICCBased color space so a custom gray
or CMYK output intent does not misidentify their components. Replace only the
page's Contents, Resources and obsolete Group after rendering/text preparation
succeed. Do not alter shared resource dictionaries. Each page is atomic, with
cooperative cancellation/progress between pages under the outer operation name.

## Reachability and reporting

Validation scans the live object map, including orphaned objects. Record the
reachable object numbers before flattening and delete only objects this pass
newly orphans, after checking all catalog/Info references. Never delete a shared
object or a pre-existing orphan. Inherited page-tree resources that no leaf
inherits must be detached too; resources still used by another leaf survive.
Run cleanup in finally so cancelled operations leave coherent partial results.

Report successful pages as ConvertAction entries with rule Transparency, the
page, resolution and retained glyph count. Revalidate through the existing
validator; unresolved remains precisely its Errors. Never infer Passed from
having rasterized a page. Policy refusals propagate, and default rendering
fidelity limitations still apply. Validate option types/resolution before any
conversion mutation. No runtime dependencies or new package exports.

## Evidence

TDD covers default/false/preserve/non-part-1 behavior, alpha and soft masks,
blend groups, text extraction and invisible rendering, forms, rotated/cropped
pages, shared/inherited resources, orphan cleanup, tagged/signed refusal,
invalid options, resource limits and sync/async cancellation. Use hand-known
composite colors and renderer comparisons. Run feature and main quality gates.

References: existing PDF/A-1 validator clause ISO 19005-1 section 6.4 and
[Adobe transparency flattening](https://helpx.adobe.com/acrobat/using/transparency-flattening-acrobat-pro.html).
