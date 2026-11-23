# Revocation discovery fixtures

Go's `crypto/x509` and `golang.org/x/crypto/ocsp` v0.41.0 generated the
synthetic certificates, DER request and response vectors in `evidence.json`.
The test-only leaf key is public fixture material. Tests use it to sign PDFs
with the same leaf. The `at` field fixes evidence evaluation, and all
destinations are used only with fake transports.

To regenerate, copy `generate.go` into a temporary Go module, add
`golang.org/x/crypto@v0.41.0`, and redirect `go run .` to `evidence.json` as UTF-8
without a byte order mark. Keys, signatures, and dates vary between runs.
