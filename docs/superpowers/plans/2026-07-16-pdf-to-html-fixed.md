# PDF → HTML export Phase 2 (fixed mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mode: 'fixed'` to `doc.ToHtml` / `page.ToHtml` — a visual page reproduction with absolutely positioned text over an SVG vector backdrop.

**Architecture:** A new `HtmlSink implements RenderSink` delegates every non-text op to an internal `SvgSink` (the backdrop) and diverts `glyphRun` to absolutely positioned `<span>`s, so one `interpret()` pass yields both layers and text is never drawn twice. A new `htmlfont.ts` maps the generic font family + bold/italic to a CSS stack, weight, style, and a calibrated ascent ratio; text `top` is `baseline − ratio·size`. `html.ts` gains a fixed dispatch branch and per-mode CSS.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime dependencies (`node:` built-ins only).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { fmt } from './svgrender.js'`).
- **TDD** — every task writes the failing test first, watches it fail, then writes minimal code.
- **`ToHtml` never throws** except for genuinely unimplemented input — after this plan there is no such input; fixed mode degrades per-page like `renderPageToSvg`.
- **Units** — all fixed-mode lengths are CSS **px**, one per PDF unit, matching the unitless `SvgSink` backdrop viewBox.
- **Ascent ratios (family-keyed, calibrated):** serif `"Times New Roman", Times, serif` → **0.836**; sans-serif `Arial, Helvetica, sans-serif` → **0.846**; monospace `"Courier New", Courier, monospace` → **0.756**.
- **Gate before closing:** `npm run typecheck` and `npm test` both green.

Spec: `docs/superpowers/specs/2026-07-16-pdf-to-html-export-design.md`.

---

### Task 1: `htmlfont.ts` — font mapping + class dedup

**Files:**
- Create: `src/htmlfont.ts`
- Test: `test/htmlfont.test.ts`

**Interfaces:**
- Consumes: `Rgb`, `rgbHex` from `./colorspace.js`.
- Produces:
  - `export function resolveFont(fontFamily: string, bold: boolean, italic: boolean): { stack: string; weight: number; style: 'normal' | 'italic'; ascent: number }`
  - `export interface RunFont { cls: string; ascent: number }`
  - `export class FontRegistry { get(fontFamily: string, bold: boolean, italic: boolean, color: Rgb): RunFont; css(): string }`

- [ ] **Step 1: Write the failing test**

Create `test/htmlfont.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveFont, FontRegistry } from '../src/htmlfont.js';

describe('resolveFont', () => {
  it('maps serif to the Times New Roman stack with ascent 0.836', () => {
    expect(resolveFont('serif', false, false)).toEqual({
      stack: '"Times New Roman", Times, serif', weight: 400, style: 'normal', ascent: 0.836,
    });
  });

  it('maps monospace bold+italic to Courier New, weight 700, italic, ascent 0.756', () => {
    expect(resolveFont('monospace', true, true)).toEqual({
      stack: '"Courier New", Courier, monospace', weight: 700, style: 'italic', ascent: 0.756,
    });
  });

  it('falls back to the Arial sans-serif stack (ascent 0.846) for any other family', () => {
    expect(resolveFont('sans-serif', false, false).stack).toBe('Arial, Helvetica, sans-serif');
    expect(resolveFont('sans-serif', false, false).ascent).toBe(0.846);
  });
});

