# OPC package reading — design (`m2fp.2`)

Epic `m2fp` imports DOCX over the flow engine. `m2fp.1` gave us `zipread.ts`;
this issue adds the Open Packaging Conventions layer above it — content types
and relationships — which `m2fp.3` (the WordprocessingML model) consumes.
`ooxml.ts` is the WRITE side of the same conventions and shares one rule with
this module (below).

## Decisions taken in brainstorming

1. **Lazy.** `[Content_Types].xml` is read at open; each `.rels` is parsed the
   first time its source is asked about, then cached. A DOCX never pays for the
   `customXml` or theme relationships the importer does not follow, and damage
   in one `.rels` does not refuse the package.
2. **`..` past the root CLAMPS**, per RFC 3986 `remove_dot_segments` — which is
   what `System.IO.Packaging` does. Refusing would make us disagree with the
   format owner's reader about which part a link names.
3. **Third-party oracle: a Word 2010 document** generated through COM by a
   script in `scripts/`, vendored under `test/fixtures/docx/` with PROVENANCE.
   It is the first file of `m2fp.4`'s corpus, which adds the rest.

## Module and API

A new leaf, `src/opcread.ts`, over `zipread.js`, `xml.js`, `loadlimits.js`,
`errors.js`, and `ooxml.js` for ONE symbol: `relsPath` is exported from
`ooxml.ts`, so the writer and the reader share one answer to "where does a
source's `.rels` live". That edge is one-way (`ooxml.ts` imports only `zip.js`
and `xml.js`) and closes no cycle. No `Document`, no `node:fs`, not exported
from `index.ts`.

```ts
export interface OpcRelationship {
  readonly id: string;
  readonly type: string;
  /** Verbatim from the file. */
  readonly target: string;
  /** TargetMode="External". Never resolved, never fetched. */
  readonly external: boolean;
  /** Internal only: the resolved package path (no leading slash). Absent for
   *  an external target, or an internal one carrying a query or fragment. */
  readonly part?: string;
}

export interface OpcPackage {
  readonly zip: ZipArchive;
  /** Override for the part, else Default for its extension, else undefined. */
  contentType(part: string): string | undefined;
  /** The source's relationships in file order; '' is the package root.
   *  A source with no `.rels` has none. */
  relationships(source: string): readonly OpcRelationship[];
  /** Lookup by Id within one source — what an `r:id`/`r:embed` names. */
  relationship(source: string, id: string): OpcRelationship | undefined;
  /** Every relationship of the source with this type, in file order. */
  byType(source: string, type: string): OpcRelationship[];
  has(part: string): boolean;
  /** Decode one part (zipread's `read`, through the case-insensitive lookup). */
  read(part: string): Uint8Array;
}

export function openOpc(bytes: Uint8Array, limits?: LoadLimits): OpcPackage;
```

The module exports the transitional relationship-type constants the importer
needs (`OFFICE_DOCUMENT`, `STYLES`, `NUMBERING`, `IMAGE`, `HYPERLINK`). It does
NOT decide what a DOCX is: `m2fp.3` finds the main document through
`byType('', OFFICE_DOCUMENT)`.

## Rules

**Content types.** `<Default Extension ContentType>` and
`<Override PartName ContentType>`, namespace-agnostic element local names (the
file's own namespace is not checked, matching `parseXml`'s prefix stripping).
An Override's `PartName` has its leading `/` removed and is percent-decoded. A
PartName with an encoded separator, or an empty, `.` or `..` segment once
decoded, is damage (final review, I1).
Override matches a part name ASCII-case-insensitively; failing that, Default
matches the extension (after the last `/` and last `.`) case-insensitively.

**Relationships.** `<Relationship Id Type Target TargetMode>`. `TargetMode` is
`External` or absent/`Internal`; any other value is damage. `Id`, `Type` and
`Target` are required.

**Target resolution (internal).** The target is an RFC 3986 relative reference
resolved against the source part's URI — `/word/document.xml` for
`word/document.xml`, `/` for the root:

- starting with `/` → absolute path within the package;
- otherwise → merged with the source's directory;
- the target is percent-decoded as UTF-8 FIRST, so `%2e%2e` is `..` as it is
  to any reader normalizing per RFC 3986 6.2.2.2; an encoded separator
  (`%2F`, `%5C`) names no part (amended by the final review, I1 — decoding
  after dot removal let `%2e%2e` survive as a literal segment);
- dot segments removed by `remove_dot_segments`, so `..` past the root clamps;
- the result has its leading `/` removed;
- a target containing `?` or `#` gets no `part` (the relationship is still
  returned; the caller reports it);
- a target with a scheme (`http:`) but no `TargetMode="External"` gets no
  `part` either — it names nothing in the package.

**Part names are ASCII case-insensitive.** `has`/`read` try the exact name,
then an index of case-folded entry names. Two ZIP entries whose names differ
only by ASCII case are refused at open (`PdfParseError`): two readers would
pick different bytes, which is `zipread.ts`'s duplicate-name rule one level up.

**Damage** (`PdfParseError`):

- at open: `[Content_Types].xml` missing or not well-formed; a duplicate
  Override `PartName` (case-folded); a duplicate Default `Extension`
  (case-folded); a case-only collision among ZIP entry names;
- at first query of a source: its `.rels` not well-formed; a relationship
  missing `Id`, `Type` or `Target`; an unknown `TargetMode`; a duplicate `Id`.

A `.rels` failure is thrown on every query of that source (the failure is
cached, not retried), and every other source stays usable.

**Limits.** `[Content_Types].xml` entries and each source's relationships count
against `maxContainerItems` as they are produced. XML depth is bounded by
`parseXml`; bytes by `zipread.ts`. Every `catch` calls `rethrowLimit` first.

## Out of scope — noted, not guessed

- Strict OOXML (`http://purl.oclc.org/ooxml/...` relationship types): kept
  verbatim in `type`, nothing maps them.
- Interleaved parts (`/[0].piece`).
- Verifying that a related part's content type is what its relationship type
  expects — `m2fp.3`'s concern if at all.

## Testing

- **Hand-built packages** through `buildOoxmlPackage` for the ordinary shapes,
  and `writeZip` directly for what `ooxml.ts` cannot emit: `../` targets,
  absolute `/word/...` targets, percent-encoded targets, a case-mismatched
  target, clamping at the root, query/fragment targets, a scheme without
  `External`, and every damage case above.
- **`ToDocx` round trip:** resolve the main document, styles, numbering, an
  image and an external hyperlink from our own output.
- **Word 2010 fixture:** `test/fixtures/docx/word2010-basic.docx`, written by
  `scripts/gen-docx-word.ps1` (Word COM automation, not run by `npm test`) with
  a heading, a numbered list, an inline image and a hyperlink. Resolve the same
  five. `PROVENANCE.md` records Word's version, the script, SHA-256s, and that
  `docProps/core.xml` carries a timestamp, so regeneration is not byte-stable
  and the vendored file is the reference.
- **Mutation:** every rule above is broken once and must redden something;
  anything that stays green is recorded as a redundant defence.
