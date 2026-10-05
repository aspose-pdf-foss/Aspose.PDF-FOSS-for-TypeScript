# Cross-operator and ligature-aware replace (u3l5.1)

Part of epic u3l5 (Text editing in place). Extends `src/textedit.ts`'s
`replaceText`, which backs `page.ReplaceText` and `doc.ReplaceText`.

## Problem

`replaceText` plans its edits from `TextMatch.hits`, a list of WHOLE glyphs.
A glyph whose text is several characters — a ligature, `fi` mapped from one
code by `/ToUnicode` — is therefore all-or-nothing, and the part of it outside
the match is deleted. Measured on the current code, with `fi` one glyph:

| Page text | Find → replacement | Result | Correct |
|---|---|---|---|
| `fine` | `ine` → `one` | `one` | `fone` |
| `fine` | `f` → `x` | `xne` | `xine` |
| `ofifix` | `if` → `eee` | `oeeex` | `ofeeeix` |

Two matches inside one ligature (`/[fi]/g`) produce two edits over the same
byte range, which corrupts the string by construction.

The cross-operator half largely works already: a match spanning several
`Tj`/`TJ` operators puts the whole replacement into the first fragment and
empties the rest. Two leftovers remain: a `TJ` kern between two matched glyphs
stays behind (`[(World) -50 ()] TJ`), and an emptied `Tj` stays as `() Tj`.

## Decisions

1. **Placement.** A match spanning several fragments puts its whole
   replacement into the fragment where the match starts; the other fragments
   lose their matched glyphs. (Unchanged rule. Splitting the replacement
   across fragments was rejected: it cuts words at arbitrary points, and
   reflow is u3l5.5.)
2. **Positioning cleanup.** A numeric kern strictly inside a match is dropped;
   every other kern and every line or text-matrix operator is kept. A `Tj`
   left with an empty string is removed. A `TJ`, `'` or `"` left empty is kept,
   since it still moves the pen or the line.

## Out of scope

Type0 fonts and characters the font cannot encode (u3l5.2), closing the gap or
shifting the rest of the line (u3l5.4), paragraph reflow (u3l5.5), options
(u3l5.3). Matching semantics do not change: a match is still found in the text
`Search` and `GetText` assemble, so a `TJ` kern large enough to be read as a
space still reads as one.

## Design

### Plan at character level, write at glyph level

1. **One layout pass.** `searchText` is split into an internal
   `pageText(doc, page, opts)` returning `{ text, refs }` and the search on
   top of it. `replaceText` reads `text`/`refs` directly; `findRanges` stays
   the one owner of the matching rule. `Search` and `TextMatch` are unchanged.
2. **Glyph spans.** One pass over `refs` gives each glyph its contiguous
   character range `[gs, ge)` in `text`.
3. **Anchors.** A match `[s, e)`'s anchor is the first position in it that
   belongs to a real glyph — a space inserted by layout has no glyph. A match
   with no anchor (inserted characters only) is skipped, as today.
4. **Glyph rewrite.** For each glyph touched by any match, walk its
   characters: keep a character no match covers, drop a matched one, and at a
   match's anchor position emit that match's replacement. That one rule
   yields leading residue, trailing residue, and several matches in one
   ligature as ONE edit.
5. **Encoding.** A replacement is encoded in its anchor glyph's font; a
   residue character in its own glyph's font. Everything is encoded before
   any edit is applied.
6. **Writing.** Consecutive touched glyphs in one show-string element merge
   into one byte-range edit, ordered by `byteStart`. An untouched glyph is
   never re-encoded, so its bytes stay identical. `spliceShowOp` and
   `spliceElement` are unchanged.

### Kerns

In a `TJ`, a numeric element is dropped only when, for ONE match, it lies
between that match's first and last string elements in that `TJ`, AND every
string element between them is fully matched. The second condition is a
guard: reading order comes from `layoutLines`, which sorts by position and
can differ from stream order, and a kern belonging to text outside the match
must never be removed.

### Empty `Tj`

A `Tj` whose string was non-empty and is empty after its edits is removed from
the op list. Removal happens after all edits for the stream are applied, so no
planned op index is invalidated.

### Errors

- A residue character the font cannot encode throws `UnsupportedFeatureError`
  naming that character (for example a font holding the `fi` glyph and no
  plain `f`).
- Writing any character into a Type0 glyph throws as today. An EMPTY
  replacement writes nothing, so deleting Type0 text now succeeds where it
  used to throw (decided in the final review: deleting whole codes is
  byte-safe and needs no encoding).
- Nothing is mutated before every edit has encoded, so a refused call leaves
  the document byte-identical.

## Testing

TDD in `test/text-replace.test.ts` (or a new `test/text-replace-ligature.test.ts`),
over `buildToUnicodePdf` with a `/ToUnicode` mapping one code to `fi` — the
shape real ligatures take; this library's glyph-name table has no `fi`, so a
`/Differences` fixture would decode nothing.

- Residue before the match, after it, and on both sides (`ofifix`).
- Two matches inside one ligature.
- A match covering a ligature exactly (no residue, unchanged behaviour).
- An unencodable residue throws, and the saved bytes equal the original's.
- A kern inside a match is dropped; one outside is kept; one is kept when
  stream order and reading order disagree.
- An emptied `Tj` is removed; an emptied `TJ` and `'` are kept.
- Every existing replace test passes unedited.

Each rule is mutation-checked: break it and confirm a case reddens.

## Documentation

- CHANGELOG **Fixed**: replacing part of a ligature deleted its other half.
- CHANGELOG **Changed**: kerns inside a match and emptied `Tj` operators are
  removed.
- CLAUDE.md: a `textedit.ts` entry recording the character-plan rule and the
  kern guard.
