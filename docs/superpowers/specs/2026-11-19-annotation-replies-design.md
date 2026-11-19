# Annotation reply threads

Beads issue `k4h1.1` brings typed PDF annotation replies and grouping to the existing live annotation handles. Review states are covered by `k4h1.2`.

## API

- `Annotation.InReplyTo` reads the annotation named by `/IRT` as a typed handle. Assigning an annotation links it as the parent. Assigning `undefined` clears `/IRT` and `/RT`.
- `Annotation.ReplyType` exposes `'R'` for a regular reply and `'Group'` for a group member. A valid parent with no `/RT` means `'R'`. Assigning `undefined` removes the explicit `/RT` entry.
- `Annotation.AddReply({ contents, author?, rect? })` creates a `TextAnnotation` on the parent’s page. The rectangle defaults to the parent’s rectangle or `[0, 0, 0, 0]` when the parent has no rectangle. The new annotation is an ordinary reply.

Authoring checks current `/Annots` membership by object identity and writes an indirect `/IRT` reference. A link requires a markup annotation and a parent annotation on the same page of the same document. The API rejects self-links, cycles, and grouping under an annotation that already has a parent. A group primary must remain free of `/IRT` while it has group members. Validate inputs before attaching a new note or editing a relationship. Read existing annotations even when `/P` is absent, and expose unresolved parents and unsupported `/RT` values as `undefined`.

Earlier page copies used inline annotation dictionaries. Promote an inline parent in its current page slot when authoring a link. Page copying preserves same-page relationships between the new annotation objects, even when a source page is copied more than once. Removing a parent clears the links from surviving replies so the removed annotation is collectible during save.

`Reorder` keeps the existing widget references on repeated pages so widgets stay connected to their form fields. Creating a reply through a handle shared by multiple pages requires unambiguous page ownership and throws.

## Approach

The approved approach uses `Annotation` for the relationship and reuses the existing text-note builder for creation. A method that only attaches an existing annotation would require a separate creation step for every comment. A thread object would add a second representation of live PDF dictionaries. The existing `Save` and `Open` paths carry the indirect references.

The implementation retains strict TypeScript, ESM `.js` import specifiers, and zero runtime dependencies. [PDF 32000-1, §12.5.6.2 and Table 170](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf#page=400).
