# Export detected tables to XLSX (cfgh.2)

Document.ToXlsx and ToXlsxAsync return workbook bytes. Both drive one resumable operation over the existing table detector, continuation matcher and SpreadsheetML writer. Callers can select pages and logical tables by one-based number. Selection retains document order. A gap in selected pages breaks stitching.

Place each logical table on its own sheet. Emit nested tables depth-first in cell order immediately after their parent. Give every worksheet a unique numeric identifier. A nested sheet's name identifies its parent worksheet and the anchor cell in that worksheet. Preserve each cell's extracted text and translate spans into XLSX merges.

Use the original page tables when reporting losses. A repeated first row may be discarded on a continuation when it repeats the leader's header according to the stitcher. Retain a repeated row that contains a nested table or spans into subsequent rows. Report removed rows, PDF-only table metadata and styling through an optional onSkipped callback. An empty selection produces one blank sheet and a diagnostic. Test PDF inputs through both public entry points and open generated workbooks in an independent reader.
