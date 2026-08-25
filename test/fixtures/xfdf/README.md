# XFDF foreign-producer fixtures

## `acrobat-stamp-appearance.xml`

The decoded payload of the `<appearance>` element of a **real Acrobat-produced
XFDF** — `stamp_annotation.xfdf`, attached to
[PDFBOX-4437](https://issues.apache.org/jira/browse/PDFBOX-4437) (attachment
`12955984`), the bug report that taught Apache PDFBox to read this encoding.

Acrobat does not put a PDF fragment in `<appearance>` (which is what *we* write,
see `encodeAppearance` in `src/xfdfannot.ts`). It puts base64 of an XML
serialization of the COS objects, rooted at `<DICT KEY="AP">`. This file is that
XML, after base64-decoding.

**Derived, not verbatim.** The original decodes to 289 KB, almost all of it a
scanned floor plan. Two things were changed, and nothing else:

- the three image `<DATA>` bodies are truncated to 8 bytes each;
- their `<INT KEY="Length">` values are set to `8` to match.

The `/N` Form XObject's own 68-byte content stream is kept verbatim, as is every
element, attribute and byte of the surrounding structure — so the file still
exercises the real nesting (`Resources` → `XObject` → stream, and an image with
a nested `SMask` stream) and the real element set (`DICT` `STREAM` `ARRAY` `INT`
`FIXED` `NAME` `BOOL` `DATA`, with `ENCODING="HEX" MODE="RAW"`).
