# EPUB 3 container and package writer (zwto.1)

`Document` already serializes to three reflowable formats — HTML, Markdown and
DOCX — all of them over the neutral model `docmodel.ts` reconstructs. EPUB is the
fourth, and `docmodel.ts`'s own header has named it as an intended consumer since
`no93` shipped.

This adds `doc.ToEpub(options?)`: a valid, single-chapter EPUB 3 that opens in a
reader. Splitting it into chapters with a real navigation TOC is `zwto.2`;
confirming Calibre opens it is `zwto.3`.

## What EPUB actually requires, and what of it we already have

An EPUB is a ZIP with three layers of ceremony on top, and we have exactly one
of them already.

| Layer | What it is | Have it? |
|---|---|---|
| ZIP | the archive itself | **yes** — `zip.ts` |
| OCF | `mimetype` + `META-INF/container.xml` | no |
| OPF | the package document: metadata, manifest, spine | no |
| Content | XHTML documents + a navigation document | partly — `semanticBody` |

`zip.ts` was written for DOCX but with this format in mind, and says so:

> **Invariant:** the compression method is per ENTRY. EPUB requires its
> `mimetype` entry stored uncompressed, so an archive-wide setting would force a
> second writer for that format.

So no change to `zip.ts` is needed. What is emphatically *not* reusable is
`ooxml.ts`: OPC's `[Content_Types].xml` and `.rels` graph are an OOXML
invention with no EPUB counterpart, and EPUB's manifest/spine has no OPC
counterpart. The two container conventions share the ZIP and nothing above it.

## Package layout

```
mimetype                  stored, FIRST entry
META-INF/container.xml    -> EPUB/package.opf
EPUB/package.opf          metadata + manifest + spine
EPUB/nav.xhtml            properties="nav"
EPUB/content.xhtml        the whole document
EPUB/images/image1.png    one per distinct image
```

`EPUB/` as the content directory rather than the older `OEBPS/`: the location is
free — `container.xml` names it — and `EPUB/` is what the EPUB 3 specification's
own examples use.

**Invariant:** `mimetype` is the FIRST entry and is STORED. Both halves matter,
and neither is decorative: a reader identifies an EPUB by reading
`application/epub+zip` at byte **38** — 30 bytes of local file header plus the
8-byte name `mimetype`, with no extra field — without inflating anything.
Deflate it, or emit it second, and the file is still a valid ZIP holding all the
right parts — it simply stops being recognisable as an EPUB. This is the one
rule in the format that a structural test of "are all the parts present" cannot
see, so it is asserted on the archive's raw bytes.

## Architecture

Three modules, split exactly as `svgdraw.ts`/`svgembed.ts` and
`docxflow.ts`/`docxexport.ts` already are.

| Module | Role | Imports `document.js`? |
|---|---|---|
| `epub.ts` (new) | OCF + OPF writer: parts and metadata in, archive out | **no** |
| `epubexport.ts` (new) | content, images, metadata resolution | yes |
| `htmlsemantic.ts` | XHTML-compatible markup (below) | yes, already |

**Invariant:** `epub.ts` never imports `document.js`, `page.js` or any PDF object
module. That is what lets every rule above — mimetype placement, manifest/spine
consistency, the OPF grammar — be driven from hand-built part lists rather than
from a built PDF, the split `floatstack.ts` and `booklet.ts` already make.

`epubexport.ts` is the only module here that reads a `Document`, and it is thin:
reconstruct the model, render the body, register the images, resolve the four
metadata fields, hand it all to `epub.ts`.

### Content documents are XHTML, and so is the HTML export

EPUB content documents must be well-formed XHTML. `semanticBody` in
`htmlsemantic.ts` already produces the right *semantics* — the same
structure-type-to-tag mapping, the same figure and table handling — and its
escaper already emits only `&amp; &lt; &gt; &quot;`, all five of which are
predefined in XML. Named entities, the usual XHTML trap, never arise.

The gap is exactly five sites, all of them void elements or bare boolean
attributes:

| Site | HTML5 today | XHTML |
|---|---|---|
| `htmlsemantic.ts` figure | `<img src alt>` | `<img src alt/>` |
| `htmlsemantic.ts` task item | `<input type disabled checked>` | `<input … disabled="disabled" checked="checked"/>` |
| `tablemodel.ts` cell break ×2 | `<br>` | `<br/>` |

**Decision:** emit the XHTML-compatible spelling **unconditionally**, from the one
serializer, rather than adding an `xhtml` flag or writing a second serializer.

The self-closing form and the spelled-out boolean attributes are valid HTML5 as
well as valid XHTML, so one dialect satisfies both consumers. A flag would mean
the two exports emit different bytes for identical content and every future void
element must remember it — a class of bug that only ever breaks EPUB, and only
in a reader. A second serializer would put two mappings of structure type to
markup in the repo, which is the drift this codebase designs against everywhere
else (`mdflow.ts`'s three entry points, `choiceopt.ts`'s one `/Opt` grammar,
`tablegrid.ts` shared by both table detectors).

The cost is real and one-time: `test/html-identity.test.ts` snapshots move for
every fixture containing an image, a task list, or a table cell with a newline.
That test is a fence against *silent* movement; this movement is deliberate,
reviewed, and recorded here.

### Where a figure's image href comes from

