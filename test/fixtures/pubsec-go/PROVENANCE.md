# Go PubSec fixtures

## AES-128

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

## AES-256

`aes256.pdf` is direct `WriteTo` output from the same Go revision and Go 1.27.4.
The generator makes a 400 × 200 page with `Go PubSec AES-256 fixture text` in
Helvetica and passes `EncryptionAlgAES256` to `SetEncryption`. It uses the same
addressed certificate and key, plus a fresh decoy certificate with CN
`Go PubSec fixture decoy` and serial 13. The decoy envelope appears first.
The addressed recipient can print at low resolution and has no other grants.

The PDF uses `/AESV3` for its PDF objects. Each CMS recipient envelope uses
AES-256-CBC (`2.16.840.1.101.3.4.1.42`) with a 16-byte IV and a 32-byte content
key wrapped with RSAES-PKCS1-v1_5. The Go generator reopened the output with
`OpenStreamWithCertificate` and verified the extracted page text.

PDF SHA-256 `b3a26fd7c356ddc6d259dc467fea1455fea2a436369321f4fc6c7e24153150c5`.
