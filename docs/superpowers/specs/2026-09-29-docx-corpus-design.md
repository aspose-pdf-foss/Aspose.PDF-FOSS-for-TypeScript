# Real-world DOCX corpus — design (`m2fp.4`)

Epic `m2fp` imports DOCX over the flow engine. `m2fp.3` built the reader
(`readDocx`) and anchored its RESOLUTION rules on a document we wrote and Word
read. This issue anchors the reader on documents OTHER PROGRAMS wrote: a corpus
of `.docx` files from two independent producers, each file read back by two
independent applications, and a test holding `readDocx` to what they agree on.
A reader that handles our own `ToDocx` output well and real documents poorly is
worse than none (the epic's words).

## Decisions taken in brainstorming

1. **Two producers:** Microsoft Word 2010 through COM (already scripted by
   `scripts/gen-docx-word.ps1`) and LibreOffice, a PINNED build obtained as an
   unpacked copy outside the repository — not a system install.
2. **Native authoring:** one content recipe per topic, built natively by each
   application through its own automation (Word COM from PowerShell; LibreOffice
   UNO from its bundled Python), so each writer emits its own conventions.
3. **Two readers of every file:** Word and LibreOffice each read EVERY corpus
   file, their own and the other's. The test asserts only what they AGREE on;
   where they disagree, the disagreement is recorded and pinned.
4. **`readDocx` is tested now**, not left for `m2fp.5`: the corpus proves itself
   useful immediately, and the truth format is exercised by a real consumer.

## Corpus

Five topic recipes, each produced by both writers — ten documents — named for
who wrote them: `word2010-<topic>.docx`, `lo<major>.<minor>-<topic>.docx`.

| Topic | Exercises |
|---|---|
| `styles` | built-in Heading 1–3; a custom paragraph style based on Heading 2; a custom BOLD character style; direct bold, italic, size, font and colour; the toggle case — the bold character style applied inside a paragraph whose style is bold |
| `lists` | a bulleted list nested three levels; a multilevel numbered list (`1.`, `a.`, `i.`); a numbered list interrupted by a plain paragraph and then continued; a second numbered list restarted at 1 |
| `tables` | a table whose first row repeats as a header; a horizontally merged cell; a vertically merged cell; a table nested in a cell; a shaded cell |
| `media` | an inline PNG; an external hyperlink; an internal link to a bookmark |
| `skipped` | a header and a footer; a footnote; an endnote; a text box; a TOC field over the headings; a comment; a tracked insertion and a tracked deletion; a second section in landscape |

The recipes are prose in the two builder scripts, kept in step by hand: same
texts, same order, so the two files of a topic are comparable. The existing
`word2010-basic.docx` stays and gains truth from both readers too.

**Licensing:** every text, picture and structure is ours; each writer adds only
its own defaults (theme, style tables, font tables) — the position PROVENANCE
already records for `word2010-basic.docx`. LibreOffice's own output carries no
licence on the document content.

## Scripts

None of these is run by `npm test`; each needs an application installed.

- **`scripts/gen-docx-corpus-word.ps1`** — builds the five Word documents through
  COM.
- **`scripts/gen-docx-corpus-lo.py`** — builds the five LibreOffice documents;
  run by LibreOffice's bundled Python against `soffice --headless` over a UNO
  socket.
- **`scripts/docx-truth-word.ps1`** — opens any `.docx` read-only in Word and
  writes `<file>.word.json`.
- **`scripts/docx-truth-lo.py`** — opens any `.docx` in LibreOffice and writes
  `<file>.lo.json`.
- **`scripts/gen-docx-corpus.ps1`** — the driver: runs both builders, then both
  readers over every file in `test/fixtures/docx/`, and prints each file's
  SHA-256 for PROVENANCE. It takes the LibreOffice program directory as a
  parameter.

**Obtaining LibreOffice:** the current stable release's Windows x64 MSI from
`download.documentfoundation.org`, unpacked by an ADMINISTRATIVE install
(`msiexec /a <msi> /qn TARGETDIR=<dir>`), which extracts without installing,
into a directory outside the repository. The exact version (`x.y.z.w`) and the
MSI's SHA-256 are recorded in PROVENANCE and in every `.lo.json`; the corpus
file names carry `major.minor`.

## Ground truth

Every corpus file has two truth files beside it, one per reader, in ONE schema so
they compare field for field:

```ts
interface DocxTruth {
  reader: string;                 // "Word 14.0.7268" | "LibreOffice 26.2.1.2"
  paragraphs: {
    text: string;                 // without the paragraph mark or list label
    styleName: string;            // the reader's name for the paragraph style
    heading: number | null;       // 1..9, or null for body text
    listLabel: string | null;     // exactly as the reader displays it
    inTable: boolean;
    segments: { text: string; bold: boolean; italic: boolean; sizePt: number; font: string }[];
  }[];
  tables: { rows: string[][] }[]; // cell texts, row by row, top-level tables in order
  links: ({ text: string; url: string } | { text: string; anchor: string })[];
  images: number;                 // inline pictures in the main story
  counts: { headers: number; footers: number; footnotes: number; endnotes: number;
            textBoxes: number; fields: number; comments: number; revisions: number };
}
```

**Normalizations**, so the two readers and ours are comparable:

- `paragraphs` are the MAIN STORY in document order, table-cell paragraphs
  included — how both applications enumerate it. Headers, footers, notes, text
  boxes and comments are other stories and are counted, not listed.
- `segments` are MAXIMAL runs of identical `(bold, italic, sizePt, font)`,
  concatenating to `text`. Word reports formatting per word and LibreOffice per
  text portion; both readers merge to this shape, and the test merges
  `readDocx`'s runs the same way.
- `heading` is 1..9 or null in both: Word's `OutlineLevel` 10 and LibreOffice's
  0 are body text.
- Empty paragraphs are kept; they are part of the structure.

**Where the readers disagree:** the test computes, per file, the set of JSON
paths at which the Word and LibreOffice truth differ, and asserts it EQUALS a
committed per-file list (`test/fixtures/docx/disagreements.json`). A regenerated
truth that moves the set reddens the build. `readDocx` is asserted only at paths
OUTSIDE that set. Every disagreement is also written up in PROVENANCE, since each
is a finding: two mature readers differing on a document is exactly where an
importer has to choose.

## The corpus test

`test/docx-corpus.test.ts`, per file:

- **Structure:** the flattened paragraph sequence — `text`, `heading`,
  `listLabel`, `inTable` — against the agreed truth; each top-level table's cell
  texts; the links; the image count.
- **Formatting:** each paragraph's merged segments.
- **Skipped constructs:** every nonzero `counts` entry must appear in
  `readDocx`'s `unsupported` under a fixed mapping — footnotes
  `w:footnoteReference`, endnotes `w:endnoteReference`, text boxes
  `w:txbxContent` or `w:pict`, comments `w:commentReference`, fields
  `w:fldChar` or `w:fldSimple`, revisions `w:ins` or `w:del`, headers
  `w:headerReference`, footers `w:footerReference`.

**Expected gaps** the corpus will confirm or refute:

- **Headers and footers are silently ignored today.** `wmlbody.ts` reads only
  `w:pgSz` and `w:pgMar` from a `w:sectPr`, so a document's headers leave no
  record. Fix here: a `w:sectPr` records `w:headerReference`,
  `w:footerReference`, and — when it sits inside a paragraph, i.e. a section
  break — `w:sectPr` itself.
- **Text-box text is kept inline.** `m2fp.3`'s rule keeps an unknown construct's
  text in place, so a text box's text lands in its anchor paragraph, where both
  applications report it as a separate story. The rule stands (visible beats
  dropped); the test removes text-box text from `readDocx`'s paragraphs before
  comparing, and says why.

**Rule for divergences between `readDocx` and the agreed truth:** a small,
local fix in the `wml*` modules is made in this issue, test first; a larger one
is filed as its own issue and pinned in the test as a KNOWN GAP naming that
issue, so fixing it later reddens the pin on purpose. Truth JSON is never edited
by hand, and a pin never asserts less than the current behaviour.

## Fallback

If the pinned LibreOffice build cannot be obtained, or will not run headless
here, the Word half ships alone: five Word documents, Word truth only, the test
unchanged (it asserts against whatever readers a file has, and with one reader
every path is "agreed"). LibreOffice then becomes a follow-up issue.

## Documentation

- `test/fixtures/docx/PROVENANCE.md`: per file — producer and exact version, the
  command, SHA-256, what it covers and does not, and the reader disagreements.
- `CLAUDE.md`: the fixture-table row for `fixtures/docx/` grows to describe the
  corpus; `wmlbody.ts`'s entry records the `sectPr` fix.
- No CHANGELOG entry: nothing user-visible until `m2fp.5`.
