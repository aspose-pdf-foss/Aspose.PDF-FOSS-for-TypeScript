# Signature structure implementation plan

Implement the [signature structure design](../specs/2026-11-23-signature-structure-design.md) under `eent.3` using TypeScript with NodeNext `.js` imports, Vitest, and zero runtime dependencies. Track the work in Beads.

1. Write verification tests for clean signatures, tail data, PDF whitespace, a normal incremental update, and malformed range data. Keep the fixtures benign and begin with a red run.
2. In `object-parser.ts`, collect the lexical `/Contents` span and duplicate-key evidence for dictionaries with the signature keys. Record this only for objects read at file offsets in `document.ts`, so object streams cannot supply file offsets from decoded bytes.
3. In `xref.ts`, preserve the existing revision lengths for recovery. Record a separately confirmed footer when the parsed section is followed by its own `startxref` and `%%EOF`.
4. In `sigstructure.ts`, define `SignatureStructureFinding` and inspect the range shape, dictionary, signed revision binding and unsigned tail. Wire `structureFindings` into `sigverify.ts`, `document.ts`, and `index.ts`. Guard reads of malformed prefixes used by existing verification paths.
5. Run the focused tests, document the findings in `README.md`, `CLAUDE.md`, and the changelog, and run both quality gates on `main` before closing and syncing `eent.3`.
