# Annotation review states

Beads issue `k4h1.2` adds typed review and marked state records to annotation replies. PDF stores the reviewer in `/T`, the link in `/IRT`, and the state and model as PDF text strings on a `/Text` annotation. [PDF 32000-1, §12.5.6.3 and Tables 171–172](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf#page=401).

The `Marked` model supports `Marked` and `Unmarked`. Its default is `Unmarked`. The `Review` model supports `Accepted`, `Rejected`, `Cancelled`, `Completed`, and `None`. Its default is `None`.

`TextAnnotation.State` and `StateModel` expose the values on the record. Setting `State` writes the matching model. Clearing `State` restores the model’s default. Setting `StateModel` preserves an explicit state valid for that model and clears an incompatible state. Clearing `StateModel` removes both entries.

`Annotation.AddStateReply({ state, author, contents?, rect? })` validates the state and reviewer, then creates an ordinary same-page text reply with the corresponding model. For another update by the same reviewer, call it on the previous state reply. The caller chooses the previous record when there is branching history. The author’s name is stored as supplied.

## Approach

The approved approach exposes individual state records and uses `AddReply` for page membership, rectangle defaults, and linking. Inferring the latest state from a thread would require an ordering rule for imported and branching histories. Individual records let callers follow or extend the PDF’s explicit links.

The implementation uses strict TypeScript, ESM `.js` import specifiers, and zero runtime dependencies.
