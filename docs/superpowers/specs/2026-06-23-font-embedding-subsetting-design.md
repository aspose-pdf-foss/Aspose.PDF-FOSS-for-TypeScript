# Phase 7 — Font Embedding & Subsetting (design)

Content-authoring roadmap **Phase 7**, the deferred font-embedding track called
out in the Phase 6 "Non-goals"
(`docs/superpowers/specs/2026-06-22-font-text-authoring-design.md`). This spec is
the shared design for the Phase 7 epic (`aspose-pdf-foss-for-ts-gnr`) and blocks
its implementation children.

Phase 7 lets callers **embed real font files** and author text with **arbitrary
Unicode**, beyond the Standard-14 + WinAnsi ceiling of Phase 6. It introduces the
codebase's first **sfnt parser** (none exists today), **glyph subsetting** for
TrueType-flavored fonts, and **Type0/CIDFont (Identity-H) embedding**, then wires
embedded fonts through the existing `AddText`/`AddTextBlock` authoring API. It
adds **no new runtime dependencies** (only `node:zlib` for stream compression,
already used) and preserves the full-rewrite `Save` model.

## Scope

Loading a font program, measuring/encoding arbitrary text with it, and embedding
a (subset, where possible) font into the saved PDF:

1. **Track P — sfnt parsing** (`sfnt.ts`): parse a TrueType/OpenType font's table
   directory and the tables downstream steps need.
2. **Track S — glyph subsetting** (`subset.ts`): build a minimal valid `glyf`
   font program from the set of used glyphs.
3. **Track E — CIDFont embedding** (`fontembed.ts`): emit the Type0/CIDFont PDF
   object graph (FontFile, `/W`, `/CIDToGIDMap`, `/ToUnicode`).
4. **Authoring integration** (`stamp.ts`, `document.ts`, `page.ts`): a
   `doc.AddFont(bytes)` handle threaded through `AddText`/`AddTextBlock`.

### Key decisions (resolved during design)

- **Subset at `Save` (deferred finalize).** Subsetting needs the complete set of
  used glyphs, which is unknown until every draw has run. The `Document` keeps a
  registry of embedded fonts; each `AddText`/`AddTextBlock` draw records the
  glyphs it used on the font handle. A new **pre-serialize finalize pass** —
  `Save()` becomes `finalizeEmbeddedFonts(); serializeDocument(...)` — builds the
  subset, `FontFile`, and `/W` for each used font and patches its object graph.
  Rejected alternatives: embedding the whole font eagerly on first use (no
  subsetting, the point of the phase), and re-subsetting after every draw
  (redundant work, object churn).
- **Subset `glyf`; whole-embed CFF.** TrueType-flavored sfnt (`glyf`/`loca`) is
  subset and embedded as `FontFile2` in a **CIDFontType2** descendant. CFF /
  PostScript-outline OpenType (`.otf` with a `CFF ` table) is embedded **whole**
  (no subsetting) as `FontFile3 /Subtype /OpenType` in a **CIDFontType0**
  descendant. CFF subsetting is a separate parser and a non-goal here.
- **Opaque handle API.** `doc.AddFont(bytes)` returns an `EmbeddedFont` handle;
  callers pass it as `opts.font`. The authoring `font` option widens to
  `StdFont | EmbeddedFont`, avoiding any name collision with the 12 Standard-14
  strings and keeping the type safe. `node.ts` adds `AddFontFile(path)`.
- **Identity-H, CID = original GID.** Text is mapped Unicode → cmap → glyph id
  (GID) and the **original** GID is emitted as a 2-byte CID at draw time. Because
  show-strings are baked into page content during the draw — before subsetting
  renumbers glyphs at finalize — the CID must be the stable original GID. A subset
  `glyf` font therefore carries a `/CIDToGIDMap` **stream** (original GID → subset
  GID); the whole-embed CFF path, which never renumbers, uses `/CIDToGIDMap
  /Identity`. `/W` and `/ToUnicode` are keyed by the original GID. This matches the
  read side in `font.ts` (`parseType0Widths` assumes CID = code).
