# DOCX footnotes and endnotes (v9j3.3.2) — design

## Purpose

`AddDocx` stops reporting Word footnotes and endnotes as `dropped` and renders
them through the Flow footnote engine shipped in `v9j3.3`. Word's numbering
properties are honoured — format, start, and restart per section and per page —
which needs two small engine additions. The oracle is the `m2fp.4` corpus,
regenerated with notes by Word 2010 and LibreOffice 26.8.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Oracle | Word 2010 (COM) and the unpacked LibreOffice 26.8 (UNO), both run here, as `m2fp.4` did. |
| A reference in a table cell | Draws nothing and is reported `w:footnoteReference (table cell)` / dropped, until `v9j3.3.3` lifts it for Markdown and DOCX together. |
| Numbering | Full: `numFmt`, `numStart`, and `numRestart` both `eachSect` and `eachPage`. |
| Per-page restart | Lazy numbering per column offer (approach A): a mark never changes after its line is PLACED. |
| Endnotes at section end (`pos="sectEnd"`) | A placement feature, not numbering: reported degraded. |

## Engine additions (`flownotes.ts`, `flow.ts`)

**1. Per-section restart.** `flow.RestartNotes(kind?: 'footnote' | 'endnote')`
(both when omitted, chainable) enqueues a `note-restart` sentinel, like
`AddColumnBreak`'s. The numbering pass resets that kind's counter to its
`start` when it reaches one; placement skips it. `notesAsTrailing` honours
sentinels in its own pass. A flow that never calls it is unchanged.

**2. Per-page restart.** `FlowNoteOptions.restart?: 'continuous' | 'page'`
(footnotes only; Word offers nothing else for endnotes, and
`FlowEndnoteOptions` refuses `'page'` with a `TypeError`). Default
`'continuous'`. Under `'page'`:

- the up-front pass skips footnote references (endnotes are still numbered
  there);
- when an element is offered to a column — before any probe or settle — each
  of its UNCOMMITTED footnote references is numbered `start + (footnotes
  committed on this page so far) + its position among them`;
- `NoteNumberer.assign` may run again for such a reference: it rewrites the
  mark and REBUILDS the body, since the gutter width depends on the mark;
- a reference whose line moves to the next page, or that rides a split
  element's remainder, is renumbered at its next offer; a committed reference
  is final;
- a repeat keeps its first citation's mark, as now (a DOCX never repeats);
- the module invariant becomes "a mark never changes after its line is
  PLACED" — every measurement already happens in the column the line is then
  placed in, so a line is never placed at a width measured for another mark.

In one rect (`notesAsTrailing`) per-page restart is per call, since a rect is
one page.

**Byte-identity.** With neither feature used, the code path is today's: the
v9j3.3 and v9j3.3.1 suites stay unedited, and a hash fence over representative
note flows is recorded BEFORE the placement loop is touched.

## Reading (`wmlread.ts`, `wmlbody.ts`, new `wmlnotes.ts`)

- **Parts.** `footnotes.xml` and `endnotes.xml` are found through the main
  document's relationships by type (Strict twins too), as `styles.xml` is;
  `settings.xml` likewise. Each notes part is parsed by
  `parseNotes(bytes, ctx)` (**amended:** it lives in `wmlbody.ts`, beside
  `parseBody`, needing the module-private `Walker`) into `Map<string, WmlBlock[]>` keyed by `w:id`,
  through the SAME `Walker` the body uses, so a note's paragraphs, lists,
  tables, images and links resolve by the body's rules.
- **Relationships.** Each notes part resolves `r:id`s against ITS OWN
  relationships (`pkg.relationships(part)`) — an image or hyperlink in a note
  names `footnotes.xml.rels`, never the document's.
- **Separators.** Entries with `w:type` `separator`, `continuationSeparator`
  or `continuationNotice` are skipped; the engine draws its own rule.
- **Damage.** A part that is missing or unreadable is recorded
  (`footnotes.xml: missing` / `: unreadable`) and its references fall back to
  `dropped`, as `styles.xml` degrades. A reference naming an id with no entry
  is recorded (`w:footnoteReference (unknown id)`) and dropped.
