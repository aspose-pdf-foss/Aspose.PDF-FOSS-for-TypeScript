# WPT HTML tree-construction suite — provenance

The conformance corpus for the HTML parser's tree-construction stage, here to
validate `src/htmltree.ts` against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-26-html5-tree-construction-design.md`.

**Source:** <https://github.com/web-platform-tests/wpt>, `html/syntax/parsing/resources`
(BSD-3-Clause). Downloaded verbatim, not regenerated.

**Commit:** `8f1efd278facb6c96d46c0cd92897a8a3faeaf29`.

## Why not html5lib-tests

`test/fixtures/html5lib/` holds the *tokenizer* suite from html5lib-tests. The
tree-construction tests are **no longer there** — that repository's README
records that they "are now solely maintained on web-platform-tests", and the
`tree-construction/` directory has been removed. These fixtures are named for
who produced the bytes, so a different upstream gets a different directory.

## The files

62 files, 1,936 cases.

| File | Bytes | SHA-256 |
|---|---|---|
| `adoption01.dat` | 6084 | `b2aba05bd1d832f73a0c6103b3c8b151b283bab7c56887274d81f3a062c4963e` |
| `adoption02.dat` | 1035 | `b73bf9b375e8ee4b1e4364a7d6fec4eaf862930c26fdbdb59b87b75e468fd3dd` |
| `blocks.dat` | 9688 | `e3b7da1b57a4ec6991443dfc7ab3270f41d0f5959092a49be3e0edca0dae2104` |
| `comments01.dat` | 3349 | `c2f3a5ab4baf24f360ee14272aad18c33deffb9a56c2d5964777b1b6e0b8e3c1` |
| `doctype01.dat` | 9076 | `f3a286c09d729eeed9aa63e0aec13ab12336af04590c169543e6d1e1ef4723b2` |
| `domjs-unsafe.dat` | 10356 | `eef4fb719e027ffaadfb854787d172893850fc561c29efe72d90c5bfa3c8b7ac` |
| `entities01.dat` | 17640 | `b73605caac5aed5656184ab8db3f08edff5457ac3186cb04afa28384bca955e3` |
| `entities02.dat` | 4952 | `f4e0cd461204b0184709be040c00811b776fbde1a6d002bb1c75d02056d9e54a` |
| `foreign-fragment.dat` | 9082 | `73e1785753c66420c067e5b29f89b17e7ebe1079687a512040ef19c6d42ac2c2` |
| `html5test-com.dat` | 5550 | `bc8b465fe4a3ef199142d7f7e8bc6bf7ba10327d3dd795d7abef993bcfb352d0` |
| `inbody01.dat` | 836 | `cb722f2853ec9613b71ea68e8bb26f474cc450b64612930591ab2656406222fe` |
| `isindex.dat` | 774 | `d152de773e276a07a1cfc91e93f01f3ce52c447c110192f2828dab51be2721b6` |
| `main-element.dat` | 727 | `d56e382994e1a5228ddb2ea49a5ff51ab68487f9a8f79ad34bcad05d40dc1e8f` |
| `math.dat` | 1862 | `3c2ecc07272c175676ecfafa0cf6e18e74c3293075703702a4b7929fcb0d07bd` |
| `menuitem-element.dat` | 4015 | `08e5e25f38bbc181c840ce5c5203b2566dc03129aeaf105ca2311645d40aae4d` |
| `namespace-sensitivity.dat` | 518 | `318fbc9926eddf5863524f1503c711ddaea93b55bcbd1eaab71b7e354ddfeb09` |
| `noscript01.dat` | 4619 | `e82449304a6371c14ed490384b6d814b7b1eeb1022dbc5caa2045fc8400655d7` |
| `pending-spec-changes-plain-text-unsafe.dat` | 927 | `f45151f8dc7a4fe1a4b36710cf33606ff43cc98a42f1d2f085a77680683b0c99` |
| `pending-spec-changes.dat` | 851 | `a6b7c4ecccabe70de2f24184245e4a73a8d12ed44ee658c3d5d25cce04c9d27f` |
| `plain-text-unsafe.dat` | 11528 | `36782d4d697c98704704c7e724b230065d3eeb88ca3e30f92dbff1d407711ae3` |
| `processing-instructions.dat` | 12487 | `3d4c6e67b59fda8fa0eb798106a42d244c69a84d7e3a385f9845bfc40071b4f1` |
| `quirks01.dat` | 1170 | `b6717cc15d4ed573ccf6755bc9d52073e675b4d09f23bde07961e27592b9717c` |
| `ruby.dat` | 4471 | `5ae76ac4570d40e6648066798dd3ff729231bec98d3e010fdd67e0257f23a742` |
| `scriptdata01.dat` | 6624 | `e32ea3adc3d68c90e62ea50b3a41bf80369d1491958532bf00787b3509667322` |
| `scripted_adoption01.dat` | 296 | `1203be63238a6effc9cc47e3c9b1fa9a0c7e0126a2f78916514afed2d46f42d8` |
| `scripted_ark.dat` | 631 | `93365261fd9ea7dd9242613b57c23dba94e66bfd837a5d928f725bed81012dd0` |
| `scripted_foster01.dat` | 648 | `4bc2c004bfd5efe3ca1b49f3b03de0b31d69347440c97ee1ed83b34ee16ad158` |
| `scripted_webkit01.dat` | 603 | `9d84f68ffd6e8b7b3924c9211280a70a888576b49074654cc9708236834afc58` |
| `search-element.dat` | 741 | `30be0e9e8cbeea825e0323a7a3a518ab88f44fcada9b4f82b0cc7bbeb9334b76` |
| `svg.dat` | 1606 | `4c819b8dbdfbd98cfbce9a535a304b0a16597eb29ccc04077131a62810f309cd` |
| `tables01.dat` | 7041 | `bfd4a53246e3acc527c8bb214cc743082e19260e72365001aad3f1d8f4bd08dc` |
| `template.dat` | 25142 | `74bc8308e673589d81b63eb71411a6f8ecea6fd6af649b5802c22615b7102a03` |
| `tests1.dat` | 39460 | `aada6e3d12d624051bc978694475bd6a12bcedd7758781ba62425314684d23f3` |
| `tests10.dat` | 16458 | `2d2624a819c323661e396d864ac23440053127b5ea7adb44a5904f5ceee5fa64` |
| `tests11.dat` | 17679 | `276190e2a7b97e8fcf3bd863a4b4b5346b555a8336c00143cb1d0e8956b94a07` |
| `tests12.dat` | 1612 | `e6c506cea74979a0d6ca47f6b175c7b6177d6e57db708920a89694e31dfd8a42` |
| `tests14.dat` | 1067 | `d151b2426f38de40a5d4ae726e2a56dbc7742a9b1c95299d60c1e2e0fdad1f98` |
| `tests15.dat` | 3649 | `ef784ece74cbd760da3a6947aaf4478810246b73c753f25a04be4d11dd806b2d` |
| `tests16.dat` | 46454 | `3350be682713afc1f6dad37059f2551709497a3643c38c26e1fe36fd07d23745` |
| `tests17.dat` | 2819 | `0567680775f58a5b2ad24e234f41d53f68fb2fc3ef7809bebaec0920e2f13c89` |
| `tests18.dat` | 12119 | `5d0019ae43bb4e0b0da9f2e1d57ac0618a607bd8a1324b163ec7a23a1dc120f3` |
| `tests19.dat` | 22988 | `a9316b1eb4d2821a18e2c840394c6218bfcdb598857b92631490d9c3c1840ce4` |
| `tests2.dat` | 13193 | `9cf76b5f4890065c04fc82ae828379a55b85cbe76f584fb1ef23dcef0a77b86b` |
| `tests20.dat` | 13524 | `07f7661690c4cd7cc0bbb0f1b9c1e1d65135e07c4dde8bbf106692f687e7d33d` |
| `tests21.dat` | 5092 | `b1a67420c79a5131002fefc987084ffb6b6094a3a74b272c6f545a47df06452c` |
| `tests22.dat` | 4243 | `78488328181d0f82f34b1a5e9e456ff7c713b3ff86dab6ace1530f6f07d5370d` |
| `tests23.dat` | 3478 | `2e4752ff4ef898e4a0cf9a450e481440095163d45075a662846a062552afe148` |
| `tests24.dat` | 929 | `fdd5c21f60f42235ded224a03e7182d289088328f460525adaf3c14e772a24ac` |
| `tests25.dat` | 3586 | `f2e08fda6d15a08faf9ff0001ec38560d942069cee6b4e264aeedbbacde7da8d` |
| `tests26.dat` | 8865 | `d55d24dfca2444fba759d59346cbab21f7e70340dbb14e2c7af8da3d44abd4ab` |
| `tests3.dat` | 4601 | `c4b4d8e0ea3d978c49d1e6a985d427164858b71ec980153c4526ed0c398f43b9` |
| `tests4.dat` | 1041 | `e6003a52e1cbffc361eca7c739cdd4459074ac8c59766d1eb171b9c9eb42f517` |
| `tests5.dat` | 3160 | `bf80b927082290541781844906abdcb72f091488f7a11e8b7d9ac00076dd4fce` |
| `tests6.dat` | 11065 | `be16c74d2a9862283262968439c95b9bfce6182ea61055a3c886c28d14f3e01a` |
| `tests7.dat` | 7339 | `aeb9569589c809b1a563c0b163173e8cf980a6a4028cb7c210f19c181b56999a` |
| `tests8.dat` | 2664 | `f3c8b1baece162e7e8c394540cdf9057266bb738bb0ad539a9d9b2f9d365f162` |
| `tests9.dat` | 10391 | `857820f088506a6d20ea6acefbf19c0a6c4de87a39b24988878066397516b36f` |
| `tests_innerHTML_1.dat` | 11205 | `acb9f835119e302d33204f437d54637a84ae26608ccb7bc961c6f7f44202a44c` |
| `tricky01.dat` | 6690 | `3fb6d24c5e371860d096ef07f5fff38be3ceaa85f1239bee35cce548b596198a` |
| `void-in-phrasing.dat` | 1890 | `c8855173aca8ecbd218abc26db34a631393ce0285fffebffdaf69b8bdd6224e9` |
| `webkit01.dat` | 14034 | `063ca232535a792fa238ae769eeb0ddcc9bd2ee961d3da327ca134612d35d93c` |
| `webkit02.dat` | 14921 | `03b215350d352faf110df2cc6eac23a44a7f70945b4ea962f0b17bed103459f7` |

## Shape

A case is `#data` (input), `#errors`, optionally `#new-errors`, optionally
`#document-fragment` or `#script-on`/`#script-off`, then `#document` (the
expected tree). Cases are separated by a blank line immediately followed by
`#data`; the final case has no trailing blank line.

