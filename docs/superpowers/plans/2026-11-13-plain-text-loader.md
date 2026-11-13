# Plain-text Loader Implementation Plan

Execution: inline; Beads `nh1t.5` owns task status.

**Goal:** add monospace plain-text import with form-feed page breaks and a file wrapper.
**Spec:** `docs/superpowers/specs/2026-11-13-plain-text-loader-design.md`.
**Architecture:** `src/plaintext.ts` owns validation, text normalization, strict
font coverage and per-section Flow preparation/rendering. `document.ts` delegates;
`node.ts` handles bounded file reads, decoding, font bytes and final writes.
**Tech stack:** existing Flow/codeBlock, authoring fonts and operation generators;
Node built-ins; TypeScript/Vitest. Zero added runtime dependencies.

## Review focus

Pin empty/edge form feeds, CR/LF and blank lines, tabs/indentation, long-line and
page overflow, unsupported characters in a later section before mutation,
invalid options before mutation, Unicode through an embedded monospace font,
BOM precedence and malformed encoding, output preservation on refusal, and
cancellation/control capture. Document every new public export and update the
compiler-reported README counts.

## Implementation

1. Write failing tests in `test/plaintext.test.ts` and `test/plaintext-file.test.ts`
   against literal expected page text and geometry; use the existing Liberation
   Mono font for Unicode. Observe missing API failures before implementation.
2. Implement `PlainTextOptions`, shared `addPlainTextSteps`, sync/async drivers
   and strict byte decoding in `src/plaintext.ts`. Add the two Document methods,
   `TextFileOptions`/`textFileToPdf`, and exports in `src/index.ts`. Verify targeted
   tests, including mutation-sensitive form-feed and unsupported-glyph cases.
3. Add README capability/example/API/type rows, an Unreleased changelog entry and
   the module architecture note in CLAUDE.md. Run the README export test, copy
   its actual counts, and review the complete diff.
4. Run `npm run typecheck` and `npm test`; commit and merge into main, repeat both
   gates on main, close the issue, commit its audit entry, push main, delete the
   merged branch and sync Beads with `bd dolt push`.
