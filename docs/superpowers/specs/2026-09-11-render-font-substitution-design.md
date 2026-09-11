# Render-time font substitution sources (`lqcs.2`, folding in `lqcs.3`)

## The gap this closes

There is no way to hand the **renderer** a font. `RegisterFontFolder`,
`RegisterSystemFonts` and `LoadFontByName` exist for *authoring* and stop
there: `fontsource.ts` indexes folders and `fontmatch.ts` implements CSS Fonts
4 §5.2 matching, and neither is reachable from `raster.ts`.

So a non-embedded font renders through the bundled Standard-14 substitute and
nothing else. `lqcs.1` lifted the `!isType0` guard, which made that substitute
reach a *composite* font too — but the bundled faces are the 12 Latin
Standard-14 outlines, so a non-embedded CJK font still has no glyph for a
single one of its characters and draws a page of hairline placeholder boxes.

That is the everyday shape for an East Asian document: `/BaseFont
/MS-Mincho`, `/Encoding /UniJIS-UCS2-H`, no `/FontFile2`, because the producer
assumed the reader has the font installed. On a machine that *does* have it,
we draw boxes anyway.

## Two corrections to the issue's premise, both measured

**1. `ToSvg` is not affected and cannot be.** The issue's acceptance criterion
says "the same document renders differently with and without a directory", and
`lqcs.2`'s title names `ToImage`/`ToSvg` alike. But `SvgSink.glyphRun`
(`svgrender.ts:364`) emits `<text>`/`<tspan>` carrying Unicode plus
`font-family="${info.fontFamily}"` — a CSS stack from `htmlfont.ts`. It never
resolves a glyph program at all, so substitution there is the *browser's*, and
no font directory we index can change one byte of SVG output.

The real consumers of `buildGlyphSource` are two: `raster.ts` — so `ToImage`,
`ToTiff`, HTML `backdrop: 'raster'`/`'page'` and the DOCX textbox backdrop —
and `htmlfontembed.ts`, whose `probe` tests the descriptor's `/FontFile*`
**before** consulting `src.sfnt` (`lqcs.1`), so a substituted face can never
become an embedded `@font-face` there. The criterion is restated accordingly
under **Acceptance** below.

**2. `lqcs.3` is folded in.** Its three-step resolution collapses to two rungs
here — see *Why there is no family-name table*. It closes with this issue
rather than being implemented separately.

## Scope

**In:**

- Two document-level entry points naming render font sources: folders, and the
  platform's own font directories.
- Resolving a non-embedded font dict to an installed face: by `/BaseFont`
  name, then by Unicode coverage.
- Loading and memoizing the chosen face.

**Out, and each deliberately:**

- **Font programs supplied as bytes.** `FaceRecord.path` is a filesystem path
  that `LoadFontByName` reads with `readFileSync`; a bytes source makes it a
  discriminated union and the change reaches the **authoring** path too — a
  wider blast radius than the rest of this issue put together, for a
  convenience nobody has asked for. Its own follow-up.
- **Any change to extraction, editing, or PDF/A font embedding.** This affects
  rendering only, and no substituted program is written into the document.
- **Any change to `ToSvg` or `ToHtml`'s semantic mode.** Correction 1 above.
- **`lqcs.4`** (box an unknown symbolic font rather than substituting Latin).
  It gets easier once real faces exist — a symbolic font may now match by name
  — but the rule it asks for is untouched here.

## Design

### Where it plugs in

One new module, **`fontsubst.ts`**. `subst` rather than `sub`: in this
codebase `sub` already means *subset* (`subset.ts`, `cffsubset.ts`), and a
reader seeing `fontsub.ts` beside them would expect glyph subsetting.

**Invariant: it is a leaf and takes its faces as an ARGUMENT.**
`resolveSubstitute(faces, req)` receives a `FaceRecord[]`, never a `Document`,
so every resolution rule is drivable from hand-built records with no PDF
built, no filesystem touched and no folder registered — the seam
`colorimage.ts` takes `resolve`/`inflate` through, and the reason
`floatstack.ts` and `xfageom.ts` are separate modules.

Value edges: `fontsubst.ts` → `fontsource.js`, `fontmatch.js`,
`cidunicode.js`, `cmap.js`, `encoding.js`. None of those value-imports back,
so the edge `raster.ts` → `fontsubst.ts` closes no cycle. Run
`npx vitest run test/import-cycles.test.ts` to confirm, as `imagedecode.ts`'s
invariant requires.

`raster.ts` imports `Document` as a **type** already (`raster.ts:1`), so
calling a new method on the `doc` it is handed adds no value edge at all —
which is what keeps `node:fs` out of the rasterizer's import graph.

### The API

```ts
doc.RegisterRenderFontFolder(dir, { sniff?: boolean }): void
doc.RegisterRenderSystemFonts(): void
```

