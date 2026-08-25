# Form Field Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every AcroForm field type a border, background and text style — at creation and on fields that already exist — reflected in the generated `/AP`.

**Architecture:** A new `src/fieldstyle.ts` owns the style vocabulary (two interfaces, validation, and the `/MK` + `/BS` writer) so both `formcreate.ts` and `formfield.ts` can use it without an import cycle. `mkOps` in `appearance.ts` learns to render all five `/BS /S` border styles. `Field.SetStyle` rewrites the keys and regenerates the appearance, dispatching per field type.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`./fieldstyle.js`), even though the source file is `.ts`.
- **Issue tracking is `bd`, not TodoWrite or markdown TODOs.** The issue is `aspose-pdf-foss-for-ts-dbpr.6`.
- **Creation and restyle must be all-or-nothing.** Every argument is validated before the first object is allocated or the first key written, so a rejected call leaves the document byte-identical. This is an epic-wide invariant.
- **Colours are RGB triples in 0..1** on input. `null` means "paint nothing" and is written as an empty PDF array.
- **`npm run typecheck` and `npm test` must both be green before the issue closes.**
- Spec: `docs/superpowers/specs/2026-07-27-field-styling-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/fieldstyle.ts` | **new** — `WidgetStyle`/`FieldStyle` types, validation, `/MK`+`/BS` writer, plus `DR_KEY`/`ensureDRFont`/`fieldDA`/`pdfLatin` moved out of `formcreate.ts` |
| `src/appearance.ts` | `mkOps` renders five border styles; `glyphBody` takes a colour; `buildButtonAP` takes a `ResolvedDA`; `synthOnState` exported |
| `src/formcreate.ts` | consumes the style on every creation path; re-exports the moved helpers |
| `src/buttonap.ts` | `regeneratePushButtonAP`; `buildPushButtonAP` accepts a pre-allocated icon ref |
| `src/formfield.ts` | `Field.SetStyle` and its per-type regeneration dispatch |
| `src/index.ts` | public type exports |
| `test/form-style.test.ts` | **new** — the whole feature |
| `README.md` | styling options and `Field.SetStyle` |

---

### Task 1: The style vocabulary

Creates `src/fieldstyle.ts`: the types, the validators, and the writer. Nothing consumes it yet, so this task is pure addition — no existing behaviour changes.

**Files:**
- Create: `src/fieldstyle.ts`
- Modify: `src/formcreate.ts:25-35` (delete `DR_KEY`), `src/formcreate.ts:52-93` (delete `ensureDRFont`, `fieldDA`), `src/formcreate.ts:265-268` (delete `pdfLatin`)
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `checkNums(key, v, n)` from `./annotation.js`; `num` from `./pagecontent.js`; `StdFont` from `./metrics.js`.
- Produces:
  - `type FieldBorderStyle = 'solid'|'dashed'|'beveled'|'inset'|'underline'`
  - `interface WidgetStyle`, `interface FieldStyle extends WidgetStyle`
  - `interface NormalizedStyle { bg?: number[]|null; bc?: number[]|null; width?: number; style?: FieldBorderStyle; dash?: number[] }`
  - `checkColor(key: string, c: [number,number,number]|null|undefined): number[]|null|undefined`
  - `checkWidgetStyle(s: WidgetStyle): NormalizedStyle`
  - `checkFont(f: StdFont|undefined): void`
  - `applyWidgetStyle(doc: Document, widget: PdfDict, s: NormalizedStyle): void`
  - moved verbatim: `DR_KEY`, `ensureDRFont(doc, acro, std): string`, `fieldDA(key, size, color): string`, `pdfLatin(s): PdfObject`

- [ ] **Step 1: Write the failing test**

Create `test/form-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkWidgetStyle, applyWidgetStyle } from '../src/fieldstyle.js';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { PdfDict, PdfObject, isArray, isDict, isName } from '../src/types.js';

const blank = () => Document.Open(buildBlankPage());
const sub = (d: Document, w: PdfDict, k: string) => d.resolve(w.get(k)) as PdfDict;

describe('checkWidgetStyle', () => {
  it('normalizes colours and defaults', () => {
    const n = checkWidgetStyle({ backgroundColor: [1, 0, 0], borderColor: null });
    expect(n.bg).toEqual([1, 0, 0]);
    expect(n.bc).toBeNull();
    expect(n.width).toBeUndefined();
  });

  it('rejects a colour that is not three numbers', () => {
    expect(() => checkWidgetStyle({ backgroundColor: [1, 0] as never })).toThrow(TypeError);
  });

  it('rejects a colour component outside 0..1', () => {
    expect(() => checkWidgetStyle({ borderColor: [0, 0, 2] })).toThrow(TypeError);
  });

  it('rejects a negative borderWidth', () => {
    expect(() => checkWidgetStyle({ borderWidth: -1 })).toThrow(TypeError);
  });

  it('rejects an unknown borderStyle', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'groovy' as never })).toThrow(TypeError);
  });

  it('rejects an empty or non-positive dashPattern', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'dashed', dashPattern: [] })).toThrow(TypeError);
    expect(() => checkWidgetStyle({ borderStyle: 'dashed', dashPattern: [0] })).toThrow(TypeError);
  });

  it('rejects a dashPattern on a non-dashed border', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'beveled', dashPattern: [3] }))
      .toThrow(RangeError);
  });
});

describe('applyWidgetStyle', () => {
  it('writes /MK /BG and /BC, and an empty array for null', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ backgroundColor: [0, 0, 1], borderColor: null }));
    const mk = sub(doc, w, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([0, 0, 1]);
    expect(doc.resolve(mk.get('BC'))).toEqual([]);
  });

  it('writes /BS with /W 1 and /S /S by default', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ borderColor: [0, 0, 0] }));
    const bs = sub(doc, w, 'BS');
    expect(doc.resolve(bs.get('W'))).toBe(1);
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('S');
  });

  it('writes /BS /D only for a dashed border', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({
      borderColor: [0, 0, 0], borderStyle: 'dashed', dashPattern: [4, 2],
    }));
    const bs = sub(doc, w, 'BS');
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('D');
    expect(doc.resolve(bs.get('D'))).toEqual([4, 2]);
  });

  it('writes no /BS at all when no border key is given', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ backgroundColor: [1, 1, 1] }));
    expect(w.has('BS')).toBe(false);
    expect(isDict(doc.resolve(w.get('MK')))).toBe(true);
  });

  it('leaves absent keys alone on an existing /MK', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>([
      ['MK', new Map<string, PdfObject>([['BG', [1, 1, 1]], ['CA', { kind: 'string', bytes: new Uint8Array([65]) }]])],
    ]);
    applyWidgetStyle(doc, w, checkWidgetStyle({ borderColor: [0, 0, 0] }));
    const mk = sub(doc, w, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([1, 1, 1]);
    expect(mk.has('CA')).toBe(true);
    expect(isArray(doc.resolve(mk.get('BC')))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts`
Expected: FAIL — `Failed to resolve import "../src/fieldstyle.js"`.

