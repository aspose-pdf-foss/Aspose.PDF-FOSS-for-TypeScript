# Complex-text Shaping Phase 3 — Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-shipped OpenType layout core (Phase 1, `otlayout.ts`) and Unicode/bidi core (Phase 2, `bidi.ts`/`unicode-data.ts`) into the text-authoring API so `Page.AddText` / `Page.AddTextBlock` shape complex scripts (Arabic joining + ligatures, GSUB substitution, GPOS kerning + marks, bidi/RTL reordering) with embedded OpenType fonts — opt-in per font and per call — while leaving the Standard-14 and non-shaped embedded paths byte-for-byte identical.

**Architecture:** Two new pure modules — `shape.ts` (orchestrator: `shapeText(text, sfnt, opts) → ShapedRun[]` combining bidi reorder, script itemization, Arabic joining-form derivation, and GSUB/GPOS over cmapped gids) and `otemit.ts` (turn a positioned run into content-stream ops: `TJ` advance/placement deltas + `Ts` text-rise for mark y). `EmbeddedFont` gains a shaping driver that records used gids and a `gid→source-text` cluster map for `/ToUnicode`. `stamp.ts` branches to the shaped path only when the resolved font is an `EmbeddedFont` and shaping is on; otherwise today's exact 1:1 `Tj` path runs unchanged.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest, zero runtime deps (`node:` built-ins only). Fixtures built programmatically in `test/helpers/build-sfnt.ts`.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension (e.g. `import { reorderLine } from './bidi.js'`).
- **TDD** — every feature lands with a vitest test and (where a font is needed) a fixture builder in `test/helpers/`.
- **Degrade, never throw** — absent/malformed GSUB/GPOS/GDEF passes the buffer through unchanged (Phase 1 already guarantees this inside `applyGsub`/`applyGpos`; `shapeText` must not add new throw paths for missing tables).
- **Byte-identical non-shaped output** — for a Standard-14 font, or an embedded font with shaping off, the emitted content stream must be byte-for-byte identical to pre-Phase-3 output. This is an explicit regression test.
- **Font units** — `PositionedGlyph` offsets/advances are in font design units (`sfnt.unitsPerEm`). Emission scales to the PDF `/1000`-em convention: a design-unit value `v` becomes `v * 1000 / unitsPerEm` for `TJ` numbers, and `v * fontSize / unitsPerEm` text-space points for `Ts`.
- Run `npm run typecheck` and `npm test` (both green) before closing each task.

## Test Harness Conventions (use verbatim — do NOT invent factory APIs)

The codebase has **no** `Document.Create()` / `doc.AddPage([box])`. Authoring tests
build a blank page from a fixture and read the page's decoded content stream directly:

```ts
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

const doc = Document.Open(buildStampTarget()); // 1 blank page, MediaBox present
const page = doc.Pages[0];
page.AddText('…', 20, 100, { font, fontSize: 12 });

// Read the page content stream as text (canonical helper used across stamp tests):
const body = new TextDecoder('latin1').decode(page.Contents);

// Round-trip:
const round = Document.Open(doc.Save());
round.Pages[0].GetText();
```

Every test snippet below that shows `Document.Create()`, `doc.AddPage([...])`, or
`readPageContent(...)` is shorthand — replace it with the pattern above
(`Document.Open(buildStampTarget())` → `doc.Pages[0]`; `new TextDecoder('latin1').decode(page.Contents)`).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/shape.ts` | **create** | `PositionedGlyph`, `ShapedRun`, `shapeText()`, `measureShaped()`. Bidi reorder + itemize + joining forms + GSUB/GPOS → visual-order positioned runs. Pure. |
| `src/otemit.ts` | **create** | `emitShapedRuns()`: positioned runs → content-stream body ops (`TJ` deltas, `Ts` rises, collapse-to-`Tj`). Pure string builder. |
| `src/embeddedfont.ts` | modify | Carry a default `shape` flag + a `toUnicode: Map<number,string>` cluster map. Add `shapeRuns()` (shape + record gids + accumulate cluster map) and `measureShaped()`. Keep the existing 1:1 `encode`/`measure`/`probe`/`driver` untouched. |
| `src/fontembed.ts` | modify | `buildEmbeddedFont()` accepts an optional `toUnicode` override map; prefer it over the reverse-cmap when building `/ToUnicode` bfchar entries. |
| `src/document.ts` | modify | `AddFont(bytes, opts?)` / `AddFontFile(path, opts?)` accept `{ shape?: boolean }`; pass each font's `toUnicode` map into `finalizeEmbeddedFonts`. |
| `src/stamp.ts` | modify | `StampOptions`/`TextBlockOptions` gain `shape?`/`dir?`/`script?`/`language?`. `stampText`/`stampTextBlock` branch to a shaped emission path (via `otemit`) when effective-shaping is on. `measureText` reflects shaping. |
| `src/page.ts` | modify | `AddText`/`AddTextBlock`/`MeasureText` already forward options; no signature change needed beyond the option types widening in `stamp.ts` (verify + doc-comment). |
| `test/helpers/build-sfnt.ts` | modify | Add `buildOtFontFor({ gsub?, gpos?, gdef?, cmap })` — `buildOtFont` with a caller-supplied cmap; and an Arabic joining `initMediFinaIsolLookups` helper. |
| `test/shape.test.ts` | **create** | Unit tests for `shapeText` (Latin liga, kern, Arabic joining, RTL visual order, degrade). |
| `test/otemit.test.ts` | **create** | Unit tests for `emitShapedRuns` (kern → TJ number, mark yOffset → Ts, xOffset placement, trivial collapse). |
| `test/shape-authoring.test.ts` | **create** | End-to-end acceptance: `AddText`/`AddTextBlock` on Arabic + Latin-ligature samples; content-stream + `GetText()` round-trip; byte-identical `shape:false` regression. |
| `README.md` | modify | i18n note in Features + Limitations. |

---

## Task 1: Data model + `shapeText` core (Latin: cmap → GSUB → GPOS, LTR)

**Files:**
- Create: `src/shape.ts`
- Modify: `test/helpers/build-sfnt.ts` (add `buildOtFontFor`)
- Test: `test/shape.test.ts`

**Interfaces:**
- Consumes (Phase 1/2, exact signatures):
  - `otlayout.ts`: `applyGsub(t: OtTable, buf: ShapedGlyph[], gdef: Gdef|undefined, script: string|undefined, lang: string|undefined, features: string[]): void`; `applyGpos(t, buf, gdef, script, lang, features, rtl?: boolean): void`; `interface ShapedGlyph { gid; cluster; xAdvance; xOffset; yOffset; ligId?; ligComp?; cursiveParent? }`; `interface OtLayout { gsub?: OtTable; gpos?: OtTable; gdef?: Gdef }`.
  - `sfnt.ts`: `SfntFont` with `cmapLookup(cp): number|undefined`, `advanceWidth(gid): number`, `unitsPerEm: number`, `otLayout(): OtLayout|undefined`.
  - `bidi.ts`: `reorderLine(codes, dir): { paraLevel; levels; removed; order }`; `itemizeScripts(codes): { start; end; script; otTag; rtl }[]`; `arabicJoiningForms(codes, start, end): ('isol'|'init'|'medi'|'fina'|null)[]`.
- Produces (used by Tasks 2, 3):
  ```ts
  export interface PositionedGlyph { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number; }
  export interface ShapedRun { glyphs: PositionedGlyph[]; rtl: boolean; }
  export interface ShapeOpts { dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string; }
  export function shapeText(text: string, sfnt: SfntFont, opts?: ShapeOpts): ShapedRun[];
  export function measureShaped(runs: ShapedRun[]): number; // Σ xAdvance in font units
  ```

- [ ] **Step 1: Add `buildOtFontFor` fixture builder.** In `test/helpers/build-sfnt.ts`, just below `buildOtFont`, add a variant that takes a custom cmap so tests can drive shaping by real code points. Reuse the existing `buildCmapFor([[cp,gid],…])` helper.

```ts
/** Like {@link buildOtFont} but with a caller-supplied cmap (code point → gid),
 *  so shaping tests can map real code points to specific glyph ids. */
