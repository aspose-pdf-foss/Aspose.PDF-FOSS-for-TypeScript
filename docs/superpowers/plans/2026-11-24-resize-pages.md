# Coordinated page resize implementation plan

Implement the [approved design](../specs/2026-11-24-resize-pages-design.md) in TypeScript with existing PDF object types, zero runtime dependencies and Vitest. Track progress in Beads issue `4qhc.1`.

## Page and annotation edits

1. Extend the geometry fixture with a rotated page whose CropBox starts at (10, 20). Mapping a 100 × 50 crop to [5, 7, 205, 157] must send (20, 30) to (25, 37), including a callout tip. Assert the same content matrix, annotation positions and rotation after reopening the saved document.
2. Exercise repeated selections, a second page with a different crop and an indirect array of content streams. Check an invalid later page, empty source crop and malformed annotation before comparing the saved bytes and object count with their pre-call values.
3. Run the focused tests against the missing API. Add the public method in `src/document.ts`, prepare edits in `src/resizepages.ts` and reuse the content wrapper in `src/pagecontent.ts`. Validate all input pages and transformed coordinates before allocating or writing objects.

## Explicit destinations

1. Add a bookmark and a link on an unselected page that share an indirect destination. Check the transformed coordinates once, the source link's original rectangle and the unchanged reference after a round trip. Exercise XYZ nulls and zoom, FitR and the horizontal and vertical fit variants.
2. Visit local destinations in outlines, annotations, catalog open actions and both named-destination tables. Follow local actions with cycle protection. Key planned destination edits by resolved array identity. Skip remote destinations and targets outside the selection.
3. Verify the focused tests, including the existing Page.Resize suite. Document the public method in README, the user-visible change in CHANGELOG and the new module in CLAUDE. Run `npm run typecheck` and `npm test`.
