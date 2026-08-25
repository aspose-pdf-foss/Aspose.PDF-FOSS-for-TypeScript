# OOXML package writer — ZIP container, content types and relationships

Design for `aspose-pdf-foss-for-ts-8yt9.1`, the first child of the
`PDF to DOCX export` epic (`8yt9`), which depends on `no93` — the epic that
established `docmodel.ts` as the neutral document model every exporter reads.

## Problem

A `.docx` is a ZIP archive of XML parts wired together by two conventions:
`[Content_Types].xml`, which declares the media type of every part, and a graph
of `.rels` files, which say which part points at which. Nothing in `src/`
writes a ZIP, and nothing knows either convention.

The three siblings that follow — flow mode (`8yt9.2`), ruled tables (`8yt9.3`)
and textbox mode (`8yt9.4`) — all produce WordprocessingML that has to be
packaged. This issue is the packaging, and the interface it settles is the one
they build against.

## Approach

Three layers, each ignorant of the one above it:

- **`zip.ts`** — entries in, archive bytes out. Knows nothing of OOXML.
- **`ooxml.ts`** — parts, content types and relationships. Knows nothing of
  WordprocessingML.
- **`docxpackage.ts`** — the minimal `.docx` part set, with the document body
  as a seam `8yt9.2` fills.

Two alternatives were considered and rejected:

- **One DOCX-specific module, ZIP mechanics included.** Smallest surface, and
  nothing speculative. Rejected because `zwto.1` is *EPUB 3 container and
  package writer*, and an EPUB is also a ZIP: a DOCX-shaped container means that
  epic writes a second one, and the seam gets discovered with a DOCX writer
  already built through it. That is the four-walk problem `no93.1` was written
  to prevent, arriving one epic later. The cost of avoiding it now is one extra
  module.
- **A streaming writer.** A ZIP can be produced without holding the archive in
  memory, which matters for multi-gigabyte output. Rejected as unearned: every
  other writer in this library returns a `Uint8Array` (`Save`, `ToImage`,
  `ToHtml`), a `.docx` of a converted PDF is measured in megabytes, and
  streaming would force an async API on a synchronous core.

## Scope

In scope:

- `src/crc32.ts` (new) — extracted from `pngencode.ts`, which already has it.
- `src/zip.ts` (new) — the format-neutral archive writer.
- `src/ooxml.ts` (new) — content types and the relationship graph.
- `src/docxpackage.ts` (new) — the minimal `.docx` part set.
- `test/helpers/unzip.ts` (new) — a test-only reader.
- `README.md`, `CLAUDE.md`.

Out of scope, each a named sibling: mapping `docmodel.ts` to WordprocessingML
(`8yt9.2`), tables (`8yt9.3`), textbox positioning (`8yt9.4`).

Out of scope with no sibling: ZIP64, encryption, and reading a `.docx`. This
library converts *from* PDF; nothing here parses an Office file.

## `crc32.ts`

`pngencode.ts` already computes CRC-32 with the `0xEDB88320` polynomial, which
is the one ZIP uses. It moves to its own module and `pngencode.ts` imports it.

**Invariant:** one owner. A second copy is a second chance to get the
initial/final XOR wrong, and a wrong CRC in a ZIP is not a crash — it is an
archive that some readers accept and others reject, which is the worst failure
mode to debug. PNG output must stay byte-identical across the move, which
`test/` already fences.

## `zip.ts`

```ts
interface ZipEntry {
  /** Archive-relative path, '/'-separated, no leading slash. */
  path: string;
  bytes: Uint8Array;
  /** Default 'deflate'. */
  method?: 'store' | 'deflate';
}

function writeZip(entries: ZipEntry[]): Uint8Array;
```

Local file header per entry, then the central directory, then the
end-of-central-directory record. Raw DEFLATE via `deflateRawSync` from
`node:zlib` — the same module `filters.ts` and `fontembed.ts` already use, so
the issue title's "no zip dependency" holds without new code.

**Invariant:** the compression method is per ENTRY, not per archive. EPUB
requires its `mimetype` entry first and stored uncompressed (OCF, and the reason
`file(1)` can identify an EPUB from its first bytes), so an archive-wide setting
would force `zwto.1` to write its own container after all. That constraint is
honoured now because honouring it later means changing this signature.

**Invariant:** `store` is also the honest choice for already-compressed data.
Deflating a JPEG costs time and usually grows it; `8yt9.2` will embed images and
should store them.

**Invariant:** timestamps are the fixed constant 1980-01-01 00:00:00 — the
zero of the MS-DOS date format ZIP stores, and the only value that needs no
clock. Two runs over one input must produce identical bytes, or nothing
downstream can be snapshot-tested and a caller cannot tell a real change from
the time of day. This is the same reason `Save()` preserves the document `/ID`
rather than regenerating it.

**Invariant:** overflow THROWS. Past 4 GB of data or 65535 entries the 32-bit
fields silently wrap, producing an archive that looks well-formed and is not.
Neither bound is reachable by a converted PDF, so the guard costs nothing and
refuses the one case where the format cannot express the truth. ZIP64 is the
feature that would lift it and is deliberately absent.

