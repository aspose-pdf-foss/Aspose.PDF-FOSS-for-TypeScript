# PDF/UA-2: font and CMap rules (`q7hc.4.3`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ISO 14289-2 clause 8.4.5 — 15 new PDF/UA-2 rules over fonts, CMaps and
the glyphs a document actually shows — with part 1 byte-identical.

**Architecture:** `visitContent` learns `/Tr` and `GlyphEvent` gains
`renderMode`, because four of the five glyph rules exempt invisible text.
`TextFont` gains `dictWidth`, because the width rule needs the DICTIONARY width
and `Glyph.width` falls back to the program. `uafont.ts` then holds all 15 rules
beside `uaannot.ts`, both over `uarule.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-15-pdfua2-fonts-cmaps-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every relative import specifier carries `.js`.
- **`npm run typecheck` and `npm test` green before any task is done.**
- **Part 1 is byte-identical.** These four must pass **UNEDITED**:
  `test/pdfua-part1-identity.test.ts`, `test/pdfua2-validate.test.ts`,
  `test/pdfuaconvert.test.ts`, `test/markdown-pdfua.test.ts`.
- **`GlyphEvent.renderMode` is ABSENT for mode 0**, the PDF initial value —
  `GlyphEvent.color`'s precedent, and what keeps every existing fixture that
  compares a glyph event byte-identical. If a text/extraction test moves, the
  change is wrong.
- **Every new rule opens `if (ctx.part !== 2) return [];`** and is APPENDED to
  `RULES`, never inserted.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.4.3` at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  Run the sweep through node, not shell globbing:
  ```bash
  node -e "
  const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');
  const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts'))
    .filter(b=>!md.includes('**'+b+'**') && !md.includes('\`'+b+'\`'));
  console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
  ```
- **The anchor is a TRANSCRIPTION, not a runnable oracle**, fetched 2026-09-15:
  - `veraPDF/veraPDF-validation-profiles@integration`,
    `PDF_UA/2/8.4 Text representation for content/8.4.5 Fonts/**`
  - `veraPDF/veraPDF-validation@integration`,
    `validation-model/src/main/java/org/verapdf/gf/model/impl/operator/textshow/GFGlyph.java`

  **Never write one of these from memory.**

## Verified API surface

Every name below was checked against the codebase before this plan was written.
Use them exactly:

| Name | Where | Signature |
|---|---|---|
| `Ctx` | `validatectx.ts` | `{ doc, catalog, R(o), cache }` — constructible from a `UaCtx` |
| `enumerateFonts` | `validatectx.ts` | `(ctx: Ctx) => { ref?: PdfRef; dict: PdfDict }[]`, memoized |
| `descendantFont` | `validatectx.ts` | `(ctx: Ctx, font: PdfDict) => PdfDict \| undefined` |
| `hasFontProgram` | `validatectx.ts` | `(ctx: Ctx, descriptor: PdfObject \| undefined) => boolean` |
| `nameOf` | `validatectx.ts` | `(ctx: Ctx, dict: PdfDict, key: string) => string \| undefined` |
| `loadEmbeddedProgram` | `glyphprogram.ts` | `(fdObj, resolve, inflate) => EmbeddedProgram` — takes the **FontDescriptor** |
| `gidForProgram` | `glyphprogram.ts` | `(prog, code, text, nameForCode) => number \| undefined` |
| `gidForCid` | `glyphprogram.ts` | `(prog, cid, cidToGid) => number` |
| `programAdvance` | `glyphprogram.ts` | `(prog, gid) => number \| undefined`, **already 1/1000 em** |
| `glyphNameResolver` | `font.ts` | exported |
| `SfntFont.cmapSubtable` | `sfnt.ts` | `(platform, encoding) => Map<number, number> \| undefined` |
| `Glyph` | `font.ts` | `{ text, width, code, cid, byteStart, byteLen, isWordSpace }` |

---

## File Structure

| File | Responsibility |
|---|---|
| **Modify** `src/text.ts` | Track `/Tr`; `GlyphEvent.renderMode`; save/restore it across `q`/`Q`. |
| **Modify** `src/font.ts` | `TextFont.dictWidth(key)` — the DICTIONARY width alone. |
| **Create** `src/uafont.ts` | The 15 rules of 8.4.5. |
| **Modify** `src/structvalidate.ts` | Append `FONT_RULES`. |
| **Create** `test/text-render-mode-event.test.ts` | `renderMode`: absent at 0, present otherwise, restored by `Q`. |
| **Create** `test/pdfua2-font.test.ts` | Each of the 15 as a cross-part PAIR. |
| **Create** `test/helpers/build-font-pdf.ts` | A tagged page drawing text in a font built to order. |
| **Create** `test/pdfua2-font-coverage.test.ts` | The census, and the Table 116 size. |
| **Modify** `CLAUDE.md`, `README.md`, `CHANGELOG.md` | Source entries, count, API text, Unreleased. |

---

### Task 1: `/Tr` reaches `GlyphEvent`, correctly scoped

**Files:**
- Modify: `src/text.ts`
- Test: `test/text-render-mode-event.test.ts`

**Interfaces:**
- Produces: `GlyphEvent.renderMode?: number` — absent for 0.

- [ ] **Step 1: Write the failing test**

Create `test/text-render-mode-event.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildRenderModePdf } from './helpers/build-render-mode-pdf.js';

/** Every glyph event of page 0, in order. */
function glyphs(bytes: Uint8Array): GlyphEvent[] {
  const doc = Document.Open(bytes);
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
}

describe('GlyphEvent.renderMode', () => {
  it('is ABSENT for mode 0, the PDF initial value', () => {
    // GlyphEvent.color's precedent: a key present on every glyph would move
    // every fixture that compares an event. Asserted with `in` rather than a
    // value comparison, since `undefined` and absent differ to toEqual.
    const [g] = glyphs(buildRenderModePdf([{ text: 'a' }]));
    expect('renderMode' in g).toBe(false);
  });

  it('is present for every other mode', () => {
    for (const mode of [1, 2, 3, 7]) {
      const [g] = glyphs(buildRenderModePdf([{ text: 'a', mode }]));
      expect(g.renderMode, `mode ${mode}`).toBe(mode);
    }
  });

  it('is RESTORED by Q, unlike its five siblings', () => {
    // The whole reason this field is scoped and Tc/Tw/Tz/TL/Ts are not (g5x6).
    // An OCR tool that wraps its invisible layer in q...Q would otherwise leave
    // the mode stuck at 3 and silently EXEMPT the visible text after it — a
    // false negative on exactly the population mode 3 exists to excuse.
    const out = glyphs(buildRenderModePdf([
      { text: 'a', mode: 3, wrapInQ: true },
      { text: 'b' },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0].renderMode).toBe(3);
    expect('renderMode' in out[1]).toBe(false);
  });

  it('persists WITHOUT a q/Q, since Tr is not reset by BT', () => {
    const out = glyphs(buildRenderModePdf([
      { text: 'a', mode: 3 },
      { text: 'b' },
    ]));
    expect(out[0].renderMode).toBe(3);
    expect(out[1].renderMode).toBe(3);
  });
});
```