describe('FontRegistry', () => {
  it('shares one class across identical (family,weight,style,color) tuples', () => {
    const r = new FontRegistry();
    const a = r.get('serif', false, false, [0, 0, 0]);
    const b = r.get('serif', false, false, [0, 0, 0]);
    expect(a.cls).toBe(b.cls);
    expect(a.ascent).toBe(0.836);
  });

  it('assigns distinct classes for differing tuples and emits their CSS', () => {
    const r = new FontRegistry();
    const a = r.get('serif', false, false, [0, 0, 0]);
    const c = r.get('serif', true, false, [0, 0, 0]);
    expect(c.cls).not.toBe(a.cls);
    expect(r.css()).toContain('.f0{font-family:"Times New Roman", Times, serif;font-weight:400;font-style:normal;color:#000000}');
    expect(r.css()).toContain('.f1{font-family:"Times New Roman", Times, serif;font-weight:700;font-style:normal;color:#000000}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlfont.test.ts`
Expected: FAIL — `Cannot find module '../src/htmlfont.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/htmlfont.ts`:

```typescript
import { Rgb, rgbHex } from './colorspace.js';

/** Map the generic family (already derived by `pagerender.applyFontStyle`) plus
 *  bold/italic to a CSS font stack, weight, style, and the calibrated ascent
 *  ratio used to convert a PDF baseline to a CSS `top`. Ratios were measured in
 *  a browser against these exact stacks (see the design spec); they are size-
 *  and style-independent, so the ascent keys on family alone. */
export function resolveFont(
  fontFamily: string, bold: boolean, italic: boolean,
): { stack: string; weight: number; style: 'normal' | 'italic'; ascent: number } {
  const f = fontFamily === 'serif'
    ? { stack: '"Times New Roman", Times, serif', ascent: 0.836 }
    : fontFamily === 'monospace'
    ? { stack: '"Courier New", Courier, monospace', ascent: 0.756 }
    : { stack: 'Arial, Helvetica, sans-serif', ascent: 0.846 };
  return { stack: f.stack, ascent: f.ascent, weight: bold ? 700 : 400, style: italic ? 'italic' : 'normal' };
}

export interface RunFont { cls: string; ascent: number; }

/** Assigns a CSS class (`f0`, `f1`, …) per distinct (stack, weight, style,
 *  color) tuple and emits the matching rules — dedup is document-wide. */
export class FontRegistry {
  private map = new Map<string, { cls: string; rule: string }>();

  get(fontFamily: string, bold: boolean, italic: boolean, color: Rgb): RunFont {
    const r = resolveFont(fontFamily, bold, italic);
    const hex = rgbHex(color);
    const key = `${r.stack}|${r.weight}|${r.style}|${hex}`;
    let e = this.map.get(key);
    if (!e) {
      const cls = `f${this.map.size}`;
      const rule = `.${cls}{font-family:${r.stack};font-weight:${r.weight};font-style:${r.style};color:${hex}}`;
      e = { cls, rule };
      this.map.set(key, e);
    }
    return { cls: e.cls, ascent: r.ascent };
  }

  css(): string {
    return [...this.map.values()].map((e) => e.rule).join('');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/htmlfont.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/htmlfont.ts test/htmlfont.test.ts
git commit -m "feat(ec5): htmlfont — PDF font family -> CSS stack + ascent ratio"
```

---

### Task 2: Fixed mode end-to-end — `SvgSink` export, `htmlfixed.ts`, `html.ts` wiring

**Files:**
- Modify: `src/svgrender.ts:64` (add `export` to `class SvgSink`)
- Create: `src/htmlfixed.ts`
- Modify: `src/html.ts` (add `fixedBody` dispatch, per-mode CSS, `shell` takes a CSS argument)
- Test: `test/html.test.ts` (add a `fixed mode` describe block; remove the "rejects the unimplemented fixed mode" test)

**Interfaces:**
- Consumes: `SvgSink`, `fmt` from `./svgrender.js`; `interpret`, `baseMatrix`, `RenderSink`, `Path`, `StrokeStyle`, `TextRunInfo` from `./pagerender.js`; `Matrix`, `mul`, `translate` from `./text.js`; `escapeHtml`, `HtmlOptions` from `./html.js`; `FontRegistry` from `./htmlfont.js` (Task 1); `Rgb` from `./colorspace.js`; `PdfDict`, `PdfStream` from `./types.js`.
- Produces: `export function fixedBody(doc: Document, pages: Page[], opts: HtmlOptions): { body: string; css: string }`.

- [ ] **Step 1: Write the failing test**

In `test/html.test.ts`, add these imports at the top (alongside the existing ones):

```typescript
import { buildSvgPdf, TEXT_CONTENT, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';
```

Then add this describe block:

```typescript
describe('ToHtml — fixed mode', () => {
  const textDoc = () => Document.Open(
    buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT }));

  it('positions a run at its device baseline, ascent-adjusted', () => {
    // TEXT_CONTENT: Helvetica-Bold size 24 at (72,100) on a 200x200 page.
    // baseMatrix flips y -> device baseline (72,100). sans-serif ascent 0.846:
    // top = 100 - 0.846*24 = 79.696.
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('<span class="f0" style="left:72px;top:79.696px;font-size:24px">Hi</span>');
  });

  it('emits an SVG backdrop inside a page div sized to the crop box', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('<div class="pg" style="width:200px;height:200px">');
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"');
  });

  it('never draws text into the backdrop (no <text>, "Hi" appears once)', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).not.toContain('<text');
    expect((html.match(/Hi/g) ?? []).length).toBe(1);
  });

  it('emits the font class CSS in the shell', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('.f0{font-family:Arial, Helvetica, sans-serif;font-weight:700;font-style:normal;color:#000000}');
  });
});
```

Also **delete** the existing test in the `ToHtml — shell` block:

```typescript
  it('rejects the unimplemented fixed mode', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    expect(() => doc.ToHtml({ mode: 'fixed' })).toThrow(UnsupportedFeatureError);
  });
```

(Leave the `UnsupportedFeatureError` import in place — other tests may use it; if the linter flags it as unused after this, remove that single import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL — the fixed-mode `ToHtml` still throws `UnsupportedFeatureError`, so the four new assertions fail.

- [ ] **Step 3a: Export `SvgSink`**

In `src/svgrender.ts`, change the class declaration:

```typescript
/** RenderSink that emits a standalone SVG document. */
export class SvgSink implements RenderSink {
```

- [ ] **Step 3b: Create `src/htmlfixed.ts`**

```typescript
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul, translate } from './text.js';
import { PdfDict, PdfStream } from './types.js';
import { Rgb } from './colorspace.js';
import { interpret, baseMatrix, RenderSink, Path, StrokeStyle, TextRunInfo } from './pagerender.js';
import { SvgSink, fmt } from './svgrender.js';
import { escapeHtml, HtmlOptions } from './html.js';
import { FontRegistry } from './htmlfont.js';

/** RenderSink that paints non-text ops onto an internal SvgSink backdrop and
 *  diverts each glyph run to an absolutely positioned <span>. One interpret()
 *  pass yields both layers, so text is never drawn twice. */
class HtmlSink implements RenderSink {
  private svg: SvgSink;
  private spans: string[] = [];
  constructor(doc: Document, private fonts: FontRegistry) {
    this.svg = new SvgSink(doc);
  }

  save(): void { this.svg.save(); }
  restore(): void { this.svg.restore(); }
  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void { this.svg.addClip(path, ctm, evenOdd); }
  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void { this.svg.fill(path, ctm, color, evenOdd); }
  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void { this.svg.stroke(path, ctm, color, style); }
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void { this.svg.image(stream, ctm, fillColor); }
  shading(dict: PdfDict, ctm: Matrix): void { this.svg.shading(dict, ctm); }

  glyphRun(info: TextRunInfo): void {
    const text = info.decoded.text;
    if (text.length === 0) return;
    // L: text space -> device space (ctm already folds in baseMatrix).
    const L = mul(mul(translate(0, info.rise), info.tm), info.ctm);
    const { cls, ascent } = this.fonts.get(info.fontFamily, info.bold, info.italic, info.color);
    const [a, b, c, d, e, f] = L;
    const size = info.fontSize;
    // Fast path: axis-aligned, upright, uniform scale — plain left/top/font-size.
    const upright = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d < 0
      && Math.abs(Math.abs(a) - Math.abs(d)) < 1e-6;
    let style: string;
    if (upright) {
      const dev = size * Math.abs(d);
      style = `left:${fmt(e)}px;top:${fmt(f - ascent * dev)}px;font-size:${fmt(dev)}px`;
    } else {
      // General path: same PDF-y-up -> CSS-y-down flip SvgSink uses (-c,-d);
      // the inner translateY applies the baseline->top shift in local space so
      // it rotates with the text.
      const m = `matrix(${[a, b, -c, -d, 0, 0].map(fmt).join(',')}) translateY(${fmt(-ascent * size)}px)`;
      style = `left:${fmt(e)}px;top:${fmt(f)}px;font-size:${fmt(size)}px;transform:${m}`;
    }
    this.spans.push(`<span class="${cls}" style="${style}">${escapeHtml(text)}</span>`);
  }

  /** The SVG backdrop followed by the positioned spans. */
  finish(width: number, height: number): string {
    return this.svg.finish(width, height) + this.spans.join('');
  }
}

/** Build the fixed-mode body — one `<div class="pg">` per page — plus the
 *  document-wide font-class CSS. Never throws per page: a page that fails
 *  mid-walk contributes whatever was emitted, matching renderPageToSvg. */
export function fixedBody(
  doc: Document, pages: Page[], opts: HtmlOptions,
): { body: string; css: string } {
  const box = opts.box ?? 'crop';
  const fonts = new FontRegistry();
  const divs: string[] = [];
  for (const page of pages) {
    const { matrix, width, height } = baseMatrix(page, box);
    const sink = new HtmlSink(doc, fonts);
    try {
      interpret(doc, page, matrix, sink, { annotations: opts.annotations });
    } catch {
      // Degrade: whatever was emitted before the failure still renders.
    }
    divs.push(`<div class="pg" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + sink.finish(width, height) + `</div>`);
  }
  return { body: divs.join('\n'), css: fonts.css() };
}
```

- [ ] **Step 3c: Wire fixed mode into `src/html.ts`**

Add the import near the other body-builder imports:

```typescript
import { fixedBody } from './htmlfixed.js';
```

Add a fixed-mode stylesheet constant next to the existing `CSS` constant:

```typescript
const FIXED_CSS = [
  '.pg{position:relative;background:#fff;margin:0 auto 8px;overflow:hidden}',
  '.pg>svg{position:absolute;left:0;top:0}',
  '.pg>span{position:absolute;white-space:pre;line-height:1;transform-origin:0 0}',
].join('');
```

Change `shell` to take the stylesheet as an argument:

```typescript
function shell(doc: Document, body: string, opts: HtmlOptions, css: string): string {
  const title = opts.title ?? doc.GetMetadata().title ?? '';
  const lang = doc.Lang;
  const langAttr = lang ? ` lang="${escapeHtml(lang)}"` : '';
  return `<!doctype html>\n<html${langAttr}>\n<head>\n<meta charset="utf-8">\n`
    + `<title>${escapeHtml(title)}</title>\n<style>${css}</style>\n</head>\n`
    + `<body>\n${body}\n</body>\n</html>\n`;
}
```

Replace the body of `render` (the whole function) with:

```typescript
function render(doc: Document, pages: Page[], opts: HtmlOptions): string {
  const mode = opts.mode ?? 'semantic';
  if (mode === 'fixed') {
    let out = { body: '', css: '' };
    try {
      out = fixedBody(doc, pages, opts);
    } catch {
      // Degrade: emit a well-formed shell around whatever was produced.
    }
    return opts.fragment ? out.body : shell(doc, out.body, opts, FIXED_CSS + out.css);
  }
  let body = '';
  try {
    body = bodyFor(doc, pages, opts);
  } catch {
    // Degrade: emit a well-formed shell around whatever was produced. Matches
    // renderPageToSvg, which never throws.
  }
  return opts.fragment ? body : shell(doc, body, opts, CSS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/html.test.ts test/htmlfont.test.ts`
Expected: PASS — all fixed-mode assertions green, existing semantic/shell tests still green, the removed "rejects" test gone.

- [ ] **Step 5: Commit**

```bash
git add src/svgrender.ts src/htmlfixed.ts src/html.ts test/html.test.ts
git commit -m "feat(ec5): fixed-mode HTML export — positioned spans over SvgSink backdrop"
```

---

### Task 3: Rotated runs, multi-page, round-trip, fragment

**Files:**
- Test: `test/html.test.ts` (extend the `fixed mode` describe block)

**Interfaces:**
- Consumes: `fixedBody` behavior via the public `ToHtml` (Task 2); `buildMultiPageTaggedPdf` from `./helpers/build-multipage-tagged-pdf.js`.
- Produces: no new source symbols — this task proves the general path and document-level behavior already implemented in Task 2.

- [ ] **Step 1: Write the failing tests**

Add the import near the other helper imports in `test/html.test.ts` (it may already be present from Phase 1 — do not duplicate):

```typescript
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
```

Add these tests inside the `ToHtml — fixed mode` describe block:

```typescript
  it('emits a CSS transform for a rotated run', () => {
    // 90-degree rotation via cm before the text; L gains off-diagonal terms,
    // so glyphRun takes the transform path.
    const content = 'q 0 1 -1 0 100 0 cm BT /F1 24 Tf 10 10 Td (Hi) Tj ET Q';
    const doc = Document.Open(
      buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content }));
    const html = doc.Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('transform:matrix(');
  });

  it('renders every page as its own div inside one document', () => {
    const html = Document.Open(buildMultiPageTaggedPdf()).ToHtml({ mode: 'fixed' });
    expect((html.match(/<div class="pg"/g) ?? []).length).toBe(2);
    expect((html.match(/<html/g) ?? []).length).toBe(1);
    expect(html).toContain('Page one body');
    expect(html).toContain('Page two body');
  });

  it('round-trips text: fixed output contains every GetText word', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ mode: 'fixed', fragment: true });
    const stripped = html.replace(/<[^>]+>/g, '');
    for (const word of doc.Pages[0].GetText().split(/\s+/).filter(Boolean)) {
      expect(stripped).toContain(word);
    }
  });

  it('omits the shell (and its font CSS) for fragment: true', () => {
    const doc = Document.Open(
      buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT }));
    const html = doc.Pages[0].ToHtml({ mode: 'fixed', fragment: true });
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('<style>');
    expect(html).toContain('<div class="pg"');
  });
