# AutoTag annotation implementation plan

1. Exercise mixed link, note and widget annotations on a text page. Assert structure reading order, OBJR page and target, reverse parent-tree lookup, page tab order and preservation of text and rendering after reopening.
2. Exercise repeated references, previously tagged annotations, missing page pointers and forced re-tagging. Verify table-cell placement and annotation-only pages.
3. Extend the shared annotation writer and the layout pass in AutoTag. Document the report count, eligible annotations and reading-order rules.
4. Run the targeted structure and AutoTag suites, typecheck and the full test suite before integration.
