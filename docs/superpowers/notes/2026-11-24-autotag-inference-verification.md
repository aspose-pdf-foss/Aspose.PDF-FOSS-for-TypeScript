# AutoTag inference corpus verification

The automated AutoTag tests construct PDFs with explicit expected role trees. They exercise outline and threshold headings, ambiguous titles, split marker/body text, nested and wrapped lists, table boundaries, annotated items, interleaved drawing streams, pagination artifacts and caller-confirmed watermarks. The combined document checks logical order after reopening, along with extracted text and rendered pixels.

For a separate producer corpus, AutoTag ran with furniture detection enabled on six untagged PDFs in the Go reference testdata. Each of the 19 pages retained the same extracted text and the same SHA-256 hash of its rendered image at scale 0.35 after saving and reopening. The post-tag structure roles and logical text also matched across reopening.

| PDF | Pages | Table detection |
| --- | ---: | --- |
| PdfWithLinks.pdf | 2 | Enabled |
| PdfWithImages2.pdf | 1 | Enabled |
| marketing.pdf | 2 | Enabled |
| openpdf-demo-generation.pdf | 11 | Enabled |
| PdfWithTable.pdf | 2 | Disabled |
| word-umlauts.pdf | 1 | Disabled |

Beads issue `scsg` tracks the nested-table extractor recursion encountered with table detection enabled on the last two PDFs. The corpus comparison checks preservation and round-trip stability. Expected hierarchy and reading order are asserted separately by the automated fixtures.
