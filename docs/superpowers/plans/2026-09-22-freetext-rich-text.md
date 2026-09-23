# FreeText Rich Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a FreeText annotation's `/RC` rich text — bold, italic, family, size, colour, alignment, underline and line-through — in the appearance generated on XFDF/FDF import and in the on-the-fly appearance for a FreeText with no `/AP`.

**Architecture:** A new pure leaf, `src/richlayout.ts`, turns `/RC` markup (plus the `/DS` default style) into styled paragraphs and lays them out through `layout.ts`'s `layoutRuns` with Standard-14 `winAnsiDriver`s, emitting a content-stream body and the faces it names. `annotdraw.ts`'s FreeText builder uses it when `/RC` parses; `regenerateAppearance` installs the result with allocated fonts, and `annotappearance.ts`'s viewer fallback wraps it inline.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-freetext-rich-text-design.md`

## Global Constraints

- Zero runtime dependencies.
- Every `catch` in `src/` calls `rethrowLimit(caught)` first, with a named binding (`test/limits-catch.test.ts`).
- `test/import-cycles.test.ts` must stay green: no new value-import 2-cycle.
- A FreeText WITHOUT a usable `/RC` must regenerate byte-identically to today (Task 3's hash fence).
- Rendering must not allocate: the viewer fallback uses INLINE font dictionaries.
- Font keys in a body are `F0`, `F1`, … in order of first use, and every key a body names is registered in that stream's own `/Resources /Font` (`test/ap-font-key.test.ts` enforces this).
- **Write every patch script to a file with the Write tool and run it with node. Never pass TypeScript containing a backtick, `$` or backslash through `node -e "…"` or a heredoc** — bash substitutes backticks even when escaped (memory `bash-heredoc-strips-backslashes`).
- Before closing: `npm run typecheck` and `npm test` green.
- Beads issue `aspose-pdf-foss-for-ts-v0tz.3`. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: `richlayout.ts` — markup and styles to paragraphs

**Files:**
- Modify: `src/richtext.ts` (export the block set; take in `readRichTextMarkup`)
- Modify: `src/formfield.ts` (re-export `readRichTextMarkup` from `richtext.ts`)
- Create: `src/richlayout.ts`
- Test: `test/richlayout.test.ts`

**Interfaces:**
- Produces, in `src/richlayout.ts`:
  - `type Family = 'Helvetica' | 'Times' | 'Courier'`
  - `type RichAlign = 'left' | 'center' | 'right' | 'justify'`
  - `interface RichStyle { family: Family; bold: boolean; italic: boolean; size: number; color: [number, number, number]; underline: boolean; strike: boolean; align: RichAlign }`
  - `interface RichRun { text: string; face: StdFont; size: number; color: [number, number, number]; underline: boolean; strike: boolean }`
  - `interface RichParagraph { align: RichAlign; runs: RichRun[] }`
  - `faceOf(s: RichStyle): StdFont`
  - `styleFromFace(face: StdFont, size: number, color: [number, number, number], align: RichAlign): RichStyle`
  - `applyStyle(css: string, s: RichStyle): RichStyle`
  - `parseRichText(markup: string, ds: string | undefined, base: RichStyle): RichParagraph[] | undefined`
- Produces, in `src/richtext.ts`: `RICH_BLOCK_ELEMENTS: ReadonlySet<string>` (the existing `BLOCK`, exported) and `readRichTextMarkup(doc, dict, key)` moved here.

- [ ] **Step 1: Move `readRichTextMarkup` into `richtext.ts`**

It must be reachable from `annotdraw.ts` without importing `formfield.ts`, which imports `flatten.ts`, which imports `annotappearance.ts` — the module Task 4 makes import `annotdraw.ts`, so that edge would close a cycle.

In `src/richtext.ts`: rename `const BLOCK` to `export const RICH_BLOCK_ELEMENTS: ReadonlySet<string>` (update its one use in `walk`), and add, with the imports `import type { Document } from './document.js';`, `import { type PdfDict, isStream, isString } from './types.js';`, `import { decodePdfText } from './metadata.js';`, `import { decodeStream } from './filters.js';`:

```ts
/** A rich-text entry's MARKUP — `/RV` on a field, `/RC` on a markup
 *  annotation. The two share the string-or-stream duality, so they share one
 *  reader. Moved here from formfield.ts (`v0tz.3`) so the annotation appearance
 *  path can reach it without importing formfield.ts, whose `flatten.js` edge
 *  would close a cycle; formfield.ts re-exports it.
 *
 *  **Invariant:** this returns MARKUP, and its round-tripping callers depend on
 *  that — `formdata.ts` writes it into FDF/XFDF `<value-richtext>` and
 *  `xfdfannot.ts` into `contents-richtext`, both verbatim. */
export function readRichTextMarkup(
  doc: Document, dict: PdfDict, key: 'RV' | 'RC' = 'RV',
): string | undefined {
  const rv = doc.resolve(dict.get(key));
  if (isString(rv)) return decodePdfText(rv.bytes);
  if (isStream(rv)) return new TextDecoder('utf-8').decode(decodeStream(rv));
  return undefined;
}
```

In `src/formfield.ts`, delete the function body and replace it with
`export { readRichTextMarkup } from './richtext.js';` plus
`import { readRichTextMarkup } from './richtext.js';` (an `export … from` makes no local binding, and `readRichTextValue` and `RichTextValue` use it). Keep `export const readRichTextValue = readRichTextMarkup;`. Remove any import `formfield.ts` no longer needs.

Run: `npm run typecheck && npx vitest run test/richtext.test.ts test/annot-search-text.test.ts test/import-cycles.test.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing tests**

`test/richlayout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyStyle, parseRichText, faceOf, styleFromFace, type RichStyle } from '../src/richlayout.js';

const BASE: RichStyle = styleFromFace('Helvetica', 12, [0, 0, 0], 'left');
const runs = (markup: string, ds?: string) =>
  (parseRichText(markup, ds, BASE) ?? []).map((p) => p.runs.map((r) => ({ t: r.text, f: r.face, s: r.size, c: r.color, u: r.underline, x: r.strike })));
const texts = (markup: string) => (parseRichText(markup, undefined, BASE) ?? []).map((p) => p.runs.map((r) => r.text).join(''));

describe('faces', () => {
  it('maps family and style to the 12 Standard-14 text faces', () => {
    expect(faceOf({ ...BASE, family: 'Times', bold: true, italic: true })).toBe('Times-BoldItalic');
    expect(faceOf({ ...BASE, family: 'Courier', italic: true })).toBe('Courier-Oblique');
    expect(faceOf({ ...BASE, bold: true })).toBe('Helvetica-Bold');
  });
  it('styleFromFace reads family and style back out of a face', () => {
    const s = styleFromFace('Times-Italic', 9, [1, 0, 0], 'center');
    expect([s.family, s.bold, s.italic, s.size, s.align]).toEqual(['Times', false, true, 9, 'center']);
    expect(styleFromFace('Symbol', 9, [0, 0, 0], 'left').family).toBe('Helvetica');
  });
});