- [ ] **Step 2: Write the fixture builder**

Create `test/helpers/build-render-mode-pdf.ts`:

```ts
import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';

/** One show operation on the page. */
export interface ShowSpec {
  text: string;
  /** /Tr to set before showing; omitted leaves the mode as it stands. */
  mode?: number;
  /** Wrap the Tr and the show in `q` … `Q`, so the mode must be restored. */
  wrapInQ?: boolean;
}

/** A one-page document whose content stream shows each spec in turn, using the
 *  page's existing /F1 font.
 *
 *  Hand-built content rather than `AddText`, because `AddText` emits no /Tr at
 *  all and there is no authoring option for one — the render mode is a
 *  rendering concern this library writes only through PageGraphics. */
export function buildRenderModePdf(specs: ShowSpec[]): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  const page = doc.Pages[0];
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const parts: string[] = [];
  let y = 700;
  for (const s of specs) {
    const body = [
      s.mode === undefined ? '' : `${s.mode} Tr`,
      'BT /F1 12 Tf',
      `1 0 0 1 72 ${y} Tm`,
      `(${esc(s.text)}) Tj`,
      'ET',
    ].filter((l) => l !== '').join('\n');
    parts.push(s.wrapInQ === true ? `q\n${body}\nQ` : body);
    y -= 20;
  }
  page.AppendContent(parts.join('\n'));
  return doc.Save();
}
```

> **Confirm `Page.AppendContent` exists with that name before writing this.**
> Run `grep -n "AppendContent\|appendContent" src/page.ts`. If it does not,
> splice the stream the way `test/helpers/build-multi-stream-page.ts` does and
> use that helper's entry point instead — do NOT invent a page method.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/text-render-mode-event.test.ts`
Expected: FAIL — `renderMode` is undefined for every mode.

- [ ] **Step 4: Track `/Tr` in the text state**

In `src/text.ts`, add the field to `TextState` (the interface around line 391)
and to `newState()`:

```ts
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
  /** /Tr, the text rendering mode (32000-2 9.3.6). 0 is the initial value.
   *
   *  **Invariant, and it is a DELIBERATE INCONSISTENCY inside this struct:**
   *  this field IS saved and restored across `q`/`Q`; its five siblings above
   *  are NOT. `TextState` is built once per walk and the `q` stack holds
   *  `{ ctm, fill, conv }` alone, so `Tc`/`Tw`/`Tz`/`TL`/`Ts` persist across a
   *  `Q` contrary to 9.3.1. Fixing all six moves glyph POSITIONS for any
   *  document using `q`/`Q` around them, which reaches `GetTextFragments`,
   *  table detection and every export — filed as `g5x6`.
   *
   *  Scoping only this one correctly is not tidiness: ISO 14289-2's glyph rules
   *  exempt mode 3, and an OCR tool that wraps its invisible layer in `q` … `Q`
   *  would otherwise leave the mode stuck at 3 and silently EXEMPT the visible
   *  text after it. */
  renderMode: number;
```

```ts
function newState(): TextState {
  return {
    tm: IDENTITY, tlm: IDENTITY, fontSize: 0, charSp: 0, wordSp: 0,
    hscale: 1, leading: 0, rise: 0, renderMode: 0,
  };
}
```

- [ ] **Step 5: Handle the operator and the q/Q stack**

Beside its five siblings (around line 650):

```ts
        case 'Tr': st.renderMode = num(op.operands[0]); break;
```

In the `q` case, save it; in `Q`, restore it. The stack entry gains one field:

```ts
        case 'q': gsStack.push({ ctm: curCtm, fill, conv: fillConv, renderMode: st.renderMode }); break;
```

and the `Q` case assigns `st.renderMode` back from the popped entry alongside
the CTM and fill it already restores. Widen the `gsStack` element type to carry
`renderMode: number`.

- [ ] **Step 6: Put it on the event**

In `GlyphEvent`, after `color`:

```ts
  /** /Tr, the text rendering mode, when it is not 0.
   *
   *  **Absent means 0**, the PDF initial value — `color`'s rule, and for
   *  `color`'s reason: a key present on every glyph would move every fixture
   *  that compares an event. Read by ISO 14289-2's glyph rules, four of which
   *  exempt mode 3 (invisible text, the OCR layer of a scanned page). */
  renderMode?: number;
```

and where the glyph event is constructed, set it only when non-zero:

```ts
      ...(st.renderMode !== 0 ? { renderMode: st.renderMode } : {}),
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/text-render-mode-event.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Prove nothing else moved**

Run: `npx vitest run test/text.test.ts test/text-fragments.test.ts test/text-script.test.ts test/search-region.test.ts test/docmodel.test.ts`
Expected: PASS, **unedited**. `renderMode` is absent at mode 0, so every event
comparison is byte-identical; if one of these moves, the absent-means-0 rule was
not honoured.

- [ ] **Step 9: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/text.ts test/text-render-mode-event.test.ts test/helpers/build-render-mode-pdf.ts
git commit -m "feat(q7hc.4.3): visitContent tracks /Tr, and GlyphEvent carries it

Tr was the only text-state operator visitContent did not track. Four of
ISO 14289-2's five glyph rules exempt mode 3, which is the OCR layer of
every scanned PDF, so without it those rules fire on exactly the
population they exist to excuse.

Absent means 0, GlyphEvent.color's rule, so every existing fixture that
compares an event is byte-identical by construction.

The new field IS restored by Q while its five siblings are not — filed as
g5x6. An OCR layer wrapped in q...Q would otherwise leave the mode stuck
at 3 and silently exempt the visible text after it."
```

---

### Task 2: `TextFont.dictWidth` — the dictionary width alone

**Files:**
- Modify: `src/font.ts`
- Test: `test/font-dict-width.test.ts`

