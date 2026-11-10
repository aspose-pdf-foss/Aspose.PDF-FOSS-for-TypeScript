# qpdf cleartext-metadata fixtures: provenance

Documents encrypted by **qpdf** with `--cleartext-metadata`. qpdf writes
`/EncryptMetadata false` and leaves the XMP packet plaintext **with no `/Crypt`
marker** on its stream. That shape is not one this library writes (since `lj8t`
it marks the stream with an Identity `/Crypt`, Acrobat's shape), so reading it
needs bytes we did not produce (`hch6`). Tests are in `test/qpdf-xmp.test.ts`.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-qpdf-xmp.ts` (not run by `npm test`) |
| Encrypted by | qpdf 12.3.2 |
| Runner | tsx, Node v24.16.0 |
| OS | Windows 11 Pro, 10.0.26300 |
| Date | 2026-10-24 |
| Issue | `hch6` |

```bash
qpdf --version
npx tsx scripts/gen-qpdf-xmp.ts
```

The INPUT is ours: one page of text (`hch6 body text`) and an XMP packet
(`dc:title` `hch6 cleartext XMP`). What is under test is qpdf's encryption of it:

```
qpdf --static-id --static-aes-iv --stream-data=preserve --object-streams=disable \
  [--allow-weak-crypto] --encrypt --user-password= --owner-password=owner <bits> \
  --cleartext-metadata -- input.pdf out.pdf
```

The generator refuses to write a fixture whose metadata stream carries a `/Crypt`
filter, whose XMP is not plaintext, which lacks `/EncryptMetadata false`, or
which `qpdf --check` does not call clean.

## Fixtures

| Fixture | Handler | Bytes | SHA-256 |
|---|---|---|---|
| `aes128.pdf` | V 4, R 4, `/AESV2` | 1826 | `6187bd4a05d519f4a19491d10b1639429d5c60f71266815e5a4b0c6960529e3a` |
| `aes256.pdf` | V 5, R 6, `/AESV3` | 2126 | `7a1908044ccb6fab0be23681a2003db88c142c6b1c9e92f8be15b7fd291cacde` |
| `rc4.pdf` | V 4, R 4, `/V2` | 1733 | `d8808b543c92fd0b10f2bcc7768325dd1711c3cc84203c9df9cd353a9a7b27f6` |

`aes128.pdf` and `rc4.pdf` are byte-reproducible. **`aes256.pdf` is not**: qpdf
draws R 6's salts and file key at random even under `--static-id` and
`--static-aes-iv`, so a rerun writes a different file. The vendored one is the
reference.

## What each one is for

Before `hch6`, `aes128.pdf` and `aes256.pdf` were refused by `Open`
(`object 3 could not be parsed`): the plaintext XMP went through AES unpadding
and threw. `rc4.pdf` opened with its XMP silently decrypted to garbage, so
`GetXmp()` reported nothing. Each now opens with the XMP readable and the page
content still decrypted.

## What it does NOT cover

- **A compressed plaintext XMP.** qpdf INFLATES the packet it leaves in clear
  even under `--stream-data=preserve` (a `/FlateDecode` input came out as the
  same 424 uncompressed bytes), and no other producer of the shape was found.
  The reader therefore looks at the RAW payload only.
- **The V 2 handler.** qpdf forces V 4 for `--cleartext-metadata`, and
  `/EncryptMetadata` means nothing below V 4, so the reader's rule is gated there.
- **One producer.** This is qpdf's reading of the flag; it is evidence for the
  shape, not conformance.