```

- [ ] **Step 2: Run tests to verify they pass immediately**

Run: `npx vitest run test/html.test.ts`
Expected: PASS. These behaviors were implemented in Task 2; this task locks them with tests. If any fails, fix the Task 2 code (not the test):
- rotated missing `transform:` → check the `upright` predicate signs.
- fragment still shows `<style>` → `render` must return `out.body` (not the shell) when `opts.fragment`.

- [ ] **Step 3: Commit**

```bash
git add test/html.test.ts
git commit -m "test(ec5): fixed-mode rotated/multi-page/round-trip/fragment coverage"
```

---

### Task 4: Docs — README + full gate

**Files:**
- Modify: `README.md` (feature bullet ~line 48; API table ~lines 882–883; Limitations ~line 928)

**Interfaces:**
- Consumes: nothing new.
- Produces: user-facing documentation only.

- [ ] **Step 1: Update the feature bullet**

In `README.md`, find the `**Export (PDF → HTML)**` bullet (~line 48) and append this sentence before "Never throws":

```markdown
 `mode: 'fixed'` instead reproduces page appearance: each page becomes a `<div class="pg">` holding an SVG vector backdrop (paths, images, shadings — the same output as `ToSvg`) with the text as absolutely positioned `<span>`s over it, one `interpret` pass so text is never double-drawn. Text is placed at its PDF baseline via a per-family calibrated ascent (`top = baseline − ratio·size`); runs carrying rotation or skew keep a `transform: matrix(…)`. Fonts map to CSS family stacks (Times New Roman / Arial / Courier New) with weight and style — no `@font-face` embedding, so a viewer lacking a named font sees a small baseline drift.
