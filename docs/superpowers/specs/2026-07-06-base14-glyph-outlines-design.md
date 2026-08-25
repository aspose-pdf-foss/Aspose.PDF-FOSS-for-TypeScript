# Bundle Base-14 glyph outlines for raster text (3sh.3)

**Issue:** aspose-pdf-foss-for-ts-3sh.3 (epic 3sh: PDF rendering: page → SVG → raster)
**Date:** 2026-07-06

## Goal

Ship compact outline data for the 14 base fonts so that **non-embedded**
Standard-14 text rasterizes as real glyphs in `Page.ToImage()`, replacing the
low-coverage placeholder-box fallback introduced in 3sh.2.6. Must respect the
zero-runtime-dependency ethos (embed data, only `node:` built-ins) and document
the package-size cost.

Scope is the **raster** backend only. `ToSvg()` renders non-embedded text with
`<text>` + `font-family` and needs no outline data.

## Data source & licensing

Full faces (not subset) are bundled for all 14 Standard-14 fonts:

| Standard-14 face(s)                                   | Substitute                         | License              |
| ----------------------------------------------------- | ---------------------------------- | -------------------- |
| Helvetica / -Bold / -Oblique / -BoldOblique           | Liberation Sans (R/B/I/BI)         | SIL OFL 1.1          |
| Times-Roman / -Bold / -Italic / -BoldItalic           | Liberation Serif (R/B/I/BI)        | SIL OFL 1.1          |
| Courier / -Bold / -Oblique / -BoldOblique             | Liberation Mono (R/B/I/BI)         | SIL OFL 1.1          |
| Symbol                                                | URW Standard Symbols PS (a010013l) | AGPLv3 + font exception |
| ZapfDingbats                                          | URW Dingbats (d050000l)            | AGPLv3 + font exception |

Liberation faces are metric-compatible with the Helvetica/Times/Courier
families; URW faces are the canonical Ghostscript substitutes for
Symbol/ZapfDingbats. License texts are committed and shipped in the npm package.

**All 14 files are TrueType (`glyf` outlines)** — including the URW `.ttf`
variants of Symbol/Dingbats — so the runtime loader parses every face uniformly
via `parseSfnt` (no CFF branch needed). The source files are already fetched
into `fonts/` (Liberation 2.1.5 tarball; URW `StandardSymbolsPS.ttf` +
`D050000L.ttf` from `ArtifexSoftware/urw-base35-fonts`), with provenance and
SHA-256 checksums recorded in `fonts/SOURCES.md` + `fonts/SHA256SUMS.txt`.

## Why this integrates cheaply

The existing raster glyph path already does the hard parts:

- `rasterizeGlyphRun` (raster.ts) computes each glyph's **Unicode** (`g.text`)
  from `TextFont.decodeGlyphs`, and advances the pen by the **PDF-declared
  widths** (`g.width`), not the font program's own advances.
- `gidForCode` already has a simple-font branch that resolves a glyph via
  `src.sfnt.cmapLookup(text.codePointAt(0))`.

Therefore a substitute only needs to supply the glyph **shape** through its own
Unicode cmap. Text spacing stays exactly as the PDF specifies regardless of the
substitute's metrics. No change to `rasterizeGlyphRun` or the advance math.

## Components

Each unit has one purpose, a narrow interface, and can be understood/tested on
its own.

### `fonts/` (repo-only, not shipped) — already populated
The 14 raw source TrueType files (Liberation `*.ttf` ×12, URW
`StandardSymbolsPS.ttf` + `D050000L.ttf`), plus:
- `LICENSE-OFL.txt`, `LICENSE-URW-AGPL.txt`
- `SOURCES.md` — upstream release URLs, versions, face→file mapping
- `SHA256SUMS.txt` — SHA-256 of each file

Excluded from the npm tarball via `package.json` `files` (only `dist/` ships).
The generated `src/std14data.ts` is the shipped artifact.

### `scripts/gen-std14-fonts.mjs` (committed generator)
One-time / re-runnable node script. For each face:
1. Read the raw font bytes from `fonts/`.
2. `deflateSync` (node:zlib) → base64.
3. Emit `src/std14data.ts` as `export const STD14_DATA: Record<StdFont, string>`
   plus a header comment noting it is generated (do not edit by hand) and the
   command to regenerate.

No npm dependency; only `node:fs`/`node:zlib`. Fully reproducible in-repo from
the committed `fonts/`.

### `src/std14data.ts` (generated)
The 14 base64 deflated sfnt blobs keyed by `StdFont`. This is the ~1 MB that
compiles into `dist` — the documented package-size cost.

### `src/std14fonts.ts` (runtime loader)
```ts
export function getStd14Sfnt(std: StdFont): SfntFont | undefined;
```
- Lazily, on first request for a face: `Buffer.from(b64, 'base64')` →
  `inflateSync` (node:zlib) → `parseSfnt`.
