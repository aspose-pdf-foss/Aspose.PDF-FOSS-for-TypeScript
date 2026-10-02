# Comparison fixtures — two revisions of one Word document

Two PDFs of one document, before and after a KNOWN list of edits, for
`test/compare-real.test.ts` (`aq4a.6`). The point of the pair is that the
expected comparison does not come from this library: the edits were made in
Word by `scripts/gen-compare-word.ps1`, so a comparison that disagrees with the
list below is wrong, whatever our own diff thinks.

## Producer

- **Microsoft Word 2010**, version 14.0, build 14.0.7268 (Russian UI), driven
  through COM automation, PDF written by `Document.SaveAs2(path, 17)`
  (`wdFormatPDF`). `ExportAsFixedFormat` hung with no visible dialog on the
  two-page document while working on a one-line one; `SaveAs2` did not hang.
- **Command:** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-compare-word.ps1`
  (NOT run by `npm test`: it needs Word).
- **Not reproducible byte for byte.** Word stamps each PDF with its creation
  time, so a rerun writes different bytes. The vendored files are the
  reference, and the test pins their SHA-256.

## Font

The text is set in **Liberation Sans 2.1.5** (SIL OFL 1.1), Regular and Bold,
from this repository's `fonts/` directory (`LiberationSans-Regular.ttf`
sha256 `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8`,
`LiberationSans-Bold.ttf` sha256
`788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173`). They were
made visible to Word for the run only, through GDI's `AddFontResource`, and
unloaded afterwards — nothing was installed. Word embeds a subset of each,
which the OFL permits. The script refuses to keep a PDF that names any other
font, so no Microsoft font reaches the repository; both files embed exactly
`ABCDEE+Liberation#20Sans` and `ABCDEE+Liberation#20Sans,Bold`.

## Files

| File | Bytes | SHA-256 |
|---|---|---|
| `word2010-rev1.pdf` | 74,548 | `cc5135f9469326b751b60be1cb034b9719b0c0e5a7268d7681e6780d211ff59b` |
| `word2010-rev2.pdf` | 75,981 | `0c50a8efdb25357344f9f987124c5b95e9fc870b7e4a780d5e1a54fc9472e7ad` |

Both are A4 (595.32 × 841.92), two pages, tagged (Word writes a structure tree
by default). The document is a heading, three short paragraphs, and 30
two-line "Clause N." paragraphs; 11pt body, 18pt bold heading, 6pt after each
paragraph.

## The edits (rev1 → rev2), which are the oracle

| # | Edit in Word | What a comparison must report |
|---|---|---|
| E1 | Heading "Service Agreement" recoloured red | **No text change.** A rendering change over the heading. |
| E2 | `thirty days` → `sixty days` | delete `thirty`, insert `sixty` |
| E3 | Sentence `Late delivery incurs a penalty of two percent per week.` deleted | together with E4, one change |
| E4 | A five-line paragraph inserted right after it (`All prices exclude value added tax, …`) | together with E3, one change |
| E5 | `The colour of` → `The color of` | delete `colour`, insert `color`; at character granularity, delete `u` |
| E6 | `last day of December.` → `last day of November.` (last clause, page 2) | delete `December.`, insert `November.`, on page 2 |

E4 is long enough to push Clause 17 from the foot of page 1 to the top of
page 2. That is no change in document mode and a deletion on page 1 plus an
insertion on page 2 in pages mode — the case that tells the two modes apart.

## What these files found

The fixture found a real defect on its first run. E3 and E4 share the word
`of`, and the MINIMAL word diff anchors on it, splitting one rewrite into two
delete/insert pairs around a lone `of`. `CompareText` gained a semantic cleanup
(`cleanup: 'semantic'`, the default) that folds such an equality into the
change. The first version of that cleanup used diff-match-patch's `<=` rule and
then merged E4 with E5, because the one-word equality `The` between them is as
long as the one-word edit `colour` → `color`. On words that equality is a
landmark, so the rule is strictly shorter (`<`). Both readings are held by this
test: dropping the cleanup and loosening it to `<=` each turn it red.

## What these files cover, and what they do not

**Covered:** Word 2010's PDF writer — subset TrueType with `/ToUnicode`, its
text positioning and line breaking, and its tagged structure — through text
extraction, word and character comparison, both comparison modes, change
placement, the side-by-side document and the rendering comparison.

**Not covered:**

- **One producer.** LibreOffice, used for the DOCX corpus, was no longer
  unpacked on the machine. A second producer would test a different PDF
  writer against the same edit list.
- **Latin text only,** with no ligatures, kerning, hyphenation or justification.
- **No tables, images, lists or columns,** and no change to page size.
- **No real-world document history.** The edits are authored, which is what
  makes them an oracle, but a document edited over months by several people
  produces messier differences than six clean ones.