```

- [ ] **Step 2: Update the API-table rows**

Replace the two `ToHtml` rows (~lines 882–883):

```markdown
| `doc.ToHtml(options?)` | Export every page to one standalone HTML document. `mode: 'semantic'` (default, reflowable; `/StructTree`-driven when tagged, font-size heuristics otherwise) or `mode: 'fixed'` (positioned text over an SVG vector backdrop); `{ fragment: true }` for body markup only |
| `page.ToHtml(options?)` | Export one page to a standalone HTML document (same options; a tagged semantic tree is filtered to this page's content, ancestors intact) |
```

- [ ] **Step 3: Update the Limitations bullet**

Replace the `**HTML export is semantic-only for now**` bullet (~line 928) with:

```markdown
- **HTML export** — `ToHtml` ships both `mode: 'semantic'` (reflowable) and `mode: 'fixed'` (visual reproduction with absolutely positioned text over a vector backdrop). Fixed mode has no `@font-face` embedding, so text renders in a mapped CSS family stack (Times New Roman / Arial / Courier New) and a viewer lacking a named font sees a small baseline drift (bounded by the ascent-ratio gap, well under a pixel at body sizes); embedding font programs as data URIs is future work. Semantic output carries no font styling by design. Untagged list reconstruction (`<ul>`/`<ol>`) is not implemented — untagged bullets stay paragraph text, while tagged `/L`/`/LI` become real lists. Untagged heading levels come from font-size ranks, so a document whose headings are not larger than its body text yields `<p>` throughout. In tagged output, `/Lbl` and `/LBody` render as `<div>` inside their `<li>`, and structure types outside the mapped set fall back to `<div>`.
```

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (no regressions in `autotag`, `html`, `svg`, `tablemodel`, etc.).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(ec5): document fixed-mode HTML export"
```

---

## Self-Review

**Spec coverage:**
- Public API (`mode: 'fixed'`, `box`, `annotations`, `fragment`, `title`) — Task 2 wires `fixed`; `box`/`annotations`/`fragment`/`title` flow through unchanged from Phase 1.
- Modules `htmlfixed.ts` + `htmlfont.ts` — Tasks 1–2.
- `SvgSink` exported, not re-exported from `index.ts` — Task 2 Step 3a (export only from `svgrender.ts`; no `index.ts` change).
- Data flow (HtmlSink wraps SvgSink, one `interpret` pass, glyphRun→span) — Task 2 `htmlfixed.ts`.
- Placement fast path + transform path + baseline ascent — Task 2 `glyphRun`; tested Tasks 2–3.
- `htmlfont` mapping + class dedup + ascent ratios — Task 1.
- Never-throws / per-page degrade — Task 2 `fixedBody` try/catch + `render` try/catch.
- Testing list (span position, backdrop present, page div = crop box, rotated transform, not double-drawn, font mapping, placement math, multi-page, round-trip, fragment) — Tasks 1–3.
- README sync — Task 4.

**Placeholder scan:** none — every code and test step carries complete content.

**Type consistency:** `resolveFont` / `RunFont` / `FontRegistry.get` / `FontRegistry.css` (Task 1) are consumed with the same signatures in Task 2's `htmlfixed.ts`. `fixedBody(doc, pages, opts): { body, css }` (Task 2 Produces) matches its call in `html.ts` `render`. `shell(doc, body, opts, css)` is updated at its definition and both call sites in the same step.