In `#document`, each node is `| ` then two spaces per depth. An element is
`<name>`, its attributes follow one per line sorted by name, text is in double
quotes, a comment is `<!-- data -->`, a doctype is `<!DOCTYPE name>`. A node
whose text contains a newline puts only its FIRST line behind `| `; the rest
are bare continuation lines.

Three files carry a lone CR inside a `#data` payload
(`processing-instructions.dat`'s `<?hey<CR>there=1?>` is the readable one),
which is why `.gitattributes` marks this directory `-text`: the payloads are
byte-exact or worthless.


## Buckets

1,936 cases, classified by the loader and asserted. Three buckets have been
RETIRED as the parser grew into them — `foreign` (zch2.1.3.1), `template`
(zch2.1.3.2) and `fragment` (zch2.1.3.3) — each by DELETING its predicate
rather than replacing it. What is left is what the parser deliberately does
not do:

| Bucket | Cases | Status |
|---|---|---|
| In scope (`zch2.1.2`, `zch2.1.3.1`, `zch2.1.3.2`, `zch2.1.3.3`, `zch2.9`) | 1,918 | run |
| Scripted (`#script-on`, `scripted_*.dat`) | 14 | excluded — the scripting flag is off |
| `<selectedcontent>` | 4 | excluded — see below (`4h3p`) |

The split is COMPUTED by a predicate over the case, never a hand-maintained
file list: a list is a second place for the truth to live, and it drifts
silently in the direction of testing less. The bucket counts are asserted in
`test/wpt-tree-suite.test.ts`, so a case that migrates between buckets because
upstream edited it reddens the build rather than quietly shrinking the suite.

**The plan for `zch2.1.2` predicted five buckets and 1,328 in-scope cases.**
Both numbers were measured from the corpus and were right about the corpus; what
they missed is that eleven of those 1,328 exercise a disagreement rather than a
parse. Both widenings are recorded below with the case ids, because widening an
exclusion to make a failure go away is the exact thing this design exists to
prevent — the record is what makes it auditable rather than silent.

## Exclusions

**Both error sections are ignored; only `#document` is asserted.** `#errors`
uses a vocabulary html5lib invented — `expected-doctype-but-got-chars` appears
nowhere in the HTML Standard — while `htmltoken.ts` guarantees error codes are
the spec's own names verbatim. Asserting it would mean maintaining a second,
non-spec error vocabulary beside the first. `#new-errors` is spec-coded but
sparse (292 of 1,936 cases) and mostly re-tests errors `zch2.1.1` already
asserts.

**Processing instructions — the exclusion is RETIRED (`zch2.9`).** All 88
cases run, and pass. This is the fourth bucket retired, after `foreign`,
`template` and `fragment`, and the only one retired because the SPEC moved
rather than because we implemented more of it.

WPT expects `<body><?something>` to produce a real ProcessingInstruction node
with no parse error. That is now simply correct: [whatwg/html#12118][pr],
*Parse XML-style `<?target data?>` processing instructions*, was **merged
2026-06-25**, adding five tokenizer states and deleting
`unexpected-question-mark-instead-of-tag-name` from the tag open state.
`src/htmltoken.ts` implements it.

[pr]: https://github.com/whatwg/html/pull/12118

**The disagreement did not go away — it moved to the other corpus.** The
html5lib-tests tokenizer suite still expects the bogus comment; its pin is ours
and is dated one day AFTER that merge, with no commit since. 38 cases there are
now excluded instead, which is a strictly better trade: 88 cases returned, 38
left, and the 38 are the ones the spec says are wrong. See
`test/fixtures/html5lib/PROVENANCE.md`.

Two of the 88 were only ever reachable after `zch2.1.3.2` retired the
`template` bucket: `processing-instructions.dat#119` and `#123` expect a PI
node INSIDE template content, so the template predicate had been matching them
first. Both are now asserted IN SCOPE by id, as are the six cases that made the
old exclusion need two predicates — `processing-instructions.dat#100`–`#105`
and `tests1.dat#39`, where an unterminated `<?` leaves nothing at all, and
`comments01.dat#13`, `processing-instructions.dat#106` and `tests1.dat#40`,
where a comment was always the right answer. Asserting them in the opposite
direction is what would redden if an exclusion ever crept back.

The old two-predicate shape recorded something that turned out to be exactly
right, and it is worth keeping: WPT makes a PI only when the target is a usable
name — `xml` and `xml-stylesheet` are blocklisted, a digit or punctuation
start is not a name, and whitespace straight after `<?` means no target at
all. Each falls back to a bogus comment, which is why 36 cases in
`processing-instructions.dat` expect one. That is precisely the merged spec's
rule, read off the corpus before the spec was consulted.

**`<selectedcontent>` (4 cases).** `webkit02.dat#44`–`#47`. The expected tree
holds text no parser ever put there: under the customizable-select feature a
`<selectedcontent>` element clones the selected `<option>`'s subtree into
itself, so

```
<select><button><selectedcontent></button><option>X
```

expects `"X"` inside `<selectedcontent>` as well as inside the `<option>`.
That is the element's own DOM behaviour, observed because WPT's runner is a
real browser; it is not tree construction, and a parser that produced it would
produce a tree no other parser produces. Excluded by a predicate over the
expected tree. These are the ONLY four cases in the whole corpus naming the
element and all four failed, so the exclusion costs no coverage.

**The exclusion is PERMANENT, not a gap awaiting work** (`4h3p`, closed). The
predicate matches the expected TREE, and we deliberately do not mirror in the
parser — so no future work recovers these four cases, and they must not be
cited as coverage this corpus could one day regain.

**And the RENDER, which is the separate question, already agrees.** What a
browser DISPLAYS for all four inputs is the selected option's text, and
`selectedOptionText` (htmlreport.ts) implements the very rule they turn on —
the `selected` attribute, else the first option — while `cssinline.ts`
intercepts a `<select>` wholesale, so the unselected options never reach the
page. Measured: the four inputs render `X`, `xiibb`, `X`, `Y`, which is what
Chrome shows. Nothing had to be built. **The one residue** is that emphasis
inside a customizable-select is flattened — `x<i>i<b>ib</i>b` draws the right
characters unstyled — which is also what a NATIVE `<select>` widget does, so
it is only a divergence for markup that opts into `appearance: base-select`.

Pinned by `test/htmlreport-render.test.ts`, which renders the four inputs
verbatim, because the corpus provably cannot report a regression here.
**Measured, and it is why the pin is not redundant:** taking the LAST option
rather than the first reddens that pin and NOTHING else — the pre-existing
`draws ONLY the selected option of a select` case carries an explicit
`selected` attribute, so the else-first branch had no render-level cover
before.

## What the corpus corrected about the spec

`zch2.1.2`'s design and plan were both written against an older reading of
§13.2.6, and 17 in-scope cases disagreed with it. The corpus won, and the
implementation follows the current HTML Standard:

- **There is no "in select" insertion mode, and no "in select in table".**
  §13.2.6.4 now runs .1 to .21 rather than .1 to .23. A `<select>`'s content is
  parsed by "in body", which grew `select`/`option`/`optgroup` clauses and a
  `select`-in-scope test on `<hr>` and `<input>`. `src/htmltree.ts` implements
  20 modes — every one but "in template".
- **There are four scopes, not five, and "select scope" is gone.** `select` has
  moved into the DEFAULT scope's terminator list, which is a reversal: the old
  select scope was *inverted*, admitting only `optgroup` and `option`.
- `</select>` is now in "in body"'s block end-tag list, beside `button`,
  `listing` and `pre`.

And from `zch2.1.3.1`:

- **Every "pop until an element with this tag name" means an HTML ELEMENT with
  that tag name.** `<td><svg><td>` puts an SVG `td` above the HTML one, so a
  name-only match stops at the wrong element and strands the whole SVG subtree
  on the stack. The design and the plan both missed it and one vendored case
  caught it — which is what `namespace-sensitivity.dat` exists for.


## Mutation results

Six mutations named before the code was written, each run against
`test/wpt-tree.test.ts`, `test/htmltree.test.ts` and `test/htmlstack.test.ts`
(1,340 assertions, all green at baseline) and then reverted. These are the
OBSERVED counts, not the predictions.

| # | Mutation | Failures | Where |
|---|---|---|---|
| 1 | Adoption agency reduced to a plain pop of the formatting element | 70 | `tests1` 16, `adoption01` 12, `tests26` 9, `tests19` 7, `tricky01` 6, `tests22` 5, `webkit02` 4, `webkit01` 3, `tests8` 2, `adoption02` 2, `tests2` 1, `html5test-com` 1, plus 2 hand-built |
| 2 | Foster parenting appends into the table instead of before it | 73 | `tests7` 9, `tests18` 9, `tests1` 8, `tests19` 7, `tests15` 6, `tables01` 6, `tests8` 4, and 12 more files, plus 1 hand-built |
| 3 | Reconstruction skipped before inserting text | 50 | `tests26` 10, `tests1` 10, `tricky01` 6, `tests19` 6, `tests23` 5, `adoption01` 4, and 5 more files, plus 1 hand-built |
| 4 | `hasInScope` ignores `kind` and always uses the default scope | 54 | `tests20` 38, `tests1` 6, `tests17` 3, `tables01` 2, `webkit02` 1, `adoption02` 1, plus 3 in `htmlstack.test.ts` |
| 5 | "Original insertion mode" made a stack rather than one variable | **0** | **nothing — see below** |
| 6 | Implied end tags always use the "thoroughly" variant | 83 | `blocks` 24, `tests1` 12, `tests2` 8, `tests19` 7, `tricky01` 5, and 15 more files, plus 1 hand-built |

**Mutation 5 reddens nothing, and that is the result worth recording.** The
spec says "original insertion mode" is one variable; a stack behaves
identically until a document nests the constructs that expose it, and no case
in the 1,317 does. So the corpus does NOT cover that rule — it is held by
reading the spec, not by this suite. Written down rather than left to be
discovered, the form `test/fixtures/fonts/PROVENANCE.md` already uses.

Two mutations landed harder than predicted and one is worth naming: #4's 38
failures in `tests20` are almost all `<p>` auto-closing, which is what button
scope decides — the commonest shape in real HTML, in the one file that
exercises it densely. #1 and #3 both redden `adoption01`, as expected, but #1
is the only one that reaches `adoption02`.

Four further mutations, run over the same three files so the whole set is
comparable:

| Mutation | Failures | Where |
|---|---|---|
| `popUntilName` stops BEFORE its match instead of popping through it | 164 | `blocks` 48, `tests1` 25, `tricky01` 9, `tests19` 9, and 16 more files, plus 1 unit case |
| Noah's Ark clause deleted | 5 | `tests23` 3, `adoption01` 1, plus 1 unit case |
| `htmldom.ts` drops the detach before an append | 1 | `test/htmldom.test.ts`'s move case alone |
| The serializer drops its attribute sort | 1 | `test/wpt-tree-suite.test.ts`'s attribute case alone |

**Noah's Ark was expected to redden nothing** — it has no visible symptom, so
the unit assertion was written to stand alone. It reaches 4 vendored cases,
which is better than predicted but still thin enough that the direct assertion
earns its place. The `htmldom.ts` and serializer mutations were run against
their own files when those landed, before the corpus was turned on.

### zch2.1.3.1 — foreign content

Seven mutations named before the code was written, each run against
`test/wpt-tree.test.ts`, `test/htmltree.test.ts`, `test/htmlstack.test.ts` and
`test/htmlforeign.test.ts` (1,571 assertions, all green at baseline) and then
reverted. OBSERVED counts, not predictions.

| # | Mutation | Failures | Where |
|---|---|---|---|
| 1 | `adjustSvgTagName` returns its argument unchanged | 24 | `tests10` 6, `tests11` 3, `webkit02` 2, `tests26` 2, `tests12` 2, `plain-text-unsafe` 2, `html5test-com` 2, 4 more files, plus 1 unit |
| 2 | Both integration-point predicates forced false | 54 | `tests10` 11, `plain-text-unsafe` 9, `tests19` 6, `tests20` 5, `webkit01` 4, `tests26` 4, 6 more files |
| 3 | `FOREIGN_BREAKOUT` emptied | 25 | `tests10` 8, `tests9` 7, `tests20` 3, `webkit01` 2, 3 more files, plus 2 unit |
| 4 | The self-closing branch of "any other start tag" deleted | 8 | `tests11` 4, `tests19` 2, `tests9` 1, `tests10` 1 |
| 5 | `adjustedCurrentNodeIsForeign` forced to `() => false` | 30 | `tests21` 21, `html5test-com` 4, `domjs-unsafe` 3, `plain-text-unsafe` 2 |
| 6 | `isSpecial` made namespace-blind | **1** | `adoption01` — see below |
| 7 | Foreign NUL ignored rather than inserted as U+FFFD | 9 | `plain-text-unsafe`, all 9 |

**Mutation 6 was predicted to redden nothing and reddens exactly one case.**
That is thin, and it is recorded rather than celebrated: `special` being
namespace-aware is held by ONE vendored case (`adoption01`) plus the unit
assertions in `test/htmlstack.test.ts`. A document has to mis-nest formatting
*across* a foreign boundary to expose it, which the corpus does once. Do not
read the wide margins on the other six as covering this one.

Mutation 5's count excludes `test/htmltoken.test.ts`, which was not in this
run and carries four more assertions on that seam directly.

**Found by the corpus rather than by the plan**, and the reason
`namespace-sensitivity.dat` exists as its own file: every "pop until an
element with this tag name" in the spec is "until an **HTML element** with
this tag name". `<td><svg><td>` puts an SVG `td` above the HTML one, so a
name-only `popUntilName` stops at the wrong element and strands the entire SVG
subtree on the stack. The design and the plan both missed it; the single
failing case on the first full corpus run is what surfaced it. It reaches
`popUntilOneOf`, both implied-end-tag walks, the `li` and `dd`/`dt` scans,
"any other end tag" and the adoption agency's first test. Measured: reverting
`popUntilName` alone reddens `namespace-sensitivity.dat#0` and the unit case
written for it, and nothing else.

### zch2.1.3.2 — `<template>`

Six mutations named before the code was written, each run against
`test/wpt-tree.test.ts`, `test/htmltree.test.ts`, `test/htmldom.test.ts` and
`test/wpt-tree-suite.test.ts` (1,688 assertions, all green at baseline) and
then reverted. OBSERVED counts, not predictions.

| # | Mutation | Failures | Where |
|---|---|---|---|
| 1 | The content fragment never created; children land on the element | 115 | `template.dat` 109, `tests18` 1, plus 5 hand-built |
| 2 | The insertion-location template redirect dropped | 93 | `template.dat` 88, `tests18` 1, plus 4 hand-built |
| 3 | `template` removed from the foster-parenting search | **2** | `template.dat`, both |
| 4 | `templateModes` collapsed to depth 1 rather than a stack | 13 | `template.dat`, all |
| 5 | `resetInsertionMode`'s `template` branch dropped | 18 | `template.dat`, all |
| 6 | `generateImpliedEndTagsThoroughly` swapped for the ordinary variant in `</template>` | **0** | **nothing — see below** |

**Mutation 6 reddens nothing, and that is the result worth recording.**
`</template>` is the spec's only call site for the thorough variant, and the
thorough list's extra names are the table-section tags (`caption`, `colgroup`,
`tbody`, `td`, `tfoot`, `th`, `thead`, `tr`) — no vendored case has one of
those open when a `</template>` arrives. So the rule is held by the spec, not
by this suite.

Note this is a DIFFERENT claim from the one `zch2.1.2` measured. That issue
found that using the thorough list EVERYWHERE reddens 83 cases; this one finds
that using the ordinary list at the one place the thorough variant belongs
reddens none. Both are true, and only the first is covered.

**Mutation 3 is thin at two cases**, which is still better than the zero it
could have been: the foster-parenting search reading "last table" instead of
"last template or table" was a defect shipped in `zch2.1.2` and unreachable
until templates existed. Two vendored cases is the whole of its coverage.

**Three rules the corpus caught that the plan did not name**, all found on the
first full run and all in `src/htmltree.ts`:

1. **In-body's EOF consults the template insertion-mode stack** — the only
   place outside "in template" that does. It is the whole reason an unclosed
   `<template>` still gets a `<body>`: "in template" redirects nearly every
   start tag to "in body", so by EOF the insertion mode is usually `InBody`
   and the template unwind never runs. 20 cases.
2. **In-body's `<html>` and `<body>` start tags ignore the token outright when
   a template is open**, rather than merging attributes onto the element.
   Without it, `<template><html b=c>` writes `b="c"` onto the real `html`
   element. 4 cases. (`<frameset>`'s parenthetical mentions templates too, but
   its stated condition does not need the guard — `<template>` sets
   frameset-ok to "not ok", which already refuses the token.)
3. **Foster parenting must accept a FRAGMENT as the last table's parent**,
   which is exactly what it is whenever that table was opened inside a
   template. Without it, text fosters to the END of the template's content
   instead of before the table. 1 case.

### zch2.1.3.3 — fragment parsing

Six mutations named before the code was written, each run against
`test/wpt-tree.test.ts`, `test/htmltree.test.ts`, `test/wpt-tree-suite.test.ts`
and `test/html-public-api.test.ts` (1,887 assertions, all green at baseline)
and then reverted. OBSERVED counts, not predictions — and here the predictions
were the worst of the four issues, wrong in both directions.

| # | Mutation | Predicted | Observed | Where |
|---|---|---|---|---|
| 1 | `adjustedCurrentNode` reverted to the current node | 67 | **20** | `foreign-fragment` 18, `plain-text-unsafe` 2 |
| 2 | The tokenizer priming switch emptied | 6 | **6** | `tests4` 5, plus 1 hand-built |
| 3 | The template-context push dropped | 1 | **0** | **nothing — see below** |
| 4 | `resetInsertionMode`'s context substitution dropped | 91 | **194** | `tests_innerHTML_1` 77, `foreign-fragment` 66, `tests6` 12, `tests4` 8, `svg` 8, `math` 8, and 3 more files |
| 5 | The synthetic root created with `context.name` instead of `html` | "broad" | **43** | `tests_innerHTML_1` 30, `tests6` 4, `svg` 4, `math` 4, `foreign-fragment` 1 |
| 6 | The form-pointer walk deleted | 0 | **0** | **nothing, and known in advance** |

**Mutation 3 reddens nothing, and the reason is specific rather than a gap in
the corpus.** There is exactly one `template`-context case, `template.dat#108`,
and its input is
`<template><form><input name="q"></form><div>second</div></template>` — it
opens its **own** `<template>`, which pushes "in template" through the in-head
start-tag rule regardless. The context push is redundant for the only case
that could exercise it. So §13.4's step is held by the spec, not by this
suite.

**Mutation 6 reddens nothing and was known to be uncoverable before it was
run.** A `.dat` context element is synthesized with no ancestors, so no
vendored case can reach the form-pointer walk at all. It is implemented
because §13.4 says so; if a caller ever passes a real element, that code path
has never executed.

**Mutation 1 was over-predicted by more than three to one**, and the gap is
informative: 67 cases have a foreign context but only 20 can tell
`adjustedCurrentNode` from the current node. For most of them the first token
pushes an element onto the stack before anything consults the adjusted node,
after which the two agree. `foreign-fragment.dat` is where the distinction
actually lives.

**Mutation 4 was under-predicted by more than two to one** — 194 against 91.
The context substitution in `resetInsertionMode` does not only decide the
table-context modes: it decides the *starting* insertion mode for every
fragment parse, so dropping it moves nearly every case that has a context at
all.

Taken together, mutations 4 and 5 are the two that make fragment parsing work
at all, and 1 is the one that makes it work for FOREIGN contexts. Mutations 3
and 6 are recorded as uncovered.
