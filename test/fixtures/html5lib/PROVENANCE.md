# html5lib-tests tokenizer suite — provenance

The official conformance suite for the WHATWG HTML tokenizer, here to validate
`src/htmltoken.ts` against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-26-html5-tokenizer-design.md`.

**Source:** <https://github.com/html5lib/html5lib-tests>, the shared test suite
maintained by the html5lib project and used by browser engines and independent
implementations alike (MIT). Downloaded verbatim, not regenerated.

**Commit:** `224991ec10db04f056a89eed8b0bd8695fd2950e` (2026-06-26).

### Command

```bash
mkdir -p test/fixtures/html5lib/tokenizer
for f in contentModelFlags domjs entities escapeFlag namedEntities numericEntities \
         pendingSpecChanges test1 test2 test3 test4 unicodeChars \
         unicodeCharsProblematic xmlViolation; do
  curl -fsSL "https://raw.githubusercontent.com/html5lib/html5lib-tests/224991ec10db04f056a89eed8b0bd8695fd2950e/tokenizer/$f.test" \
    -o "test/fixtures/html5lib/tokenizer/$f.test"
done
```

| File | Bytes | SHA-256 |
|---|---|---|
| `contentModelFlags.test` | 3,055 | `77784a505a528950761cfb3c76617afade28b27c3be2a8c37dce3c3d8988391d` |
| `domjs.test` | 13,430 | `3273e7861bbdb094571e4b0813ffdd934fe2bfd65864600fef62e8e3b807131a` |
| `entities.test` | 19,147 | `fe17483810a00247579f5f129ca9c007fbab6755ba839523e29aa9f8875f4085` |
| `escapeFlag.test` | 1,378 | `edbd2e070a14fc67f6bbc104e50207f0fe206a21891c260deea3d227b32c93c9` |
| `namedEntities.test` | 1,128,317 | `a7f0e59ff7653820330548776cb3031c18e45f5fd1481a9813d9c7acee89bd6e` |
| `numericEntities.test` | 49,842 | `679296c976252322ece27e2b113a5358a0aa3b0b8ecd2d6d9b365f9d1b0f9632` |
| `pendingSpecChanges.test` | 162 | `6b56d81ca09afa47d8cb0f33e3fb7169010c3a64493e608ebec921ac098ff8e9` |
| `test1.test` | 10,006 | `524fcfa4d561a14f0c4e72e0573549abe6341fd4dfb8e16bc2dcf59a608a7219` |
| `test2.test` | 8,647 | `f6450e77760cea823258de86f8e08894a1815671dbec0d74e7fbdab075596e37` |
| `test3.test` | 349,970 | `9912fa27f03344243f1baa96d9690a5c2a4a9c9426c70da5cbf5c62391d62de4` |
| `test4.test` | 16,339 | `c4967118aecbf8eb2ca34d5c5306f536614acca03e58610f75fbd9efa89fbb42` |
| `unicodeChars.test` | 43,771 | `22b7263a840da38179b13693bbfe72f0507dcd41951622456a0d3f5300ba42bd` |
| `unicodeCharsProblematic.test` | 1,107 | `3c166d5cfa24ee60fd7310ff0f5057e4ae0c649842ec446b5949215759e19a68` |
| `xmlViolation.test` | 442 | `193a2f52d81adb4df4e056e3489f3bae79b3fc65253ccf31423a0e2f9c128d5c` |

1,645,613 bytes in total, of which `namedEntities.test` alone is 1.1 MB — it
exercises all 2231 named references in both spellings, which is precisely the
rule `src/mdentity.ts`'s legacy predicate exists for.

## Shape

Each file is a JSON object with a `tests` array. A case carries `description`,
`input`, and `output` — a list of tokens spelled `["Character", data]`,
`["Comment", data]`, `["StartTag", name, attrs]` (a fourth `true` for
self-closing), `["EndTag", name]`, or
`["DOCTYPE", name, publicId, systemId, correctness]`, where `correctness` is the
**negation** of the force-quirks flag. Optional keys: `errors` (each `code`,
`line`, `col`), `initialStates` (up to six named states, expanded by the loader
into one case each), `lastStartTag` (the appropriate end tag for a case starting
inside RCDATA, RAWTEXT or script data), and `doubleEscaped` (input and
expectations carry literal `\uXXXX` sequences).

Consecutive `Character` tokens are concatenated in the expectations, so the
runner concatenates what the tokenizer emits before comparing.

After `initialStates` expansion the suite is **7,032 cases**, of which **1,799**
expect at least one parse error:

| File | Cases |
|---|---|
| `contentModelFlags.test` | 24 |
| `domjs.test` | 59 |
| `entities.test` | 80 |
| `escapeFlag.test` | 9 |
| `namedEntities.test` | 4,210 |
| `numericEntities.test` | 336 |
| `pendingSpecChanges.test` | 1 |
| `test1.test` | 69 |
| `test2.test` | 45 |
| `test3.test` | 1,786 |
| `test4.test` | 85 |
| `unicodeChars.test` | 323 |
| `unicodeCharsProblematic.test` | 5 |

## What it covers

Every tokenizer state, both character-reference forms in both the text and
attribute return states, the full parse-error vocabulary with positions, and the
alternate content models (RCDATA, RAWTEXT, script data and its two escape
levels, PLAINTEXT).

It is the suite browser engines share, so it catches the class our own builders
cannot: our tokenizer and our own expectations agreeing with each other and both
disagreeing with HTML5.

## What it does not cover

Tree construction, foreign content and fragment parsing. Those tests are **no
longer in this repository**: html5lib-tests' README records that they "are now
solely maintained on web-platform-tests", and `tree-construction/` has been
removed. `zch2.1.2` and `zch2.1.3` vendor them from
<https://github.com/web-platform-tests/wpt/tree/master/html/syntax/parsing/resources>
into `test/fixtures/wpt/` instead — a separate directory, because these
fixtures are named for who produced the bytes.

Character-encoding detection from bytes is not covered by any tokenizer case and
is out of scope here (`zch2.8`).

## Exclusions

| File | Reason |
|---|---|
| `xmlViolation.test` | Encodes an XML-compatibility output mode this library does not implement: U+FFFF folded to U+FFFD, FF treated as a space, `--` rewritten inside a comment. Excluded **structurally** — its root key is `xmlViolationTests` rather than `tests`, so the loader throws rather than matching on a file name. |

### Processing instructions: 38 cases, and this pin cannot be moved (`zch2.9`)

These fixtures expect `<?something>` to tokenize as a bogus comment plus
`unexpected-question-mark-instead-of-tag-name`. **That is no longer the HTML
Standard.** [whatwg/html#12118][pr] — *Parse XML-style `<?target data?>`
processing instructions* — was **merged on 2026-06-25**, adding five tokenizer
states and a processing instruction token, and deleting the question-mark
parse error from the tag open state outright.

[pr]: https://github.com/whatwg/html/pull/12118

`src/htmltoken.ts` implements the merged spec, so those 38 cases now assert a
state the tokenizer no longer has, and they are excluded.

**The pin cannot simply be moved forward.** This corpus's newest commit *is*
our pin — `224991ec` (2026-06-26), one day after the spec merged — and there
has been no commit since; its last act was recording that tree-construction had
moved to WPT. There is no newer expectation to take, and nobody is maintaining
this one. The other corpus, `test/fixtures/wpt/`, is pinned after the change
and agrees with the spec: `zch2.9` retired its 88-case PI exclusion, taking it
from 1,830 to **1,918 of 1,936** in scope.

So the disagreement `zch2.1.2` recorded did not go away — it moved. It used to
cost 88 WPT cases and now costs 38 here, and the 38 are the ones the *spec*
says are wrong.

The exclusion is a **computed predicate** over each case's expected errors, not
a list of ids, so a case cannot be reclassified to dodge a failure. The count
is asserted at 38 in `test/html5lib-tokenizer.test.ts`.

What the 38 would become under the merged spec, measured by classifying each
one — note most of them are **not** newly-PIs, they merely report a different
error for the same bogus comment:

| Under the merged spec | Cases |
|---|---|
| Still a bogus comment; only the error code changed | 27 |
| A real processing instruction; output changed | 2 |
| EOF, so `eof-in-processing-instruction` and **nothing emitted** | 9 |

That last row is the same fact WPT records from the other side: an unterminated
`<?` leaves no node at all, because the spec emits the EOF token and never the
buffer.

**Note, measured, and it is a trap for the next person to test this:** on this
corpus, `input.includes('<?')` selects **exactly the same 38 cases** as the
error-code predicate. So a mutation swapping one for the other reddens nothing
— it is a no-op rather than an uncovered rule. The predicate *is* fenced: a
genuine widening (`input.includes('<')`) reddens 2 and removing it entirely
reddens 39.

## Mutation results

Measured, not predicted. Each rule was broken in `src/` and the suite re-run;
the counts are cases, and they are recorded because a fixture that passes on the
first run is not evidence that it covers anything.

| Mutation | Reddened |
|---|---|
| `allowsMissingSemicolon` always returns false | 106 `namedEntities.test`, 4 `entities.test`, 3 `test1.test` (+4 hand-written) |
| The attribute-context rule deleted (always replace) | 6 `entities.test`, 3 `test1.test` (+1) |
| `preprocess` returns its input unchanged | 23 `test3.test`, 8 `test4.test`, 3 `domjs.test`, 1 `unicodeCharsProblematic.test` (+3) |
| The windows-1252 override deleted | 52 `entities.test` (+1) |
| NUL replaced globally with U+FFFD rather than per state | 1 each in `test2`, `test3`, `test4`, `unicodeCharsProblematic` (+2) |
| Input-stream errors never scanned | 94 `unicodeChars.test`, 91 `test3.test`, 4 `unicodeCharsProblematic.test`, 3 `test4.test` |
| Columns counted in code points rather than UTF-16 units | 19 `test3.test` (+1) |
| The longest-match scan bails out instead of falling back to a shorter name | 1 `domjs.test`, 1 `test1.test` (+1) |
| Input-stream errors flushed only at EOF (ordering) | 63 `test3.test` |

Three of these were **not** what the plan predicted, and the difference is the
point of measuring:

- The windows-1252 override is covered by `entities.test`, **not** by
  `numericEntities.test` as expected.
- The longest-match fallback (`&notin` degrading to `&not`) reddened **nothing**
  while only the three entity files were enabled — it is covered by
  `domjs.test` and `test1.test`, which came on later. Until then only
  `test/htmlcharref.test.ts` held it.
- Two rules were **corrected by the suite rather than confirmed by it**, having
  been asserted the wrong way round in this repo's own hand-written tests first:
  columns count UTF-16 code units (an astral character advances by two), and
  `cdata-in-html-content` is reported at the last character of the `[CDATA[` it
  consumed while `incorrectly-opened-comment` is reported at the one character
  it merely peeked. Both hand-written tests passed before the vendored cases
  ran, because both halves were ours — which is exactly the shared-convention
  class these fixtures exist to catch.

Nothing here reddens **only** hand-written tests, so no rule in `src/htmltoken.ts`
or `src/htmlcharref.ts` is currently pinned by our own expectations alone.