- [ ] **Step 3: Create `src/fieldstyle.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, name } from './types.js';
import { num } from './pagecontent.js';
import { checkNums } from './annotation.js';
import type { StdFont } from './metrics.js';

/** Acrobat's conventional /DR /Font resource keys for the Standard-14 faces.
 *  These are the names its /DA strings expect; da.ts already reads them. */
export const DR_KEY: Record<StdFont, string> = {
  'Helvetica': 'Helv', 'Helvetica-Bold': 'HeBo',
  'Helvetica-Oblique': 'HeOb', 'Helvetica-BoldOblique': 'HeBO',
  'Courier': 'Cour', 'Courier-Bold': 'CoBo',
  'Courier-Oblique': 'CoOb', 'Courier-BoldOblique': 'CoBO',
  'Times-Roman': 'TiRo', 'Times-Bold': 'TiBo',
  'Times-Italic': 'TiIt', 'Times-BoldItalic': 'TiBI',
  'Symbol': 'Symb', 'ZapfDingbats': 'ZaDb',
};

/** A PdfString carrying a latin1/ASCII byte string (/DA and friends, which are
 *  read back with a latin1 decoder in da.ts — never UTF-16). */
export function pdfLatin(s: string): PdfObject {
  return { kind: 'string', bytes: new TextEncoder().encode(s) };
}

/** Register `std` in the AcroForm /DR /Font and return its resource key.
 *  Reuses any key already bound to that face, so repeated calls never
 *  duplicate a font. When the conventional key is held by a *different* face,
 *  takes a suffixed key instead of retargeting it — silently repointing /Helv
 *  would change how every existing field in the document renders. */
export function ensureDRFont(doc: Document, acro: PdfDict, std: StdFont): string {
  // MOVE THIS BODY VERBATIM from src/formcreate.ts (the current lines 57-85).
  // It is unchanged; only its home changes. Its imports (isDict, isName, name)
  // must be added to this file's import list.
  throw new Error('replaced by the moved body');
}

/** A /DA string: font resource key, size (0 = auto-size to the box), and an
 *  RGB fill colour. `rg` rather than `g` even for grey, so there is one form
 *  to write and one to read back. */
export function fieldDA(key: string, size: number, color: [number, number, number]): string {
  const [r, g, b] = color;
  return `/${key} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg`;
}

/** How a widget's border is drawn (/BS /S). */
export type FieldBorderStyle =
  'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';

/** Every supported style, for validation and exhaustive tests. */
export const BORDER_STYLES: readonly FieldBorderStyle[] =
  ['solid', 'dashed', 'beveled', 'inset', 'underline'];

/** The /BS /S name for each style (PDF 32000-1 table 166). */
export const BS_S: Record<FieldBorderStyle, string> = {
  solid: 'S', dashed: 'D', beveled: 'B', inset: 'I', underline: 'U',
};

/** /MK + /BS: what a widget's box looks like. Every key is optional and an
 *  absent one is left as it is, which is what makes the same type usable for
 *  creation and for restyling an existing field. */
export interface WidgetStyle {
  /** /MK /BG fill, RGB 0..1. `null` paints nothing (an empty /BG array). */
  backgroundColor?: [number, number, number] | null;
  /** /MK /BC stroke, RGB 0..1. `null` paints nothing. */
  borderColor?: [number, number, number] | null;
  /** /BS /W in points. Default 1 whenever /BS is written. */
  borderWidth?: number;
  /** /BS /S. Default 'solid'. */
  borderStyle?: FieldBorderStyle;
  /** /BS /D dash lengths in points. Only with 'dashed'; default [3]. */
  dashPattern?: number[];
}

/** WidgetStyle plus the /DA text half. */
export interface FieldStyle extends WidgetStyle {
  /** Standard-14 face for the field's /DA. */
  font?: StdFont;
  /** /DA font size; 0 auto-sizes to the box. */
  fontSize?: number;
  /** /DA text colour, RGB 0..1. */
  textColor?: [number, number, number];
}

/** A validated WidgetStyle. `undefined` means "leave the key alone"; `null`
 *  means "explicitly nothing" and becomes an empty PDF array. */
export interface NormalizedStyle {
  bg?: number[] | null;
  bc?: number[] | null;
  width?: number;
  style?: FieldBorderStyle;
  dash?: number[];
}

/** An RGB triple validated to 0..1, passed through `null` and `undefined`. */
export function checkColor(
  key: string, c: [number, number, number] | null | undefined,
): number[] | null | undefined {
  if (c === undefined) return undefined;
  if (c === null) return null;
  const v = checkNums(key, c, 3);
  if (v.some((x) => x < 0 || x > 1))
    throw new TypeError(`${key} components must be in 0..1`);
  return v;
}

/** Reject a `font` that is not one of the fourteen. TypeScript already narrows
 *  it, but a JavaScript caller reaches ensureDRFont with it and would otherwise
 *  get `/undefined` as the /DA resource key. */
export function checkFont(f: StdFont | undefined): void {
  if (f !== undefined && !(f in DR_KEY))
    throw new TypeError(`font must be one of the Standard-14 faces, not '${String(f)}'`);
}

/** Validate a WidgetStyle, mutating nothing. Every creation and restyle path
 *  calls this before allocating, so a rejection leaves the document unchanged. */
export function checkWidgetStyle(s: WidgetStyle): NormalizedStyle {
  const bg = checkColor('backgroundColor', s.backgroundColor);
  const bc = checkColor('borderColor', s.borderColor);

  const width = s.borderWidth;
  if (width !== undefined
      && (typeof width !== 'number' || !Number.isFinite(width) || width < 0))
    throw new TypeError('borderWidth must be a non-negative number');

  const style = s.borderStyle;
  if (style !== undefined && !BORDER_STYLES.includes(style))
    throw new TypeError(`borderStyle must be one of ${BORDER_STYLES.join(', ')}`);

  let dash: number[] | undefined;
  if (s.dashPattern !== undefined) {
    if (!Array.isArray(s.dashPattern) || s.dashPattern.length === 0)
      throw new TypeError('dashPattern must be a non-empty array of numbers');
    if (!s.dashPattern.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))
      throw new TypeError('dashPattern entries must be positive finite numbers');
    // Stored and ignored on any other style, so the field would come out looking
    // nothing like the call that made it.
    if (style !== 'dashed')
      throw new RangeError("dashPattern requires borderStyle 'dashed'");
    dash = [...s.dashPattern];
  }

  return { bg, bc, width, style, dash };
}

/** Validate the whole FieldStyle. The text half is checked here so a restyle
 *  rejects before writing any of the widget half. */
export function checkFieldStyle(s: FieldStyle): NormalizedStyle {
  checkFont(s.font);
  if (s.fontSize !== undefined
      && (typeof s.fontSize !== 'number' || !Number.isFinite(s.fontSize) || s.fontSize < 0))
    throw new TypeError('fontSize must be a non-negative number');
  checkColor('textColor', s.textColor);
  return checkWidgetStyle(s);
}

/** Write a validated style's /MK and /BS onto one widget. Absent keys are left
 *  alone; a null colour writes the empty array that paints nothing.
 *
 *  /BS is created only when a border key was given. A field with no border
 *  writes no /BS rather than one with /W 0 — mkOps already paints no border
 *  when /BC is absent, so the empty dict would be noise in every saved file. */
export function applyWidgetStyle(doc: Document, widget: PdfDict, s: NormalizedStyle): void {
  if (s.bg !== undefined || s.bc !== undefined) {
    let mk = doc.resolve(widget.get('MK'));
    if (!isDict(mk)) { mk = new Map<string, PdfObject>(); widget.set('MK', mk); }
    if (s.bg !== undefined) (mk as PdfDict).set('BG', s.bg ?? []);
    if (s.bc !== undefined) (mk as PdfDict).set('BC', s.bc ?? []);
  }

  if (s.bc === undefined && s.width === undefined
      && s.style === undefined && s.dash === undefined) return;

  let bs = doc.resolve(widget.get('BS'));
  if (!isDict(bs)) {
    bs = new Map<string, PdfObject>([['Type', name('Border')]]);
    widget.set('BS', bs);
  }
  (bs as PdfDict).set('W', s.width ?? 1);
  (bs as PdfDict).set('S', name(BS_S[s.style ?? 'solid']));
  if (s.dash) (bs as PdfDict).set('D', s.dash);
}
```

