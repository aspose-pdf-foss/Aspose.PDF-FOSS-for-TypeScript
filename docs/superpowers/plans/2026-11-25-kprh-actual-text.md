# Opt-in marked-content text extraction

Callers can request `{ actualText: true }` on `Page.GetText` and `Page.Search`. A replacement covers its enclosing marked sequence, including nested content and glyphs painted by Forms. Search for any part of a replacement returns the glyphs and line boxes for the whole span. The default read path and all editing operations use decoded glyph text.

1. Exercise both public methods with inline and named property lists, nested and adjacent spans, multi-line replacements and repeated Form invocations. Check raw glyph geometry and edit behavior on the same fixtures.
2. Track the enclosing replacement by occurrence during the content walk. Use the existing line layout for placement and share the semantic text and provenance between extraction and search.
3. Document the option, run the focused tests, typecheck and full suite, then verify on main before closing the issue.