describe('applyStyle', () => {
  it('font-size in pt, px, em, percent and unitless', () => {
    expect(applyStyle('font-size: 10pt', BASE).size).toBe(10);
    expect(applyStyle('font-size: 16px', BASE).size).toBe(12);
    expect(applyStyle('font-size: 2em', BASE).size).toBe(24);
    expect(applyStyle('font-size: 50%', BASE).size).toBe(6);
    expect(applyStyle('font-size: 9', BASE).size).toBe(9);
  });
  it('ignores a size it cannot read, keeping the inherited one', () => {
    expect(applyStyle('font-size: large', BASE).size).toBe(12);
    expect(applyStyle('font-size: -3pt', BASE).size).toBe(12);
  });
  it('font-weight and font-style', () => {
    expect(applyStyle('font-weight: bold', BASE).bold).toBe(true);
    expect(applyStyle('font-weight: 700', BASE).bold).toBe(true);
    expect(applyStyle('font-weight: 500', BASE).bold).toBe(false);
    expect(applyStyle('font-weight: normal', { ...BASE, bold: true }).bold).toBe(false);
    expect(applyStyle('font-style: oblique', BASE).italic).toBe(true);
  });
  it('font-family takes the FIRST name it recognises', () => {
    expect(applyStyle('font-family: Garamond, "Times New Roman", Courier', BASE).family).toBe('Times');
    expect(applyStyle('font-family: monospace', BASE).family).toBe('Courier');
    expect(applyStyle('font-family: Arial', { ...BASE, family: 'Times' }).family).toBe('Helvetica');
  });
  it('an unrecognised family list keeps what the run inherited', () => {
    expect(applyStyle('font-family: Garamond, Palatino', { ...BASE, family: 'Courier' }).family).toBe('Courier');
  });
  it('the font shorthand, including Acrobat\'s family-before-size order', () => {
    const a = applyStyle('font: italic bold 14pt Times', BASE);
    expect([a.italic, a.bold, a.size, a.family]).toEqual([true, true, 14, 'Times']);
    const b = applyStyle('font: Courier,monospace 9.0pt', BASE);
    expect([b.family, b.size]).toEqual(['Courier', 9]);
  });
  it('color in hex, rgb() and names; transparent is ignored', () => {
    expect(applyStyle('color: #FF0000', BASE).color).toEqual([1, 0, 0]);
    expect(applyStyle('color: rgb(0, 0, 255)', BASE).color).toEqual([0, 0, 1]);
    expect(applyStyle('color: green', BASE).color[1]).toBeGreaterThan(0.4);
    expect(applyStyle('color: transparent', BASE).color).toEqual([0, 0, 0]);
  });
  it('text-align and text-decoration', () => {
    expect(applyStyle('text-align: right', BASE).align).toBe('right');
    expect(applyStyle('text-align: end', BASE).align).toBe('right');
    const d = applyStyle('text-decoration: underline line-through', BASE);
    expect([d.underline, d.strike]).toEqual([true, true]);
    expect(applyStyle('text-decoration: none', d).underline).toBe(false);
  });
  it('a malformed declaration list costs only what it broke', () => {
    const s = applyStyle('font-size: ; color: #00F; nonsense', BASE);
    expect(s.color).toEqual([0, 0, 1]);
    expect(s.size).toBe(12);
  });
});