**Invariant: a SEPARATE list from the authoring folders.** `RegisterFontFolder`
goes on feeding `LoadFontByName` alone. Reusing it would be a behaviour change
for every caller who registered a folder for `AddText` — their pages would
start rendering differently — and the opt-in property below is the whole
reason the render goldens stay meaningful.

Both copy `RegisterFontFolder`'s documented rules verbatim, because a reader
who knows one must not be surprised by the other: no I/O at registration;
re-registering a held path does not move it or grow the list; `sniff` is
**sticky-on** and upgrades a held path in place.

**Invariant: opt-in, and byte-identity is STRUCTURAL rather than tested for.**
With nothing registered the face list is empty and `resolveSubstitute` returns
`undefined` on its first line, so the bundled Standard-14 path runs exactly as
it does today. Every existing render golden is untouched *by construction*.
That is a stronger claim than a passing snapshot and it should be asserted
directly, so it reads as a decision.

### Resolution

In `buildGlyphSource`, reached only where the font is non-embedded — the
branch `lqcs.1` already established, whose descriptor is already read from the
DESCENDANT for a composite font.

**Rung 1 — name.** `/BaseFont` with its subset prefix stripped
(`/AAAAAB+MS-Mincho` → `MS-Mincho`), through the existing `matchChain`, with
the style request from `font.ts`'s `fontStyleOf` — the one owner of "is this
bold or italic", shared with `fragmentsFromGlyphs` and `struct.ts`'s
`styledRuns`. A family hit wins outright, exactly as a chain does on the
authoring side: the document named a family, and a coverage score must not
overrule a name that matched.

**Rung 2 — coverage.** Score indexed faces against the codepoints *this font
dict can emit*:

| the font has | the emittable set is |
|---|---|
| a `/ToUnicode` CMap | its target codepoints, through `CMap.entries()` |
| a composite font with a known `/CIDSystemInfo` ordering | that collection's Unicode table (`cidunidata.ts`) |
| a simple font | its encoding's glyph names through `encoding.ts` |

**Note the second row needs NO new API, and the obvious reading is wrong.**
`CMap.entries()` exists (`cmap.ts:11`) and gives the first row its set
outright, but `CidToUnicode` exposes **`lookup(cid)` and nothing else** — there
is no enumeration to iterate. The set is therefore *probed*: sample CIDs
across the collection's range through `lookup` and keep what answers. That is
sufficient because the score is a fraction rather than a census, and it leaves
`cidunicode.ts` untouched rather than widening a public interface for one
consumer.

Both rows are sampled to a bounded set (a few hundred codepoints), since the
bundled tables hold 113,292 mappings across their five collections and the
answer does not improve past a sample. The exact bound is a constant the
implementation pins, with the measured cost beside it.

Pre-filter on `OS/2.ulUnicodeRange`, then confirm the top candidates against
their real `cmap`.

**Rung 3 — the bundled face.** `getStd14Sfnt(normalizeFont(...))`, today's
line, unchanged. Nothing matched is an ordinary outcome, not an error.

**Invariant: the pre-filter is FREE, and that is why it is worth having.**
`fontnames.ts` already reads the whole `OS/2` byte range to get
`usWeightClass` at offset 4 (`fontnames.ts:117`), so `ulUnicodeRange1..4`
(offsets 42, 46, 50, 54) and `sFamilyClass` (offset 30) are additive fields on
`FontNames` read from a slice already in hand — no extra I/O during indexing,
and `fontsource.ts`'s partial-read cost model survives untouched. Each needs
its own length guard beside the existing `os2.length >= 6` one: a version-0
`OS/2` is 78 bytes and covers both, but a truncated table must not be read
past its end.

**Invariant: the real-`cmap` confirm is per FONT DICT, not per file.**
`ulUnicodeRange` is a producer's claim about its own font and is routinely
optimistic, so it selects candidates and never decides. Confirming means a
second partial read — table directory plus the `cmap` range — for a handful of
faces, once per non-embedded font dict, which is a few reads per document
rather than per file indexed.

Tie-break: coverage fraction descending, then the descriptor's `/Flags` serif
bit (bit 2) against the face's `OS/2.sFamilyClass`, then index order.

**Note the serif rung is the one SOFT rule here, and it is recorded as such.**
The field is real and cited, but no oracle in this repo can say it chose well
— a serif face where a sans was wanted still renders perfectly readable text.
It is retained because the alternative is "whichever face sorts first", which
is worse for a reader and no more defensible. It is mutation-checked against a
hand-built pair so it stays a decision.

### Why there is no family-name table (`lqcs.3` folded)

`lqcs.3` proposed a middle step: the well-known families of a composite font's
`/CIDSystemInfo` ordering, so a PDF naming SimSun renders on a machine that
has only PingFang SC. Under rung 2 that step **is already taken**, by a
different route: for a composite font with a known ordering, "the font's own
emittable set" *is* `cidunidata.ts`'s table for that collection, so any face
covering Simplified Chinese scores and PingFang SC is found without anybody
writing its name down.

