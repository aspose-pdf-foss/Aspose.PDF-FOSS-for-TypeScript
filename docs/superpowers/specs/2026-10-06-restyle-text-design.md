# Restyle found text (u3l5.6)

## Goal

`page.RestyleText(find, style, options?)` and `doc.RestyleText(...)` change how
matched text LOOKS without changing what it SAYS: its colour, size and font,
and underline, strikethrough and background decorations. A restyled match
extracts the same text afterwards. Mirrors .NET's `TextStateModifier`.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| Q1 | Properties | `color`, `fontSize`, `font`, `underline`, `strikethrough`, `background`. |
| Q2 | Decoration vocabulary | `textdecor.ts`'s `DecorationOptions` — the names and the geometry every authoring producer already uses (`resolveDecor`, `decorRects`). One rule, so a restyled word and an authored one decorate alike. |
| Q3 | Colour, size, font | A `planReplace` whose replacement is each match's OWN text, styled through u3l5.3. Colour alone keeps the original glyph bytes. |
| Q4 | Where decorations go | In the text's own scope (page or form), around its text object: background before `BT`, rules after `ET`, each in `q <Tm> cm … Q`. Not a page-level overlay, which would cover the text with its own background. |
| Q5 | Width changes | `adjust` behaves as in `ReplaceText`; decorations follow the match's final position, reflow included. |

## API

```ts
interface TextRestyle extends DecorationOptions {   // underline, strikethrough, background
  font?: AuthoringFont;
  fontSize?: number;                  // points as rendered, u3l5.3's meaning
  color?: [number, number, number];   // 0..1
}

interface RestyleTextOptions {
  region?: Rect; ignoreCase?: boolean; wholeWord?: boolean;
  fallbackFonts?: AuthoringFont[]; matchRegisteredFonts?: boolean;
  onUndrawable?: (r: UndrawableText) => void;
  adjust?: ReplaceAdjust; onUnreflowable?: (r: UnreflowableText) => void;
}

page.RestyleText(find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions): number;
doc.RestyleText(find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions): number;
```

- Returns the number of matches restyled.
- A style stating nothing is a `TypeError`; every value is validated as
  `ReplaceText` and `textdecor.ts` validate it, before any page is read.
- `doc.RestyleText` dry-plans every page, throws before changing any, and
  re-plans each page just before applying it (`doc.ReplaceText`'s contract).

## Colour, size and font

`planReplace` gains a per-match replacement: a function of the matched text.
`ReplaceText` passes a constant and is byte-identical; `RestyleText` passes the
identity, with `font`, `fontSize` and `color` as u3l5.3 styles the replacement.
Everything u3l5.2-u3l5.5 decided carries over: the original font where it can
draw (so colour alone writes the same bytes), `fallbackFonts` and
`matchRegisteredFonts` after a `font` it cannot draw in, `onUndrawable`, the
fill restored in its own colour space, the refusals about naming a font or a
colour space in another scope, and `adjust`.

## Decorations

**Line boxes.** One per layout line a match covers: x where the restyled run
starts, its baseline (rise excluded), and the width the run now draws
(`runsAdvance`). With `adjust: 'reflow'` the origin comes from the wrap's
targets, so a match moved to another line takes its decoration with it, and a
match broken across lines gets one box per line. Without reflow the match never
moves (`shiftRest`/`spaceWidth` move only what follows).

**Frame.** The boxes, converted into the glyph's TEXT space, go through
`resolveDecor` and `decorRects` unchanged, and are emitted as
`q <Tm> cm … Q`. Rotated and scaled text is decorated along its own baseline;
the `q`/`Q` keeps the fill colour from leaking.

**Metrics.** With `font`, `vmetricsFor(font)`. Otherwise from the matched
glyph's font: an embedded sfnt program's `post`/`OS/2` values; else a
Standard-14 name's AFM family (`matchStd14`); else the descriptor's `/Ascent`
and `/Descent` with `textdecor.ts`'s fallback em fractions for the rules. Font
size is the restyled size, else the glyph's.

**Colour.** A rule defaults to `color`, else the glyph's fill as
`GlyphEvent.color` (black when absent) — an RGB approximation for a spot or
pattern fill. `background` states its own colour.

**Placement.** In the text's own scope: the background inserted immediately
BEFORE the text object's `BT`, so it is under the glyphs and over what was drawn
earlier; underline and strikethrough immediately AFTER its `ET`. `StreamEdits`
gains `before` beside u3l5.5's `after`. A form drawn twice is one stream, so
both drawings show the decoration, as they show the text change.

**Tagged documents.** Decorations are wrapped in `/Artifact BMC … EMC` when the
document has a structure tree — redaction's rule for ink that carries no
content. Untagged output carries no marked content.

## Refusals

`UnsupportedFeatureError`, decided while planning, so the document is unchanged:

- a decoration on vertical text;
- a decoration where the text object's `BT` or `ET` is not in the same content
  stream as the match;
- everything `ReplaceText` already refuses for `font`, `fontSize`, `color` and
  `adjust`.

Documented, not prevented: a repeat call draws a second rule; invisible
(`Tr 3`) text gets the visible decoration asked for.

## Units

- `src/textedit.ts` — the per-match replacement; `StreamEdits.before`; the
  planned final origin of each match exposed to the decoration plan.
- `src/restyle.ts` (new) — the entry points, validation, document-font
  metrics, decoration boxes and their insertion.
- `src/page.ts`, `src/document.ts`, `src/index.ts`, README, CHANGELOG,
  CLAUDE.md.

## Testing

- **Oracle:** `AddText('word', { underline, strikethrough, background })`
  against `AddText('word')` restyled with the same options: the rects
  `GetPaths` reports agree within 1e-3. Both go through `decorRects`, so this
  checks the frame and the op surgery against output drawn independently.
- Text unchanged: `GetText()` before and after is identical for every style.
- Colour alone leaves the show operator's bytes unchanged.
- Background under, rules over: operator order in the scope.
- A form-scoped match; rotated text; a match across two lines; `adjust:
  'reflow'` moving a decorated word.
- Tagged: decorations are artifacts; `ValidatePdfUa` reports nothing new.
- Each refusal leaves the document byte-identical; `doc.RestyleText` refuses
  before changing any page.
- Fences: the replace and adjust suites unchanged.
- A mutation sweep before closing.

## Out of scope

Removing existing decorations or reading a style back; detecting an
already-applied style; character spacing, word spacing, horizontal scaling and
render mode; decorations on vertical text.