- **Characters absent from the font's cmap are dropped**, consistent with how the
  Phase 6 WinAnsi path drops unencodable characters. A fully-unencodable string is
  a no-op (`AddText` draws nothing; `AddTextBlock` returns `null`).

### Dependencies (all shipped on `main`)

- `font.ts` — the **read** counterpart: `TextFont` already decodes Type0 /
  Identity-H, parses `/W` (`parseType0Widths`, Identity CID = code), and reads
  `/ToUnicode`. Phase 7's embed output is validated by round-tripping through it.
- `stamp.ts` — `registerFont`, `measureText`, `stampText`, `stampTextBlock`,
  `buildStampBody`/`buildBlockBody` (the `Tf`/`Tj` emission seams).
- `metrics.ts` — Standard-14 measurement (`measure`, `StdFont`); unchanged, but
  the embedded path mirrors its `measure(font, bytes, fontSize)` shape.
- `pagecontent.ts` — `ensureOwnResources`, `ensureOwnSubdict`, `freshKey`,
  `appendContent`, `num`.
- `serialize.ts` — `enc`, `serializeString` (hex/literal show strings).
- `document.ts` — `allocObject`, `Save` (the finalize hook lands here),
  `resolve`. `flate.ts` — `FlateDecode` for compressing `FontFile`/`ToUnicode`
  streams.
- `layout.ts` — the word-wrap engine. **Today it is not font-agnostic**: it
  imports `measure`/`encodeWinAnsi`/`StdFont` directly and hardcodes the
  Standard-14 + WinAnsi path for both line measurement and `LaidLine.bytes`. A1
  refactors it to take a small **font driver** (see below) so the same engine
  flows Standard-14 (1-byte WinAnsi) and embedded (2-byte Identity-H) text.

## Track P — sfnt parser (`sfnt.ts`, new, internal)

A pure, dependency-free module that parses an sfnt font program into an in-memory
table model. No PDF objects, no document state.

```ts
// @internal
type OutlineKind = 'glyf' | 'cff';

interface SfntFont {
  outlines: OutlineKind;          // 'glyf' (TrueType) or 'cff' (.otf with 'CFF ')
  unitsPerEm: number;             // head.unitsPerEm (scale to /1000 em space)
  numGlyphs: number;              // maxp.numGlyphs
  indexToLocFormat: 0 | 1;        // head.indexToLocFormat (loca short/long)
  bbox: [number, number, number, number]; // head xMin/yMin/xMax/yMax (font units)
  ascent: number; descent: number; capHeight: number; // OS/2 + head
  italicAngle: number;            // post.italicAngle
  flags: number;                  // FontDescriptor /Flags (serif/italic/symbolic…)
  stemV: number;                  // approximated (OS/2 weight class heuristic)
  advanceWidth(gid: number): number;     // hmtx, font units
  cmapLookup(cp: number): number | undefined; // Unicode code point -> GID
  cmapReverse(): Map<number, number>;    // GID -> first Unicode (for /ToUnicode)
  // glyf only:
  glyphData(gid: number): Uint8Array;    // raw glyf bytes for `gid` (may be empty)
  componentGids(gid: number): number[];  // composite-glyph component GIDs
  raw: Uint8Array;                       // the original sfnt bytes (CFF whole-embed)
}

function parseSfnt(bytes: Uint8Array): SfntFont;
```

- Reads the table directory (sfnt version `0x00010000` or `OTTO`), then `head`,
  `maxp`, `hhea`+`hmtx`, `cmap`, `name`, `OS/2`, `post`. For `glyf` fonts also
  `loca`+`glyf`. Presence of a `CFF ` table ⇒ `outlines: 'cff'`.
- **cmap**: support subtable **format 4** (BMP) and **format 12** (full Unicode);
  prefer a `(3,10)` or `(3,1)` Windows Unicode subtable, falling back to
  `(0,*)`. A `glyf` font with no usable Unicode cmap throws
  `UnsupportedFeatureError`.
