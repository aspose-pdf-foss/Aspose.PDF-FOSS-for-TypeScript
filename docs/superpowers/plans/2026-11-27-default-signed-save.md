# Default signed-save implementation

1. Exercise the ordinary save entry points with a signed fixture, a certified
   form edit, a raw form-tree edit, incompatible output options and an applied
   redaction. Run focused tests before changing the writer.
2. Record source signature evidence independently of live form edits. Route
   implicit saves to the existing incremental implementation, including
   asynchronous recipient authentication. Guard full-rewrite-only operations
   and retain the sealed signing-session behavior.
3. Document save selection, update the changelog and verify the focused tests,
   the typecheck and the complete suite on main before closing the issue.
