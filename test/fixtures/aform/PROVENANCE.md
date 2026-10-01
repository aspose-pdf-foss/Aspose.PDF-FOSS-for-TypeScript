# AForm goldens (jzn8)

**Producer:** pdf.js, `src/scripting_api/aform.js` and `util.js`, an independent
Apache-2.0 reimplementation of Acrobat's AForm functions.
**Commit:** `d52fdf411a6e4d338180687456e0df019e28475e`
**Command:** `npm run gen:aform` (`scripts/gen-aform-goldens.mjs`), run under
`TZ=UTC` (the script switches to it and refuses to run otherwise). Running it
twice produces byte-identical files.

## Sources (SHA-256 of each file as fetched)

| File | SHA-256 |
|---|---|
| src/scripting_api/aform.js | `dd032e82b5311b25505568591f7855b7988e0dd53be57d402784c84c33365d85` |
| src/scripting_api/util.js | `c05cc5300e47144cf53a5321a5d25c70358fb5fe4cde151bee48d25cb874a686` |
| src/scripting_api/constants.js | `0c62f65e3555a5a8c97c7ac5a80929c18eb94a149545fa6c7c9481b3be153c63` |
| src/scripting_api/pdf_object.js | `aef78c9f548a2ea054362fadae2b0799acadd0e5ab4a416d9e775586bf2d3da4` |
| src/shared/scripting_utils.js | `a9b84a04f6a39b1e6ce647bafd3a88ca715aed4fbf5b9d14e20a79429f2c3b71` |
| src/shared/math_clamp.js | `177a9924f860fa5d6016284924f2296921811af2b9eb2400c32bb95d7a18fb97` |

## Cases

| File | Cases |
|---|---|
| number-format.json | 9120 |
| percent-format.json | 760 |
| number-keystroke.json | 140 |
| date-format.json | 591 |
| date-keystroke.json | 597 |
| special-format.json | 36 |
| special-keystroke.json | 107 |
| range-validate.json | 80 |
| simple-calculate.json | 17 |
| **total** | **11448** |

Of these, 399 `date-format` cases and 399 `date-keystroke` cases are
`strict: false` (see below).

## How the generator drives pdf.js

- A fresh `Util` and `AForm` for every case: `util.js` caches its date regex
  with the `/g` flag, so a reused instance alternates between matching and
  failing on the same input.
- `Math.sumPrecise` and `Map.prototype.getOrInsertComputed` are polyfilled,
  since Node 24 has neither. The `sumPrecise` polyfill is exact BigInt
  arithmetic, deliberately a different algorithm from `src/afcalc.ts`'s
  Shewchuk summation, so the two cannot share a rounding bug.
- A stub `event` with `willCommit: true`: keystroke cases are commit-time
  checks only.

## What this does NOT establish

- **pdf.js is not Acrobat.** Agreement is evidence, not conformance, and where
  the two differ we match pdf.js knowingly.
- **Strict date matching only.** A date case where pdf.js's strict parse fails
  is recorded with `strict: false` and no pdf.js answer, because pdf.js's
  fallbacks default the year to the current year and call `Date.parse`. The
  suite asserts OUR behaviour for those cases (value left unformatted, rejected
  by the keystroke check), and asserts their count against `meta.json`.
- **No red text.** Negative styles 1 and 3 change the text colour in a viewer.
  That is outside what a golden records, and outside what we implement.
- **Group expansion and `/CO` order** are library behaviour, not pdf.js
  function behaviour, and are covered by `test/aform-recalc.test.ts`.

## Real form: `real/dates.pdf`

The goldens prove the semantics; only a file we did not write proves the
recogniser accepts scripts Acrobat actually writes.

- **Source:** `test/pdfs/dates.pdf` in pdf.js at commit
  `d52fdf411a6e4d338180687456e0df019e28475e`, added by commit `57ce4f8f4`
  ("Use a HTML date/time input when a field requires a date or a time",
  Calixte Denizet, 2025-07-22).
- **Producer:** Adobe Acrobat (64-bit) 25.1.20577 (its own `/Creator` and
  `/Producer`).
- **SHA-256:** `7bf9b6c569b52adf0c73ff608aa0353d7e8dd22e9cdb97eed95b38bba2a66027`
- **Why it may be vendored:** it was authored by a pdf.js maintainer for that
  feature commit, in a repository licensed Apache-2.0, and nothing in its
  history traces it to an outside report. The 12 other corpus files carrying AF
  scripts (`bug*.pdf`, `issue*.pdf`) were NOT vendored: each reproduces a user
  report, so it may be a document the reporter owns.
- **What it holds:** 6 field scripts that call an AF function. 5 are
  recognised. The sixth, `AFTime_Keystroke("HH:MM:ss");`, passes a picture
  string where the function takes a format index; pdf.js turns it into a no-op,
  and we report it as unrecognised rather than guess.

Scan of the whole corpus at the pinned commit (982 committed PDFs): 13 carry AF
scripts, 63 such scripts in all, 59 recognised. The 4 misses are 2 expressions
in `bug1918115.pdf` (`event.value = AFMakeNumber(...) * ...`, not one call) and
the string-argument `AFTime_Keystroke` above, in both `dates.pdf` and
`dates_save.pdf`.
