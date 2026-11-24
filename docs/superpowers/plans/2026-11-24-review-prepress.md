# Review and prepress implementation plan

1. Exercise shape border dictionaries, dash operators and line leader endpoints. Implement typed creation and editing plus regeneration and fallback appearances in the annotation writer.
2. Verify FreeText default appearance strings, font resources, visible inset/effect geometry and font use after save/reopen. Reuse the existing font and appearance machinery.
3. Test link activation modes and border width through Page.AddLink and reopened LinkAnnotation handles, including indirect and shared producer dictionaries. Retain explicit destinations, actions and custom appearances.
4. Exercise page-information labels on individual and selected pages in annotation and static content modes. Validate geometry and options across the full selection before writing marks.
5. Document public types and defaults, run the targeted tests, inspect rendered output, and run both repository quality gates before delivery.
