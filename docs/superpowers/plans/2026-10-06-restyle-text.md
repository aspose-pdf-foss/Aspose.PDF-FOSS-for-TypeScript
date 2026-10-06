# Restyle Found Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.RestyleText(find, style, options?)` and `doc.RestyleText(...)` change matched text's colour, size and font and add underline, strikethrough and background decorations, without changing the characters.

**Architecture:** `planReplace` gains a restyle mode: each match is cut into PIECES at show-string element boundaries and every piece is rewritten as its own text through u3l5.3's styling, so nothing moves between operators. A decoration hook, called after the text plan (reflow targets included), inserts `decorRects` output in the text's own scope — background before the text object's `BT`, rules after its `ET`, each in `q <frame> cm … Q`. The new module `textrestyle.ts` holds the entry points, validation, document-font metrics and the decoration plan.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-restyle-text-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- `ReplaceText` output must stay byte-identical except for the twice-drawn-form fix in Task 1 (`test/text-replace.test.ts`, `test/replace-adjust.test.ts`, `test/replace-options.test.ts`, `test/replace-fallback.test.ts`, `test/text-replace-ligature.test.ts`, `test/reflow*.test.ts` are the fences).
- A refused call changes nothing: everything is decided while PLANNING; `apply` only writes.
- A restyled match extracts the same text afterwards.
- Decorations use `textdecor.ts`'s vocabulary and geometry (`DecorationOptions`, `resolveDecor`, `decorRects`) — no second decoration rule.
- New public names need a README API Reference row and the README's stated type count updated (`test/readme-api.test.ts`).
- New `src/*.ts` modules get a CLAUDE.md Source entry (Task 4 writes it once behaviour is final).
- `AddText`/`AddTextBlock` rects are `[x, y, w, h]` (u3l5.5 ruling).
- Write code containing backslashes with the Write/Edit tools, never a bash heredoc (heredocs strip backslashes on this machine).
- Run `npm run typecheck` and `npm test` green before closing; one file: `npx vitest run test/<name>.test.ts`.

## Review Focus

1. **A word split by a TJ kern** (`[(wo) -50 (rd)]`) is two pieces: the kern stays, each piece keeps its place, and a decoration draws one box per piece under its own glyphs. Pinned in Task 2 ("a TJ-kerned word gets a rule under each piece").
2. **Raised text** (`Ts`): the decoration sits on the BASELINE, not under the raised glyphs. Pinned in Task 2 ("a raised match is decorated on its baseline").
3. **A form drawn twice**: the text change and the decoration are written ONCE into the form, so both drawings show one each. Pinned in Task 1 (ReplaceText not doubled) and Task 2 ("a form drawn twice is decorated once").
4. **A repeat call** with `underline` draws a second rule (documented, not prevented). Pinned in Task 2 ("a second call adds a second rule").
5. **A decoration-only restyle** writes no text operator at all — every show string keeps its bytes. Pinned in Task 2 ("decoration only leaves every show string as it was").

---

## File Structure

- Create `src/textrestyle.ts` — `TextRestyle`, `RestyleTextOptions`, `restyleText`, `restyleDocument`, validation, document-font metrics, the decoration plan.
- Modify `src/textedit.ts` — restyle mode in `planReplace` (pieces, `RestyleRequest`, `DecorateContext`), `StreamEdits.before`, twice-drawn dedupe, reflow targets out.
- Modify `src/replacefont.ts` — `checkReplaceOptions(opts, label)`.
- Modify `src/textdecor.ts` — export `sfntVMetrics`, `std14VMetricsFor`, `FALLBACK_VMETRICS`.
- Modify `src/page.ts`, `src/document.ts`, `src/index.ts`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`.
- Tests: `test/restyle-text.test.ts`, `test/restyle-decor.test.ts`, `test/restyle-reflow.test.ts`.

---

### Task 1: The restyle engine and colour, size, font

**Files:**
- Modify: `src/textedit.ts`, `src/replacefont.ts`, `src/page.ts`, `src/document.ts`, `src/index.ts`, `README.md`
- Create: `src/textrestyle.ts`
- Test: `test/restyle-text.test.ts`

**Interfaces:**
- Produces (textedit.ts, `@internal`):

```ts
export interface RestyleRequest {
  /** False for a decoration-only restyle: no character is rewritten. */
  rewrite: boolean;
  /** Plans decorations once the text plan (reflow included) is known; throws
   *  to refuse, before anything changes. */
  decorate?: (ctx: DecorateContext) => void;
}
export interface RestylePiece { anchor: GlyphEvent; glyphs: GlyphEvent[]; runs?: Run[] }
export interface DecorateContext {
  pageNumber: number;
  pieces: readonly RestylePiece[];
  /** Reflow targets (glyph origin incl. rise, device space); empty without reflow. */
  targets: ReadonlyMap<GlyphEvent, [number, number]>;
  /** The parsed ops of the scope at `path`, per stream, read-only. */
  scopeOps(path: readonly string[]): ContentOp[][];
  before(addr: ContentAddr, ops: readonly ContentOp[]): void;
  after(addr: ContentAddr, ops: readonly ContentOp[]): void;
}
export function planReplace(doc, page, pageNumber, find, replacement: string | RestyleRequest, opts): ReplacePlan;
```

- `StreamEdits.before: Map<number, ContentOp[]>` — operators written BEFORE an operator.
- replacefont.ts: `checkReplaceOptions(opts, label = 'ReplaceText')`.
- textrestyle.ts: `TextRestyle`, `RestyleTextOptions` (exported types), `restyleText(doc, page, find, style, options?): number`, `restyleDocument(doc, find, style, options?): number`, and `checkRestyle(style, options): { opts: ReplaceTextOptions; request: RestyleRequest; style: TextRestyle }` (internal, Task 2 sets `request.decorate`).
- `Page.RestyleText(find, style, options?)`, `Document.RestyleText(find, style, options?)`.

- [ ] **Step 1: Write the failing tests**

Create `test/restyle-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';
import { isArray, isString } from '../src/types.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document, page = 0): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[page], { glyph: (g) => out.push(g) });
  return out;
};
/** Every show string's bytes on the page, in order, as latin1. */
const shown = (doc: Document): string => parseContentStream(doc.Pages[0].Contents)
  .flatMap((o) => (o.operator === 'TJ' && isArray(o.operands[0]) ? o.operands[0] : o.operands))
  .filter(isString).map((s) => String.fromCharCode(...s.bytes)).join('|');