**Invariant:** paths are stored with `/` separators and no leading slash, and a
duplicate path is rejected. A `.docx` with two `word/document.xml` entries is
readable by some tools and not others; failing at write time is the only place
the ambiguity can still be pointed at.

## `ooxml.ts`

```ts
interface OoxmlPart {
  /** Package path, e.g. 'word/document.xml'. */
  path: string;
  bytes: Uint8Array;
  /** e.g. 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' */
  contentType: string;
  /** Store rather than deflate — for an already-compressed image. */
  store?: boolean;
}

interface OoxmlRelationship {
  /** The part whose .rels file this belongs in; '' for the package root. */
  source: string;
  id: string;            // 'rId1'
  type: string;          // the ECMA-376 relationship type URI
  target: string;        // relative to the source part's directory
  external?: boolean;    // a hyperlink, not a part
}

function buildOoxmlPackage(parts: OoxmlPart[], rels: OoxmlRelationship[]): Uint8Array;
```

It generates `[Content_Types].xml` and one `.rels` per source, then hands the
whole set to `writeZip`.

**Invariant:** `[Content_Types].xml` is generated from the parts, never written
by hand. Every part must be typed, by extension default or by an explicit
override, and a part the file does not cover is a part Word refuses. Deriving it
from the same list that produces the entries is what makes the two incapable of
disagreeing.

**Invariant:** `.rels` files are parts of the package but are NOT themselves
listed as overrides — their extension default (`rels` →
`application/vnd.openxmlformats-package.relationships+xml`) covers them.
Listing one as an override is a conformance error a lenient reader hides.

**Invariant:** a relationship target is resolved relative to the SOURCE part's
directory, not the package root. `word/_rels/document.xml.rels` pointing at
`styles.xml` means `word/styles.xml`. Getting this wrong produces a package
whose parts all exist and whose links all dangle — every symptom points at the
target and the fault is in the base.

**Invariant:** XML escaping goes through `xml.ts`'s `escapeXml`. A fifth copy
(`svgrender.ts` and `xmp.ts` each have one already) is a fifth chance to forget
an entity. Consolidating the existing copies is NOT in this issue's scope.

## `docxpackage.ts`

The minimal conformant WordprocessingML package:

| Part | Purpose |
|---|---|
| `[Content_Types].xml` | generated |
| `_rels/.rels` | package root → `word/document.xml` (officeDocument) |
| `word/document.xml` | `<w:document><w:body>…</w:body></w:document>` |
| `word/_rels/document.xml.rels` | present, so `8yt9.2` has somewhere to add image and hyperlink rels |

```ts
function writeDocx(bodyXml: string): Uint8Array;
```

`bodyXml` is the seam. This issue emits an empty body; `8yt9.2` produces it from
`docmodel.ts`.

**Invariant:** the `w:` namespace declaration lives on `<w:document>` and the
part is emitted with an XML declaration and UTF-8 encoding, both of which
ECMA-376 requires. Whether a given consumer *tolerates* their absence is
untested here — see Limitations — so conformance is the standard we hold, not
what some reader happens to accept.

## Testing

A writer cannot be validated by the writer. CLAUDE.md's rule — *a differential
test cannot validate the parser it runs through* — applies directly, so the
assertions are anchored outside our own code in three ways:

- **`test/helpers/unzip.ts`**, a reader written against the format rather than
  against `zip.ts`: locate the EOCD, walk the central directory, inflate each
  entry. It is what makes the structural assertions readable, and `8yt9.2`–`.4`
  need it anyway to inspect `word/document.xml`.
- **Published CRC-32 vectors.** The reader can confirm an archive is
  self-consistent while both halves share a wrong CRC. Known values for known
  strings cannot.
- **`inflateRawSync`.** A payload deflated by us and inflated by `node:zlib` has
  passed through code we did not write.

Cases: a stored entry and a deflated entry; a duplicate path rejected; the
overflow guards; determinism (two writes, identical bytes); every part declared
in `[Content_Types].xml`; every relationship resolving to a part that exists; a
relationship target resolved relative to its source directory; and the DOCX part
set complete.

Per CLAUDE.md each new path is broken and the suite confirmed red rather than
trusted on first green. Mutations to run: emit a fixed timestamp from the clock
instead (determinism goes red); drop an override from `[Content_Types].xml`;
resolve a relationship target from the package root; deflate an entry marked
`store`; and remove the duplicate-path check.

## Limitations, stated rather than implied

**We cannot run Word in CI.** These tests prove the package is structurally
conformant to ECMA-376 — parts typed, relationships resolving, archive
well-formed. They do not prove any particular consumer opens it. That is a real
gap and is recorded as one; the first time a `.docx` is opened by Word will be
by hand, and any finding belongs in this issue's successor rather than being
retro-fitted as a claim here.

**No ZIP64**, so no archive above 4 GB or 65535 entries. The writer throws there.

## Documentation

- `README.md` — no public API yet; `writeDocx` is internal until `8yt9.2` gives
  it a `Document.ToDocx()`. The Limitations section gains the ZIP64 bound and
  the note that Word compatibility is unverified in CI.
- `CLAUDE.md` — a Source-list entry for the three new modules carrying the
  invariants above, and the `crc32.ts` extraction noted beside `pngencode.ts`.
