# XMP packet fixtures

## `acrobat-tutorial-sample.xmp`

An XMP packet written by **Adobe XMP Core 9.1-c001 79.675d0f7 (2023/06/11)**,
as named in its own `x:xmptk` attribute. It is the only `/Metadata` stream of
`TutorialSample.pdf`, which **Adobe Acrobat Reader 26.1.21691.0** installs at
`C:\Program Files\Adobe\Acrobat DC\Acrobat\Tutorials\Resources\`. Its History
records InDesign 19.5, `pdfMakeAccessible` and `pdfDowngradeTool` before
Acrobat.

Only the packet is vendored, not the PDF. It runs from `<?xpacket begin` to the
closing `?>` of `<?xpacket end="w"?>`, trailing padding included, byte for
byte:

```bash
node -e '
const fs=require("fs");const [src,out]=process.argv.slice(1);
const b=fs.readFileSync(src);const s=b.toString("latin1");
const i=s.indexOf("<?xpacket begin");const e=s.indexOf("?>",s.indexOf("<?xpacket end",i))+2;
fs.writeFileSync(out,b.subarray(i,e));' \
  "C:/Program Files/Adobe/Acrobat DC/Acrobat/Tutorials/Resources/TutorialSample.pdf" \
  test/fixtures/xmp/acrobat-tutorial-sample.xmp
```

| File | Bytes | SHA-256 |
|---|---|---|
| `TutorialSample.pdf` (source, not vendored) | 603,028 | `ebc5846a3826f8e100762a41de46b2df64c1073c87109997eb0bc62873b25f6d` |
| `acrobat-tutorial-sample.xmp` | 5,745 | `c7e4faf0eecd738250cd0e0b9a413cc1a6a1e1fa494c469f591a11a040240479` |

### Why this file

`o6uu.1`'s acceptance criterion requires a real Adobe packet that contains a
Seq of structs and a language alternative. None of the packets already vendored
has a Seq of structs: the IRS LiveCycle forms and the Ghostscript PDF/X-4
don't. The first plan was to build a PDF of our own and have Acrobat re-save it.
That needs Acrobat Pro, which the development machine does not have.

Vendoring the bytes was the maintainer's decision. The packet is Adobe's file:
it holds dates, UUIDs and tool names, and no artwork or program. The objection
that kept `RSWOP.icm` out of `test/fixtures/icc/` was weighed and accepted for
metadata of this size.

### What it covers (`test/xmprdf-real.test.ts`)

- `xmpMM:History` as an `rdf:Seq` of three `rdf:parseType="Resource"` structs
  whose fields appear in different orders.
- `xmpMM:DerivedFrom` as a `parseType="Resource"` struct.
- `dc:title` as an `rdf:Alt` language alternative holding `&amp;`.
- `dc:creator` as an empty `<rdf:Bag/>`.
- The xpacket wrapper, `x:xmptk` and whitespace padding.

Measured: turning `parseType="Resource"` into a simple value turns 2 of the
file's 4 cases red.

### What it does NOT cover

- **One producer.** Nothing arbitrates Adobe's reading of RDF against ours.
- **No other struct syntaxes.** It has no nested `rdf:Description` struct, no
  attribute-form struct and no multi-language `Alt`. Those shapes are pinned only
  by hand-built cases in `test/xmprdf.test.ts`.
- **No qualifiers, no `rdf:resource` and no PDF/A extension schema.**
  Qualifiers come from `calibre-identifiers.xmp` below. The PDF/A extension
  schema belongs to `o6uu.3`.
- **No UTF-16.** The packet is UTF-8.

## `calibre-identifiers.xmp`

An XMP packet written by **calibre 7.26** (`ebook-meta.exe`). The input was a
one-page PDF that we built with `test/helpers/build-xmp-pdf.ts`; its packet held
only a `dc:title`. calibre was then asked to set three identifiers:

```bash
ebook-meta calibre-out.pdf --isbn 9780306406157 \
  --identifier "doi:10.1000/182" --identifier "uri:https://example.com/book"
```

calibre rewrote the packet itself, and this file is the last
`<?xpacket begin … end="w"?>` region in its output, byte for byte, padding
included.

| File | Bytes | SHA-256 |
|---|---|---|
| input PDF (not vendored) | 851 | `d274ecf91e3066b9a1b9543c0d8e32dae162681fc980a7291bb2d15815d84b6c` |
| calibre's output PDF (not vendored) | 5,764 | `932a4f7ad9f1c55088bfda47fab17ffa9cf3a1422b70216c5a88a4e7de57359e` |
| `calibre-identifiers.xmp` | 5,160 | `c40ea45613a4c886fda7f1cb19c4ece278a9dd40a466c42e1943b93c7d050c09` |

The output cannot be reproduced byte for byte: calibre stamps
`xmp:MetadataDate` with the current time.

### Why this file

`o6uu.2`'s acceptance criterion asks for a qualified identifier. calibre builds
`xmp:Identifier` from its own code rather than copying input markup. It writes
a Bag of `rdf:parseType="Resource"` items that put **`xmpidq:Scheme` before
`rdf:value`**, which is an ordering our own serializer never produces.

calibre is not a suitable source for *foreign* schemas: it copies those as XML
subtrees, so they would come back in our own syntax. For that reason the
History half of the criterion rests on `acrobat-tutorial-sample.xmp` instead.

### What it does NOT cover

- **One producer, and only one qualifier.** It has `xmpidq:Scheme` alone, no
  nested (recursive) qualification and no `xml:lang` on `rdf:value`. Those are
  held by `test/xmprdf-qualifiers.test.ts`.
- **No `rdf:resource`.** No producer available here writes one, so URI values
  are held by hand-built cases only.
