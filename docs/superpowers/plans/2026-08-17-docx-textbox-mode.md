# DOCX Textbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.ToDocx({ mode: 'textbox' })` — a second DOCX layout mode that reproduces each PDF page's own geometry as positioned `w:framePr` text frames, instead of reflowing the document.

**Architecture:** Two new pure modules — `docxgroup.ts` (glyph events → positioned groups, the adaptive merge) and `docxtextbox.ts` (groups + image placements → `w:body` XML) — plus a single mode branch in `docxexport.ts`, the only module in the stack that reads a `Document`. One narrow shared-model change: `GlyphEvent` gains a fill colour; `TextFragment` deliberately does not.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies (`node:` built-ins only). Output is ECMA-376 WordprocessingML written through the existing `zip.ts` → `ooxml.ts` → `docxpackage.ts` stack.

**Spec:** `docs/superpowers/specs/2026-08-17-docx-textbox-mode-design.md`

**Issue:** `aspose-pdf-foss-for-ts-8yt9.4` (bd), last child of epic `8yt9`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any task is considered done.
- **Full suite green.** `npm test` must pass before closing any task. Target one file with `npx vitest run test/<name>.test.ts`.
- **Flow mode is byte-frozen.** `doc.ToDocx()` output must not change by one byte. Task 3 installs the fence that proves it; every later task must keep it green.
- **Absent, not defaulted.** New optional fields (`GlyphEvent.color`, `TextGroup.bold`, …) are omitted when they carry the default value, never set to `false`/`[0,0,0]`. This is the fence that keeps existing snapshots still — `TextFragment.bold`/`.italic` already established it.
- **One emitter per construct.** Paragraphs and runs are emitted by `docxflow.ts`'s `paragraphXml`/`runXml` and nowhere else. `docxtextbox.ts` extends the vocabulary, never forks the emitter.
- **Errors** use `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `errors.ts`. Export entry points never throw — they degrade, as `renderDocumentToDocx` already does.
- **Prove assertions load-bearing.** For each task, break the code path the new test covers and confirm the suite goes red before committing. A green first run is not evidence.

---

### Task 1: `GlyphEvent.color` — fill-colour tracking in `text.ts`

`text.ts`'s `walkScope` threads the CTM and nothing else of the graphics state. Textbox mode needs the fill colour on each glyph. `paths.ts` already resolves colour operands; this task reuses `colorspace.ts` the same way rather than adding a second copy.

**Files:**
- Modify: `src/text.ts` — `GlyphEvent` (line ~204), `walkScope` (line ~309), `emitGlyphs`/`emitGlyphArray` (line ~460–505)
- Test: `test/glyph-color.test.ts` (create)

**Interfaces:**
- Consumes: `colorspace.ts`'s `Rgb`, `ColorConverter`, `deviceGray`, `cmykToRgb`, `resolveColorSpace` (no import cycle: `colorspace.ts` imports only `types.ts` and `pdffunction.ts`).
- Produces: `GlyphEvent.color?: Rgb` — RGB 0..255, **absent when the fill is black**. Task 2 groups on it.

- [ ] **Step 1: Write the failing test**

Create `test/glyph-color.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

function glyphs(stream: string): GlyphEvent[] {
  const doc = Document.Open(buildSimpleTextPdf(stream));
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => out.push(e) });
  return out;
}

