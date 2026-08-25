# Family and style matching — design

Issue: `l1my.3`, under epic `l1my` (Font sourcing by name, `gap-vs-go`).
Date: 2026-08-24.

`l1my.1` shipped `LoadFontByName`, which finds a face by family across
registered folders and, on request, the platform's own font directories.
`l1my.2` added `.ttc` collections, indexed face by face. Both stopped short of
choosing *which* face of a family to use: the rule today is a tie-break —
prefer one that is neither bold nor italic — and that spec says so explicitly,
parking style selection here rather than half-building it there.

This is the design for that selection: asking a family for a weight and a
slant, naming several families in preference order, and getting the four faces
emphasis needs.

## What exists today

`FaceRecord.names` (`fontnames.ts`) already carries `family`, `subfamily`,
`typographicFamily`, `typographicSubfamily`, `bold`, `italic` and `weight` —
read from `name`, `head` and `OS/2` during the partial-read index scan. **This
feature reads nothing new from disk.** Every rule below is arithmetic over
records the index already holds, which is what keeps `l1my.1`'s cost model
untouched.

`Document.LoadFontByName(family, opts)` walks the registered folders, matches
the family case-insensitively against the typographic family (ID 16) where the
font states one and ID 1 otherwise, and applies the tie-break inline in
`document.ts`. The whole matcher is about eight lines inside a method that also
does the loading and the memoization.

## Scope

**In:** a style request (`weight` + `italic`) resolved by the published CSS
Fonts 4 §5.2 rule; a family *chain*, so a caller can name substitutes; a
`ResolveFontByName` query reporting what would be chosen without loading it;
and `LoadFontFamily`, returning the four-face object `mdstyle.ts` already
consumes.

**Out:** stretch/`usWidthClass`, `OS/2.fsSelection`, synthetic bold and
oblique. Each is argued in **Out of scope** rather than left unmentioned.

## Three decisions that shape everything else