- Caches the parsed `SfntFont` in a module-level `Map<StdFont, SfntFont | null>`
  (null = parse failed, so we do not retry).
- Never throws; returns `undefined` on any failure so the caller degrades to the
  placeholder box.

### `src/raster.ts` — `buildGlyphSource` (the only edit to existing code)
After the embedded-outline resolution fails to find any `FontFile*`, and the
font is a simple (non-Type0) font:
```ts
if (!sfnt && !cff && !isType0) {
  const base = /* /BaseFont name, undefined-safe */;
  sfnt = getStd14Sfnt(normalizeFont(base ?? 'Helvetica'));
}
```
`normalizeFont` (metrics.ts) already maps subset prefixes, Arial/Times/Courier
aliases, and Acrobat abbreviations to a `StdFont`, defaulting to Helvetica. The
resulting `src.sfnt` flows through the unchanged `gidForCode` / `glyphOutline`
path. `drawGlyphPlaceholder` remains the final fallback when the substitute
cannot resolve a glyph or data is unavailable.

**Scope decision (confirmed):** the substitute applies to *all* non-embedded
simple fonts (via `normalizeFont`, default Helvetica), mirroring how real
viewers substitute, not only exact Standard-14 names.

## Data flow

```
Page.ToImage()
  → interpret() → sink.glyphRun(info)
    → rasterizeGlyphRun: glyphs = font.decodeGlyphs(bytes)  // g.text = Unicode, g.width = PDF advance
      → buildGlyphSource(fontDict) [cached per fontDict]
          embedded FontFile*?  → parse as today
          else non-embedded simple → getStd14Sfnt(normalizeFont(BaseFont))
      → per glyph: gidForCode(src, code, g.text)            // cmapLookup(Unicode)
          → src.sfnt.glyphOutline(gid) → flattenGlyphContours → rasterizeFill
          → if unresolved: drawGlyphPlaceholder (unchanged fallback)
```

## Symbol / ZapfDingbats note

`TextFont` decodes Symbol and ZapfDingbats codes to Unicode via their built-in
encodings (Symbol → Greek/technical Unicode; ZapfDingbats → U+2700 block). The
URW substitutes carry Unicode cmaps for these ranges, so they resolve through
the same `cmapLookup(Unicode)` path. Any code the substitute's cmap does not
cover degrades to the placeholder box rather than failing. Exact Symbol coverage
is therefore best-effort; Latin coverage is complete.

## Error handling

- Missing/corrupt embedded data, `inflateSync` failure, or `parseSfnt` failure →
  `getStd14Sfnt` returns `undefined`, caller draws the placeholder box.
- A resolved substitute with a missing glyph for a particular code → placeholder
  box for that glyph only.
- `renderPageToPng` already wraps interpretation in degrade-on-error; no new
  throwing paths are introduced.

## Testing

`test/helpers/build-svg-fixtures.ts`: add a fixture builder producing a page
that shows text in non-embedded `/Helvetica`, `/Times-Bold`, `/Courier`, and
`/Symbol` (simple Type1 font dicts, no FontFile).

`test/raster-std14.test.ts` (vitest), deterministic pixel checks:
- A capital letter (e.g. "H") in non-embedded Helvetica paints a known
  **interior** pixel (glyph body), not just a hairline outline.
- Painted-pixel count for the glyph is well above the empty placeholder box
  (proves filled outlines vs. box).
- `/Times-Bold` and `/Courier` also render filled glyphs.
- `/Symbol` renders a filled glyph **or** cleanly falls back (no throw, valid
  PNG) — asserted as "does not throw and PNG is valid".

`README.md`: document the embedded-font package-size impact in the rendering /
limitations section, and note the bundled font licenses.

## Package-size cost

The generated `src/std14data.ts` adds **~3.1 MB** to the published package
(measured: deflated + base64 of the 14 full faces; raw input is ~4.2 MB). The
overage beyond a Latin-only subset is non-Latin glyph coverage
(Cyrillic/Greek/Hebrew/etc.) that Standard-14 substitution never looks up;
bundling full faces was chosen deliberately to avoid an offline subsetting tool
and keep regeneration node-only and in-repo. Documented in README. A future
size optimization (Node-only or `y18` CFF subsetter) can cut this to a few
hundred KB without changing the public behavior.

## Out of scope

- Subsetting the bundled faces (a future size optimization; could reuse the CFF
  subsetter from issue y18).
- Substituting for non-embedded **Type0/CID** fonts (composite fonts); only
  simple fonts are covered here.
- Stroke-text (`Tr` render modes) changes; fills only, as today.

## Implementation risk (resolved)

The generator requires the actual font files as input. **These are already
fetched into `fonts/`** (all 14, verified TrueType with checksums recorded), so
`gen-std14-fonts.mjs` can run immediately. Remaining uncertainty is limited to
per-face Symbol/ZapfDingbats cmap coverage, which degrades to the placeholder
box per the error-handling section.
