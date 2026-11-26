# Source preflight implementation plan

**Goal.** Implement Beads `1t5g.1` so callers can inspect a PDF's original structure before deciding whether to open it.

**Design.** [Source preflight before recovery](../specs/2026-11-26-source-preflight-design.md)

**Implementation.** TypeScript, the existing lexer, COS and cross-reference parsers, and Vitest. Track work in Beads. Each task starts with a failing assertion through the public entry point.

## Public report and cross-reference checks

1. In `test/source-preflight.test.ts`, use `buildClassicPdf`, `buildXrefStreamPdf` and `corruptStartxref`. Expect clean reports from both healthy files, and a malformed xref finding from the damaged file. Compare `Document.Open` on that same byte view with the original page count and check its recovery reason. Include a missing or malformed header, missing footer, and an input exceeding `maxFileBytes`. Verify the entire backing buffer stays byte-identical for a nonzero-offset input view.
2. Run `npx vitest run test/source-preflight.test.ts` and confirm the missing API causes the failure. Add `Document.Preflight(bytes: Uint8Array, options?: { limits?: LoadLimits }): SourcePreflightReport` in `src/document.ts`. Define the inspection and report types in `src/preflight.ts`, export the public types from `src/index.ts`, and share the bounded header read with Open.
3. In preflight, enforce the file bound before inspecting any bytes. Use one decode budget with `readXref` and consult `revisionFooterEnd` for each revision. Adapt a typed resource error to a terminal finding at the public reporting boundary in `src/errors.ts`. Preserve immediate limit propagation inside every parser catch. Assert the limit fields and verify an unsupported xref filter gets a distinct category. Run the focused suite again.

## Objects, streams and trailer

1. Add cases for a stale offset, a wrong object number or generation, a missing end marker, an incorrect stream length, and a valid indirect length with marker-like bytes in the payload. Test valid compressed and incremental saves, a freed object, a missing catalog, and a compressed xref entry whose index disagrees with its container. Check a parser limit after the header and xref have passed. Confirm each new case fails for its intended reason.
2. Visit live xref entries using the existing `ObjectParser` and check each offset against the parsed header. Reuse or extract source checks in `src/object-parser.ts` to verify stream boundaries and indirect lengths with cycle protection. Preflight must see a length mismatch before Open's marker-scan fallback. Check the trailer's effective catalog against the live entries.
3. Share the object-stream header reader in `src/objstm.ts` with a strict inspection path. Decode each inspected container once, using the shared budget, and compare its indexed members with the xref entries. Exercise an encrypted container as unsupported inspection and an unreadable member as malformed. Ensure independent object findings retain their object numbers. Rerun the focused tests and the existing recovery and load-limit suites.

## Public documentation and verification

1. Add the public types, method, and an example comparing preflight with Open to `README.md`. Update its export counts from `test/readme-api.test.ts`. Record the user-visible feature in `CHANGELOG.md` and document `preflight.ts` in `CLAUDE.md`.
2. Run `npm run typecheck` and `npm test`. Verify that source findings survive a successful recovery comparison, that compressed and incremental files remain clean, and that limit failures stop later work. Complete the repository's merge, verification, Beads and push workflow.