**Interfaces:**
- Produces: `TextFont.dictWidth(key: number): number | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/font-dict-width.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildWidthsPdf } from './helpers/build-font-pdf.js';

describe('TextFont.dictWidth', () => {
  it('returns the width the /Widths array states', () => {
    const doc = Document.Open(buildWidthsPdf({ widths: { 65: 600 } }));
    const font = doc.Pages[0].Fonts[0];
    expect(font.dictWidth(65)).toBeCloseTo(0.6, 6);
  });

  it('returns /MissingWidth for a code the array does not cover', () => {
    const doc = Document.Open(buildWidthsPdf({ widths: { 65: 600 }, missingWidth: 250 }));
    const font = doc.Pages[0].Fonts[0];
    expect(font.dictWidth(66)).toBeCloseTo(0.25, 6);
  });

  it('is UNDEFINED where the dictionary states nothing', () => {
    // The whole point. `Glyph.width` falls through to the embedded program
    // here, so comparing THAT against the program would compare a value with
    // itself and 8.4.5.6-1 could never fire.
    const doc = Document.Open(buildWidthsPdf({ widths: { 65: 600 } }));
    const font = doc.Pages[0].Fonts[0];
    expect(font.dictWidth(66)).toBeUndefined();
  });

  it('is UNDEFINED for a font with no /Widths at all', () => {
    const doc = Document.Open(buildWidthsPdf({}));
    const font = doc.Pages[0].Fonts[0];
    expect(font.dictWidth(65)).toBeUndefined();
  });
});
```

