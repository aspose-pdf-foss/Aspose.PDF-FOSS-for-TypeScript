# Atomic Node output implementation plan

Implement the approved [design](../specs/2026-11-27-atomic-node-output.md) using Node filesystem primitives and no runtime dependencies.

1. Add filesystem regression tests for partial writes, failed publication, occupied symlinks, competing writers and a conflict midway through a split.
2. Extend `src/fileoutput.ts` with an asynchronous staged writer. Flush and close before rename or exclusive hard-link publication. Clean up staged files on failure and after successful linking.
3. Route every writer in `src/node.ts` through it, expose a shared output options type via `src/index.ts`, preserve helper-specific options and cancellation, and exercise the public entry points.
4. Document defaults, hard-link support and partial batch outcomes. Run typecheck and the full suite on main before closing cqzf.4.
