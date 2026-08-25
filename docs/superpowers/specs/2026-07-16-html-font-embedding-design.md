# PDF → HTML export: `@font-face` embedding (`fonts: 'embed'`)

Issue: `aspose-pdf-foss-for-ts-kkh`

Follow-up to `2026-07-16-pdf-to-html-export-design.md`, which shipped fixed-mode
HTML export with CSS *family mapping* and explicitly deferred font-program
embedding to this opt-in issue.

## Goal

An opt-in mode for **fixed** HTML export that re-emits each PDF's embedded font
programs as base64 `@font-face` web fonts, so text renders in the document's own
faces with the document's own glyph metrics instead of a substitute stack. The
export layer keeps its composition ethos: reuse the renderer's code→GID
resolution and the existing sfnt/CFF parsers; add only an sfnt/WOFF *writer* and
the CSS wiring. Zero runtime dependencies (`node:zlib` only).

## Public API

One new field on the existing `HtmlOptions`:

```ts
export interface HtmlOptions {
  // …existing fields…
  /** Font handling in `fixed` mode. Default 'map'.
   *  'map'       — CSS family stacks (serif/sans/mono), no embedded programs.
   *  'embed'     — embed each embeddable font as a base64 WOFF @font-face;
   *                fonts whose OS/2 fsType sets the Restricted-License bit
   *                (0x0002) are skipped and fall back to 'map' for that font.
   *  'embed-all' — like 'embed' but ignore fsType (caller assumes licensing
   *                responsibility). */
  fonts?: 'map' | 'embed' | 'embed-all';
}
```

- Meaningful only in `mode: 'fixed'`. In `semantic` mode `fonts` is ignored —
  per-run embedded fonts fight the reflowability semantic mode exists for.
- Default `'map'` keeps current output **byte-identical**.
- No new public types or error types. `HtmlOptions` already flows through
  `Page.ToHtml` / `Document.ToHtml`; the union simply widens.

## Core approach

For every **distinct embedded font program** in the exported pages (deduplicated
by `fontDict` object identity, document-wide, exactly as `FontRegistry` dedups
style tuples), build a fresh browser sfnt whose **only** `cmap` is one this
export synthesizes, WOFF-wrap it, and emit it as one `@font-face`. Spans that use
that font reference its generated family name.

The glyph the browser selects must be the glyph the rasterizer draws. Both are
driven by the **same** code→GID resolver — `gidForCode` in `raster.ts` — so
fidelity is guaranteed by construction rather than reverse-engineered:

```
code --gidForCode--> GID          (font-program indexing; identical to the raster backend)
code --ToUnicode-->  Unicode      (TextFont)
```

We then synthesize a cmap keyed by a **rendering codepoint** we assign per GID
(see Hybrid assignment) that maps to that GID, and emit each glyph in its span as
its rendering codepoint. The original font's own cmap (if any) is discarded — a
freshly built cmap is uniform across subset and non-subset fonts, where relying
on the embedded cmap is not (subset PDF fonts frequently carry no usable Unicode
cmap).

### Hybrid codepoint assignment

Chosen in brainstorming over pure real-text (drops ligature/collision glyphs to a
substitute font) and pure PUA (destroys all copy/paste). Per glyph, resolved once
per GID and cached (stable, so a single emit pass suffices):

- `gid = gidForCode(src, code, uni)`; `uni = TextFont` ToUnicode text for `code`.
- If `uni` is exactly one Unicode scalar **and** that scalar is not already
  claimed by a *different* GID in this font → claim it. The glyph renders from
  the real character; its span text is that character (selectable, searchable,
  round-trips through `GetText`).
- Otherwise (multi-scalar ToUnicode such as an `ffi` ligature, empty ToUnicode,
  or a scalar already claimed by another GID) → assign the next Private-Use
  codepoint starting at `U+E000`. The glyph still renders correctly; its span
  emits the PUA codepoint (copy/paste yields the PUA char for that one glyph —
  the documented cost of guaranteeing the glyph over its text).

Assignment is deterministic: first sight of a GID fixes its rendering codepoint,
so `HtmlSink.glyphRun` can build each span inline while the complete
`GID → rendering-codepoint` map accumulates in the registry for cmap emission at
`css()` time. Multiple codes reaching the same GID: first sight wins.

Because a run's characters are emitted glyph-by-glyph from `decodeGlyphs`, a run
mixes real and PUA codepoints freely; no run is ever dropped to a substitute
font for a fidelity reason. Runs whose **font** cannot be embedded (below) still
fall back to map mode.

### Advances and intra-run spacing

A single `<span>` per run relies on the embedded font's `hmtx` advances to place
characters internally. We source advances from `TextFont.decodeGlyphs` em-widths
(`emWidth × unitsPerEm`), which are the PDF `/Widths` (`/W`) values and therefore
authoritative for how the PDF spaced this text:

- **glyf / OpenType-CFF fonts** (already sfnt): keep the original `hmtx` — the
  font's native advances — to minimize rewriting and risk. PDF `/Widths` that
  override native advances cause the same sub-glyph drift map mode already has;
  acceptable and pre-existing.