> **`Page.Fonts` may not exist.** Confirm with `grep -n "get Fonts" src/page.ts`.
> If it does not, reach the `TextFont` the way `test/font-cid-program-widths.test.ts`
> does — read that file and use its route. Do NOT add a page accessor for a test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-dict-width.test.ts`
Expected: FAIL — `dictWidth is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/font.ts`, beside the private `advance` method:

```ts
  /**
   * The width the font DICTIONARY states for `key`, or `undefined` when it
   * states none. Pass a code for a simple font and a CID for a composite one,
   * exactly as {@link TextFont.advance} does.
   *
   * **This is NOT `Glyph.width`, and the difference is the whole reason it
   * exists.** `advance` falls through to the embedded program when `/Widths`
   * has no entry for the key — which is right for measuring text and fatal for
   * ISO 14289-2 8.4.5.6-1, whose job is to compare the dictionary against the
   * program. Reading `Glyph.width` there would compare the program's answer
   * with itself and the rule could never fire.
   *
   * It mirrors `advance`'s first two branches and stops before the fallback, so
   * the two provably cannot disagree about what the dictionary says.
   *
   * **Note the unit:** em units, like `Glyph.width` — `widthScale` is 0.001 for
   * every font but Type 3, whose scale is its `/FontMatrix`. A Type 3 font has
   * no font program, so 8.4.5.6-1 short-circuits before the units could matter.
   */
  dictWidth(key: number): number | undefined {
    if (!this.hasWidths) return undefined;
    const w = this.widths?.get(key);
    if (w !== undefined) return w * this.widthScale;
    if (this.hasMissingWidth) return this.defaultWidth * this.widthScale;
    return undefined;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/font-dict-width.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove it differs from `Glyph.width`**

Add to `test/font-dict-width.test.ts`:

```ts
  it('differs from Glyph.width exactly where the program takes over', () => {
    // Belt and braces on the rule above: for a code the dictionary does not
    // cover, `advance` answers from the program and this answers nothing.
    const doc = Document.Open(buildWidthsPdf({ widths: { 65: 600 }, embed: true }));
    const font = doc.Pages[0].Fonts[0];
    expect(font.dictWidth(66)).toBeUndefined();
    const [g] = font.decodeGlyphs(new Uint8Array([66]));
    expect(g.width).toBeGreaterThan(0);
  });
```

Run it; expected PASS. If `g.width` is 0 the fixture's font has no program for
that code — fix the fixture, since this case is what pins the distinction.

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/font.ts test/font-dict-width.test.ts test/helpers/build-font-pdf.ts
git commit -m "feat(q7hc.4.3): TextFont.dictWidth — the dictionary width alone

advance() falls through to the embedded program when /Widths has no entry,
which is right for measuring text and fatal for ISO 14289-2 8.4.5.6-1 —
comparing Glyph.width against the program compares the program's answer
with itself, so the rule could never fire."
```

---

### Task 3: `uafont.ts` and the five embedding / TrueType rules

**Files:**
- Create: `src/uafont.ts`
- Modify: `src/structvalidate.ts`
- Create: `test/helpers/build-font-pdf.ts` (extended from Task 2)
- Create: `test/pdfua2-font.test.ts`

**Interfaces:**
- Consumes: `UaCtx`, `Rule`, `uaClause` from `./uarule.js`; `enumerateFonts`,
  `descendantFont`, `hasFontProgram`, `nameOf`, type `Ctx` from
  `./validatectx.js`; `loadEmbeddedProgram` from `./glyphprogram.js`.
- Produces: `export const FONT_RULES: Rule[]`, with rule names
  `FontNotEmbedded`, `TrueTypeNonSymbolicCmap`, `TrueTypeNonSymbolicEncoding`,
  `TrueTypeSymbolicEncoding`, `TrueTypeSymbolicCmap`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfua2-font.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFontPdf, type FontPdfSpec } from './helpers/build-font-pdf.js';

const ids = (spec: FontPdfSpec, part: 1 | 2): string[] =>
  Document.Open(buildFontPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. */
function expectPair(spec: FontPdfSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.4.5.5.1-1: fonts must be embedded', () => {
  it('reports a simple font with no font program', () => {
    expectPair({ embed: false, text: 'A' }, 'FontNotEmbedded');
  });

  it('is silent for an embedded font', () => {
    expect(ids({ embed: true, text: 'A' }, 2)).not.toContain('FontNotEmbedded');
  });

  it('EXEMPTS text drawn in render mode 3', () => {
    // The OCR-layer exemption. A fixture that draws its text invisibly measures
    // nothing for any other glyph rule, which is why only this case uses it.
    expect(ids({ embed: false, text: 'A', mode: 3 }, 2)).not.toContain('FontNotEmbedded');
  });

  it('EXEMPTS Type3 and Type0, which the profile names explicitly', () => {
    expect(ids({ embed: false, text: 'A', subtype: 'Type3' }, 2))
      .not.toContain('FontNotEmbedded');
  });
});

describe('PDF/UA-2 8.4.5.7: TrueType encodings', () => {
  it('-3 reports a SYMBOLIC TrueType that states an /Encoding', () => {
    expectPair({ embed: true, text: 'A', symbolic: true, encoding: 'WinAnsiEncoding' },
      'TrueTypeSymbolicEncoding');
  });

  it('-3 is silent for a symbolic TrueType with no /Encoding', () => {
    expect(ids({ embed: true, text: 'A', symbolic: true }, 2))
      .not.toContain('TrueTypeSymbolicEncoding');
  });

  it('-2 reports a NON-SYMBOLIC TrueType whose /Encoding is neither Mac nor WinAnsi', () => {
    expectPair({ embed: true, text: 'A', symbolic: false, encoding: 'StandardEncoding' },
      'TrueTypeNonSymbolicEncoding');
  });

  it('-2 accepts MacRomanEncoding and WinAnsiEncoding', () => {
    for (const encoding of ['MacRomanEncoding', 'WinAnsiEncoding']) {
      expect(ids({ embed: true, text: 'A', symbolic: false, encoding }, 2), encoding)
        .not.toContain('TrueTypeNonSymbolicEncoding');
    }
  });
});
```

- [ ] **Step 2: Write the fixture builder**

Create `test/helpers/build-font-pdf.ts`. It must build a font dict by hand — the
authoring API always embeds and always writes a conformant descriptor, so it
cannot produce the documents these rules are about.

```ts
import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import { buildUnicodeTtf } from './build-unicode-ttf.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';

export interface FontPdfSpec {
  /** Embed a font program (/FontFile2). */
  embed?: boolean;
  /** /Subtype; default TrueType. */
  subtype?: string;
  /** Set the descriptor's Symbolic (bit 3) or Nonsymbolic (bit 6) flag. */
  symbolic?: boolean;
  /** /Encoding as a base-encoding name; omitted leaves the key absent. */
  encoding?: string;
  /** /Widths entries, code -> glyph-space width. */
  widths?: Record<number, number>;
  /** /MissingWidth on the descriptor. */
  missingWidth?: number;
  /** Text to show. */
  text?: string;
  /** /Tr to set before showing. */
  mode?: number;
}

/** A tagged, titled one-page document drawing `text` in a hand-built font. */
export function buildFontPdf(spec: FontPdfSpec): Uint8Array { /* see Step 2b */ }

/** The same builder, named for the width tests of Task 2. */
export const buildWidthsPdf = buildFontPdf;
```

- [ ] **Step 2b: The builder body**

> The exact dict assembly depends on helpers this plan cannot verify from the
> outside. Before writing it, READ `test/helpers/build-tagged-pdf.ts` (which
> writes a font dict by hand) and `test/helpers/build-unicode-ttf.js` (the
> synthetic TrueType), and follow their shapes. The builder must produce:
> a `/Font` resource under the page, a descriptor carrying `/Flags` with bit 3
> (Symbolic, value 4) or bit 6 (Nonsymbolic, value 32) per `spec.symbolic`, a
> `/FontFile2` holding `buildUnicodeTtf()` when `spec.embed`, `/Widths` +
> `/FirstChar` + `/LastChar` from `spec.widths`, `/MissingWidth` on the
> descriptor, and a content stream that sets `spec.mode` as `/Tr` before
> showing `spec.text`. Those flag VALUES are 32000-2 Table 121 and must be
> checked there, not recalled.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-font.test.ts`
Expected: FAIL — none of the rule ids appear.

- [ ] **Step 4: Write `src/uafont.ts`**

```ts
/** ISO 14289-2 clause 8.4.5 — fonts and CMaps, the 15 rules `q7hc.4.3` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.4 Text representation for content/8.4.5 Fonts/**`, plus
 *  `GFGlyph.java` for the glyph model's CACHE KEY, fetched 2026-09-15. A
 *  TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module beside `uaannot.ts`, both over `uarule.ts`.
 *  The split is by subject, which is what keeps `structvalidate.ts` the
 *  structure tree's rules and the three free of an import cycle.
 *
 *  **Invariant:** the per-font rules reuse `validatectx.ts`'s `enumerateFonts`,
 *  which `pdfavalidate.ts` and `pdfxvalidate.ts` already consume — a third font
 *  walk is how three validators come to disagree about which fonts a document
 *  has. A `validatectx.Ctx` is built from the `UaCtx` for that one purpose.
 *
 *  **Invariant:** NOTHING here is converted. Embedding a font, synthesizing
 *  `/ToUnicode` and correcting `/Widths` are things `ConvertToPdfA` does under
 *  its own opt-in; doing them here would silently re-encode a document the
 *  caller asked only to validate. Every rule lands in `unresolved`. @internal */
import { isDict, isName, isStream, type PdfDict, type PdfObject } from './types.js';
import { uaClause, type Rule, type UaCtx } from './uarule.js';
import {
  descendantFont, enumerateFonts, hasFontProgram, nameOf, type Ctx,
} from './validatectx.js';
import { loadEmbeddedProgram } from './glyphprogram.js';
import type { ValidationIssue } from './validation.js';

/** A `validatectx.Ctx` over this run, so the shared font walk can be reused.
 *  Memoized on the UaCtx so `enumerateFonts` is walked once per validation. */
const CTX = new WeakMap<UaCtx, Ctx>();
function vctx(ctx: UaCtx): Ctx {
  let c = CTX.get(ctx);
  if (c === undefined) {
    c = {
      doc: ctx.doc, catalog: ctx.catalog,
      R: (o: PdfObject | undefined) => ctx.doc.resolve(o),
      cache: new Map<string, unknown>(),
    };
    CTX.set(ctx, c);
  }
  return c;
}

/** 32000-2 Table 121 font descriptor flags. */
const FLAG_SYMBOLIC = 4;      // bit 3

/** True when the descriptor sets Symbolic. */
function isSymbolic(ctx: UaCtx, descriptor: PdfObject | undefined): boolean {
  const fd = ctx.doc.resolve(descriptor);
  if (!isDict(fd)) return false;
  const flags = ctx.doc.resolve(fd.get('Flags'));
  return typeof flags === 'number' && (flags & FLAG_SYMBOLIC) !== 0;
}

/** 8.4.5.5.1-1: every rendered font shall be embedded.
 *
 *  **Note the three exemptions are the profile's own:** Type3 (its glyphs are
 *  content streams, so there is no program to embed), Type0 (the rule applies
 *  to its DESCENDANT, which 8.4.5.3.2 covers) and render mode 3. */
const fontNotEmbeddedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    const subtype = nameOf(c, dict, 'Subtype');
    if (subtype === 'Type3' || subtype === 'Type0') continue;
    if (hasFontProgram(c, dict.get('FontDescriptor'))) continue;
    if (!rendersVisibly(ctx, dict)) continue;
    issues.push({
      rule: 'FontNotEmbedded', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.5.1' }), object: ref,
      message: `Font '${nameOf(c, dict, 'BaseFont') ?? '(unnamed)'}' is rendered `
        + 'but has no embedded font program.',
    });
  }
  return issues;
};
```

> `rendersVisibly(ctx, fontDict)` — "does any glyph drawn in this font use a
> render mode other than 3" — is built in Task 5 alongside the glyph walk, which
> is the only thing that knows. **Until Task 5 lands, define it in this file as
> `() => true`** and replace it there; Task 5's step list says so explicitly.

Add the four TrueType rules:

```ts
/** 8.4.5.7-3: a symbolic TrueType shall state no /Encoding. */
const trueTypeSymbolicEncodingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    if (!isSymbolic(ctx, dict.get('FontDescriptor'))) continue;
    if (!dict.has('Encoding')) continue;
    issues.push({
      rule: 'TrueTypeSymbolicEncoding', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
      message: 'Symbolic TrueType font states an /Encoding; it must state none.',
    });
  }
  return issues;
};