export function buildOtFontFor(
  ot: { gsub?: Uint8Array; gpos?: Uint8Array; gdef?: Uint8Array; cmap: [number, number][] },
): Uint8Array {
  const numGlyphs = 100;
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);
  const glyphs: Uint8Array[] = [g0]; for (let i = 1; i < numGlyphs; i++) glyphs.push(g1);
  const glyf = concat(glyphs);
  const offs = [0]; for (let i = 0; i < numGlyphs; i++) offs.push(offs[i] + glyphs[i].length);
  const loca = concat(offs.map((o) => u16(o / 2)));
  const maxp = (() => { const b = new Uint8Array(32); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, numGlyphs); return b; })();
  const hhea = (() => { const b = new Uint8Array(36); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, numGlyphs); return b; })();
  const hmtxParts: Uint8Array[] = []; for (let i = 0; i < numGlyphs; i++) hmtxParts.push(u16(Math.max(100, i * 100)), i16(0));
  const hmtx = concat(hmtxParts);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmapFor(ot.cmap) }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  if (ot.gdef) tables.push({ tag: 'GDEF', data: ot.gdef });
  if (ot.gsub) tables.push({ tag: 'GSUB', data: ot.gsub });
  if (ot.gpos) tables.push({ tag: 'GPOS', data: ot.gpos });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}
```

- [ ] **Step 2: Write the failing test** (`test/shape.test.ts`). Latin: two code points that a Ligature lookup (f+i → fi) merges, with a kern pair, LTR.

```ts
import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { shapeText, measureShaped } from '../src/shape.js';
import { buildOtFontFor, buildGsub, buildGpos, ligatureLookup, pairKernLookup } from './helpers/build-sfnt.js';