- **bare CFF wrapped into OTF**: no `hmtx` exists, so build one from the
  `decodeGlyphs` em-widths for used GIDs and a nominal advance
  (`unitsPerEm / 2`) for unused GIDs (which the fresh cmap never maps, so they
  never render).

## Font-flavor handling

Flavor comes from the PDF `FontDescriptor` (`/FontFile`, `/FontFile2`,
`/FontFile3` with `/Subtype`) and, for `/FontFile3`, from whether the program
begins with the `OTTO`/sfnt signature (already distinguished by `parseSfnt` vs a
bare CFF).

| PDF program | sfnt already? | Handling | Emitted flavor |
|---|---|---|---|
| `FontFile2` (TrueType `glyf`) | yes | keep all tables, **replace** `cmap` with the fresh one | TrueType sfnt → WOFF |
| `FontFile3` `OpenType` | yes | **replace** `cmap` | sfnt (CFF or glyf) → WOFF |
| `FontFile3` `Type1C` (simple CFF) | no | **wrap** `CFF ` verbatim into an OTF with fresh `cmap` + minimal `head`/`hhea`/`hmtx`/`maxp`/`name`/`OS/2`/`post` | OTF → WOFF |
| `FontFile3` `CIDFontType0C` (CID CFF) | no | same wrap (`gidForCode` already resolves CID→GID via `/CIDToGIDMap`) | OTF → WOFF |
| `FontFile` (Type1 PFB) | no | **not embeddable** — Type1→CFF conversion is out of scope | — (map-mode fallback) |
| non-embedded font (Std-14, no `FontFile*`) | — | **not embeddable** | — (map-mode fallback) |

Embeddability is probed once per `fontDict` and cached; a probe failure (parse
error, unsupported flavor, restricted `fsType` under `'embed'`) marks the font
non-embeddable, and all its runs use the existing `FontRegistry` (CSS stack). The
export therefore degrades **per font**, never per document.

### `fsType` policy

`fsType` lives in the font program's `OS/2` table (PDF `FontDescriptor` does not
carry it). Read it from the parsed sfnt; a bare CFF has no `OS/2`, so no
restriction is known and the font is treated as embeddable.

- `'embed'`: if `(fsType & 0x0002)` (Restricted License Embedding) → skip
  (map-mode fallback). Preview-&-Print (0x0004) and Editable (0x0008) are
  permissive enough for view-only HTML and are **not** blocked.
- `'embed-all'`: `fsType` ignored — the bytes are already present in the source
  PDF, and the caller has asserted licensing responsibility.

## Modules

New:

| File | Responsibility |
|---|---|
| `src/sfntwrite.ts` | sfnt **writer** primitives: `buildCmap(map)` (format 4; format 12 when any codepoint > U+FFFF), `assembleSfnt(tables, flavor)` (table directory, per-table + whole-font checksums, `head.checksumAdjustment`), `replaceTable(sfntBytes, tag, data)`, `otfFromCff(cffBytes, cmap, hmtx, metrics)` (minimal OTF assembly around a verbatim `CFF ` table) |
| `src/woffwrite.ts` | `sfntToWoff(sfntBytes)` — WOFF 1.0 container: 44-byte header + table directory (tag, offset, compLength, origLength, origChecksum) + per-table `zlib.deflateSync` (store uncompressed when deflate does not shrink, per spec) |
| `src/htmlfontembed.ts` | `EmbeddedFontRegistry`: per-`fontDict` embeddability probe + `fsType` policy, per-glyph hybrid codepoint assignment, GID/advance accumulation, and final CSS emission (`@font-face { font-family:…; src:url(data:font/woff;base64,…) }` + `.f#` class rules). Depends on `font.ts`, `raster.ts` (`buildGlyphSource`/`gidForCode`/`GlyphSource`), `sfnt.ts`, `cff.ts`, `sfntwrite.ts`, `woffwrite.ts` |

Edited:

- `src/raster.ts` — export the currently-internal `buildGlyphSource`,
  `gidForCode`, and the `GlyphSource` type so the embed registry resolves GIDs
  through the exact code the raster backend uses. No behavior change; export only.
- `src/htmlfixed.ts` — `HtmlSink` gains an `EmbeddedFontRegistry` (when
  `fonts !== 'map'`). `glyphRun` asks the embed registry for the run's rendering
  string + class; on a non-embeddable font the registry signals fallback and the
  sink uses the existing `FontRegistry`. `fixedBody` concatenates both registries'
  CSS.
- `src/html.ts` — thread `opts.fonts` into `fixedBody`; append the embed CSS to
  `FIXED_CSS`.
- `src/index.ts` — no change beyond the widened `HtmlOptions` (already exported).

`sfntwrite.ts` and `woffwrite.ts` are pure byte-builders with no PDF knowledge —
independently testable against `parseSfnt` / `sfntFromWoff` round-trips.

## Data flow — `fonts: 'embed'`