- **FontDescriptor metadata**: `/Flags`, `/FontBBox`, `/Ascent`, `/Descent`,
  `/CapHeight`, `/ItalicAngle`, `/StemV` are derived here (StemV approximated from
  the OS/2 weight class — exact stem extraction is a non-goal).
- Throws `PdfParseError` on a truncated/malformed directory or a missing required
  table; `UnsupportedFeatureError` for a non-sfnt container (WOFF/WOFF2, bare
  CFF, Type1/PFB).

## Track S — glyph subsetting (`subset.ts`, new, internal)

Builds a minimal valid `glyf` sfnt from a parsed font and a set of used GIDs.
`glyf` fonts only.

```ts
// @internal
interface SubsetResult {
  bytes: Uint8Array;              // a valid standalone sfnt with pruned glyf/loca
  gidMap: Map<number, number>;    // old GID -> new GID (dense, GID 0 = .notdef)
}

function subsetGlyf(font: SfntFont, usedGids: Iterable<number>): SubsetResult;
```

Algorithm:

1. **Glyph closure** — start from `usedGids ∪ {0}` (always keep `.notdef`); for
   each composite glyph, pull in its `componentGids` transitively until the set is
   closed.
2. **Renumber** — assign new dense GIDs in ascending old-GID order, recording
   `gidMap`.
3. **Rebuild `glyf`** — concatenate retained glyph data (rewriting composite
   component GIDs through `gidMap`); rebuild **`loca`** choosing short vs long
   format by the new table size and updating `head.indexToLocFormat`.
4. **Reassemble** — emit a new table directory with the retained/rewritten tables
   (`head`, `maxp` with new `numGlyphs`, `hhea`/`hmtx` trimmed to the subset,
   `cmap` may be dropped — PDF uses Identity-H, not the font cmap, at view time),
   recompute each table checksum and `head.checkSumAdjustment`.

> **CID = GID note.** Because the PDF maps text → original GID and we renumber
> during subsetting, the embed step (Track E) maps **CID = original GID** and
> supplies a `/CIDToGIDMap` **stream** translating original GID → subset GID. (An
> `/Identity` map is used only when no subsetting occurred, i.e. the CFF path.)
> This keeps `/W` and `/ToUnicode` keyed by the stable original GID.

## Track E — CIDFont embedding (`fontembed.ts`, new)

Builds the PDF font object graph for one embedded font and returns the Type0
font dict (to register as a `/Font` resource).

```ts
// @internal
function buildEmbeddedFont(
  doc: Document, font: SfntFont, usedGids: Set<number>,
): PdfDict; // the Type0 font dict (allocated descendants/descriptor/streams)
```

- **Type0** font: `/Subtype /Type0`, `/Encoding /Identity-H`, `/BaseFont` =
  `ABCDEF+<PostScriptName>` (a deterministic six-uppercase-letter subset tag),
  `/DescendantFonts [ <cidfont> ]`, `/ToUnicode <stream>`.
- **Descendant CIDFont**:
  - `glyf`: `/Subtype /CIDFontType2`, `/CIDToGIDMap` = stream (orig GID → subset
    GID), `/FontDescriptor` with `/FontFile2` = the `subsetGlyf` bytes.
  - `cff`: `/Subtype /CIDFontType0`, `/CIDToGIDMap /Identity`, `/FontDescriptor`
    with `/FontFile3 /Subtype /OpenType` = the whole sfnt bytes.
  - `/CIDSystemInfo` `{ Registry (Adobe) Ordering (Identity) Supplement 0 }`,
    `/DW` (default width) and `/W` (per-CID widths from `hmtx`, scaled
    `1000/unitsPerEm`, keyed by original GID).
- **FontDescriptor**: `/Flags`, `/FontBBox`, `/ItalicAngle`, `/Ascent`,
  `/Descent`, `/CapHeight`, `/StemV` from the parsed metadata, scaled to /1000 em.
