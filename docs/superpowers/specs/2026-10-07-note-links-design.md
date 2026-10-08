# Internal Links Between Note Marks and Notes (v9j3.3.4) — Design

**Issue:** `v9j3.3.4`, child of `v9j3.3` (Footnotes and endnotes).
**Status:** approved in conversation, 2026-10-07.

## Goal

A footnote or endnote citation mark is a clickable GoTo link to its note, and
the note's own (gutter) mark is a GoTo link back to the citation — in every
placement path the v9j3.3 engine has: the column foot, endnotes, a single rect
(`page.AddMarkdown`, `page.AddDocx`), table cells, and therefore hand-built
flows, Markdown and DOCX alike.

## Decisions

| Question | Decision |
|---|---|
| Default | ON. `FlowNoteOptions.links: false` (per kind: `footnotes`, `endnotes`) turns it off. Word, LibreOffice and GitHub link footnotes by default. |
| Mechanism | Deferred link boxes collected during placement; ALL annotations written in one pass at the end (`NoteLinks.finish()`). Never an annotation with a placeholder target. |
| Repeated citations | Every citation links to the note; the note's ONE back link targets the FIRST citation. |
| A cited run that is itself a URI link | Its text keeps the URI; its mark links to the note (today the mark inherits the URI). |
| `/Contents` on the annotations | None, as for the existing URI run links — the link's content is the mark itself. |
| `/Ref` / PDF 2.0 `FENote` | Out of scope: this library writes `/Note`. |
| A note that is never placed (one rect, overflowed into the remainder) | Its citation gets no link. Nothing is written half-finished. Documented. |

## Mechanism

### The deferred link

`lowerNotes` gives every mark run, when the reference's kind has `links` on,
an INTERNAL link value in place of a URI string: an object carrying a
module-private symbol and its `NoteRef`. It is not public API; `TextRun.link`'s
public type stays `string`. `resolveRuns`' validation of `link` admits it beside
a non-empty string.

- `stamp.ts` collects one box per line for any linked run (`runLinkBoxes`) and,
  in a tagged block, gives a linked run its own marked content — the mark gets
  both unchanged.
- `runlink.ts`'s `placeRunLinks` branches once per box: a URI box makes its
  annotation immediately, exactly as today; a deferred box creates only its
  `/Link` structure element (holding the mark's MCID, retargeted as for a URI
  link) when tagged, and records `{ page, rect, linkElem? }` on the reference's
  collector entry. No annotation yet.
- The deferred value carries no URI, so the run's own `link` (if any) stays on
  the cited text: `lowerNotes` stops copying `body.link` onto the mark run when
  it sets a deferred link, and keeps copying it when links are off (today's
  behaviour, byte-identical).

### The back link

When a note's gutter mark is painted (`NoteElement`, `flownotes.ts`), its box is
recorded on the same entry: the page, the mark's rect (measured width at the
gutter position, `[x, y - descent, x + w, y + ascent]` from the mark's size),
and the note's ANCHOR — page, the column's x, and the top of the note's first
line. When tagged, the gutter mark is stamped under a `/Link` child of the
`/Note` rather than directly under the `/Note`.

### The collector

`NoteLinks` (in `flownotes.ts`), one per placement — `Flow.Render`, or one rect
call — keyed by `NoteRef` (a repeat resolves to its first). `finish()` runs once
everything is placed and writes, through `addLink` with `border: 0`:

- each citation box → GoTo { page: note's page index, view: XYZ(note x, note top) };
- the note's gutter box → GoTo { page: first citation's page index, view: XYZ(that box's left, that box's top) }.

After each annotation it appends its `/OBJR` to the box's `/Link` element (when
tagged): glyphs first, then the annotation, as `runlink.ts` already orders them.
An entry with no note anchor (the note never placed) or no citation box writes
nothing.

## Coverage

- **Column foot and endnotes:** `Flow.Render` calls `finish()` after endnotes
  are placed.
- **Table cells:** a cell paints through `stampTextBlock`, which places run
  links already, so a cell mark links with no table-specific code.
- **One rect:** `notesAsTrailing` keeps the deferred link on the mark run when
  it detaches the reference; the note element records its anchor when it
  paints; `page.AddMarkdown` and `page.AddDocx` call `finish()` after
  `placeElements`.
- **`restart: 'page'`:** renumbering changes mark text only.
- **Exports** (`ToHtml`, `ToMarkdown`, `ToDocx`) read URI links back only, so an
  internal GoTo degrades to its text, as any internal link does today.

## The opt-out

`FlowNoteOptions.links?: boolean`, default `true`, validated as a boolean. With
`false` the mark runs carry no deferred link and output is byte-identical to
v9j3.3.3's, tagged output included. `doc.AddMarkdown`/`doc.AddDocx` pass their
`FlowOptions` through as now; one-rect paths follow the note options they
already resolve.

## Testing

- **Fence (before any change):** `links: false` twins of every case in
  `test/flow-notes-identity.test.ts`, asserting the EXISTING recorded hashes.
  With links on, the untagged hashes (content bytes only) must not move; the
  tagged one moves and is re-recorded under an explicit ruling.
- **Geometry:** a citation link's rect covers the mark glyph's quad and its
  GoTo names the note's page and lands at the note's first line; the back link
  covers the gutter mark and lands at the citation; a note pushed to the next
  page (the link crosses pages); repeats (two citation links, one back link to
  the first); an endnote on a later page; a table-cell mark; `page.AddMarkdown`
  one rect; a cited URI run (text keeps the URI, mark goes to the note).
- **Tagging:** each `/Link` holds the mark's MCID then its `/OBJR`, under the
  citing `/P` (or `/TD`) and under the `/Note`; `ValidatePdfUa` still passes on
  a tagged flow with notes.
- **Front ends:** one Markdown and one DOCX end-to-end case.
- **Opt-out:** `links: false` writes no annotation and equals the fence.
- **Mutation sweep** at the end.

## Review Focus

1. A note on a DIFFERENT page from its citation: both links cross pages and
   land on the right line.
2. A repeated citation: every citation is clickable; the back link goes to the
   first.
3. A tagged flow with notes: still passes `ValidatePdfUa`, and each link is a
   `/Link` element with content and `/OBJR`.
4. `links: false`: byte-identical to v9j3.3.3.
5. A cited run that is itself a URI link: its words still open the URI.
