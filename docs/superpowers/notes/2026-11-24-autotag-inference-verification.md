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

The initial run disabled table detection on the last two PDFs because nested-table extraction exceeded the call stack. After the `scsg` fix, default `AutoTag()` tagged one table on each of their three pages. All three pages retained their extracted text and the SHA-256 hash of their rendered image at scale 0.35 after saving and reopening. The automated fixtures check the expected hierarchy and reading order separately.