/** 8.4.5.7-2: a non-symbolic TrueType's /Encoding shall be MacRoman or WinAnsi,
 *  and any /Differences shall be Unicode compliant.
 *
 *  **Note `differencesAreUnicodeCompliant` means every name in /Differences
 *  resolves to a Unicode code point** through the Adobe glyph list, which
 *  `encoding.ts`'s resolver already answers — a name it cannot resolve is one
 *  no consumer can map to text. */
const trueTypeNonSymbolicEncodingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    if (isSymbolic(ctx, dict.get('FontDescriptor'))) continue;
    const enc = ctx.doc.resolve(dict.get('Encoding'));
    const base = isName(enc) ? enc.name
      : isDict(enc) ? nameOf(c, enc, 'BaseEncoding') : undefined;
    const baseOk = base === 'MacRomanEncoding' || base === 'WinAnsiEncoding';
    const diffsOk = !isDict(enc) || differencesUnicodeCompliant(ctx, enc);
    if (baseOk && diffsOk) continue;
    issues.push({
      rule: 'TrueTypeNonSymbolicEncoding', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
      message: baseOk
        ? 'Non-symbolic TrueType /Differences names a glyph with no Unicode value.'
        : `Non-symbolic TrueType /Encoding is '${base ?? '(absent)'}', expected `
          + 'MacRomanEncoding or WinAnsiEncoding.',
    });
  }
  return issues;
};

/** 8.4.5.7-1 and -4: the embedded program's cmap subtables.
 *
 *  Non-symbolic needs (3,1) or (1,0); symbolic needs (3,0) or (1,0). Both are
 *  read through `SfntFont.cmapSubtable`, which returns exactly the named
 *  subtable rather than the best Unicode one — the distinction that whole
 *  accessor exists for. */
const trueTypeCmapRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    const prog = loadEmbeddedProgram(
      dict.get('FontDescriptor'),
      (o: PdfObject | undefined) => ctx.doc.resolve(o),
      (s) => ctx.doc.inflateStream(s),
    );
    const sfnt = prog.sfnt;
    if (sfnt === undefined) continue;
    const has = (p: number, e: number): boolean => sfnt.cmapSubtable(p, e) !== undefined;
    const symbolic = isSymbolic(ctx, dict.get('FontDescriptor'));
    if (!symbolic && !has(3, 1) && !has(1, 0)) {
      issues.push({
        rule: 'TrueTypeNonSymbolicCmap', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
        message: 'Non-symbolic TrueType program has neither a (3,1) nor a (1,0) '
          + 'cmap subtable.',
      });
    }
    if (symbolic && !has(3, 0) && !has(1, 0)) {
      issues.push({
        rule: 'TrueTypeSymbolicCmap', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
        message: 'Symbolic TrueType program has neither a (3,0) nor a (1,0) '
          + 'cmap subtable.',
      });
    }
  }
  return issues;
};

export const FONT_RULES: Rule[] = [
  fontNotEmbeddedRule, trueTypeSymbolicEncodingRule,
  trueTypeNonSymbolicEncodingRule, trueTypeCmapRules,
];
```

> **`differencesUnicodeCompliant(ctx, encDict)`** and
> **`doc.inflateStream`** are the two names this task cannot verify from the
> outside. Before writing, confirm the inflate route with
> `grep -n "inflateStream" src/document.ts src/glyphprogram.ts` and use whatever
> `font.ts` passes to `loadEmbeddedProgram`; and write
> `differencesUnicodeCompliant` over `encoding.ts`'s Adobe-glyph-name resolver,
> confirming its exported name with `grep -n "^export" src/encoding.ts`.

- [ ] **Step 5: Append in `structvalidate.ts`**

```ts
import { FONT_RULES } from './uafont.js';
```

and, after `...ANNOT_RULES`:

```ts
  // q7hc.4.3 — ISO 14289-2 8.4.5, part 2 only. APPENDED, so part-1 order holds.
  ...FONT_RULES,
```

- [ ] **Step 6: Run the test, the fences and the cycle check**

```bash
npx vitest run test/pdfua2-font.test.ts
npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/import-cycles.test.ts
```
Expected: PASS, all, **unedited**.

- [ ] **Step 7: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uafont.ts src/structvalidate.ts test/pdfua2-font.test.ts test/helpers/build-font-pdf.ts
git commit -m "feat(q7hc.4.3): font embedding and the four TrueType encoding rules

The per-font rules reuse validatectx.ts's enumerateFonts, which
pdfavalidate and pdfxvalidate already consume — a third font walk is how
three validators come to disagree about which fonts a document has.

cmapSubtable returns exactly the NAMED subtable rather than the best
Unicode one, which is the distinction that accessor exists for."
```

---

### Task 4: The five CMap and CIDFont rules

**Files:**
- Modify: `src/uafont.ts`
- Test: `test/pdfua2-font.test.ts`

**Interfaces:**
- Produces rule names: `CidSystemInfoMatch`, `CidToGidMap`, `CMapEmbedded`,
  `CMapWModeMatch`, `CMapReference`.

- [ ] **Step 1: Transcribe Table 116**

Add to `src/uafont.ts`:

