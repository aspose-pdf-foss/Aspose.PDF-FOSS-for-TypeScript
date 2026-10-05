# Replacement font fallback (u3l5.2)

Part of epic u3l5 (Text editing in place). Builds on u3l5.1's per-character
replace plan in `src/textedit.ts`.

## Problem

`ReplaceText` writes every replacement character in the matched glyph's own
font, and throws `UnsupportedFeatureError` when it cannot:

- A Type0 (composite) font always throws for non-empty text, though most
  modern PDFs set their text in one.
- A character absent from the font's encoding throws, even when the caller
  has a font that could draw it.
- **Silent failure:** a SUBSET font's encoding can map a character whose
  glyph was never embedded. The replacement encodes, writes, and draws
  nothing — or `.notdef` — with no error.

## Decisions

1. **Tiers A + B + C**, tried per character in this order; D is out of scope.
   - A: the original font, used more widely (inverse `/ToUnicode`) and
     verified against the embedded program.
   - C: the same face, found by PostScript name in registered font folders
     (opt-in).
   - B: caller-given fallback fonts, in order.
   - D (out of scope): re-subsetting the existing embedded program to add
     glyphs. It means rewriting `glyf`/CFF in place while keeping glyph ids,
     and needs the original full font anyway, which C already uses directly.
2. **Nothing can draw a character:** throw `UnsupportedFeatureError` by
   default, naming the characters, document unchanged. With an
   `onUndrawable` callback the call proceeds, omits those characters and
   reports them. The `number` return type is unchanged.
3. **Per-character runs.** Each character goes to the first tier that can
   draw it; consecutive characters landing on one font form one run.
   `Total: €5` with `€` missing from the original font is three runs.

## Out of scope

D above. Explicit replacement font, size and colour, case sensitivity and
whole-word matching (u3l5.3, which reuses this font-switch machinery). Line
adjustment and reflow (u3l5.4, u3l5.5).

## Design

### 1. Choosing each character's font

Every character a replacement writes — the replacement itself and u3l5.1's
ligature residue alike — goes through the tiers below, and the first that can
draw it wins.

**Tier A, the original font.** A character is drawable when a code exists
that (a) DECODES back to exactly that character through the font's own
decoder (`TextFont`: `/ToUnicode` first, then the encoding), and (b) for an
EMBEDDED font, selects a glyph its program defines.

- Candidate codes: the encoding inverse (simple fonts, today's
  `encodeChar`) and the inverse of `/ToUnicode`'s single-character entries.
- For a Type0 font the `/ToUnicode` inverse is taken only under
  `/Identity-H` or `/Identity-V`, where a code is its CID and is two bytes.
  Any other CMap declines this route.
- Glyph presence goes through `glyphprogram.ts`: `gidForCid` for a composite
  font, `gidForProgram` for a simple one — the split `uafont.ts`'s
  `GlyphNotPresent` rule already makes. A gid of `undefined`, or one at or past
  `numGlyphs`, is missing. A non-embedded font is trusted by its encoding: the
  viewer supplies the face.
- The round trip is the criterion, not a heuristic: a code that would not
  extract as the intended character is the wrong code.

**Tier C, the same face from registered folders** (`matchRegisteredFonts:
true`). Strip a subset tag from `/BaseFont` (`ABCDEF+Arial-BoldMT` →
`Arial-BoldMT`) and find a face registered through `RegisterFontFolder` /
`RegisterSystemFonts` whose PostScript name (`name` ID 6) equals it exactly. A
family-only match does not count: that is a different face. A found face is
loaded through the same path as `LoadFontByName` (so it shares that memo) and
written as an embedded font.

**Tier B, `fallbackFonts`**, in order: Standard-14 names or
`AddFont`/`LoadFontByName` handles, probed through each one's existing
`FontDriver`.

**No tier.** See Errors.

Consecutive characters assigned one font form one run.

### 2. Writing a run in another font

When every run of an edit is in the original font, the edit is u3l5.1's byte
splice and the output is **byte-identical** to before u3l5.2.

An edit carrying a foreign run SPLITS the show operator holding its anchor
glyph:

- **`Tj`:** the string before the edit as `Tj`; then for each run in order, an
  original run inline and a foreign run as `/Fx size Tf <run> Tj /orig size
  Tf`; then the string after the edit as `Tj`. Adjacent original-font pieces
  merge into one string.