- **`/ToUnicode`**: a CMap stream built from `cmapReverse()` so extraction and
  copy-paste recover the original text. `FontFile*` and `ToUnicode` streams are
  `FlateDecode`-compressed; `FontFile2` carries `/Length1` (uncompressed length).
- Allocation uses `doc.allocObject`; nothing in the caller's existing objects is
  mutated, so a second `Save()` re-runs finalize cleanly.

## Authoring integration (`stamp.ts`, `document.ts`, `page.ts`)

### The handle and the registry

```ts
// public
class EmbeddedFont { /* opaque handle; identity only */ }

class Document {
  /** Parse and register a font program; returns a handle for AddText/AddTextBlock. */
  AddFont(bytes: Uint8Array): EmbeddedFont;
  // node.ts adds: AddFontFile(path: string): EmbeddedFont
}
```

Internally each `EmbeddedFont` owns its `SfntFont`, a `usedGids: Set<number>`, a
memoized `text → { bytes, width }` encoder, and — once finalized — the resource
key / object refs it was assigned. The `Document` holds the set of registered
fonts for the finalize pass.

### Threading through draws

- `StampOptions.font` / `TextBlockOptions.font` widen to `StdFont | EmbeddedFont`.
  `normalizeOptions` accepts either; a value that is neither a known `StdFont`
  string nor an `EmbeddedFont` throws `TypeError`.
- **Font driver.** A1 introduces a small interface that both font kinds satisfy,
  so `measureText`/`layout`/emission stop hardcoding WinAnsi:

  ```ts
  // @internal
  interface FontDriver {
    encode(text: string): Uint8Array;          // WinAnsi 1-byte | Identity-H 2-byte (+ records GIDs)
    measure(text: string, fontSize: number): number; // points
  }
  ```

  A Standard-14 driver wraps `encodeWinAnsi` + `metrics.measure`; an embedded
  driver encodes via `cmapLookup` (recording used GIDs) and measures via
  `advanceWidth` scaled by `fontSize/unitsPerEm`. `layoutText` takes a
  `FontDriver` instead of `(font, fontSize)`, and `LaidLine.bytes` is whatever the
  driver emitted. This refactor is the bulk of A1's surface area; the Standard-14
  behavior must be byte-for-byte unchanged (covered by existing Phase 6 tests).
- **Emission**: the embedded path encodes text to **2-byte Identity-H** glyph
  strings (each char → cmap GID → CID bytes), recording each GID in `usedGids`,
  and emits the same `BT … Tf … Tj … ET` shape via `serializeString`. `registerFont`
  gains an embedded branch that reserves a `/Font` resource key bound to the
  handle (the dict is filled at finalize).

### Finalize at Save

`Document.Save` runs `finalizeEmbeddedFonts()` before `serializeDocument`:
for every registered font that was actually used, call `buildEmbeddedFont` and
write the resulting Type0 dict into the resource slot(s) reserved during drawing.
Unused registered fonts emit nothing. Finalize is idempotent (safe across
repeated saves).

## Module / file layout

| Module | Track | Responsibility |
|---|---|---|
| `sfnt.ts` (new) | P | parse table directory + needed tables → `SfntFont` |
| `subset.ts` (new) | S | glyph closure + `glyf`/`loca` prune + checksum rebuild |
| `fontembed.ts` (new) | E | Type0/CIDFont object graph (FontFile, `/W`, `/CIDToGIDMap`, `/ToUnicode`) |
| `embeddedfont.ts` (new) | E/A | `EmbeddedFont` handle: sfnt + used-glyph set + encode/measure |
| `layout.ts` (refactor) | A | take a `FontDriver` instead of `(StdFont, fontSize)`; Standard-14 behavior unchanged |
| `stamp.ts` (extend) | A | `font: StdFont \| EmbeddedFont`; `FontDriver`s; embedded measure + Identity-H emission |
| `document.ts` (extend) | A | `AddFont`; embedded-font registry; finalize hook in `Save` |
| `node.ts` (extend) | A | `AddFontFile(path)` |
| `page.ts` / `index.ts` | A | thread handle; export `EmbeddedFont` and public types |