```ts
/** The predefined CMap names ISO 32000-2 Table 116 sanctions.
 *
 *  **Invariant: SIXTY-ONE, and this is NOT `predefcmap.ts`'s set.**
 *  `cmapdata.ts` bundles **195** predefined Adobe CMaps — every one Adobe
 *  published, including the deprecated Japan2 collection — where Table 116 is
 *  the subset PDF 2.0 still sanctions. "Do we have this CMap bundled" and "does
 *  PDF 2.0 sanction it" are different questions and the bundled set is three
 *  times the size; answering the first would silently pass 134 CMaps this rule
 *  exists to report. Transcribed from the profile's own test expression, which
 *  spells every name out.
 *
 *  Asserted by SIZE in `test/pdfua2-font-coverage.test.ts`, so a half-pasted
 *  list is a red build — the rule `htmlforeign.ts` sets for its five tables. */
const TABLE_116_CMAPS = new Set([
  'Identity-H', 'Identity-V',
  'GB-EUC-H', 'GB-EUC-V', 'GBpc-EUC-H', 'GBpc-EUC-V', 'GBK-EUC-H', 'GBK-EUC-V',
  'GBKp-EUC-H', 'GBKp-EUC-V', 'GBK2K-H', 'GBK2K-V',
  'UniGB-UCS2-H', 'UniGB-UCS2-V', 'UniGB-UTF16-H', 'UniGB-UTF16-V',
  'B5pc-H', 'B5pc-V', 'HKscs-B5-H', 'HKscs-B5-V', 'ETen-B5-H', 'ETen-B5-V',
  'ETenms-B5-H', 'ETenms-B5-V', 'CNS-EUC-H', 'CNS-EUC-V',
  'UniCNS-UCS2-H', 'UniCNS-UCS2-V', 'UniCNS-UTF16-H', 'UniCNS-UTF16-V',
  '83pv-RKSJ-H', '90ms-RKSJ-H', '90ms-RKSJ-V', '90msp-RKSJ-H', '90msp-RKSJ-V',
  '90pv-RKSJ-H', 'Add-RKSJ-H', 'Add-RKSJ-V', 'EUC-H', 'EUC-V',
  'Ext-RKSJ-H', 'Ext-RKSJ-V', 'H', 'V',
  'UniJIS-UCS2-H', 'UniJIS-UCS2-V', 'UniJIS-UCS2-HW-H', 'UniJIS-UCS2-HW-V',
  'UniJIS-UTF16-H', 'UniJIS-UTF16-V',
  'KSC-EUC-H', 'KSC-EUC-V', 'KSCms-UHC-H', 'KSCms-UHC-V',
  'KSCms-UHC-HW-H', 'KSCms-UHC-HW-V', 'KSCpc-EUC-H',
  'UniKS-UCS2-H', 'UniKS-UCS2-V', 'UniKS-UTF16-H', 'UniKS-UTF16-V',
]);
```

- [ ] **Step 2: Write the failing test**

Append to `test/pdfua2-font.test.ts`:

```ts
describe('PDF/UA-2 8.4.5.4: CMaps', () => {
  it('-1 reports a predefined CMap outside Table 116', () => {
    // 'Identity-UTF16-H' is a real Adobe CMap our cmapdata.ts bundles and
    // Table 116 does NOT list. That gap is the whole rule: answering from the
    // bundled 195 rather than the sanctioned 61 passes it silently.
    expectPair({ type0: { encoding: 'UniJIS-UCS2-HW-V' }, text: 'A' }, 'CMapEmbedded');
  });

  it('-1 is silent for a Table 116 name', () => {
    expect(ids({ type0: { encoding: 'Identity-H' }, text: 'A' }, 2))
      .not.toContain('CMapEmbedded');
  });
});

describe('PDF/UA-2 8.4.5.3.2-1: CIDToGIDMap', () => {
  it('reports an EMBEDDED CIDFontType2 with no /CIDToGIDMap', () => {
    expectPair({ type0: { encoding: 'Identity-H', embed: true }, text: 'A' },
      'CidToGidMap');
  });

  it('is silent when /CIDToGIDMap is present', () => {
    expect(ids({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' }, text: 'A',
    }, 2)).not.toContain('CidToGidMap');
  });

  it('is silent for a NON-embedded CIDFontType2', () => {
    // The profile's own escape: `containsFontFile == false`. Reporting a
    // missing map on a font with no program would be reporting twice for one
    // defect, which 8.4.5.5.1-1 already names.
    expect(ids({ type0: { encoding: 'Identity-H', embed: false }, text: 'A' }, 2))
      .not.toContain('CidToGidMap');
  });
});

describe('PDF/UA-2 8.4.5.3.1-1: CIDSystemInfo must match the CMap', () => {
  it('is silent for Identity-H whatever the CIDSystemInfo says', () => {
    // The profile exempts Identity-H and Identity-V by name — they belong to no
    // collection, so there is nothing to agree with.
    expect(ids({
      type0: { encoding: 'Identity-H', registry: 'Adobe', ordering: 'Japan1' }, text: 'A',
    }, 2)).not.toContain('CidSystemInfoMatch');
  });

  it('reports an ordering that differs from the CMap', () => {
    expectPair({
      type0: { encoding: 'UniJIS-UCS2-H', registry: 'Adobe', ordering: 'GB1', supplement: 0 },
      text: 'A',
    }, 'CidSystemInfoMatch');
  });

  it('reports a supplement HIGHER than the CMap', () => {
    // `CIDFontSupplement <= CMapSupplement` — a font may be older than its
    // CMap, never newer.
    expectPair({
      type0: {
        encoding: 'UniJIS-UCS2-H', registry: 'Adobe', ordering: 'Japan1', supplement: 99,
      },
      text: 'A',
    }, 'CidSystemInfoMatch');
  });
});
```

> **Before writing these, confirm what `cidcmap.ts` / `predefcmap.ts` expose for
> a predefined CMap's registry, ordering and supplement.** Run
> `grep -n "registry\|ordering\|supplement" src/cidcmap.ts src/predefcmap.ts`.
> If the bundled data does not carry the supplement, 8.4.5.3.1-1 can compare
> registry and ordering only — record that narrowing in the rule's doc comment
> and in PROVENANCE-style prose, and drop the supplement CASE from this test
> rather than asserting something the data cannot answer.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-font.test.ts`
Expected: FAIL — the five new rule ids do not appear.

- [ ] **Step 4: Write the five rules**

Add to `src/uafont.ts`, before `FONT_RULES`, and add each to that array:

```ts
/** 8.4.5.4-1: a CMap outside Table 116 shall be embedded. */
const cmapEmbeddedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'Type0') continue;
    const enc = ctx.doc.resolve(dict.get('Encoding'));
    // An embedded CMap is a STREAM; a predefined one is a NAME.
    if (isStream(enc)) continue;
    const cmapName = isName(enc) ? enc.name : undefined;
    if (cmapName !== undefined && TABLE_116_CMAPS.has(cmapName)) continue;
    issues.push({
      rule: 'CMapEmbedded', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.4' }), object: ref,
      message: `CMap '${cmapName ?? '(absent)'}' is not one of the predefined `
        + 'CMaps ISO 32000-2 Table 116 lists, and is not embedded.',
    });
  }
  return issues;
};

