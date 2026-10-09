# XFA Growable Sizes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Size XFA fields, draws and subforms whose size the template leaves to their text, measuring with the named face (or a closed metric-compatible substitute), and correct the table-cell column rule (164g.7).

**Architecture:** `xfarich.ts` (pure) turns a leaf's template XML into a `LeafText`; `xfatext.ts` (pure) measures a `LeafText` at a box through `layoutRuns`; `xfafont.ts` (holds the `Document`) resolves faces in three tiers. `xfaflow.ts` stays a pure leaf and gains an optional `measure` callback, which `xfaconvert.ts` builds. Tables resolve column widths before measuring cell heights, and a stated column width is a cell's box (XFA 3.3 p. 329).

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-xfa-growable-sizes-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only. Import specifiers end in `.js`.
- `xfaflow.ts`, `xfarich.ts`, `xfatext.ts` import no `Document`, no PDF object module, no `node:` module. `xfaflow.ts` may `import type` from `xfarich.ts` and nothing else new.
- Nothing in the four modules throws on input; refusals are `{ reason: string }` values. Every `catch` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- Without a measurer, `layoutPage` behaves exactly as before for every leaf that needs one (same refusal text, `states no w|h ... needs text measurement (164g.7)`).
- The p. 329 column rule applies with or without a measurer.
- Font tiers, in order: embedded (`/FontFile2`, `/FontFile3 /OpenType`, identified by the program's own `name` table), registered font folders (`RegisterFontFolder`/`RegisterSystemFonts`), then the closed table `arial` → Liberation Sans, `times new roman` → Liberation Serif, `courier new` → Liberation Mono. `Helvetica`, `Times`, `Courier` are NOT substitutes.
- Style match is exact: bold ⇔ `deriveStyle(names).weight >= 600`; italic ⇔ `deriveStyle(names).italic`.
- Line height = (hhea ascender − hhea descender) × size / unitsPerEm, max over the faces on the line; `para lineHeight` wins when greater.
- `min*` is a floor and `max*` a ceiling on a grown axis in every parent layout; `max*` of 0 is absent; `min > max` is swapped with a warning `"<label>: min<A> exceeds max<A>, so the two are swapped (XFA 3.3 p. 277)"`.
- An empty text field measures one empty line in its own `<font>`.
- Font defaults (template reference p. 743): size `10pt`, typeface `Courier`, weight `normal`, posture `normal`.
- Whitespace: consecutive spaces collapse (XFA p. 1220, and `layoutRuns` does so). Refused: two or more spaces inside an `xfa-spacerun:yes` span (on any axis, since collapsing them would change wrapping), and, on a width-growable leaf, a line with leading or trailing spaces.
- A measured leaf's caption with no `reserve` refuses on EITHER axis (a deliberate narrowing of the spec's "on a growable axis": an unknown caption width changes where a fixed-width leaf's text wraps, and so its height).
- Commit after every task; every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A field whose datasets value is an ARRAY (a multi-select bound value) reaching a text measurer → refuse with a reason, never measure `String(array)`. Test in Task 7.
2. A rich-text value containing an unrecognised element (`<script>`, `<div>`) → its content is dropped (p. 1187), not measured. Test in Task 1.
3. A run whose family list names only a generic keyword (`font-family: sans-serif`) → refuses, never resolves to a substitute. Test in Task 3.
4. A caption with `presence="hidden"` and no `reserve` → the caption is ignored, not refused. Test in Task 1.
5. A table whose `-1` column holds only an unstated-width text cell → the column is sized from that cell's MEASURED width when a measurer is given, and still refuses without one. Test in Task 6.

---

### Task 1: `xfarich.ts` — a leaf's template XML to `LeafText`

**Files:**
- Create: `src/xfarich.ts`
- Test: `test/xfarich.test.ts`

**Interfaces:**
- Consumes: `parseXml`, `XmlNode` (`src/xml.ts`); `measureToPt` (`src/xfageom.ts`); `parseDeclarationList` (`src/cssparse.ts`); `trimWs` (`src/cssvalue.ts`); type `CssValue` (`src/cssparse.ts`).
- Produces:
  ```ts
  export interface RunStyle { family: string[]; size: number; bold: boolean; italic: boolean }
  export interface RunSpec extends RunStyle { text: string }
  export interface ParaSpec {
    runs: RunSpec[]; base: RunStyle;
    marginLeft: number; marginRight: number; textIndent: number;
    lineHeight: number; spaceAbove: number; spaceBelow: number;
  }
  export type CaptionSide = 'left' | 'right' | 'top' | 'bottom';
  export interface LeafText {
    kind: 'text' | 'geometry';
    paras: ParaSpec[];
    insets: { l: number; r: number; t: number; b: number };
    caption?: { placement: CaptionSide; reserve?: number };
    password: boolean;
    picture: boolean;
    refusal?: string;
  }
  export function leafText(el: XmlNode): LeafText;
  export function withValue(t: LeafText, value: string): LeafText;
  export function plainParas(text: string, base: RunStyle, para: Omit<ParaSpec, 'runs' | 'base'>): ParaSpec[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/xfarich.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, withValue } from '../src/xfarich.js';

const el = (xml: string) => parseXml(new TextEncoder().encode(xml));

describe('leafText: plain text', () => {
  it('applies the template-reference font defaults (size 10, Courier, normal)', () => {
    const t = leafText(el('<draw><value><text>hi</text></value></draw>'));
    expect(t.kind).toBe('text');
    expect(t.paras).toHaveLength(1);
    expect(t.paras[0].runs).toEqual([{ text: 'hi', family: ['Courier'], size: 10, bold: false, italic: false }]);
  });

  it('reads <font>, <para>, <margin> and splits records on newlines', () => {
    const t = leafText(el(
      '<draw><font typeface="Arial" size="9pt" weight="bold" posture="italic"/>'
      + '<para marginLeft="2pt" marginRight="3pt" textIndent="4pt" lineHeight="12pt" spaceAbove="1pt" spaceBelow="5pt"/>'
      + '<margin leftInset="1pt" rightInset="2pt" topInset="3pt" bottomInset="4pt"/>'
      + '<value><text>a\nb</text></value></draw>'));
    expect(t.paras.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['a', 'b']);
    expect(t.paras[0].runs[0]).toMatchObject({ family: ['Arial'], size: 9, bold: true, italic: true });
    expect(t.paras[0]).toMatchObject({ marginLeft: 2, marginRight: 3, textIndent: 4, lineHeight: 12, spaceAbove: 1, spaceBelow: 5 });
    expect(t.insets).toEqual({ l: 1, r: 2, t: 3, b: 4 });
  });

  it('gives an empty value one empty paragraph, which measures one line', () => {
    const t = leafText(el('<field><ui><textEdit/></ui><font typeface="Arial"/></field>'));
    expect(t.paras).toHaveLength(1);
    expect(t.paras[0].runs).toEqual([]);
    expect(t.paras[0].base).toEqual({ family: ['Arial'], size: 10, bold: false, italic: false });
  });

  it('withValue replaces the default with a bound value', () => {
    const t = withValue(leafText(el('<field><ui><textEdit/></ui><value><text>x</text></value></field>')), 'p\nq');
    expect(t.paras.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['p', 'q']);
  });

  it('marks a password field and a picture clause', () => {
    expect(leafText(el('<field><ui><passwordEdit/></ui></field>')).password).toBe(true);
    const pic = leafText(el('<field><ui><textEdit/></ui><format><picture>999</picture></format></field>'));
    expect(pic.picture).toBe(true);
    expect(withValue(pic, '12').refusal).toMatch(/display picture/);
    expect(withValue(pic, '').refusal).toBeUndefined();
  });
});

describe('leafText: captions', () => {
  it('reads placement (default left) and reserve', () => {
    expect(leafText(el('<field><ui><textEdit/></ui><caption reserve="20mm"/></field>')).caption)
      .toEqual({ placement: 'left', reserve: 20 * 72 / 25.4 });
    expect(leafText(el('<field><ui><textEdit/></ui><caption placement="top"/></field>')).caption)
      .toEqual({ placement: 'top' });
  });

  // Review Focus 4: a hidden caption takes no space, so its missing reserve is
  // not a reason to refuse.
  it('ignores a hidden or inactive caption', () => {
    expect(leafText(el('<field><ui><textEdit/></ui><caption presence="hidden"/></field>')).caption).toBeUndefined();
    expect(leafText(el('<field><ui><textEdit/></ui><caption presence="inactive"/></field>')).caption).toBeUndefined();
  });
});

describe('leafText: rich text (XFA 3.3 ch. 27)', () => {
  const rich = (body: string, font = '<font typeface="Arial"/>') => leafText(el(
    `<draw>${font}<value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">${body}</body></exData></value></draw>`));

  it('reads OPM 1644 Q1: spans inherit, a 9pt italic span, spacerun spaces', () => {
    const t = rich('<p>1. Type of provider<span style="xfa-spacerun:yes"> </span>'
      + '<span style="font-size:9pt;font-style:italic">(Check one)<span style="xfa-spacerun:yes"> </span></span></p>');
    expect(t.paras).toHaveLength(1);
    const runs = t.paras[0].runs;
    expect(runs.map((r) => r.text).join('')).toBe('1. Type of provider (Check one) ');
    expect(runs[0]).toMatchObject({ family: ['Arial'], size: 10, italic: false });
    expect(runs.find((r) => r.text.includes('Check'))).toMatchObject({ size: 9, italic: true });
  });

  it('reads b, i, br, font-family lists and paragraph margins', () => {
    const t = rich('<p style="margin-top:2pt;margin-bottom:3pt;margin-left:4pt;text-indent:1pt">a<b>b</b><i>c</i><br/>d</p>'
      + '<p style="font-family:\'Times New Roman\', serif;font-weight:bold">e</p>');
    expect(t.paras).toHaveLength(2);
    expect(t.paras[0]).toMatchObject({ spaceAbove: 2, spaceBelow: 3, marginLeft: 4, textIndent: 1 });
    expect(t.paras[0].runs.map((r) => [r.text, r.bold, r.italic])).toEqual([['a', false, false], ['b', true, false], ['c', false, true], ['\nd', false, false]]);
    expect(t.paras[1].runs[0]).toMatchObject({ family: ['Times New Roman', 'serif'], bold: true });
  });

  it('collapses whitespace outside a spacerun', () => {
    const t = rich('<p>a   b\n  c</p>');
    expect(t.paras[0].runs.map((r) => r.text).join('')).toBe('a b c');
  });

  // Review Focus 2: p. 1187 -- an unrecognised element is ignored WITH its content.
  it('drops an unrecognised element and its content', () => {
    const t = rich('<p>a<script>evil</script><div>gone</div>b</p>');
    expect(t.paras[0].runs.map((r) => r.text).join('')).toBe('ab');
  });

  it('refuses what changes a size and is not modelled', () => {
    expect(rich('<p>a<sub>2</sub></p>').refusal).toMatch(/sub/);
    expect(rich('<p style="letter-spacing:1pt">a</p>').refusal).toMatch(/letter-spacing/);
    expect(rich('<ul><li>a</li></ul>').refusal).toMatch(/list/);
    expect(rich('<p style="font-size:12px">a</p>').refusal).toMatch(/font-size/);
    expect(rich('<p>a<span style="xfa-spacerun:yes">  </span>b</p>').refusal).toMatch(/spacerun/);
  });
});