Then move `ensureDRFont`'s body: cut lines 57-85 of `src/formcreate.ts` into the stub above (replacing the `throw`), and add `isName` to this file's `./types.js` import.

- [ ] **Step 4: Delete the moved code from `formcreate.ts` and re-export**

Delete `DR_KEY` (lines 25-35), `ensureDRFont` (52-85), `fieldDA` (87-93) and `pdfLatin` (265-268) from `src/formcreate.ts`. Add near the top of its imports:

```ts
import {
  ensureDRFont, fieldDA, pdfLatin, checkColor, checkWidgetStyle, checkFieldStyle,
  applyWidgetStyle, type FieldStyle, type WidgetStyle, type NormalizedStyle,
} from './fieldstyle.js';

// Re-exported so existing import sites (test/form-create.test.ts, index.ts) keep
// working after the move.
export { ensureDRFont, fieldDA } from './fieldstyle.js';
export type { FieldStyle, WidgetStyle, FieldBorderStyle } from './fieldstyle.js';
```

Remove the now-unused `StdFont` import from `formcreate.ts` only if nothing else there uses it (`FieldInit.font` does, so keep it).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-create.test.ts && npm run typecheck`
Expected: PASS. `form-create.test.ts` must stay green — it imports `ensureDRFont` and `fieldDA` from `formcreate.js`, which now re-exports them.

- [ ] **Step 6: Commit**

```bash
git add src/fieldstyle.ts src/formcreate.ts test/form-style.test.ts
git commit -m "feat(form): field style vocabulary and /MK + /BS writer (dbpr.6)"
```

---

### Task 2: Render all five border styles

`mkOps` reads only `/BS /W` and always strokes a plain rectangle. Teach it `/BS /S`.

**Files:**
- Modify: `src/appearance.ts:67-119` (`colorArr` → `numArray`, and the border half of `mkOps`)
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `BS_S` is *not* used here — `mkOps` reads the raw `/S` name letter.
- Produces: `mkOps(doc, widget, g, darken?)` keeps its exact `{ ops: string; inset: number }` shape, so `buildButtonAP`, `buildPushButtonAP` and `generateFieldAppearance` are untouched.

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
import { mkOps, widgetGeom } from '../src/appearance.js';
import { applyWidgetStyle as apply2, checkWidgetStyle as check2, type FieldBorderStyle } from '../src/fieldstyle.js';

const styledWidget = (doc: Document, style: Parameters<typeof check2>[0]) => {
  const w: PdfDict = new Map<string, PdfObject>([['Rect', [0, 0, 100, 20]]]);
  apply2(doc, w, check2({ backgroundColor: [1, 1, 1], borderColor: [0, 0, 0], ...style }));
  return w;
};

describe('mkOps border styles', () => {
  it('draws all five styles differently', () => {
    const doc = blank();
    const styles: FieldBorderStyle[] =
      ['solid', 'dashed', 'beveled', 'inset', 'underline'];
    const drawn = styles.map((borderStyle) => {
      const w = styledWidget(doc, borderStyle === 'dashed'
        ? { borderStyle, dashPattern: [4, 2] } : { borderStyle });
      return mkOps(doc, w, widgetGeom(doc, w)!).ops;
    });
    for (let i = 0; i < drawn.length; i++)
      for (let j = i + 1; j < drawn.length; j++)
        expect(drawn[i], `${styles[i]} vs ${styles[j]}`).not.toBe(drawn[j]);
  });

  it('emits the dash array as a `d` operator', () => {
    const doc = blank();
    const w = styledWidget(doc, { borderStyle: 'dashed', dashPattern: [4, 2] });
    expect(mkOps(doc, w, widgetGeom(doc, w)!).ops).toContain('[4 2] 0 d');
  });

  it('insets by the border width for solid, twice that for beveled, none for underline', () => {
    const doc = blank();
    const g = (s: FieldBorderStyle) => {
      const w = styledWidget(doc, { borderStyle: s, borderWidth: 3 });
      return mkOps(doc, w, widgetGeom(doc, w)!).inset;
    };
    expect(g('solid')).toBe(3);
    expect(g('beveled')).toBe(6);
    expect(g('inset')).toBe(6);
    expect(g('underline')).toBe(0);
  });

  it('falls back to solid for an unrecognised /BS /S', () => {
    const doc = blank();
    const solid = styledWidget(doc, { borderStyle: 'solid' });
    const weird = styledWidget(doc, {});
    (doc.resolve(weird.get('BS')) as PdfDict).set('S', { kind: 'name', name: 'Z' });
    expect(mkOps(doc, weird, widgetGeom(doc, weird)!).ops)
      .toBe(mkOps(doc, solid, widgetGeom(doc, solid)!).ops);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "border styles"`
Expected: FAIL — "draws all five styles differently" fails because every style currently produces the identical solid rectangle stroke.

- [ ] **Step 3: Rewrite the border half of `mkOps`**

In `src/appearance.ts`, rename `colorArr` to `numArray` (it is a generic
number-array reader and is about to have a second, non-colour caller — the dash
pattern). Update its two existing call sites inside `mkOps`.

Add above `mkOps`:

```ts
/** Highlight and shadow greys for a 3-D border's two bands. */
const BEVEL_LIGHT = 1;
const BEVEL_DARK = 0.5;

/** /BS as the three things a border needs, with the specification's defaults
 *  (width 1, style Solid, dash [3]) for every key the widget omits. */
function borderSpec(doc: Document, widget: PdfDict): { w: number; s: string; dash: number[] } {
  let w = 1, s = 'S', dash = [3];
  const bs = doc.resolve(widget.get('BS'));
  if (isDict(bs)) {
    const wv = doc.resolve((bs as PdfDict).get('W'));
    if (typeof wv === 'number') w = wv;
    const sv = doc.resolve((bs as PdfDict).get('S'));
    if (isName(sv)) s = sv.name;
    const dv = numArray(doc, (bs as PdfDict).get('D'));
    if (dv && dv.length > 0) dash = dv;
  }
  return { w, s, dash };
}

/** The two L-shaped bands of a 3-D border, filled in the ring between inset
 *  `bw` and inset `2*bw` — just inside the /BC stroke. `raised` puts the
 *  highlight on the top-left (Beveled); false swaps them (Inset).
 *
 *  Two separate fills rather than one path: the Ls abut along their diagonals
 *  but never overlap, so no winding rule has to reconcile them. */
function bevelOps(w: number, h: number, bw: number, raised: boolean): string {
  const a = bw, b = bw * 2;
  const poly = (pts: Array<[number, number]>): string =>
    pts.map(([x, y], i) => `${num(x)} ${num(y)} ${i === 0 ? 'm' : 'l'}`).join(' ') + ' h f\n';
  const upper = poly([[a, a], [a, h - a], [w - a, h - a], [w - b, h - b], [b, h - b], [b, b]]);
  const lower = poly([[a, a], [b, b], [w - b, b], [w - b, h - b], [w - a, h - a], [w - a, a]]);
  const light = `${num(BEVEL_LIGHT)} g\n`;
  const dark = `${num(BEVEL_DARK)} g\n`;
  return raised ? light + upper + dark + lower : dark + upper + light + lower;
}
```

Replace `mkOps` (currently lines 97-119) with:

```ts
/** Content ops painting the widget's /MK background (/BG) and border (/BC), plus
 *  a border inset for text layout. Empty when there is no /MK.
 *
 *  `darken` (default 1) scales the background toward black; a push button's
 *  pressed state uses it. The border is deliberately not darkened — a pressed
 *  button darkens its face, not its outline. */
export function mkOps(
  doc: Document, widget: PdfDict, g: WidgetGeom, darken = 1,
): { ops: string; inset: number } {
  const mk = doc.resolve(widget.get('MK'));
  if (!isDict(mk)) return { ops: '', inset: 0 };

  let ops = '';
  const bg = numArray(doc, (mk as PdfDict).get('BG'));
  if (bg) ops += `${setColorOp(darkenColor(bg, darken), false)} 0 0 ${num(g.w)} ${num(g.h)} re f\n`;

  const bc = numArray(doc, (mk as PdfDict).get('BC'));
  if (!bc) return { ops, inset: 0 };
  const { w: bw, s, dash } = borderSpec(doc, widget);
  if (bw <= 0) return { ops, inset: 0 };

  const half = bw / 2;
  const pen = `${setColorOp(bc, true)} ${num(bw)} w `;
  const box = `${num(half)} ${num(half)} ${num(g.w - bw)} ${num(g.h - bw)} re S\n`;

  switch (s) {
    case 'U':
      // Only a bottom edge, so there is no side or top border for text to avoid.
      ops += `${pen}${num(0)} ${num(half)} m ${num(g.w)} ${num(half)} l S\n`;
      return { ops, inset: 0 };
    case 'D':
      ops += `${pen}[${dash.map((d) => num(d)).join(' ')}] 0 d ${box}`;
      return { ops, inset: bw };
    case 'B':
    case 'I':
      // The bevel band sits inside the stroke and eats another bw of the box,
      // so text must clear both or its glyphs land on the highlight.
      ops += pen + box + bevelOps(g.w, g.h, bw, s === 'B');
      return { ops, inset: bw * 2 };
    default:
      // 'S' and anything unrecognised: the specification's default.
      ops += pen + box;
      return { ops, inset: bw };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-appearance.test.ts test/form-create.test.ts && npm run typecheck`
Expected: PASS across all three. The existing suites cover solid borders only, whose output is byte-identical to before.

- [ ] **Step 5: Prove the pairwise test is load-bearing**

Per `CLAUDE.md`, do not just watch it go green. Temporarily replace the whole
`switch (s)` block with `ops += pen + box; return { ops, inset: bw };` and run:

Run: `npx vitest run test/form-style.test.ts -t "draws all five styles differently"`
Expected: FAIL. Then revert the mutation and confirm it passes again.

- [ ] **Step 6: Commit**

```bash
git add src/appearance.ts test/form-style.test.ts
git commit -m "feat(form): render all five /BS /S border styles (dbpr.6)"
```

---

### Task 3: The button mark takes its colour from /DA

`glyphBody` hardcodes `0 g`, so a check or dot is always black however the field is styled.

**Files:**
- Modify: `src/appearance.ts:325-334` (`glyphBody`), `src/appearance.ts:364-379` (`buildButtonAP`), `src/appearance.ts:513` (its call site)
- Modify: `src/formcreate.ts` (the two `buildButtonAP` call sites)
- Test: `test/form-style.test.ts`

**Interfaces:**
- Produces: `buildButtonAP(doc, widget, onState, kind, da: ResolvedDA): void` — the trailing `std: StdFont = 'Helvetica'` parameter is **replaced** by a required `da`. Also `export function synthOnState(doc, widget, fieldDict, widgetIndex, value): string` (was module-private; Task 7 needs it).

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
import { isStream } from '../src/types.js';

const streamText = (o: unknown) =>
  isStream(o as never) ? new TextDecoder('latin1').decode((o as { raw: Uint8Array }).raw) : '';

describe('button mark colour', () => {
  it('draws a checkbox check in the /DA colour, not black', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree',
      checked: true, textColor: [1, 0, 0],
    });
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as PdfDict;
    const on = streamText(doc.resolve(n.get('Yes')));
    expect(on).toContain('/ZaDb');
    expect(on).toContain('1 0 0 rg');
    expect(on).not.toContain('0 g\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "button mark colour"`
Expected: FAIL — the on-state stream contains `0 g` and no `1 0 0 rg`.

- [ ] **Step 3: Thread the colour through**

In `src/appearance.ts`, change `glyphBody`:

```ts
/** Body that draws a ZapfDingbats glyph centered in the box, in `color`. */
function glyphBody(glyph: string, color: [number, number, number]): (g: WidgetGeom) => string {
  return (g: WidgetGeom) => {
    const size = Math.min(g.w, g.h) * 0.8;
    const bytes = encodeWinAnsi(glyph);
    const w = measure('ZapfDingbats', bytes, size);
    const x = (g.w - w) / 2;
    const y = (g.h - size) / 2 + size * 0.2;
    const [r, gg, b] = color;
    return `BT\n/ZaDb ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
      `${num(x)} ${num(y)} Td\n${serializeString(bytes)} Tj\nET`;
  };
}
```

Change `buildButtonAP`'s signature and body:

```ts
/** Build and install a button widget's two normal appearances: `onState` and
 *  'Off'. No-op when the widget has no usable geometry.
 *
 *  Separated from generateFieldAppearance so creation can name the on-state
 *  outright — synthOnState exists to *guess* it for documents we did not
 *  author, and that guess defaults to 'Yes'.
 *
 *  `da` supplies both the mark's colour and the off stream's /Helv face. It is
 *  required rather than defaulted: a defaulted face silently disagreed with the
 *  field's real /DA. */