/** 8.4.5.3.2-1: an embedded CIDFontType2 shall state /CIDToGIDMap. */
const cidToGidMapRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'Type0') continue;
    const cid = descendantFont(c, dict);
    if (cid === undefined) continue;
    if (nameOf(c, cid, 'Subtype') !== 'CIDFontType2') continue;
    if (cid.has('CIDToGIDMap')) continue;
    if (!hasFontProgram(c, cid.get('FontDescriptor'))) continue;
    issues.push({
      rule: 'CidToGidMap', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.3.2' }), object: ref,
      message: 'Embedded CIDFontType2 does not state /CIDToGIDMap.',
    });
  }
  return issues;
};
```

> The remaining three — `CidSystemInfoMatch`, `CMapWModeMatch` and
> `CMapReference` — each need one fact this plan could not verify from outside:
> a predefined CMap's registry/ordering/supplement, an embedded CMap stream's
> parsed `/WMode`, and a `usecmap` name. Write them over `cidcmap.ts`'s parser
> and `predefcmap.ts`'s bundle after the greps in Step 2's note, and give each a
> doc comment naming the clause and the escape the profile states. Do NOT
> re-implement CMap parsing — `cidcmap.ts` is the one owner, shared with
> `scripts/gen-cmaps.ts`, and a second grammar there is how the bundled data and
> a document's own CMap come to be read differently.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-font.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uafont.ts test/pdfua2-font.test.ts test/helpers/build-font-pdf.ts
git commit -m "feat(q7hc.4.3): the CMap and CIDFont rules, and Table 116

Table 116 is SIXTY-ONE names; cmapdata.ts bundles 195. Answering 'do we
have this CMap' rather than 'does PDF 2.0 sanction it' would pass 134
CMaps the rule exists to report."
```

---

### Task 5: The five glyph rules, deduped

**Files:**
- Modify: `src/uafont.ts`
- Test: `test/pdfua2-font.test.ts`

**Interfaces:**
- Consumes: `visitContent` from `./text.js`; `GlyphEvent.renderMode` (Task 1);
  `TextFont.dictWidth` (Task 2); `gidForProgram`, `gidForCid`, `programAdvance`
  from `./glyphprogram.js`.
- Produces rule names: `GlyphNotPresent`, `GlyphWidthMismatch`,
  `ToUnicodeMissing`, `ToUnicodeReserved`, `NotdefUsed`; and replaces
  `rendersVisibly` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-font.test.ts`:

```ts
describe('PDF/UA-2 8.4.5.8: ToUnicode', () => {
  it('-1 reports a code that maps to no Unicode', () => {
    expectPair({ embed: true, text: 'A', noToUnicode: true }, 'ToUnicodeMissing');
  });

  it('-2 reports U+0000, U+FEFF and U+FFFE', () => {
    for (const cp of [0x0000, 0xfeff, 0xfffe]) {
      expectPair({ embed: true, text: 'A', toUnicodeFor: { 65: cp } }, 'ToUnicodeReserved');
    }
  });

  it('-2 is silent for an ordinary mapping', () => {
    expect(ids({ embed: true, text: 'A', toUnicodeFor: { 65: 0x0041 } }, 2))
      .not.toContain('ToUnicodeReserved');
  });

  it('EXEMPTS render mode 3', () => {
    expect(ids({ embed: true, text: 'A', noToUnicode: true, mode: 3 }, 2))
      .not.toContain('ToUnicodeMissing');
  });
});

describe('PDF/UA-2 8.4.5.6-1: glyph widths', () => {
  it('reports a /Widths that disagrees with the program by more than 1', () => {
    // The acceptance criterion's fixture. The tolerance is 1 unit of 1/1000 em
    // and programAdvance already normalizes to that space, so no scaling here.
    expectPair({ embed: true, text: 'A', widthsDisagreeBy: 50 }, 'GlyphWidthMismatch');
  });

  it('is silent for a disagreement of exactly 1', () => {
    // `<= 1` — one unit is conformant, so a fixture that differs by 1 measures
    // the boundary rather than the rule.
    expect(ids({ embed: true, text: 'A', widthsDisagreeBy: 1 }, 2))
      .not.toContain('GlyphWidthMismatch');
  });

  it('is silent when the dictionary states no width for the code', () => {
    // widthFromDictionary == null. Glyph.width would answer from the program
    // here, so reading THAT would compare the program with itself.
    expect(ids({ embed: true, text: 'A', widths: {} }, 2))
      .not.toContain('GlyphWidthMismatch');
  });
});

