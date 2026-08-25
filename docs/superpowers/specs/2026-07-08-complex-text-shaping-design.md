# Complex-text shaping: bidi + OpenType GSUB/GPOS — Design

**Issue:** aspose-pdf-foss-for-ts-8u0
**Date:** 2026-07-08
**Status:** Approved (brainstorming)

## Goal

Shape complex scripts for text authoring (`Page.AddText` / `Page.AddTextBlock`)
with embedded OpenType fonts: Unicode bidi/RTL reordering, ligatures and
contextual substitution (GSUB), and positioning/kerning plus mark placement
(GPOS). Today authoring is one code point → one glyph via `cmap`, LTR only.

**Acceptance:** `AddText`/`AddTextBlock` shape Arabic and Latin-ligature samples
correctly (glyph selection + advances + RTL order); opt-in per font; vitest;
README i18n note updated.

**Scope decision:** full engine — GSUB + Unicode bidi + GPOS kerning + GPOS mark
positioning. Opt-in **per font and per call** ("Both").

## Non-goals

- Script-specific reordering engines (Indic/SEA `RPHF`/reordering, Khmer, etc.).
  Only generic GSUB/GPOS is applied; scripts needing a dedicated reordering
  stage are out of scope.
- Shaping for Standard-14 fonts (Latin/WinAnsi only, no embedded tables).
- `justify` alignment for shaped text (stays a left-alignment fallback, as it
  already is for embedded fonts — `Tw` is inert for 2-byte Identity-H text).
- Vertical writing modes.

## Architecture

The engine sits between "text string + embedded font" and content-stream bytes,
replacing the 1:1 `codepoint → glyph` step **only** when shaping is enabled for
an `EmbeddedFont`. The Standard-14 path and the non-shaped embedded path are
untouched (byte-for-byte identical output).

### New modules (zero runtime deps — `node:` built-ins only)

| Module | Responsibility |
|---|---|
| `src/unicode-data.ts` (generated) | Sorted range tables for `Bidi_Class`, `Joining_Type`/`Joining_Group`, `Script`, `Canonical_Combining_Class`, and bracket/mirroring pairs, with binary-search lookups. Emitted by `npm run gen:ucd`. |
| `src/bidi.ts` | UAX #9 reordering → visual-order level runs; paragraph base-direction detection (`dir: auto` → first-strong P2/P3); script itemization (split runs by Unicode script → OpenType script tag + direction). |
| `src/otlayout.ts` | Parse `GDEF`/`GSUB`/`GPOS`; apply a feature set to a glyph buffer. |
| `src/shape.ts` | Orchestrator: `(text, sfnt, {script?, lang?, dir?}) → PositionedGlyph[]`. Ties joining-form feature computation + itemization + OT layout. |
| `src/otemit.ts` | Convert a `PositionedGlyph[]` run into a minimal `BT…ET` body (`Tf`/`Tm`/`TJ`/`Ts`). (May be folded into `stamp.ts` if small.) |

### Touched existing modules

- `src/sfnt.ts` — expose lazily-parsed `GDEF`/`GSUB`/`GPOS` (raw bytes already
  reachable via `table(tag)`); cache parsed tables on the `SfntFont`.
- `src/embeddedfont.ts` — carry a `shape` flag; a richer driver that returns
  positioned runs (not just bytes); record final gids for subsetting and a
  `gid → source code points` map for `/ToUnicode`.
- `src/layout.ts` / `src/stamp.ts` — wrap in logical order, then bidi-reorder +
  shape per line; positioned emission via `otemit`.
- `src/document.ts` — `AddFont`/`AddFontFile` options (`{ shape }`).
- `src/page.ts` — per-call `shape`/`dir`/`script`/`language` options.
- `src/subset.ts` — unchanged. Shaping produces **original** gids (exactly as
  `cmap` lookup does today), which flow into `usedGids`; the existing subset pass
  emits only `glyf`/`head`/`hhea`/`hmtx`/`loca`/`maxp` and remaps gids, so
  GSUB/GPOS/GDEF are naturally absent from the embedded subset. The CID scheme
  (Identity-H CID → subset gid) is inherited unchanged from the current embedded
  path.

## Data model

```ts
interface PositionedGlyph {
  gid: number;      // glyph id in the embedded font (= CID under Identity-H)
  cluster: number;  // index into the source code-point array (for /ToUnicode + wrap safety)
  xAdvance: number; // font units, post-GPOS
  xOffset: number;  // font units, GPOS placement (marks/cursive)
  yOffset: number;  // font units, GPOS placement
}
interface ShapedRun { glyphs: PositionedGlyph[]; rtl: boolean; }
```

`measure()` = Σ `xAdvance` × scale. `encode`/emit consumes the same run, so
measurement and rendering never diverge.

## Shaping pipeline (`shapeText(text, sfnt, {script?, lang?, dir?})`)

