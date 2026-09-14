/** Matching a language TAG against a language RANGE, RFC 4647 §3.3.2
 *  extended filtering. A leaf importing NOTHING, so every rule below is
 *  testable from two strings.
 *
 *  Its own module because TWO unrelated stacks ask the same question and
 *  neither may reach the other: `htmllang.ts` answers CSS `:lang()`, and
 *  `ocusage.ts` decides whether an optional-content group's `/Usage
 *  /Language` matches the language a caller supplied. `htmllang.ts` value-
 *  imports `bidi.js` for `nodeDirection`, so importing it from the
 *  optional-content stack would drag the UAX #9 tables in behind a
 *  three-line predicate — the extraction `colornames.ts`, `preformat.ts`,
 *  `bordersides.ts` and `datauri.ts` each already made. `htmllang.ts`
 *  re-exports it, so `cssselect.ts`'s import path is unchanged. */

/** Split a language tag or range into lowercased subtags. */
const subtags = (s: string): string[] => s.toLowerCase().split('-');

/** Does `tag` match `range` under RFC 4647 §3.3.2 extended filtering?
 *
 *  The rule Selectors 4 cites for `:lang()`, and the one PDF 32000-1
 *  8.11.4.4's `/Language` usage entry needs. Two halves are easy to get
 *  wrong and each renders plausibly: the match must fall on a SUBTAG
 *  BOUNDARY, so `:lang(en)` matches `en-US` and not `english` — which a
 *  `startsWith` gets backwards — and a SINGLETON subtag may never be skipped,
 *  because a one-character subtag begins an extension and skipping past one
 *  matches across a boundary that means something. */
export function langMatches(tag: string, range: string): boolean {
  if (tag.trim() === '') return false;
  const t = subtags(tag);
  const r = subtags(range);

  // Step 2: the first subtags must be equal, unless the range's is a wildcard.
  if (r[0] !== '*' && r[0] !== t[0]) return false;

  let ti = 1;
  let ri = 1;
  while (ri < r.length) {
    if (r[ri] === '*') { ri += 1; continue; }        // 3.A
    if (ti >= t.length) return false;                // 3.B
    if (t[ti] === r[ri]) { ti += 1; ri += 1; continue; }  // 3.C.iii
    if (t[ti].length === 1) return false;            // 3.C.ii — a singleton
    ti += 1;                                         // 3.C.i — skip and retry
  }
  return true;
}
