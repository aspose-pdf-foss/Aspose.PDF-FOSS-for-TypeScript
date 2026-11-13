# Plain-text to PDF loader

Issue: `aspose-pdf-foss-for-ts-nh1t.5`.

Provide `Document.AddPlainText(text, options?)`, its cooperative async counterpart,
and `textFileToPdf(inputPath, outPath, options?)`. The document methods append
fresh pages and return those pages. Empty input produces one blank page.

Reuse preformatted Flow blocks with no fill or padding. Defaults are Courier
10pt, 12pt leading, four-column tabs, A4 and 72pt margins. Normalize CRLF and
bare CR to LF; retain blank lines, indentation and literal markup. Long lines
wrap and text paginates automatically. Every form feed starts a new page sequence;
leading, trailing and consecutive form feeds preserve their empty sections.
Indentation uses the existing preformat helper's nonbreaking spaces in PDF text.
The existing layout engine's character-boundary fallback is forwarded through
preformatted blocks for tokens with no ordinary break opportunity. Other Flow
callers retain their default wrapping rules.

Expose `PlainTextOptions` for page size/margins, font, font size, leading, color,
tab width, optional title and operation controls. A title updates metadata and
DisplayDocTitle like other document importers. Invalid options and unsupported
characters are rejected before any pages are appended. The user explicitly chose
clear rejection for characters Courier cannot draw; an embedded font handle from
the same document supports other characters when that font has the glyphs.
Coverage is strict even for fonts whose shaping default is enabled: an absent
character is refused rather than relying on the ordinary shaped-block diagnostic,
which permits partial loss for formatting/joiner characters.

Expose `TextFileOptions` with the same options, an explicit text encoding, and
optional `fontData` bytes for a font registered in the newly created document.
Its `font` option accepts Standard-14 names; `font` and `fontData` are mutually
exclusive. Decode UTF-8 by default; UTF-8/UTF-16 BOMs outrank an explicit encoding.
Reject invalid encoded bytes. Enforce the default input file-size bound before
reading, create the output directory after conversion succeeds, and write the
PDF only after rendering/saving succeeds. No runtime dependencies are added.

Both document entry points share one generator. Validation/preparation precedes
page allocation; cancellation after rendering begins leaves completed pages,
matching the library's operation contract. The file wrapper uses the async path
and captures operation controls before I/O. No implicit font or network lookup.
