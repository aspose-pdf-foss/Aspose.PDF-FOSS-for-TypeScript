# Reopened signatures on explicit incremental save

For `cqzf.1`, a caller who explicitly requests an incremental save of an
untouched reopened PDF should receive the original byte image when the source
declares AcroForm AppendOnly or a signature field binds a byte range. A field
may be nested, and a producer may omit SigFlags. This is a structural check.
Cryptographic verification remains a separate operation.

Use the authenticated incremental baseline to identify the source and compare
the live trailer and objects before returning those bytes. This also covers
edits made through live dictionary handles. A real change follows the existing
incremental writer. Default save selection is tracked in `cqzf.2`.