- **Reference.** `w:footnoteReference` / `w:endnoteReference` in a run becomes
  `{ kind: 'note', note: 'footnote' | 'endnote', id: string, mark?: string }`.
  With `w:customMarkFollows="1"` the run's following `w:t` text is the mark,
  not body text. `w:footnoteRef` / `w:endnoteRef` (Word's number inside the
  note body) is dropped silently — the engine draws the gutter mark.
- **Numbering properties.** `settings.xml`'s `w:footnotePr` / `w:endnotePr`
  are the document defaults (`numFmt`, `numStart`, `numRestart`, `pos`); a
  section's `sectPr` overrides them. A paragraph ending a section
  (`pPr/sectPr`) gains `sectionEnd: { footnotePr?, endnotePr? }`; the body's
  final `sectPr` is the last section's. Only what is stated is kept.
- **Model.** `WmlDocument` gains `footnotes`, `endnotes` (id → blocks) and
  `notePr` (the settings defaults and the last section's). No reference is
  recorded unsupported any more, except in a table cell or for an unknown id.

## Mapping (`wmlflow.ts`, `wmlruns.ts`, `wmlimport.ts`)

- One `FlowNote` per referenced id, built once, its content the note's blocks
  through the same block mapper the body uses, at the note's OWN resolved Word
  styles (Footnote Text, usually 10pt) — no library size.
- A `note` inline becomes an empty run carrying `footnote` / `endnote` in its
  run's style, a merge barrier both ways (the Markdown rule). A custom mark
  sets `FlowNote.mark`.
- In a table cell: no run, reported `w:footnoteReference (table cell)` /
  dropped (or the endnote spelling).
- Resolution, from the LAST section's properties (as page geometry is):
  - `numFmt`: decimal → `arabic`, lowerRoman → `roman`, upperRoman → `Roman`,
    lowerLetter → `alpha`, upperLetter → `Alpha`, chicago → `symbols`; any
    other → `arabic`, reported `w:numFmt (footnote)` / degraded.
  - `numStart` → `start`.
  - `numRestart`: `eachSect` → a `RestartNotes(kind)` after every
    section-ending paragraph; `eachPage` → `footnotes.restart: 'page'`.
  - A section whose `numFmt` or `numStart` differs from the last section's is
    reported degraded (the engine has one format per flow).
  - Non-default placement — footnote `pos` `beneathText` / `sectEnd` /
    `docEnd`, endnote `pos` `sectEnd` — reported degraded.
- The engine's per-kind note `fontSize`, which sizes the gutter mark, is the
  first note's first paragraph's resolved size (default 10).
- `doc.AddDocx` and `flow.AddDocx` render through the Flow; `page.AddDocx`
  uses `notesAsTrailing` with tagging under a `structParent`. Tagged output
  makes one `/Note` per note.

## Oracle

- The two corpus generators (`gen-docx-corpus-word.ps1`,
  `gen-docx-corpus-lo.py`) gain a `notes` recipe: several footnotes, one of two
  paragraphs and one holding a list (**amended:** no list — LibreOffice's
  list-style names vary by version, so a list in a note is held by hand-built
  cases); an endnote; a custom mark (`*`); a second
  section with lowerRoman footnotes restarting each section; a footnote in a
  table cell.
- The truth scripts gain, per note, its kind, its text, and the mark each
  reader shows (Word: `Footnotes(i).Reference` text / `Index`; LibreOffice:
  `getLabel()` / the anchor string).
- `test/docx-corpus.test.ts` holds `readDocx`'s notes, and the marks the
  mapping computes for continuous and per-section numbering, to what both
  readers agree on, under the corpus's existing disagreement discipline.
- Per-page numbering depends on pagination we deliberately do not share with
  Word, so it is held by hand-built engine tests alone; PROVENANCE says so.

## Testing

- Engine: per-section reset; per-page renumbering of a moved line, of a split
  remainder; committed marks final; endnotes unaffected by `'page'`;
  `'page'` on endnotes refused; byte-identity fence.
- Reader: both parts and their own relationships, separators skipped, custom
  mark, `footnoteRef` dropped, unknown id, missing and unreadable parts,
  settings and section properties.
- Mapping end to end through all three entry points: marks and bodies, a list
  and a table in a note, formats and starts, per-section restart, table-cell
  reference reported, tagged output (one `/Note`, PDF/UA), a note-free DOCX
  byte-identical.
- Mutation-check each rule; PROVENANCE records rules only hand-built tests hold.