describe('shapeText — Latin', () => {
  it('applies a ligature (f+i → fi) and kerning, LTR, single run', () => {
    // code points 0x66 'f'→gid10, 0x69 'i'→gid11, 0x6a 'j'→gid12
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);   // 10,11 → 20
    const gpos = buildGpos([pairKernLookup('kern', 20, 12, -40)]);     // (20,12) kern -40
    const sfnt = parseSfnt(buildOtFontFor({ gsub, gpos, cmap: [[0x66, 10], [0x69, 11], [0x6a, 12]] }));
    const runs = shapeText('fij', sfnt, { dir: 'ltr' });
    expect(runs.length).toBe(1);
    expect(runs[0].rtl).toBe(false);
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([20, 12]); // fi ligature + j
    expect(runs[0].glyphs[0].cluster).toBe(0);                  // ligature keeps first cluster
    expect(runs[0].glyphs[1].cluster).toBe(2);
    // gid20 natural advance = max(100,20*100)=2000; kern -40 applied to the fi glyph's advance
    expect(runs[0].glyphs[0].xAdvance).toBe(2000 - 40);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** Run: `npx vitest run test/shape.test.ts`. Expected: FAIL — cannot resolve `../src/shape.js`.

- [ ] **Step 4: Write minimal `src/shape.ts`.** Handle the LTR, single-script path first: bidi reorder to get logical→visual order and per-position levels, itemize by script, cmap each segment, apply general GSUB then re-seed advances then GPOS, concatenate. Arabic joining and RTL reversal are refined in Tasks folded here (Steps 6–9). Start minimal:

```ts
import { SfntFont } from './sfnt.js';
import { applyGsub, applyGpos, type ShapedGlyph } from './otlayout.js';
import { reorderLine, itemizeScripts, arabicJoiningForms } from './bidi.js';

export interface PositionedGlyph { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number; }
export interface ShapedRun { glyphs: PositionedGlyph[]; rtl: boolean; }
export interface ShapeOpts { dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string; }

// General features applied across a whole segment buffer, in application order.
const GSUB_FEATURES = ['ccmp', 'liga', 'rlig', 'calt'];
const GPOS_FEATURES = ['kern', 'mark', 'mkmk'];
const ARABIC_TAG = 'arab';

/** Shape `text` with `sfnt` into visual-order positioned runs. Pure; never throws
 *  for missing/malformed layout tables (Phase-1 apply* degrade to pass-through). */
export function shapeText(text: string, sfnt: SfntFont, opts: ShapeOpts = {}): ShapedRun[] {
  const codes = [...text].map((c) => c.codePointAt(0)!);
  if (codes.length === 0) return [];
  const dir = opts.dir ?? 'auto';
  const layout = sfnt.otLayout();
  const gsub = layout?.gsub, gpos = layout?.gpos, gdef = layout?.gdef;

  // Bidi: visual order + per-logical-position embedding levels.
  const { levels, order } = reorderLine(codes, dir);
  // Itemize the LOGICAL sequence by script; each segment inherits its bidi run's
  // direction (odd level = RTL). Split further where the level changes.
  const segs = itemizeScripts(codes);

  const runs: ShapedRun[] = [];
  for (const seg of segs) {
    for (const sub of splitByLevel(seg, levels)) {
      const otTag = opts.script ?? sub.otTag;
      const rtl = (levels[sub.start] & 1) === 1;
      const glyphs = shapeSegment(codes, sub.start, sub.end, sfnt, gsub, gpos, gdef, otTag, opts.language, rtl);
      if (glyphs.length) runs.push({ glyphs, rtl });
    }
  }
  // Order runs left-to-right by their leftmost visual position.
  runs.sort((a, b) => visualPos(a, order) - visualPos(b, order));
  return runs;
}

interface Seg { start: number; end: number; otTag: string; }
function splitByLevel(seg: { start: number; end: number; otTag: string }, levels: Int8Array): Seg[] {
  const out: Seg[] = [];
  let s = seg.start;
  for (let i = seg.start + 1; i <= seg.end; i++) {
    if (i === seg.end || levels[i] !== levels[s]) { out.push({ start: s, end: i, otTag: seg.otTag }); s = i; }
  }
  return out;
}

// Leftmost visual index of a run's clusters, for left-to-right run ordering.
function visualPos(run: ShapedRun, order: number[]): number {
  let min = Infinity;
  for (const g of run.glyphs) { const v = order.indexOf(g.cluster); if (v >= 0 && v < min) min = v; }
  return min;
}

function shapeSegment(
  codes: number[], start: number, end: number, sfnt: SfntFont,
  gsub: import('./otlayout.js').OtTable | undefined, gpos: import('./otlayout.js').OtTable | undefined,
  gdef: import('./otlayout.js').Gdef | undefined, otTag: string, lang: string | undefined, rtl: boolean,
): PositionedGlyph[] {
  // cmap → nominal gids (record source cluster = code-point index).
  const buf: ShapedGlyph[] = [];
  for (let i = start; i < end; i++) {
    const gid = sfnt.cmapLookup(codes[i]);
    if (gid === undefined) continue;
    buf.push({ gid, cluster: i, xAdvance: sfnt.advanceWidth(gid), xOffset: 0, yOffset: 0 });
  }
  if (buf.length === 0) return [];

  // Arabic: per-glyph joining-form substitution (single-glyph slices — the forms
  // are non-contextual Single Substitutions keyed by nominal glyph).
  if (gsub && otTag === ARABIC_TAG) applyJoiningForms(codes, start, end, buf, gsub, gdef, otTag, lang);

  // General GSUB (ligatures / contextual), then re-seed advances, then GPOS.
  if (gsub) applyGsub(gsub, buf, gdef, otTag, lang, GSUB_FEATURES);
  for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid);
  if (gpos) applyGpos(gpos, buf, gdef, otTag, lang, GPOS_FEATURES, rtl);

  // Shape logical, reverse for RTL visual emission.
  const glyphs: PositionedGlyph[] = buf.map((g) => ({ gid: g.gid, cluster: g.cluster, xAdvance: g.xAdvance, xOffset: g.xOffset, yOffset: g.yOffset }));
  if (rtl) glyphs.reverse();
  return glyphs;
}

// Substitute each glyph's Arabic positional form on a single-glyph buffer so the
// form feature applies exactly at that position and nowhere else.
function applyJoiningForms(
  codes: number[], start: number, end: number, buf: ShapedGlyph[],
  gsub: import('./otlayout.js').OtTable, gdef: import('./otlayout.js').Gdef | undefined,
  otTag: string, lang: string | undefined,
): void {
  const forms = arabicJoiningForms(codes, start, end);
  // buf is aligned to the cmappable subset of [start,end); recompute alignment by
  // walking clusters (buf[k].cluster is the code index).
  for (let k = 0; k < buf.length; k++) {
    const form = forms[buf[k].cluster - start];
    if (!form) continue;
    const one: ShapedGlyph[] = [buf[k]];
    applyGsub(gsub, one, gdef, otTag, lang, [form]);
    buf.splice(k, 1, ...one);
    k += one.length - 1;
  }
}

/** Total advance of all runs, in font design units. */
export function measureShaped(runs: ShapedRun[]): number {
  let w = 0;
  for (const r of runs) for (const g of r.glyphs) w += g.xAdvance;
  return w;
}
```

- [ ] **Step 5: Run test to verify it passes.** Run: `npx vitest run test/shape.test.ts`. Expected: PASS.

- [ ] **Step 6: Add the RTL + Arabic-joining tests.** Append to `test/shape.test.ts`:

```ts
import { buildOtFontFor as _f } from './helpers/build-sfnt.js'; // (already imported above; keep one import)

describe('shapeText — Arabic / RTL', () => {
  it('reverses an RTL run to visual order and keeps clusters', () => {
    // Two Arabic letters (isolated forms), no GSUB/GPOS: nominal gids, RTL reversed.
    const sfnt = parseSfnt(buildOtFontFor({ cmap: [[0x0627, 30], [0x0628, 31]] })); // alef, beh
    const runs = shapeText('اب', sfnt, { dir: 'rtl' });
    expect(runs.length).toBe(1);
    expect(runs[0].rtl).toBe(true);
    // logical [alef=30(cluster0), beh=31(cluster1)] → visual reversed [31,30]
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([31, 30]);
    expect(runs[0].glyphs.map((g) => g.cluster)).toEqual([1, 0]);
  });

  it('applies init/medi/fina joining forms per glyph', () => {
    // beh 0x0628 → nominal gid40; init form → 41, medi → 42, fina → 43 (Single Subst by feature).
    const gsub = buildGsub([
      singleSubstDelta('init', 40, 1),   // 40 → 41
      singleSubstDelta('medi', 40, 2),   // 40 → 42
      singleSubstDelta('fina', 40, 3),   // 40 → 43
    ]);
    const sfnt = parseSfnt(buildOtFontFor({ gsub, cmap: [[0x0628, 40]] }));
    const runs = shapeText('ببب', sfnt, { dir: 'rtl', script: 'arab' });
    // logical forms: [init, medi, fina] → gids [41,42,43]; RTL visual reverse → [43,42,41]
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([43, 42, 41]);
  });
});
```
Add `singleSubstDelta` to the import list at the top of the file.

- [ ] **Step 7: Run to verify** joining/RTL tests pass. Run: `npx vitest run test/shape.test.ts`. Expected: PASS (adjust `splitByLevel`/`itemizeScripts` interplay if a test reveals an off-by-one — the `end` of `itemizeScripts` segments is exclusive; confirm against `bidi.ts`).

- [ ] **Step 8: Run the full suite + typecheck.** Run: `npm run typecheck && npx vitest run`. Expected: all green.

- [ ] **Step 9: Commit.**

```bash
git add src/shape.ts test/shape.test.ts test/helpers/build-sfnt.ts
git commit -m "feat(8u0.3): shape.ts orchestrator (bidi+itemize+joining+GSUB/GPOS -> ShapedRun[])"
```

---

## Task 2: `otemit.ts` — positioned runs → content-stream ops

**Files:**
- Create: `src/otemit.ts`
- Test: `test/otemit.test.ts`

**Interfaces:**
- Consumes: `ShapedRun`, `PositionedGlyph` from `shape.ts`.
- Produces (used by Task 5):
  ```ts
  // Returns the show-operators for one already-positioned line (visual order),
  // to be placed between a `Tm`/`Td` and the next line. `unitsPerEm` scales font
  // units; `naturalAdvance(gid)` gives the glyph's /W advance in the SAME font
  // units (so kerning/mark deltas are the difference). Records nothing.
  export function emitLine(
    runs: ShapedRun[], fontSize: number, unitsPerEm: number,
    naturalAdvance: (gid: number) => number,
  ): string;
  export function encodeGids(runs: ShapedRun[]): Uint8Array; // 2-byte Identity-H CIDs, visual order
  ```

**Emission model (spec §Content-stream emission):**
- Glyph shown via a hex string inside a `TJ` array; `/W` advances the pen by the glyph's natural `hmtx` width.
- Per glyph with design-unit offset `o = xOffset`, advance `a = xAdvance`, natural `w`:
  - **pre-adjust** number `= -(o * 1000 / unitsPerEm)` (move pen right by the placement before showing);
  - **post-adjust** number `= (o + w - a) * 1000 / unitsPerEm` (return the placement and correct the advance; positive tightens/left, matching TJ's subtract-`n/1000·fs` rule).
  - Consecutive glyphs with zero pre/post adjust concatenate into one hex string (no separating number).
- **y placement** `yOffset ≠ 0` → emit `Ts` = `yOffset * fontSize / unitsPerEm` before the glyph and `0 Ts` after (text rise doesn't affect horizontal advance). Split the `TJ` array around the rise: `[…]TJ  <rise> Ts [<glyph>]TJ  0 Ts […]TJ`.
- **Trivial collapse:** when every glyph has `xOffset === 0`, `yOffset === 0`, and `a === w`, emit a single `<…> Tj` (one hex string) — byte-identical to the non-shaped path.

- [ ] **Step 1: Write the failing test** (`test/otemit.test.ts`).

```ts
import { describe, it, expect } from 'vitest';
import { emitLine } from '../src/otemit.js';
import type { ShapedRun } from '../src/shape.js';

const nat = (gid: number) => Math.max(100, gid * 100); // mirror buildOtFont hmtx

function run(glyphs: [number, number, number, number, number][]): ShapedRun {
  // [gid, cluster, xAdvance, xOffset, yOffset]
  return { rtl: false, glyphs: glyphs.map(([gid, cluster, xAdvance, xOffset, yOffset]) => ({ gid, cluster, xAdvance, xOffset, yOffset })) };
}

describe('emitLine', () => {
  it('collapses trivial LTR text to a single Tj', () => {
    const s = emitLine([run([[10, 0, 1000, 0, 0], [11, 1, 1100, 0, 0]])], 12, 1000, nat);
    expect(s.trim()).toBe('<000a000b> Tj');
  });

  it('emits a kern advance delta as a TJ number', () => {
    // gid20 natural 2000, advance 1960 → post-adjust = (0 + 2000 - 1960)*1000/1000 = 40
    const s = emitLine([run([[20, 0, 1960, 0, 0], [12, 1, 1200, 0, 0]])], 12, 1000, nat);
    expect(s.trim()).toBe('[<0014> 40 <000c>] TJ');
  });

  it('emits a mark yOffset as Ts around the glyph', () => {
    const s = emitLine([run([[50, 0, 0, 0, 300]])], 12, 1000, nat); // yOffset 300 units
    // Ts = 300 * 12 / 1000 = 3.6 ; mark advance 0, natural 5000 → post = 0 + 5000 - 0 = 5000
    expect(s).toContain('3.6 Ts');
    expect(s).toContain('0 Ts');
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/otemit.test.ts`. Expected: FAIL — cannot resolve `../src/otemit.js`.

- [ ] **Step 3: Write `src/otemit.ts`.**

```ts
import type { ShapedRun } from './shape.js';
import { num } from './pagecontent.js';

function hex4(n: number): string { return (n & 0xffff).toString(16).padStart(4, '0'); }

/** 2-byte Identity-H codes for every glyph across all runs, in visual order. */
export function encodeGids(runs: ShapedRun[]): Uint8Array {
  const out: number[] = [];
  for (const r of runs) for (const g of r.glyphs) out.push((g.gid >> 8) & 0xff, g.gid & 0xff);
  return Uint8Array.from(out);
}

interface Item { gid: number; pre: number; post: number; rise: number; }

/** Show-operators for one positioned line. See plan §Emission model. */
export function emitLine(
  runs: ShapedRun[], fontSize: number, unitsPerEm: number,
  naturalAdvance: (gid: number) => number,
): string {
  const k = 1000 / (unitsPerEm || 1000);
  const items: Item[] = [];
  for (const r of runs) for (const g of r.glyphs) {
    const w = naturalAdvance(g.gid);
    items.push({
      gid: g.gid,
      pre: -(g.xOffset * k),
      post: (g.xOffset + w - g.xAdvance) * k,
      rise: g.yOffset * (fontSize / (unitsPerEm || 1000)),
    });
  }
  const trivial = items.every((it) => it.pre === 0 && it.post === 0 && it.rise === 0);
  if (trivial) return `${'<' + items.map((it) => hex4(it.gid)).join('') + '>'} Tj\n`;

  // Build a TJ array, splitting around any glyph that needs a text rise.
  let s = '';
  let arr: string[] = [];
  const flush = () => { if (arr.length) { s += `[${arr.join(' ')}] TJ\n`; arr = []; } };
  let curRise = 0;
  for (const it of items) {
    if (it.rise !== curRise) { flush(); s += `${num(it.rise)} Ts\n`; curRise = it.rise; }
    if (it.pre !== 0) arr.push(num(-it.pre === 0 ? 0 : it.pre)); // pre is already the TJ number
    if (it.pre !== 0) { /* handled above */ }
    // Append the glyph, merging into the previous hex string when no pre-adjust.
    const last = arr[arr.length - 1];
    if (it.pre === 0 && last && last.startsWith('<')) arr[arr.length - 1] = last.slice(0, -1) + hex4(it.gid) + '>';
    else arr.push(`<${hex4(it.gid)}>`);
    if (it.post !== 0) arr.push(num(it.post));
  }
  if (curRise !== 0) { flush(); s += '0 Ts\n'; } else flush();
  return s;
}
```
> Note for the implementer: the `pre` handling above is intentionally simple — `pre` is already expressed as a TJ number (negative moves the pen right). Push `num(it.pre)` before the glyph when non-zero; do **not** merge that glyph into a previous hex string. Simplify the two `if (it.pre !== 0)` lines into one `arr.push(num(it.pre));`. Keep the merge-into-previous-string branch only for `it.pre === 0`.

- [ ] **Step 4: Run to verify it passes** (fix the `pre` block per the note until green). Run: `npx vitest run test/otemit.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck + full suite.** Run: `npm run typecheck && npx vitest run`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add src/otemit.ts test/otemit.test.ts
git commit -m "feat(8u0.3): otemit.ts — positioned runs to TJ/Ts content ops"
```

---

## Task 3: `EmbeddedFont` shaping driver + cluster `/ToUnicode` map

**Files:**
- Modify: `src/embeddedfont.ts`
- Test: `test/shape.test.ts` (add an `EmbeddedFont.shapeRuns` block)

**Interfaces:**
- Consumes: `shapeText`, `measureShaped`, `ShapedRun` (Task 1); `encodeGids` (Task 2).
- Produces (used by Tasks 4, 5):
  ```ts
  class EmbeddedFont {
    shape: boolean;                       // default from AddFont options
    readonly toUnicode: Map<number, string>;  // gid → source text (cluster map)
    shapeRuns(text: string, opts?: ShapeOpts): ShapedRun[]; // records gids + toUnicode
    measureShaped(text: string, fontSize: number, opts?: ShapeOpts): number;
  }
  ```

- [ ] **Step 1: Write the failing test.** Append to `test/shape.test.ts`:

```ts
import { EmbeddedFont } from '../src/embeddedfont.js';

describe('EmbeddedFont.shapeRuns', () => {
  it('records used gids and a ligature gid→source-text ToUnicode entry', () => {
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
    const sfnt = parseSfnt(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] }));
    const font = new EmbeddedFont(sfnt);
    const runs = font.shapeRuns('fi', { dir: 'ltr' });
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([20]);
    expect(font.usedGids.has(20)).toBe(true);
    expect(font.toUnicode.get(20)).toBe('fi'); // ligature restores both source code points
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/shape.test.ts`. Expected: FAIL — `shapeRuns` is not a function.

- [ ] **Step 3: Implement.** In `src/embeddedfont.ts`: import `shapeText`, `measureShaped`, and `ShapedRun`/`ShapeOpts`; add the `shape` flag, `toUnicode` map, and the two methods. The `gid→source-text` map is built by grouping the original code points by cluster within each run.

```ts
import { shapeText, measureShaped, type ShapedRun, type ShapeOpts } from './shape.js';
// … existing imports …

export class EmbeddedFont {
  readonly sfnt: SfntFont;
  readonly usedGids = new Set<number>();
  /** @internal default shaping flag, from Document.AddFont({ shape }). */
  shape = false;
  /** @internal gid → source text, for /ToUnicode of shaped/ligated/RTL glyphs. */
  readonly toUnicode = new Map<number, string>();
  objNum: number | undefined;

  constructor(sfnt: SfntFont) { this.sfnt = sfnt; }

  // … existing measure/encode/probe/driver unchanged …

  /** @internal Shape `text` into visual runs, recording used gids and, for each
   *  final gid, the source code points of its cluster (for /ToUnicode). */
  shapeRuns(text: string, opts?: ShapeOpts): ShapedRun[] {
    const codes = [...text];
    const runs = shapeText(text, this.sfnt, opts);
    for (const r of runs) {
      // Sort glyphs by cluster to gather each gid's source substring in logical order.
      for (const g of r.glyphs) {
        this.usedGids.add(g.gid);
        if (!this.toUnicode.has(g.gid)) this.toUnicode.set(g.gid, sourceForCluster(codes, r, g.cluster));
      }
    }
    return runs;
  }

  /** @internal Shaped width of `text` in points at `fontSize`. */
  measureShaped(text: string, fontSize: number, opts?: ShapeOpts): number {
    const scale = fontSize / (this.sfnt.unitsPerEm || 1000);
    return measureShaped(shapeText(text, this.sfnt, opts)) * scale;
  }
}

// Source code points whose cluster equals `cluster` (a ligature merges several).
function sourceForCluster(codes: string[], run: ShapedRun, cluster: number): string {
  const clusters = run.glyphs.map((g) => g.cluster);
  // Cluster range = [cluster, next distinct cluster) over the run's source span.
  const sorted = [...new Set(clusters)].sort((a, b) => a - b);
  const idx = sorted.indexOf(cluster);
  const next = idx + 1 < sorted.length ? sorted[idx + 1] : cluster + 1;
  return codes.slice(cluster, Math.max(next, cluster + 1)).join('');
}
```
> Implementer note: cluster ranges assume ligatures merge contiguous logical clusters (Phase-1 `gsubLigature` keeps the first component's cluster). For an RTL run the glyph order is reversed but clusters are still logical indices, so `codes.slice(cluster, next)` restores logical (correct) Unicode.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run test/shape.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck + full suite.** Run: `npm run typecheck && npx vitest run`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add src/embeddedfont.ts test/shape.test.ts
git commit -m "feat(8u0.3): EmbeddedFont shaping driver + gid→source cluster map"
```

---

## Task 4: `/ToUnicode` override in `fontembed.ts`

**Files:**
- Modify: `src/fontembed.ts` (`buildEmbeddedFont` signature + `tuEntries` build)
- Modify: `src/document.ts` (`finalizeEmbeddedFonts` passes the map)
- Test: `test/shape-authoring.test.ts` (new file — start it here with a ToUnicode assertion; grows in Task 7)

**Interfaces:**
- Consumes: `EmbeddedFont.toUnicode` (Task 3).
- Produces:
  ```ts
  export function buildEmbeddedFont(
    font: SfntFont, usedGids: Set<number>, alloc: Alloc,
    toUnicode?: Map<number, string>,   // NEW optional override; prefer over reverse cmap
  ): PdfDict;
  ```

- [ ] **Step 1: Write the failing test** (`test/shape-authoring.test.ts`).

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildOtFontFor, buildGsub, ligatureLookup } from './helpers/build-sfnt.js';

function ttf() {
  const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
  return buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] });
}

describe('shaped /ToUnicode', () => {
  it('maps a ligature gid back to its source code points', () => {
    const doc = Document.Create();
    const page = doc.AddPage([0, 0, 200, 200]);
    const font = doc.AddFont(ttf(), { shape: true });
    page.AddText('fi', 20, 100, { font, fontSize: 12 });
    const round = Document.Open(doc.Save());
    expect(round.Pages[0].GetText()).toBe('fi'); // ligature round-trips via /ToUnicode
  });
});
```
> Implementer note: use whatever `Document.Create()`/`AddPage` factory the codebase exposes (check `test/*` for the canonical construction; several authoring tests build a fresh doc). Drop the placeholder line.

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: FAIL — `AddFont` rejects a second arg / `GetText` returns empty (no shaped emission yet). This test is the Task-4+5+7 acceptance anchor; it goes green once emission lands. For an isolated Task-4 check, temporarily assert `buildEmbeddedFont` directly (see Step 3 test), then rely on the end-to-end assertion after Task 5.

- [ ] **Step 3: Implement the override.** In `src/fontembed.ts`:

```ts
export function buildEmbeddedFont(
  font: SfntFont, usedGids: Set<number>, alloc: Alloc, toUnicode?: Map<number, string>,
): PdfDict {
  // … unchanged up to the /ToUnicode block …

  const rev = font.cmapReverse();
  const tuEntries: [number, string][] = [];
  for (const cid of cids) {
    const override = toUnicode?.get(cid);
    if (override !== undefined && override !== '') { tuEntries.push([cid, override]); continue; }
    const cp = rev.get(cid);
    if (cp !== undefined) tuEntries.push([cid, String.fromCodePoint(cp)]);
  }
  // … rest unchanged …
}
```

- [ ] **Step 4: Thread the map in `document.ts`.** In `finalizeEmbeddedFonts`:

```ts
private finalizeEmbeddedFonts(): void {
  for (const font of this.embeddedFonts) {
    if (font.objNum === undefined || font.usedGids.size === 0) continue;
    const type0 = buildEmbeddedFont(font.sfnt, font.usedGids, (obj) => this.allocObject(obj), font.toUnicode);
    this.objects.set(font.objNum, type0);
  }
}
```

- [ ] **Step 5: Typecheck.** Run: `npm run typecheck`. Expected: PASS (the end-to-end test stays red until Task 5). Full suite must still pass except the new anchor test.

- [ ] **Step 6: Commit.**

```bash
git add src/fontembed.ts src/document.ts test/shape-authoring.test.ts
git commit -m "feat(8u0.3): /ToUnicode override from shaped cluster map"
```

---

## Task 5: `AddText` shaped emission path (`stamp.ts`) + `AddFont({shape})` API

**Files:**
- Modify: `src/document.ts` (`AddFont`/`AddFontFile` options)
- Modify: `src/stamp.ts` (`StampOptions`, `stampText`, `measureText`, effective-shape resolution)
- Test: `test/shape-authoring.test.ts` (Task-4 anchor now goes green; add a kern-in-TJ + RTL-order assertion)

**Interfaces:**
- Consumes: `EmbeddedFont.shape`/`shapeRuns`/`measureShaped` (Task 3); `emitLine`, `encodeGids` (Task 2).
- Produces:
  ```ts
  interface AddFontOptions { shape?: boolean }
  Document.AddFont(bytes: Uint8Array, opts?: AddFontOptions): EmbeddedFont
  Document.AddFontFile(path: string, opts?: AddFontOptions): EmbeddedFont
  // StampOptions gains: shape?, dir?: 'auto'|'ltr'|'rtl', script?: string, language?: string
  ```

- [ ] **Step 1: Write the failing test.** Append to `test/shape-authoring.test.ts` a content-stream assertion that a kern delta appears in a `TJ` array and that RTL text is emitted in visual (reversed) order. (Read the page content stream via the document's decode helper used by other stamp tests — grep `AddText` tests for the pattern that pulls the page `/Contents` string.)

```ts
it('emits shaped Arabic in RTL visual order with a Tf/TJ body', () => {
  const doc = Document.Create();
  const page = doc.AddPage([0, 0, 200, 200]);
  const sfnt = buildOtFontFor({ cmap: [[0x0627, 30], [0x0628, 31]] }); // alef, beh
  const font = doc.AddFont(sfnt, { shape: true });
  page.AddText('اب', 20, 100, { font, fontSize: 12, dir: 'rtl' });
  const body = /* decode page content stream to string */ readPageContent(doc, page);
  expect(body).toMatch(/BT[\s\S]*Tf[\s\S]*(Tj|TJ)[\s\S]*ET/);
  // visual order beh(31) then alef(30): codes 001f before 001e
  expect(body).toMatch(/<001f0*1e>|<001f><001e>|001f001e/);
});
```
> Implementer note: define `readPageContent` using the same decode path existing stamp tests use (e.g. resolve `page.dict.get('Contents')`, flate-decode, `Buffer.toString('latin1')`). Reuse a helper if one exists.

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: FAIL — `AddFont` ignores `{shape}` / no shaped body.

- [ ] **Step 3: `AddFont` options in `document.ts`.**

```ts
export interface AddFontOptions { /** Shape text drawn with this font by default. Default false. */ shape?: boolean; }

AddFont(bytes: Uint8Array, opts: AddFontOptions = {}): EmbeddedFont {
  const font = new EmbeddedFont(parseSfnt(bytes));
  font.shape = opts.shape ?? false;
  this.embeddedFonts.push(font);
  return font;
}

AddFontFile(fileName: string, opts: AddFontOptions = {}): EmbeddedFont {
  return this.AddFont(new Uint8Array(readFileSync(fileName)), opts);
}
```

- [ ] **Step 4: Extend `StampOptions` + shaped path in `stamp.ts`.** Add option fields and an effective-shape resolver, then branch `stampText`.

```ts
import { emitLine, encodeGids } from './otemit.js';
import type { ShapeOpts } from './shape.js';

export interface StampOptions {
  // … existing fields …
  /** Enable/disable complex-text shaping for this call, overriding the font's
   *  default. Ignored for Standard-14 fonts. */
  shape?: boolean;
  /** Base paragraph direction for shaping. Default 'auto' (first-strong). */
  dir?: 'auto' | 'ltr' | 'rtl';
  /** OpenType script tag override (default: auto per script itemization). */
  script?: string;
  /** OpenType language-system tag (default: 'dflt'). */
  language?: string;
}

/** True when `font` is an embedded handle AND shaping is effectively on. */
function effectiveShape(font: AuthoringFont, callShape: boolean | undefined): font is EmbeddedFont {
  return font instanceof EmbeddedFont && (callShape ?? font.shape);
}

function shapeOptsFrom(o: StampOptions): ShapeOpts {
  return { dir: o.dir, script: o.script, language: o.language };
}
```

Branch `stampText` — build a shaped body when effective, else fall through to the exact existing path:

```ts
export function stampText(doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {}): void {
  const o = normalizeOptions(options);
  if (effectiveShape(o.font, options.shape)) {
    const font = o.font;
    const runs = font.shapeRuns(text, shapeOptsFrom(options));
    if (runs.every((r) => r.glyphs.length === 0)) return;
    const fontKey = registerFont(doc, page, font);
    const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
    const width = font.measureShaped(text, o.fontSize, shapeOptsFrom(options));
    const inner = emitLine(runs, o.fontSize, font.sfnt.unitsPerEm || 1000, (gid) => font.sfnt.advanceWidth(gid));
    const body = buildShapedStampBody(inner, x, y, o, fontKey, width, gsKey);
    const tagged = options.tag ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body) : body;
    appendContent(doc, page, tagged);
    return;
  }
  // … existing unchanged 1:1 path …
}
```

Add `buildShapedStampBody` — the same `q…BT…Tf…rg…Tm…ET…Q` frame as `buildStampBody`, but injects `inner` (the `TJ`/`Ts` ops from `emitLine`) instead of a single `Tj`:

```ts
function buildShapedStampBody(inner: string, x: number, y: number, o: NormalizedOptions, fontKey: string, width: number, gsKey: string | undefined): Uint8Array {
  const f = o.align === 'center' ? 0.5 : o.align === 'right' ? 1 : 0;
  const theta = (o.rotate * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = x - f * width * cos, ty = y - f * width * sin;
  const [r, g, b] = o.color;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)} Tm\n`;
  s += inner;               // ends with a newline
  s += 'ET\nQ';
  return enc(s);
}
```

Route `measureText` through shaping when a shaped embedded font is passed:

```ts
export function measureText(text: string, fontSize: number, font: AuthoringFont = 'Helvetica', shape?: boolean, dir?: StampOptions['dir'], script?: string, language?: string): number {
  if (effectiveShape(font, shape)) return font.measureShaped(text, fontSize, { dir, script, language });
  return driverFor(font).measure(text, fontSize);
}
```
> Keep the public `MeasureText` signature stable (Task 8 wires page-level options); the extra params default to `undefined` (non-shaped behavior unchanged).

- [ ] **Step 5: Run the anchor + new tests.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: PASS (ligature round-trip, kern in TJ, RTL order).

- [ ] **Step 6: Typecheck + full suite.** Run: `npm run typecheck && npx vitest run`. Expected: green.

- [ ] **Step 7: Commit.**

```bash
git add src/document.ts src/stamp.ts test/shape-authoring.test.ts
git commit -m "feat(8u0.3): AddFont({shape}) + AddText shaped emission via otemit"
```

---

## Task 6: Byte-identical regression for the non-shaped path

**Files:**
- Test: `test/shape-authoring.test.ts` (regression block)

**Interfaces:** none new — asserts unchanged behavior.

- [ ] **Step 1: Write the regression test.** Same embedded font drawn with `shape:false` must produce a content stream byte-identical to the pre-feature 1:1 path (a single `Tj` with 2-byte codes, no `TJ`/`Ts`).

```ts
it('shape:false embedded Latin is byte-identical to the 1:1 path (single Tj, no TJ/Ts)', () => {
  const doc = Document.Create();
  const page = doc.AddPage([0, 0, 200, 200]);
  const font = doc.AddFont(buildOtFontFor({ cmap: [[0x41, 1], [0x42, 2]] })); // shape default false
  page.AddText('AB', 20, 100, { font, fontSize: 12, shape: false });
  const body = readPageContent(doc, page);
  expect(body).toContain('<00010002> Tj');
  expect(body).not.toContain('TJ');
  expect(body).not.toContain('Ts');
});
```

- [ ] **Step 2: Run.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: PASS (the shaped branch is skipped when `shape` resolves false).

- [ ] **Step 3: Full suite + typecheck.** Run: `npm run typecheck && npx vitest run`. Expected: green — confirms no existing stamp/authoring test output drifted.

- [ ] **Step 4: Commit.**

```bash
git add test/shape-authoring.test.ts
git commit -m "test(8u0.3): byte-identical regression for shape:false embedded text"
```

---

## Task 7: `AddTextBlock` shaped path (wrap-in-logical-order, shape-per-line)

**Files:**
- Modify: `src/stamp.ts` (`TextBlockOptions`, `stampTextBlock`, block body builder)
- Modify: `src/layout.ts` (allow the driver to measure via shaping — see note)
- Test: `test/shape-authoring.test.ts` (multi-line Arabic/Latin block)

**Interfaces:**
- Consumes: `EmbeddedFont.shapeRuns`/`measureShaped`; `emitLine`; existing `layoutText`.
- Produces: `TextBlockOptions` gains `shape?`/`dir?`/`script?`/`language?`; `stampTextBlock` emits shaped lines.

**Design:** Wrapping runs in **logical order** (line breaks only at spaces, which are Arabic non-joining boundaries, so per-line shaping equals per-paragraph shaping — spec §Wrapping). Reuse `layoutText`, but its `FontDriver.measure`/`encode` are the 1:1 path. For shaped fonts, wrap using a **shaping-aware measure** so candidate line widths are correct, then shape+emit each final line via `otemit`. `justify → left` already forced for embedded fonts (existing line in `normalizeBlockOptions`).

- [ ] **Step 1: Write the failing test.** A two-line Latin-ligature block: assert both lines emit, ligature gid present, and `GetText()` round-trips.

```ts
it('AddTextBlock shapes each wrapped line (ligature + round-trip)', () => {
  const doc = Document.Create();
  const page = doc.AddPage([0, 0, 300, 300]);
  const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
  const font = doc.AddFont(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11], [0x20, 3]] }), { shape: true });
  const rem = page.AddTextBlock('fi fi', [20, 20, 120, 200], { font, fontSize: 12 });
  const body = readPageContent(doc, page);
  expect(body).toContain('0014'); // ligature gid 20 = 0x14 appears
  const round = Document.Open(doc.Save());
  expect(round.Pages[0].GetText().replace(/\s+/g, ' ').trim()).toContain('fi');
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: FAIL — block path ignores shaping.

- [ ] **Step 3: Shaping-aware wrap + emit.** In `stamp.ts`, add `TextBlockOptions` fields (mirror `StampOptions`) and branch `stampTextBlock`:

```ts
export interface TextBlockOptions extends Omit<StampOptions, 'align' | 'rotate'> {
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'center' | 'bottom';
  leading?: number;
  // shape?/dir?/script?/language? inherited from StampOptions via extends
}
```

For wrapping, provide `layoutText` a driver whose `measure` shapes. Add to `stamp.ts`:

```ts
function shapedDriver(font: EmbeddedFont, so: ShapeOpts): FontDriver {
  return {
    measure: (t, fs) => font.measureShaped(t, fs, so),
    encode: () => new Uint8Array(0), // unused for shaped path (emission via otemit)
    probe: (t) => (t.length ? shapeText(t, font.sfnt, so).reduce((n, r) => n + r.glyphs.length, 0) : 0),
  };
}
```
(Import `shapeText` and `ShapeOpts` from `./shape.js`.)

Branch `stampTextBlock`:

```ts
export function stampTextBlock(doc, page, text, rect, options = {}) {
  validateRect(rect);
  const o = normalizeBlockOptions(options);
  const [x, y, w, h] = rect;
  if (effectiveShape(o.font, options.shape)) {
    const font = o.font, so = shapeOptsFrom(options);
    const driver = shapedDriver(font, so);
    if (driver.probe(text) === 0) return null;
    const { lines, remainder } = layoutText(text, driver, o.fontSize, w, h, o.leading);
    if (lines.length > 0) {
      const fontKey = registerFont(doc, page, font);
      const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
      const body = buildShapedBlockBody(font, lines, x, y, w, h, o, fontKey, gsKey, so);
      const tagged = options.tag ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body) : body;
      appendContent(doc, page, tagged);
    }
    return remainder === '' ? null : remainder;
  }
  // … existing unchanged path …
}
```

`buildShapedBlockBody` mirrors `buildBlockBody` but per line: compute the line's shaped runs (recording gids + toUnicode via `font.shapeRuns(lines[i].text, so)`), align by the line's measured `width`, position with `Td`, and inject `emitLine(...)`:

```ts
function buildShapedBlockBody(font, lines, x, y, w, h, o, fontKey, gsKey, so) {
  const blockHeight = lines.length * o.leading;
  const valignOffset = o.valign === 'center' ? (h - blockHeight) / 2 : o.valign === 'bottom' ? h - blockHeight : 0;
  const baseline0 = (y + h - valignOffset) - o.fontSize;
  const [r, g, b] = o.color;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  let prevOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const offset = alignOffset(o.align, w, lines[i].width);
    if (i === 0) s += `${num(x + offset)} ${num(baseline0)} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(-o.leading)} Td\n`;
    prevOffset = offset;
    const runs = font.shapeRuns(lines[i].text, so);
    s += emitLine(runs, o.fontSize, font.sfnt.unitsPerEm || 1000, (gid) => font.sfnt.advanceWidth(gid));
  }
  s += 'ET\nQ';
  return enc(s);
}
```
> Implementer note: `alignOffset`/`justifySpacing` are unchanged; justify already falls back to left for embedded fonts. `Tw` is not emitted on the shaped path.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck + full suite.** Run: `npm run typecheck && npx vitest run`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add src/stamp.ts test/shape-authoring.test.ts
git commit -m "feat(8u0.3): AddTextBlock shaped path (wrap logical, shape per line)"
```

---

## Task 8: Page API surface + `MeasureText` shaping + doc-comments

**Files:**
- Modify: `src/page.ts` (`AddText`/`AddTextBlock`/`MeasureText` doc-comments; `MeasureText` forwards shape options)
- Test: `test/shape-authoring.test.ts` (MeasureText reflects shaping)

**Interfaces:**
- `Page.MeasureText(text, fontSize?, font?, opts?)` reflects shaping when the font is a shaped embedded handle.

- [ ] **Step 1: Write the failing test.**

```ts
it('MeasureText reflects shaping (ligature narrows vs 1:1)', () => {
  const doc = Document.Create();
  const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]); // gid20 advance 2000; 10+11 = 1000+1100
  const font = doc.AddFont(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] }), { shape: true });
  const page = doc.AddPage([0, 0, 200, 200]);
  const shaped = page.MeasureText('fi', 12, font);          // ligature: 2000 units
  const raw = page.MeasureText('fi', 12, font, { shape: false }); // 1000+1100 = 2100 units
  expect(shaped).toBeCloseTo(2000 * 12 / 1000);
  expect(raw).toBeCloseTo((1000 + 1100) * 12 / 1000);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: FAIL — `MeasureText` has no shape option.

