# Go PubSec AES-128 fixture

`aes128.pdf` was written by [Aspose PDF FOSS for Go at dfa75dbf](https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/tree/dfa75dbfb300e6eb5a8e5d2199f81d07ed602916)
using Go 1.27.4. The generator makes a 400 × 200 page, adds the text
`Go PubSec fixture text` in Helvetica, and calls
`SetEncryption(EncryptionOptions{Algorithm: EncryptionAlgAES128, Recipients: ...})`
and `WriteTo`. The writer emits two CMS envelopes in recipient order. The
decoy certificate has CN `Go PubSec fixture decoy` and serial 13. The addressed
certificate has CN `Go PubSec fixture recipient` and serial 11.

`recipient-cert.pem` and `recipient-key.pem` are the synthetic self-signed
certificate and disposable RSA-2048 private key created for this PDF with
Go's `crypto/x509` and `crypto/rsa`. `other-serial-cert.pem` was issued with
the same issuer and public key as the addressed certificate and has serial 12.
The certificates allow key encipherment and are dated 2020–2050. The decoy
private key was discarded. All material was generated for tests.

PDF SHA-256 `04ef510fe60b1805808f0e8541233e2a2bbc23d835ab410315cc633a092f1abf`.
The TypeScript encoder did not produce or modify the fixture.