`semanticBody` today resolves every figure through `imageHref`, which returns a
`data:` URI. That is right for a standalone HTML file and wrong here: an EPUB
carries its images as package parts, and the manifest must name a file that
exists. Emitting `data:` URIs instead would leave the manifest empty of images
and inline the bytes into the XHTML, which readers handle inconsistently and
which defeats the per-image dedup the package gets for free.

So `semanticBody` takes an optional image sink, exactly as `docxBody` already
takes `DocxImageSink` and `DocxLinkSink`:

```ts
/** Resolves a figure's image to an href. */
export interface HtmlImageSink { href(stream: PdfStream): string | undefined }

export function semanticBody(
  doc: Document, nodes: DocNode[], images?: HtmlImageSink,
): string
```

Omitted, it resolves through `imageHref` exactly as now, so the HTML export is
byte-identical apart from the void-element change above. `epubexport.ts` passes
a sink that registers the encoded bytes as a part and returns a path relative to
the OPF.

**Invariant:** the sink returns `undefined` for an image that will not encode,
and the mapper's existing fallback then applies unchanged — a tagged `/Figure`
keeps its `/Alt` and an untagged page image leaves nothing behind. The rule that
an unencodable image must not reach the output is `figureHtml`'s already; the
sink does not get to re-decide it.

### Metadata

EPUB 3 requires `dc:identifier`, `dc:title` and `dc:language`. A PDF reliably
supplies none of them, so each needs a resolution order that terminates.

```ts
interface EpubOptions {
  identifier?: string;
  title?: string;
  language?: string;
  author?: string;
}
```

| Field | Resolution order |
|---|---|
| `dc:identifier` | option → `urn:uuid:` from trailer `/ID[0]` → `urn:sha256:` of the content documents |
| `dc:title` | option → `/Info` title → `''` |
| `dc:language` | option → `Document.Lang` → `und` |
| `dc:creator` | option → `/Info` author → omitted |

**Invariant:** every branch is deterministic. `zip.ts` fixes its timestamps so
that two runs over one input give identical bytes; an identifier from
`crypto.randomUUID()` would undo that for the whole format, and nothing
downstream could be snapshot-tested. The trailer `/ID` is the PDF's own claim to
identity and `Save()` already preserves it across a round trip, which makes it
the honest first choice; the content hash is the fallback for a document that
has no `/ID` at all.

**`und`, not `en`.** A missing `dc:language` makes the file invalid, so
*something* must be written, but defaulting to English states a fact the document
never stated — and for a Japanese or Arabic PDF it is simply wrong, in a field
readers use for hyphenation and speech. ISO 639-2's `und` ("undetermined") is
valid, is honest, and is the same refusal to invent that keeps `<strong>` out of
the HTML export and an info string off an exported code fence.

**Invariant:** image identity is the hash of the ENCODED BYTES, not the
`PdfStream` object — `mdexport.ts`'s rule, reused rather than re-derived. A
merged document holds distinct stream objects with identical content, and keying
on identity would write the same picture into the package several times.

## Error handling

`ToEpub` degrades rather than throwing, matching `ToDocx`, `ToHtml` and the
render half of `ToMarkdown`: a document that cannot be fully reconstructed
contributes what it produced, and an image that will not encode is dropped from
the manifest along with the `<img>` that referenced it. A half-written EPUB that
opens beats an exception, and the alternative — a manifest naming a part that
does not exist — is the one shape that makes readers reject the whole file.

There is no assets variant. An EPUB contains its images, so there is nothing for
a caller to hand back; the `ToMarkdownAssets` split exists only because a string
has nowhere to put bytes.

## Testing

`test/epub-package.test.ts`, structural conformance in the shape
`test/docx-package.test.ts` already sets, read back through
`test/helpers/unzip.ts` — which is written against APPNOTE rather than against
`zip.ts`, so the writer is not validated by its own reader.

- `mimetype` is entry 0, method `store`, and the raw archive holds
  `application/epub+zip` at byte 38 exactly.
- `META-INF/container.xml` names an OPF path that exists as a part.
- Every manifest `href` resolves to a part in the archive.
- Every spine `idref` resolves to a manifest item.
- Exactly one manifest item carries `properties="nav"`.
- The OPF, the nav document and every content document parse as well-formed XML
  through the repo's own `parseXml` — which is what turns "we emitted XHTML"
  from a claim into a check.
- Two exports of one input are byte-identical.

**Prove the assertions load-bearing.** Each of the rules above is confirmed to
go red when its production line is broken — the mimetype rules especially, since
an archive with a deflated or misplaced `mimetype` passes every "are the parts
there" assertion.

No CI here can open a reader. These tests prove structural conformance to
EPUB 3, not that any particular consumer opens the file — the same limit
`docx-package.test.ts` records about Word. That is `zwto.3`.

## Out of scope

- Chapter splitting and a real navigation TOC — `zwto.2`. The nav document here
  is valid and minimal: one entry, pointing at the single content document.
- Calibre verification — `zwto.3`.
- `Page.ToEpub`. A book is a document; a one-page EPUB is not a thing anyone
  wants, and none of the three sibling exporters' page-level entry points would
  make sense here.
- Fixed-layout EPUB, cover images, CSS beyond what the HTML export already
  inlines, and `epub:type` semantic enrichment.