describe('parseRichText', () => {
  it('b and i set weight and style; span styles a run', () => {
    expect(runs('<p>a <b>b</b> <i>c</i> <span style="color:#FF0000">d</span></p>')).toEqual([[
      { t: 'a ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'b', f: 'Helvetica-Bold', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: ' ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'c', f: 'Helvetica-Oblique', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: ' ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'd', f: 'Helvetica', s: 12, c: [1, 0, 0], u: false, x: false },
    ]]);
  });
  it('each <p> is a paragraph; <br> is a line break inside one', () => {
    expect(texts('<p>one</p><p>two<br/>three</p>')).toEqual(['one', 'two\nthree']);
  });
  it('several top-level elements all survive (the synthetic root)', () => {
    expect(texts('<p>a</p><p>b</p><p>c</p>')).toEqual(['a', 'b', 'c']);
  });
  it('collapses whitespace like XHTML, never doubling a space across runs', () => {
    expect(texts('<p>\n  a   <b> b </b>  c\n</p>')).toEqual(['a b c']);
  });
  it('an unknown element is transparent: its text is kept', () => {
    expect(texts('<p>x<font color="red">y</font>z</p>')).toEqual(['xyz']);
  });
  it('/DS applies beneath everything, and element style beats it', () => {
    const r = runs('<p>a<span style="font-size:20pt">b</span></p>', 'font: Times 10pt; color:#0000FF');
    expect(r[0][0]).toMatchObject({ f: 'Times-Roman', s: 10, c: [0, 0, 1] });
    expect(r[0][1]).toMatchObject({ f: 'Times-Roman', s: 20, c: [0, 0, 1] });
  });
  it('inherits down the tree', () => {
    const r = runs('<body style="font-family:Courier"><p style="font-weight:bold">a<i>b</i></p></body>');
    expect(r[0].map((x) => x.f)).toEqual(['Courier-Bold', 'Courier-BoldOblique']);
  });
  it('a paragraph takes its own text-align', () => {
    const p = parseRichText('<p style="text-align:center">a</p><p>b</p>', undefined, BASE)!;
    expect(p.map((x) => x.align)).toEqual(['center', 'left']);
  });
  it('an unknown family on a span keeps what it inherited', () => {
    const r = runs('<p style="font-family:Times">a<span style="font-family:Wingdings">b</span></p>');
    expect(r[0].map((x) => x.f)).toEqual(['Times-Roman']); // merged: same style
    expect(texts('<p style="font-family:Times">a<span style="font-family:Wingdings">b</span></p>')).toEqual(['ab']);
  });
  it('drops empty paragraphs', () => {
    expect(texts('<p>a</p><p>  </p><p>b</p>')).toEqual(['a', 'b']);
  });
  it('markup that will not parse is undefined, never a regex strip', () => {
    expect(parseRichText('<p>unclosed', undefined, BASE)).toBeUndefined();
    expect(parseRichText('<p>a &nbsp; b</p>', undefined, BASE)).toBeUndefined();
  });
  it('markup with no text is an empty list', () => {
    expect(parseRichText('<p></p>', undefined, BASE)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/richlayout.test.ts`
Expected: FAIL — cannot resolve `../src/richlayout.js`.

- [ ] **Step 4: Write `src/richlayout.ts` (parsing half)**

```ts
// A FreeText's rich text (`/RC`, ISO 32000-1 12.7.3.4) as styled paragraphs,
// and those paragraphs laid out and emitted as a content-stream body
// (`v0tz.3`). A pure leaf: no Document, no allocation — the caller decides
// where the fonts it names live.
//
// Parsing is xml.ts's, exactly as richtext.ts parses the same markup for
// search, and the block-boundary rule is richtext.ts's RICH_BLOCK_ELEMENTS, so
// the two cannot disagree about where a paragraph ends. CSS is cssparse.ts's
// grammar and cssvalue.ts's colours: one owner each. Layout is layout.ts's
// layoutRuns — the ONE wrapping engine — with a Standard-14 winAnsiDriver per
// face.
import { parseXml, type XmlNode } from './xml.js';
import { parseDeclarationList, type CssValue } from './cssparse.js';
import { colorOf, trimWs } from './cssvalue.js';
import { layoutRuns, winAnsiDriver, type FontDriver } from './layout.js';
import type { StdFont } from './metrics.js';
import { vmetricsFor } from './textdecor.js';
import { serializeString } from './serialize.js';
import { num } from './pagecontent.js';
import { RICH_BLOCK_ELEMENTS } from './richtext.js';
import { rethrowLimit } from './errors.js';

export type Family = 'Helvetica' | 'Times' | 'Courier';
export type RichAlign = 'left' | 'center' | 'right' | 'justify';

export interface RichStyle {
  family: Family; bold: boolean; italic: boolean; size: number;
  color: [number, number, number]; underline: boolean; strike: boolean; align: RichAlign;
}
export interface RichRun {
  text: string; face: StdFont; size: number;
  color: [number, number, number]; underline: boolean; strike: boolean;
}
export interface RichParagraph { align: RichAlign; runs: RichRun[] }

const FACES: Record<Family, [StdFont, StdFont, StdFont, StdFont]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** The Standard-14 face for a style: regular, bold, italic, bold-italic. */
export function faceOf(s: RichStyle): StdFont {
  return FACES[s.family][(s.bold ? 1 : 0) + (s.italic ? 2 : 0)];
}

/** A base style from a Standard-14 face — how a FreeText's /DA font seeds the
 *  run model. Symbol and ZapfDingbats are not text faces; they seed Helvetica. */
export function styleFromFace(
  face: StdFont, size: number, color: [number, number, number], align: RichAlign,
): RichStyle {
  const family: Family = face.startsWith('Times') ? 'Times' : face.startsWith('Courier') ? 'Courier' : 'Helvetica';
  const text = family === 'Helvetica' && !face.startsWith('Helvetica') ? 'Helvetica' : face;
  return {
    family, bold: /Bold/.test(text), italic: /Italic|Oblique/.test(text), size,
    color, underline: false, strike: false, align,
  };
}

/** Family names recognised, lower-cased. Probed with hasOwnProperty: a
 *  family name comes from the document, and `in` would find `constructor`. */
const FAMILY_NAMES: Readonly<Record<string, Family>> = {
  helvetica: 'Helvetica', arial: 'Helvetica', 'sans-serif': 'Helvetica',
  times: 'Times', 'times new roman': 'Times', 'times-roman': 'Times', serif: 'Times',
  courier: 'Courier', 'courier new': 'Courier', monospace: 'Courier',
};
const familyNamed = (n: string): Family | undefined =>
  Object.prototype.hasOwnProperty.call(FAMILY_NAMES, n) ? FAMILY_NAMES[n] : undefined;

const positive = (n: number): number | undefined => (Number.isFinite(n) && n > 0 ? n : undefined);

/** A font size from one token: pt, px (x0.75), em (x parent), in, mm, cm,
 *  percent, or a unitless number read as pt — which producers do write. */
function sizeOf(t: CssValue, parent: number): number | undefined {
  if (t.kind === 'dimension') {
    const u = t.unit.toLowerCase();
    const k = u === 'pt' ? 1 : u === 'px' ? 0.75 : u === 'em' ? parent
      : u === 'in' ? 72 : u === 'mm' ? 72 / 25.4 : u === 'cm' ? 72 / 2.54 : undefined;
    return k === undefined ? undefined : positive(t.value * k);
  }
  if (t.kind === 'percentage') return positive((parent * t.value) / 100);
  if (t.kind === 'number') return positive(t.value);
  return undefined;
}

/** The first recognised family among comma-separated parts of `v`. */
function familyOf(v: CssValue[]): Family | undefined {
  const parts: string[][] = [[]];
  for (const t of v) {
    if (t.kind === 'comma') parts.push([]);
    else if (t.kind === 'ident' || t.kind === 'string') parts[parts.length - 1].push(t.value);
  }
  for (const p of parts) {
    const f = familyNamed(p.join(' ').trim().toLowerCase());
    if (f) return f;
  }
  return undefined;
}

/** `font`: style and weight keywords, a size, and a family list, in ANY
 *  order — Acrobat writes `font: Helvetica,sans-serif 12.0pt`, family first,
 *  which a strict CSS reading refuses. A `/line-height` is skipped. Properties
 *  the shorthand does not state are kept rather than reset. */
function applyFont(v: CssValue[], s: RichStyle): void {
  const familyTokens: CssValue[] = [];
  for (let i = 0; i < v.length; i++) {
    const t = v[i];
    if (t.kind === 'whitespace') { familyTokens.push(t); continue; }
    if (t.kind === 'delim' && t.value === '/') {
      while (i + 1 < v.length && v[i + 1].kind === 'whitespace') i++;
      i++;
      continue;
    }
    if (t.kind === 'ident') {
      const k = t.value.toLowerCase();
      if (k === 'italic' || k === 'oblique') { s.italic = true; continue; }
      if (k === 'bold' || k === 'bolder') { s.bold = true; continue; }
      if (k === 'lighter') { s.bold = false; continue; }
      if (k === 'normal') continue;
    }
    if (t.kind === 'number' && t.int && t.value >= 100 && t.value <= 900 && t.value % 100 === 0) {
      s.bold = t.value >= 600;
      continue;
    }
    const size = sizeOf(t, s.size);
    if (size !== undefined && t.kind !== 'number') { s.size = size; continue; }
    familyTokens.push(t);
  }
  const f = familyOf(familyTokens);
  if (f) s.family = f;
}

/** `style` declarations over `s`. A declaration that does not parse, or names
 *  a value this does not read, is skipped: the run keeps what it inherited. */
export function applyStyle(css: string, s: RichStyle): RichStyle {
  const out: RichStyle = { ...s };
  for (const d of parseDeclarationList(css)) {
    if (d.kind !== 'declaration') continue;
    const v = trimWs(d.value);
    if (v.length === 0) continue;
    const kw = v.length === 1 && v[0].kind === 'ident' ? v[0].value.toLowerCase() : undefined;
    switch (d.name.toLowerCase()) {
      case 'font-size': {
        const size = v.length === 1 ? sizeOf(v[0], s.size) : undefined;
        if (size !== undefined) out.size = size;
        break;
      }
      case 'font-weight':
        if (kw === 'bold' || kw === 'bolder') out.bold = true;
        else if (kw === 'normal' || kw === 'lighter') out.bold = false;
        else if (v.length === 1 && v[0].kind === 'number') out.bold = v[0].value >= 600;
        break;
      case 'font-style':
        if (kw === 'italic' || kw === 'oblique') out.italic = true;
        else if (kw === 'normal') out.italic = false;
        break;
      case 'font-family': {
        const f = familyOf(v);
        if (f) out.family = f;
        break;
      }
      case 'font':
        applyFont(v, out);
        break;
      case 'color': {
        const c = colorOf(v);
        if (c && c !== 'currentcolor' && c.a > 0) out.color = [c.rgb[0], c.rgb[1], c.rgb[2]];
        break;
      }
      case 'text-align':
        if (kw === 'left' || kw === 'start') out.align = 'left';
        else if (kw === 'right' || kw === 'end') out.align = 'right';
        else if (kw === 'center' || kw === 'justify') out.align = kw;
        break;
      case 'text-decoration': {
        const words = v.filter((t) => t.kind === 'ident').map((t) => (t as { value: string }).value.toLowerCase());
        if (words.length === 0) break;
        out.underline = words.includes('underline');
        out.strike = words.includes('line-through');
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const sameStyle = (a: RichRun, b: RichRun): boolean =>
  a.face === b.face && a.size === b.size && a.underline === b.underline && a.strike === b.strike
  && a.color[0] === b.color[0] && a.color[1] === b.color[1] && a.color[2] === b.color[2];

/** Accumulates paragraphs while walking. */
class Builder {
  readonly paras: RichParagraph[] = [];
  private cur: RichParagraph | undefined;

  open(align: RichAlign): void { this.close(); this.cur = { align, runs: [] }; }

  close(): void {
    const p = this.cur;
    this.cur = undefined;
    if (!p) return;
    // Trailing whitespace and line breaks are layout, not content.
    while (p.runs.length > 0) {
      const last = p.runs[p.runs.length - 1];
      last.text = last.text.replace(/[ \n]+$/, '');
      if (last.text !== '') break;
      p.runs.pop();
    }
    if (p.runs.length > 0) this.paras.push(p);
  }

  private append(text: string, s: RichStyle): void {
    if (!this.cur) this.cur = { align: s.align, runs: [] };
    const runs = this.cur.runs;
    const last = runs[runs.length - 1];
    const run: RichRun = {
      text, face: faceOf(s), size: s.size, color: s.color, underline: s.underline, strike: s.strike,
    };
    if (last && sameStyle(last, run)) last.text += text;
    else runs.push(run);
  }

  /** XHTML whitespace: every run of whitespace is one space, and a space at the
   *  start of a line — or after one already emitted — is dropped, so a space
   *  never doubles across a run boundary. */
  text(raw: string, s: RichStyle): void {
    let t = raw.replace(/[ \t\r\n\f\v]+/g, ' ');
    const runs = this.cur?.runs ?? [];
    const last = runs[runs.length - 1];
    if (!last || /[ \n]$/.test(last.text)) t = t.replace(/^ /, '');
    if (t !== '') this.append(t, s);
  }

  br(s: RichStyle): void {
    const runs = this.cur?.runs ?? [];
    const last = runs[runs.length - 1];
    if (last) last.text = last.text.replace(/ +$/, '');
    this.append('\n', s);
  }

  visit(node: XmlNode, s: RichStyle): void {
    for (const n of node.nodes) {
      if (typeof n === 'string') { this.text(n, s); continue; }
      const tag = n.name.toLowerCase();
      if (tag === 'br') { this.br(s); continue; }
      let cs = s;
      if (tag === 'b' || tag === 'strong') cs = { ...cs, bold: true };
      if (tag === 'i' || tag === 'em') cs = { ...cs, italic: true };
      const style = n.attrs.get('style');
      if (style !== undefined) cs = applyStyle(style, cs);
      if (RICH_BLOCK_ELEMENTS.has(tag)) {
        this.open(cs.align);
        this.visit(n, cs);
        this.close();
      } else {
        this.visit(n, cs);
      }
    }
  }
}

/** `/RC` markup as paragraphs of styled runs, `/DS` applied beneath
 *  everything, or `undefined` when the markup will not parse — the caller then
 *  draws plain /Contents, and never a regex strip of the markup.
 *
 *  The fragment is wrapped in a synthetic root, as richtext.ts wraps it: a
 *  fragment legitimately has several top-level elements and parseXml returns
 *  one. An element outside the vocabulary is TRANSPARENT — its text kept, its
 *  tag ignored — so unknown markup never loses words. */
export function parseRichText(
  markup: string, ds: string | undefined, base: RichStyle,
): RichParagraph[] | undefined {
  let root: XmlNode;
  try {
    root = parseXml(new TextEncoder().encode(`<pdf4ts-rich>${markup}</pdf4ts-rich>`));
  } catch (caught) {
    rethrowLimit(caught);
    return undefined;
  }
  const b = new Builder();
  b.visit(root, ds === undefined ? base : applyStyle(ds, base));
  b.close();
  return b.paras;
}
```

(`layoutRuns`, `winAnsiDriver`, `FontDriver`, `vmetricsFor`, `serializeString` and `num` are used by Task 2's half; if `tsc` complains about unused imports before then, add them in Task 2 instead.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/richlayout.test.ts && npm run typecheck`
Expected: PASS. If a whitespace case fails, fix the `Builder`, not the test: the expectations are XHTML's rule.

- [ ] **Step 6: Commit**

```bash
git add src/richtext.ts src/formfield.ts src/richlayout.ts test/richlayout.test.ts
git commit -m "feat(v0tz.3): richlayout.ts parses /RC and /DS into styled paragraphs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `richTextBody` — layout and emission

**Files:**
- Modify: `src/richlayout.ts`
- Modify: `src/appearance.ts` (export `PAD`)
- Test: `test/richlayout.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's types.
- Produces: `interface RichBody { body: string; faces: Map<string, StdFont> }` and `richTextBody(paras: readonly RichParagraph[], boxW: number, boxH: number, inset: number): RichBody`.

- [ ] **Step 1: Export `PAD`**

In `src/appearance.ts` change `const PAD = 2;` to `export const PAD = 2;` (one owner of the text inset both paths use).

- [ ] **Step 2: Append the failing tests**

```ts
import { richTextBody } from '../src/richlayout.js';

const body = (markup: string, w = 200, h = 100) => richTextBody(parseRichText(markup, undefined, BASE)!, w, h, 1);

describe('richTextBody', () => {
  it('names each face once, F0 upward in order of first use', () => {
    const r = body('<p>a <b>b</b> <i>c</i> d <b>e</b></p>');
    expect([...r.faces]).toEqual([['F0', 'Helvetica'], ['F1', 'Helvetica-Bold'], ['F2', 'Helvetica-Oblique']]);
    for (const k of ['F0', 'F1', 'F2']) expect(r.body).toContain(`/${k} 12 Tf`);
  });
  it('shows each run in its own colour', () => {
    const r = body('<p>a <span style="color:#FF0000">b</span></p>');
    expect(r.body).toMatch(/1 0 0 rg\s+\(b\) Tj/);
  });
  it('starts each paragraph on a new line, top-anchored', () => {
    const r = body('<p>one</p><p>two</p>');
    const ys = [...r.body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
    expect(ys.length).toBe(2);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[0]).toBeLessThan(100);
  });
  it('a larger run makes its line taller', () => {
    const plain = body('<p>a</p><p>b</p>');
    const big = body('<p>a<span style="font-size:30pt">A</span></p><p>b</p>');
    const gap = (r: { body: string }) => {
      const ys = [...r.body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
      return ys[0] - ys[1];
    };
    expect(gap(big)).toBeGreaterThan(gap(plain));
  });
  it('aligns each paragraph by its own text-align', () => {
    const xs = (m: string) => [...body(m).body.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map((x) => Number(x[1]));
    const left = xs('<p>ab</p>')[0], centre = xs('<p style="text-align:center">ab</p>')[0], right = xs('<p style="text-align:right">ab</p>')[0];
    expect(left).toBeLessThan(centre);
    expect(centre).toBeLessThan(right);
  });
  it('justifies with Tw, and never the last line of a paragraph', () => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    const r = body(`<p style="text-align:justify">${words}</p>`, 120, 200);
    const tws = [...r.body.matchAll(/([\d.]+) Tw/g)].map((m) => Number(m[1]));
    expect(tws.some((t) => t > 0)).toBe(true);
    expect(r.body.trimEnd().split('\n').filter((l) => / Tw$/.test(l)).pop()).toBe('0 Tw');
  });
  it('underline and line-through are filled rects in the run colour', () => {
    const u = body('<p><span style="text-decoration:underline;color:#0000FF">x</span></p>');
    expect(u.body).toMatch(/0 0 1 rg [\d.-]+ [\d.-]+ [\d.]+ [\d.]+ re f/);
    const plainBody = body('<p>x</p>');
    expect(plainBody.body).not.toContain(' re f');
  });
  it('wraps a paragraph wider than the box', () => {
    const r = body('<p>aaaa bbbb cccc dddd eeee ffff gggg hhhh</p>', 60, 200);
    expect([...r.body.matchAll(/ Tm/g)].length).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/richlayout.test.ts`
Expected: FAIL — `richTextBody` is not exported.

- [ ] **Step 4: Implement**

Append to `src/richlayout.ts` (add `import { PAD } from './appearance.js';` — check first with `grep -n "^import" src/appearance.ts` that `appearance.ts` does not import `richlayout.js`; it does not today):

```ts
/** A laid-out rich-text body and the faces its `Tf` operators name. */
export interface RichBody { body: string; faces: Map<string, StdFont> }

/** Space the line's words so it fills `avail`: `Tw` applies to byte 32 of a
 *  single-byte font, which WinAnsi is. Never the last line of a paragraph —
 *  the rule `stamp.ts`'s own justify follows. */
function justifyTw(align: RichAlign, avail: number, line: { text: string; width: number; hardBreak: boolean }): number {
  if (align !== 'justify' || line.hardBreak) return 0;
  let gaps = 0;
  for (const ch of line.text) if (ch === ' ') gaps++;
  const slack = avail - line.width;
  return gaps > 0 && slack > 0 ? slack / gaps : 0;
}

/** Paragraphs laid out by layoutRuns, top-anchored in a `boxW` x `boxH` box
 *  inset by `inset` plus the appearance text PAD, and emitted as one BT…ET
 *  with each line placed by `Tm`, followed by filled rects for underline and
 *  line-through (geometry from textdecor.ts's vmetricsFor, so they sit where
 *  the rest of the library puts them).
 *
 *  A line's baseline sits its `maxFontSize` below the band top and the band is
 *  `height` tall — layoutRuns' per-line rule, so a larger run makes its own
 *  line taller. Text past the box bottom is still emitted: the form's /BBox
 *  clips it, as it clips the plain path, and a viewer does not shrink FreeText
 *  to fit. */
export function richTextBody(
  paras: readonly RichParagraph[], boxW: number, boxH: number, inset: number,
): RichBody {
  const x0 = inset + PAD;
  const avail = Math.max(1, boxW - 2 * (inset + PAD));
  const faces = new Map<string, StdFont>();
  const keys = new Map<StdFont, string>();
  const drivers = new Map<StdFont, FontDriver>();
  const keyOf = (f: StdFont): string => {
    let k = keys.get(f);
    if (k === undefined) { k = `F${keys.size}`; keys.set(f, k); faces.set(k, f); }
    return k;
  };
  const driverOf = (f: StdFont): FontDriver => {
    let d = drivers.get(f);
    if (d === undefined) { d = winAnsiDriver(f); drivers.set(f, d); }
    return d;
  };

  const text: string[] = ['BT'];
  const rules: string[] = [];
  let top = boxH - inset - PAD;
  let curFont = '', curColor = '', curTw = 0;

  for (const p of paras) {
    if (p.runs.length === 0) continue;
    const base = p.runs[0].size;
    const laid = layoutRuns(
      p.runs.map((r) => ({ text: r.text, driver: driverOf(r.face), fontSize: r.size })),
      avail, 1e9, base * 1.15, base,
    );
    for (const line of laid.lines) {
      const baseline = top - line.maxFontSize;
      const tw = justifyTw(p.align, avail, line);
      let x = x0;
      if (p.align === 'center') x = x0 + (avail - line.width) / 2;
      else if (p.align === 'right') x = x0 + avail - line.width;
      if (x < x0) x = x0;
      text.push(`1 0 0 1 ${num(x)} ${num(baseline)} Tm`);
      if (tw !== curTw) { text.push(`${num(tw)} Tw`); curTw = tw; }
      for (const seg of line.segments) {
        const r = p.runs[seg.run];
        let spaces = 0;
        for (const ch of seg.text) if (ch === ' ') spaces++;
        const w = seg.width + tw * spaces;
        if (seg.bytes.length > 0) {
          const font = `/${keyOf(r.face)} ${num(r.size)} Tf`;
          if (font !== curFont) { text.push(font); curFont = font; }
          const color = `${num(r.color[0])} ${num(r.color[1])} ${num(r.color[2])} rg`;
          if (color !== curColor) { text.push(color); curColor = color; }
          text.push(`${serializeString(seg.bytes)} Tj`);
          if (r.underline || r.strike) {
            const vm = vmetricsFor(r.face);
            if (r.underline) {
              const t = vm.underlineThickness * r.size;
              rules.push(`${color} ${num(x)} ${num(baseline + vm.underlineOffset * r.size - t / 2)} ${num(w)} ${num(t)} re f`);
            }
            if (r.strike) {
              const t = vm.strikeThickness * r.size;
              rules.push(`${color} ${num(x)} ${num(baseline + vm.strikeOffset * r.size - t / 2)} ${num(w)} ${num(t)} re f`);
            }
          }
        }
        x += w;
      }
      top -= line.height;
    }
  }
  if (curTw !== 0) text.push('0 Tw');
  text.push('ET');
  return { body: text.join('\n') + (rules.length ? `\n${rules.join('\n')}` : ''), faces };
}
```

The trailing `0 Tw` resets word spacing at the end so it cannot leak into anything the form draws after the text; the justify test's last-`Tw`-is-zero assertion relies on it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/richlayout.test.ts test/import-cycles.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/richlayout.ts src/appearance.ts test/richlayout.test.ts
git commit -m "feat(v0tz.3): richTextBody lays rich paragraphs out through layoutRuns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: FreeText regeneration draws `/RC`

**Files:**
- Modify: `src/annotdraw.ts`
- Test: `test/freetext-rich.test.ts`

**Interfaces:**
- Consumes: `parseRichText`, `richTextBody`, `styleFromFace` (Tasks 1–2); `readRichTextMarkup` (Task 1, from `richtext.js`).
- Produces, in `src/annotdraw.ts`:
  - `interface FreeTextParts { g: WidgetGeom; body: string; faces: Map<string, StdFont>; opacity: number }`
  - `freeTextParts(doc: Document, dict: PdfDict): FreeTextParts | undefined` — reads the dict, allocates nothing.
  - `installShapeAP(doc, dict, g, body, opacity, faces?)` — `faces` defaults to `F0 → Helvetica`.

- [ ] **Step 1: Record the plain-path fence BEFORE touching `annotdraw.ts`**

The fence is the real test file's first case, and its expected value is read off a run of the UNMODIFIED code. Create `test/freetext-rich.test.ts` containing only:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { regenerateAppearance } from '../src/annotdraw.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

/** The /AP /N stream bytes regenerateAppearance installs for a FreeText. */
function regenerated(entries: [string, PdfObject][]): Uint8Array {
  const doc = Document.Open(buildAnnotTarget());
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Annot')], ['Subtype', name('FreeText')], ...entries]);
  expect(regenerateAppearance(doc, dict)).toBe(true);
  const ap = doc.resolve(dict.get('AP'));
  const n = isDict(ap) ? doc.resolve(ap.get('N')) : undefined;
  if (!isStream(n)) throw new Error('no /AP /N');
  return n.raw;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PLAIN: [string, PdfObject][] = [
  ['Rect', [0, 0, 160, 80]],
  ['Contents', str('A plain comment that wraps onto a second line of text')],
  ['DA', str('0 0 1 rg /Helv 11 Tf')],
  ['Q', 1],
  ['RD', [2, 3, 2, 3]],
  ['C', [1, 0, 0]],
  ['IC', [1, 1, 0.8]],
  ['CL', [0, 0, 20, 20, 30, 30]],
];

describe('plain FreeText regeneration is unchanged (fence)', () => {
  it('matches the bytes written before v0tz.3', () => {
    expect(sha(regenerated(PLAIN))).toBe('RECORDED');
  });
});
```

Run: `npx vitest run test/freetext-rich.test.ts` — it fails, printing the actual hash. Replace `'RECORDED'` with that hash and re-run: PASS. **This value is recorded from the unmodified code and must not be updated later**; if it moves after Step 4, the plain path changed and that is the bug.

- [ ] **Step 2: Append the failing tests**

```ts
import { freeTextParts } from '../src/annotdraw.js';
import { decodePng } from './helpers/decode-png.js';

const RC = '<body xmlns="http://www.w3.org/1999/xhtml"><p>Plain <b>BOLD</b> <span style="color:#FF0000">RED</span> <i>ital</i></p><p style="font-size:20pt;font-family:Times">Big</p></body>';

describe('regenerateAppearance draws /RC', () => {
  it('uses one font key per face, each registered in the form', () => {
    const doc = Document.Open(buildAnnotTarget());
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FreeText')], ['Rect', [0, 0, 300, 120]],
      ['Contents', str('Plain BOLD RED ital Big')], ['RC', str(RC)], ['DA', str('0 g /Helv 12 Tf')],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const ap = doc.resolve(dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N'));
    if (!isStream(n)) throw new Error('no stream');
    const fonts = doc.resolve((n.dict.get('Resources') as PdfDict).get('Font')) as PdfDict;
    const base = [...fonts.keys()].map((k) => {
      const f = doc.resolve(fonts.get(k)) as PdfDict;
      return [k, (f.get('BaseFont') as { name: string }).name];
    });
    expect(base).toEqual([['F0', 'Helvetica'], ['F1', 'Helvetica-Bold'], ['F2', 'Helvetica-Oblique'], ['F3', 'Times-Roman']]);
  });

  it('falls back to plain /Contents when /RC will not parse', () => {
    expect(sha(regenerated([...PLAIN, ['RC', str('<p>broken')]]))).toBe(sha(regenerated(PLAIN)));
  });

  it('falls back to plain /Contents when /RC has no text', () => {
    expect(sha(regenerated([...PLAIN, ['RC', str('<p> </p>')]]))).toBe(sha(regenerated(PLAIN)));
  });

  it('draws /RC even with no /Contents', () => {
    const b = new TextDecoder('latin1').decode(regenerated([['Rect', [0, 0, 200, 60]], ['RC', str('<p>only rich</p>')]]));
    expect(b).toContain('(only rich) Tj');
  });

  it('freeTextParts allocates nothing', () => {
    const doc = Document.Open(buildAnnotTarget());
    const before = [...doc.objectEntries()].length;
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FreeText')], ['Rect', [0, 0, 200, 60]], ['RC', str(RC)],
    ]);
    expect(freeTextParts(doc, dict)).toBeDefined();
    expect([...doc.objectEntries()].length).toBe(before);
  });
});

/** An XFDF carrying one FreeText with rich text and no appearance. */
function xfdf(rc: string): Uint8Array {
  return new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
    + '<freetext page="0" rect="50,500,450,620" name="ft1">'
    + '<contents>Plain BOLD RED ital Big</contents>'
    + `<contents-richtext>${rc}</contents-richtext>`
    + '<defaultappearance>0 g /Helv 12 Tf</defaultappearance>'
    + '</freetext></annots></xfdf>');
}

describe('an imported styled FreeText flattens with its styling (v0tz.3)', () => {
  function flattened() {
    const d = Document.Open(buildAnnotTarget());
    d.ImportXfdf(xfdf(RC), { annotations: true });
    d.FlattenAnnotations();
    return Document.Open(d.Save());
  }

  it('keeps each word in its own face and size', () => {
    const frags = flattened().Pages[0].GetTextFragments();
    const of = (t: string) => frags.find((f) => f.text.includes(t));
    expect(of('BOLD')?.fontName).toMatch(/Helvetica-Bold/);
    expect(of('ital')?.fontName).toMatch(/Helvetica-Oblique/);
    expect(of('Big')?.fontName).toMatch(/Times-Roman/);
    expect(of('Big')?.fontSize).toBe(20);
    expect(of('Plain')?.fontName).toMatch(/^(?!.*Bold)/);
  });

  it('paints the red word red', () => {
    const img = decodePng(flattened().Pages[0].ToImage());
    let red = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.at(x, y);
      if (r > 200 && g < 60 && b < 60) red++;
    }
    expect(red).toBeGreaterThan(20);
  });
});
```

Before running, check `buildAnnotTarget`'s page size with `grep -n MediaBox test/helpers/build-annot-target.ts`; if the rect `50,500,450,620` falls outside it, move the rect inside and keep the same 400x120 size.

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/freetext-rich.test.ts`
Expected: the fence PASSES; the `/RC` cases FAIL (`freeTextParts` not exported, plain text drawn).

- [ ] **Step 4: Implement in `src/annotdraw.ts`**

Imports to add: `import { parseRichText, richTextBody, styleFromFace, type RichAlign } from './richlayout.js';`, `import { readRichTextMarkup } from './richtext.js';`, `import { normalizeFont, type StdFont } from './metrics.js';` (merge with the existing `measure` import).

(a) Split the frame out of `freeTextBoxBody`, keeping its output byte-identical:

```ts
/** Fill and inset border of a text box of size w×h at the origin — the part
 *  of a FreeText appearance that does not depend on its text. */
export function freeTextFrame(
  w: number, h: number, color: [number, number, number],
  fill: [number, number, number] | undefined, width: number,
): string {
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n0 0 ${num(w)} ${num(h)} re f\n`;
  if (width > 0) {
    const half = width / 2;
    s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n` +
      `${num(half)} ${num(half)} ${num(w - width)} ${num(h - width)} re S\n`;
  }
  return s;
}
```

and make `freeTextBoxBody` return `freeTextFrame(w, h, color, fill, width) + wrapTextBody(contents, 'Helvetica', fontSize, textColor, w, h, width, align, AP_FONT_KEY)`.

(b) Let `installShapeAP` register several faces:

```ts
export function installShapeAP(
  doc: Document, dict: PdfDict, g: WidgetGeom, body: string, opacity: number,
  faces: ReadonlyMap<string, StdFont> = new Map([[AP_FONT_KEY, 'Helvetica']]),
): void {
  let full = '';
  if (opacity < 1) full += '/GS0 gs\n';
  full += body;
  const [[firstKey, firstFace], ...rest] = [...faces];
  const stream = buildAppearanceXObject(doc, g, firstFace, firstKey, full);
  const resources = stream.dict.get('Resources') as PdfDict;
  const fonts = resources.get('Font') as PdfDict;
  for (const [key, face] of rest) {
    fonts.set(key, doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type1')],
      ['BaseFont', name(face)], ['Encoding', name('WinAnsiEncoding')],
    ])));
  }
  if (opacity < 1) {
    const gsDict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', opacity], ['CA', opacity],
    ]);
    resources.set('ExtGState', new Map<string, PdfObject>([['GS0', doc.allocObject(gsDict)]]));
  }
  installAP(doc, dict, stream);
}
```

(The default argument reproduces today's single `buildAppearanceXObject(doc, g, 'Helvetica', AP_FONT_KEY, full)` call, so every other caller is byte-identical.)

(c) Replace `freeTextBody` with a builder that returns parts, and export `freeTextParts`:

```ts
export interface FreeTextParts {
  g: WidgetGeom; body: string; faces: Map<string, StdFont>; opacity: number;
}

/** The rich paragraphs a FreeText's /RC describes, over its /DA and /DS, or
 *  undefined — no /RC, markup that will not parse, or markup with no text —
 *  in which case the caller draws plain /Contents (`v0tz.3`). */
function richParagraphs(doc: Document, dict: PdfDict, face: StdFont, size: number,
  color: [number, number, number], align: RichAlign) {
  const rc = readRichTextMarkup(doc, dict, 'RC');
  if (rc === undefined) return undefined;
  const dsRaw = doc.resolve(dict.get('DS'));
  const ds = isString(dsRaw) ? decodePdfText(dsRaw.bytes) : undefined;
  const paras = parseRichText(rc, ds, styleFromFace(face, size, color, align));
  return paras !== undefined && paras.length > 0 ? paras : undefined;
}

/** Body for /FreeText: /RC when it yields styled text, else /Contents; /DA,
 *  /Q and /RD as before, plus /CL when present. */
function freeTextBody(
  doc: Document, dict: PdfDict, g: WidgetGeom, minX: number, minY: number,
  color: RGB, fill: RGB | undefined, width: number,
): { body: string; faces: Map<string, StdFont> } | undefined {
  const daRaw = doc.resolve(dict.get('DA'));
  const da = isString(daRaw) ? parseDA(decodePdfText(daRaw.bytes)) : undefined;
  const fontSize = da !== undefined && da.size > 0 ? da.size : 12;
  const textColor: RGB = da !== undefined ? da.color : [0, 0, 0];

  const q = doc.resolve(dict.get('Q'));
  const align = q === 1 ? 'center' : q === 2 ? 'right' : 'left';

  const rd = numsOf(doc, dict.get('RD'));
  const [padL, padT, padR, padB] = rd.length === 4 ? rd : [0, 0, 0, 0];
  const boxW = g.w - padL - padR;
  const boxH = g.h - padT - padB;
  if (boxW <= 0 || boxH <= 0) return undefined;

  const face = da !== undefined ? normalizeFont(da.fontName) : 'Helvetica';
  const rich = richParagraphs(doc, dict, face, fontSize, textColor, align);
  let inner: string;
  let faces: Map<string, StdFont>;
  if (rich !== undefined) {
    const r = richTextBody(rich, boxW, boxH, width);
    inner = freeTextFrame(boxW, boxH, color, fill, width) + r.body;
    faces = r.faces;
  } else {
    const contentsRaw = doc.resolve(dict.get('Contents'));
    if (!isString(contentsRaw)) return undefined;
    inner = freeTextBoxBody(boxW, boxH, decodePdfText(contentsRaw.bytes), fontSize, textColor, align, color, fill, width);
    faces = new Map([[AP_FONT_KEY, 'Helvetica']]);
  }

  let body = `q 1 0 0 1 ${num(padL)} ${num(padB)} cm\n` + inner + '\nQ\n';

  const cl = numsOf(doc, dict.get('CL'));
  if (cl.length === 4 || cl.length === 6) {
    const p = toFormSpace(cl, minX, minY);
    body += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width || 1)} w\n`;
    body += `${num(p[0])} ${num(p[1])} m `;
    for (let i = 2; i < p.length; i += 2) body += `${num(p[i])} ${num(p[i + 1])} l `;
    body += 'S\n';
    const le = doc.resolve(dict.get('LE'));
    const ending = isName(le) ? (le.name as LineEnding) : 'OpenArrow';
    if (ending !== 'None') {
      const [dx, dy] = unitDir(p[2], p[3], p[0], p[1]);
      body += drawEnding(p[0], p[1], dx, dy, ending, Math.max(8, width * 3), color);
    }
  }
  return { body, faces };
}

/** Everything a FreeText's appearance needs, read from the dict and allocating
 *  NOTHING, so `regenerateAppearance` can install it and
 *  `annotappearance.ts`'s viewer fallback can wrap it inline (`v0tz.3`). */
export function freeTextParts(doc: Document, dict: PdfDict): FreeTextParts | undefined {
  const g = widgetGeom(doc, dict);
  if (!g) return undefined;
  const rect = numsOf(doc, dict.get('Rect'));
  if (rect.length !== 4) return undefined;
  const color = colorOf(doc, dict.get('C')) ?? [0, 0, 0];
  const fill = colorOf(doc, dict.get('IC'));
  const width = widthOf(doc, dict);
  const ca = doc.resolve(dict.get('CA'));
  const opacity = typeof ca === 'number' && ca >= 0 && ca <= 1 ? ca : 1;
  const parts = freeTextBody(doc, dict, g, Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), color, fill, width);
  return parts && { g, body: parts.body, faces: parts.faces, opacity };
}
```

Compare `freeTextParts`'s reads with the top of `regenerateAppearance` before committing — `colorOf`, `widthOf` and the opacity rule must be the SAME helpers so the two paths agree. Then change the FreeText case in `regenerateAppearance`:

```ts
    case 'FreeText': {
      const parts = freeTextParts(doc, dict);
      if (parts === undefined) return false;
      installShapeAP(doc, dict, parts.g, parts.body, parts.opacity, parts.faces);
      return true;
    }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/freetext-rich.test.ts test/annotdraw.test.ts test/ap-font-key.test.ts test/import-cycles.test.ts test/annotation.test.ts && npm run typecheck`
Expected: PASS, the fence unchanged. If the fence moved, diff the two bodies before changing anything.

- [ ] **Step 6: Commit**

```bash
git add src/annotdraw.ts test/freetext-rich.test.ts
git commit -m "feat(v0tz.3): FreeText regeneration draws /RC rich text

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The no-`/AP` FreeText fallback

**Files:**
- Modify: `src/annotappearance.ts`
- Test: `test/freetext-rich.test.ts` (append)

**Interfaces:**
- Consumes: `freeTextParts` (Task 3).

- [ ] **Step 1: Append the failing tests**

```ts
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';

function freeTextPage(entries: string): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Annots [4 0 R] >>',
    `<< /Type /Annot /Subtype /FreeText /Rect [20 20 380 180] ${entries} >>`,
  ]);
}
const RC_PDF = '(<p>Plain <b>BOLD</b> <span style="color:#FF0000">RED</span></p>)';

describe('a FreeText with no /AP is drawn from /RC (v0tz.3)', () => {
  it('draws its styled text, readable by SearchAnnotations', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    expect(d.Pages[0].SearchAnnotations('BOLD').length).toBe(1);
  });

  it('with no /RC draws plain /Contents', () => {
    const d = Document.Open(freeTextPage('/DA (0 g /Helv 12 Tf) /Contents (hello there)'));
    expect(d.Pages[0].SearchAnnotations('hello').length).toBe(1);
  });

  it('flattens with its styling', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    d.FlattenAnnotations();
    const frags = Document.Open(d.Save()).Pages[0].GetTextFragments();
    expect(frags.find((f) => f.text.includes('BOLD'))?.fontName).toMatch(/Helvetica-Bold/);
  });

  it('rendering allocates nothing and writes no /AP', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    const before = [...d.objectEntries()].length;
    d.Pages[0].ToImage();
    d.Pages[0].ToSvg();
    expect([...d.objectEntries()].length).toBe(before);
    expect(d.Pages[0].Annotations[0].Dict.has('AP')).toBe(false);
  });

  it('a present /AP is respected', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF} /AP << /N << /On 9 0 R >> >> /AS /Off`));
    expect(d.Pages[0].SearchAnnotations('BOLD').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/freetext-rich.test.ts`
Expected: the new describe FAILS (nothing drawn).

- [ ] **Step 3: Implement**

In `src/annotappearance.ts` add `import { freeTextParts } from './annotdraw.js';` and a branch in `viewerAppearance`:

```ts
  if (isName(sub) && sub.name === 'FreeText') return freeTextAppearance(doc, annot);
```

and:

```ts
/** A /FreeText with no /AP, drawn from /RC (else /Contents) exactly as
 *  `regenerateAppearance` would draw it — one builder, `freeTextParts` — but
 *  wrapped INLINE: its fonts and any /GS0 live in the stream's own
 *  /Resources, so rendering allocates nothing (`v0tz.3`). */
function freeTextAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const parts = freeTextParts(doc, annot);
  if (parts === undefined) return undefined;
  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const fonts = new Map<string, PdfObject>();
  for (const [key, face] of parts.faces) {
    fonts.set(key, new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type1')],
      ['BaseFont', name(face)], ['Encoding', name('WinAnsiEncoding')],
    ]));
  }
  const resources = new Map<string, PdfObject>([['Font', fonts]]);
  let content = parts.body;
  if (parts.opacity < 1) {
    resources.set('ExtGState', new Map<string, PdfObject>([['GS0', new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', parts.opacity], ['CA', parts.opacity],
    ])]]));
    content = `/GS0 gs\n${content}`;
  }
  const raw = new TextEncoder().encode(`q\n${content}\nQ`);
  const bbox = [0, 0, parts.g.w, parts.g.h];
  const stream: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', bbox],
      ['Resources', resources], ['Length', raw.length],
    ]),
    raw,
  };
  const place = placementMatrix(bbox, IDENTITY, rect);
  if (place === undefined) return undefined;
  return { entry: stream, stream, place };
}
```

A FreeText has no `/MK /R`, so `parts.g` carries `rotate: 0` and the identity placement is the same one `buildAppearanceXObject` would compute.

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/freetext-rich.test.ts test/import-cycles.test.ts && npm run typecheck && npm test`
Expected: PASS. A pre-existing test that asserted an AP-less FreeText draws nothing is a deliberate change — fix its FIXTURE (give the annotation a subtype with no fallback, e.g. `/Square`) so it keeps its meaning, as `v0tz.2` did with `build-flatten-target.ts`, and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/annotappearance.ts test/freetext-rich.test.ts
git commit -m "feat(v0tz.3): a FreeText with no /AP draws /RC on the fly

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Mutations, docs, gates, close