describe('RestyleText: colour, size, font (u3l5.6)', () => {
  const S = 'BT /F1 12 Tf 20 250 Td (alpha beta gamma) Tj ET';

  it('colours the match and leaves the text as it was', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    expect(doc.Pages[0].RestyleText('beta', { color: [1, 0, 0] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('alpha beta gamma');
    const red = glyphs(doc).filter((g) => g.color);
    expect(red.map((g) => g.text).join('')).toBe('beta');
    for (const g of red) expect(g.color).toEqual([1, 0, 0]);
  });

  it('writes the same glyph bytes when only the colour changes', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    doc.Pages[0].RestyleText('beta', { color: [1, 0, 0] });
    expect(shown(doc).split('|').join('')).toBe('alpha beta gamma');
  });

  it('resizes and refonts the match only', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    doc.Pages[0].RestyleText('beta', { fontSize: 24, font: 'Courier' });
    expect(doc.Pages[0].GetText()).toBe('alpha beta gamma');
    const b = glyphs(doc).find((g) => g.text === 'b')!, g0 = glyphs(doc).find((g) => g.text === 'g')!;
    expect(b.fontSize).toBeCloseTo(24, 6);
    expect(b.font.name).toContain('Courier');
    expect(g0.fontSize).toBeCloseTo(12, 6);
  });

  it('restyles a match across two operators where each part is', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (one two) Tj 0 -14 Td (three four) Tj ET'));
    const before = glyphs(doc).map((g) => [g.text, g.quad[0], g.quad[1]]);
    expect(doc.Pages[0].RestyleText(/two\sthree/, { color: [0, 0, 1] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('one two\nthree four');
    expect(glyphs(doc).map((g) => [g.text, g.quad[0], g.quad[1]])).toEqual(before);
    expect(glyphs(doc).filter((g) => g.color).map((g) => g.text).join('')).toBe('twothree');
  });

  it('validates the style and the options before anything changes', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    const p = doc.Pages[0];
    expect(() => p.RestyleText('beta', {})).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { underline: false })).toThrow(/changes nothing/);
    expect(() => p.RestyleText('beta', null as never)).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { color: [1, 0, 0] }, 5 as never)).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { fontSize: -1 })).toThrow(/RestyleText: fontSize/);
    expect(() => p.RestyleText('beta', { underline: { thickness: -1 } })).toThrow(TypeError);
    expect(p.GetText()).toBe('alpha beta gamma');
  });

  it('doc.RestyleText refuses before changing any page', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('beta is fine here', [72, 400, 300, 100], { fontSize: 12 });
    d.AddPage();
    // One line at the page foot: a 60pt "beta" pushes "gamma" below the page.
    d.Pages[1].AddTextBlock('beta gamma', [72, 0, 300, 20], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.RestyleText('beta', { fontSize: 60 }, { adjust: 'reflow' })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
});

