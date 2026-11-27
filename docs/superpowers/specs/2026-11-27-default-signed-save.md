# Default saves of reopened signed PDFs

For cqzf.2, ordinary synchronous and asynchronous saves preserve the signed
source revision. Use the source AcroForm, including the AppendOnly flag and
bound nested fields, to select the writer even if a caller edits the live form.
Return an untouched input byte-for-byte. Append edits and keep certification
permission reporting separate from digest verification.

For an incompatible output option, require an explicit full rewrite with
`incremental: false`. Applying redactions or sanitization that removes history
requires a standalone rewrite. Caller-requested incremental output must then
fail. Keep the existing signed-input restrictions on sanitization.