**Files:** `README.md`, `CHANGELOG.md`, `CLAUDE.md`.

- [ ] **Step 1: Mutation-check**

Write a runner script (to a file) that applies each mutation, runs `npx vitest run test/richlayout.test.ts test/freetext-rich.test.ts`, reports `N red` / `GREEN` / a worker crash, and restores the file. Treat "Worker exited unexpectedly" as red. Mutations:

1. `familyOf`: return the LAST recognised part instead of the first.
2. `familyNamed`: `in` instead of `hasOwnProperty` — expect GREEN unless a `font-family: constructor` case exists; if green, add one to `richlayout.test.ts` and re-run.
3. `applyFont`: drop the size branch.
4. `sizeOf`: `px` factor 1.
5. `Builder.text`: stop dropping the leading space after an existing space.
6. `Builder.visit`: treat every element as a block.
7. `Builder.visit`: ignore `<b>`.
8. `parseRichText`: drop the `/DS` application.
9. `richTextBody`: new face keys all `F0`.
10. `richTextBody`: omit the `rg` when the colour changes.
11. `justifyTw`: justify the last line too.
12. `richTextBody`: baseline at `top - base` instead of `top - line.maxFontSize`.
13. `freeTextBody`: always take the plain path.
14. `richParagraphs`: accept an empty paragraph list (return `paras` when defined).
15. `installShapeAP`: register only the first face.
16. `viewerAppearance`: drop the FreeText branch.