describe('PDF/UA-2 8.4.5: glyph rules are DEDUPED per (font, code, mode)', () => {
  it('reports ONCE for a character drawn many times', () => {
    // GFGlyph.getGlyph caches per (font, code, renderingMode, ...), so veraPDF
    // models one Glyph however often it is drawn. A test asserting one finding
    // per occurrence would be asserting the ABSENCE of that cache.
    const hits = Document.Open(buildFontPdf({ embed: true, text: 'AAAAA', noToUnicode: true }))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'ToUnicodeMissing');
    expect(hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-font.test.ts`
Expected: FAIL — the five new rule ids do not appear.

- [ ] **Step 3: Write the deduped glyph walk**

Add to `src/uafont.ts`:

```ts
/** One distinct glyph the document shows: the deduplication key, plus the font
 *  it was shown in.
 *
 *  **Invariant: DEDUPED by `(font dict, code, renderMode)`.** `GFGlyph.getGlyph`
 *  caches by `(fontId, fontName, glyphCode, renderingMode, markedContent,
 *  structElem, isRealContent)`, so veraPDF models a Glyph ONCE per unique
 *  combination however often it is drawn — a page with five thousand `e`s in
 *  one font yields one Glyph and at most one finding.
 *
 *  We drop the three components we cannot cheaply model, which only ever MERGES
 *  findings veraPDF would separate and never splits one it would merge: the
 *  divergence is a smaller report, never a missed defect.
 *
 *  **It is a correctness rule as much as a cost one.** Without it,
 *  `GlyphWidthMismatch` loads the font program once per character DRAWN, and
 *  the report becomes one finding per glyph on the page. */
interface DistinctGlyph {
  font: TextFont;
  fontDict: PdfDict;
  code: number;
  cid: number;
  text: string;
  renderMode: number;
}

/** Every distinct glyph the document shows, memoized per run. */
function distinctGlyphs(ctx: UaCtx): DistinctGlyph[] {
  return memoUa(ctx, 'ua-glyphs', () => {
    const seen = new Map<string, DistinctGlyph>();
    for (const page of ctx.doc.Pages) {
      visitContent(ctx.doc, page, {
        glyph: (e) => {
          const mode = e.renderMode ?? 0;
          for (const g of e.font.decodeGlyphs(/* … */)) { /* see note */ }
        },
      });
    }
    return [...seen.values()];
  });
}
```

> **The glyph event gives one glyph, not a run.** `GlyphEvent` already carries
> `font`, `text`, `byteStart` and `byteLen`, and Task 1 added `renderMode` — but
> it does NOT carry `code` or `cid`, which the width and presence rules need.
> Before writing this walk, check whether `GlyphEvent` exposes them
> (`grep -n "code\|cid" src/text.ts` around the `GlyphEvent` interface). If it
> does not, the honest options are (a) carry `code` and `cid` onto `GlyphEvent`
> beside `renderMode`, following the same absent-by-default discipline where
> possible, or (b) re-decode the show string through `font.decodeGlyphs`. Prefer
> (a) — CLAUDE.md records that every consumer which re-derived the code from
> `byteStart`/`byteLen` "drew the right glyph for /Identity-H and the wrong one
> for every other CMap, silently". Do NOT re-derive.

- [ ] **Step 4: Write the five rules over that walk**

Each takes the deduped list and reports at most one finding per distinct glyph:

```ts
/** 8.4.5.8-1: every code shall map to a Unicode value. */
/** 8.4.5.8-2: and that value shall not contain U+0000, U+FEFF or U+FFFE.
 *
 *  Transcribed from the profile's own `toUnicode.indexOf(...)` tests. These
 *  three are the code points a consumer cannot render as text: NUL, and the two
 *  byte-order marks, one of which is not even a valid character. */
const RESERVED_UNICODE = [' ', '﻿', '￾'];
```

> Write each rule to: skip `renderMode === 3` (the four that carry that
> exemption — 8.4.5.9-1 does NOT), read its fact from the deduped glyph, and
> cite its clause. `GlyphWidthMismatch` compares
> `Math.abs(programAdvance(prog, gid) - dictWidth * 1000) <= 1`, with
> `programAdvance` already in 1/1000 em and `dictWidth` in em — the ONE place
> the two unit spaces meet, so state it in the comment.

- [ ] **Step 5: Replace `rendersVisibly`**

Task 3 defined it as `() => true`. Replace it with a real answer over the
deduped glyphs: a font renders visibly when any distinct glyph in it has a
render mode other than 3. Re-run Task 3's "EXEMPTS text drawn in render mode 3"
case, which until now was passing for the wrong reason — it must still pass, and
now for the right one.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pdfua2-font.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove four rules are load-bearing**

Run each mutation, confirm it reddens, then **revert**:

1. Drop the `renderMode === 3` skip from `ToUnicodeMissing` — the "EXEMPTS
   render mode 3" case must redden.
2. Change the width tolerance from `<= 1` to `< 1` — the "disagreement of
   exactly 1" case must redden.
3. Read `Glyph.width` instead of `dictWidth` — the "no width for the code" case
   must redden.
4. Drop the dedup (report per occurrence) — the "reports ONCE" case must redden.

- [ ] **Step 8: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uafont.ts test/pdfua2-font.test.ts test/helpers/build-font-pdf.ts
git commit -m "feat(q7hc.4.3): the five glyph rules, deduped per (font, code, mode)

Transcribed from GFGlyph's cache key, which bounds both the cost and the
report: without it the width rule loads the font program once per
character DRAWN and the report is one finding per glyph on the page.

The width rule reads dictWidth, not Glyph.width — the latter falls back to
the program, so it would compare the program's answer with itself."
```

---

### Task 6: The census, the count, and the docs

**Files:**
- Create: `test/pdfua2-font-coverage.test.ts`
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write the census**

Create `test/pdfua2-font-coverage.test.ts`, listing the 15 rule names against
their clauses exactly as `test/pdfua2-annot-coverage.test.ts` does, asserting
`toHaveLength(15)`, that each appears in `src/uafont.ts`, and that
`TABLE_116_CMAPS` holds **61** entries — parsed out of the source the way the
annotation census parses `MARKUP_ANNOTS`.

- [ ] **Step 2: Correct the rule count in CLAUDE.md**

Find the paragraph beginning **"Note the SCOPE, so the absences read as
decisions"**. It currently says 64 of 91 ship and names the remaining 27 as
`.3` (15), `.4` (11) and `.6` (1). Update to: **79 of 91** ship, and the
remaining 12 are `.4` (11) and `.6` (1).

- [ ] **Step 3: Add the CLAUDE.md entries**

A `uafont.ts` Source-list entry after `uaannot.ts`, carrying: the module's
subject and anchor; the `enumerateFonts` reuse; the Table 116 vs 195 invariant;
the glyph dedup and its key; that `dictWidth` is not `Glyph.width` and why; and
that nothing here is converted.

Extend `text.ts`'s entry with the `renderMode` invariant — absent means 0, and
the deliberate q/Q inconsistency with `g5x6` filed.

Extend `font.ts`'s entry with `dictWidth`.

- [ ] **Step 4: README and CHANGELOG**

Extend the `ValidatePdfUa` sentence with clause 8.4.5, and add an
`## [Unreleased]` → `### Added` entry citing `q7hc.4.3` that names the 15 rules,
the `/Tr` tracking, and the two things a reader would otherwise get wrong: that
`GlyphEvent.renderMode` is absent at 0, and that the glyph rules are deduped.

- [ ] **Step 5: Full verification and commit**

```bash
npm run typecheck && npm test
npx vitest run test/pdfua-part1-identity.test.ts test/import-cycles.test.ts
node -e "const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts')).filter(b=>!md.includes('**'+b+'**')&&!md.includes('\`'+b+'\`'));console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
git add test/pdfua2-font-coverage.test.ts CLAUDE.md README.md CHANGELOG.md
git commit -m "docs(q7hc.4.3): the census, and 79 of 91"
```

---

## Final verification

- [ ] `npm run typecheck` and `npm test` — green.
- [ ] The four part-1 fences pass **with no edits in the diff**:
      `git diff --stat main -- test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
      (expected: empty).
- [ ] **No extraction test moved.** `renderMode` is absent at mode 0, so
      `git diff --stat main -- test/text.test.ts test/text-fragments.test.ts test/text-script.test.ts test/docmodel.test.ts`
      must also be empty. If one moved, the absent-means-0 rule was not honoured
      and the change is wrong.
- [ ] `test/import-cycles.test.ts` — the same 15 pairs.
- [ ] The CLAUDE.md sweep prints nothing.
- [ ] `bd close q7hc.4.3` with a note recording the `/Tr` scoping decision and
      `g5x6`, the dedup narrowing, and any rule a mutation showed to be
      uncovered.
- [ ] `git pull --rebase && git push && git status` — must show up to date with
      origin. **Work is not complete until the push succeeds.**