export function buildButtonAP(
  doc: Document, widget: PdfDict, onState: string,
  kind: 'checkbox' | 'radio', da: ResolvedDA,
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const mk = mkOps(doc, widget, g);
  const glyph = kind === 'radio' ? ZADB_CIRCLE : ZADB_CHECK;
  const onStream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops + glyphBody(glyph, da.color)(g));
  (onStream.dict.get('Resources') as PdfDict).set(
    'Font', (zapfResources(doc) as PdfDict).get('Font')!,
  );
  const offStream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops);
  installAPState(doc, widget, onState, onStream);
  installAPState(doc, widget, 'Off', offStream);
}
```

At line 513 inside `generateFieldAppearance`, change the call to pass the whole `da`:

```ts
        buildButtonAP(doc, widget, synthOnState(doc, widget, fieldDict, wi, value), type, da);
```

Export `synthOnState` by adding `export` to its declaration (Task 7 needs it).

In `src/formcreate.ts`, add `resolveDA` to the imports from `./da.js` and update the two call sites:

```ts
// addCheckbox
    buildAP: (d, dict, acro) => { buildButtonAP(d, dict, on, 'checkbox', resolveDA(d, dict, acro)); },
```

```ts
// addRadioGroup, inside the per-option loop
    buildButtonAP(doc, widget, on, 'radio', resolveDA(doc, parent, acro));
```

`addRadioGroup` does not write a `/DA` yet — Task 4 adds it, and until then
`resolveDA` correctly falls back to the AcroForm `/DA`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-appearance.test.ts test/form-create.test.ts test/flatten-form.test.ts && npm run typecheck`
Expected: PASS. Any existing assertion on `0 g` inside a button on-state must be updated to `0 0 0 rg` — the default colour is unchanged, only its operator is.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts src/formcreate.ts test/form-style.test.ts
git commit -m "feat(form): button check and dot take the /DA colour (dbpr.6)"
```

---

### Task 4: Style on every creation path

Wire the validated style into `createField` (which every type but the radio group routes through) and into `addRadioGroup`.

**Files:**
- Modify: `src/formcreate.ts` — `FieldInit` (207-225), `createField` (303-353), `RadioGroupInit` (426-435), `addRadioGroup` (443-506)
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `checkFieldStyle`, `checkWidgetStyle`, `applyWidgetStyle`, `checkColor`, `ensureDRFont`, `fieldDA`, `pdfLatin` from `./fieldstyle.js`.
- Produces: `FieldInit extends FieldStyle`; `RadioGroupInit extends WidgetStyle` with its own `textColor`.

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
describe('styling at creation', () => {
  it('lands the style on a text field widget and its /DA', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 200, 30], name: 'nm',
      backgroundColor: [0.9, 0.9, 1], borderColor: [0, 0, 0.5],
      borderWidth: 2, borderStyle: 'beveled',
      font: 'Times-Bold', fontSize: 11, textColor: [1, 0, 0],
    });
    const mk = sub(doc, f.Dict, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([0.9, 0.9, 1]);
    expect(doc.resolve(mk.get('BC'))).toEqual([0, 0, 0.5]);
    const bs = sub(doc, f.Dict, 'BS');
    expect(doc.resolve(bs.get('W'))).toBe(2);
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('B');
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 1 0 0 rg');
  });

  it('puts /MK and /BS on each radio kid, and the colour in the parent /DA', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({
      name: 'pick',
      options: [
        { page: 1, rect: [10, 10, 30, 30], export: 'a' },
        { page: 1, rect: [40, 10, 60, 30], export: 'b' },
      ],
      backgroundColor: [1, 1, 1], borderColor: [0, 0, 0], textColor: [0, 0.5, 0],
    });
    expect(f.Dict.has('MK')).toBe(false);
    expect(f.Dict.has('BS')).toBe(false);
    const kids = doc.resolve(f.Dict.get('Kids')) as PdfObject[];
    expect(kids.length).toBe(2);
    for (const k of kids) {
      const w = doc.resolve(k) as PdfDict;
      expect(doc.resolve(sub(doc, w, 'MK').get('BG'))).toEqual([1, 1, 1]);
      expect(sub(doc, w, 'BS').has('S')).toBe(true);
    }
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toContain('0 0.5 0 rg');
  });

  it('leaves the document byte-identical when the style is rejected', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'ok' });
    const before = doc.Save().length;
    expect(() => doc.Form.AddTextField({
      page: 1, rect: [10, 40, 200, 60], name: 'bad', borderColor: [0, 0, 5],
    })).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "styling at creation"`
Expected: FAIL — `/MK` is absent on the text field; `AddRadioGroup` rejects the unknown options.

- [ ] **Step 3: Extend `FieldInit` and `createField`**

In `src/formcreate.ts`, replace the three text-style members of `FieldInit` with
inheritance, keeping the rest:

```ts
/** Options common to every field-creation entry point. */
export interface FieldInit extends FieldStyle {
  /** 1-based page number carrying the widget. */
  page: number;
  /** Widget rectangle [llx, lly, urx, ury] in default user space. */
  rect: [number, number, number, number];
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** /Ff ReadOnly (bit 1). */
  readOnly?: boolean;
  /** /Ff Required (bit 2). */
  required?: boolean;
}
```

In `createField`, replace the inline font/size/colour validation in step 1 with
the shared helpers, and apply the widget style in step 4:

```ts
  // 1. Validate every argument against the document, mutating nothing.
  const page = pageOf(doc, init.page);
  const rect = checkNums('rect', init.rect, 4) as [number, number, number, number];
  const style = checkFieldStyle(init);
  const std: StdFont = init.font ?? 'Helvetica';
  const size = init.fontSize ?? 0;
  const color = (checkColor('textColor', init.textColor ?? [0, 0, 0]) ?? [0, 0, 0]) as
    [number, number, number];
  nameParts(init.name);
```

and, in step 4, immediately after the `spec.entries` loop and **before** the
appearance is built (so `mkOps` sees the style):

```ts
  for (const [k, v] of spec.entries ?? []) dict.set(k, v);
  applyWidgetStyle(doc, dict, style);
```

- [ ] **Step 4: Extend `RadioGroupInit` and `addRadioGroup`**

```ts
/** Options for Form.AddRadioGroup. Deliberately not a FieldInit: page and rect
 *  are per-option, and a button draws no /DA text. It carries `textColor`
 *  regardless, because the dot itself is drawn in the /DA colour. */
export interface RadioGroupInit extends WidgetStyle {
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** At least one option. */
  options: RadioOption[];
  /** Initially selected export value. Default: nothing selected. */
  selected?: string;
  /** The dot's colour, written to the group's /DA. Default black. */
  textColor?: [number, number, number];
  readOnly?: boolean;
  required?: boolean;
}
```

In `addRadioGroup`, validate before allocating (right after the options loop and
the `selected` check):

```ts
  const style = checkWidgetStyle(init);
  const markColor = (checkColor('textColor', init.textColor ?? [0, 0, 0]) ?? [0, 0, 0]) as
    [number, number, number];
```

Give the parent a `/DA` so the colour survives a later regeneration, after
`const acro = ensureAcroForm(doc);`:

```ts
  const daKey = ensureDRFont(doc, acro, 'Helvetica');
```

and add to the `parent` dict literal, after its `['V', …]` entry:

```ts
    ['DA', pdfLatin(fieldDA(daKey, 0, markColor))],
```

Then style each kid inside the per-option loop, before `buildButtonAP`:

```ts
    const widgetRef = doc.allocObject(widget);
    kids.push(widgetRef);
    attachWidget(doc, pages[i], widgetRef);
    applyWidgetStyle(doc, widget, style);
    buildButtonAP(doc, widget, on, 'radio', resolveDA(doc, parent, acro));
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-create.test.ts test/form-appearance.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/formcreate.ts test/form-style.test.ts
git commit -m "feat(form): accept a style on every field-creation path (dbpr.6)"
```

---

### Task 5: Push-button defaults become overridable

`addPushButton` hardcodes `/MK /BG` and `/BC`. They must apply only when the caller styled neither, and `null` must genuinely suppress them.

**Files:**
- Modify: `src/formcreate.ts:673-682` (the `mk` dict literal in `addPushButton`)
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `applyWidgetStyle` already runs inside `createField` (Task 4) and mutates the same `/MK` dict this literal creates, so no new plumbing is needed — only the guard.

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
describe('push button defaults', () => {
  const mkOf = (doc: Document, f: { Dict: PdfDict }) => sub(doc, f.Dict, 'MK');

  it('applies the grey face when neither colour is given', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({ page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go' });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([0.86, 0.86, 0.86]);
    expect(doc.resolve(mkOf(doc, f).get('BC'))).toEqual([0.5, 0.5, 0.5]);
  });

  it('drops both defaults as soon as either colour is given', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go',
      backgroundColor: [0, 0, 1],
    });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([0, 0, 1]);
    expect(mkOf(doc, f).has('BC')).toBe(false);
  });

  it('lets null suppress the default face', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go',
      backgroundColor: null, borderColor: null,
    });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([]);
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).not.toContain(' re f');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "push button defaults"`
Expected: FAIL — the second and third tests find the hardcoded grey still present.

- [ ] **Step 3: Guard the defaults**

Replace the `mk` dict literal in `addPushButton` with:

```ts
  const mk: PdfDict = new Map<string, PdfObject>([
    ['CA', pdfText(caption)],
    ['RC', pdfText(rollover)],
    ['AC', pdfText(down)],
    ['TP', TP_FOR[position]],
  ]);
  // Defaults so a created button looks like a button — applied only when the
  // caller styled neither colour. A null is a deliberate suppression and
  // applyWidgetStyle (in createField) writes the empty array that honours it.
  if (init.backgroundColor === undefined && init.borderColor === undefined) {
    mk.set('BG', [0.86, 0.86, 0.86]);
    mk.set('BC', [0.5, 0.5, 0.5]);
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-create.test.ts && npm run typecheck`
Expected: PASS. The existing dbpr.5 assertions on the default `/BG` and `/BC` still hold — they create buttons without style keys.

- [ ] **Step 5: Commit**

```bash
git add src/formcreate.ts test/form-style.test.ts
git commit -m "feat(form): push-button face defaults yield to an explicit style (dbpr.6)"
```

---

### Task 6: Rebuild a push button's appearance from its dict

`SetStyle` has no `PushButtonFace` — the captions, layout and icon are only in the document. Recover them.

**Files:**
- Modify: `src/buttonap.ts` — `iconOps` (98-111), `buildPushButtonAP` (118-152), plus new `POSITION_FOR_TP`, `existingIconRef`, `regeneratePushButtonAP`
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `TP_FOR`, `BUTTON_POSITIONS`, `ICON_KEY` (already in this file).
- Produces:
  - `buildPushButtonAP(doc, widget, acro, face, iconRef?: PdfRef): void` — one new optional trailing parameter; every existing call site is unchanged.
  - `POSITION_FOR_TP: Record<number, ButtonIconPosition>`
  - `regeneratePushButtonAP(doc: Document, widget: PdfDict, acro: PdfDict): void`

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
import { regeneratePushButtonAP } from '../src/buttonap.js';
import { makePng } from './helpers/make-png.js';

describe('regeneratePushButtonAP', () => {
  it('rebuilds all three streams, keeping caption, layout and icon', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', downCaption: 'Going', icon: makePng(4, 4),
      iconPosition: 'icon-above-caption',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const before = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const beforeN = before.get('N');

    regeneratePushButtonAP(doc, f.Dict, acro);

    const after = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect([...after.keys()].sort()).toEqual(['D', 'N', 'R']);
    expect(after.get('N')).not.toBe(beforeN);       // a fresh stream
    const n = streamText(doc.resolve(after.get('N')));
    expect(n).toContain('(Go) Tj');
    expect(n).toContain('/BtnIco Do');
    expect(streamText(doc.resolve(after.get('D')))).toContain('(Going) Tj');
  });

  it('reuses the icon object rather than embedding it again', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(4, 4), iconPosition: 'icon-only',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const iconRefOf = (): PdfObject => {
      const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
      const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
      const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
      return (doc.resolve(res.get('XObject')) as PdfDict).get('BtnIco')!;
    };
    const first = iconRefOf();
    regeneratePushButtonAP(doc, f.Dict, acro);
    regeneratePushButtonAP(doc, f.Dict, acro);
    expect(iconRefOf()).toEqual(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "regeneratePushButtonAP"`
Expected: FAIL — `regeneratePushButtonAP is not a function`.

- [ ] **Step 3: Let `buildPushButtonAP` take a pre-allocated icon**

In `src/buttonap.ts`, change `iconOps` to read the image dict directly rather
than a `BuiltImage`, since the regenerate path has only a ref:

```ts
/** Ops drawing the icon aspect-fit and centred in [x, y, w, h]. */
function iconOps(
  doc: Document, iconDict: PdfDict, rect: [number, number, number, number],
): string {
  const [x, y, w, h] = rect;
  const iw = doc.resolve(iconDict.get('Width'));
  const ih = doc.resolve(iconDict.get('Height'));
  if (typeof iw !== 'number' || typeof ih !== 'number' || iw <= 0 || ih <= 0) return '';
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  return `q\n${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(dy)} cm\n/${ICON_KEY} Do\nQ\n`;
}
```

Change `buildPushButtonAP`'s icon handling:

```ts
export function buildPushButtonAP(
  doc: Document, widget: PdfDict, acro: PdfDict, face: PushButtonFace,
  iconRef?: PdfRef,
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const da = resolveDA(doc, widget, acro);
  const size = da.size > 0 ? da.size : Math.min(12, g.h * 0.5);

  // The icon is one object shared by all three streams rather than three copies.
  // A caller that already has it allocated (the regenerate path) passes the ref,
  // so restyling a button any number of times never duplicates its image.
  let ref = iconRef;
  if (ref === undefined && face.icon) {
    if (face.icon.smask) face.icon.stream.dict.set('SMask', doc.allocObject(face.icon.smask));
    ref = doc.allocObject(face.icon.stream);
  }
  const resolved = ref === undefined ? undefined : doc.resolve(ref);
  const iconDict = isStream(resolved) ? resolved.dict : undefined;

  const build = (caption: string, darken: number) => {
    const mk = mkOps(doc, widget, g, darken);
    const regions = buttonRegions(face.position, g.w, g.h, mk.inset);
    let body = mk.ops;
    if (regions.icon && iconDict) body += iconOps(doc, iconDict, regions.icon);
    if (regions.caption) body += centredCaption(caption, regions.caption, da.std, size, da.color);
    const stream = buildAppearanceXObject(doc, g, da.std, 'Helv', body);
    if (ref) {
      const res = stream.dict.get('Resources') as PdfDict;
      res.set('XObject', new Map<string, PdfObject>([[ICON_KEY, ref]]));
    }
    return doc.allocObject(stream);
  };

  widget.set('AP', new Map<string, PdfObject>([
    ['N', build(face.caption, 1)],
    ['R', build(face.rolloverCaption, 1)],
    ['D', build(face.downCaption, DOWN_DARKEN)],
  ]));
}
```

Add `isStream`, `isDict`, `isString`, `isRef`, `PdfRef` to the `./types.js`
import, and `decodePdfText` from `./metadata.js`.

- [ ] **Step 4: Add the regenerate path**

Append to `src/buttonap.ts`:

```ts
/** A /TP value back to its layout name — the inverse of TP_FOR. */
export const POSITION_FOR_TP: Record<number, ButtonIconPosition> =
  Object.fromEntries(BUTTON_POSITIONS.map((p) => [TP_FOR[p], p]));

/** The icon XObject a previous build registered in the /N stream, so a rebuild
 *  reuses that object instead of embedding the image a second time. */
function existingIconRef(doc: Document, widget: PdfDict): PdfRef | undefined {
  const ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve((ap as PdfDict).get('N'));
  if (!isStream(n)) return undefined;
  const res = doc.resolve(n.dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const xo = doc.resolve((res as PdfDict).get('XObject'));
  if (!isDict(xo)) return undefined;
  const r = (xo as PdfDict).get(ICON_KEY);
  return isRef(r) ? r : undefined;
}

/** Rebuild a push button's three appearance streams from what the document
 *  already holds.
 *
 *  The restyle path has no PushButtonFace: the captions, layout and icon were
 *  supplied at creation and now live only in the dict. Everything needed is
 *  still there — /MK /CA, /RC and /AC, /MK /TP, and the icon in the existing
 *  /N stream's resources. Mirrors annotdraw.ts's regenerateAppearance, which
 *  exists for the same reason. */
export function regeneratePushButtonAP(doc: Document, widget: PdfDict, acro: PdfDict): void {
  const mk = doc.resolve(widget.get('MK'));
  const txt = (k: string): string => {
    const v = isDict(mk) ? doc.resolve((mk as PdfDict).get(k)) : undefined;
    return isString(v) ? decodePdfText(v.bytes) : '';
  };
  const caption = txt('CA');
  const tp = isDict(mk) ? doc.resolve((mk as PdfDict).get('TP')) : undefined;
  const iconRef = existingIconRef(doc, widget);
  let position = POSITION_FOR_TP[typeof tp === 'number' ? tp : 0] ?? 'caption-only';
  // An icon-bearing layout with no icon left would draw nothing at all.
  if (!iconRef && position !== 'caption-only') position = 'caption-only';

  buildPushButtonAP(doc, widget, acro, {
    caption,
    rolloverCaption: txt('RC') || caption,
    downCaption: txt('AC') || caption,
    position,
  }, iconRef);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-style.test.ts test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Prove the icon-survival test is load-bearing**

Temporarily make `existingIconRef` `return undefined;` unconditionally and run:

Run: `npx vitest run test/form-style.test.ts -t "regeneratePushButtonAP"`
Expected: FAIL on both tests — the icon `Do` disappears and the ref is not reused. Revert the mutation and confirm they pass again.

- [ ] **Step 7: Commit**

```bash
git add src/buttonap.ts test/form-style.test.ts
git commit -m "feat(form): rebuild a push button's /AP from its own dict (dbpr.6)"
```

---

### Task 7: `Field.SetStyle`

**Files:**
- Modify: `src/formfield.ts` — imports, and a new public method plus one private helper on `Field`
- Test: `test/form-style.test.ts`

**Interfaces:**
- Consumes: `checkFieldStyle`, `applyWidgetStyle`, `ensureDRFont`, `fieldDA`, `pdfLatin`, `checkColor`, `type FieldStyle` from `./fieldstyle.js`; `buildButtonAP`, `synthOnState` from `./appearance.js`; `regeneratePushButtonAP` from `./buttonap.js`; `resolveDA` from `./da.js`.
- Produces: `Field.SetStyle(style: FieldStyle): void`, inherited by every subclass.

- [ ] **Step 1: Write the failing test**

Append to `test/form-style.test.ts`:

```ts
describe('Field.SetStyle', () => {
  it('restyles a text field parsed back from saved bytes', () => {
    const src = blank();
    src.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'nm', value: 'hi' });
    const doc = Document.Open(src.Save());

    const f = doc.Form.Get('nm')!;
    f.SetStyle({ backgroundColor: [1, 1, 0], borderColor: [1, 0, 0], borderWidth: 2 });

    expect(doc.resolve(sub(doc, f.Dict, 'MK').get('BG'))).toEqual([1, 1, 0]);
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).toContain('1 1 0 rg');
  });

  it('keeps unspecified /DA parts and rewrites the given ones', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 200, 30], name: 'nm', font: 'Times-Bold', fontSize: 11,
    });
    f.SetStyle({ textColor: [0, 0, 1] });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 0 0 1 rg');
  });

  it('replaces a checkbox appearance that already has /AP states', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On', checked: true,
    });
    const n = () => doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as PdfDict;
    expect(streamText(doc.resolve(n().get('On')))).not.toContain('0 0 1 rg');
    f.SetStyle({ textColor: [0, 0, 1], backgroundColor: [1, 1, 1] });
    // The on-state is still keyed by the export value, and it was rebuilt.
    expect([...n().keys()].sort()).toEqual(['Off', 'On']);
    expect(streamText(doc.resolve(n().get('On')))).toContain('0 0 1 rg');
  });

  it('restyles a push button without losing its icon or captions', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(4, 4), iconPosition: 'icon-above-caption',
    });
    f.SetStyle({ backgroundColor: [0, 0, 0.5], borderStyle: 'beveled', borderWidth: 2 });
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect([...ap.keys()].sort()).toEqual(['D', 'N', 'R']);
    const n = streamText(doc.resolve(ap.get('N')));
    expect(n).toContain('(Go) Tj');
    expect(n).toContain('/BtnIco Do');
    expect(n).toContain('0 0 0.5 rg');
  });

  it('leaves the document byte-identical when the style is rejected', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'nm' });
    const before = doc.Save().length;
    expect(() => f.SetStyle({ borderWidth: -3 })).toThrow(TypeError);
    expect(() => f.SetStyle({ borderStyle: 'beveled', dashPattern: [2] })).toThrow(RangeError);
    expect(doc.Save().length).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-style.test.ts -t "Field.SetStyle"`
Expected: FAIL — `f.SetStyle is not a function`.

- [ ] **Step 3: Implement `SetStyle`**

Add to `src/formfield.ts`'s imports:

```ts
import {
  applyWidgetStyle, checkColor, checkFieldStyle, ensureDRFont, fieldDA, pdfLatin,
  type FieldStyle,
} from './fieldstyle.js';
import { buildButtonAP, synthOnState } from './appearance.js';
import { regeneratePushButtonAP } from './buttonap.js';
import { resolveDA } from './da.js';
```

Add to the `Field` class, after `GenerateAppearance`:

```ts
  /** Restyle this field: border, background and text. Absent keys are left as
   *  they are, so `SetStyle({ borderColor: [1, 0, 0] })` recolours the border
   *  and changes nothing else.
   *
   *  Validation runs before the first write, so a throw leaves the document
   *  unmodified — the same invariant field creation holds. */
  SetStyle(style: FieldStyle): void {
    const ws = checkFieldStyle(style);

    // The /DA is rewritten whole, so unspecified parts come from the current one.
    const cur = resolveDA(this.doc, this.Dict, this.acroForm);
    const std = style.font ?? cur.std;
    const size = style.fontSize ?? cur.size;
    const color = (checkColor('textColor', style.textColor) ?? cur.color) as
      [number, number, number];

    for (const w of this.widgets()) applyWidgetStyle(this.doc, w, ws);
    const key = ensureDRFont(this.doc, this.acroForm, std);
    this.Dict.set('DA', pdfLatin(fieldDA(key, size, color)));

    this.restyleAppearance();
    this.doc.markModified();
  }

  /** Rebuild every widget's appearance after a restyle.
   *
   *  Not GenerateAppearance() for the two button families. That function guards
   *  button regeneration behind an existing-/AP check, to preserve an author's
   *  artwork — but a restyle is precisely the request to replace it. And a push
   *  button is never value-driven at all: its face has to come back from its
   *  own dict. */
  private restyleAppearance(): void {
    const widgets = this.widgets();
    if (this.Type === 'pushbutton') {
      for (const w of widgets) regeneratePushButtonAP(this.doc, w, this.acroForm);
      return;
    }
    if (this.Type === 'checkbox' || this.Type === 'radio') {
      const da = resolveDA(this.doc, this.Dict, this.acroForm);
      const v = this.rawValue();
      for (let i = 0; i < widgets.length; i++) {
        const on = this.onState(widgets[i])
          ?? synthOnState(this.doc, widgets[i], this.Dict, i, v);
        buildButtonAP(this.doc, widgets[i], on, this.Type, da);
      }
      return;
    }
    this.GenerateAppearance();
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-style.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. `formfield.ts` now imports `buttonap.ts`; confirm no import cycle warning and that `test/flatten-form.test.ts` and `test/form-appearance.test.ts` are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/formfield.ts test/form-style.test.ts
git commit -m "feat(form): Field.SetStyle restyles an existing field (dbpr.6)"
```

---

### Task 8: Public exports, docs, and close the issue

**Files:**
- Modify: `src/index.ts`, `README.md`
- Test: the full suite

**Interfaces:**
- Consumes: everything above.
- Produces: `FieldStyle`, `WidgetStyle`, `FieldBorderStyle` as public type exports.

- [ ] **Step 1: Export the public types**

In `src/index.ts`, add to the existing `formcreate.js` type re-export block (or
create one alongside the other form exports):

```ts
export type {
  FieldStyle, WidgetStyle, FieldBorderStyle,
} from './fieldstyle.js';
```

- [ ] **Step 2: Verify the public surface compiles and builds**

Run: `npm run typecheck && npm run build`
Expected: both succeed; `dist/index.d.ts` contains `FieldStyle`.

- [ ] **Step 3: Update `README.md`**

In the AcroForm / form-field section, add the styling options to the field-creation
description and document the new method. Add a worked example:

```ts
const doc = Document.Open(bytes);

// Style at creation.
doc.Pages[0].AddTextField({
  rect: [72, 700, 300, 722], name: 'email',
  backgroundColor: [0.97, 0.97, 1],
  borderColor: [0.2, 0.2, 0.6], borderWidth: 1, borderStyle: 'beveled',
  font: 'Helvetica', fontSize: 11, textColor: [0, 0, 0],
});

// Restyle a field that was already in the document.
doc.Form.Get('signature.name')?.SetStyle({
  borderColor: [1, 0, 0], borderStyle: 'dashed', dashPattern: [4, 2],
});
```

Document, in prose: `borderStyle` accepts `'solid' | 'dashed' | 'beveled' |
'inset' | 'underline'`; colours are RGB triples in 0..1; `null` paints nothing;
an absent key is left unchanged.

- [ ] **Step 4: Update `CLAUDE.md`'s architecture list**

Add `fieldstyle.ts` to the AcroForm bullet's file list, and record the invariant
this feature introduces:

> **Invariant:** a restyle must not route through `generateFieldAppearance` for
> the two button families. That function preserves an existing `/AP` (the
> `hasNStates` guard) so an author's artwork survives a value change — but a
> restyle is the request to replace it, and a push button's face is not
> value-driven at all and must be rebuilt from `/MK` plus the icon already in
> its `/N` resources.

- [ ] **Step 5: Run the full quality gate**

Run: `npm run typecheck && npm test`
Expected: both green. Do not proceed otherwise.

- [ ] **Step 6: Commit and close**

```bash
git add src/index.ts README.md CLAUDE.md
git commit -m "docs(form): document field styling and Field.SetStyle (dbpr.6)"
bd close aspose-pdf-foss-for-ts-dbpr.6
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Closing `dbpr.6` completes the `dbpr` epic (6/6). Check whether `bd` closes the
parent automatically; if not, close `aspose-pdf-foss-for-ts-dbpr` as well.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Two interfaces, one hierarchy | 1 |
| A new module (`fieldstyle.ts`, moved `/DA` helpers) | 1 |
| What gets written (`/MK`, `/BS`, `/DA`); `null` → `[]`; `/BS` only when a border key is given | 1, 4 |
| Push button defaults | 5 |
| `mkOps` learns `/BS /S` (all five, insets, fallback) | 2 |
| Check mark takes its colour from `/DA`; `buildButtonAP` takes a `ResolvedDA` | 3 |
| Radio group: `/MK`+`/BS` on kids, `textColor` → parent `/DA` | 4 |
| Live restyle + per-type dispatch | 7 |
| `regeneratePushButtonAP` | 6 |
| Validation table (all 7 rows) | 1 (validators), 4 + 7 (byte-identical rejection) |
| Testing bullets (all 8) | 1–7 |
| Mutation proofs (border switch, icon survival) | 2 step 5, 6 step 6 |
| README | 8 |

No gaps.

**Type consistency:** `checkWidgetStyle` → `NormalizedStyle` is consumed by
`applyWidgetStyle` in Tasks 1, 4 and 7 under that exact name. `buildButtonAP`'s
signature changes once (Task 3) and every later call site — Tasks 4 and 7 — uses
the new `da: ResolvedDA` form. `buildPushButtonAP`'s new trailing `iconRef` is
optional, so Task 5's untouched call site in `formcreate.ts` still compiles.
`regeneratePushButtonAP(doc, widget, acro)` is defined in Task 6 and called with
that arity in Task 7.

**Placeholder scan:** one deliberate marker remains — Task 1 Step 3's
`ensureDRFont` body is a `throw` with an explicit instruction to move the
existing 29-line body verbatim from `formcreate.ts:57-85`, rather than
reproducing code that must stay identical. Step 3's closing paragraph and Step 5's
test run both enforce it. No other TBDs.