Every one must go red; record the counts for CLAUDE.md, and add a case for any that stays green before moving on.

- [ ] **Step 2: Docs**

- **README** (Key Capabilities › Annotations bullet, after the stamp sentence): a FreeText's `/RC` rich text is drawn — `<b>`, `<i>`, `<span>` styles over `/DS` and `/DA`: size, weight, style, family (Helvetica, Times, Courier; the first recognised name in a list), colour, alignment, underline and line-through — on XFDF/FDF import and for a FreeText with no `/AP`; markup that will not parse falls back to plain `/Contents`; backgrounds, margins and nested block layout are not rendered; rich-text form fields are a separate, open feature.
- **CHANGELOG** `### Added` under `[Unreleased]`: **Styled FreeText comments keep their styling.** What went wrong (a styled comment imported from XFDF flattened as plain text; one with no appearance drew nothing), what is drawn now, the parse-failure fallback, what is out of scope. `(v0tz.3)`
- **CLAUDE.md**: a **richlayout.ts** entry after **richtext.ts** — the leaf's imports and why (one XML parser, one block rule, one CSS grammar, one wrapping engine); the family-stack and `/DS` rules; `font` read in any order because Acrobat writes family first; the fallback to plain `/Contents` for unparseable or empty `/RC`; font keys `F0…` in first-use order; `freeTextParts` as the one builder with two wrappers; the plain-path hash fence; the mutation counts. Update the **richtext.ts** entry: `readRichTextMarkup` now lives there (the note saying it lives in `formfield.ts` must change), re-exported by `formfield.ts`, moved because `formfield.ts → flatten.ts → annotappearance.ts` would close a cycle.
- Run the module-doc sweep and confirm it prints nothing:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 3: Gates**

Run: `npm run typecheck` and `npm test`. Both green.

- [ ] **Step 4: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md test/richlayout.test.ts
git commit -m "docs(v0tz.3): FreeText rich text in README, CHANGELOG and CLAUDE.md

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-v0tz.3
git add .beads/interactions.jsonl
git commit -m "chore: beads interaction log

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status
```

Expected: up to date with origin.