- [ ] **Step 3: Widen `Page.MeasureText`.** In `src/page.ts`, forward an options object to `measureText`:

```ts
MeasureText(text: string, fontSize = 12, font: AuthoringFont = 'Helvetica', opts: { shape?: boolean; dir?: 'auto'|'ltr'|'rtl'; script?: string; language?: string } = {}): number {
  return measureText(text, fontSize, font, opts.shape, opts.dir, opts.script, opts.language);
}
```
Confirm `AddText`/`AddTextBlock` already spread `options` straight into `stampText`/`stampTextBlock` (they do — no change beyond doc-comments noting the new `shape`/`dir`/`script`/`language` fields).

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run test/shape-authoring.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck + full suite.** Run: `npm run typecheck && npx vitest run`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add src/page.ts test/shape-authoring.test.ts
git commit -m "feat(8u0.3): Page.MeasureText reflects shaping; API doc-comments"
```

---

## Task 9: Acceptance end-to-end + README i18n note

**Files:**
- Test: `test/shape-authoring.test.ts` (Arabic joining+rlig lam-alef acceptance)
- Modify: `README.md`

**Interfaces:** none new.

- [ ] **Step 1: Write the acceptance test** — Arabic joining + an `rlig` lam-alef ligature, asserting glyph selection, RTL visual order, and `GetText()` round-trip to the original Unicode.

```ts
it('acceptance: Arabic joining + lam-alef rlig, RTL order, round-trips', () => {
  // lam 0x0644→gid50, alef 0x0627→gid51; fina lam→52; rlig (lam.fina? use nominal) 50+51→60 lam-alef.
  const gsub = buildGsub([
    singleSubstDelta('init', 50, 5),   // lam init → 55 (example)
    ligatureLookup('rlig', 50, [51], 60), // lam + alef → lam-alef ligature 60
  ]);
  const font = /* AddFont with shape:true */ null as any;
  // Build doc, AddText('لا', …, { dir:'rtl', script:'arab' }); assert body has <003c> (gid60)
  // and GetText() === 'لا'.
});
```
> Implementer note: finalize the exact lookup wiring so joining + `rlig` compose (apply joining forms first, then `rlig` on the whole buffer). Use `buildGsub` lookup order = feature application order. Assert: (a) the emitted body contains the ligature gid hex; (b) `Document.Open(doc.Save()).Pages[0].GetText()` equals the original `'لا'`.

- [ ] **Step 2: Run to verify it passes** (iterate lookup wiring until glyph selection + round-trip hold). Run: `npx vitest run test/shape-authoring.test.ts`. Expected: PASS.

- [ ] **Step 3: Update `README.md`.** In **Features**, add a "Complex-text shaping (i18n)" bullet; in **Limitations**, add the shaping caveats. Copy verbatim:

```markdown
### Complex-text shaping (embedded OpenType fonts)

