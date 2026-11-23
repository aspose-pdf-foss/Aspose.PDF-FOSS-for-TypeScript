# Go-produced AES-256 signed PDF

`aes256.pdf` is the direct output of `Document.WriteTo` from
[Aspose PDF FOSS for Go at `dfa75dbfb300e6eb5a8e5d2199f81d07ed602916`](https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/tree/dfa75dbfb300e6eb5a8e5d2199f81d07ed602916),
built with Go 1.27.4 in a scratch module with a local `replace` pointing to
that checkout.

The generator made a 400 by 200 point page with `Go encrypted signature fixture text`
in Helvetica and set the title to `Go encrypted signature fixture`. It called
`SetEncryption` with `EncryptionAlgAES256`, user password `go-signature-user`,
and owner password `go-signature-owner`. It then called `Sign` with an RSA-2048
key and a self-signed certificate generated in memory by Go's `crypto/rsa` and
`crypto/x509`. The certificate has CN `Go encrypted fixture signer`, serial 17,
digital-signature key usage, and a validity period from 2020-01-01 to 2050-01-01.
`Sign` used the same signer name, reason `Interoperability test`, and signing
time `2026-11-23T00:00:00Z`. The disposable private key was discarded.

`WriteTo` wrote an encrypted base and appended the detached CMS approval signature
as an incremental revision. The generator reopened the resulting bytes with each
password and confirmed in Go that `Signature1` passed integrity and signature
verification and covered the full file. qpdf reported AESv3 encryption at
revision 6 and found no syntax or stream encoding errors. OpenSSL verified the
detached CMS against the two byte spans identified by `/ByteRange`.

PDF SHA-256 `9a92cd5b632a80774c6f22546b32718adda16d1f91b9444efaefd2729ec33308`.
