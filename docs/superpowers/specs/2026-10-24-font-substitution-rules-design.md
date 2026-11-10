# Font substitution rules and a custom handler (g0ky.6)

## Intent

A PDF that names a font it does not embed is rendered with a stand-in face.
Today the stand-in is chosen by a fixed ladder in `src/fontsubst.ts`
(`resolveSubstitute`), over faces the caller registered for rendering
(`RegisterRenderFontFolder`, `RegisterRenderSystemFonts`, `AddRenderFont`),
then the bundled Standard-14 face:

1. exact PostScript name (`name` ID 6) against `/BaseFont`;
2. family match with CSS Fonts 4 slant-then-weight (`matchChain`);
3. best `cmap` coverage of the characters the font needs;
4. otherwise `raster.ts` falls back to the bundled Standard-14 face (or the
   `lqcs.4` placeholder boxes for an unidentifiable symbolic font).

A caller cannot step into that. Two kinds of caller need to:

- someone rendering PDFs whose fonts are not on the machine, who wants to say
  which face stands in -- "Arial is Liberation Sans here", or a decision per
  font;
- someone porting .NET code that sets `FontRepository.Substitutions`
  (`SimpleFontSubstitution`, `CustomFontSubstitutionBase`), who wants the same
  idea to carry over.

## Goals

- An ordered list of name -> name substitution rules, per document.
- One optional custom handler per document, asked before the rules.
- Both consulted BEFORE the existing ladder; the ladder is unchanged and
  still runs when they produce nothing.
- Shapes recognisably close to .NET's, for porters.

## Non-goals

- **Saved files never change because of a rule or the handler.** This is
  RENDER-ONLY, exactly like the existing substitution. `EmbedFonts` and
  `ReplaceFont` do NOT consult rules or the handler (decided with the user):
  `EmbedFonts` embeds a face only when it really IS the missing font, since
  embedding records that claim in the file, and `ReplaceFont` already takes
  the face to use as an argument.
- No process-wide registry. Rules live on the `Document` (decided with the
  user), consistent with the render font folders.
- `ToSvg` is unaffected and structurally cannot be: it emits `<text>` with a
  CSS family stack and resolves no glyph program (`fontsubst.ts`' existing
  note). `htmlfontembed.ts` shares `buildGlyphSource` but probes the
  descriptor's `/FontFile*` first, so a substitute never becomes an embedded
  `@font-face`; that also stays as is.
- No substitution for EMBEDDED fonts. Only a font whose descriptor carries no
  usable program reaches this code, as today.

## Anti-goals

- Any byte change in a render when no rule and no handler is set. Every
  existing render golden must stay green unedited.
- A rule that silently does something other than what it reads as -- e.g. a
  rule for `Arial` that fails to catch `Arial-BoldMT`, or that catches
  `ArialNarrow`.

## Public API

On `Document` (names follow the existing `RegisterRenderFontFolder` /
`AddRenderFont` family):

```ts
doc.AddFontSubstitution(original: string, substitute: string): void
doc.SetFontSubstitutionHandler(handler: FontSubstitutionHandler | undefined): void
doc.FontSubstitutions: readonly FontSubstitutionRule[]   // read-only view, in order
doc.ClearFontSubstitutions(): void                        // rules only; handler untouched

interface FontSubstitutionRule { original: string; substitute: string }

interface FontSubstitutionRequest {
  /** /BaseFont, subset tag removed; '' when absent. */
  name: string;
  bold: boolean;
  italic: boolean;
  /** A SAMPLE of the characters the font needs -- fontsubst.ts'
   *  wantedCodepoints, capped at 256 code points. Documented as a sample. */
  characters: ReadonlySet<number>;
}

type FontSubstitutionHandler =
  (req: FontSubstitutionRequest) => string | Uint8Array | undefined;
```

`string` is a face name, resolved exactly as a rule's substitute; a
`Uint8Array` is font bytes (sfnt, TTC face 0, WOFF/WOFF2, Type 1, `.dfont` --
whatever `parseSfnt` reads); `undefined` means "not mine, carry on".