`AddText` / `AddTextBlock` can shape complex scripts when drawing with an
embedded font (`Document.AddFont(bytes, { shape: true })`, or per call
`{ shape: true }`):

- Unicode **bidi/RTL** reordering (UAX #9) with `dir: 'auto' | 'ltr' | 'rtl'`.
- **Arabic** cursive joining (init/medi/fina/isol) and ligatures.
- **GSUB** substitution (ligatures, contextual alternates).
- **GPOS** kerning and mark positioning.
- Optional `script` (OpenType tag) and `language` (OpenType language-system tag)
  overrides.

Shaped, ligated, and reordered text still round-trips to the original Unicode
via `/ToUnicode` (verified by `GetText()`).
```

```markdown
**Complex-text shaping limitations**

- No script-specific reordering engines (Indic / SEA / Khmer) — only generic
  GSUB/GPOS is applied.
- GPOS cursive and mark-to-ligature attachment are best-effort.
- `justify` alignment falls back to left for shaped/embedded text.
- Standard-14 fonts do not shape (`shape` is ignored — WinAnsi/Latin only).
```

- [ ] **Step 4: Full suite + typecheck.** Run: `npm run typecheck && npx vitest run`. Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add test/shape-authoring.test.ts README.md
git commit -m "feat(8u0.3): Arabic+Latin acceptance e2e; README i18n note"
```

---

## Self-Review

**Spec coverage:**
- New `src/shape.ts` (bidi+itemize→PositionedGlyph[]) → Task 1. ✔
- New `src/otemit.ts` (TJ x advance/offset, Ts mark y) → Task 2. ✔
- Refactor `embeddedfont.ts` driver to positioned runs + shape flag → Tasks 3, 5. ✔
- wrap-then-bidi-per-line in `layout.ts`/`stamp.ts` → Task 7. ✔
- API `AddFont/AddFontFile {shape}` → Task 5; `AddText/AddTextBlock {shape,dir,script,language}` (per-call override) → Tasks 5, 7, 8. ✔
- `/ToUnicode` from cluster map → Tasks 3, 4. ✔
- Standard-14 ignores shape → `effectiveShape` guard (Task 5) — `font instanceof EmbeddedFont`. ✔
- Arabic+Latin end-to-end vitest → Tasks 1, 5, 7, 9. ✔
- Byte-identical regression for `shape:false` Latin → Task 6. ✔
- README i18n note → Task 9. ✔

**Open design decision recorded:** Arabic joining forms are applied per-glyph on single-glyph slices (Task 1, `applyJoiningForms`) because Phase-1 `otlayout` has no per-glyph feature mask. This is correct for non-contextual Single-Substitution joining lookups (the norm). If a future font needs contextual joining, add a per-glyph feature mask to `otlayout` (out of scope here).

**Type consistency:** `ShapeOpts { dir?; script?; language? }` is the single options shape passed to `shapeText`/`shapeRuns`/`measureShaped`/`shapedDriver`. `PositionedGlyph`/`ShapedRun` field names (`gid`,`cluster`,`xAdvance`,`xOffset`,`yOffset`,`rtl`,`glyphs`) are used identically in Tasks 1–7. `AddFontOptions { shape? }` matches `document.ts` and `EmbeddedFont.shape`. `buildEmbeddedFont(..., toUnicode?)` matches the `document.ts` call site (Task 4).

**Placeholder scan:** the `emitLine` `pre`-handling in Task 2 Step 3 carries an explicit implementer note to simplify the two guarded lines into one `arr.push(num(it.pre))`; the acceptance-test lookup wiring (Task 9) and `readPageContent` helper (Task 5) are flagged as "wire to the codebase's existing pattern" rather than invented APIs — grep the existing authoring tests for the canonical form.
