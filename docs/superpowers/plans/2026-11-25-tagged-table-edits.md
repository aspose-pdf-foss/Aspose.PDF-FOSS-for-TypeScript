# Tagged table editing

The approved design for kprh.7 keeps the table's reading-order position on replacement. The builder supplies the new rows, cells, and header scopes. Removal releases the table's content identifiers and detaches its structure. References from surviving elements to disappearing cells must fail before publication.

1. Exercise both operations through `page.GetTables()` on an imported tagged PDF. Reopen the result and check the parent tree, surviving marked content, and replacement semantics. Exercise external references and a redraw failure.
2. Bind the extracted handle to its source table. Validate ownership of marked content and decoration, then prepare content edits and private copies of the affected structure dictionaries. Publish them through the existing table transaction.
3. Use the tagged authoring path to paint fitted replacements. Document supported inputs and verify with the focused tests, typecheck, and the full suite on main.
