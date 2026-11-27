# Preserve untouched signed inputs on explicit incremental save

1. Extend `test/sign-incremental-survival.test.ts` with byte comparisons for a
   valid signed input, a nested signature without flags and a flag-only input.
   Check unsigned empty fields and trailer-only edits as controls. Run the
   focused suite against the existing writer and observe the failing cases.
2. In the shared sync/async incremental path in `src/document.ts`, recognize
   the protected baseline and reuse the existing object comparison. Retain
   the original bytes only when the trailer and objects agree. Exercise direct
   dictionary edits, existing writer refusals and signature verification.
3. Document the explicit save behavior in the README, save options and
   changelog. Run the focused tests, then typecheck and the full suite on main.