## Errors

- `UnsupportedFeatureError` — non-sfnt container (WOFF/WOFF2, bare CFF, Type1/PFB),
  or a `glyf` font with no usable Unicode cmap (formats 4/12).
- `PdfParseError` — truncated/malformed sfnt directory or a missing required table.
- `TypeError` — a `font` option that is neither a known `StdFont` string nor an
  `EmbeddedFont` handle (consistent with the rest of the authoring API).
- Characters absent from the font's cmap are **dropped** (not an error), matching
  the Phase 6 WinAnsi-unencodable behavior.

## Testing strategy

Per-issue vitest TDD. Parser and subsetter are unit-tested without a document;
embedding is validated by round-tripping through this library's own read side.

- **P (sfnt.ts)**: parse a small committed TTF fixture — assert `unitsPerEm`,
  `numGlyphs`, a known `cmapLookup`, an `advanceWidth`, and the derived descriptor
  metadata; assert a CFF `.otf` reports `outlines: 'cff'`; assert WOFF / truncated
  input throws the right error.
- **S (subset.ts)**: subset to a small GID set — assert the result re-parses via
  `parseSfnt`, contains exactly the glyph closure (composite components pulled in),
  preserves advance widths, and that `gidMap` is dense from 0.
- **E (fontembed.ts)**: `buildEmbeddedFont` emits a Type0/CIDFontType2 graph whose
  `/W`, `/CIDToGIDMap`, and `/ToUnicode` are correct; **`Save()` → `Open()` →
  `Page.GetText()` recovers the drawn Unicode** (closing the loop with `font.ts`);
  the CFF path emits CIDFontType0 + `FontFile3`.
- **A (authoring)**: `AddText`/`AddTextBlock` with an embedded font measure
  non-WinAnsi text (e.g. `café — 你好`), wrap correctly, record only the used
  glyphs (subset size scales with distinct glyphs), and round-trip; an
  all-uncmapped string is a no-op; a second `Save()` produces identical output.

Every operation that mutates a page asserts a `Save()`/`Open` round-trip.

## Non-goals (Phase 7)

- **CFF/Type1C subsetting** — CFF OpenType is whole-embedded, not subset.
- **WOFF/WOFF2, bare CFF, Type1/PFB, bitmap (`EBDT`/`CBDT`) fonts** — sfnt
  (`glyf`/`CFF `) containers only.
- **Hinting/`gasp` fidelity, exact StemV extraction** — StemV is approximated.
- **Complex text** — RTL/bidi, combining-mark composition, OpenType shaping
  (GSUB/GPOS), ligatures; one code point → one glyph via cmap only.
- **Vertical writing modes** (Identity-V), and non-Identity CID orderings.
- **Rich runs** — one block/stamp is still one font/size/color (unchanged from
  Phase 6).

## Beads decomposition

Epic `Phase 7 — Font embedding & subsetting` (`aspose-pdf-foss-for-ts-gnr`):

| ID | Title | Depends on |
|---|---|---|
| gnr.1 | Phase 7 design spec (this document) | — |
| gnr.2 | P1 — sfnt/TrueType parser (directory, glyf/loca/cmap/hmtx) | gnr.1 |
| gnr.3 | S1 — glyph subsetting (closure, glyf/loca prune) | gnr.2 |
| gnr.4 | E1 — Type0/CIDFont embedding (FontFile, Identity-H, CIDToGIDMap, W, ToUnicode) | gnr.2, gnr.3 |
| gnr.5 | A1 — authoring integration (embedded fonts in AddText/AddTextBlock) | gnr.4 |

Each child follows the repo's spec → plan → implementation cycle with vitest TDD,
matching the Phase 5/6 structure. README (Features, API overview, Limitations) is
updated as each public API lands.
