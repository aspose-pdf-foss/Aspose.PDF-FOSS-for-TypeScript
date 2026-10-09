# OPM form fixtures: provenance

Two forms from the US Office of Personnel Management that `Document.Open`
refused (`lj8t`), each for a different reason. They were found while scanning
OPM's form indexes for `164g.6`. Tests are in `test/crypt-filter.test.ts`.

| Fixture | Source | Producer (from the file) | What it carries |
|---|---|---|---|
| `opm-sf50.pdf` | <https://www.opm.gov/forms/pdfimage/sf50.pdf> | Acrobat PDFWriter 3.02 for Windows | An unescaped `)` in `/Info`: `/Title (pages))` |
| `opm-sf1153.pdf` | <https://www.opm.gov/forms/pdf_fill/sf1153.pdf> | Adobe LiveCycle Designer ES 8.2 | AESV2, `/EncryptMetadata false`, and a plaintext XMP packet under its own `/Filter [/Crypt]` |

- Fetched **2026-10-09**.
- SHA-256:
  - `opm-sf50.pdf`: `a3cc809710d9e48c8112e4858ae4a642c96469b6ac94c3d4bc528061754936fb` (343,298 bytes)
  - `opm-sf1153.pdf`: `e8b29d08b723c41c8deb15224413553f2313d5c17ae17abe23f3bfd19c35522f` (183,271 bytes)
- **Licence:** works of the United States federal government, not subject to
  copyright in the US (17 U.S.C. § 105), so they can be committed.

## What each one is for

**`opm-sf50.pdf`** has a sound xref and a `/Root` that is a catalog. Its `/Info`
dictionary (object 1) holds

```
/Creator (Print SF50.TIF (6 pages))
/Title (pages))
```

The `/Creator` is legal: balanced parentheses nest inside a literal string. The
`/Title` is not. PDFWriter cut a longer title down to its last word and left the
closing `)` of `(6 pages)` behind, which closes the string early and leaves a
stray `)` where a key should be. `Open` refused any structurally sound file
holding an object that would not parse, so the whole document was refused. Now
the object is re-parsed once in the object parser's lenient mode, which skips a
stray delimiter where a key or array element belongs. The file opens with
`/Info` salvaged, and `doc.recovery` reports object 1 as repaired.

**`opm-sf1153.pdf`** is conformant. It is AESV2-encrypted with `/EncryptMetadata
false`, and Designer marked its plaintext XMP with an Identity crypt filter
(`/Filter [/Crypt]` with no `/DecodeParms`, ISO 32000-1 7.4.10). We decrypted
every stream with `/StmF` regardless, the AES unpadding of that plaintext threw,
and the object counted as unparseable. The stream's own crypt filter now decides
how it is decrypted and written.

A third form, `sf39a.pdf`
(`2a172d229809c82deb7d0a139a578c0fae6ef80c144c654ab0d156300551af61`, 684,352
bytes), has `sf1153`'s shape from the same producer. It is not vendored, because
it adds nothing `sf1153` does not already cover.

## What it does NOT cover

- **No `/Crypt` naming a non-Identity filter** appears in either file. That
  path, `/DecodeParms /Name`, is covered by hand-built cases only.
- **No producer that writes `/EncryptMetadata false` and leaves the XMP plaintext
  with NO `/Crypt` marker** is vendored. The reader does not infer plaintext from
  the flag alone: a file this library wrote before `lj8t` encrypted its XMP
  whatever the flag said, and still has to open.
- **One damaged `/Info`.** The lenient mode is only checked against the shape
  `sf50` has.