- **`TJ`:** the array is cut at the edit's element and byte position:
  `TJ [prefix]`, the runs, `TJ [suffix]`. Kerns stay on the side they sat on;
  u3l5.1's kern dropping still applies inside the match.
- **`'` and `"`:** the line move belongs to the operator, so the PREFIX keeps
  the original operator (`"` with its `aw ac` operands, even when the prefix
  string is empty) and everything after the split is written as `Tj`, so the
  move and the spacing apply once.
- An empty prefix or suffix `Tj`/`TJ` piece is omitted.

**Restore.** After each foreign run, `/orig size Tf` puts the original font
back, so text after the replacement in the same text object is unchanged.
`text.ts`'s `TextState` records the resource name `Tf` used, and
`GlyphEvent` gains `tfKey: string`, REQUIRED like `code` and `cid`. The size
is `TextState.fontSize`, carried as `GlyphEvent.tfSize: number`. `Tc`, `Tw`,
`Tz`, `Tr`, `Ts` and the fill colour persist, so a fallback run draws at the
replaced text's size, spacing and colour.

**Resources.** The fallback font is registered in the `/Resources` of the
stream being edited: the page's own resources for page content, the
copy-on-write form's resources for a Form XObject, reached through
`EditableContent` — never through a dict captured before the copy-on-write.
`stamp.ts`'s `registerFont(doc, page, font)` becomes a wrapper over
`registerFontIn(doc, fonts: PdfDict, font)`, keeping one owner of "reuse the
key when this font is already there". An embedded fallback records its glyphs
for subsetting at Save, as every authoring draw does.

### 3. API

```ts
interface ReplaceTextOptions extends SearchOptions {
  fallbackFonts?: AuthoringFont[];
  matchRegisteredFonts?: boolean;   // default false
  onUndrawable?: (r: UndrawableText) => void;
}
interface UndrawableText {
  page: number;        // 1-based
  match: string;       // the matched text
  missing: string[];   // distinct characters, in order of first appearance
}
```

`page.ReplaceText(find, replacement, options?)` takes `ReplaceTextOptions`;
`doc.ReplaceText(find, replacement, options?)` gains the same argument.
Options are validated before any page is read: `TypeError` for a
`fallbackFonts` that is not an array, an entry that is neither one of the 12
authoring Standard-14 names nor an `EmbeddedFont`, a non-boolean
`matchRegisteredFonts`, or a non-function `onUndrawable`.

### 4. Plan and apply

Replacement splits into a PLAN (search, assign fonts, encode; mutates nothing)
and an APPLY. `doc.ReplaceText` plans every page before applying any, so a
throw on page 3 leaves pages 1 and 2 untouched — today an error mid-document
leaves earlier pages rewritten. Loading a registered face during planning
reads a file and touches no PDF object; a fallback font's object is allocated
only when its first run is written.

### Errors

- No tier can draw a character and no `onUndrawable`: throw
  `UnsupportedFeatureError` naming the characters and the 1-based page,
  before anything changes (document-wide for `doc.ReplaceText`).
- With `onUndrawable`: omit each undrawable character, call it once per
  affected match with a fresh object, and continue.

## Testing

TDD over hand-built fixtures; each rule mutation-checked.

- A subset font whose encoding maps a character its program lacks: falls
  back instead of drawing blank (and throws without a fallback).
- A Type0 `/Identity-H` font: a character present in `/ToUnicode` re-encodes;
  the result extracts as the intended text.
- `fallbackFonts` with a Standard-14 name and with an `EmbeddedFont`.
- Per-character runs: `Total: €5`. An all-original replacement is
  byte-identical to u3l5.1's output.
- Splitting `Tj`, `TJ`, `'` and `"`; the `Tf` restore checked by the position
  and font of the text AFTER the replacement.
- A Form XObject scope: the font lands in the form's resources.
- `matchRegisteredFonts` against a vendored face's PostScript name, and a
  family-only name that must NOT match.
- `onUndrawable` records, and the document-level atomic throw.

## Documentation

- CHANGELOG **Added**: fallback fonts and registered-face matching.
- CHANGELOG **Fixed**: a subset font drew a blank where its program had no
  glyph.
- CHANGELOG **Changed**: Type0 text re-encodes where `/ToUnicode` allows;
  `doc.ReplaceText` is atomic across pages.
- README replace bullet and API rows; CLAUDE.md `textedit.ts` entry.