describe('leafText: refusals and geometry', () => {
  it('refuses non-default font and para features', () => {
    expect(leafText(el('<draw><font letterSpacing="1pt"/><value><text>a</text></value></draw>')).refusal).toMatch(/letterSpacing/);
    expect(leafText(el('<draw><font kerningMode="pair"/><value><text>a</text></value></draw>')).refusal).toMatch(/kerningMode/);
    expect(leafText(el('<draw><font fontHorizontalScale="90%"/><value><text>a</text></value></draw>')).refusal).toMatch(/fontHorizontalScale/);
    expect(leafText(el('<draw><font baselineShift="2pt"/><value><text>a</text></value></draw>')).refusal).toMatch(/baselineShift/);
    expect(leafText(el('<draw><para hAlign="radix"/><value><text>a</text></value></draw>')).refusal).toMatch(/radix/);
    expect(leafText(el('<draw><value><text>a\tb</text></value></draw>')).refusal).toMatch(/tab/);
    expect(leafText(el('<draw><para><hyphenation hyphenate="1"/></para><value><text>a</text></value></draw>')).refusal).toMatch(/hyphenat/);
  });

  it('refuses a growable field whose ui is not text-like', () => {
    expect(leafText(el('<field><ui><checkButton/></ui></field>')).refusal).toMatch(/checkButton/);
    expect(leafText(el('<field><ui><choiceList/></ui></field>')).refusal).toMatch(/choiceList/);
  });

  it('treats a rectangle, line or arc draw as geometry and refuses an image', () => {
    expect(leafText(el('<draw><value><rectangle/></value></draw>')).kind).toBe('geometry');
    expect(leafText(el('<draw><value><line/></value></draw>')).kind).toBe('geometry');
    expect(leafText(el('<draw><value><image/></value></draw>')).refusal).toMatch(/image/);
  });

  it('never throws on junk', () => {
    expect(() => leafText(el('<draw><font size="huge"/><value><text>a</text></value></draw>'))).not.toThrow();
    expect(leafText(el('<draw><font size="huge"/><value><text>a</text></value></draw>')).refusal).toMatch(/size/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xfarich.test.ts`
Expected: FAIL — `Cannot find module '../src/xfarich.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/xfarich.ts
/**
 * What an XFA leaf (`<field>` or `<draw>`) asks to be measured with (`164g.7`):
 * its value as paragraphs of styled runs, its insets and its caption.
 *
 * **Invariant: a pure leaf over `xml.js`, `xfageom.js` and the CSS parser.** No
 * `Document`, no font, no PDF object, and it never throws -- what cannot be
 * modelled is `refusal`, which the converter turns into a reason.
 *
 * Every rule is XFA 3.3's: font defaults from the Template Reference `font`
 * element (p. 743: size 10pt, typeface Courier, weight and posture normal --
 * the p. 58 prose says the default weight is bold, and the normative syntax
 * wins); rich text from ch. 27 (p. 1187-1221), where an UNRECOGNISED element is
 * ignored with its content, unlike `richtext.ts`'s transparent rule for /RC.
 */
import type { XmlNode } from './xml.js';
import { measureToPt } from './xfageom.js';
import { parseDeclarationList, type CssValue } from './cssparse.js';
import { trimWs } from './cssvalue.js';

export interface RunStyle { family: string[]; size: number; bold: boolean; italic: boolean }
export interface RunSpec extends RunStyle { text: string }
export interface ParaSpec {
  runs: RunSpec[];
  /** The style an empty paragraph (or an empty line) measures in. */
  base: RunStyle;
  marginLeft: number; marginRight: number; textIndent: number;
  lineHeight: number; spaceAbove: number; spaceBelow: number;
}
export type CaptionSide = 'left' | 'right' | 'top' | 'bottom';
export interface LeafText {
  /** `geometry`: a rectangle, line or arc draw, sized by `min*` alone (p. 276). */
  kind: 'text' | 'geometry';
  paras: ParaSpec[];
  insets: { l: number; r: number; t: number; b: number };
  caption?: { placement: CaptionSide; reserve?: number };
  password: boolean;
  /** The field states a display `<format><picture>`, which is not formatted. */
  picture: boolean;
  refusal?: string;
}

type ParaBox = Omit<ParaSpec, 'runs' | 'base'>;
const ZERO_PARA: ParaBox = { marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 };
const DEFAULT_STYLE: RunStyle = { family: ['Courier'], size: 10, bold: false, italic: false };
const TEXT_UI = new Set(['textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit']);
const GEOMETRY = new Set(['rectangle', 'line', 'arc']);

const child = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);

/** A measurement in points, or a refusal naming the attribute. */
function pt(v: string | undefined, what: string, fallback: number): number | { refusal: string } {
  if (v === undefined || v === '') return fallback;
  const p = measureToPt(v);
  return p === undefined ? { refusal: `${what}="${v}" could not be read as a measurement` } : p;
}

/** The leaf's own <font>, or why it cannot be measured with. */
function fontOf(el: XmlNode): RunStyle | { refusal: string } {
  const f = child(el, 'font');
  if (!f) return { ...DEFAULT_STYLE };
  const size = pt(f.attrs.get('size'), 'font size', 10);
  if (typeof size === 'object') return size;
  const bs = f.attrs.get('baselineShift');
  if (bs !== undefined && bs !== '' && measureToPt(bs) !== 0)
    return { refusal: `font baselineShift="${bs}" is not measured` };
  for (const k of ['fontHorizontalScale', 'fontVerticalScale'] as const) {
    const v = f.attrs.get(k);
    if (v !== undefined && v !== '' && v.trim() !== '100%') return { refusal: `font ${k}="${v}" is not measured` };
  }
  const ls = f.attrs.get('letterSpacing');
  if (ls !== undefined && ls !== '' && measureToPt(ls) !== 0) return { refusal: `font letterSpacing="${ls}" is not measured` };
  if (f.attrs.get('kerningMode') === 'pair') return { refusal: 'font kerningMode="pair" is not measured' };
  const face = f.attrs.get('typeface');
  return {
    family: [face !== undefined && face !== '' ? face : 'Courier'],
    size,
    bold: f.attrs.get('weight') === 'bold',
    italic: f.attrs.get('posture') === 'italic',
  };
}

function paraOf(el: XmlNode): ParaBox | { refusal: string } {
  const p = child(el, 'para');
  if (!p) return { ...ZERO_PARA };
  if (p.attrs.get('hAlign') === 'radix') return { refusal: 'para hAlign="radix" is not measured' };
  const hy = child(p, 'hyphenation');
  if (hy && hy.attrs.get('hyphenate') === '1') return { refusal: 'para hyphenation is not measured' };
  const out = { ...ZERO_PARA };
  for (const k of Object.keys(ZERO_PARA) as (keyof ParaBox)[]) {
    const v = pt(p.attrs.get(k), `para ${k}`, 0);
    if (typeof v === 'object') return v;
    out[k] = v;
  }
  return out;
}

function insetsOf(el: XmlNode): LeafText['insets'] | { refusal: string } {
  const m = child(el, 'margin');
  const out = { l: 0, r: 0, t: 0, b: 0 };
  if (!m) return out;
  const keys = { l: 'leftInset', r: 'rightInset', t: 'topInset', b: 'bottomInset' } as const;
  for (const [k, a] of Object.entries(keys) as [keyof typeof keys, string][]) {
    const v = pt(m.attrs.get(a), `margin ${a}`, 0);
    if (typeof v === 'object') return v;
    out[k] = v;
  }
  return out;
}

function captionOf(el: XmlNode): LeafText['caption'] | { refusal: string } | undefined {
  const c = child(el, 'caption');
  if (!c) return undefined;
  const presence = c.attrs.get('presence');
  if (presence === 'hidden' || presence === 'inactive') return undefined;
  const pl = c.attrs.get('placement') ?? 'left';
  if (pl !== 'left' && pl !== 'right' && pl !== 'top' && pl !== 'bottom')
    return { refusal: `caption placement="${pl}" is not one of the four` };
  const r = c.attrs.get('reserve');
  if (r === undefined || r === '') return { placement: pl };
  const v = measureToPt(r);
  return v === undefined ? { refusal: `caption reserve="${r}" could not be read as a measurement` } : { placement: pl, reserve: v };
}

/** Plain text: one paragraph per record (p. 56: a newline or U+2029 delimits a
 *  record). An empty string is ONE empty paragraph, which measures one line. */
export function plainParas(text: string, base: RunStyle, para: ParaBox): ParaSpec[] {
  return text.split(/\r\n|\r|\n| /).map((rec) => ({
    ...para, base, runs: rec === '' ? [] : [{ ...base, text: rec }],
  }));
}

// ---- rich text ------------------------------------------------------------------

/** p. 1187-1188: the elements, and the CSS properties that change no size. */
const INLINE = new Set(['span', 'b', 'i', 'a']);
const CONTAINER = new Set(['html', 'body']);
const NO_SIZE = new Set(['color', 'text-decoration', 'orphans', 'widows', 'page-break-after',
  'page-break-before', 'page-break-inside', 'text-align']);

interface Ctx { style: RunStyle; spacerun: boolean }

function familyList(v: CssValue[]): string[] | undefined {
  const out: string[] = [];
  let cur: string[] = [];
  for (const t of v) {
    if (t.kind === 'comma') { if (cur.length) out.push(cur.join(' ')); cur = []; continue; }
    if (t.kind === 'ident' || t.kind === 'string') cur.push(t.value);
  }
  if (cur.length) out.push(cur.join(' '));
  return out.length ? out : undefined;
}

function cssPt(t: CssValue): number | undefined {
  if (t.kind === 'number') return t.value === 0 ? 0 : undefined;
  if (t.kind !== 'dimension') return undefined;
  return measureToPt(`${t.repr}${t.unit}`);
}

/** Apply one element's `style`; a refusal names the property. */
function applyCss(css: string, ctx: Ctx, para: ParaBox | undefined): Ctx | { refusal: string } {
  const style = { ...ctx.style };
  let spacerun = ctx.spacerun;
  for (const d of parseDeclarationList(css)) {
    if (d.kind !== 'declaration') continue;
    const name = d.name.toLowerCase();
    const v = trimWs(d.value);
    if (v.length === 0 || NO_SIZE.has(name)) continue;
    const kw = v.length === 1 && v[0].kind === 'ident' ? v[0].value.toLowerCase() : undefined;
    switch (name) {
      case 'font-size': {
        const p = v.length === 1 ? cssPt(v[0]) : undefined;
        if (p === undefined || p <= 0) return { refusal: `font-size in rich text could not be read in points` };
        style.size = p; break;
      }
      case 'font-weight':
        if (kw === 'bold') style.bold = true;
        else if (kw === 'normal') style.bold = false;
        else if (v.length === 1 && v[0].kind === 'number') style.bold = v[0].value >= 600;
        else return { refusal: 'font-weight in rich text could not be read' };
        break;
      case 'font-style':
        if (kw === 'italic' || kw === 'oblique') style.italic = true;
        else if (kw === 'normal') style.italic = false;
        else return { refusal: 'font-style in rich text could not be read' };
        break;
      case 'font-family': {
        const f = familyList(v);
        if (!f) return { refusal: 'font-family in rich text could not be read' };
        style.family = f; break;
      }
      case 'font-stretch':
        if (kw !== 'normal') return { refusal: 'font-stretch in rich text is not measured' };
        break;
      case 'xfa-spacerun':
        spacerun = kw === 'yes'; break;
      case 'margin-top': case 'margin-bottom': case 'margin-left': case 'margin-right':
      case 'text-indent': case 'line-height': {
        const p = v.length === 1 ? cssPt(v[0]) : undefined;
        if (p === undefined) return { refusal: `${name} in rich text could not be read in points` };
        if (!para) return { refusal: `${name} on an inline element is not measured` };
        const key = ({ 'margin-top': 'spaceAbove', 'margin-bottom': 'spaceBelow', 'margin-left': 'marginLeft',
          'margin-right': 'marginRight', 'text-indent': 'textIndent', 'line-height': 'lineHeight' } as const)[name];
        para[key] = p; break;
      }
      case 'letter-spacing':
        if (!(v.length === 1 && cssPt(v[0]) === 0) && kw !== 'normal') return { refusal: 'letter-spacing in rich text is not measured' };
        break;
      case 'kerning-mode':
        if (kw !== 'none') return { refusal: 'kerning-mode in rich text is not measured' };
        break;
      case 'vertical-align':
        if (kw !== 'baseline') return { refusal: 'vertical-align in rich text is not measured' };
        break;
      default:
        // margin shorthand, tab stops, font shorthand, font scale: not modelled.
        return { refusal: `${name} in rich text is not measured` };
    }
  }
  return { style, spacerun };
}

class RichBuilder {
  readonly paras: ParaSpec[] = [];
  private cur: ParaSpec | undefined;
  refusal: string | undefined;
  constructor(private readonly base: RunStyle, private readonly para: ParaBox) {}

  open(p: ParaBox, s: RunStyle): void { this.close(); this.cur = { ...p, base: s, runs: [] }; }
  close(): void {
    const p = this.cur;
    this.cur = undefined;
    if (!p) return;
    const last = p.runs[p.runs.length - 1];
    if (last) last.text = last.text.replace(/ +$/, '');
    if (last && last.text === '') p.runs.pop();
    this.paras.push(p);
  }
  private para0(s: RunStyle): ParaSpec {
    if (!this.cur) this.cur = { ...this.para, base: s, runs: [] };
    return this.cur;
  }
  text(raw: string, ctx: Ctx): void {
    const p = this.para0(ctx.style);
    let t: string;
    if (ctx.spacerun) {
      // p. 1220: each U+00A0 or space in a spacerun is one space. Two or more
      // would be collapsed by layoutRuns, changing the wrap: refuse.
      t = raw.replace(/ /g, ' ').replace(/[\t\r\n]/g, '');
      if (/ {2,}/.test(t)) { this.refusal ??= 'two or more spaces in an xfa-spacerun span are not measured'; return; }
    } else {
      t = raw.replace(/[ \t\r\n\f]+/g, ' ');
      const prev = p.runs[p.runs.length - 1];
      if (!prev || /[ \n]$/.test(prev.text)) t = t.replace(/^ /, '');
    }
    if (t === '') return;
    const prev = p.runs[p.runs.length - 1];
    const s = ctx.style;
    if (prev && prev.size === s.size && prev.bold === s.bold && prev.italic === s.italic
      && prev.family.join('\0') === s.family.join('\0')) prev.text += t;
    else p.runs.push({ ...s, text: t });
  }
  br(ctx: Ctx): void {
    const p = this.para0(ctx.style);
    const prev = p.runs[p.runs.length - 1];
    if (prev) prev.text = prev.text.replace(/ +$/, '');
    p.runs.push({ ...ctx.style, text: '\n' });
  }
}

function walkRich(n: XmlNode, ctx: Ctx, b: RichBuilder): void {
  for (const c of n.nodes) {
    if (b.refusal) return;
    if (typeof c === 'string') { b.text(c, ctx); continue; }
    const name = c.name.toLowerCase();
    if (name === 'br') { b.br(ctx); continue; }
    if (name === 'sub' || name === 'sup') { b.refusal = `<${name}> in rich text is not measured`; return; }
    if (name === 'ol' || name === 'ul' || name === 'li') { b.refusal = 'a list in rich text is not measured'; return; }
    if (name === 'span' && c.attrs.has('embed')) { b.refusal = 'an embedded-object span is not measured'; return; }
    const isP = name === 'p';
    if (!isP && !INLINE.has(name) && !CONTAINER.has(name)) continue; // p. 1187: dropped with content
    const para: ParaBox | undefined = isP ? { ...ZERO_PARA } : undefined;
    let next: Ctx = { ...ctx, style: { ...ctx.style } };
    if (name === 'b') next.style.bold = true;
    if (name === 'i') next.style.italic = true;
    const css = c.attrs.get('style');
    if (css !== undefined) {
      const r = applyCss(css, next, para);
      if ('refusal' in r) { b.refusal = r.refusal; return; }
      next = r;
    }
    if (isP) b.open(para!, next.style);
    walkRich(c, next, b);
    if (isP) b.close();
  }
}

/** The leaf's whole measurable description. Never throws. */
export function leafText(el: XmlNode): LeafText {
  const insets = insetsOf(el);
  const font = fontOf(el);
  const para = paraOf(el);
  const caption = el.name === 'field' ? captionOf(el) : undefined;
  const uiEl = child(el, 'ui')?.children[0];
  const fmt = child(el, 'format');
  const out: LeafText = {
    kind: 'text', paras: [],
    insets: 'refusal' in insets ? { l: 0, r: 0, t: 0, b: 0 } : insets,
    ...(caption && !('refusal' in caption) ? { caption } : {}),
    password: uiEl?.name === 'passwordEdit',
    picture: fmt !== undefined && child(fmt, 'picture') !== undefined,
  };
  const fail = [insets, font, para, caption].find((x) => x !== undefined && 'refusal' in x) as { refusal: string } | undefined;
  if (fail) return { ...out, refusal: fail.refusal };
  const base = font as RunStyle;
  const pb = para as ParaBox;
  if (el.name === 'field' && uiEl && !TEXT_UI.has(uiEl.name))
    return { ...out, refusal: `a growable <${uiEl.name}> field is not measured` };
  const value = child(el, 'value');
  const v = value?.children[0];
  if (v && GEOMETRY.has(v.name)) return { ...out, kind: 'geometry' };
  if (v && v.name === 'image') return { ...out, refusal: 'a growable image draw is not measured' };
  if (v && v.name === 'exData') {
    const ct = v.attrs.get('contentType');
    if (ct !== 'text/html') return { ...out, refusal: `exData contentType="${ct ?? ''}" is not measured` };
    const b = new RichBuilder(base, pb);
    walkRich(v, { style: base, spacerun: false }, b);
    b.close();
    // A refusal about the VALUE keeps the base paragraph, so a bound datasets
    // value can still replace it (withValue); every other refusal has none.
    if (b.refusal) return { ...out, paras: plainParas('', base, pb), refusal: b.refusal };
    const paras = b.paras.length ? b.paras : plainParas('', base, pb);
    return { ...out, paras };
  }
  const text = v ? v.text : '';
  const keep = plainParas('', base, pb);
  if (text.includes('\t')) return { ...out, paras: keep, refusal: 'a tab character is not measured' };
  if (out.picture && text !== '') return { ...out, paras: keep, refusal: 'a value under a display picture is not formatted' };
  return { ...out, paras: plainParas(text, base, pb) };
}

/** A field's description with its bound datasets value as plain text. */
export function withValue(t: LeafText, value: string): LeafText {
  if (t.kind !== 'text') return t;
  // A refusal with no paragraph is about the font, para, insets or ui, which
  // the value does not change.
  if (t.refusal !== undefined && t.paras.length === 0) return t;
  const { refusal: _ignored, ...rest } = t;
  if (value.includes('\t')) return { ...rest, refusal: 'a tab character is not measured' };
  if (t.picture && value !== '') return { ...rest, refusal: 'a value under a display picture is not formatted' };
  const p = t.paras[0];
  const base = p ? p.base : DEFAULT_STYLE;
  const box: ParaBox = p ? { marginLeft: p.marginLeft, marginRight: p.marginRight, textIndent: p.textIndent,
    lineHeight: p.lineHeight, spaceAbove: p.spaceAbove, spaceBelow: p.spaceBelow } : { ...ZERO_PARA };
  return { ...rest, paras: plainParas(value, base, box) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/xfarich.test.ts`
Expected: PASS. Then add one case pinning the rule just added:

```ts
  it('withValue keeps a refusal that is not about the value', () => {
    const t = leafText(el('<field><ui><textEdit/></ui><font letterSpacing="1pt"/></field>'));
    expect(withValue(t, 'x').refusal).toMatch(/letterSpacing/);
  });
```
Run again: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no output (clean).

```bash
git add src/xfarich.ts test/xfarich.test.ts
git commit -m "feat(164g.7): xfarich -- an XFA leaf's text, font, para and caption

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `xfatext.ts` — measure a `LeafText` at a box

**Files:**
- Create: `src/xfatext.ts`
- Test: `test/xfatext.test.ts`

**Interfaces:**
- Consumes: `LeafText`, `RunStyle` (Task 1); `layoutRuns`, `FontDriver`, `TextLayoutRun` (`src/layout.ts`).
- Produces:
  ```ts
  export interface FaceMetrics { unitsPerEm: number; ascent: number; descent: number; advance(cp: number): number | undefined }
  export type FaceLookup = (style: RunStyle, text: string) => FaceMetrics | { reason: string };
  export type MeasureBox = { width: number } | { maxWidth?: number };
  export function measureLeaf(t: LeafText, box: MeasureBox, faces: FaceLookup): { w: number; h: number } | { reason: string };
  ```
  `ascent` and `descent` are both POSITIVE font units (hhea ascender, minus hhea descender).

- [ ] **Step 1: Write the failing test**

```ts
// test/xfatext.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, withValue, type RunStyle } from '../src/xfarich.js';
import { measureLeaf, type FaceLookup, type FaceMetrics } from '../src/xfatext.js';

const el = (xml: string) => leafText(parseXml(new TextEncoder().encode(xml)));
/** 'Mono': every glyph 500/1000 wide, ascent 800, descent 200 -> a 10pt line is
 *  10pt tall and each character 5pt wide. 'Tall' doubles the ascent. The bullet
 *  U+2022 is missing from 'Mono'. */
const MONO: FaceMetrics = { unitsPerEm: 1000, ascent: 800, descent: 200, advance: (cp) => (cp === 0x2022 ? undefined : 500) };
const TALL: FaceMetrics = { unitsPerEm: 1000, ascent: 1600, descent: 200, advance: () => 500 };
const faces: FaceLookup = (s: RunStyle, text: string) => {
  const m = s.family[0] === 'Tall' ? TALL : s.family[0] === 'Mono' ? MONO : undefined;
  if (!m) return { reason: `no face for ${s.family.join(',')}` };
  for (const ch of text) if (ch !== '\n' && m.advance(ch.codePointAt(0)!) === undefined) return { reason: 'uncovered' };
  return m;
};
const draw = (text: string, extra = '') => el(`<draw><font typeface="Mono" size="10pt"/>${extra}<value><text>${text}</text></value></draw>`);

describe('measureLeaf', () => {
  it('wraps at a fixed width and grows in height', () => {
    // 'aaaa bbbb' = 45pt; a 30pt box holds one word per line.
    expect(measureLeaf(draw('aaaa bbbb'), { width: 30 }, faces)).toEqual({ w: 30, h: 20 });
    expect(measureLeaf(draw('aaaa bbbb'), { width: 100 }, faces)).toEqual({ w: 100, h: 10 });
  });

  it('grows in width to the longest line, breaking only at newlines', () => {
    expect(measureLeaf(draw('aa\naaaa'), {}, faces)).toEqual({ w: 20, h: 20 });
  });

  it('wraps a width-growable leaf at maxWidth', () => {
    expect(measureLeaf(draw('aaaa bbbb'), { maxWidth: 30 }, faces)).toEqual({ w: 20, h: 20 });
  });

  it('adds insets, paragraph margins, first-line indent and a caption reserve', () => {
    const t = draw('aa', '<margin leftInset="1pt" rightInset="2pt" topInset="3pt" bottomInset="4pt"/>'
      + '<para marginLeft="5pt" marginRight="6pt" textIndent="7pt"/>');
    expect(measureLeaf(t, {}, faces)).toEqual({ w: 1 + 2 + 5 + 6 + 7 + 10, h: 3 + 4 + 10 });
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption reserve="15pt"/><value><text>aa</text></value></field>');
    expect(measureLeaf(f, {}, faces)).toEqual({ w: 25, h: 10 });
    const top = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption placement="top" reserve="6pt"/><value><text>aa</text></value></field>');
    expect(measureLeaf(top, {}, faces)).toEqual({ w: 10, h: 16 });
  });

  it('refuses a measured caption that states no reserve', () => {
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption/><value><text>a</text></value></field>');
    expect(measureLeaf(f, { width: 50 }, faces)).toMatchObject({ reason: expect.stringMatching(/caption.*reserve/) });
  });

  it('takes the line height from the tallest face on the line, and lineHeight when greater', () => {
    const rich = el('<draw><font typeface="Mono"/><value><exData contentType="text/html"><body>'
      + '<p>a<span style="font-family:Tall">b</span></p><p>c</p></body></exData></value></draw>');
    expect(measureLeaf(rich, { width: 100 }, faces)).toEqual({ w: 100, h: 18 + 10 });
    expect(measureLeaf(draw('a', '<para lineHeight="14pt"/>'), { width: 100 }, faces)).toEqual({ w: 100, h: 14 });
  });

  it('adds the larger of spaceBelow and spaceAbove between paragraphs only', () => {
    const t = draw('a\nb', '<para spaceAbove="2pt" spaceBelow="5pt"/>');
    expect(measureLeaf(t, { width: 100 }, faces)).toEqual({ w: 100, h: 10 + 5 + 10 });
  });

  it('measures an empty field as one empty line in its own font', () => {
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono" size="12pt"/></field>');
    expect(measureLeaf(f, { width: 50 }, faces)).toEqual({ w: 50, h: 12 });
  });

  it('measures a password by its mask, falling back to * where the face has no bullet', () => {
    const f = withValue(el('<field><ui><passwordEdit/></ui><font typeface="Mono"/></field>'), 'secret');
    expect(measureLeaf(f, {}, faces)).toEqual({ w: 30, h: 10 });
  });

  it('refuses a face that will not resolve, and a box with no room', () => {
    expect(measureLeaf(el('<draw><font typeface="Nope"/><value><text>a</text></value></draw>'), {}, faces))
      .toMatchObject({ reason: expect.stringMatching(/Nope/) });
    expect(measureLeaf(draw('a', '<margin leftInset="30pt"/>'), { width: 20 }, faces))
      .toMatchObject({ reason: expect.stringMatching(/no room/) });
  });

  it('refuses edge whitespace on a width-growable leaf only', () => {
    const t = withValue(el('<field><ui><textEdit/></ui><font typeface="Mono"/></field>'), ' a');
    expect(measureLeaf(t, {}, faces)).toMatchObject({ reason: expect.stringMatching(/whitespace/) });
    expect(measureLeaf(t, { width: 50 }, faces)).toEqual({ w: 50, h: 10 });
  });

  it('passes a refusal through and sizes geometry at zero', () => {
    expect(measureLeaf(el('<draw><font letterSpacing="1pt"/><value><text>a</text></value></draw>'), {}, faces))
      .toMatchObject({ reason: expect.stringMatching(/letterSpacing/) });
    expect(measureLeaf(el('<draw><value><rectangle/></value></draw>'), {}, faces)).toEqual({ w: 0, h: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xfatext.test.ts`
Expected: FAIL — `Cannot find module '../src/xfatext.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/xfatext.ts
/**
 * The nominal size of an XFA leaf's text (`164g.7`), XFA 3.3 p. 56-61 and
 * p. 275-279.
 *
 * **Invariant: a pure leaf.** Faces arrive through `FaceLookup`, so every rule
 * is testable from synthetic metrics. It never throws.
 *
 * **Invariant: ONE wrapping engine.** Lines are broken by `layoutRuns`; only the
 * line HEIGHT is computed here, because XFA's is the tallest glyph box on the
 * line (p. 61) where `layoutRuns` uses a leading. Read as hhea ascender minus
 * descender -- pdf.js measures 10pt Arial as exactly that, 11.17pt.
 */
import { layoutRuns, type FontDriver, type TextLayoutRun } from './layout.js';
import type { LeafText, ParaSpec, RunStyle } from './xfarich.js';

export interface FaceMetrics {
  unitsPerEm: number;
  /** hhea ascender, font units, positive. */
  ascent: number;
  /** minus hhea descender, font units, positive. */
  descent: number;
  /** Advance in font units, or undefined when the face has no glyph. */
  advance(cp: number): number | undefined;
}
export type FaceLookup = (style: RunStyle, text: string) => FaceMetrics | { reason: string };
export type MeasureBox = { width: number } | { maxWidth?: number };

const EMPTY = new Uint8Array(0);
const WIDE = 1e9;
const EPS = 1e-9;

function driverFor(m: FaceMetrics): FontDriver {
  const units = (t: string): number => {
    let s = 0;
    for (const ch of t) s += m.advance(ch.codePointAt(0)!) ?? 0;
    return s;
  };
  return {
    measure: (t, fs) => (units(t) * fs) / m.unitsPerEm,
    encode: () => EMPTY,
    probe: (t) => [...t].filter((ch) => m.advance(ch.codePointAt(0)!) !== undefined).length,
  };
}

const extent = (m: FaceMetrics, size: number) => ({
  asc: (m.ascent * size) / m.unitsPerEm, desc: (m.descent * size) / m.unitsPerEm,
});

/** A password's mask: U+2022 where the face draws it, else `*`. */
function mask(t: LeafText, faces: FaceLookup): LeafText {
  const paras = t.paras.map((p) => ({
    ...p,
    runs: p.runs.map((r) => {
      const bullet = !('reason' in faces(r, '•'));
      return { ...r, text: r.text.replace(/[^\n]/gu, bullet ? '•' : '*') };
    }),
  }));
  return { ...t, paras };
}

interface ParaSize { w: number; h: number }

function measurePara(p: ParaSpec, width: number, grow: boolean, faces: FaceLookup): ParaSize | { reason: string } {
  const avail = width - p.marginLeft - p.marginRight;
  if (avail <= EPS) return { reason: 'its paragraph margins leave no room for its text' };
  const baseLine = (s: RunStyle): number | { reason: string } => {
    const m = faces(s, '');
    if ('reason' in m) return m;
    const e = extent(m, s.size);
    return Math.max(e.asc + e.desc, p.lineHeight);
  };
  if (p.runs.length === 0) {
    const h = baseLine(p.base);
    return typeof h === 'number' ? { w: p.marginLeft + p.marginRight, h } : h;
  }
  if (grow) {
    for (const line of p.runs.map((r) => r.text).join('').split('\n'))
      if (/^ | $/.test(line)) return { reason: 'its width depends on leading or trailing whitespace, which is not measured' };
  }
  const metrics: FaceMetrics[] = [];
  const runs: TextLayoutRun[] = [];
  for (const r of p.runs) {
    const m = faces(r, r.text);
    if ('reason' in m) return m;
    metrics.push(m);
    runs.push({ text: r.text, driver: driverFor(m), fontSize: r.size });
  }
  const res = layoutRuns(runs, avail, WIDE, 1, p.base.size, p.textIndent);
  let h = 0;
  let w = 0;
  res.lines.forEach((line, i) => {
    let asc = 0;
    let desc = 0;
    for (const seg of line.segments) {
      const e = extent(metrics[seg.run], p.runs[seg.run].size);
      asc = Math.max(asc, e.asc);
      desc = Math.max(desc, e.desc);
    }
    if (line.segments.length === 0) {
      const e = extent(metrics[0], p.base.size);
      asc = e.asc; desc = e.desc;
    }
    h += Math.max(asc + desc, p.lineHeight);
    w = Math.max(w, line.width + (i === 0 ? p.textIndent : 0));
  });
  return { w: w + p.marginLeft + p.marginRight, h };
}

/** The leaf's nominal extent at `box`, insets and caption included. */
export function measureLeaf(
  t0: LeafText, box: MeasureBox, faces: FaceLookup,
): { w: number; h: number } | { reason: string } {
  if (t0.refusal !== undefined) return { reason: t0.refusal };
  if (t0.kind === 'geometry') return { w: 0, h: 0 };
  const t = t0.password ? mask(t0, faces) : t0;
  const cap = t.caption;
  if (cap && cap.reserve === undefined)
    return { reason: 'its caption states no reserve, so the room left for its text is not known' };
  const capW = cap && (cap.placement === 'left' || cap.placement === 'right') ? cap.reserve! : 0;
  const capH = cap && (cap.placement === 'top' || cap.placement === 'bottom') ? cap.reserve! : 0;
  const { l, r, t: top, b } = t.insets;
  const fixed = 'width' in box ? box.width : undefined;
  const limit = fixed ?? ('maxWidth' in box && box.maxWidth !== undefined ? box.maxWidth : undefined);
  const wrapAt = limit === undefined ? WIDE : limit - l - r - capW;
  if (wrapAt <= EPS) return { reason: 'its insets and caption leave no room for its text' };
  let h = 0;
  let w = 0;
  let prev: ParaSpec | undefined;
  for (const p of t.paras) {
    const s = measurePara(p, wrapAt, fixed === undefined, faces);
    if ('reason' in s) return s;
    if (prev) h += Math.max(prev.spaceBelow, p.spaceAbove);
    h += s.h;
    w = Math.max(w, s.w);
    prev = p;
  }
  return { w: fixed ?? w + l + r + capW, h: h + top + b + capH };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/xfatext.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — clean.

```bash
git add src/xfatext.ts test/xfatext.test.ts
git commit -m "feat(164g.7): xfatext -- measure an XFA leaf's text through layoutRuns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `xfafont.ts` — resolve a face in three tiers

**Files:**
- Create: `src/xfafont.ts`
- Modify: `src/document.ts` (two `@internal` methods beside `renderFontFaces()`, ~line 2262)
- Test: `test/xfafont.test.ts`

**Interfaces:**
- Consumes: `FaceLookup`, `FaceMetrics` (Task 2); `RunStyle` (Task 1); `parseSfnt`, `SfntFont` (`src/sfnt.ts`); `readFontNames` (`src/fontnames.ts`); `familyMatches`, `deriveStyle` (`src/fontmatch.ts`); `getStd14Sfnt` (`src/std14fonts.ts`); `decodeStream` (`src/filters.ts`); `FaceRecord` (`src/fontsource.ts`).
- Produces:
  ```ts
  export function faceLookup(doc: Document): FaceLookup;
  export const XFA_SUBSTITUTES: Readonly<Record<string, readonly [StdFont, StdFont, StdFont, StdFont]>>;
  // Document (@internal):
  registeredFontFaces(): FaceRecord[];
  registeredFaceSfnt(rec: FaceRecord): SfntFont | undefined;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/xfafont.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { faceLookup, XFA_SUBSTITUTES } from '../src/xfafont.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildSigner } from './helpers/build-signer.js';

const opm = () => new Uint8Array(readFileSync(new URL('./fixtures/xfa-dynamic/opm1644.pdf', import.meta.url)));
const style = (family: string[], bold = false, italic = false) => ({ family, size: 10, bold, italic });
const metrics = (r: ReturnType<ReturnType<typeof faceLookup>>) => {
  if ('reason' in r) throw new Error(r.reason);
  return r;
};

describe('faceLookup: tier 1, faces embedded in the document', () => {
  it('finds OPM 1644 Arial by its own name table, with hhea line metrics', () => {
    const faces = faceLookup(Document.Open(opm()));
    const m = metrics(faces(style(['Arial']), 'Type of provider'));
    expect(m.unitsPerEm).toBe(2048);
    expect([m.ascent, m.descent]).toEqual([1854, 434]);
    expect(m.advance(0x41)).toBe(1366);
  });

  it('matches style exactly: Arial italic is a different embedded face from Arial', () => {
    const faces = faceLookup(Document.Open(opm()));
    const i = metrics(faces(style(['Arial'], false, true), 'x'));
    const b = metrics(faces(style(['Arial'], true, false), 'x'));
    expect(b.advance(0x41)).toBe(1479);
    expect(i).not.toBe(metrics(faces(style(['Arial']), 'x')));
  });
});

describe('faceLookup: tier 2, registered folders', () => {
  it('finds a registered face by family when nothing is embedded', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(fileURLToPath(new URL('../fonts/', import.meta.url)));
    const m = metrics(faceLookup(doc)(style(['Liberation Serif'], true)), 'abc'));
    expect(m.unitsPerEm).toBe(2048);
  });
});

describe('faceLookup: tier 3, the closed substitute table', () => {
  it('maps exactly three families onto the bundled Liberation faces', () => {
    expect(Object.keys(XFA_SUBSTITUTES).sort()).toEqual(['arial', 'courier new', 'times new roman']);
    const doc = Document.New();
    const m = metrics(faceLookup(doc)(style(['Times New Roman'], false, true), 'abc'));
    const lib = getStd14Sfnt('Times-Italic')!;
    expect(m.advance(0x61)).toBe(lib.advanceWidth(lib.cmapLookup(0x61)!));
  });

  // Helvetica's vendors' vertical metrics differ from Liberation's: not a substitute.
  it('does not substitute Helvetica, Times or Courier', () => {
    const faces = faceLookup(Document.New());
    for (const f of ['Helvetica', 'Times', 'Courier'])
      expect(faces(style([f]), 'a')).toMatchObject({ reason: expect.stringMatching(new RegExp(f)) });
  });

  // Review Focus 3: a generic keyword never resolves.
  it('never resolves a generic family keyword', () => {
    expect(faceLookup(Document.New())(style(['sans-serif']), 'a'))
      .toMatchObject({ reason: expect.any(String) });
    expect(metrics(faceLookup(Document.New())(style(['sans-serif', 'Arial']), 'a')).unitsPerEm).toBe(2048);
  });
});

describe('faceLookup: coverage and purity', () => {
  it('refuses a character no face covers, naming it', () => {
    expect(faceLookup(Document.New())(style(['Arial']), 'a\u{1F600}'))
      .toMatchObject({ reason: expect.stringMatching(/U\+1F600/) });
  });

  // A lookup must not mark the document modified: the sign path is the only
  // place that can see it (a full rewrite reproduces an untouched model).
  it('writes nothing to the document', async () => {
    const base = opm();
    const doc = Document.Open(base);
    const faces = faceLookup(doc);
    faces(style(['Arial']), 'abc');
    faces(style(['Times New Roman'], true), 'abc');
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(doc.Save().subarray(0, base.length)).toEqual(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xfafont.test.ts`
Expected: FAIL — `Cannot find module '../src/xfafont.js'`.

- [ ] **Step 3: Add the two Document methods**

In `src/document.ts`, directly after `renderFontFaces()`:

```ts
  /** @internal The faces of the folders `LoadFontByName` searches, in
   *  registration order. `xfafont.ts` measures XFA text with them (164g.7)
   *  without going through `LoadFontFamily`, which would create an embeddable
   *  font and change the document. */
  registeredFontFaces(): FaceRecord[] {
    const out: FaceRecord[] = [];
    for (const f of this.fontFolders) out.push(...indexFolder(f.dir, f.sniff));
    return out;
  }

  /** @internal One registered face parsed for measurement only, memoized per
   *  path and face; `undefined` when it will not parse. */
  registeredFaceSfnt(rec: FaceRecord): SfntFont | undefined {
    const key = `${rec.path}#${String(rec.faceIndex)}`;
    if (this.measureFaces.has(key)) return this.measureFaces.get(key) ?? undefined;
    let sfnt: SfntFont | null = null;
    try {
      sfnt = parseSfnt(new Uint8Array(readFileSync(rec.path)), rec.faceIndex, this.loadLimits);
    } catch (caught) { rethrowLimit(caught);
      sfnt = null;
    }
    this.measureFaces.set(key, sfnt);
    return sfnt ?? undefined;
  }
```
and beside `renderFaces` (~line 413) add the field:
```ts
  /** Faces parsed for XFA measurement, keyed `path#faceIndex`; `null` marks
   *  one that would not parse. */
  private readonly measureFaces = new Map<string, SfntFont | null>();
```
Check `parseSfnt`, `readFileSync`, `indexFolder`, `FaceRecord`, `SfntFont` are already imported in `document.ts` (`grep -n "parseSfnt\|readFileSync\|indexFolder\|FaceRecord" src/document.ts | head`); add any missing to the existing import lines.

- [ ] **Step 4: Write `src/xfafont.ts`**

```ts
// src/xfafont.ts
/**
 * Which face measures an XFA run (`164g.7`), in three tiers: embedded in the
 * document, registered font folders, then a CLOSED table of metric-compatible
 * substitutes. The first tier offering a face of exactly the requested family
 * and style that covers every character of the run wins.
 *
 * **Invariant:** an embedded program is identified by its OWN `name` table
 * (`fontnames.ts`), never by `/BaseFont` spelling, so `Arial,Bold` and
 * `ABCDEF+Arial-BoldMT` agree. A bare CFF or Type 1 program has no `name` table
 * and is no candidate.
 *
 * **Invariant:** the substitute table is CLOSED and its faces are the bundled
 * Liberation fonts, which equal Arial and Times New Roman on advances AND on
 * hhea, typo and win line metrics (measured against OPM 1644's embedded faces).
 * Helvetica, Times and Courier are deliberately absent: their vendors' vertical
 * metrics differ from Liberation's, and line height comes from them (p. 61).
 *
 * **Invariant:** nothing is written to the document; `registeredFaceSfnt`
 * parses a file, it never calls `AddFont`.
 */
import type { Document } from './document.js';
import { isDict, isName, isStream } from './types.js';
import { decodeStream } from './filters.js';
import { parseSfnt, type SfntFont } from './sfnt.js';
import { readFontNames, type FontNames } from './fontnames.js';
import { deriveStyle, familyMatches } from './fontmatch.js';
import { getStd14Sfnt } from './std14fonts.js';
import type { StdFont } from './metrics.js';
import { rethrowLimit } from './errors.js';
import type { RunStyle } from './xfarich.js';
import type { FaceLookup, FaceMetrics } from './xfatext.js';

/** [regular, bold, italic, bold italic], by exact family name (lower-cased). */
export const XFA_SUBSTITUTES: Readonly<Record<string, readonly [StdFont, StdFont, StdFont, StdFont]>> = {
  arial: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  'times new roman': ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  'courier new': ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** CSS generic families: never a face (cssfont.ts's rule). */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

interface Face { names?: FontNames; metrics: FaceMetrics }

function unicodeCmap(s: SfntFont): Map<number, number> | undefined {
  return s.cmapSubtable(3, 10) ?? s.cmapSubtable(3, 1) ?? s.cmapSubtable(0, 4) ?? s.cmapSubtable(0, 3);
}

function metricsOf(s: SfntFont): FaceMetrics | undefined {
  const cmap = unicodeCmap(s);
  const hhea = s.table('hhea', false);
  if (!cmap || !hhea || hhea.length < 8) return undefined;
  const v = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
  return {
    unitsPerEm: s.unitsPerEm,
    ascent: v.getInt16(4),
    descent: -v.getInt16(6),
    advance: (cp) => {
      const gid = cmap.get(cp);
      return gid === undefined || gid === 0 || gid >= s.numGlyphs ? undefined : s.advanceWidth(gid);
    },
  };
}

function face(s: SfntFont | undefined): Face | undefined {
  if (!s) return undefined;
  const m = metricsOf(s);
  if (!m) return undefined;
  const names = readFontNames(s.raw);
  return { ...(names ? { names } : {}), metrics: m };
}

const styled = (names: FontNames, want: string, bold: boolean, italic: boolean): boolean => {
  if (!familyMatches(names, want)) return false;
  const st = deriveStyle(names);
  return (st.weight >= 600) === bold && st.italic === italic;
};

const covers = (m: FaceMetrics, text: string): number | undefined => {
  for (const ch of text) {
    if (ch === '\n') continue;
    const cp = ch.codePointAt(0)!;
    if (m.advance(cp) === undefined) return cp;
  }
  return undefined;
};

export function faceLookup(doc: Document): FaceLookup {
  let embedded: Face[] | undefined;
  const embeddedFaces = (): Face[] => {
    if (embedded) return embedded;
    embedded = [];
    for (const [, o] of doc.objectEntries()) {
      if (!isDict(o)) continue;
      const t = o.get('Type');
      if (!isName(t) || t.name !== 'FontDescriptor') continue;
      for (const key of ['FontFile2', 'FontFile3']) {
        const s = doc.resolve(o.get(key));
        if (!isStream(s)) continue;
        if (key === 'FontFile3') {
          const sub = s.dict.get('Subtype');
          if (!isName(sub) || sub.name !== 'OpenType') continue;
        }
        try {
          const f = face(parseSfnt(decodeStream(s), 0, doc.loadLimits));
          if (f?.names) embedded.push(f);
        } catch (caught) { rethrowLimit(caught); }
      }
    }
    return embedded;
  };
  let registered: { rec: Parameters<Document['registeredFaceSfnt']>[0]; f?: Face | null }[] | undefined;
  const registeredFaces = () => (registered ??= doc.registeredFontFaces().map((rec) => ({ rec })));

  return (style: RunStyle, text: string) => {
    const tried: string[] = [];
    for (const raw of style.family) {
      const want = raw.trim().toLowerCase();
      if (want === '' || GENERIC.has(want)) continue;
      tried.push(raw.trim());
      let uncovered: number | undefined;
      const accept = (f: Face): FaceMetrics | undefined => {
        const miss = covers(f.metrics, text);
        if (miss === undefined) return f.metrics;
        uncovered ??= miss;
        return undefined;
      };
      for (const f of embeddedFaces())
        if (styled(f.names!, want, style.bold, style.italic)) { const m = accept(f); if (m) return m; }
      for (const r of registeredFaces()) {
        if (!styled(r.rec.names, want, style.bold, style.italic)) continue;
        if (r.f === undefined) r.f = face(doc.registeredFaceSfnt(r.rec)) ?? null;
        if (r.f) { const m = accept(r.f); if (m) return m; }
      }
      // hasOwn FIRST: the name comes from the document, and 'constructor'
      // must not find Object.prototype's (predefcmap.ts's trap).
      const sub = Object.hasOwn(XFA_SUBSTITUTES, want) ? XFA_SUBSTITUTES[want] : undefined;
      if (sub) {
        const f = face(getStd14Sfnt(sub[(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]));
        if (f) { const m = accept(f); if (m) return m; }
      }
      if (uncovered !== undefined)
        return { reason: `no face of "${raw.trim()}" covers U+${uncovered.toString(16).toUpperCase().padStart(4, '0')}` };
    }
    const st = `${style.bold ? 'bold' : 'normal'} ${style.italic ? 'italic' : 'normal'}`;
    return { reason: tried.length === 0
      ? `its font family "${style.family.join(', ')}" names no face`
      : `no face named "${tried.join('", "')}" (${st}) is embedded, registered, or a known substitute` };
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/xfafont.test.ts`
Expected: PASS. If the OPM `Arial` bold-advance case fails, print `readFontNames` of each embedded program (`familyMatches` uses ID 16 then ID 1) and adjust the TEST only if the font genuinely names itself differently; the matching rule is the spec's.

- [ ] **Step 6: Typecheck, run the catch scan, commit**

Run: `npm run typecheck` (clean) and `npx vitest run test/limits-catch.test.ts test/import-cycles.test.ts` (PASS; the new catches call `rethrowLimit` first, and no new 2-cycle exists — `xfafont.ts` imports `Document` as a type only).

```bash
git add src/xfafont.ts src/document.ts test/xfafont.test.ts
git commit -m "feat(164g.7): xfafont -- embedded, registered, then substitute faces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: attach `LeafText` to layout leaves in `xfatemplate.ts`

**Files:**
- Modify: `src/xfaflow.ts` (`LayoutNode` gains `text?: LeafText`)
- Modify: `src/xfatemplate.ts:278-301` (`nodeOf`)
- Test: `test/xfatemplate-text.test.ts`

**Interfaces:**
- Consumes: `leafText` (Task 1).
- Produces: every field and draw `LayoutNode` carries `text: LeafText`.

- [ ] **Step 1: Write the failing test**

```ts
// test/xfatemplate-text.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import type { LayoutNode } from '../src/xfaflow.js';
import { loadDynamicPdf } from './helpers/xfa-dynamic.js';

function find(n: LayoutNode, path: string[]): LayoutNode | undefined {
  if (path.length === 0) return n;
  const c = n.children.find((k) => k.label === path[0]);
  return c ? find(c, path.slice(1)) : undefined;
}

describe('xfatemplate: leaves carry their LeafText', () => {
  it('gives OPM 1644 Q1 its rich text, in Arial', () => {
    const doc = Document.Open(loadDynamicPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    const p = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
    if ('reason' in p) throw new Error(p.reason);
    const tpl = parseXfaTemplate(p.packets.get('template')!);
    const q1 = find(tpl.roots[0].node, ['Page1[0]', 'SectionII[0]', 'Row1[0]', 'Q1']);
    expect(q1?.kind).toBe('draw');
    expect(q1?.text?.paras[0].runs[0]).toMatchObject({ family: ['Arial'], size: 10 });
    const field = find(tpl.roots[0].node, ['Page1[0]', 'SectionI[0]', 'Row2[0]', 'FieldQ1Name[0]']);
    expect(field?.text?.kind).toBe('text');
    expect(find(tpl.roots[0].node, ['Page1[0]', 'SectionI[0]'])?.text).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/xfatemplate-text.test.ts`
Expected: FAIL — `q1?.text` is undefined.

- [ ] **Step 3: Implement**

In `src/xfaflow.ts`, add the import at the top (type-only, so `xfaflow.ts` stays a leaf at run time):
```ts
import type { LeafText } from './xfarich.js';
```
and in `interface LayoutNode`, after `field?: string;`:
```ts
  /** A field's or draw's text, insets and caption, measured when its size is
   *  not stated (164g.7). Absent on containers. */
  text?: LeafText;
```
In `src/xfatemplate.ts`, import `import { leafText } from './xfarich.js';` and in `nodeOf`, before `return n;`:
```ts
  if (kind === 'field' || kind === 'draw') n.text = leafText(el);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/xfatemplate-text.test.ts test/xfaflow.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts test/import-cycles.test.ts`
Expected: PASS (no layout behaviour has changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts src/xfatemplate.ts test/xfatemplate-text.test.ts
git commit -m "feat(164g.7): XFA layout leaves carry their LeafText

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `xfaflow.ts` — a measurer for leaves, `min*`/`max*` everywhere, the swap

**Files:**
- Modify: `src/xfaflow.ts` (`Engine` constructor, `measure`, `grow`, `layoutPage`)
- Test: `test/xfaflow-measure.test.ts`

**Interfaces:**
- Consumes: `MeasureBox` shape from Task 2 (redeclared here so the leaf imports nothing).
- Produces:
  ```ts
  export type XfaMeasureBox = { width: number } | { maxWidth?: number };
  export type XfaMeasure = (n: LayoutNode, box: XfaMeasureBox) => { w: number; h: number } | { reason: string };
  export function layoutPage(root: LayoutNode, measure?: XfaMeasure, warnings?: string[]): Map<string, Placed>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/xfaflow-measure.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed, type XfaMeasure } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const sub = (label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout, geom, children, ...extra });
const page = (children: LayoutNode[]): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'position', geom: { h: '10000pt' }, children });
const box = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'reason' in p) throw new Error(`${n}: ${p && 'reason' in p ? p.reason : 'none'}`);
  return p.box;
};
const why = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'box' in p) throw new Error(`${n}: placed`);
  return p.reason;
};
/** Text of N characters at 5pt each, 10pt a line, wrapping at the given width. */
const text = (n: number): XfaMeasure => (_node, b) => {
  const lineW = 'width' in b ? b.width : b.maxWidth ?? Infinity;
  const per = Math.max(1, Math.floor(lineW / 5));
  const lines = Math.ceil(n / Math.min(per, n));
  return { w: 'width' in b ? b.width : Math.min(n, per) * 5, h: lines * 10 };
};

describe('layoutPage with a measurer', () => {
  it('without one, refuses exactly as 164g.1 did', () => {
    const m = layoutPage(page([fld('a', { w: '10pt' })]));
    expect(why(m, 'a')).toMatch(/states no h, so its size comes from its content, which needs text measurement \(164g\.7\)/);
  });

  it('measures a height-growable leaf at its stated width', () => {
    const m = layoutPage(page([fld('a', { w: '20pt' })]), text(10));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 30 });
  });

  it('measures a width-growable leaf, wrapping at maxW', () => {
    const m = layoutPage(page([fld('a', { h: '10pt' }, { minMax: { maxW: '15pt' } })]), text(3));
    expect(box(m, 'a').w).toBe(15);
  });

  it('applies minH and minW as floors under tb and row parents too', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { w: '20pt' }, { minMax: { minH: '25pt' } }),
      fld('b', { w: '20pt' }),
    ])]), text(2));
    expect(box(m, 'a').h).toBe(25);
    expect(box(m, 'b').y).toBe(25);
  });

  it('treats maxH of 0 as absent and refuses content past a non-zero maxH', () => {
    expect(box(layoutPage(page([fld('a', { w: '20pt' }, { minMax: { maxH: '0' } })]), text(10)), 'a').h).toBe(30);
    expect(why(layoutPage(page([fld('a', { w: '20pt' }, { minMax: { maxH: '15pt' } })]), text(10)), 'a')).toMatch(/exceeds maxH/);
  });

  it('swaps min > max, with a warning', () => {
    const warnings: string[] = [];
    const m = layoutPage(page([fld('a', { w: '20pt' }, { minMax: { minH: '40pt', maxH: '30pt' } })]), text(2), warnings);
    expect(box(m, 'a').h).toBe(30);
    expect(warnings).toEqual(['a: minH exceeds maxH, so the two are swapped (XFA 3.3 p. 277)']);
  });

  it('passes the measurer\'s reason through and fails the rest of the flow', () => {
    const no: XfaMeasure = () => ({ reason: 'a: no face' });
    const m = layoutPage(page([sub('T', 'tb', {}, [fld('a', { w: '20pt' }), fld('b', { w: '20pt', h: '5pt' })])]), no);
    expect(why(m, 'a')).toBe('a: no face');
    expect(why(m, 'b')).toMatch(/an earlier item in its flow could not be laid out \(a: no face\)/);
  });

  it('ignores min and max on a leaf that states both w and h (p. 276)', () => {
    const m = layoutPage(page([fld('a', { w: '20pt', h: '5pt' }, { minMax: { minH: '40pt' } })]), text(2));
    expect(box(m, 'a').h).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/xfaflow-measure.test.ts`
Expected: FAIL — `layoutPage` ignores the measurer (and `XfaMeasure` is not exported: typecheck error, vitest still runs and the measurement cases fail).

- [ ] **Step 3: Implement**

In `src/xfaflow.ts`:

1. Add the exported types after `export type Placed`:
```ts
/** Where a measured leaf's text must fit: a fixed (stated or column-imposed)
 *  width, or a width-growable leaf wrapping at `maxW` when one is stated. */
export type XfaMeasureBox = { width: number } | { maxWidth?: number };
/** A leaf's nominal extent from its text (164g.7). `min*`/`max*` are the
 *  engine's to apply, not the measurer's. */
export type XfaMeasure = (n: LayoutNode, box: XfaMeasureBox) => { w: number; h: number } | { reason: string };
```

2. Change the `Engine` constructor:
```ts
  constructor(
    private readonly bottom: number | undefined,
    private readonly measurer: XfaMeasure | undefined,
    private readonly warnings: string[],
  ) {}
```

3. Replace the leaf branch in `measure(n)`:
```ts
    if (isLeaf(n)) {
      if (w !== undefined && h !== undefined) return { w, h };
      return this.measureLeaf(n, w, h);
    }
```
and add the method to `Engine`:
```ts
  /** A leaf with an unstated axis (XFA 3.3 p. 276): its text measured at its
   *  fixed width, or wrapping at `maxW`, then `min*`/`max*` applied on the
   *  grown axis -- in every parent layout. `imposed` is a table column's width,
   *  which replaces a stated `w` (p. 329). */
  measureLeaf(n: LayoutNode, w: number | undefined, h: number | undefined, imposed?: number): Size | Fail {
    if (!this.measurer)
      return {
        reason: `${n.label}: states no ${w === undefined ? 'w' : 'h'}, so its size comes `
          + 'from its content, which needs text measurement (164g.7)',
      };
    const width = imposed ?? w;
    let box: XfaMeasureBox = {};
    if (width !== undefined) box = { width };
    else {
      const max = this.limits(n, 'minW', 'maxW');
      if (isFail(max)) return max;
      if (max.max !== undefined) box = { maxWidth: max.max };
    }
    const r = this.measurer(n, box);
    if ('reason' in r) return { reason: r.reason };
    const W = width ?? this.grow(n, 'minW', 'maxW', undefined, r.w);
    if (isFail(W)) return W;
    const H = this.grow(n, 'minH', 'maxH', h, r.h);
    if (isFail(H)) return H;
    return { w: W, h: H };
  }
```

4. Replace `grow` with a version built on a shared `limits` reader that swaps:
```ts
  /** One axis's `min*`/`max*` in points. `max*="0"` means absent (p. 277); a
   *  minimum above the maximum is non-conforming and swapped, with a warning
   *  (p. 277). */
  private limits(n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH'): { min?: number; max?: number } | Fail {
    const mm = n.minMax ?? {};
    const read = (k: string, v: string | undefined): number | undefined | Fail => {
      if (v === undefined) return undefined;
      const p = measureToPt(v);
      return p === undefined ? { reason: `${n.label}: ${k}="${v}" could not be read as a measurement` } : p;
    };
    const min = read(minKey, mm[minKey]);
    if (isFail(min)) return min;
    let max = read(maxKey, mm[maxKey]);
    if (isFail(max)) return max;
    if (max === 0) max = undefined;
    if (min !== undefined && max !== undefined && min > max + EPS) {
      const axis = minKey.slice(3);
      this.warnings.push(`${n.label}: min${axis} exceeds max${axis}, so the two are swapped (XFA 3.3 p. 277)`);
      return { min: max, max: min };
    }
    return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }

  /** One axis of a growable extent. Content past a stated maximum would be
   *  clipped, which is not modelled. */
  private grow(
    n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH',
    fixed: number | undefined, content: number,
  ): number | Fail {
    if (fixed !== undefined) return fixed;
    const lim = this.limits(n, minKey, maxKey);
    if (isFail(lim)) return lim;
    const v = Math.max(content, lim.min ?? 0);
    if (lim.max !== undefined && v > lim.max + EPS)
      return { reason: `${n.label}: its content exceeds ${maxKey}, and clipping is not laid out` };
    return v;
  }
```
Note: the swap warning is pushed once per `limits` call; `measure` results are memoized in `sizes`, and `measureLeaf` calls `limits(n,'minW','maxW')` and then `grow(..'minW','maxW'..)` for a width-growable leaf — de-duplicate by pushing through a `Set`: give `Engine` `private readonly warned = new Set<string>()` and in `limits` replace the push with:
```ts
      const msg = `${n.label}: min${axis} exceeds max${axis}, so the two are swapped (XFA 3.3 p. 277)`;
      if (!this.warned.has(msg)) { this.warned.add(msg); this.warnings.push(msg); }
```

5. Change `layoutPage`:
```ts
export function layoutPage(root: LayoutNode, measure?: XfaMeasure, warnings: string[] = []): Map<string, Placed> {
  ...
  const engine = new Engine(bottom, measure, warnings);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/xfaflow-measure.test.ts test/xfaflow.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts`
Expected: PASS — the pre-existing files unchanged (they pass no measurer; the container `grow` path behaves as before except for the swap, which no pre-existing case exercises).

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts test/xfaflow-measure.test.ts
git commit -m "feat(164g.7): XFA layout measures growable leaves through a callback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: tables — widths first, cells measured at their column, p. 329 narrowing

**Files:**
- Modify: `src/xfaflow.ts` (`Cell`, `rowCells`, `table`)
- Modify: `test/xfaflow.test.ts` (two 164g.1 cases that asserted the old refusal)
- Test: `test/xfaflow-table-measure.test.ts`

**Interfaces:**
- Consumes: `Engine.measureLeaf` (Task 5).
- Produces: no new exports. `Cell` gains `measure?: true` (height deferred to the column width).

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfaflow-table-measure.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed, type XfaMeasure } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const sub = (label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout, geom, children, ...extra });
const row = (label: string, cells: LayoutNode[]) => sub(label, 'row', {}, cells);
const table = (cols: string | undefined, rows: LayoutNode[]) =>
  sub('T', 'table', {}, rows, cols === undefined ? {} : { columnWidths: cols });
const page = (children: LayoutNode[]): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'position', geom: { h: '10000pt' }, children });
const box = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'reason' in p) throw new Error(`${n}: ${p && 'reason' in p ? p.reason : 'none'}`);
  return p.box;
};
const why = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'box' in p) throw new Error(`${n}: placed`);
  return p.reason;
};
/** 5pt a character, 10pt a line. */
const text = (n: number): XfaMeasure => (_node, b) => {
  const lineW = 'width' in b ? b.width : b.maxWidth ?? Infinity;
  const per = Math.max(1, Math.floor(lineW / 5));
  return { w: 'width' in b ? b.width : Math.min(n, per) * 5, h: Math.ceil(n / Math.min(per, n)) * 10 };
};

describe('tables: p. 329, a stated column width is the cell box', () => {
  it('narrows a stated-size leaf to its column, with or without a measurer', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', { w: '30pt', h: '10pt' })])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  it('narrows a positioned subform cell, keeping its children at their offsets', () => {
    const m = layoutPage(page([table('20pt', [row('r', [
      sub('C', 'position', { w: '30pt', h: '10pt' }, [fld('a', { x: '2pt', y: '1pt', w: '5pt', h: '5pt' })]),
    ])])]));
    expect(box(m, 'a')).toEqual({ x: 2, y: 1, w: 5, h: 5 });
  });

  it('still refuses a flowed container wider than its column, which would re-wrap', () => {
    const m = layoutPage(page([table('20pt', [row('r', [
      sub('C', 'tb', { w: '30pt' }, [fld('a', { w: '30pt', h: '10pt' })]),
    ])])]));
    expect(why(m, 'a')).toMatch(/wider than its column, and narrowing a flowed container .* is not laid out/);
  });
});

describe('tables: measured cells', () => {
  it('measures a height-growable cell at its column width, then sizes the row', () => {
    const m = layoutPage(page([table('20pt 30pt', [row('r', [
      fld('a', {}), fld('b', { w: '30pt', h: '5pt' }),
    ])])]), text(10));
    // 10 chars at 5pt in a 20pt column: 4 a line, 3 lines.
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 30 });
    expect(box(m, 'b')).toEqual({ x: 20, y: 0, w: 30, h: 30 });
  });

  it('re-measures a narrowed text leaf at its column width', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', { w: '40pt' })])])]), text(8));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });

  // Review Focus 5.
  it('sizes a -1 column from a measured cell width, and still refuses without a measurer', () => {
    const t = page([table('-1', [row('r', [fld('a', { h: '10pt' })])])]);
    expect(box(layoutPage(t, text(3)), 'a')).toEqual({ x: 0, y: 0, w: 15, h: 10 });
    expect(why(layoutPage(t), 'a')).toMatch(/column 1 has width -1/);
  });

  it('applies minH to a measured cell', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', {}, { minMax: { minH: '25pt' } })])])]), text(2));
    expect(box(m, 'a').h).toBe(25);
  });
});
```

In `test/xfaflow.test.ts`, replace the two cases that pinned the old refusal:

```ts
  // The f1040 Row6 shape: a growable lr-tb cell whose single line exactly fills
  // its column; and the refusal when it would not (a narrowed flowed container
  // would re-wrap).
  it('lays an lr-tb cell on one line when it fits its column, and refuses when it does not', () => {
    const fits = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '20pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(box(fits, 'b')).toEqual({ x: 20, y: 0, w: 30, h: 10 });
    const over = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '30pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(why(over, 'a')).toMatch(/one line wider than its column/);
  });