```
interpret(doc, page, sink)                     (one pass, unchanged)
  └─ glyphRun(info)                             HtmlSink
       ├─ fontRegistry?  (map / non-embeddable) → existing .f# class, real text
       └─ embedRegistry.run(info):
            for each glyph in font.decodeGlyphs(bytes):
              gid  = gidForCode(src, code, uni)
              cp   = assign(gid, uni)            real Unicode | PUA, cached per GID
              append cp to the span's display string
              record gid→cp and gid→advance
            → { cls, display }                   embedded family class + string
       └─ emit <span class="cls" style="left/top/size/transform">display</span>

css():   for each embeddable fontDict:
            sfnt = replaceTable(program, 'cmap', buildCmap(gid→cp))   (glyf / OTTO)
                 | otfFromCff(cff, buildCmap(gid→cp), hmtx, metrics)  (bare CFF)
            woff = sfntToWoff(sfnt)
            emit @font-face { font-family: pfN; src: data:font/woff;base64,… }
                 + .fN { font-family: pfN; font-weight; font-style; color }
```

Placement math (fast path vs. rotated/skewed transform path) is unchanged from
fixed mode — embedding changes only which `font-family` a span carries and the
characters inside it, not where the span sits.

## Error handling

`ToHtml` still **never throws**. Every embed step is guarded:

- A font that fails to parse, is an unsupported flavor, or is `fsType`-restricted
  under `'embed'` → marked non-embeddable → map-mode fallback for its runs.
- A cmap/sfnt/WOFF build that throws mid-way → that font is dropped to map mode;
  other fonts and the rest of the page are unaffected.
- A glyph whose GID cannot be resolved (`gidForCode` returns undefined) maps to
  GID 0 in the fresh cmap and renders `.notdef` — matching what the rasterizer
  draws for the same unresolved code, keeping the two backends consistent.
  (Embeddability is decided per font, not per glyph: a run is embedded as a unit
  or falls back as a unit.)

## Testing

Added to `test/html.test.ts` with programmatic fixtures in `test/helpers/` (an
embedded TrueType and an embedded CFF font builder; a bare-CFF and a
`fsType`-restricted variant):

- **TrueType embed**: `mode:'fixed', fonts:'embed'` emits one `@font-face` with a
  `data:font/woff;base64,` src; the referenced font parses back through
  `sfntFromWoff` → `parseSfnt`; its `cmap` maps each used real character to the
  expected GID; span text is the real characters (round-trips through `GetText`).
- **Bare-CFF wrap**: emitted program parses as a valid sfnt (`parseSfnt`),
  `outlines === 'cff'`, has `CFF `/`cmap`/`head`/`hhea`/`hmtx`/`maxp` tables, and
  `numGlyphs` matches the source CFF.
- **Hybrid PUA**: a ligature (multi-scalar ToUnicode) or a two-GIDs-one-Unicode
  collision yields a `U+E000`-range codepoint in both the span and the cmap; a
  plain character stays real.
- **fsType policy**: a restricted font (`fsType & 0x0002`) is skipped under
  `'embed'` (its runs carry a map-mode class, no `@font-face`) and embedded under
  `'embed-all'`.
- **Non-embeddable fallback**: a Type1 (`FontFile`) and a non-embedded Std-14
  font produce no `@font-face`; runs use the CSS stack.
- **WOFF container**: `sfntToWoff` output has the `wOFF` signature, a table
  directory whose entries decompress (`zlib.inflateSync`) to the original table
  bytes, and `sfntFromWoff(sfntToWoff(x))` reproduces every table of `x`.
- **cmap format switch**: an all-BMP set emits format 4; a set including a
  codepoint > U+FFFF emits format 12.
- **Dedup**: two runs sharing one `fontDict` emit exactly one `@font-face`; two
  distinct programs emit two.
- **Default unchanged**: `mode:'fixed'` with no `fonts` (and explicit
  `fonts:'map'`) produces byte-identical output to the pre-change fixed mode.

`npm run typecheck` and `npm test` both green before close.

## Delivery

Single plan against `kkh`, built bottom-up so each layer is tested before the one
above it depends on it:

1. `sfntwrite.ts` (+ `raster.ts` exports) — cmap/sfnt/OTF-from-CFF writers,
   tested via `parseSfnt` round-trips.
2. `woffwrite.ts` — `sfntToWoff`, tested via `sfntFromWoff` round-trips.
3. `htmlfontembed.ts` — `EmbeddedFontRegistry`, tested in isolation on fixtures.
4. Wire into `htmlfixed.ts` / `html.ts`; end-to-end `ToHtml` tests; README.

## Out of scope (documented in README)

- **Re-subsetting** to page-used glyphs. The PDF's embedded program (usually
  already subset) is emitted as-is; per-page glyph subsetting via `subset.ts` /
  `cffsubset.ts` is a later size optimization, not correctness.
- **WOFF2** — needs Brotli plus the WOFF2 `glyf` transform; disproportionate to
  this issue.
- **Type1 (`FontFile`) embedding** — would need Type1→CFF conversion; these
  fonts fall back to map mode.
- **Semantic mode** embedding — embedding fights reflow; `fonts` is fixed-mode
  only.