Validation (`TypeError` for the wrong kind, the repo's split): both rule
arguments are non-empty strings after trimming; the handler is a function or
`undefined`. `SetFontSubstitutionHandler(undefined)` removes it. All public
names get README API Reference rows (`test/readme-api.test.ts` enforces it),
a Key Capabilities sentence beside the existing font-substitution one, and a
CHANGELOG `Added` entry.

## Resolution order (per non-embedded font dict)

1. **Handler**, if set. Its answer is used if it resolves to a face; a name
   that resolves to nothing, or bytes that do not parse, fall through to the
   rules (see "Failure").
2. **Rules**, in the order added. The FIRST rule whose `original` matches the
   font AND whose `substitute` resolves to a face wins. A matching rule whose
   substitute resolves to nothing is skipped and the next rule is tried.
3. **The existing ladder**, unchanged (`resolveSubstitute`).
4. **The existing fallback**, unchanged (Standard-14 / `lqcs.4` boxes).

### Matching a rule's `original`

Against the font's `/BaseFont` with any six-letter subset prefix removed,
case-insensitively and with spaces and hyphens squashed out (embedfonts.ts'
`squash`, reused unchanged so `EmbedFonts` behaves exactly as before), a rule
matches when `original` equals:

- the whole name (`Arial-BoldMT` rule catches exactly that face), or
- the family part: the name up to the first `,` (`Arial,Bold` -> `Arial`), or
  up to the first `,` or `-` (`Arial-BoldMT` -> `Arial`).

This is exactly `embedfonts.ts`'s existing family split
(`baseFont.split(',')[0]`, `baseFont.split(/[,-]/)[0]`, spaces squashed), so
"what is this font's family" has one rule in the library; extract it to a
shared helper rather than copy it. It cannot catch `ArialNarrow` from `Arial`
(no separator), which is the anti-goal above.

### Resolving a substitute name

A substitute name (from a rule or a handler string) resolves, in order:

1. among the document's render faces (`doc.renderFontFaces()`): exact
   PostScript name, else family via `matchChain` at the FONT's style (weight
   700 if bold else 400, italic as stated) -- i.e. rung 1 of
   `resolveSubstitute` with the substitute name in place of `/BaseFont`.
   Extract that rung so both use one code path;
2. else, if the name is one of the bundled Standard-14 names (`matchStd14`
   returning it exactly, e.g. `Helvetica`, `Times-Roman`, `Courier-Bold`), or
   one of the three family words `Helvetica`, `Times`, `Courier` combined
   with the font's bold/italic into the right Standard-14 member, the bundled
   face. So "draw MyCorpFont as Times" works with no folders registered.
3. else nothing. Faces registered only for AUTHORING (`RegisterFontFolder`,
   `RegisterSystemFonts`) are NOT searched: render and authoring folders are
   separate lists (`lqcs.2`), and a rule must not change what a caller gets
   merely because they registered a folder for `AddText`. Documented.

Style is honoured inside the substitute family: a bold Arial under the rule
`Arial -> Liberation Sans` draws in Liberation Sans Bold when it is
registered.

### Handler bytes

Parsed through the same path `AddRenderFont` uses (`parseSfnt`, names from the
extracted face), but NOT added to the document's render faces -- the handler
supplied it for this font. Bytes that do not parse fall through, as a name
that resolves to nothing does.

## Opt-in and byte identity

With no rules and no handler, `raster.ts`' `installedSubstitute` behaves
exactly as today, including its structural early return when no render faces
are registered. Note that rules targeting the bundled Standard-14 faces must
work WITHOUT any render faces, so the early return must now be "no faces AND
no rules AND no handler". Test: every existing raster/HTML/DOCX golden green
unedited; a dedicated case asserts a render with an empty rule list is
byte-identical to one with none.