1. **Bidi** (`bidi.ts`): decode code points; UAX #9 → level runs in **visual
   order**. Base direction from `dir` (`auto` = first-strong).
2. **Itemize**: within each level run, split by Unicode script (and by the
   font's covered scripts) → segments, each with an OpenType script tag
   (`arab`, `latn`, …) and direction.
3. **Per segment:**
   a. `cmap` map code points → nominal gids (record `cluster`).
   b. Feature set: always-on `ccmp`, `liga`, `rlig`, `kern`, `mark`, `mkmk`; for
      Arabic add per-glyph joining features `init`/`medi`/`fina`/`isol` computed
      from `Joining_Type` (Arabic Cursive Joining), plus `calt`.
   c. **GSUB** pass: apply enabled features' lookups in list order, mutating the
      buffer (N→1 ligatures, 1→N `ccmp`; clusters merge).
   d. **GPOS** pass: fill `xAdvance`/`xOffset`/`yOffset`; advances seed from
      `hmtx`.
   e. No GSUB/GPOS present → c/d are no-ops (nominal gids + hmtx); bidi/RTL still
      applies.
4. Concatenate segments in visual order. Arabic/RTL runs are shaped in logical
   order then reversed for visual emission ("shape logical, reverse for RTL").
5. Record every final `gid` in `EmbeddedFont.usedGids`; build `gid → source code
   points` for `/ToUnicode` (ligature gid → its component string).

### Wrapping interaction (`AddTextBlock`)

Wrap in **logical order** (measure candidate lines by shaping them), then run the
full pipeline (bidi reorder + shape) per final line for emission. Line breaks
occur only at spaces (Arabic non-joining boundaries), so per-line shaping equals
per-paragraph shaping. `justify` → left fallback for shaped/embedded fonts.

## OpenType layout coverage (`otlayout.ts`)

Shared helpers: Coverage (formats 1/2), ClassDef (1/2), Script/Feature/Lookup
lists, LangSys resolution (`dflt` + requested language tag).

**GSUB lookups:** 1 Single (1/2), 2 Multiple, 3 Alternate (→ first), 4 Ligature
(1), 5 Contextual (1/2/3), 6 Chaining context (1/2/3), 7 Extension, 8 Reverse
chaining single.

**GPOS lookups:** 1 Single, 2 Pair/kerning (1/2), 3 Cursive (best-effort), 4
Mark-to-base, 5 Mark-to-ligature (best-effort), 6 Mark-to-mark, 7/8 Contextual/
chaining (1/2/3), 9 Extension.

**GDEF:** glyph class def (base/ligature/mark/component) for mark filtering;
mark-attachment class sets; mark-filtering sets. `LookupFlag` bits honored:
`IgnoreBaseGlyphs`, `IgnoreLigatures`, `IgnoreMarks`, `MarkAttachmentType`,
`UseMarkFilteringSet`, `RightToLeft`.

Anything absent/malformed **degrades to a no-op** (buffer passes through), never
throws — consistent with the library's "unsupported content degrades"
convention.

## Content-stream emission (`otemit.ts`)

PDF advances the text pen by each glyph's global `/W` width, but GPOS varies
advances/offsets **per occurrence**. Keep `/W` at each glyph's natural `hmtx`
advance and correct per-occurrence:

- **x advance delta** (`xAdvance − naturalAdvance`, e.g. kerning): a number in
  the `TJ` array (PDF subtracts `n/1000 × fontSize`).
- **x placement** (`xOffset`, marks): a `TJ` number before the glyph and its
  inverse after, so the pen returns; the mark's net advance is honored by its
  own delta.
- **y placement** (`yOffset`): set `Ts` (text rise) before the glyph, reset
  `Ts 0` after. `Ts` doesn't affect horizontal advance.

A run becomes one `BT … Tf … rg … Tm … [ … ] TJ … ET`, with `Ts` toggled only
around glyphs needing it. When every glyph has zero offsets and zero advance
delta (plain LTR Latin, no kerning), it collapses to a single `Tj` — **output is
byte-for-byte identical to today** for non-shaped documents.

`/ToUnicode` is built from the `gid → source code points` cluster map, so shaped/
ligated/RTL text extracts and copies back as the original Unicode (RTL restored
to logical order).

## API surface

Enabling shaping — per font and per call ("Both"):

```ts
// Per font (default for every draw with this handle):
const ar = doc.AddFont(arabicTtf, { shape: true });   // AddFontFile(path, { shape: true }) too
doc.Pages[0].AddText('مرحبا بالعالم', 72, 700, { font: ar, fontSize: 18 });

// Per call — override the font default either way:
doc.Pages[0].AddText(txt, 72, 700, { font: latinHandle, shape: true });   // force on
doc.Pages[0].AddText(txt, 72, 680, { font: ar, shape: false });           // force off
doc.Pages[0].AddText(txt, 72, 660, { font: ar, dir: 'rtl', script: 'arab', language: 'ARA' });
```

- `AddFontOptions { shape?: boolean }` — default `false` (backward-compatible).
- `StampOptions` / `TextBlockOptions` gain `shape?: boolean`,
  `dir?: 'auto' | 'ltr' | 'rtl'` (default `'auto'`), `script?: string` (OpenType
  tag, default auto per itemization), `language?: string` (OpenType language-
  system tag, default `dflt`). Per-call `shape` overrides the font flag.
- **Standard-14 fonts:** `shape` is silently ignored (no embedded tables).
- **Effective shaping** happens only when the resolved font is an `EmbeddedFont`
  **and** shaping is on; otherwise today's exact 1:1 path.
- `MeasureText` reflects shaping automatically (runs the same shaper).

## Unicode data (`unicode-data.ts` + `gen:ucd`)

- `scripts/gen-ucd.mjs` (wired as `npm run gen:ucd`) reads UCD files
  (`extracted/DerivedBidiClass.txt`, `ArabicShaping.txt`, `extracted/DerivedJoiningType.txt`,
  `Scripts.txt`, `UnicodeData.txt` for `Canonical_Combining_Class`, `BidiBrackets.txt`,
  `BidiMirroring.txt`) and emits `src/unicode-data.ts` as sorted range tables with
  binary-search lookups. Full Unicode coverage stored as ranges (generated TS,
  comparable to `std14data.ts`). It is a plain `.mjs` script (matching the
  existing `gen-std14-fonts.mjs` precedent — no TypeScript-runner dev dependency).
- The generator **downloads the pinned-version raw UCD sources on demand** into a
  gitignored `unicode/` dir (cached across runs). Only the generated
  `src/unicode-data.ts` and the committed conformance fixture
  `test/fixtures/unicode/BidiCharacterTest.txt` are in-tree; the raw UCD sources
  are not committed. Unicode version pinned in the generator and in a header
  comment of the generated file.
- Exposes `bidiClass(cp)`, `joiningType(cp)`, `joiningGroup(cp)`, `script(cp)`,
  `scriptTag(id)`, `combiningClass(cp)`, `bracket(cp)`, and `mirror(cp)`.

## Phasing (each phase = its own implementation plan, PR, and `bd` sub-issue)

- **Phase 1 — OpenType layout core** (`otlayout.ts` + sfnt table exposure):
  GSUB/GPOS/GDEF parsing and application over a glyph buffer, tested against
  synthetic fonts from an extended `build-sfnt.ts`. No PDF integration. The heart
  and the riskiest part.
- **Phase 2 — Unicode/bidi** (`unicode-data.ts` + `gen:ucd` + `bidi.ts`):
  reordering, base-direction, script itemization, Arabic joining-type derivation.
  Pure functions, unit-tested against UAX #9 samples.
- **Phase 3 — Integration** (`shape.ts` + `otemit.ts` + driver/stamp/layout/API/
  README): wire phases 1–2 into `AddText`/`AddTextBlock`, positioned emission,
  opt-in API, Arabic/Latin end-to-end vitest, README i18n note.

## Testing

- **Phase 1:** extend `build-sfnt.ts` to emit `GDEF`/`GSUB`/`GPOS`. Unit tests per
  lookup type: `liga` (f+i→fi), a chaining `calt`, an Arabic `init/medi/fina`
  set, a `kern` pair, a mark-to-base anchor. Assert output glyph buffer +
  positions directly.
- **Phase 2:** unit tests from UAX #9 canonical cases — mixed LTR/RTL, numbers
  (EN/AN), neutrals, mirrored brackets, base-direction detection; script
  itemization boundaries.
- **Phase 3 (acceptance):** build a small font with the above fixtures; run
  `AddText`/`AddTextBlock` on an Arabic sample (joining + `rlig` lam-alef) and a
  Latin ligature sample; assert the emitted content stream — glyph selection
  (ligature/joined gids), advances (kern deltas in `TJ`), RTL visual order — and
  round-trip `GetText()` back to the original Unicode. A regression test asserts
  plain Latin with `shape: false` is byte-identical to pre-feature output.
- `npm run typecheck` + full `npm test` green before closing each phase.

## README updates (i18n note, Phase 3)

Document, in Features + Limitations:

- `shape` opt-in (per font / per call), `dir`/`script`/`language` options.
- Supported: Unicode bidi/RTL reordering, Arabic joining + ligatures, GSUB
  substitution, GPOS kerning + mark positioning, for embedded OpenType fonts.
- Limitations: no script-specific reordering engines (Indic/SEA/Khmer — generic
  GSUB/GPOS only); GPOS cursive / mark-to-ligature best-effort; `justify` falls
  back to left for shaped text; Standard-14 fonts don't shape; one code point →
  one cluster round-trips via `/ToUnicode`.
```

