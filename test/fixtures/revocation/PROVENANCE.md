# Revocation evidence fixtures

`evidence.json` contains base64 DER for synthetic certificates, OCSP responses,
and CRLs. The evaluation instant is stored in `at`. Go's `crypto/x509` and
`golang.org/x/crypto/ocsp` v0.41.0 generated the DER independently of the
TypeScript verifier. The generator creates throwaway keys in memory.

The fixtures cover issuer and delegated OCSP signatures, TLS-only usage, an
expired responder, a mismatched CertID, expired evidence, and responses with no
`nextUpdate`. The CRLs include complete lists, an expired list, a CA-only list,
a different CA with the same name, and a signer certificate without `cRLSign`.
An expired leaf covers a CRL that no longer has to list its serial number.

To regenerate, copy `generate.go` into a temporary Go module, add
`golang.org/x/crypto@v0.41.0`, and redirect `go run .` to `evidence.json` as UTF-8
without a byte order mark. Keys, signatures, and dates vary between runs.
