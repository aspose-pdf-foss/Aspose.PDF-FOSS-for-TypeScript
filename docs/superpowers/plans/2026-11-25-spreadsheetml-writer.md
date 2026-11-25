# Minimal SpreadsheetML writer implementation plan

Implement [the approved design](../specs/2026-11-25-spreadsheetml-writer-design.md) inline using TypeScript, Vitest and the existing OPC package builder. Track work in Beads under cfgh.1.

1. Add an ordered two-sheet fixture under `test/helpers/` with strings, numbers, booleans, blanks and a merge crossing column Z. Write tests in `test/xlsxpackage.test.ts` for package parts, relative relationships, literal text and coordinates. Run the focused suite and confirm the missing writer causes failure.
2. Implement `writeXlsx(sheets)` in `src/xlsxpackage.ts`. Declare workbook and worksheet parts and relationships through `buildOoxmlPackage`. Encode source types, preserve XML-sensitive text and significant whitespace, and validate worksheet names, grid bounds and merges. Cover empty sheets, duplicate names, overlapping ranges, covered values and non-finite numbers.
3. Record the module in `CLAUDE.md`. Open the same fixture with openpyxl and check values, data types and merges. Run typecheck and Vitest on the feature branch and on integrated main, then close and sync the issue.
