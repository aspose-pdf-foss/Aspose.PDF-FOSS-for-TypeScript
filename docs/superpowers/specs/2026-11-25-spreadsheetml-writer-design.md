# Minimal SpreadsheetML writer (cfgh.1)

The tables-first exporter needs a way to turn ordered sheets into workbook bytes. An internal `writeXlsx` takes named sheets, rows of strings, finite numbers, booleans or blanks, and rectangular merged ranges. Array positions and merge origins are zero-based. A merge retains its top-left value and may extend into blank space.

Use inline strings so the writer can emit each worksheet independently. Source types determine cell types. A leading zero, equals sign or other prefix in a string stays part of the text. The existing OPC package builder derives content types and relationship parts and delegates compression to the ZIP writer.

The alternative of shared strings would require a workbook-wide index and a separate part. The initial table writer needs no such index. PDF table selection, type inference and the public export API belong to cfgh.2.

Verify both the OPC graph and the values seen by an independent XLSX reader. Keep the core and its runtime dependency-free.
