# OpenSSL CMS SignerIdentifier fixtures

OpenSSL 3.5.9 created detached CMS signatures over the same two byte ranges of
a minimal one-page PDF. The generator assembled the PDF directly and placed
each DER signature in its reserved `/Contents` string. It used `openssl cms
-sign` with `-binary -nosmimecap -md sha256 -outform DER`, and added `-keyid`
for the subject key identifier cases. All certificates were created with
`openssl req -new -x509` from one disposable P-256 key. The private key is
absent from the fixtures. Using a shared public key makes certificate identity
selection observable even when raw signature verification would succeed.

| Fixture | CMS certificates and identifier |
| --- | --- |
| `issuer-serial.pdf` | A decoy precedes the matching issuer and serial certificate. |
| `subject-key-id.pdf` | The same certificates precede the signer info, with a matching subject key identifier. |
| `missing-signer.pdf` | `-nocerts` omits the signer. Only the decoy is supplied with `-certfile`. Its issuer and serial differ. |
| `missing-key-id.pdf` | The signer is omitted. The decoy has an explicitly set subject key identifier that differs from the hash-derived signer identifier. |
| `ambiguous-issuer-serial.pdf` | Two distinct certificates have the signer's issuer and serial. The second has an added extended key usage. |
| `ambiguous-key-id.pdf` | Two distinct certificates have the same hash-derived subject key identifier. The second has a different subject and serial. |

`openssl cms -cmsout -print` confirmed the certificate sets and identifier
forms. `openssl cms -verify -binary -noverify` verified the two matching cases
against the concatenated byte ranges. The identifier forms are specified in
[RFC 5652 §5.3](https://www.rfc-editor.org/rfc/rfc5652.html#section-5.3).