describe('GlyphEvent.color', () => {
  it('omits the colour for the default black fill', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td (A) Tj ET');
    expect(g).toHaveLength(1);
    // Absent, not [0,0,0]: black is the PDF initial fill, so a key here would
    // appear on every glyph of every existing fixture.
    expect(g[0].color).toBeUndefined();
  });

  it('carries a DeviceRGB fill set by rg', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td (A) Tj 1 0 0 rg (B) Tj ET');
    expect(g[0].color).toBeUndefined();
    expect(g[1].color).toEqual([255, 0, 0]);
  });

  it('carries a DeviceGray fill set by g', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td 0.5 g (A) Tj ET');
    expect(g[0].color).toEqual([128, 128, 128]);
  });

  it('converts a DeviceCMYK fill set by k', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td 0 1 1 0 k (A) Tj ET');
    expect(g[0].color).toEqual([255, 0, 0]);
  });

  it('resolves a cs/scn fill through the colourspace', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td /DeviceRGB cs 0 1 0 scn (A) Tj ET');
    expect(g[0].color).toEqual([0, 255, 0]);
  });

  it('restores the fill colour at Q', () => {
    const g = glyphs(
      'q 0 0 1 rg BT /F1 12 Tf 20 100 Td (A) Tj ET Q'
      + ' BT /F1 12 Tf 20 80 Td (B) Tj ET',
    );
    expect(g[0].color).toEqual([0, 0, 255]);
    // Q pops the fill along with the CTM; without that the second run stays blue.
    expect(g[1].color).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/glyph-color.test.ts`
Expected: FAIL — every `color` assertion reports `undefined`, and TypeScript reports `color` does not exist on `GlyphEvent`.

- [ ] **Step 3: Add the field to `GlyphEvent`**

In `src/text.ts`, add to the import block at the top:

```ts
import {
  Rgb, ColorConverter, deviceGray, cmykToRgb, resolveColorSpace,
} from './colorspace.js';
```

Add to `GlyphEvent` (after `artifact?: boolean`):

```ts
  /** The fill colour in force when this glyph was shown, RGB 0..255.
   *
   *  Absent when the fill is black, which is the PDF initial value — the fence
   *  `bold`/`italic` already set on `TextFragment`. A key present on every glyph
   *  would move every fixture that compares an event.
   *
   *  Note this is deliberately NOT carried onto `TextFragment`:
   *  `fragmentsFromGlyphs` merges across show operators and colour is not part
   *  of that identity, so a fragment spanning a colour change could only report
   *  one of them. `docxgroup.ts` groups glyphs instead. */
  color?: Rgb;
```

- [ ] **Step 4: Track the fill colour in `walkScope`**

In `src/text.ts`, replace the CTM stack (line ~315) and its `q`/`Q` cases.

Add above `walkScope`:

```ts
/** The subset of the graphics state `visitContent` threads: the CTM plus the
 *  fill colour and the converter that resolves its operands. */
interface GState { ctm: Matrix; fill?: Rgb; conv: ColorConverter }

const cl255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Black is the PDF initial fill; report it as absence. */
const paint = (rgb: Rgb): Rgb | undefined =>
  rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0 ? undefined : rgb;
```

Widen `walkScope`'s signature to inherit the colour into Form XObjects, mirroring `inheritedMcid`:

```ts
function walkScope(
  ctx: Ctx, streams: { bytes: Uint8Array; streamIndex: number }[],
  resources: PdfDict | undefined, path: string[], baseCtm: Matrix,
  depth: number, seen: Set<PdfDict>,
  inheritedMcid?: number, inheritedArtifact = false,
  inheritedFill?: Rgb,
): void {
```

Replace `const ctmStack: Matrix[] = []; let curCtm = baseCtm;` with:

```ts
  const gsStack: GState[] = [];
  let curCtm = baseCtm;
  let fill: Rgb | undefined = inheritedFill;
  let fillConv: ColorConverter = deviceGray();
```

Replace the `q` / `Q` cases:

```ts
        case 'q': gsStack.push({ ctm: curCtm, fill, conv: fillConv }); break;
        case 'Q': {
          const g = gsStack.pop();
          if (g) { curCtm = g.ctm; fill = g.fill; fillConv = g.conv; }
          break;
        }
```

Add the fill operators beside the existing `case 'w':` (stroke colour is not tracked — see Step 6's note):

```ts
        case 'g': fill = paint([cl255(num(op.operands[0])), cl255(num(op.operands[0])),
                                cl255(num(op.operands[0]))]); break;
        case 'rg': {
          const n = nums(op.operands);
          fill = paint([cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)]);
          break;
        }
        case 'k': {
          const n = nums(op.operands);
          fill = paint(cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0));
          break;
        }
        case 'cs': {
          fillConv = lookupFillCs(ctx.doc, resources, op.operands[0]);
          fill = paint(fillConv.initial());
          break;
        }
        case 'sc': case 'scn': {
          const comps = nums(op.operands);
          // A trailing name means a pattern; there is no single colour to report,
          // so keep whatever the space's components give (black when there are none).
          fill = paint(comps.length ? fillConv.toRgb(comps) : [0, 0, 0]);
          break;
        }
```

And the colourspace lookup helper, beside the other module-private helpers:

```ts
/** Resolve a `cs` operand to its converter, looking a non-device name up in
 *  /Resources /ColorSpace. Mirrors `paths.ts`'s `lookupCs` — `colorspace.ts` is
 *  the one owner of "what colour is this operand". */
function lookupFillCs(
  doc: Document, resources: PdfDict | undefined, operand: PdfObject | undefined,
): ColorConverter {
  let csObj = operand;
  const DEVICE = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK']);
  if (isName(operand) && !DEVICE.has(operand.name)) {
    const csDict = resolveDict(doc, resources?.get('ColorSpace'));
    const found = csDict?.get(operand.name);
    if (found !== undefined) csObj = found;
  }
  if (csObj === undefined) return deviceGray();
  try {
    return resolveColorSpace(
      csObj as PdfObject,
      (o) => doc.resolve(o),
      (s) => inflateStream(s as Parameters<typeof inflateStream>[0]),
    );
  } catch {
    // A damaged colourspace costs a colour, not the page's text.
    return deviceGray();
  }
}
```

- [ ] **Step 5: Thread the colour onto the emitted glyph**

Add a `fill` parameter to `emitGlyphs` and `emitGlyphArray`, positioned after `ctm` exactly as `mcid`/`artifact` are threaded today:

```ts
function emitGlyphs(
  ctx: Ctx, st: TextState, strObj: PdfObject, ctm: Matrix, addr: ContentAddr,
  elementIndex: number, mcid?: number, artifact?: boolean, fill?: Rgb,
): void {
```

```ts
function emitGlyphArray(
  ctx: Ctx, st: TextState, arrObj: PdfObject, ctm: Matrix, addr: ContentAddr,
  mcid?: number, artifact?: boolean, fill?: Rgb,
): void {
```

Forward it from `emitGlyphArray`'s inner call (`emitGlyphs(ctx, st, el, ctm, addr, idx, mcid, artifact, fill)`), and set it on the event:

```ts
    ctx.visitor.glyph?.({
      addr, font: st.font, quad, text: g.text,
      fontSize: size, angle, elementIndex, byteStart: g.byteStart, byteLen: g.byteLen, advance, mcid,
      artifact: artifact || undefined,
      vertical: g.vertical ? true : undefined,
      color: fill,
    });
```

Pass `fill` at each `Tj` / `TJ` / `'` / `"` call site in `walkScope`, and pass it into the recursive `walkScope` call for a Form XObject `Do` as the new `inheritedFill` argument.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/glyph-color.test.ts`
Expected: PASS, all six.

Note deliberately not implemented: text render mode `Tr 1`/`5` (stroke-only) reports the fill colour. A stroke-outlined heading is rare and the miss is a shade rather than a disappearance; tracking the stroke colour would double the saved state for that one case. This is recorded in the spec and in Task 7's README limitation.

- [ ] **Step 7: Prove the new assertions load-bearing**

Break each path, confirm red, restore:
1. Delete the `case 'Q'` fill restore (`fill = g.fill`) → the `Q` test must fail.
2. Make `paint` return the rgb unconditionally → the "omits the colour for the default black fill" test must fail.
3. Delete `case 'k'` → the CMYK test must fail.

- [ ] **Step 8: Verify nothing shared moved**

Run: `npm test` and `npm run typecheck`
Expected: both green, with **no snapshot updated**. The whole suite staying still is the evidence that colour landed on `GlyphEvent` alone — `test/text-fragments.test.ts`, the untagged `docmodel` tests and the Markdown snapshots all ride `visitContent`.

- [ ] **Step 9: Commit**

```bash
git add src/text.ts test/glyph-color.test.ts
git commit -m "feat(text): carry the fill colour on GlyphEvent

Widen visitContent's q/Q stack from a bare CTM to a graphics-state record
and resolve g/rg/k/cs/sc/scn through colorspace.ts, as paths.ts already
does. Absent for black, so no existing fixture moves; TextFragment
deliberately gains nothing, since fragments merge across colour changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `docxgroup.ts` — the adaptive merge

The pure heuristic: which consecutive glyphs belong in one frame. Its own module so every threshold is testable from hand-built events with no PDF in sight, the way `test/docinfer.test.ts` drives `docinfer.ts`.

**Files:**
- Create: `src/docxgroup.ts`
- Test: `test/docx-group.test.ts` (create)

**Interfaces:**
- Consumes: `GlyphEvent` (Task 1, including `color`), `Rgb` from `colorspace.ts`.
- Produces:
  ```ts
  export interface TextGroup {
    quad: [number, number, number, number];
    fontSize: number;
    text: string;
    color?: Rgb;
    bold?: boolean;
    italic?: boolean;
    skewed?: boolean;
  }
  export interface GroupOptions { gapEm?: number; baselineTol?: number }
  export function groupGlyphs(glyphs: GlyphEvent[], opts?: GroupOptions): TextGroup[];
  ```
  Task 4 consumes `TextGroup[]`.

- [ ] **Step 1: Write the failing test**

Create `test/docx-group.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { GlyphEvent } from '../src/text.js';
import { groupGlyphs } from '../src/docxgroup.js';

/** A horizontal glyph at (x, baseline) of the given advance width. */
function g(
  text: string, x: number, baseline: number, size = 10,
  extra: Partial<GlyphEvent> = {},
): GlyphEvent {
  return {
    addr: { path: [], streamIndex: 0, opIndex: 0 },
    font: { bold: false, italic: false } as unknown as GlyphEvent['font'],
    quad: [x, baseline, x + size * 0.5, baseline + size],
    fontSize: size, angle: 0, text, elementIndex: 0,
    byteStart: 0, byteLen: 1, advance: 0.5,
    ...extra,
  };
}

/** Consecutive glyphs starting at x, each `size * 0.5` wide. */
function run(text: string, x: number, baseline: number, size = 10): GlyphEvent[] {
  return [...text].map((ch, i) => g(ch, x + i * size * 0.5, baseline, size));
}

describe('groupGlyphs', () => {
  it('merges a continuous run into one group', () => {
    const out = groupGlyphs(run('Hello', 20, 100));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Hello');
    expect(out[0].quad[0]).toBeCloseTo(20);
    expect(out[0].quad[2]).toBeCloseTo(45);
  });

  it('splits at a leader gap on the same baseline', () => {
    // "Introduction" at x=72, "3" at x=468 — a table-of-contents leader row.
    const out = groupGlyphs([...run('Introduction', 72, 700), ...run('3', 468, 700)]);
    expect(out.map((t) => t.text)).toEqual(['Introduction', '3']);
  });

  it('splits at a two-column gutter', () => {
    const out = groupGlyphs([...run('left', 50, 400), ...run('right', 320, 400)]);
    expect(out.map((t) => t.text)).toEqual(['left', 'right']);
  });

  it('splits at a colour change mid-run in one face at one size', () => {
    // The boundary must fall mid-run: a colour change coinciding with a font or
    // size change would be split by that instead, and the test would pass with
    // the colour rule removed.
    const glyphs = [
      ...run('see', 20, 100),
      ...run('here', 35, 100).map((e) => ({ ...e, color: [0, 0, 255] as [number, number, number] })),
    ];
    const out = groupGlyphs(glyphs);
    expect(out.map((t) => t.text)).toEqual(['see', 'here']);
    expect(out[0].color).toBeUndefined();
    expect(out[1].color).toEqual([0, 0, 255]);
  });

  it('splits at a font-size change', () => {
    const out = groupGlyphs([...run('big', 20, 100, 18), ...run('small', 47, 100, 8)]);
    expect(out.map((t) => t.text)).toEqual(['big', 'small']);
    expect(out[0].fontSize).toBe(18);
    expect(out[1].fontSize).toBe(8);
  });

  it('splits at a baseline change', () => {
    const out = groupGlyphs([...run('one', 20, 100), ...run('two', 20, 86)]);
    expect(out.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('keeps a kerned pair together despite a sub-tolerance baseline wobble', () => {
    const out = groupGlyphs([g('A', 20, 100), g('V', 25, 100.05)]);
    expect(out).toHaveLength(1);
  });

  it('marks a rotated run skewed', () => {
    const out = groupGlyphs(run('turn', 20, 100).map((e) => ({ ...e, angle: Math.PI / 2 })));
    expect(out[0].skewed).toBe(true);
  });

  it('marks a vertical run skewed', () => {
    const out = groupGlyphs(run('down', 20, 100).map((e) => ({ ...e, vertical: true as const })));
    expect(out[0].skewed).toBe(true);
  });

  it('returns [] for no glyphs', () => {
    expect(groupGlyphs([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docx-group.test.ts`
Expected: FAIL — `Cannot find module '../src/docxgroup.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/docxgroup.ts`:

```ts
// The adaptive merge behind DOCX textbox mode: which consecutive glyphs belong
// in one positioned frame. Pure — glyph events in, groups out — so every
// threshold is testable without building a PDF, the split docinfer.ts makes.
import type { GlyphEvent } from './text.js';
import type { Rgb } from './colorspace.js';

/** One frame's worth of text: the glyphs that share a baseline, a size, an
 *  emphasis and a colour, with no gap wide enough to be a layout decision. */
export interface TextGroup {
  /** Page-space axis box [x0,y0,x1,y1] covering every glyph in the group. */
  quad: [number, number, number, number];
  fontSize: number;
  text: string;
  /** Absent when black — the fence `GlyphEvent.color` sets. */
  color?: Rgb;
  bold?: boolean;
  italic?: boolean;
  /** True when any contributing glyph was rotated or vertically set. A frame
   *  has no rotation to give it, so `docxtextbox.ts` reads this only to place
   *  the group unrotated and to count it for the limitation. */
  skewed?: boolean;
}

export interface GroupOptions {
  /** Gap that starts a new group, as a multiple of the font size. Default 0.6.
   *
   *  Bounded from opposite sides by the two cases that matter: a leader row
   *  (`Introduction ....... 3`) must split, and an ordinary inter-word space
   *  must not. A space is ~0.25em in the Latin Standard-14 faces, and a
   *  deliberate layout gap is a whole em or more. */
  gapEm?: number;
  /** Baseline difference tolerated within one group, as a multiple of the font
   *  size. Default 0.02 — enough for floating-point residue and a kerned pair,
   *  far below a line's leading. */
  baselineTol?: number;
}

const DEFAULT_GAP_EM = 0.6;
const DEFAULT_BASELINE_TOL = 0.02;

const sameColor = (a: Rgb | undefined, b: Rgb | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** True when `e` continues the group whose last glyph is `prev`. */
function continues(prev: GlyphEvent, e: GlyphEvent, gapEm: number, tol: number): boolean {
  if (e.fontSize !== prev.fontSize) return false;
  if (!sameColor(e.color, prev.color)) return false;
  if (Math.abs(e.quad[1] - prev.quad[1]) > prev.fontSize * tol) return false;
  // The gap is measured from the previous glyph's right edge to this one's
  // left: negative (an overlap, from kerning or a backwards-painted marker) is
  // never a split.
  return e.quad[0] - prev.quad[2] <= prev.fontSize * gapEm;
}

/** Group consecutive glyphs into positioned frames. */
export function groupGlyphs(glyphs: GlyphEvent[], opts: GroupOptions = {}): TextGroup[] {
  const gapEm = opts.gapEm ?? DEFAULT_GAP_EM;
  const tol = opts.baselineTol ?? DEFAULT_BASELINE_TOL;
  const out: TextGroup[] = [];
  let cur: TextGroup | undefined;
  let prev: GlyphEvent | undefined;

  for (const e of glyphs) {
    const skewed = (e.angle !== undefined && Math.abs(e.angle) > 1e-6) || e.vertical === true;
    if (!cur || !prev || !continues(prev, e, gapEm, tol)) {
      cur = {
        quad: [...e.quad] as [number, number, number, number],
        fontSize: e.fontSize,
        text: e.text,
        ...(e.color ? { color: e.color } : {}),
        ...(e.font?.bold ? { bold: true } : {}),
        ...(e.font?.italic ? { italic: true } : {}),
        ...(skewed ? { skewed: true } : {}),
      };
      out.push(cur);
    } else {
      cur.text += e.text;
      cur.quad[0] = Math.min(cur.quad[0], e.quad[0]);
      cur.quad[1] = Math.min(cur.quad[1], e.quad[1]);
      cur.quad[2] = Math.max(cur.quad[2], e.quad[2]);
      cur.quad[3] = Math.max(cur.quad[3], e.quad[3]);
      if (skewed) cur.skewed = true;
    }
    prev = e;
  }
  return out;
}
```

Note `e.font?.bold` / `e.font?.italic` — `TextFont` declares both as `readonly bold: boolean` / `readonly italic: boolean` (`src/font.ts:241-242`), assigned at construction from `fontStyleOf`, the single owner of that question. Read them; do not re-derive.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/docx-group.test.ts`
Expected: PASS, all ten.

- [ ] **Step 5: Prove the assertions load-bearing**

Break each rule, confirm red, restore:
1. Delete the colour comparison from `continues` → the colour test must fail *and* the leader/gutter tests must stay green (they carry no colour), which is what shows the colour rule is pinned on its own.
2. Raise `DEFAULT_GAP_EM` to 100 → the leader and gutter tests must fail; the single-run test must stay green.
3. Delete the baseline comparison → the baseline test must fail; the kerned-pair test must stay green.

Record the outcome of (2) in the commit message: a single-column fixture cannot pin the threshold, since every gap in one is below it whatever the value.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npx vitest run test/docx-group.test.ts
git add src/docxgroup.ts test/docx-group.test.ts
git commit -m "feat(docx): add the adaptive glyph merge behind textbox mode

groupGlyphs joins consecutive glyphs sharing a baseline, size, emphasis
and colour with no gap wide enough to be a layout decision. Pure, so the
leader-gap split and the two-column gutter are testable from hand-built
events with no PDF built.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `docxflow.ts` vocabulary + the flow byte-identity fence

`docxtextbox.ts` needs paragraphs carrying `w:framePr` and runs carrying a size and colour. `ParaProps`/`RunFmt` gain those as optional fields rather than a second emitter being written — `docxtable.ts` takes its paragraph builder as an argument for exactly this reason. The fence goes in *first*, so every later task is measured against it.

**Files:**
- Modify: `src/docxflow.ts:18-19` (`RunFmt`, `ParaProps`), `:55-68` (`runXml`, `paragraphXml`)
- Test: `test/docx-flow-identity.test.ts` (create), `test/docx-flow-frame.test.ts` (create)

**Interfaces:**
- Consumes: `Rgb` from `colorspace.ts`; `rgbHex` from `colorspace.ts` (strip the leading `#` — `w:color w:val` takes bare hex).
- Produces:
  ```ts
  export interface FrameProps {
    x: number; y: number; w: number; h: number;   // twips
  }
  export interface RunFmt {
    bold?: boolean; italic?: boolean; style?: string;
    size?: number;      // points; emitted as w:sz half-points
    color?: Rgb;
  }
  export interface ParaProps {
    style?: string; numId?: number; ilvl?: number; indent?: number;
    frame?: FrameProps;
  }
  ```
  Task 4 consumes all three.

- [ ] **Step 1: Write the byte-identity fence**

Create `test/docx-flow-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

describe('flow mode is byte-frozen', () => {
  it('produces identical bytes with no options and with mode: flow', () => {
    const doc = Document.Open(buildTaggedPdf());
    const bare = doc.ToDocx();
    const explicit = doc.ToDocx({ mode: 'flow' });
    expect(Buffer.from(explicit).equals(Buffer.from(bare))).toBe(true);
  });

  it('is reproducible across two renders of one document', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(Buffer.from(doc.ToDocx()).equals(Buffer.from(doc.ToDocx()))).toBe(true);
  });
});
```

The `mode: 'flow'` call does not typecheck until Task 5 adds `DocxOptions`. Write the file now and mark the first test `it.skip` with the comment `// unskip in Task 5, when ToDocx takes options`; the second runs today and pins reproducibility.

- [ ] **Step 2: Write the failing vocabulary test**

Create `test/docx-flow-frame.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { paragraphXml, runXml } from '../src/docxflow.js';

describe('docxflow vocabulary', () => {
  it('emits nothing new when the new fields are unset', () => {
    // The whole point of extending the vocabulary rather than forking the
    // emitter: every existing call site must produce the bytes it produces today.
    expect(runXml('hi')).toBe('<w:r><w:t xml:space="preserve">hi</w:t></w:r>');
    expect(paragraphXml('<w:r/>')).toBe('<w:p><w:r/></w:p>');
  });

  it('emits w:sz in half-points', () => {
    expect(runXml('hi', { size: 10.5 })).toContain('<w:sz w:val="21"/>');
    expect(runXml('hi', { size: 10.5 })).toContain('<w:szCs w:val="21"/>');
  });

  it('emits w:color as bare hex', () => {
    expect(runXml('hi', { color: [255, 0, 0] })).toContain('<w:color w:val="FF0000"/>');
  });

  it('emits w:framePr anchored to the page', () => {
    const xml = paragraphXml('<w:r/>', { frame: { x: 1440, y: 2160, w: 2880, h: 240 } });
    expect(xml).toContain(
      '<w:framePr w:w="2880" w:h="240" w:hRule="atLeast"'
      + ' w:x="1440" w:y="2160" w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>',
    );
  });

  it('puts w:framePr first inside w:pPr', () => {
    // w:pPr's children are schema-ordered; w:framePr precedes w:pStyle.
    const xml = paragraphXml('<w:r/>', { frame: { x: 0, y: 0, w: 100, h: 100 }, style: 'Quote' });
    expect(xml.indexOf('w:framePr')).toBeLessThan(xml.indexOf('w:pStyle'));
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run test/docx-flow-frame.test.ts test/docx-flow-identity.test.ts`
Expected: `docx-flow-frame` FAILs (unknown properties `size`, `color`, `frame`); `docx-flow-identity`'s reproducibility test PASSes and the other is skipped.

- [ ] **Step 4: Extend the vocabulary**

In `src/docxflow.ts`, add the import and replace the two interfaces and two emitters:

```ts
import { rgbHex, type Rgb } from './colorspace.js';
```

```ts
/** A positioned frame, in twips, anchored to the page. Textbox mode's only
 *  positioning construct — see `docxtextbox.ts`. */
export interface FrameProps { x: number; y: number; w: number; h: number }

export interface RunFmt {
  bold?: boolean; italic?: boolean; style?: string;
  /** Font size in points. Emitted as `w:sz`, which is in HALF-points. */
  size?: number;
  /** Text colour. Omitted for black, matching `GlyphEvent.color`'s fence. */
  color?: Rgb;
}
export interface ParaProps {
  style?: string; numId?: number; ilvl?: number; indent?: number;
  frame?: FrameProps;
}
```

```ts
export function runXml(text: string, fmt: RunFmt = {}): string {
  const props = (fmt.style ? `<w:rStyle w:val="${fmt.style}"/>` : '')
    + (fmt.bold ? '<w:b/>' : '') + (fmt.italic ? '<w:i/>' : '')
    + (fmt.color ? `<w:color w:val="${rgbHex(fmt.color).slice(1).toUpperCase()}"/>` : '')
    // w:sz is in half-points, and w:szCs states the same for complex scripts —
    // omitting it leaves a mixed-script run at Word's default size.
    + (fmt.size !== undefined
      ? `<w:sz w:val="${Math.round(fmt.size * 2)}"/><w:szCs w:val="${Math.round(fmt.size * 2)}"/>`
      : '');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${textXml(text)}</w:r>`;
}

export function paragraphXml(runs: string, props: ParaProps = {}): string {
  // **Invariant:** w:pPr's children are schema-ORDERED. w:framePr precedes
  // w:pStyle, which precedes w:numPr, which precedes w:ind. Wrong order is a
  // file Word refuses outright — the same class of rule as w:tcPr's children.
  const frame = props.frame
    ? `<w:framePr w:w="${props.frame.w}" w:h="${props.frame.h}" w:hRule="atLeast"`
      + ` w:x="${props.frame.x}" w:y="${props.frame.y}"`
      + ' w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>'
    : '';
  const numPr = props.numId !== undefined
    ? `<w:numPr><w:ilvl w:val="${props.ilvl ?? 0}"/><w:numId w:val="${props.numId}"/></w:numPr>`
    : '';
  const ind = props.indent ? `<w:ind w:left="${Math.round(props.indent)}"/>` : '';
  const pPr = frame + (props.style ? `<w:pStyle w:val="${props.style}"/>` : '') + numPr + ind;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}
```

`rgbHex` returns `'#rrggbb'` in lowercase (`src/colorspace.ts:25-26`), so `.slice(1).toUpperCase()` is the conversion to `w:color`'s bare-hex value. Should a future change make it return bare hex, this breaks silently — the `w:color` test above is what catches it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/docx-flow-frame.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Prove the "emits nothing new" assertion load-bearing**

Make `w:sz` unconditional (`fmt.size ?? 11`) → the first test and every existing `test/docx-flow*.test.ts` assertion over run XML must go red. Restore.

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/docxflow.ts test/docx-flow-frame.test.ts test/docx-flow-identity.test.ts
git commit -m "feat(docx): add frame, size and colour vocabulary to the emitters

ParaProps gains an optional frame and RunFmt an optional size and colour,
so textbox mode positions through the ONE paragraph and run emitter
rather than forking them. Unset, every existing call site emits the bytes
it emits today, which the new identity fence pins.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `docxtextbox.ts` — geometry, frames and per-page sections

The mapper: positioned groups in, `w:body` inner XML out. Pure — it names an image by a `rid` a sink already handed it and touches no `Document`.

**Files:**
- Create: `src/docxtextbox.ts`
- Test: `test/docx-textbox.test.ts` (create)

**Interfaces:**
- Consumes: `TextGroup` (Task 2); `paragraphXml`, `runXml`, `drawingXml`, `FrameProps` (Task 3 — `drawingXml` is currently module-private in `docxflow.ts` and must be **exported** in this task); `TWIPS_PER_PT` from `docxstyles.ts`.
- Produces:
  ```ts
  export interface ImagePlacement {
    rid: string;
    quad: [number, number, number, number];   // page space
    alt?: string;
  }
  export interface TextboxPage {
    /** Page-space sizing box [x0,y0,x1,y1] — CropBox, or MediaBox under box:'media'. */
    box: [number, number, number, number];
    groups: TextGroup[];
    images: ImagePlacement[];
    /** Full-page backdrop, emitted first so text stacks above it. */
    backdrop?: { rid: string };
  }
  export function docxTextboxBody(pages: TextboxPage[]): string;
  ```
  Task 5 consumes `docxTextboxBody`; Task 6 fills `images` and `backdrop`.

- [ ] **Step 1: Write the failing test**

Create `test/docx-textbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxTextboxBody, type TextboxPage } from '../src/docxtextbox.js';
import type { TextGroup } from '../src/docxgroup.js';

const A4: [number, number, number, number] = [0, 0, 595.28, 841.89];

function group(text: string, x: number, baseline: number, size = 10): TextGroup {
  return { quad: [x, baseline, x + text.length * size * 0.5, baseline + size], fontSize: size, text };
}

const page = (p: Partial<TextboxPage> = {}): TextboxPage =>
  ({ box: A4, groups: [], images: [], ...p });

describe('docxTextboxBody', () => {
  it('places a group at its quad, in twips from the page top-left', () => {
    // A 10pt group whose baseline sits at y=741.89 has quad top 751.89, so it
    // is 90pt below the page top: 90 * 20 = 1800 twips. x = 72pt = 1440 twips.
    const xml = docxTextboxBody([page({ groups: [group('Hello', 72, 741.89)] })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).toContain('w:y="1800"');
  });

  it('measures against the sizing box origin, not the page', () => {
    // A CropBox offset by (20, 30): a group at x=92 is 72pt from the box's left
    // edge, and its top is measured down from the box's own top.
    const xml = docxTextboxBody([page({
      box: [20, 30, 615.28, 871.89], groups: [group('Hello', 92, 771.89)],
    })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).toContain('w:y="1800"');
  });

  it('errs wide on the frame width and never past the box edge', () => {
    // A group 25pt wide at x=72: 25 * 1.25 + 2 = 33.25pt = 665 twips.
    const xml = docxTextboxBody([page({ groups: [group('Hello', 72, 700)] })]);
    expect(xml).toContain('w:w="665"');
    // A group starting 10pt from the right edge cannot claim more than 10pt.
    const clamped = docxTextboxBody([page({ groups: [group('Hello', 585.28, 700)] })]);
    expect(clamped).toContain('w:w="200"');
  });

  it('emits the run size and colour', () => {
    const g: TextGroup = { ...group('Hi', 72, 700, 14), color: [255, 0, 0], bold: true };
    const xml = docxTextboxBody([page({ groups: [g] })]);
    expect(xml).toContain('<w:sz w:val="28"/>');
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain('<w:b/>');
  });

  it('places a skewed group unrotated at its quad top-left', () => {
    const g: TextGroup = { ...group('turn', 72, 700), skewed: true };
    const xml = docxTextboxBody([page({ groups: [g] })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).not.toContain('rot=');
  });

  it('states each page size in its own section', () => {
    const xml = docxTextboxBody([
      page({ box: [0, 0, 595.28, 841.89] }),
      page({ box: [0, 0, 612, 792] }),
    ]);
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');   // A4
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');   // Letter
  });

  it('puts a non-final sectPr inside a paragraph and the final one in the body', () => {
    const xml = docxTextboxBody([page(), page()]);
    // The first section's break rides its last paragraph's w:pPr.
    expect(xml).toContain('<w:p><w:pPr><w:sectPr>');
    // The last section's is a direct child of w:body — it closes the string.
    expect(xml.trimEnd().endsWith('</w:sectPr>')).toBe(true);
  });

  it('emits one unframed anchor paragraph per page', () => {
    // A framed paragraph is lifted out of the flow, so a page of nothing but
    // frames has no flow content and its section collapses into the next.
    const xml = docxTextboxBody([page({ groups: [group('Hi', 72, 700)] })]);
    const framed = (xml.match(/w:framePr/g) ?? []).length;
    const paras = (xml.match(/<w:p>/g) ?? []).length;
    expect(framed).toBe(1);
    expect(paras).toBe(2);
  });

  it('emits the backdrop before any text frame', () => {
    const xml = docxTextboxBody([page({
      groups: [group('Hi', 72, 700)], backdrop: { rid: 'rId9' },
    })]);
    expect(xml.indexOf('rId9')).toBeLessThan(xml.indexOf('Hi'));
  });

  it('places an image at its quad', () => {
    const xml = docxTextboxBody([page({
      images: [{ rid: 'rId5', quad: [72, 600, 172, 700], alt: 'a chart' }],
    })]);
    expect(xml).toContain('rId5');
    expect(xml).toContain('descr="a chart"');
    expect(xml).toContain('w:x="1440"');
  });

  it('returns a body with a sectPr for a document with no content', () => {
    const xml = docxTextboxBody([page()]);
    expect(xml).toContain('<w:sectPr>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docx-textbox.test.ts`
Expected: FAIL — `Cannot find module '../src/docxtextbox.js'`.

- [ ] **Step 3: Export `drawingXml` from `docxflow.ts`**

In `src/docxflow.ts`, change `function drawingXml(` to `export function drawingXml(`. Its doc comment already states the `wp:docPr@id` uniqueness invariant; add one line recording the second consumer:

```
 *  Shared with `docxtextbox.ts`, which wraps it in a frame rather than placing
 *  it inline. The `id` must stay unique across the WHOLE document, so both
 *  callers draw from one counter.
```

- [ ] **Step 4: Write the implementation**

Create `src/docxtextbox.ts`:

```ts
// DOCX textbox mode: positioned groups and image placements to the inner XML of
// <w:body>. Pure — it names an image by a rid a sink already handed it and
// touches no Document, the split svgdraw.ts/svgembed.ts already make.
import { paragraphXml, runXml, drawingXml, type FrameProps } from './docxflow.js';
import { TWIPS_PER_PT } from './docxstyles.js';
import type { TextGroup } from './docxgroup.js';

/** An image the package has already registered, and where the page drew it. */
export interface ImagePlacement {
  rid: string;
  /** Page-space axis box [x0,y0,x1,y1] of the drawn image. */
  quad: [number, number, number, number];
  alt?: string;
}

export interface TextboxPage {
  /** Page-space sizing box [x0,y0,x1,y1] — CropBox, or MediaBox under box:'media'. */
  box: [number, number, number, number];
  groups: TextGroup[];
  images: ImagePlacement[];
  /** Full-page backdrop image, emitted first so text stacks above it. */
  backdrop?: { rid: string };
}

/** A frame errs wide, never narrow: Word re-measures with a substituted face,
 *  and a frame narrower than the result wraps to a second line. `w:wrap="none"`
 *  means an over-wide frame displaces nothing, so the two errors are not
 *  symmetric. Starting points, tuned against fixtures. */
const WIDTH_HEADROOM = 1.25;
const PAD_PT = 2;

const tw = (pt: number): number => Math.round(pt * TWIPS_PER_PT);

/** A page-space quad as a page-anchored frame, in twips.
 *
 *  **Invariant:** the frame's top comes from `quad[3]`, not from a font ascent.
 *  A group's quad runs `baseline .. baseline + fontSize`, so its top edge is
 *  already where Word starts the line box. `htmlfixed.ts` subtracts
 *  `ascent * dev` because a CSS `top` is the em-box top and it knows the
 *  substituted face's ascent; inventing one for a face we did not choose would
 *  be a guess with nothing behind it. */
function frameFor(
  quad: [number, number, number, number], box: [number, number, number, number],
  headroom: number, pad: number,
): FrameProps {
  const x = quad[0] - box[0];
  const y = box[3] - quad[3];
  const avail = Math.max(0, (box[2] - box[0]) - x);
  const w = Math.min(Math.max(0, quad[2] - quad[0]) * headroom + pad, avail);
  return { x: tw(x), y: tw(y), w: tw(w), h: tw(Math.max(0, quad[3] - quad[1])) };
}

/** `w:sectPr` for one page, stated in that page's own size.
 *
 *  **Invariant:** zero margins. Frames anchor to the page edge regardless, but
 *  the unframed anchor paragraph does not — a default 1" margin would push it
 *  and, on a short page, create a page of its own. */
function sectPr(box: [number, number, number, number]): string {
  const w = tw(box[2] - box[0]);
  const h = tw(box[3] - box[1]);
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/>`
    + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"'
    + ' w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
}

/** Every frame paragraph for one page, backdrop first. */
function pageFrames(p: TextboxPage, nextDrawingId: () => number): string[] {
  const out: string[] = [];
  const full: [number, number, number, number] = p.box;

  if (p.backdrop) {
    // The backdrop is emitted FIRST: frames stack in document order, so a
    // backdrop after the text hides the page.
    const f = frameFor(full, p.box, 1, 0);
    const wPt = p.box[2] - p.box[0];
    const hPt = p.box[3] - p.box[1];
    out.push(paragraphXml(
      `<w:r>${drawingXml(p.backdrop.rid, wPt, hPt, '', nextDrawingId())}</w:r>`,
      { frame: f },
    ));
  }

  for (const img of p.images) {
    const f = frameFor(img.quad, p.box, 1, 0);
    const wPt = Math.max(1e-3, img.quad[2] - img.quad[0]);
    const hPt = Math.max(1e-3, img.quad[3] - img.quad[1]);
    out.push(paragraphXml(
      `<w:r>${drawingXml(img.rid, wPt, hPt, img.alt ?? '', nextDrawingId())}</w:r>`,
      { frame: f },
    ));
  }

  for (const g of p.groups) {
    if (!g.text) continue;
    // A skewed group is placed unrotated at its quad's top-left: a frame has no
    // rotation, and visible ink beats silently dropped content.
    const f = frameFor(g.quad, p.box, WIDTH_HEADROOM, PAD_PT);
    out.push(paragraphXml(runXml(g.text, {
      size: g.fontSize,
      ...(g.color ? { color: g.color } : {}),
      ...(g.bold ? { bold: true } : {}),
      ...(g.italic ? { italic: true } : {}),
    }), { frame: f }));
  }
  return out;
}

/** Map positioned pages to the inner XML of `<w:body>`.
 *
 *  **Invariant:** a non-final section's `w:sectPr` lives inside the LAST
 *  paragraph's `w:pPr`; only the final section's is a direct child of
 *  `w:body`. The two spellings are not interchangeable and the wrong one is a
 *  file Word refuses — the same class of rule as `w:tcPr`'s ordered children.
 *
 *  **Invariant:** every page emits one ordinary, unframed paragraph. A framed
 *  paragraph is lifted out of the flow, so a page of nothing but frames has no
 *  flow content and its section collapses into the next. */
export function docxTextboxBody(pages: TextboxPage[]): string {
  let drawingId = 0;
  const nextDrawingId = (): number => ++drawingId;
  const out: string[] = [];

  pages.forEach((p, i) => {
    out.push(...pageFrames(p, nextDrawingId));
    const last = i === pages.length - 1;
    if (last) {
      out.push(paragraphXml(''));          // the anchor paragraph
      out.push(sectPr(p.box));             // final section: a direct body child
    } else {
      // The anchor paragraph doubles as the section-break carrier.
      out.push(`<w:p><w:pPr>${sectPr(p.box)}</w:pPr></w:p>`);
    }
  });
  return out.join('');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/docx-textbox.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 6: Prove the assertions load-bearing**

Break each, confirm red, restore:
1. Change `frameFor`'s `y` to `box[3] - quad[1]` (the baseline instead of the top) → both geometry tests must fail.
2. Drop the `avail` clamp → the "never past the box edge" assertion must fail.
3. Emit the final `sectPr` inside a paragraph too → the sectPr-placement test must fail.
4. Remove the anchor paragraph from the last-page branch → the anchor-paragraph count test must fail.
5. Move the backdrop emit after the text loop → the ordering test must fail.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/docxtextbox.ts src/docxflow.ts test/docx-textbox.test.ts
git commit -m "feat(docx): map positioned groups to page-anchored text frames

docxTextboxBody places each group at its quad as a w:framePr paragraph,
one section per page carrying that page's own size. Frames err wide
because Word re-measures with a substituted face and w:wrap='none' makes
an over-wide frame free; a non-final sectPr rides its last paragraph.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `DocxOptions` and the `docxexport.ts` mode switch (text only)

Wire textbox mode end to end for text. Images and the backdrop follow in Task 6, so this task's deliverable is a `.docx` whose text is positioned and whose pictures are absent.

**Files:**
- Modify: `src/docxexport.ts` (whole `render`), `src/document.ts:968`, `src/page.ts:559`, `src/node.ts:67`, `src/index.ts`
- Test: `test/docx-textbox-export.test.ts` (create); unskip `test/docx-flow-identity.test.ts`

**Interfaces:**
- Consumes: `docxTextboxBody`, `TextboxPage` (Task 4); `groupGlyphs` (Task 2); `visitContent`, `GlyphEvent` from `text.js`.
- Produces:
  ```ts
  export interface DocxOptions {
    mode?: 'flow' | 'textbox';
    background?: 'none' | 'raster';
    box?: 'crop' | 'media';
  }
  export function renderDocumentToDocx(doc: Document, opts?: DocxOptions): Uint8Array;
  export function renderPageToDocx(doc: Document, page: Page, opts?: DocxOptions): Uint8Array;
  ```
  `DocxOptions` is exported from `index.ts`. Task 6 reads `background` and `box`.

- [ ] **Step 1: Write the failing test**

Create `test/docx-textbox-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

const docFor = (stream: string) => Document.Open(buildSimpleTextPdf(stream));

function documentXml(bytes: Uint8Array): string {
  return textOf(unzip(bytes), 'word/document.xml');
}

describe('ToDocx({ mode: "textbox" })', () => {
  it('positions text in page-anchored frames', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    const xml = documentXml(doc.ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('w:framePr');
    expect(xml).toContain('w:hAnchor="page"');
    expect(xml).toContain('Hello');
  });

  it('states the page size from the sizing box', () => {
    // build-text-pdf's MediaBox is 300x300 points -> 6000x6000 twips.
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    const xml = documentXml(doc.ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('<w:pgSz w:w="6000" w:h="6000"/>');
  });

  it('carries the fill colour end to end', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td 1 0 0 rg (Red) Tj ET');
    const xml = documentXml(doc.ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('<w:color w:val="FF0000"/>');
  });

  it('emits no w:framePr in flow mode', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    expect(documentXml(doc.ToDocx())).not.toContain('w:framePr');
  });

  it('renders one page through Page.ToDocx', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    const xml = documentXml(doc.Pages[0].ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('w:framePr');
  });

  it('never throws on a page with no text', () => {
    const doc = docFor('');
    expect(() => doc.ToDocx({ mode: 'textbox' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docx-textbox-export.test.ts`
Expected: FAIL — `ToDocx` takes no arguments.

- [ ] **Step 3: Add `DocxOptions` and the branch to `docxexport.ts`**

In `src/docxexport.ts`, add the imports and the option type:

```ts
import { visitContent, type GlyphEvent } from './text.js';
import { groupGlyphs } from './docxgroup.js';
import { docxTextboxBody, type TextboxPage, type ImagePlacement } from './docxtextbox.js';
```

```ts
/** Options for {@link Document.ToDocx} and {@link Page.ToDocx}.
 *
 *  Mirrors `HtmlOptions` deliberately: a caller who knows
 *  `ToHtml({ mode: 'fixed' })` should not have to learn a second idiom. */
export interface DocxOptions {
  /** Reflowable, or positioned page reproduction. Default 'flow'. */
  mode?: 'flow' | 'textbox';
  /** Page backdrop in 'textbox' mode. Default 'none'. */
  background?: 'none' | 'raster';
  /** Which page box sizes the page. Default 'crop'. 'textbox' mode only. */
  box?: 'crop' | 'media';
}
```

Add the page-collection function, above `render`:

```ts
/** Collect one page's positioned content. One `visitContent` pass: the visitor
 *  carries both hooks, so text and images arrive together, in content order. */
function collectPage(doc: Document, page: Page, opts: DocxOptions): TextboxPage {
  const box = (opts.box === 'media' ? page.MediaBox : page.CropBox)
    ?? [0, 0, 595.28, 841.89];
  const glyphs: GlyphEvent[] = [];
  const images: ImagePlacement[] = [];
  try {
    visitContent(doc, page, { glyph: (e) => glyphs.push(e) });
  } catch {
    // Degrade: whatever was collected before the failure still positions.
  }
  return { box: box as [number, number, number, number], groups: groupGlyphs(glyphs), images };
}
```

Rename the existing `render` to `renderFlow` (body unchanged), and add:

```ts
function renderTextbox(doc: Document, pages: Page[], opts: DocxOptions): Uint8Array {
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [];
  let nextRel = 2;
  const relId = (): string => `rId${nextRel++}`;
  void parts; void rels; void relId;      // Task 6 fills these

  let xml = '';
  try {
    xml = docxTextboxBody(pages.map((p) => collectPage(doc, p, opts)));
  } catch {
    // Degrade, matching renderFlow and renderPageToSvg.
  }
  return writeDocx(xml, { parts, rels });
}

function render(doc: Document, pages: Page[], opts: DocxOptions): Uint8Array {
  return (opts.mode ?? 'flow') === 'textbox'
    ? renderTextbox(doc, pages, opts)
    : renderFlow(doc, pages);
}
```

Widen the two entry points:

```ts
export function renderDocumentToDocx(doc: Document, opts: DocxOptions = {}): Uint8Array {
  return render(doc, doc.Pages, opts);
}

export function renderPageToDocx(doc: Document, page: Page, opts: DocxOptions = {}): Uint8Array {
  return render(doc, [page], opts);
}
```

Note textbox mode emits no `styles.xml` and no `numbering.xml`: it names no style id and allocates no list, and a part defining styles nobody uses is the same nothing as a relationships part with no relationships — the rule `docxpackage.ts` already states.

- [ ] **Step 4: Widen the public entry points**

`src/document.ts:968` — take the bag and extend the doc comment:

```ts
  /** Render every page to a `.docx` (Office Open XML).
   *
   *  `mode: 'flow'` (the default) reconstructs the document from the tagged
   *  structure tree when there is one and from font-size heuristics when there
   *  is not — the same model `ToHtml` and `ToMarkdown` read — and reflows it,
   *  with pages concatenated and no page break between them.
   *
   *  `mode: 'textbox'` reproduces each page's own geometry instead: every run
   *  of text becomes a page-anchored frame at its PDF position, one section per
   *  page carrying that page's size. Emphasis and colour are read from the
   *  page; rotated and vertical runs are placed unrotated, and vector ink
   *  reaches the output only under `background: 'raster'`.
   *
   *  Images travel inside the package either way, so there is no assets
   *  variant to call. Never throws. */
  ToDocx(options?: DocxOptions): Uint8Array {
    return renderDocumentToDocx(this, options);
  }
```

`src/page.ts:559`:

```ts
  /** Render this page to a `.docx`. See `Document.ToDocx`. */
  ToDocx(options?: DocxOptions): Uint8Array {
    return renderPageToDocx(this.doc, this, options);
  }
```

`src/node.ts:67` — pass the bag through:

```ts
export async function saveDocxFile(
  inputPath: string, outPath: string, options?: DocxOptions,
): Promise<void> {
  const input = await readFile(inputPath);
  await writeFile(outPath, Document.Open(input).ToDocx(options));
}
```

`src/index.ts` — export the type beside the other option bags:

```ts
export type { DocxOptions } from './docxexport.js';
```

Add the matching `import type { DocxOptions } from './docxexport.js';` to `document.ts`, `page.ts` and `node.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/docx-textbox-export.test.ts`
Expected: PASS, all six.

- [ ] **Step 6: Unskip the byte-identity fence**

In `test/docx-flow-identity.test.ts`, remove the `.skip` and the "unskip in Task 5" comment.

Run: `npx vitest run test/docx-flow-identity.test.ts`
Expected: PASS — `doc.ToDocx()` and `doc.ToDocx({ mode: 'flow' })` are byte-identical.

- [ ] **Step 7: Prove the branch load-bearing**

Change the default in `render` to `'textbox'` → the identity fence and "emits no w:framePr in flow mode" must both go red, and several `test/docx-flow*.test.ts` cases with them. Restore.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/docxexport.ts src/document.ts src/page.ts src/node.ts src/index.ts \
        test/docx-textbox-export.test.ts test/docx-flow-identity.test.ts
git commit -m "feat(docx): add DocxOptions and the textbox mode switch

ToDocx takes a DocxOptions bag mirroring HtmlOptions; docxexport.ts
branches once between the flow body producer and the textbox one, and
collects each page's glyphs in a single visitContent pass. Flow mode's
bytes are unchanged, which the now-unskipped identity fence pins.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Images and the raster backdrop

Textbox mode's pictures. The image sink `renderFlow` already owns — hash-of-encoded-bytes identity, `store: true` media parts — is lifted so both modes share it, and `background: 'raster'` registers a page render through the same sink.

**Files:**
- Modify: `src/docxexport.ts` (extract the sink, fill `renderTextbox`'s parts/rels, collect images, add the backdrop)
- Test: `test/docx-textbox-media.test.ts` (create)

**Interfaces:**
- Consumes: `ImagePlacement`, `TextboxPage.backdrop` (Task 4); `ImageEvent` from `text.js`; `page.ToImage` from `raster.js`; `encodeImage`/`imageExtension` from `imagehref.js`.
- Produces: nothing new. `renderTextbox` fills the `parts`/`rels` it stubbed in Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/docx-textbox-media.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPlacedImagePdf } from './helpers/build-image-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

/** A 2x2 DeviceRGB image drawn twice on one 100x100 page — at (10,10) 20pt
 *  square and at (60,60) 30pt square. Two draws of ONE image is what makes the
 *  dedup rule observable. */
function twoDraws(): Uint8Array {
  return buildPlacedImagePdf({
    width: 2, height: 2,
    samples: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    placements: ['20 0 0 20 10 10', '30 0 0 30 60 60'],
  });
}

const media = (bytes: Uint8Array) =>
  unzip(bytes).filter((e) => e.path.startsWith('word/media/'));

describe('textbox mode media', () => {
  it('places each drawn image in a frame', () => {
    const xml = textOf(unzip(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' })),
                       'word/document.xml');
    expect(xml).toContain('w:framePr');
    expect(xml).toContain('<w:drawing>');
    // Two placements -> two drawings, and their wp:docPr ids must differ.
    expect((xml.match(/<w:drawing>/g) ?? [])).toHaveLength(2);
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers ONE media part for two draws of one image', () => {
    // Identity is the hash of the ENCODED BYTES, not the PdfStream object.
    expect(media(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }))).toHaveLength(1);
  });

  it('positions the two draws differently', () => {
    const xml = textOf(unzip(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' })),
                       'word/document.xml');
    // (10,10) 20pt square on a 100pt page: x = 200 twips, top = 100-30 = 70pt
    // -> 1400 twips. (60,60) 30pt square: x = 1200, top = 100-90 = 10pt -> 200.
    expect(xml).toContain('w:x="200"');
    expect(xml).toContain('w:y="1400"');
    expect(xml).toContain('w:x="1200"');
    expect(xml).toContain('w:y="200"');
  });

  it('emits no backdrop by default and one under background: raster', () => {
    const doc = Document.Open(twoDraws());
    expect(media(doc.ToDocx({ mode: 'textbox' }))).toHaveLength(1);
    expect(media(doc.ToDocx({ mode: 'textbox', background: 'raster' }))).toHaveLength(2);
  });

  it('stores media uncompressed', () => {
    // encodeImage returns JPEG or PNG, both already compressed: deflating costs
    // time and usually grows them.
    expect(media(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }))[0].method)
      .toBe('store');
  });

  it('never throws under background: raster', () => {
    const doc = Document.Open(twoDraws());
    expect(() => doc.ToDocx({ mode: 'textbox', background: 'raster' })).not.toThrow();
  });
});
```

`UnzippedEntry.method` is `'store' | 'deflate'` (a label, not a ZIP method number) — asserted as `'store'` above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docx-textbox-media.test.ts`
Expected: FAIL — no media parts, since `renderTextbox` stubs its parts and rels.

- [ ] **Step 3: Extract the shared image sink**

In `src/docxexport.ts`, lift the sink out of `renderFlow` into a factory both modes call. Keep every rule its doc comments already record — hash-of-encoded-bytes identity, `store: true`, targets relative to the source part:

```ts
/** The package's image registry: encodes, dedupes by encoded bytes, allocates
 *  the media part and the relationship. Shared by both modes so they cannot
 *  disagree about what an image is or how many copies a package carries. */
function imageRegistry(doc: Document, parts: OoxmlPart[], rels: OoxmlRelationship[],
                       relId: () => string) {
  const seen = new Map<string, DocxImage>();
  const addBytes = (bytes: Uint8Array, mediaType: string): DocxImage => {
    const key = createHash('sha256').update(bytes).digest('hex');
    const hit = seen.get(key);
    if (hit) return hit;
    const path = `word/media/image${seen.size + 1}.${imageExtension(mediaType)}`;
    parts.push({ path, bytes, contentType: mediaType, store: true });
    const id = relId();
    rels.push({
      source: 'word/document.xml', id, type: `${REL_BASE}/image`,
      target: path.slice('word/'.length),
    });
    const img: DocxImage = { rid: id, pxWidth: 0, pxHeight: 0 };
    seen.set(key, img);
    return img;
  };
  return {
    addBytes,
    add(stream: PdfStream): DocxImage | undefined {
      const enc = encodeImage(doc, stream, [0, 0, 0]);
      if (!enc) return undefined;
      const img = addBytes(enc.bytes, enc.mediaType);
      if (!img.pxWidth) {
        const info = new ImageInfo(doc, '', stream);
        img.pxWidth = info.Width || 0;
        img.pxHeight = info.Height || 0;
      }
      return img;
    },
  };
}
```

`renderFlow` now takes `images` from this factory; its behaviour and therefore its bytes are unchanged, which the Task 3 fence proves.

- [ ] **Step 4: Collect image placements and the backdrop**

Widen `collectPage` to take the registry and fill `images`:

```ts
function collectPage(
  doc: Document, page: Page, opts: DocxOptions,
  images: ReturnType<typeof imageRegistry>,
): TextboxPage {
  const box = (opts.box === 'media' ? page.MediaBox : page.CropBox)
    ?? [0, 0, 595.28, 841.89];
  const glyphs: GlyphEvent[] = [];
  const placed: ImagePlacement[] = [];
  try {
    visitContent(doc, page, {
      glyph: (e) => glyphs.push(e),
      image: (e) => {
        // An inline image's samples live in the content op and in no object,
        // so there is nothing to register — it reaches the output only under
        // background: 'raster'.
        if (!e.stream) return;
        const img = images.add(e.stream);
        if (img) placed.push({ rid: img.rid, quad: e.quad });
      },
    });
  } catch {
    // Degrade: whatever was collected before the failure still positions.
  }

  let backdrop: { rid: string } | undefined;
  if (opts.background === 'raster') {
    try {
      const png = page.ToImage({ box: opts.box ?? 'crop' });
      backdrop = { rid: images.addBytes(png, 'image/png').rid };
    } catch {
      // A page we cannot rasterize keeps its text frames and loses its backdrop.
    }
  }

  return {
    box: box as [number, number, number, number],
    groups: groupGlyphs(glyphs), images: placed,
    ...(backdrop ? { backdrop } : {}),
  };
}
```

And fill `renderTextbox`'s stubs, dropping the `void` lines:

```ts
function renderTextbox(doc: Document, pages: Page[], opts: DocxOptions): Uint8Array {
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [];
  let nextRel = 2;
  const relId = (): string => `rId${nextRel++}`;
  const images = imageRegistry(doc, parts, rels, relId);

  let xml = '';
  try {
    xml = docxTextboxBody(pages.map((p) => collectPage(doc, p, opts, images)));
  } catch {
    // Degrade, matching renderFlow and renderPageToSvg.
  }
  return writeDocx(xml, { parts, rels });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/docx-textbox-media.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Prove the assertions load-bearing**

1. Key the dedupe map on the `PdfStream` object instead of the byte hash → the one-part test must fail on a document drawing one image twice. If the fixture draws it once, extend the fixture rather than weakening the test.
2. Drop `store: true` → the uncompressed test must fail.
3. Make the backdrop unconditional → the "no backdrop by default" test must fail.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/docxexport.ts test/docx-textbox-media.test.ts
git commit -m "feat(docx): place images and the optional raster backdrop

Lift the image registry out of the flow renderer so both modes share one
answer about what an image is and how many copies a package carries, and
place each drawn image in a frame at its quad. background: 'raster'
registers a page render as a full-page backdrop, emitted first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation and issue close

The feature is complete; this task records it where the next reader will look, and states the limitations rather than leaving them to be discovered.

**Files:**
- Modify: `README.md:75` (quick start), `:1895` (API overview row), `:2056` (the "DOCX export is flow mode" limitation)
- Modify: `CLAUDE.md` (the DOCX module block, and the `text.ts` entry)

- [ ] **Step 1: Update the README API overview row**

Replace the `doc.ToDocx()` row at `README.md:1895` with one naming both modes and the option bag: `mode: 'flow'` (default) exporting `Heading1`–`Heading6`, styled runs, lists, hyperlinks, images and tables over the same model `ToHtml`/`ToMarkdown` read; `mode: 'textbox'` reproducing each page's geometry as page-anchored frames, one section per page, with `background: 'raster'` and `box: 'crop' | 'media'`. Keep the note that images travel inside the package, so there is no assets variant.

- [ ] **Step 2: Rewrite the flow-mode limitation**

`README.md:2056` currently reads "Reproducing the PDF's own pagination is a later feature", which this issue makes false. Replace it with two bullets:

- **DOCX flow mode reflows** — pages concatenate with no page break, exactly as `ToHtml` and `ToMarkdown` do. Headers, footers, footnotes and revision tracking are not exported, because the document model records none of them.
- **DOCX textbox mode is positional, not a renderer** — each run of text becomes a `w:framePr` frame anchored to the page at its PDF position, with one section per page carrying that page's own size. Word re-measures the text with a substituted face, so a frame errs wide by design and intra-frame spacing is Word's rather than the PDF's. Rotated and vertical runs are placed **unrotated** at their top-left, since a frame has no rotation. `/Link` hyperlinks are not recovered. Annotation and form-field text is absent unless `background: 'raster'` puts its ink in the backdrop. Vector ink — rules, fills, shadings — reaches the output only through `background: 'raster'`, so a ruled table exports as positioned text with no rules. Text drawn in stroke-only render mode (`Tr 1`/`5`) reports its fill colour.

- [ ] **Step 3: Update the quick start**

At `README.md:75`, add one line beside the existing `doc.ToDocx()`:

```ts
const docx  = doc.ToDocx();                          // .docx, reflowed
const fixed = doc.ToDocx({ mode: 'textbox' });       // .docx, each page's own geometry
```

- [ ] **Step 4: Update CLAUDE.md**

Extend the DOCX module block (the `docxflow.ts`, `docxtable.ts`, `docxstyles.ts`, `docxexport.ts` entry) to name `docxgroup.ts` and `docxtextbox.ts`, and record these invariants in the house style — the reason first, the symptom second:

- One positioning construct: `w:framePr` frames, chosen because they are ECMA-376 Part 1 and leave `docxpackage.ts`'s namespace list (`w`, `r`, `wp`) untouched, where VML needs `v` on the root and a DrawingML `wps` shape needs `mc:AlternateContent` with a VML fallback — writing both other constructs anyway.
- `docxgroup.ts` groups **glyphs**, not `TextFragment`s, because fragments merge across colour changes by design; grouping from them paints a line the colour of its first word, and the boundary cannot be recovered once the fragment dissolved it.
- The gap threshold is what keeps a two-column page in two columns, and a single-column fixture cannot pin it — every gap in one is below the threshold whatever its value.
- A frame errs wide, never narrow: Word re-measures with a substituted face, and `w:wrap="none"` makes an over-wide frame free while a narrow one wraps.
- The frame top comes from `quad[3]`, not a font ascent — a group's quad already runs `baseline .. baseline + fontSize`.
- A non-final `w:sectPr` rides its last paragraph's `w:pPr`; only the final one is a direct `w:body` child. Each page emits one unframed anchor paragraph, or a page of nothing but frames has no flow content and its section collapses.
- `docxflow.ts` gains vocabulary, never a branch: `ParaProps.frame` and `RunFmt.size`/`.color` emit nothing when unset, which is what keeps flow mode byte-identical — asserted directly by `test/docx-flow-identity.test.ts`.
- `w:pPr`'s children are schema-ordered (`w:framePr`, `w:pStyle`, `w:numPr`, `w:ind`), the same class of rule as `w:tcPr`'s.

In the `text.ts` entry, record that `GlyphEvent` carries `color` (absent for black) while `TextFragment` deliberately does not, and why — with the note that `visitContent`'s `q`/`Q` stack now carries a graphics-state record rather than a bare CTM.

- [ ] **Step 5: Verify the whole suite one last time**

```bash
npm run typecheck && npm test && npm run build
```
Expected: all three green.

- [ ] **Step 6: Commit and close the issue**

```bash
git add README.md CLAUDE.md
git commit -m "docs(docx): document textbox mode and its limitations

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

bd close aspose-pdf-foss-for-ts-8yt9.4 --reason "..."
bd remember --key docx-export-shipped "..."   # update in place, note 8yt9 is 4/4
git pull --rebase && git push && git status
```

The close reason should record what shipped, the two modules, the `w:framePr` choice and why, and the limitations list — matching the depth of `no93`'s close reason. Epic `8yt9` becomes 4/4 and is eligible for close; check `bd show 8yt9` and close it too if nothing else is outstanding.

---

## Self-Review

**Spec coverage.** Every section maps to a task: positioning construct → Task 3/4; `docxgroup.ts` → Task 2; `docxtextbox.ts` geometry → Task 4; pagination → Task 4; `GlyphEvent.color` → Task 1; public API → Task 5; testing → Tasks 1–6; documentation → Task 7. The spec's out-of-scope list is carried into Task 7's README bullet rather than dropped.

**Two things the spec left open, decided here:**
- `DEFAULT_GAP_EM` is 0.6 with the reasoning recorded in the code comment (a space is ~0.25em in the Latin Standard-14 faces; a layout gap is an em or more). The spec called this "to be measured rather than assumed" — Task 2's step 5 measures it by raising it and confirming the leader and gutter tests go red.
- Inline images (`ImageEvent.stream === undefined`) reach the output only under `background: 'raster'`. The spec did not say; the placement path has no object to register.

**Known ordering constraint.** Task 3's identity fence is written before the mode exists, so its first test is skipped until Task 5 unskips it. That is deliberate — installing the fence first means Tasks 4–6 are each measured against it.

**Names verified against the source rather than assumed**, since a plan that guesses one produces code that compiles and tests that lie:

- `TextFont.bold` / `.italic` — `readonly bold: boolean`, `readonly italic: boolean` (`src/font.ts:241-242`). Used as written in Task 2.
- `rgbHex(rgb)` returns `'#rrggbb'` lowercase (`src/colorspace.ts:25-26`). Task 3 slices and upper-cases it.
- `UnzippedEntry.method` is `'store' | 'deflate'`, a label rather than a ZIP method number (`test/helpers/unzip.ts:4-10`). Task 6's first draft asserted `0` and would have failed for the wrong reason; corrected to `'store'`.
- `buildImagePdf()` returns an object of fixtures, not bytes. Task 6 uses `buildPlacedImagePdf({ width, height, samples, placements })`, whose `placements` array draws one image under several `cm` matrices — which is what makes the byte-hash dedup rule observable at all.

**Task 1's `nums`/`num`/`resolveDict` helpers** are already module-private in `text.ts` and used by the existing path-construction cases; the new colour cases reuse them rather than importing anything.