What a name table would have added is *preference* — pick MS Mincho over
whatever CJK face sorts first, serif over sans. That is a judgement list, not
a standard, and this repo does not ship constants nobody checked against a
source: a wrong entry would be invisible, since a wrong-but-plausible CJK face
still renders readable text. The three candidate sources to port from
(poppler's `GlobalParams`, fontconfig's `65-nonlatin.conf`, pdf.js's
standard-font map) disagree with each other, so choosing one is itself the
judgement it was meant to avoid.

Coverage scoring instead rests on `cidunidata.ts`, which is **already
vendored, already pinned** (mapping-resources-pdf 20230118) and already
anchored. Nothing unanchored ships, and the two rungs are one code path rather
than two that can disagree about one document.

The cost is stated rather than hidden: on a machine holding several CJK faces
we choose by coverage and a serif bit, not by taste, so the face may not be
the one a human would have picked. It will be a face that can draw the text,
which is the whole of what this epic promises.

### `GlyphSource` and the `lqcs.1` rule

`GlyphSource` keeps its shape. `substituted` goes on meaning "this `sfnt` is
not the document's own program", and `gidForCode`'s rule carries over
**unchanged**: a substituted composite font selects by **Unicode** and never
through `gidForProgram`, whose `cmapLookup(code)` / `cmapLookup(0xF000+code)`
fallbacks draw a confident wrong glyph for a CID. That holds whether the
substitute is bundled or installed, and it is why this issue adds no branch
there.

One field is added, `substituteFamily?: string`: which face was chosen. It is
the render-side counterpart of `FontMatch.exact` — the only way a caller or a
test can learn that a substitution happened and what it resolved to — and it
makes the rungs assertable without resting on pixel probes alone.

### Caching and cost

Three layers, each already present or trivially parallel to one that is:

- **The index** — `indexFolder`'s process-lifetime cache, keyed
  `${sniff}:${dir}`. Unchanged.
- **The parsed face** — memoized per document by `path#faceIndex`, mirroring
  `fontsByPath`. This one matters: indexing is partial reads, but *loading* a
  chosen face reads the whole file, and a CJK font is 10–20 MB. Keying by path
  alone would hand back face 0 of a `.ttc` for every face of it — the bug
  `LoadFontByName`'s own key records.
- **The resolution** — the existing per-sink `glyphSources` map, keyed on the
  font dict. Unchanged, and sound only because resolution is page-independent:
  it reads the font dict and the registered faces, never the text on the page
  being rendered. That is why rung 2 scores the font's *emittable* set rather
  than the drawn text.

## Acceptance

Restated from the issue, per correction 1:

> The same document renders differently with and without a registered render
> folder, and byte-identically to today with none. A page whose only font is a
> non-embedded composite font over a CJK collection draws real glyphs from a
> registered folder that holds a covering face. `ToSvg` output is unchanged in
> every case.

## Testing

**Hermetic, with no vendored CJK font.** `test/helpers/build-sfnt.ts`'s
`buildNamedFont` gains a `cmap` option so a synthetic face can cover chosen
codepoints (U+4E00 and neighbours) with a distinctive filled glyph; fonts are
written to a temp directory through `font-byname.test.ts`'s existing
`folderWith` pattern. Vendoring a real CJK face is rejected: Noto Sans CJK is
tens of megabytes, and what is under test is the resolution, not somebody
else's outlines.

**The acceptance case must compare renders, not assert that ink appears.**
`lqcs.1` measured that the unfixed build paints hairline placeholder **boxes**
— 1120 ink pixels for a four-CID run at 48pt — so a fixture asserting ink
passes on a build where nothing resolved. The case renders the same page with
and without the folder and compares against the face's own filled glyph.

Every rung gets its own mutation check, and three fixture shapes are known in
advance to be needed, each because the obvious one measures nothing:

- **Name must outrank coverage**: a face whose family matches `/BaseFont` but
  covers *less* than a rival, or the two rungs agree and the ordering is
  unfalsifiable.
- **The `cmap` confirm must outrank `ulUnicodeRange`**: a face claiming a
  range its `cmap` does not deliver. With honest faces the pre-filter and the
  confirm agree and the confirm can be deleted.
- **The serif tie-break**: two faces of *equal* coverage differing only in
  `sFamilyClass`. Any coverage difference settles it first and the rule goes
  unmeasured.

**Fences.** `test/html-identity.test.ts` and the existing render suites are
the fence for "nothing moved with nothing registered" — but the structural
argument above is the real guarantee, and it is asserted directly.

## Documentation

- `CHANGELOG.md` under `## [Unreleased]`, **Added**.
- `README.md`: Key Capabilities, and the API Reference table the two methods
  belong in. Note its example headings are imperative and its types table is
  several alphabetical runs concatenated.
- `CLAUDE.md`: a Source-list entry for `fontsubst.ts` when it lands, not when
  someone next touches the area — and the sweep in the Docs section must come
  back empty.