describe('a form drawn twice is edited once (u3l5.6)', () => {
  it('ReplaceText does not write the replacement twice', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 0 150 cm /Fm0 Do Q q /Fm0 Do Q',
      'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    expect(doc.Pages[0].ReplaceText('beta', 'BETA')).toBe(2);
    expect(doc.Pages[0].GetText().split('\n')).toEqual(['alpha BETA', 'alpha BETA']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/restyle-text.test.ts`
Expected: FAIL — `RestyleText` is not a function; the form case reads `alpha BETABETA`.

- [ ] **Step 3: Label the shared option check**

In `src/replacefont.ts`, replace `checkReplaceOptions` with:

```ts
/** Validate `opts` before any page is read; `TypeError` for the wrong kind of
 *  thing, so a typo such as `fallbackFonts: 'Helvetica'` cannot silently mean
 *  "no fallback". `label` names the calling API in every message
 *  (`RestyleText` shares these options, u3l5.6). */
export function checkReplaceOptions(opts: ReplaceTextOptions | undefined, label = 'ReplaceText'): ReplaceTextOptions {
  const o = opts ?? {};
  if (typeof o !== 'object' || o === null) throw new TypeError(`${label} options must be an object`);
  const isFont = (f: unknown): boolean => f instanceof EmbeddedFont
    || (typeof f === 'string' && (AUTHORING_FONTS as readonly string[]).includes(f));
  if (o.fallbackFonts !== undefined) {
    if (!Array.isArray(o.fallbackFonts)) throw new TypeError(`${label}: fallbackFonts must be an array of fonts`);
    for (const f of o.fallbackFonts) {
      if (!isFont(f)) throw new TypeError(`${label}: fallbackFonts entry ${String(f)} is neither a Standard-14 authoring face nor a font from AddFont`);
    }
  }
  if (o.font !== undefined && !isFont(o.font))
    throw new TypeError(`${label}: font ${String(o.font)} is neither a Standard-14 authoring face nor a font from AddFont`);
  if (o.fontSize !== undefined) {
    if (typeof o.fontSize !== 'number') throw new TypeError(`${label}: fontSize must be a number`);
    if (!Number.isFinite(o.fontSize) || o.fontSize <= 0) throw new RangeError(`${label}: fontSize must be positive, got ${o.fontSize}`);
  }
  if (o.color !== undefined) {
    if (!Array.isArray(o.color) || o.color.length !== 3 || o.color.some((c) => typeof c !== 'number'))
      throw new TypeError(`${label}: color must be [r, g, b]`);
    if (o.color.some((c) => !(c >= 0 && c <= 1))) throw new RangeError(`${label}: color components must be in 0..1`);
  }
  if (o.adjust !== undefined) {
    if (typeof o.adjust !== 'string') throw new TypeError(`${label}: adjust must be a string`);
    if (!(ADJUSTS as readonly string[]).includes(o.adjust))
      throw new RangeError(`${label}: adjust must be one of ${ADJUSTS.join(', ')}, got ${o.adjust}`);
  }
  if (o.onUnreflowable !== undefined) {
    if (typeof o.onUnreflowable !== 'function') throw new TypeError(`${label}: onUnreflowable must be a function`);
    if (o.adjust !== 'reflow') throw new TypeError(`${label}: onUnreflowable applies only with adjust: 'reflow'`);
  }
  for (const k of ['matchRegisteredFonts', 'ignoreCase', 'wholeWord'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new TypeError(`${label}: ${k} must be a boolean`);
  }
  if (o.onUndrawable !== undefined && typeof o.onUndrawable !== 'function')
    throw new TypeError(`${label}: onUndrawable must be a function`);
  return o;
}
```

- [ ] **Step 4: The restyle mode in `planReplace`**

In `src/textedit.ts`:

1. Add, above `planReplace`, the three interfaces from this task's Interfaces block, with `import type { Run } from './replacefont.js'` already present (it is).

2. `StreamEdits` gains `before: Map<number, ContentOp[]>;` (doc comment: `Operators written BEFORE an operator (u3l5.6).`), initialised in `streamFor` as `before: new Map()`.

3. Change the signature to `replacement: string | RestyleRequest` and replace the block from `const covered = new Uint8Array(text.length);` through the end of the `for (const [s, e] of ranges) { … }` loop with:

```ts
  const covered = new Uint8Array(text.length);
  const matchAt = new Int32Array(text.length).fill(-1);   // which piece covers a position
  const insertAt = new Map<number, string>();
  const restyle = typeof replacement === 'string' ? undefined : replacement;
  // **Invariant (u3l5.6):** a restyle rewrites each match WHERE ITS GLYPHS ARE,
  // so a match is cut into pieces at every change of show-string element and
  // each piece is written as its own text. A replacement is one piece, emitted
  // at the match's anchor (u3l5.1). Positions layout inserted end a piece.
  const pieces: [number, number, number][] = [];   // [start, end, match index]
  ranges.forEach(([s, e], m) => {
    if (!restyle) { pieces.push([s, e, m]); return; }
    let ps = -1;
    let key = '';
    for (let p = s; p <= e; p++) {
      const g = p < e ? refs[p] : undefined;
      const k = g ? `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}` : '';
      if (ps >= 0 && k !== key) { pieces.push([ps, p, m]); ps = -1; }
      if (g && ps < 0) { ps = p; key = k; }
    }
  });
  const anchored: [number, number][] = [];
  const matchOfPiece: number[] = [];
  for (const [s, e, m] of pieces) {
    let anchor = s;
    while (anchor < e && refs[anchor] === undefined) anchor++;
    if (anchor === e) continue;   // only characters layout inserted: no ink to rewrite
    if (!restyle || restyle.rewrite) {
      covered.fill(1, s, e);
      matchAt.fill(anchored.length, s, e);
      insertAt.set(anchor, restyle ? text.slice(s, e) : (replacement as string));
    }
    anchored.push([s, e]);
    matchOfPiece.push(m);
  }
```

4. In the `byElement` loop, after `list.sort(…)`, add `const edited = new Set<number>();` and, right after the `if (!touched) { open = undefined; continue; }` line:

```ts
      // **Invariant (u3l5.6):** a form drawn twice is ONE stream, so its glyph
      // at this byte has already been edited by the first drawing's match.
      // Editing it again wrote the replacement twice.
      if (edited.has(g.byteStart)) continue;
      edited.add(g.byteStart);
```

5. Replace the `undrawable` block (`const undrawable: UndrawableText[] = []; anchored.forEach(…)`) with one grouped by MATCH, so a restyled match reports once however many pieces it has:

```ts
  const undrawable: UndrawableText[] = [];
  const missingByMatch = new Map<number, string[]>();
  anchored.forEach((_, k) => {
    if (missing[k].length === 0) return;
    const list = missingByMatch.get(matchOfPiece[k]);
    if (list) list.push(...missing[k]); else missingByMatch.set(matchOfPiece[k], [...missing[k]]);
  });
  for (const [m, chars] of missingByMatch) {
    undrawable.push({ page: pageNumber, match: text.slice(ranges[m][0], ranges[m][1]), missing: [...new Set(chars)] });
  }
```

6. Reflow targets out: give `planReflow` a last-but-one parameter `targetsOut: Map<GlyphEvent, [number, number]>` (before `opts`), create `const targets = new Map<GlyphEvent, [number, number]>();` beside `annotWrites` in `planReplace`, pass it, and in `planReflow` after `writeReflow(…)` add `for (const [g, t] of wrap.targets) targetsOut.set(g, t);`.

7. After the reflow branch and BEFORE the undrawable block, call the hook:

```ts
  if (restyle?.decorate) {
    const editByAnchor = new Map<GlyphEvent, StrEdit>();
    for (const s of streams.values()) for (const list of s.perOp.values()) for (const e of list) editByAnchor.set(e.anchor, e);
    const restylePieces: RestylePiece[] = anchored.map(([s, e]) => {
      const gs: GlyphEvent[] = [];
      for (let p = s; p < e; p++) { const g = refs[p]; if (g && gs[gs.length - 1] !== g) gs.push(g); }
      return { anchor: gs[0], glyphs: gs, runs: editByAnchor.get(gs[0])?.runs };
    });
    const push = (map: 'before' | 'after') => (addr: ContentAddr, ops: readonly ContentOp[]): void => {
      const m = streamFor(addr)[map];
      const list = m.get(addr.opIndex);
      if (list) list.push(...ops); else m.set(addr.opIndex, [...ops]);
    };
    restyle.decorate({
      pageNumber, pieces: restylePieces, targets,
      scopeOps: (path) => readScopeOps(doc, page, path),
      before: push('before'), after: push('after'),
    });
  }
```

8. `applyEdits`: destructure `before` and push `...(before.get(i) ?? [])` FIRST inside `ops.forEach((op, i) => {`, ahead of the existing branches.

- [ ] **Step 5: `textrestyle.ts` and the entry points**

Create `src/textrestyle.ts`:

```ts
// Restyle found text (u3l5.6): page.RestyleText / doc.RestyleText. Colour, size
// and font go through planReplace's restyle mode — each match rewritten as its
// own text — and decorations through textdecor.ts's geometry, in the text's own
// scope. Holds no content walk of its own.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { AuthoringFont } from './stamp.js';
import { validateBackground, validateDecoration, type DecorationOptions } from './textdecor.js';
import {
  checkReplaceOptions, type ReplaceAdjust, type ReplaceTextOptions, type UndrawableText, type UnreflowableText,
} from './replacefont.js';
import { planReplace, type RestyleRequest, type SearchOptions } from './textedit.js';

/** How `RestyleText` changes matched text. Every property is optional, but at
 *  least one must change something. */
export interface TextRestyle extends DecorationOptions {
  /** Write the match in this font (re-encoding it); characters it cannot
   *  draw go to `fallbackFonts`. */
  font?: AuthoringFont;
  /** Size in points as rendered (the match's own scaling applies). */
  fontSize?: number;
  /** Fill colour [r, g, b] in 0..1; the previous fill is put back after. */
  color?: [number, number, number];
}

/** The `ReplaceText` options that still mean something when only the style
 *  changes. */
export interface RestyleTextOptions {
  region?: SearchOptions['region'];
  ignoreCase?: boolean;
  wholeWord?: boolean;
  fallbackFonts?: AuthoringFont[];
  matchRegisteredFonts?: boolean;
  onUndrawable?: (r: UndrawableText) => void;
  adjust?: ReplaceAdjust;
  onUnreflowable?: (r: UnreflowableText) => void;
}

/** Validate a restyle before any page is read. @internal */
export function checkRestyle(
  style: TextRestyle, options: RestyleTextOptions | undefined,
): { opts: ReplaceTextOptions; request: RestyleRequest; style: TextRestyle } {
  if (typeof style !== 'object' || style === null || Array.isArray(style)) throw new TypeError('RestyleText: style must be an object');
  if (options !== undefined && (typeof options !== 'object' || options === null)) throw new TypeError('RestyleText options must be an object');
  validateDecoration('RestyleText: underline', style.underline);
  validateDecoration('RestyleText: strikethrough', style.strikethrough);
  validateBackground('RestyleText: background', style.background);
  const rewrite = style.font !== undefined || style.fontSize !== undefined || style.color !== undefined;
  const decorated = !!style.underline || !!style.strikethrough || style.background !== undefined;
  if (!rewrite && !decorated) throw new TypeError('RestyleText: style changes nothing');
  const opts = checkReplaceOptions({ ...(options ?? {}), font: style.font, fontSize: style.fontSize, color: style.color }, 'RestyleText');
  return { opts, request: { rewrite }, style };
}

/** See `Page.RestyleText`. */
export function restyleText(
  doc: Document, page: Page, find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions,
): number {
  const { opts, request } = checkRestyle(style, options);
  const pageNumber = doc.Pages.findIndex((p) => p.Dict === page.Dict) + 1;
  const plan = planReplace(doc, page, pageNumber, find, request, opts);
  plan.apply();
  return plan.count;
}

/** See `Document.RestyleText`: every page is planned before any changes, and
 *  each is RE-planned just before it is applied (`doc.ReplaceText`'s rule). */
export function restyleDocument(
  doc: Document, find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions,
): number {
  const { opts, request } = checkRestyle(style, options);
  doc.Pages.forEach((p, i) => planReplace(doc, p, i + 1, find, request, opts));
  let total = 0;
  doc.Pages.forEach((p, i) => {
    const plan = planReplace(doc, p, i + 1, find, request, opts);
    plan.apply();
    total += plan.count;
  });
  return total;
}
```

In `src/page.ts`, beside `ReplaceText` (import `restyleText` and the two types from `./textrestyle.js`):

```ts
  /** Change how matched text LOOKS without changing what it says (u3l5.6):
   *  `style.color`, `fontSize` and `font` rewrite each match in place — colour
   *  alone keeps the original glyph bytes — and `underline`, `strikethrough`
   *  and `background` decorate it with `AddText`'s geometry. `options` take
   *  `ReplaceText`'s search, font-fallback and `adjust` options. A match that
   *  cannot be restyled throws `UnsupportedFeatureError` and changes nothing.
   *  Returns the number of matches. */
  RestyleText(find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions): number {
    return restyleText(this.doc, this, find, style, options);
  }
```

In `src/document.ts`, beside `ReplaceText` (import `restyleDocument` and the types):

```ts
  /** Restyle every match across all pages; see `Page.RestyleText`. Every page
   *  is PLANNED before any is changed, so a refusal leaves the whole document
   *  untouched. Returns the total number of matches. */
  RestyleText(find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions): number {
    return restyleDocument(this, find, style, options);
  }
```

In `src/index.ts`, beside the `replacefont.js` type export: `export type { TextRestyle, RestyleTextOptions } from './textrestyle.js';`

In `README.md`: add type rows (alphabetical, in the run holding `ReplaceTextOptions` and `UndrawableText`):

```
| `RestyleTextOptions` | `RestyleText` options: `region`, `ignoreCase`, `wholeWord`, `fallbackFonts`, `matchRegisteredFonts`, `onUndrawable`, `adjust` and `onUnreflowable`. |
| `TextRestyle` | What `RestyleText` changes: `font`, `fontSize`, `color`, `underline`, `strikethrough` and `background`. |
```

and method rows beside `page.ReplaceText(…)` and `doc.ReplaceText(…)`:

```
| `page.RestyleText(find, style, options?)` | Restyle matches in place without changing the text → count. `style` is `TextRestyle`, `options` is `RestyleTextOptions` |
| `doc.RestyleText(find, style, options?)` | Restyle matches on every page; nothing changes unless every page succeeds → count |
```

Run `npx vitest run test/readme-api.test.ts` and set the README's stated type count to what it reports.

- [ ] **Step 6: Run the tests and the fences**

Run: `npx vitest run test/restyle-text.test.ts test/text-replace.test.ts test/replace-adjust.test.ts test/replace-options.test.ts test/replace-fallback.test.ts test/text-replace-ligature.test.ts test/reflow.test.ts test/reflow-annots.test.ts test/reflow-tagged.test.ts test/reflow-review.test.ts test/readme-api.test.ts && npm run typecheck`
Expected: PASS. If an existing replace test that asserts an error MESSAGE fails, the label default is wrong — it must read `ReplaceText` with no argument.

- [ ] **Step 7: Commit**

```bash
git add src/textedit.ts src/replacefont.ts src/textrestyle.ts src/page.ts src/document.ts src/index.ts README.md test/restyle-text.test.ts
git commit -m "feat(u3l5.6): RestyleText colour, size and font; a twice-drawn form is edited once"
```

---

### Task 2: Decorations

**Files:**
- Modify: `src/textdecor.ts`, `src/textrestyle.ts`
- Test: `test/restyle-decor.test.ts`

**Interfaces:**
- Consumes: `RestyleRequest.decorate`, `DecorateContext`, `RestylePiece` (Task 1); `resolveDecor`, `decorRects`, `vmetricsFor` (textdecor.ts); `runsAdvance`, `glyphAdvance` (replaceadjust.ts); `mul`, `apply`, `invert` (text.ts); `loadEmbeddedProgram` (glyphprogram.ts); `matchStd14` (metrics.ts).
- Produces (textdecor.ts): `export function sfntVMetrics(s: SfntFont): VMetrics`, `export function std14VMetricsFor(font: string): VMetrics`, `export const FALLBACK_VMETRICS: VMetrics`. (textrestyle.ts, internal): `planDecorations(doc, style, opts, ctx): void`, `documentVMetrics(doc, g): VMetrics`.

- [ ] **Step 1: Write the failing tests**

Create `test/restyle-decor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';
import { isArray, isString } from '../src/types.js';
import { buildSimpleTextPdf, buildFormTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};
/** Filled paths as [x0, y0, x1, y1, "r,g,b"], sorted. */
const fills = (doc: Document) => doc.Pages[0].GetPaths().filter((p) => p.fill)
  .map((p) => [...p.bbox.map((v) => +v.toFixed(3)), p.fill!.rgb.map((c) => +c.toFixed(3)).join(',')] as const)
  .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
const ops = (doc: Document) => parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
const shown = (doc: Document): string => parseContentStream(doc.Pages[0].Contents)
  .flatMap((o) => (o.operator === 'TJ' && isArray(o.operands[0]) ? o.operands[0] : o.operands))
  .filter(isString).map((s) => String.fromCharCode(...s.bytes)).join('|');
const DECOR = { underline: true, strikethrough: true, background: [1, 1, 0] as [number, number, number] };

describe('RestyleText decorations (u3l5.6)', () => {
  it('matches AddText decorating the same word', () => {
    const a = Document.New(PageFormat.A4);
    a.Pages[0].AddText('word', 72, 700, DECOR);
    const b = Document.New(PageFormat.A4);
    b.Pages[0].AddText('word', 72, 700);
    const doc = Document.Open(b.Save());
    expect(doc.Pages[0].RestyleText('word', DECOR)).toBe(1);
    const want = fills(Document.Open(a.Save())), got = fills(doc);
    expect(got.length).toBe(3);
    got.forEach((r, i) => {
      for (let k = 0; k < 4; k++) expect(r[k]).toBeCloseTo(want[i][k] as number, 3);
      expect(r[4]).toBe(want[i][4]);
    });
  });

  it('paints the background before BT and the rules after ET', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', DECOR);
    const o = ops(doc);
    const bt = o.indexOf('BT'), et = o.indexOf('ET');
    expect(o.slice(0, bt)).toContain('re');
    expect(o.slice(et + 1).filter((x) => x === 're').length).toBe(2);
    expect(o.slice(bt, et).filter((x) => x === 're').length).toBe(0);
  });

  it('decoration only leaves every show string as it was', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    const before = shown(doc);
    doc.Pages[0].RestyleText('beta', { underline: true });
    expect(shown(doc)).toBe(before);
  });

  it('decorates at the restyled width', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta gamma) Tj ET'));
    doc.Pages[0].RestyleText('beta', { fontSize: 24, underline: true });
    const beta = glyphs(doc).filter((g) => 'beta'.includes(g.text) && g.fontSize > 20);
    const width = beta[beta.length - 1].penEnd[0] - beta[0].quad[0];
    const [r] = fills(doc);
    expect(r[0]).toBeCloseTo(beta[0].quad[0], 3);
    expect((r[2] as number) - (r[0] as number)).toBeCloseTo(width, 3);
  });

  it('a TJ-kerned word gets a rule under each piece', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(wo) -500 (rd)] TJ ET'));
    doc.Pages[0].RestyleText('word', { underline: true });
    const gs = glyphs(doc);
    const rules = fills(doc);
    expect(rules.length).toBe(2);
    expect(rules[0][0]).toBeCloseTo(gs[0].quad[0], 3);
    expect(rules[1][0]).toBeCloseTo(gs[2].quad[0], 3);
  });

  it('a raised match is decorated on its baseline', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td 6 Ts (sup) Tj ET'));
    doc.Pages[0].RestyleText('sup', { underline: true });
    const [r] = fills(doc);
    expect(r[3]).toBeLessThan(250);   // under the baseline, not under the raised glyphs (256)
  });

  it('decorates rotated text along its own baseline', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 0 1 -1 0 100 100 Tm (abc) Tj ET'));
    doc.Pages[0].RestyleText('abc', { underline: true });
    const [r] = fills(doc);
    expect((r[3] as number) - (r[1] as number)).toBeGreaterThan(10);   // runs up the page
    expect((r[2] as number) - (r[0] as number)).toBeLessThan(2);        // thin across it
  });

  it('decorates text in a form inside the form', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 50 0 cm /Fm0 Do Q', 'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    const p = doc.Pages[0].GetPaths().filter((x) => x.fill);
    expect(p.length).toBe(1);
    expect(p[0].addr.path).toEqual(['Fm0']);
    const b = glyphs(doc).find((g) => g.text === 'b')!;
    expect(p[0].bbox[0]).toBeCloseTo(b.quad[0], 3);
  });

  it('a form drawn twice is decorated once, and both drawings show it', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 0 150 cm /Fm0 Do Q q /Fm0 Do Q', 'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    const rules = fills(doc);
    expect(rules.length).toBe(2);
    expect((rules[1][1] as number) - (rules[0][1] as number)).toBeCloseTo(150, 3);
  });

  it('a second call adds a second rule', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    doc.Pages[0].RestyleText('beta', { underline: true });
    expect(fills(doc).length).toBe(2);
  });

  it('marks decorations as artifacts in a tagged document', () => {
    const d = Document.New();
    d.AddMarkdown('Some words to decorate here.', { tagged: true });
    const doc = Document.Open(d.Save());
    const rules0 = doc.ValidatePdfUa().Issues.map((i) => i.rule).sort();
    doc.Pages[0].RestyleText('words', { underline: true, background: [1, 1, 0] });
    const p = doc.Pages[0].GetPaths().filter((x) => x.fill);
    expect(p.length).toBe(2);
    expect(p.every((x) => x.artifact)).toBe(true);
    expect(doc.ValidatePdfUa().Issues.map((i) => i.rule).sort()).toEqual(rules0);
  });

  it('refuses a decoration on vertical text, changing nothing', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0041> <0041> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410041> Tj ET', cmap, { encoding: 'Identity-V' }));
    const before = doc.Save();
    expect(() => doc.Pages[0].RestyleText('A', { underline: true })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses when the text object is split across content streams', () => {
    // The text object opens in one /Contents stream and closes in the next.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 12 Tf 20 250 Td (alpha beta) Tj', 'ET']));
    const before = doc.Save();
    expect(() => doc.Pages[0].RestyleText('beta', { underline: true })).toThrow(/content streams/);
    expect(doc.Save()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/restyle-decor.test.ts`
Expected: FAIL — no paths are drawn (Task 1 ignores decorations); the two refusal cases do not throw.

- [ ] **Step 3: Export the metric helpers from `textdecor.ts`**

In `src/textdecor.ts`:
- rename `FALLBACK` to `FALLBACK_VMETRICS` and export it (update its uses);
- rename `std14VMetrics` to `std14VMetricsFor` and export it (update `vmetricsFor`);
- replace `embeddedVMetrics(f: EmbeddedFont)` with `export function sfntVMetrics(s: SfntFont): VMetrics` whose body is the old one minus its first line (`const s = f.sfnt;`), and make `vmetricsFor` call `sfntVMetrics(font.sfnt)`. Add `import type { SfntFont } from './sfnt.js';`.

Run `npx vitest run test/textdecor.test.ts test/rich-runs-identity.test.ts` — Expected: PASS (a rename only).

- [ ] **Step 4: Plan the decorations in `textrestyle.ts`**

Add imports:

```ts
import { UnsupportedFeatureError } from './errors.js';
import { parseContentStream, type ContentOp } from './content.js';
import { apply, invert, mul, type GlyphEvent, type Matrix } from './text.js';
import { name, isArray, isDict, isName, type PdfDict } from './types.js';
import {
  decorRects, resolveDecor, vmetricsFor, sfntVMetrics, std14VMetricsFor, FALLBACK_VMETRICS, type VMetrics,
} from './textdecor.js';
import { runsAdvance, glyphAdvance } from './replaceadjust.js';
import { loadEmbeddedProgram } from './glyphprogram.js';
import { matchStd14 } from './metrics.js';
import { inflateStream } from './flate.js';
import type { DecorateContext } from './textedit.js';
```

(If `Matrix` is not exported from `text.ts`, import it from where `text.ts` imports it.)

Add:

```ts
/** Vertical metrics of the font a glyph was DRAWN in: its embedded sfnt
 *  program's own `post`/OS/2 values, else a Standard-14 name's AFM family,
 *  else the descriptor's /Ascent and /Descent with the fallback rule
 *  fractions. One owner of each fraction stays `textdecor.ts`. */
export function documentVMetrics(doc: Document, g: GlyphEvent): VMetrics {
  const dict = g.font.dict;
  let fdHolder: PdfDict | undefined = dict;
  const desc = doc.resolve(dict.get('DescendantFonts'));
  if (isArray(desc)) { const d0 = doc.resolve(desc[0]); fdHolder = isDict(d0) ? d0 : undefined; }
  const fdObj = fdHolder?.get('FontDescriptor');
  const prog = loadEmbeddedProgram(fdObj, (o) => doc.resolve(o), inflateStream);
  if (prog.sfnt) return sfntVMetrics(prog.sfnt);
  const base = doc.resolve(dict.get('BaseFont'));
  const std = isName(base) ? matchStd14(base.name) : undefined;
  if (std) return std14VMetricsFor(std);
  const fd = doc.resolve(fdObj);
  if (isDict(fd)) {
    const a = doc.resolve(fd.get('Ascent')), d = doc.resolve(fd.get('Descent'));
    if (typeof a === 'number' && typeof d === 'number' && a > 0) {
      return { ...FALLBACK_VMETRICS, ascent: a / 1000, descent: -Math.abs(d) / 1000 };
    }
  }
  return FALLBACK_VMETRICS;
}

/** Plan every piece's decoration (u3l5.6). One box per piece — a piece lies in
 *  one show-string element, so on one line — at its FINAL origin (the reflow
 *  target when reflowed), in a frame along its own baseline: the glyph's
 *  `Tm x CTM` with its scale taken out, origin at the baseline (rise
 *  excluded), so `decorRects` draws in rendered points.
 *
 *  **Invariant:** the paint goes in the text's OWN scope — the background
 *  immediately before the text object's `BT`, the rules immediately after its
 *  `ET` — so it is under or over the glyphs and nothing else moves.
 *
 *  **Invariant:** a piece is decorated once by its anchor's place in the
 *  content, so a form drawn twice gets one decoration, which both drawings
 *  show. */
export function planDecorations(doc: Document, style: TextRestyle, opts: ReplaceTextOptions, ctx: DecorateContext): void {
  const tagged = doc.GetStructTree() !== null;
  const done = new Set<string>();
  const opsCache = new Map<string, ContentOp[][]>();
  const vmCache = new Map<PdfDict, VMetrics>();
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  for (const piece of ctx.pieces) {
    const g = piece.anchor;
    const key = `${g.addr.path.join('\0')}|${g.addr.streamIndex}|${g.addr.opIndex}|${g.elementIndex}|${g.byteStart}`;
    if (done.has(key)) continue;
    done.add(key);
    if (g.vertical) throw new UnsupportedFeatureError(`RestyleText: page ${ctx.pageNumber}: cannot decorate vertical text`);
    const pathKey = g.addr.path.join('\0');
    let scope = opsCache.get(pathKey);
    if (!scope) { scope = ctx.scopeOps(g.addr.path); opsCache.set(pathKey, scope); }
    const list = scope[g.addr.streamIndex] ?? [];
    let bt = g.addr.opIndex;
    while (bt >= 0 && list[bt]?.operator !== 'BT') bt--;
    let et = g.addr.opIndex;
    while (et < list.length && list[et].operator !== 'ET') et++;
    if (bt < 0 || et >= list.length) {
      throw new UnsupportedFeatureError(
        `RestyleText: page ${ctx.pageNumber}: the text object holding a match is split across content streams, so its decoration has nowhere to go`);
    }

    // Width as drawn after the restyle: the piece's written runs, else its glyphs.
    const written = piece.runs?.filter((r) => r.style !== undefined || r.font !== 'original');
    const width = written && written.length > 0 ? runsAdvance(written, g) : piece.glyphs.reduce((s, x) => s + glyphAdvance(x), 0);
    // The frame: Tm x CTM with its scale removed, at the baseline origin.
    const m: Matrix = mul(g.tm, g.ctm);
    const [bx, by] = apply(m, 0, 0);
    const t = ctx.targets.get(g);
    const ox = t ? t[0] - (g.quad[0] - bx) : bx;
    const oy = t ? t[1] - (g.quad[1] - by) : by;
    const sx = Math.hypot(m[0], m[1]) || 1, sy = Math.hypot(m[2], m[3]) || 1;
    const cm = mul([m[0] / sx, m[1] / sx, m[2] / sy, m[3] / sy, ox, oy], invert(g.ctm));

    let vm = opts.font !== undefined ? vmetricsFor(opts.font) : vmCache.get(g.font.dict);
    if (!vm) { vm = documentVMetrics(doc, g); vmCache.set(g.font.dict, vm); }
    const d = resolveDecor(style, opts.color ?? g.color ?? [0, 0, 0], opts.fontSize ?? g.fontSize, vm);
    if (!d) continue;
    const { beneath, above } = decorRects([{ x: 0, baseline: 0, width }], d);
    const wrap = (body: string): ContentOp[] => {
      const core: ContentOp[] = [
        { operator: 'q', operands: [] },
        { operator: 'cm', operands: cm.map(r6) },
        ...parseContentStream(new TextEncoder().encode(body)),
        { operator: 'Q', operands: [] },
      ];
      return tagged
        ? [{ operator: 'BMC', operands: [name('Artifact')] }, ...core, { operator: 'EMC', operands: [] }]
        : core;
    };
    if (beneath) ctx.before({ ...g.addr, opIndex: bt }, wrap(beneath));
    if (above) ctx.after({ ...g.addr, opIndex: et }, wrap(above));
  }
}
```

In `checkRestyle`, set the hook when a decoration is asked for:

```ts
  const request: RestyleRequest = { rewrite };
  if (decorated) request.decorate = (ctx) => planDecorations(doc, style, opts, ctx);
```

— which needs `doc`: change `checkRestyle(style, options)` to `checkRestyle(doc, style, options)` and update its two callers.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/restyle-decor.test.ts test/restyle-text.test.ts`
Expected: PASS. If the oracle is off by a constant in y, check the baseline origin (`apply(m, 0, 0)`, not the quad corner); off in width, check `written` excludes residue runs.

- [ ] **Step 6: Run the fences**

Run: `npx vitest run test/textdecor.test.ts test/rich-runs-identity.test.ts test/text-replace.test.ts test/replace-adjust.test.ts test/reflow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/textdecor.ts src/textrestyle.ts test/restyle-decor.test.ts
git commit -m "feat(u3l5.6): RestyleText underline, strikethrough and background"
```

---

### Task 3: Decorations follow a reflow

**Files:**
- Test: `test/restyle-reflow.test.ts`
- Modify (only if the test fails): `src/textrestyle.ts`

**Interfaces:**
- Consumes: `DecorateContext.targets` (Task 1), `planDecorations` (Task 2).

- [ ] **Step 1: Write the test**

Create `test/restyle-reflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};

describe('RestyleText with adjust: reflow (u3l5.6)', () => {
  it('moves a decorated word to its new line with its rule', () => {
    // Four producer lines. "ffff" at 80pt no longer fits beside "eeee", so the
    // reflow moves it to the start of the next line — and its underline,
    // planned in the same call, goes with it.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 280 Td (aaaa bbbb cccc dddd) Tj 0 -14 Td (eeee ffff) Tj '
      + '0 -14 Td (gggggggggggggggg) Tj 0 -14 Td (i jj) Tj ET'));
    doc.Pages[0].RestyleText('ffff', { fontSize: 80, underline: true }, { adjust: 'reflow' });
    const f = glyphs(doc).find((g) => g.text === 'f')!;
    expect(f.quad[0]).toBeCloseTo(20, 3);
    expect(f.quad[1]).toBeCloseTo(280 - 2 * 14, 3);
    const rules = doc.Pages[0].GetPaths().filter((p) => p.fill).map((p) => p.bbox);
    expect(rules.length).toBe(1);
    expect(rules[0][0]).toBeCloseTo(20, 3);
    expect(rules[0][3]).toBeLessThan(f.quad[1]);
    expect(rules[0][3]).toBeGreaterThan(f.quad[1] - 15);   // 80pt: offset 8pt, thickness 4pt
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/restyle-reflow.test.ts`
Expected: PASS — Task 1 already passes the targets and Task 2 already reads them. If it FAILS, the cause is a piece whose anchor has no target (a glyph the wrap placed as part of an edit anchored elsewhere): read the target of `piece.glyphs.find((x) => ctx.targets.has(x))` instead of the anchor's, and apply that glyph's own rise correction.

- [ ] **Step 3: Prove it load-bearing**

Temporarily change `const t = ctx.targets.get(g);` to `const t = undefined;` in `planDecorations`, run the test, and confirm it FAILS on the rule's x; restore the line.

- [ ] **Step 4: Commit**

```bash
git add test/restyle-reflow.test.ts src/textrestyle.ts
git commit -m "test(u3l5.6): decorations follow a reflowed match"
```

---

### Task 4: Docs, mutation sweep, close

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README**

In Key Capabilities, after the **Text replace** paragraph, add:

```
- **Text restyle** — `page.RestyleText(find, style)` (or `doc.RestyleText(...)` across all pages) changes how matched text looks without changing what it says: `style.color`, `fontSize` and `font` rewrite each match where its glyphs are — colour alone keeps the original glyph bytes, a font change re-encodes with `ReplaceText`'s fallbacks — and `underline`, `strikethrough` and `background` decorate it with exactly the geometry `AddText` uses, painted in the text's own content stream: the background under the glyphs, the rules over them. A size or font change can keep the line or paragraph in step through `adjust`, and a decoration follows a reflowed word. In a tagged document decorations are artifacts. Returns the number of matches.
```

In the Replace Text example block, add:

```ts
// Change how text looks, not what it says.
doc.RestyleText('Total', { color: [0.8, 0, 0], underline: true });
doc.Pages[0].RestyleText(/v\d+/, { font: 'Helvetica-Bold', background: [1, 1, 0.6] });
```

In Scope and Limitations, append to the text-replace bullet: `` `RestyleText` does not read a style back or remove an existing decoration; a second call with `underline` draws a second rule; a decoration is refused on vertical text and where the text object's `BT` and `ET` lie in different content streams; invisible (`Tr 3`) text still gets the visible decoration asked for. ``

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Added`, at the top:

```
- **`RestyleText` changes how found text looks without changing it.** `page.RestyleText(find, style)` and `doc.RestyleText(...)` take `color`, `fontSize`, `font`, `underline`, `strikethrough` and `background`. Colour, size and font go through `ReplaceText`'s own machinery with each match rewritten as its own text, cut at every show-string boundary so no part of a match moves to another operator; a colour alone keeps the original glyph bytes, and a font change re-encodes with `fallbackFonts` and `onUndrawable` as `ReplaceText` does. Decorations use the vocabulary and geometry of `AddText`'s `DecorationOptions`, so a restyled word and an authored one decorate alike — checked against `AddText` itself — and are painted in the text's own content stream, the background just before its text object and the rules just after, in a frame along the text's own baseline, so rotated, scaled and form-drawn text is decorated where it is. Metrics come from the restyled font, else the drawn font's embedded program, its Standard-14 family, or its descriptor. A size or font change can use `adjust`, and a decoration follows a word `'reflow'` moves. Decorations are artifacts in a tagged document. Vertical text, and a text object split across content streams, are refused before anything changes. (u3l5.6)
```

Under `### Fixed` (create it after `### Added` if absent):

```
- **`ReplaceText` wrote the replacement twice in a form drawn twice.** A Form XObject placed twice on a page is one content stream, but each drawing's match edited it, so `alpha beta` drawn twice became `alpha BETABETA` in both places. A glyph is now edited once however many drawings show it. (u3l5.6)
```

- [ ] **Step 3: CLAUDE.md**

Add a Source entry before `**replaceadjust.ts**`:

```
- **textrestyle.ts** — `page.RestyleText` / `doc.RestyleText` (`u3l5.6`): the
  entry points, validation, document-font metrics and the decoration plan.
  Colour, size and font go through `planReplace`'s RESTYLE mode.
  **Invariant:** a restyle cuts each match into PIECES at every change of
  show-string element and writes each piece as its own text, so nothing moves
  to another operator. A replacement stays ONE piece at its anchor (u3l5.1).
  **Invariant:** decorations are `textdecor.ts`'s — `resolveDecor` and
  `decorRects`, unchanged — so a restyled word and an authored one decorate by
  one rule; the oracle is `AddText` with the same options.
  **Invariant:** the paint goes in the text's OWN scope, the background
  immediately before the text object's `BT` and the rules immediately after its
  `ET`, each in `q <frame> cm … Q` where the frame is the glyph's `Tm x CTM`
  with its scale removed, at the BASELINE origin (rise excluded), so rotated,
  scaled and form-drawn text is decorated in place and nothing leaks.
  **Invariant:** a glyph is edited, and a piece decorated, ONCE by its place in
  the content: a form drawn twice is one stream. `ReplaceText` wrote a
  replacement twice there until `u3l5.6`.
  **Invariant:** everything is planned before anything is written —
  `RestyleRequest.decorate` runs inside `planReplace` and only queues
  operators; a refusal throws from there.
```

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Mutation sweep**

Write a scratchpad node script (not in the repo) that, for each mutation below, replaces the text, runs `npx vitest run test/restyle-text.test.ts test/restyle-decor.test.ts test/restyle-reflow.test.ts`, restores the file, and prints RED/GREEN/TIMEOUT/LOAD-ERROR (a run where any file failed to load is LOAD-ERROR, not GREEN). Every mutation must be RED, or be recorded in CLAUDE.md's entry as a redundant defence with the case that shows it:

1. `textedit.ts`: restyle uses one piece per match (`if (!restyle) {` → `if (true) {`).
2. `textedit.ts`: drop the twice-drawn `continue` (`if (edited.has(g.byteStart)) continue;` → `void 0;`).
3. `textedit.ts`: decoration-only still rewrites (`if (!restyle || restyle.rewrite) {` → `if (true) {`).
4. `textrestyle.ts`: background placed after `ET` (`ctx.before({ ...g.addr, opIndex: bt }` → `ctx.after({ ...g.addr, opIndex: et }`).
5. `textrestyle.ts`: origin from the quad corner (`const [bx, by] = apply(m, 0, 0);` → `const [bx, by] = [g.quad[0], g.quad[1]];`).
6. `textrestyle.ts`: frame keeps its scale (`m[0] / sx, m[1] / sx, m[2] / sy, m[3] / sy` → `m[0], m[1], m[2], m[3]`).
7. `textrestyle.ts`: width from the glyphs even after a resize (`written && written.length > 0 ?` → `false ?`).
8. `textrestyle.ts`: no artifact wrapper (`return tagged` → `return false`).
9. `textrestyle.ts`: no per-piece dedupe (`if (done.has(key)) continue;` → `void 0;`).
10. `textrestyle.ts`: ignore reflow targets (`const t = ctx.targets.get(g);` → `const t = undefined;`).
11. `textrestyle.ts`: never refuse vertical text (`if (g.vertical) throw` → `if (false) throw`).
12. `replacefont.ts`: the label ignored (`` `${label}: fontSize must be positive `` → `` `ReplaceText: fontSize must be positive ``).

- [ ] **Step 6: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(u3l5.6): restyle text"
bd close aspose-pdf-foss-for-ts-u3l5.6 --reason "RestyleText: colour/size/font via planReplace restyle pieces; underline/strikethrough/background via textdecor in the text's own scope; AddText oracle; twice-drawn form fix"
git add .beads && git commit -m "beads: u3l5.6 closed"
git pull --rebase && git push && git status
```