**The rule is cited, not invented.** Style matching is CSS Fonts 4 §5.2 — the
slant pass and then the desired-weight walk — because it is published, because
every browser implements it, and because "the documented fallback chain" the
issue asks for is worth more when the document is somebody else's. This repo
already anchors its trickier arithmetic outside itself (32000-1 for text
displacement, T.88's SLTP constants, UAX #9/#14, Adobe TN #5014); a
hand-invented weight rule would be one more thing only our own tests agree
with.

**The chain selects a FAMILY, and style matching then runs inside the
winner.** Given `['Arial', 'Liberation Sans']` at weight 700, with Arial
present in Regular only and Liberation Sans holding a real Bold, the answer is
**Arial Regular**. The caller stated a preference order over families; a style
detail must not silently override it, and the alternative — scoring family
position against style distance — makes the answer depend on a weighting
nobody can predict from the documentation. It is also CSS's own behaviour, so
the two mechanisms stay independent: one picks the family, the other picks the
face.

**Degradation is silent on the loading path and answerable off it.**
`LoadFontByName` keeps returning `EmbeddedFont | undefined` and always yields a
face once the family exists — but `EmbeddedFont.sfnt` is `@internal`, so today
a caller who asked for bold and got upright has no way to find out. A separate
pure `ResolveFontByName` reports what *would* be chosen, including whether the
style matched exactly, without loading or embedding anything. That keeps one
return shape on the loading path and gives the matcher a test seam that does
not touch `AddFont`.

## Module layout

| File | Responsibility |
|---|---|
| `src/fontmatch.ts` | **new, pure leaf.** Style derivation, the family filter, the §5.2 walk. |
| `src/fontsource.ts` | unchanged. |
| `src/fontnames.ts` | unchanged. |
| `src/document.ts` | `LoadFontByName` gains the chain and the style options; `ResolveFontByName` and `LoadFontFamily` are new. |

`fontmatch.ts` imports `FaceRecord` and `FontNames` as **types only**, so it
creates no runtime edge to the filesystem module and `fontsource.ts` imports
nothing back. `FaceRecord[]` in, one record out.

This is the split `floatstack.ts`, `docinfer.ts` and `booklet.ts` already make
against the modules that touch a document: it is what lets every branch of the
weight walk be asserted from hand-built records, with no temp folder, no
`Document`, and no font file. A matcher living inside `document.ts` — which is
where the tie-break lives now — can only be tested by writing synthetic sfnts
to disk and reading them back, which is how a rule comes to be covered by one
end-to-end case instead of by the eight it has branches.

## Deriving a face's style

The index records what the font *states*. Two of those statements are
unreliable in ways that matter, so the derived values are computed once, in
`fontmatch.ts`, and everything downstream reads them.

```
weightOf(names):
  w = names.weight              // OS/2.usWeightClass; 0 already normalised to 400
  if w !== 400: return w        // the font made a numeric statement — trust it
  // 400 is ALSO what an absent OS/2 and a stated 0 produce, so it is the one
  // value that may mean "said nothing". Corroborate, and only here.
  if names.bold: return 700     // head.macStyle bit 0
  return weightFromSubfamily(typographicSubfamily ?? subfamily) ?? 400

italicOf(names):
  return names.italic           // head.macStyle bit 1
      || /italic|oblique/i.test(typographicSubfamily ?? subfamily)
```

`weightFromSubfamily` is a documented table over the words a subfamily uses:
thin 100, extralight/ultralight 200, light 300, book/regular/normal 400,
medium 500, semibold/demibold 600, bold 700, extrabold/ultrabold 800,
black/heavy 900.

**Invariant: every signal is POSITIVE evidence and they are OR-ed** — the rule
`fontStyleOf` in `font.ts` already sets for the same question asked of a
document's own fonts. A face that merely omits `OS/2` says nothing and must not
veto a subfamily that says `Bold`.

**The weight corroboration fires only at 400, deliberately.** A mis-stated Bold
left at 400 costs twice over: it is unreachable when a caller asks for 700, and
it is a rival for the face they get when they ask for 400 — so the same defect
both hides the bold face and degrades the regular one. At any other value the
font made a numeric statement and the name is a second opinion nobody asked
for; `Roboto Condensed Light` at 300 must not be re-derived from a string.

**The slant test reads `oblique` as well as `italic`** because the two are one
bit here: `head.macStyle` has no oblique, and a face named `Oblique` that
leaves the bit clear is otherwise invisible to an italic request.

## The matching rule

Within the winning family: **slant first, then weight.** That ordering is
§5.2's (it applies stretch, then style, then weight; stretch is out of scope)
and it is the surprising half. Asking `{ weight: 700, italic: true }` of a
family holding *[Regular, Bold, Italic]* yields **Italic**, not Bold — the
upright bold face is a worse answer than the italic regular one, because slant
is the stronger signal. This is the rule most likely to be "corrected" by
someone reading the code later, so it is stated in `CLAUDE.md`, in the module
header, and in a test that names it.

Slant pass: keep the faces whose derived slant matches the request; if none do,
keep them all. (§5.2 distinguishes oblique from italic and prefers oblique when
`normal` is unavailable; with one bit those collapse into one step.)

Weight pass, verbatim from §5.2 with the desired weight `want`:

| `want` | order tried |
|---|---|
| 400 ≤ `want` ≤ 500 | weights ≥ `want` and ≤ 500, ascending; then < `want`, descending; then > 500, ascending |
| `want` < 400 | weights ≤ `want`, descending; then > `want`, ascending |
| `want` > 500 | weights ≥ `want`, ascending; then < `want`, descending |

Ties within one rank fall to registration order and then directory order,
unchanged from `l1my.1` — a lookup stays reproducible, and the same folders in
the same order give the same face.

**This REPLACES the `l1my.1` tie-break rather than sitting beside it.** "Prefer
a face that is neither bold nor italic" is exactly what resolving at
`{ weight: 400, italic: false }` does: the slant pass keeps the upright faces
and the weight walk starts at 400. The old behaviour is a special case of the
new rule, which is why `test/font-byname.test.ts` is expected to stay green
with no edits — and why a red case there means the general rule got the
special case wrong, not that the fixture is stale.

## Public API

```ts
/** Weight and slant to resolve within the matched family. */
export interface LoadFontOptions extends AddFontOptions {
  /** CSS weight, 1..1000. Default 400. */
  weight?: number;
  /** Prefer an italic or oblique face. Default false. */
  italic?: boolean;
}

/** What a name resolves to, without loading anything. */
export interface FontMatch {
  /** Family and subfamily as the FONT states them, not as they were asked for. */
  family: string;
  subfamily: string;
  /** Derived, per the rules above — not the raw usWeightClass or macStyle. */
  weight: number;
  italic: boolean;
  /** Whether weight AND slant both matched the request exactly. */
  exact: boolean;
  path: string;
  faceIndex: number;
}

LoadFontByName(family: string | string[], opts?: LoadFontOptions): EmbeddedFont | undefined;
ResolveFontByName(family: string | string[], opts?: LoadFontOptions): FontMatch | undefined;
LoadFontFamily(family: string | string[], opts?: AddFontOptions): FontFamilySpec | undefined;
```

Widening `family` to `string | string[]` is source-compatible: every existing
call passes a string.

The chain is walked in order. A family is *present* when at least one indexed
face matches it — trimmed, case-insensitive, against the typographic family
(ID 16) where the font states one and ID 1 otherwise, exactly as today. The
first present family wins outright and matching runs inside it; the chain being
exhausted is the only way to get `undefined`.

`ResolveFontByName` reads the same index — so it pays the first-lookup scan
like any other call — and loads nothing. `LoadFontByName` is `ResolveFontByName`
plus `readFileSync` plus `AddFont`, so the two cannot disagree about which face
a name means.

## `LoadFontFamily`

Returns exactly the `FontFamilySpec` that `mdstyle.ts` already consumes, so

```ts
doc.AddMarkdown(src, { font: doc.LoadFontFamily('Roboto') });
```

gets real bold and italic off the disk. Today `CLAUDE.md` records that an
embedded face "derives nothing: an unstated face falls back to `regular`, so
emphasis shows no change rather than a missing glyph" — which is the right
degradation and a poor outcome, and this is the entry that fixes it without
touching that rule.

`regular` is the `{ weight: 400, italic: false }` resolution, and it always
exists once the family does. **The other three slots are filled only when the
chosen face's derived style actually equals the request** — `weight ≥ 600` for
the two bold slots, slant matching for the two italic ones. Otherwise the slot
is left `undefined`.

Note that this test is a **bucket**, not the equality `FontMatch.exact` uses,
and the difference is deliberate. A family shipping Semibold and no 700 has a
bold face — it is the only heavier face there is — so `bold` is filled with it,
while `ResolveFontByName('…', { weight: 700 })` on that same family reports
`exact: false`, because the caller asked for 700 and did not get it. One
question is "which face plays this role", the other is "did I get what I asked
for"; collapsing them would either leave a real bold face out of a family or
report a substitution as an exact hit.

That last rule is the point of the method. Filling `bold` with whatever the
matcher returned would put the regular face in all four slots for a family that
ships one weight: four faces that are one face, dressed as a family. Leaving it
`undefined` routes through `mdstyle.ts`'s own documented fallback and produces
the identical rendering by a route a reader can follow.

Handles come through `document.ts`'s existing `path#faceIndex` memo, so two
slots resolving to one file share one `EmbeddedFont` and nothing is subset or
embedded twice.

## Degradation

Unchanged from `l1my.1`, and worth restating because the surface grew: nothing
here throws. An unreadable file, a malformed font, a folder that does not exist
and a family no folder holds are all skipped or reported as `undefined`. A
weight outside 1..1000 is clamped rather than rejected — it is a number in an
options bag, not a document we are parsing.

## Testing

**`test/font-match.test.ts` — new, pure, no disk.** Hand-built `FaceRecord[]`,
the way `test/docinfer.test.ts` drives its classifier from hand-built
`TextLine`s. Cases:

- each of the three `want` bands, and both directions within each — a family
  holding 100/300/400/500/700/900 asked at 300, 400, 500, 600 and 900, with the
  full order asserted by removing faces rather than by one lucky pick;
- **slant outranks weight**: *[Regular, Bold, Italic]* asked at
  `{ weight: 700, italic: true }` returns Italic. This passes under a
  weight-first build only by accident, so it is asserted alone and named for
  what it protects;
- the 400 corroboration firing at 400 (a face stating `Bold` with
  `usWeightClass` 400 is reachable at 700) and **not** firing at 300 or 700 (a
  stated weight is never re-derived from a name);
- `oblique` in a subfamily reads as italic with the `macStyle` bit clear;
- the chain stopping at the first *present* family even when a later family
  holds the exact requested style — the decision from the top of this document,
  asserted directly because it looks like a bug;
- ties falling to index order.

**`test/font-byname.test.ts` — existing cases unedited**, as the regression
fence for the tie-break-is-a-special-case claim. New end-to-end cases: the
chain over two temp folders; `ResolveFontByName`'s `exact` true and false, with
the reported `subfamily` proving *which* face was substituted; `LoadFontFamily`
returning four distinct handles over four files, and leaving `bold` undefined
for a one-weight family while `regular` is still defined.

**Every new assertion is mutation-checked** per the repo rule — break the path
and confirm the suite goes red. Two are called out in advance as the ones most
likely to be green either way: the slant-first case (a weight-first matcher
returns Bold, which is a plausible face) and the `LoadFontFamily` empty-slot
case (filling the slot with the regular face renders identically, so only an
assertion on the slot itself can see it).

## Documentation

`CHANGELOG.md` under `[Unreleased]`, **Added** — the style request, the family
chain, `ResolveFontByName` and `LoadFontFamily`, citing `l1my.3`.

`README.md`: the three methods in the API overview, and a paragraph in the font
section stating the §5.2 citation, the chain-picks-a-family rule and the
slant-over-weight surprise plainly. All three are things a caller otherwise
discovers by being surprised.

`CLAUDE.md`: an entry for `fontmatch.ts` recording the derivation rule (with
why the corroboration is confined to 400), slant-over-weight, chain-picks-a-
family, and the note that the `l1my.1` tie-break is now a special case rather
than a separate rule.

## Out of scope

- **`OS/2.fsSelection`.** Two more bytes of a table the indexer already reads,
  and the modern spelling of the bold and italic bits. Left out because its
  ITALIC bit agrees with `head.macStyle` in essentially every real font and the
  subfamily name is already an independent second signal — a third opinion with
  no case that needs it. Its OBLIQUE bit (v4+) is the one thing it adds, and
  the subfamily test covers that spelling.
- **Stretch / `usWidthClass`.** The third CSS axis. Widely mis-stated by real
  fonts, and nothing in this library authors condensed or expanded text, so it
  would add a mismatch source with no consumer.
- **Synthetic bold and oblique.** There is no emboldening or slanting anywhere
  in this library, and `mdstyle.ts` states the absence as a rule. Manufacturing
  a bold face here would contradict it from the other side.
- **A face whose weight lives in ID 1 with no typographic pair.** `Arial
  Narrow` and its like are their own family under the ID 16-else-ID 1 rule and
  are not reachable as a style of the base name. Documented as a limit rather
  than fixed: decomposing a family name into a base plus a style is exactly the
  string-parsing the derivation rule above refuses to do on subfamilies, and it
  would make `LoadFontByName('Arial')` start matching files it does not match
  today.
- **Glyph-coverage fallback.** CSS walks its family list per *character*, and
  falls onward when a face lacks the glyph. There is no character at
  `LoadFontByName` time — the font is chosen before any text is drawn — so the
  chain here is a family preference, not a coverage search.