The bundled-face outcome of a rule must go through the same code the existing
Standard-14 fallback uses (`getStd14Sfnt`), and must set
`GlyphSource.substituted` exactly as the existing installed-face path does, so
a substituted COMPOSITE font still selects by Unicode (`lqcs.1`'s invariant --
never `gidForProgram`'s code fallback).

## Caching

`buildGlyphSource` is memoized per render (per sink, `glyphSources`). The
handler must be asked at most ONCE per font dict per document, not once per
render: memoize its answer on the Document in a `WeakMap<PdfDict, ...>`.
The memo stores the handler's RAW answer (the name string, or the parsed
bytes), never the resolved face, so a name answer resolves against faces
registered AFTER it was asked. That memo is CLEARED whenever rules or the
handler change, so a change takes effect on the next render.

## Failure

- A handler that THROWS: the error propagates out of the render call
  (`ToImage` etc.). It is the caller's bug and must not be hidden. Note every
  `catch` in `src/` must call `rethrowLimit` first. `raster.ts`'
  `renderCanvas` catches around the whole of `interpret`, so a handler error
  WOULD be swallowed today. Wrap it in an internal marker error that
  `rethrowLimit` (or a sibling helper called beside it) rethrows, unwrapping
  to the caller's original error at the public boundary; check every catch
  on the paths in "Reach", not only `renderCanvas`, and test at least
  `ToImage`, `ToTiff` and an HTML raster backdrop.
- A handler name that resolves to nothing, or bytes that do not parse: fall
  through to the rules, then the ladder. No report (render has no report
  channel today) -- documented.

## Reach

Every renderer path that goes through `buildGlyphSource` gets the rules for
free: `ToImage`, `doc.ToTiff`, HTML `backdrop: 'raster'`/`'page'`, DOCX
textbox `backdrop: 'raster'`, `MakeSearchable`'s render, `CompareRendering`,
`Sanitize`'s pages-to-images, `GenerateAltText`'s crops. README says
"rendering" once and lists `ToSvg` as unaffected.

## Tests (each mutation-checked, per repo practice)

- rule by full name; rule by family part from `Arial-BoldMT` and `Arial,Bold`;
  `Arial` rule does NOT catch `ArialNarrow`; case/space insensitivity.
- rule order: first resolvable rule wins; an unresolvable first rule is
  skipped.
- style inside substitute family (bold font -> registered bold face).
- rule to a bundled Standard-14 name with NO render faces registered.
- rule beats the ladder: a registered face whose PostScript name equals the
  font's `/BaseFont` loses to a rule naming another registered face.
- handler before rules; handler `undefined` falls to rules; handler name
  unresolvable falls through; handler bytes used; handler bytes unparseable
  fall through; handler throwing propagates.
- handler asked once per font dict across two renders; asked again after
  `AddFontSubstitution`/`SetFontSubstitutionHandler`.
- `ClearFontSubstitutions` restores the ladder's choice; `FontSubstitutions`
  view is a copy / read-only.
- composite (Type0) non-embedded font under a rule draws by Unicode.
- empty-rules render byte-identical to no rules; `ToSvg` byte-identical with
  and without a rule; `Save()` byte-identical with and without a rule.
- `EmbedFonts` ignores rules (a rule `Foo -> Liberation Sans` does not make
  `EmbedFonts` embed Liberation Sans for `/Foo`).

Comparing renders: compare against a render of the SAME text through the
expected face (as `test/render-fonts.test.ts` does), not "ink appears".

## Decided by the user

- Render-only; saved files never change; `EmbedFonts`/`ReplaceFont` ignore
  the rules.
- Per document, not process-wide.

## The builder's calls (proposed, not user-decided)

- API names above; handler asked before rules (as .NET asks its custom
  substitution first); handler may return a name or bytes.
- Family-part matching via `embedfonts.ts`'s split.
- Standard-14 names and the three family words as valid substitutes.
- Handler errors propagate; unresolvable answers fall through silently.
- Memo per font dict per document, cleared on change.
- `FontSubstitutions` getter and `ClearFontSubstitutions` added for
  completeness; no per-rule removal.
