# Bookmark action implementation plan

Implement the [approved bookmark action design](../specs/2026-11-24-bookmark-actions-design.md) in the existing outline reader and writer.

1. Extend the outline tests with authored actions, an indirect unknown action, a named GoTo and a chained action. Rename and spread a bookmark, save and reopen, and inspect its PDF dictionary.
2. Read typed actions through the shared action parser. Retain the original same-document action and snapshot its public projections to detect changes to Action or Dest.
3. Prepare target objects before deleting the old tree. Encode newly authored actions through the shared encoder. Test invalid nested actions, competing targets and cross-document references.
4. Exercise a destination shared by a bookmark, link and catalog open action across resize and outline editing. Check its coordinates and shared identity after reopening.
5. Update the README and changelog, run the outline and action suites, then run typecheck and the complete Vitest suite.
