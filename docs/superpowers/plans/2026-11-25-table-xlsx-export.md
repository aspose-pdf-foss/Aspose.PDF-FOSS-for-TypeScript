# PDF table to XLSX implementation plan

Implement the [approved export design](../specs/2026-11-25-table-xlsx-export-design.md) inline. Track status in Beads under cfgh.2.

1. Add public-API tests with tagged nested and spanning PDF fixtures, and a multipage ruled fixture containing identifiers, formula-like text and repeated headers. Verify their failures before implementing the methods.
2. Share the continuation grouping and repeated-header comparison in src/tablestitch.ts. Map original per-page cell coordinates to destination rows and XLSX merges in src/xlsxexport.ts. Connect both Document methods to the existing operation drivers. Test noncontiguous selection, empty results, omissions, progress and cancellation.
3. Document selection, provenance, worksheet order and format losses in README.md, CHANGELOG.md and CLAUDE.md. Use openpyxl to check extracted workbooks. Run typecheck and the full suite on the feature branch and integrated main, then push and sync the closed issue.
