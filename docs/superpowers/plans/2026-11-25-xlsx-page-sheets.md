# Page worksheet implementation plan

Implement the [page worksheet design](../specs/2026-11-25-xlsx-page-sheets-design.md) inline under cfgh.3.

1. Exercise the public methods with the Go report layout, blank and selected pages, repeated image placements, explicit limits and literal text. Observe the missing page mode in Vitest.
2. Map PDF content events into a deterministic worksheet grid and bounded image registry. Extend the existing writer with row heights, column widths and worksheet drawing relationships. Share the generator between sync and async entry points.
3. Compare the table and full-page examples from Go commit dfa75dbfb300e6eb5a8e5d2199f81d07ed602916 with openpyxl. Document layout, limits and options, run the repository gates and verify integrated main.
