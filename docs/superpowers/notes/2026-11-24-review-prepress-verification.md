# Review and prepress round-trip verification

A two-page proof combined a dashed line with a negative leader length and an arrow ending, an embedded-font FreeText annotation with a cloudy inset box, and a GoTo link targeting page 2. Page 2 carried a page-information mark with a supplied job label and timestamp.

After a full save and reopen, the decoded normal appearance streams and the rendered PNGs for both pages had the same SHA-256 hashes as before reopening. The annotations reopened as their original types. The link retained its push highlight and page 2 destination. `qpdf --check` reported no syntax or stream encoding errors.

The targeted tests also cover the positive leader direction, clipping of plain and rich text, regeneration with an imported font encoding, and full and incremental saves from PDF 1.4. Separate page-information tests exercise content and annotation output, page selection, shared appearance dictionaries, and validation before the first selected page is modified.