```
(unchanged), and:
```ts
  // XFA 3.3 p. 329: "the visible representation of the object may extend
  // beyond the allotted region" -- a stated column width is the cell's box.
  it('narrows a leaf cell wider than its column to the column', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', H(10, { w: '30pt' }))])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });
```
replacing `it('refuses a cell wider than its column rather than narrowing it', ...)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfaflow-table-measure.test.ts test/xfaflow.test.ts`
Expected: FAIL — narrowing cases refused "wider than its column", measured cells refused "states no h".

- [ ] **Step 3: Implement**

In `src/xfaflow.ts`:

1. Extend `interface Cell`:
```ts
  /** A leaf whose height comes from its text at its final width (164g.7). */
  measure?: true;
```

2. In `rowCells`, replace the leaf branch body (from `const sw = stated(c, 'w');` to `h = sh;`) with:
```ts
        const sw = stated(c, 'w');
        const sh = stated(c, 'h');
        if (typeof sw === 'object') return sw;
        if (typeof sh === 'object') return sh;
        if (sh === undefined && !this.hasMeasurer)
          return {
            reason: `${c.label}: states no h, so its size comes from its content, which needs `
              + 'text measurement (164g.7)',
          };
        // A width-growable leaf's natural width may size an auto column; if it
        // cannot be measured, only a stated column can size it.
        if (sw === undefined && this.hasMeasurer) {
          const e = this.extent(c);
          w = isFail(e) ? undefined : e.w;
        } else w = sw;
        h = sh ?? 0;
        if (sh === undefined) cells.push({ node: c, span, w, h, oneLine: false, dropped: false, measure: true });
        else cells.push({ node: c, span, w, h, oneLine: false, dropped: false });
        if (span === -1) dropping = true;
        continue;
```
and add to `Engine`:
```ts
  private get hasMeasurer(): boolean { return this.measurer !== undefined; }
```
(The existing `cells.push(...)` after the `else` branch stays for containers.)

3. In `table()`, replace the per-row loop body that computes `rowH` and the cell slots. The new loop, after `tableW`/`avail`:
```ts
    for (const row of rows) {
      if (stop) { out.set(row.node, after(stop)); continue; }
      // Final widths first (p. 329), then every cell's height at its width.
      let bad: Fail | undefined;
      const sized: Array<{ c: Cell; x: number; w: number; h: number }> = [];
      let k = 0;
      for (const c of row.cells) {
        if (c.dropped) continue;
        const x = sum(widths.slice(0, k));
        const w = sum(widths.slice(k, k + c.span));
        k += c.span;
        let h = c.h;
        // A leaf with no stated h -- including one whose stated w the column
        // replaces -- is measured at its final width. A leaf with both stated
        // simply takes the column's width (p. 329).
        if (c.measure) {
          const s = this.measureLeaf(c.node, undefined, undefined, w);
          if (isFail(s)) { bad ??= s; continue; }
          h = s.h;
        } else if (!isLeaf(c.node) && c.w !== undefined && c.w > w + EPS) {
          // A narrowed flowed container would re-wrap its content, which is
          // not laid out; a positioned one keeps its children's offsets.
          if (c.oneLine)
            bad ??= { reason: `${c.node.label}: lays out on one line wider than its column, and wrapping it `
              + 'to the column is not laid out' };
          else if ((c.node.layout ?? 'position') !== 'position')
            bad ??= { reason: `${c.node.label}: is wider than its column, and narrowing a flowed container `
              + 're-wraps it, which is not laid out' };
        }
        sized.push({ c, x, w, h });
      }
      if (bad) { out.set(row.node, bad); stop = bad; continue; }
      const rowH = sized.reduce((a, s) => Math.max(a, s.h), 0);
      const cellSlots: Slots = new Map();
      for (const c of row.cells)
        if (c.dropped)
          cellSlots.set(c.node, { reason: `${c.node.label}: follows a colSpan="-1" cell, so it is not displayed` });
      for (const s of sized) cellSlots.set(s.c.node, { x: s.x, y: 0, size: { w: s.w, h: rowH } });
      if (avail !== undefined && y + rowH > avail + EPS) {
        const f = this.splitFail(n, row.node);
        out.set(row.node, f);
        stop = f;
        continue;
      }
      this.slots.set(row.node, cellSlots);
      out.set(row.node, { x: m.l, y: m.t + y, size: { w: tableW, h: rowH } });
      y += rowH;
    }
```
Remove the old "XFA 3.3 p. 329 expands a cell to its column and never says shrink" block entirely.

4. The column-width loop's `unsized` test reads `c.w`; with a measurer, measured widths now populate it. No change needed there.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/xfaflow-table-measure.test.ts test/xfaflow.test.ts test/xfaflow-measure.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts`
Expected: PASS. `xfa-real` must still report all 199 rects exact and `xfa-flow-oracle` all 40 (no measurer is passed yet, and f1040 has no over-wide cell).

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts test/xfaflow.test.ts test/xfaflow-table-measure.test.ts
git commit -m "fix(164g.7): an XFA table cell takes its column width (p. 329); cells measured at it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: wire the measurer into `ConvertXfaToAcroForm`

**Files:**
- Modify: `src/xfaconvert.ts` (report gains `warnings`; build and pass the measurer at the `layoutPage` call, ~line 228)
- Test: `test/xfaconvert-measure.test.ts`

**Interfaces:**
- Consumes: `faceLookup` (Task 3), `measureLeaf` (Task 2), `withValue` (Task 1), `XfaMeasure` (Task 5), `bindFieldValue` (`src/xfadata.ts`).
- Produces: `XfaConvertReport.warnings: string[]` — non-conforming template values the converter corrected (today: swapped `min*`/`max*`).

- [ ] **Step 1: Write the failing test**

```ts
// test/xfaconvert-measure.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { encodeStream } from '../src/filters.js';
import { name } from '../src/types.js';

/** A one-page dynamic form: a tb page subform holding a height-growable Arial
 *  field above a fixed one, so the second field's y proves the first grew. */
function buildGrowForm(value: string | string[], extra = ''): Document {
  const doc = Document.New();
  doc.AddPage();
  const tpl = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb"><pageSet><pageArea name="P"><contentArea w="612pt" h="792pt"/>
<medium short="612pt" long="792pt"/></pageArea></pageSet>
<subform name="S" layout="tb" w="612pt">
<field name="grow" w="100pt" ${extra}><ui><textEdit multiLine="1"/></ui><font typeface="Arial" size="10pt"/><margin/></field>
<field name="after" w="100pt" h="20pt"><ui><textEdit/></ui></field>
</subform></subform></template>`;
  const ds = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><S>${
    (Array.isArray(value) ? value : [value]).map((v) => `<grow>${v}</grow>`).join('')
  }</S></form1></xfa:data></xfa:datasets>`;
  const pk = (s: string) => doc.allocObject(encodeStream(new TextEncoder().encode(s), 'FlateDecode'));
  const acro = new Map([['Fields', []], ['XFA', [
    { kind: 'string', bytes: new TextEncoder().encode('template') }, pk(tpl),
    { kind: 'string', bytes: new TextEncoder().encode('datasets') }, pk(ds),
  ]]]) as never;
  doc.catalog().set('AcroForm', doc.allocObject(acro));
  doc.catalog().set('NeedsRendering', true);
  return doc;
}

const rect = (doc: Document, n: string) => doc.resolve(doc.Form.Get(n)!.Dict.get('Rect')) as number[];

describe('ConvertXfaToAcroForm measures growable fields', () => {
  it('grows a field to its bound value in Arial (the Liberation substitute when nothing is embedded)', () => {
    const doc = buildGrowForm('one two three four five six seven eight nine ten');
    const r = doc.ConvertXfaToAcroForm();
    expect(r.fields.find((f) => f.name.endsWith('grow[0]'))?.route).toBe('positioned');
    const g = rect(doc, 'form1[0].S[0].grow[0]');
    const a = rect(doc, 'form1[0].S[0].after[0]');
    const lines = Math.round((g[3] - g[1]) / ((1854 + 434) / 2048 * 10));
    expect(lines).toBeGreaterThan(1);
    expect(a[3]).toBeCloseTo(g[1], 2);
    expect(r.warnings).toEqual([]);
  });

  it('measures an empty growable field as one line', () => {
    const doc = buildGrowForm('');
    doc.ConvertXfaToAcroForm();
    const g = rect(doc, 'form1[0].S[0].grow[0]');
    expect(g[3] - g[1]).toBeCloseTo((1854 + 434) / 2048 * 10, 2);
  });

  // Review Focus 1: a multi-valued datum never reaches the measurer as a string.
  it('refuses a growable text field bound to several values', () => {
    const doc = buildGrowForm(['a', 'b']);
    const r = doc.ConvertXfaToAcroForm();
    expect(r.fields.find((f) => f.name.endsWith('grow[0]'))?.route).toBe('bare');
    expect(r.skipped.some((s) => s.name?.endsWith('grow[0]') && /several values/.test(s.reason))).toBe(true);
  });

  it('reports a swapped min/max as a warning', () => {
    const doc = buildGrowForm('a', 'minH="40pt" maxH="30pt"');
    const r = doc.ConvertXfaToAcroForm();
    expect(r.warnings).toEqual(['grow[0]: minH exceeds maxH, so the two are swapped (XFA 3.3 p. 277)']);
  });
});
```

Before running, check the exact shape `ConvertXfaToAcroForm` needs for a hand-built form: `grep -n "buildXfa\|NeedsRendering" test/helpers/*.ts | head`. If a helper already builds a form from template and datasets strings (164g.1's tests used one), use it in place of `buildGrowForm`'s body, keeping the template and datasets text above. Also check whether a bare (geometry-less) field's reason reaches `report.skipped` (`grep -an "route: 'bare'" src/xfaconvert.ts`) and adjust the "several values" assertion to wherever the converter records a bare field's reason.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/xfaconvert-measure.test.ts`
Expected: FAIL — `grow[0]` is bare ("needs text measurement") and `r.warnings` is undefined.

- [ ] **Step 3: Implement**

In `src/xfaconvert.ts`:

1. Imports:
```ts
import { layoutPage, type Placed, type XfaMeasure } from './xfaflow.js';
import { measureLeaf } from './xfatext.js';
import { withValue } from './xfarich.js';
import { faceLookup } from './xfafont.js';
```
2. `XfaConvertReport` gains, after `skipped`:
```ts
  /** Non-conforming template values corrected rather than refused -- today a
   *  `min*` greater than its `max*`, swapped as XFA 3.3 p. 277 directs. */
  warnings: string[];
```
and every report literal (`const report: XfaConvertReport = { ... }`) gains `warnings: []`.
3. Replace the 4b block's loop:
```ts
  const placed = new Map<string, Placed>();
  if (!noGeometry) {
    const faces = faceLookup(doc);
    const byName = new Map(tpl.fields.map((f) => [f.name, f]));
    // A leaf's text from the template, with a field's bound value in place of
    // its default (164g.7). A multi-valued datum is not text.
    const measure: XfaMeasure = (n, box) => {
      if (!n.text) return { reason: `${n.label}: has no measurable content` };
      let t = n.text;
      const f = n.field !== undefined ? byName.get(n.field) : undefined;
      if (f) {
        const v = bindFieldValue(f, values);
        if (Array.isArray(v)) return { reason: `${n.label}: is bound to several values, which are not measured as text` };
        if (v !== undefined) t = withValue(t, v);
      }
      const r = measureLeaf(t, box, faces);
      return 'reason' in r ? { reason: `${n.label}: ${r.reason}` } : r;
    };
    for (const r of tpl.roots) {
      if (badPages.has(r.pageIndex)) continue;
      for (const [k, v] of layoutPage(r.node, measure, report.warnings)) placed.set(`${String(r.pageIndex)}\u0000${k}`, v);
    }
  }
```
Keep the key separator that the file already uses (read the existing line: it is a non-printing separator shown as `^@`, i.e. `\u0000`; keep whatever the code has).

- [ ] **Step 4: Run tests and the fences**

Run: `npx vitest run test/xfaconvert-measure.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts test/xfaconvert*.test.ts test/xfa*.test.ts`
Expected: PASS. `xfa-real` still reports all 199 f1040 rects exact WITH the measurer in place — if any rect moved, stop: the measurer must not change a field whose size was already stated.

- [ ] **Step 5: Commit**

```bash
git add src/xfaconvert.ts test/xfaconvert-measure.test.ts
git commit -m "feat(164g.7): ConvertXfaToAcroForm measures growable XFA fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: the pdf.js oracle — isolated tables, the `Q1` divergence

**Files:**
- Modify: `test/xfa-dynamic-oracle.test.ts` (new `describe` block)
- Modify: `src/xfaconvert.ts` — export the measurer builder so the oracle can use it

**Interfaces:**
- Consumes: Tasks 1-7; `dynamicGoldens`, `loadDynamicPdf` (`test/helpers/xfa-dynamic.ts`).
- Produces (internal, `@internal` in its doc comment): `export function xfaMeasurer(doc: Document, tpl: XfaTemplate, values: XfaValues): XfaMeasure` in `src/xfaconvert.ts`, used by `planXfa` itself (refactor the closure from Task 7 into it).

- [ ] **Step 1: Extract `xfaMeasurer`**

Move Task 7's closure into:
```ts
/** @internal The measurer `ConvertXfaToAcroForm` lays pages out with (164g.7),
 *  exported so the pdf.js oracle can lay out a subtree in isolation. */
export function xfaMeasurer(doc: Document, tpl: XfaTemplate, values: XfaValues): XfaMeasure {
  const faces = faceLookup(doc);
  const byName = new Map(tpl.fields.map((f) => [f.name, f]));
  return (n, box) => { /* body exactly as in Task 7 */ };
}
```
(`XfaTemplate` from `./xfatemplate.js`, `XfaValues` from `./xfadata.js`.) Call it at the 4b site: `const measure = xfaMeasurer(doc, tpl, values);`. Run `npx vitest run test/xfaconvert-measure.test.ts` — PASS.

- [ ] **Step 2: Write the oracle tests**

Append to `test/xfa-dynamic-oracle.test.ts` (add imports `parseXfaDatasets` from `../src/xfadata.js`, `xfaMeasurer` from `../src/xfaconvert.js`, `type LayoutNode` from `../src/xfaflow.js`):

```ts
/**
 * 164g.7 against pdf.js, one table at a time. Whole-page layout of OPM 1644 is
 * blocked by its Header rows' <occur max="-1"> until 164g.2, so each table is
 * laid out ALONE on a synthetic page. A Header row bound to one data group is
 * one instance, so the test re-labels its synthetic `occur` layout `row` -- a
 * stand-in for 164g.2 that changes nothing else.
 */
describe('164g.7: measured layout against pdf.js, table by table', () => {
  const doc = Document.Open(source);
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const packets = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in packets) throw new Error(packets.reason);
  const tpl = parseXfaTemplate(packets.packets.get('template')!);
  const values = parseXfaDatasets(packets.packets.get('datasets')!);
  const measure = xfaMeasurer(doc, tpl, values);
  const page1 = tpl.roots[0].node.children[0];
  const tableNode = (label: string): LayoutNode => {
    const t = page1.children.find((c) => c.label === label)!;
    const fix = (n: LayoutNode): LayoutNode =>
      ({ ...n, ...(n.layout === 'occur' ? { layout: 'row' } : {}), children: n.children.map(fix) });
    return fix(t);
  };
  const alone = (label: string) => layoutPage(
    { kind: 'page', label: 'contentArea', layout: 'position', geom: { w: '612pt', h: '792pt' }, children: [tableNode(label)] },
    measure,
  );
  const golden = (som: string) => one('published', som);
  const PT = (mm: number) => (mm * 72) / 25.4;

  // pdf.js measures Q1 at 10pt Arial plus its insets, 14.05pt, and ignores its
  // minH; the spec (p. 276) makes minH a floor in every parent, so our row is
  // minH tall. Everything below Q1 therefore sits lower by exactly
  // minH - 14.05 -- the recorded divergence, asserted, not tolerated.
  it('SectionII: every field agrees with pdf.js, shifted by exactly the Q1 minH divergence', () => {
    const out = alone('SectionII[0]');
    const q1 = page1.children.find((c) => c.label === 'SectionII[0]')!.children
      .find((c) => c.label === 'Row1[0]')!.children[0];
    const natural = measure(q1, { width: golden('OF1644[0].Page1[0].SectionII[0].Row1[0].Q1[0]').w });
    if ('reason' in natural) throw new Error(natural.reason);
    expect(natural.h).toBeCloseTo(golden('OF1644[0].Page1[0].SectionII[0].Row1[0].Q1[0]').h, 1);
    const shift = PT(5.842) - natural.h;
    let n = 0;
    for (const [name, p] of out) {
      if (!('box' in p)) throw new Error(`${name}: ${p.reason}`);
      const g = golden(name);
      expect(p.box.x, name).toBeCloseTo(g.x, 1);
      expect(p.box.w, name).toBeCloseTo(g.w, 1);
      expect(p.box.h, name).toBeCloseTo(g.h, 1);
      expect(p.box.y - g.y, name).toBeCloseTo(shift, 1);
      n++;
    }
    expect(n).toBeGreaterThan(10);
  });

  // p. 329: the w="30mm" draws in Row3 take their narrower columns, as pdf.js
  // draws them; every field below agrees with pdf.js.
  it('SectionIIIpt2: over-wide cells take their columns, every field agrees', () => {
    const out = alone('SectionIIIpt2[0]');
    let n = 0;
    for (const [name, p] of out) {
      if (!('box' in p)) throw new Error(`${name}: ${p.reason}`);
      const g = golden(name);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(p.box[k], `${name} ${k}`).toBeCloseTo(g[k], 1);
      n++;
    }
    expect(n).toBe(nodes('published').filter((x) => x.kind === 'field'
      && x.som.startsWith('OF1644[0].Page1[0].SectionIIIpt2[0].')).length);
  });
});
```

Notes for the implementer:
- `layoutPage`'s keys are `LayoutNode.field`, the full SOM path (`OF1644[0].Page1[0]...`), exactly the goldens' naming (164g.6 pinned the two equal).
- `toBeCloseTo(v, 1)` is ±0.05, the precision the goldens carry (pdf.js rounds to 0.01 and Chrome snaps to 1/64 px).
- SectionII contains `Table2SecII`, a nested table with `w="30mm"` draws in `Row12` — those narrow too. If a field disagrees, print `p.box` against `g` and find the rule; do not widen the tolerance.

- [ ] **Step 3: Run**

Run: `npx vitest run test/xfa-dynamic-oracle.test.ts`
Expected: PASS, including the pre-existing pinned count `{ published: 0, header: 0, pages: 0 }` (page-level layout is still blocked by `Header[0]`; update that test's comment to say the column-width refusal is gone and only 164g.2/164g.3 remain).

- [ ] **Step 4: Prove the oracle is load-bearing**

Mutate and confirm each reddens, then revert (`git diff --stat` must show only the test file afterwards):
1. In `xfafont.ts`, use the `head` bbox (`sfnt.bbox`-style yMax/yMin) instead of hhea → the SectionII `natural.h` case reddens.
2. In `xfaflow.ts` `grow`, drop `Math.max(content, lim.min ?? 0)` → `content` → SectionII's shift assertion reddens.
3. Restore the p. 329 refusal for leaves → SectionIIIpt2 reddens.
Record the results in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add src/xfaconvert.ts test/xfa-dynamic-oracle.test.ts
git commit -m "test(164g.7): measured XFA tables agree with pdf.js; Q1 minH divergence pinned

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: documentation, quality gates, close

**Files:**
- Modify: `CLAUDE.md` (Source list: entries for `xfarich.ts`, `xfatext.ts`, `xfafont.ts`; the `xfaflow.ts` note on p. 329 corrected; the 164g.6 note's "VACUOUS" line updated)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `README.md` (the XFA limitation line in Scope and Limitations)
- Modify: `test/fixtures/xfa-dynamic/PROVENANCE.md`

- [ ] **Step 1: CLAUDE.md**

Add after the `xfaflow.ts` entry (search `**Invariant (\`164g.1\`):** \`xfaflow.ts\` is the ONE layout engine`):

```markdown
- **xfarich.ts**, **xfatext.ts**, **xfafont.ts** — XFA growable sizes
  (`164g.7`). `xfarich.ts` (pure) turns a field's or draw's template XML into a
  `LeafText` -- paragraphs of styled runs, insets, caption -- with XFA 3.3's
  defaults (Template Reference p. 743: 10pt Courier, normal; p. 58's prose says
  bold and is overruled by the normative syntax). `xfatext.ts` (pure) measures
  one at a box: lines broken by `layoutRuns`, the ONE wrapping engine; line
  height the tallest hhea box on the line (p. 61), read as hhea ascender minus
  descender, which pdf.js corroborates (10pt Arial = 11.17pt). `xfafont.ts`
  holds the `Document` and resolves a run's face in three tiers: embedded
  programs by their OWN `name` table, registered folders, then a CLOSED table
  (Arial, Times New Roman, Courier New to the bundled Liberation faces, equal on
  advances and on hhea/typo/win metrics; Helvetica, Times and Courier
  deliberately absent).
  **Invariant:** `xfaflow.ts` takes the measurer as a CALLBACK and stays a pure
  leaf; without one every leaf refuses exactly as 164g.1 did. `min*`/`max*`
  are the engine's, a floor and ceiling in every parent layout (p. 276), which
  is where we and pdf.js part: pdf.js applies them only in a positioned parent,
  so OPM 1644's `Q1` is 16.56pt here and 14.05pt there, and the oracle asserts
  that exact difference.
  **Invariant (p. 329), and 164g.1 read it backwards:** a stated column width IS
  a cell's box -- "the visible representation of the object may extend beyond
  the allotted region". A leaf or positioned subform is narrowed; a flowed
  container that would re-wrap still refuses. Tables now resolve widths BEFORE
  measuring cell heights, since a height-growable cell's height depends on its
  column.
```
In the `164g.6` note, replace the sentence beginning "**Our engine places NONE of it today**" through "(`164g.2`, `164g.3`, `164g.7`)." with:
```markdown
  **Page-level layout still places none of it** -- the `Header` rows' `<occur>`
  (`164g.2`) and the second `Page2` instance (`164g.3`) block it -- so the
  page-level count stays 0. Since `164g.7` the tables are checked ALONE
  (`SectionII`, `SectionIIIpt2`), where every field agrees with pdf.js.
```
and delete the "**One disagreement to settle in `164g.7`, not here:**" sentence (it is settled).

Then run the module-entry sweep and confirm it prints nothing:
```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 2: CHANGELOG.md, under `## [Unreleased]`**

Under **Added**:
```markdown
- **`ConvertXfaToAcroForm` sizes growable XFA fields and draws from their text.**
  A field or draw that leaves its width or height to its content -- an absent
  `w`/`h`, or `minW`/`minH`/`maxW`/`maxH` -- used to be left bare. It is now
  measured with the face its template names: one embedded in the document,
  else one in a registered font folder, else, for Arial, Times New Roman and
  Courier New only, the bundled Liberation face, which matches them glyph for
  glyph in width and line height. Plain and rich text (`exData`) are both
  measured; an empty field measures one line. Anything it cannot measure
  faithfully -- an unresolvable face, a missing glyph, letter spacing, a list --
  is refused by name, never estimated. Checked against pdf.js's XFA layout of
  OPM Form 1644. `XfaConvertReport.warnings` reports a corrected template
  value, today a `min*` above its `max*`. (164g.7)
```
Under **Changed**:
```markdown
- **An XFA table cell wider than its column now takes the column's width.**
  XFA 3.3 p. 329 makes a stated column width the cell's box ("the visible
  representation of the object may extend beyond the allotted region"); the
  converter used to refuse such a cell and every field after it in the table,
  which left OPM Form 1644's provider table bare. A flowed container that
  would have to re-wrap is still refused. (164g.7)
```

- [ ] **Step 3: README.md**

Find the XFA line in Scope and Limitations (`grep -n "XFA" README.md`) and change its account of sizes to: flowed and growable layouts are placed, a growable field or draw is measured with the named face (embedded, registered, or the Liberation substitute for Arial/Times New Roman/Courier New) and refused otherwise; repetition (`<occur>`) and page breaking remain unsupported. Keep the existing sentence structure; change only what is now false.

- [ ] **Step 4: PROVENANCE.md (`test/fixtures/xfa-dynamic/`)**

In "What it established on its first run", replace the paragraph listing the three reasons our engine places none of the form with:
```markdown
- **Since `164g.7` the tables agree.** Laid out alone, every field of
  `SectionII` and `SectionIIIpt2` lands on pdf.js's box to 0.05pt -- with one
  recorded divergence: pdf.js ignores `Q1`'s `minH` (it applies `min*` only in a
  positioned parent; XFA 3.3 p. 276 makes it a floor everywhere), so every row
  below `Q1` sits exactly `minH − 14.05pt` lower here, and the test asserts that
  difference rather than tolerating it. pdf.js measured `Q1` at exactly the
  hhea extent of 10pt Arial plus its insets, which is the reading `xfatext.ts`
  takes of p. 61. The column-width disagreement 164g.6 recorded is settled in
  pdf.js's favour by p. 329. Page-level layout still waits on `164g.2` and
  `164g.3`.
```

- [ ] **Step 5: Quality gates**

Run: `npm run typecheck` — clean.
Run: `npm test` — all green. Record the file and test counts.

- [ ] **Step 6: Commit, close, push**

```bash
git add CLAUDE.md CHANGELOG.md README.md test/fixtures/xfa-dynamic/PROVENANCE.md
git commit -m "docs(164g.7): XFA growable sizes in CLAUDE.md, CHANGELOG, README, PROVENANCE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close 164g.7
git pull --rebase && git push && git status
```
