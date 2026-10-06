# Reflow Hyphenation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ReplaceText`/`RestyleText({ adjust: 'reflow', hyphenate })` break a word that no longer fits at a hyphenation point and draw a hyphen, exactly as `AddTextBlock({ hyphenate })` would.

**Architecture:** With `hyphenate` on, `reflowwrap.ts` stops feeding words to `layoutRuns` as atomic boxes and feeds them as TEXT: every drawn unit (an original glyph, or one character of an edit) is one run whose text is a unique supplementary-private-use proxy code point, measured at exactly that unit's advance, with a `Hyphenator` adapter mapping the real word's hyphenation points onto proxy offsets. The wrap reports where it broke, each glyph's per-line boxes, and line-end hyphens it rejoined. `textedit.ts` turns breaks into hyphen inserts (`ShowInsert` run pieces), splits an edit's runs across lines (`StrEdit.breaks`), and removes rejoined hyphens through an empty `StrEdit`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-reflow-hyphenation-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Import specifiers carry `.js`; `strict` TypeScript; `npm run typecheck` and `npm test` both green before closing.
- `hyphenate` absent or `false`: NO new code path runs and output is byte-identical (fence in Task 1).
- `hyphenate` stated with any `adjust` other than `'reflow'` → `RangeError` before any page is read.
- Validation errors: `TypeError` for wrong kind, `RangeError` outside the allowed set; a rejected call leaves the document byte-identical.
- Language per paragraph: `hyphenate.lang`, else the anchor glyph's structure element `EffectiveLang` (which ends at the catalog `/Lang`), else catalog `/Lang`; no bundled table → whole-word reflow, silently. `'manual'` needs no language.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts` enforces it).
- A drawn hyphen extracts as `-` (no `/ActualText`), as `AddTextBlock`'s do.
- Hyphen face tiers: the unit's own font (`drawCode('-')`), then with `matchRegisteredFonts` the registered same face, then `fallbackFonts`; a foreign face needs `canSwitch`. No face → that point is skipped.
- Update `CHANGELOG.md` (`## [Unreleased]`, **Added**), README and CLAUDE.md in the same commits as the user-visible change (Task 9 finishes them).
- Every new test's load-bearing assertions are mutation-checked (break the code path, see red, restore). Verify each mutation actually applied before trusting a green; a hung run means kill orphaned vitest workers before re-running.

## Review Focus

1. **A word drawn by two show operators** (`(docu) Tj (mentation) Tj`, chained) — the hyphen goes after the right glyph in the right operator and the tail gets a `Tm`. Test in Task 5.
2. **Justified source text with `Tw` in force** — a hyphen inside a `TJ` takes `Tc` but no `Tw`; the reflowed justified lines still match the `AddTextBlock` oracle. Test in Task 5.
3. **A tagged document** — inserted hyphens sit inside the word's marked content, so `ValidatePdfUa` reports no new `UntaggedContent`. Test in Task 7.
4. **Two paragraphs with different `/Lang`** (tagged, one `de`, one `en`) — each hyphenates by its own patterns. Test in Task 5.
5. **An embedded Type0 (Identity-H) font** — the hyphen is a 2-byte code from `drawCode`, and the split inside a replacement re-encodes at a character boundary. Test in Task 6.

---

## File Structure

- `src/replacefont.ts` — `ReplaceTextOptions.hyphenate`, validation in `checkReplaceOptions`.
- `src/textrestyle.ts` — `RestyleTextOptions.hyphenate`; `planDecorations` decorates per line box.
- `src/replaceadjust.ts` — `runUnits`, `splitRuns` (pure, beside `runsAdvance`); `ShowInsert` gains a `run` piece.
- `src/reflowwrap.ts` — the hyphenated wrap (`wrapHyphenated`), its types, rejoin.
- `src/textedit.ts` — language and hyphenator per paragraph, hyphen faces, `StrEdit.breaks`, hyphen inserts and suppression in `planReflow`/`writeReflow`/`showPieces`, boxes in `moveAnnotQuads`, `DecorateContext.boxes`.
- Tests: `test/reflow-hyphen-identity.test.ts`, `test/reflow-hyphen-options.test.ts`, `test/replace-run-units.test.ts`, `test/reflow-wrap-hyphen.test.ts`, `test/reflow-hyphen.test.ts`, `test/reflow-hyphen-edit.test.ts`, `test/reflow-hyphen-rejoin.test.ts`, `test/reflow-hyphen-annots.test.ts`.

---

### Task 1: Identity fence and the `hyphenate` option

**Files:**
- Create: `test/reflow-hyphen-identity.test.ts`
- Create: `test/reflow-hyphen-options.test.ts`
- Modify: `src/replacefont.ts` (interface `ReplaceTextOptions`, `checkReplaceOptions`)
- Modify: `src/textrestyle.ts` (interface `RestyleTextOptions`)

**Interfaces:**
- Produces: `ReplaceTextOptions.hyphenate?: HyphenationOptions | false`, `RestyleTextOptions.hyphenate?: HyphenationOptions | false`. Validated; not yet read by anything.

- [ ] **Step 1: Write the identity fence BEFORE touching src**

`test/reflow-hyphen-identity.test.ts` — hashes of the page content and annotation geometry of reflow scenarios, recorded with today's code. Page content is hashed rather than `Save()` bytes because a new document's `/ID` is random.

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isArray, isDict } from '../src/types.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const block = (align: 'left' | 'justify' | 'center' | 'right') => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12, align });
  return Document.Open(d.Save());
};
/** Decoded page content plus every annotation's /QuadPoints and /Rect. */
const digest = (doc: Document): string => {
  const h = createHash('sha256');
  h.update(doc.Pages[0].Contents);
  const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
  if (isArray(annots)) for (const a of annots) {
    const d = doc.resolve(a);
    if (isDict(d)) h.update(JSON.stringify([doc.resolve(d.get('QuadPoints')), doc.resolve(d.get('Rect'))]));
  }
  return h.digest('hex');
};

// Recorded BEFORE 6y39 touched src/. A red case here is a regression of the
// unhyphenated path, never a golden to refresh.
const RECORDED: Record<string, string> = {
  'replace-left': '',
  'replace-justify': '',
  'replace-center': '',
  'replace-right': '',
  'restyle-reflow': '',
  'replace-link': '',
};

describe('reflow without hyphenate is byte-identical (6y39 fence)', () => {
  const cases: Record<string, () => Document> = {
    'replace-left': () => { const d = block('left'); d.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' }); return d; },
    'replace-justify': () => { const d = block('justify'); d.Pages[0].ReplaceText('quick', 'remarkablyquick', { adjust: 'reflow' }); return d; },
    'replace-center': () => { const d = block('center'); d.Pages[0].ReplaceText('lazy dog', 'cat', { adjust: 'reflow' }); return d; },
    'replace-right': () => { const d = block('right'); d.Pages[0].ReplaceText('fox', 'foxes and hounds', { adjust: 'reflow' }); return d; },
    'restyle-reflow': () => { const d = block('left'); d.Pages[0].RestyleText('quick', { fontSize: 20, underline: true }, { adjust: 'reflow' }); return d; },
    'replace-link': () => {
      const d = block('left');
      const m = d.Pages[0].Search('lazy dog')[0];
      d.Pages[0].AddLink({ rect: m.quads[0], action: { type: 'uri', uri: 'https://example.com' } });
      d.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
      d.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
      return d;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    it(name, () => {
      const got = digest(make());
      if (RECORDED[name] === '') console.log(`RECORD ${name} ${got}`);
      expect(got).toBe(RECORDED[name]);
    });
  }
});
```

`page.Contents` is the decoded, concatenated content; `AddLink`/`AddHighlight` follow `test/reflow-annots.test.ts`'s `linked()`.

- [ ] **Step 2: Record the hashes**

Run: `npx vitest run test/reflow-hyphen-identity.test.ts`
Expected: 6 FAIL, each printing `RECORD <name> <hex>`. Paste each hex into `RECORDED`. Re-run: 6 PASS. Run it a second time to confirm the hashes are stable.

- [ ] **Step 3: Commit the fence alone**

```bash
git add test/reflow-hyphen-identity.test.ts
git commit -m "test(6y39): identity fence for unhyphenated reflow"
```

- [ ] **Step 4: Write the failing option tests**

`test/reflow-hyphen-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const doc = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock('alpha beta gamma delta', [72, 400, 200, 300], { fontSize: 12 });
  return Document.Open(d.Save());
};
const bytes = (d: Document) => d.Pages[0].Contents;

describe('hyphenate option validation (6y39)', () => {
  it('requires adjust: reflow', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { hyphenate: { lang: 'en' } })).toThrow(RangeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'shiftRest', hyphenate: { lang: 'en' } })).toThrow(RangeError);
    expect(() => d.RestyleText('beta', { underline: true }, { hyphenate: { lang: 'en' } })).toThrow(RangeError);
  });
  it('false and absent are accepted everywhere', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { hyphenate: false })).not.toThrow();
  });
  it('rejects the wrong kind with TypeError and leaves the document untouched', () => {
    const d = doc();
    const before = bytes(d);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: 'en' as never })).toThrow(TypeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { minLeft: 1.5 } })).toThrow(TypeError);
    expect(bytes(d)).toEqual(before);
  });
  it('rejects values outside the set with RangeError', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { mode: 'x' as never } })).toThrow(RangeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { lang: 'tlh' } })).toThrow(RangeError);
  });
  it('accepts auto with no lang: the language comes from the document', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: {} })).not.toThrow();
  });
  it('messages name the calling API', () => {
    const d = doc();
    expect(() => d.RestyleText('beta', { underline: true }, { adjust: 'reflow', hyphenate: { lang: 'tlh' } })).toThrow(/RestyleText/);
  });
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `npx vitest run test/reflow-hyphen-options.test.ts`
Expected: FAIL — `hyphenate` is not a known option, so nothing throws (typecheck errors too).

- [ ] **Step 6: Implement**

In `src/replacefont.ts` add the imports and the field (after `onUnreflowable`):

```ts
import { resolveHyphenation, type HyphenationOptions } from './hyphenate.js';
import { rethrowLimit } from './errors.js';
```

```ts
  /** With `adjust: 'reflow'`, break a word that no longer fits at a
   *  hyphenation point and draw a hyphen (6y39) — the engine `AddTextBlock`
   *  uses, so `{ lang }` hyphenates by Liang patterns and `{ mode: 'manual' }`
   *  only at soft hyphens. Without `lang` each paragraph uses its own
   *  language — its structure element's /Lang, then the document's — and a
   *  paragraph whose language has no bundled patterns reflows whole words.
   *  A hyphen a reflow no longer needs at a line end is removed when the
   *  patterns confirm it was a break. Default off. */
  hyphenate?: HyphenationOptions | false;
```

In `checkReplaceOptions`, after the `onUnreflowable` block:

```ts
  if (o.hyphenate !== undefined && o.hyphenate !== false) {
    if (o.adjust !== 'reflow') throw new RangeError(`${label}: hyphenate applies only with adjust: 'reflow'`);
    // A missing lang is resolved per paragraph from the document, so only the
    // OTHER fields are validated against a stand-in language here.
    const h = o.hyphenate as unknown;
    const stated = typeof h === 'object' && h !== null && !Array.isArray(h) && (h as HyphenationOptions).lang !== undefined;
    try {
      resolveHyphenation(h, stated ? undefined : 'en-US');
    } catch (e) {
      rethrowLimit(e);
      if (e instanceof TypeError) throw new TypeError(`${label}: ${e.message}`);
      if (e instanceof RangeError) throw new RangeError(`${label}: ${e.message}`);
      throw e;
    }
  }
```

In `src/textrestyle.ts`, `RestyleTextOptions`, add after `onUnreflowable`:

```ts
  /** See `ReplaceTextOptions.hyphenate`. */
  hyphenate?: HyphenationOptions | false;
```

with `import type { HyphenationOptions } from './hyphenate.js';`. `checkRestyle` already spreads `options` into `checkReplaceOptions`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/reflow-hyphen-options.test.ts test/reflow-hyphen-identity.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Mutation-check** — drop the `o.adjust !== 'reflow'` check: the first case reddens. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/replacefont.ts src/textrestyle.ts test/reflow-hyphen-options.test.ts
git commit -m "feat(6y39): hyphenate option on ReplaceText and RestyleText, validated"
```

---

### Task 2: `runUnits` and `splitRuns`

**Files:**
- Modify: `src/replaceadjust.ts` (beside `runsAdvance`)
- Modify: `docs/superpowers/specs/2026-10-06-reflow-hyphenation-design.md` (rename `runCharAdvances` → `runUnits`)
- Create: `test/replace-run-units.test.ts`

**Interfaces:**
- Consumes: `Run`, `runsAdvance(runs, anchor)`, `GlyphEvent` text state (`fontSize`, `tfSize`, `hscale`, `charSpacing`, `wordSpacing`, `font.decodeGlyphs`).
- Produces:

```ts
/** One drawn unit of an edit's runs: a decoded glyph of an original-font run,
 *  or a code point of a foreign one. */
export interface RunUnit { text: string; width: number; run: number }
export function runUnits(runs: readonly Run[], anchor: GlyphEvent): RunUnit[];
/** `runs` cut before each unit index in `cuts` (ascending, 0 < c < units). */
export function splitRuns(runs: readonly Run[], anchor: GlyphEvent, cuts: readonly number[]): Run[][];
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout } from '../src/textedit.js';
import { runsAdvance, runUnits, splitRuns } from '../src/replaceadjust.js';
import type { Run } from '../src/replacefont.js';

const anchorOf = (justify = false) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock('alpha beta gamma delta epsilon zeta eta theta', [72, 400, 120, 300], { fontSize: 12, align: justify ? 'justify' : 'left' });
  const doc = Document.Open(d.Save());
  return pageLayout(doc, doc.Pages[0], {}).all.find((g) => g.text === 'a')!;
};
const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('runUnits / splitRuns (6y39)', () => {
  it('units sum exactly to runsAdvance, original and foreign runs alike', () => {
    for (const justify of [false, true]) {
      const g = anchorOf(justify);
      const runs: Run[] = [{ font: 'original', bytes: enc('ab c') }, { font: 'Times-Roman', text: 'xy z' }];
      const us = runUnits(runs, g);
      expect(us.map((u) => u.text).join('')).toBe('ab cxy z');
      expect(us.map((u) => u.run)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
      expect(us.reduce((s, u) => s + u.width, 0)).toBeCloseTo(runsAdvance(runs, g), 9);
    }
  });
  it('a styled run measures at its own size', () => {
    const g = anchorOf();
    const runs: Run[] = [{ font: 'original', bytes: enc('ab'), style: { size: g.tfSize * 2 } }];
    expect(runUnits(runs, g).reduce((s, u) => s + u.width, 0)).toBeCloseTo(runsAdvance(runs, g), 9);
  });
  it('splitRuns cuts inside a run at a unit boundary and keeps style', () => {
    const g = anchorOf();
    const style = { size: 5 };
    const runs: Run[] = [{ font: 'original', bytes: enc('abc'), style }, { font: 'Times-Roman', text: 'xyz' }];
    const parts = splitRuns(runs, g, [2, 4]);
    expect(parts).toEqual([
      [{ font: 'original', bytes: enc('ab'), style }],
      [{ font: 'original', bytes: enc('c'), style }, { font: 'Times-Roman', text: 'x' }],
      [{ font: 'Times-Roman', text: 'yz' }],
    ]);
  });
  it('a cut at a run boundary yields no empty run', () => {
    const g = anchorOf();
    const runs: Run[] = [{ font: 'original', bytes: enc('ab') }, { font: 'Times-Roman', text: 'xy' }];
    expect(splitRuns(runs, g, [2])).toEqual([[runs[0]], [runs[1]]]);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/replace-run-units.test.ts` — FAIL (not exported).

- [ ] **Step 3: Implement** in `src/replaceadjust.ts`, below `runsAdvance`:

```ts
/** One drawn unit of an edit's runs (6y39): a decoded glyph of an
 *  original-font run, or a code point of a foreign one, with its device
 *  advance under `anchor`'s text state.
 *
 *  **Invariant:** the widths sum EXACTLY to `runsAdvance(runs, anchor)` — the
 *  same arithmetic per unit — so a hyphenated wrap measures an edit as the
 *  unhyphenated one does. */
export interface RunUnit { text: string; width: number; run: number }

export function runUnits(runs: readonly Run[], anchor: GlyphEvent): RunUnit[] {
  const tfs = Math.abs(anchor.tfSize);
  const out: RunUnit[] = [];
  if (tfs === 0) {
    runs.forEach((r, ri) => {
      const texts = r.font === 'original' ? anchor.font.decodeGlyphs(r.bytes).map((gl) => gl.text) : [...r.text];
      for (const t of texts) out.push({ text: t, width: 0, run: ri });
    });
    return out;
  }
  const unit = (anchor.fontSize / tfs) * anchor.hscale;
  runs.forEach((r, ri) => {
    const size = Math.abs(r.style?.size ?? anchor.tfSize);
    if (r.font === 'original') {
      for (const gl of anchor.font.decodeGlyphs(r.bytes)) {
        out.push({ text: gl.text, run: ri, width: (gl.width * size + anchor.charSpacing + (gl.isWordSpace ? anchor.wordSpacing : 0)) * unit });
      }
    } else {
      const d = driverFor(r.font);
      for (const ch of r.text) {
        out.push({ text: ch, run: ri, width: (d.measure(ch, size) + anchor.charSpacing + (ch === ' ' ? anchor.wordSpacing : 0)) * unit });
      }
    }
  });
  return out;
}

/** `runs` cut before each unit index in `cuts` (ascending, strictly inside),
 *  so `splitRuns(r, a, cuts).flat()` draws what `r` draws. An original-font
 *  run is cut at a decoded glyph's byte boundary, a foreign one at a code
 *  point; each part keeps its run's style. */
export function splitRuns(runs: readonly Run[], anchor: GlyphEvent, cuts: readonly number[]): Run[][] {
  const parts: Run[][] = [[]];
  let u = 0;
  let next = 0;
  const cutHere = () => { while (next < cuts.length && cuts[next] === u) { parts.push([]); next++; } };
  for (const r of runs) {
    if (r.font === 'original') {
      let from = 0;
      for (const gl of anchor.font.decodeGlyphs(r.bytes)) {
        if (next < cuts.length && cuts[next] === u && gl.byteStart > from) {
          parts[parts.length - 1].push({ ...r, bytes: r.bytes.slice(from, gl.byteStart) });
          from = gl.byteStart;
        }
        cutHere();
        u++;
      }
      if (from < r.bytes.length) parts[parts.length - 1].push(from === 0 ? r : { ...r, bytes: r.bytes.slice(from) });
    } else {
      let acc = '';
      for (const ch of r.text) {
        if (next < cuts.length && cuts[next] === u && acc !== '') { parts[parts.length - 1].push({ ...r, text: acc }); acc = ''; }
        cutHere();
        acc += ch;
        u++;
      }
      if (acc !== '') parts[parts.length - 1].push(acc === r.text ? r : { ...r, text: acc });
    }
  }
  return parts;
}
```

Note: when `style` is undefined the spread `{ ...r, bytes }` keeps `style: undefined` absent as in the source run; the `toEqual` in the test treats an absent and an undefined key alike.

- [ ] **Step 4: Run** — PASS. Also rename `runCharAdvances(runs, anchor)` → `runUnits(runs, anchor)` in the spec (Section 2, Units bullet, and Section 5 docs bullet).

- [ ] **Step 5: Mutation-check** — drop `anchor.charSpacing` from the foreign branch: the `justify`/sum case reddens (the source has `Tc 0`, so if it stays green, add a run with a non-zero `charSpacing` built by a hand content stream `BT /F1 12 Tf 1 Tc ...` via `buildSimpleTextPdf`). Restore.

- [ ] **Step 6: Commit**

```bash
git add src/replaceadjust.ts test/replace-run-units.test.ts docs/superpowers/specs/2026-10-06-reflow-hyphenation-design.md
git commit -m "feat(6y39): runUnits and splitRuns — an edit's runs unit by unit"
```

---

### Task 3: The hyphenated wrap (no rejoin yet)

**Files:**
- Modify: `src/reflowwrap.ts`
- Create: `test/reflow-wrap-hyphen.test.ts`

**Interfaces:**
- Consumes: `layoutRuns(runs, boxWidth, boxHeight, leading, blockFontSize, firstLineIndent, hyphenation?)`, `Hyphenator` from `hyphenate.ts`.
- Produces (exported from `reflowwrap.ts`):

```ts
export interface WrapUnit { text: string; width: number; hyphen?: number }
export interface HyphenWrap {
  hyphenator: Hyphenator;
  manual: boolean;
  /** The units `g` draws, WITHOUT its kern lead: one for an untouched glyph,
   *  an edit anchor's units, none for a glyph its edit's anchor draws. */
  unitsOf(g: GlyphEvent): WrapUnit[];
  /** Whether a line-final drawn hyphen glyph may be removed (Task 4). */
  canSuppress(g: GlyphEvent): boolean;
}
export interface LineBox { x: number; y: number; width: number }
export interface WrapBreak {
  glyph: GlyphEvent; unit: number;
  /** Where unit + 1 of the SAME glyph starts, when the break is inside it. */
  tail?: [number, number];
  /** An original hyphen glyph kept at the line end: nothing is inserted. */
  own?: GlyphEvent;
}
// WrapInput gains:   hyphen?: HyphenWrap
// WrapResult gains:  breaks: WrapBreak[]; boxes: Map<GlyphEvent, LineBox[]>; suppressed: GlyphEvent[]
```

`LineBox.x` is the glyph's ORIGIN on that line (after its kern lead), `y` the same frame as a target (rise included), `width` its drawn advance on that line plus a hyphen drawn after it there.

- [ ] **Step 1: Write failing tests**

`test/reflow-wrap-hyphen.test.ts` (reuse `block`/`paraOf`/`wordIndex` from `test/reflow-wrap.test.ts` by copying them):

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { wrapParagraph, type HyphenWrap, type WrapUnit } from '../src/reflowwrap.js';
import { glyphAdvance } from '../src/replaceadjust.js';
import { hyphenator, resolveHyphenation, type Hyphenator } from '../src/hyphenate.js';
import type { GlyphEvent } from '../src/text.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const block = (text: string, box = BOX[2]) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], box, BOX[3]], { fontSize: 12 });
  return Document.Open(d.Save());
};
function paraOf(doc: Document, anchorText: string): Paragraph {
  const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
  const [[s]] = findRanges(text, anchorText);
  const p = findParagraph({ all, text, refs, covered: new Uint8Array(text.length), keyOf: untaggedKeys(text, refs),
    anchor: refs[s]!, gap: () => 'relative', inks, annots: [] });
  if (typeof p === 'string') throw new Error(p);
  return p;
}
const wordIndex = (p: Paragraph, w: string) => p.words.findIndex((x) => x.glyphs.map((g) => g.text).join('') === w);
const plain = (h: Hyphenator, over: Map<GlyphEvent, WrapUnit[]> = new Map()): HyphenWrap => ({
  hyphenator: h, manual: false,
  unitsOf: (g) => over.get(g) ?? [{ text: g.text, width: glyphAdvance(g), hyphen: 12 * 0.333 }],
  canSuppress: () => false,
});
const none: Hyphenator = { points: () => [] };
const en = hyphenator(resolveHyphenation({ lang: 'en' }));
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

describe('wrapParagraph with hyphenate (6y39)', () => {
  it('with no points, places every glyph exactly as the atomic path', () => {
    const doc = block(T);
    const p = paraOf(doc, 'quick');
    const k = wordIndex(p, 'quick');
    const quick = p.words[k].glyphs;
    const adv = (g: GlyphEvent) => (g === quick[0] ? glyphAdvance(g) * 4 : glyphAdvance(g));
    const a = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k });
    const over = new Map(quick.map((g) => [g, [{ text: g.text, width: adv(g), hyphen: 4 }]] as const));
    const b = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k, hyphen: plain(none, over) });
    for (const [g, t] of a.targets) { expect(b.targets.get(g)![0]).toBeCloseTo(t[0], 9); expect(b.targets.get(g)![1]).toBeCloseTo(t[1], 9); }
    expect(b.addedLines).toBe(a.addedLines);
    expect(b.breaks).toEqual([]);
  });

  it('breaks a long word at a pattern point and reports it', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(en) });
    expect(r.breaks.length).toBeGreaterThan(0);
    const br = r.breaks[0];
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const at = word.indexOf(br.glyph);
    expect(at).toBeGreaterThan(0);
    // The glyph after the break starts the next line, at the box's left.
    const next = r.targets.get(word[at + 1])!;
    expect(next[1]).toBeLessThan(r.targets.get(br.glyph)![1]);
    expect(next[0]).toBeCloseTo(p.lines[1]?.left ?? p.lines[0].left, 6);
    // Its box carries the hyphen.
    const box = r.boxes.get(br.glyph)!;
    expect(box[0].width).toBeCloseTo(glyphAdvance(br.glyph) + 12 * 0.333, 6);
  });

  it('skips a point whose unit has no hyphen face', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const noFace: HyphenWrap = { ...plain(en), unitsOf: (g) => [{ text: g.text, width: glyphAdvance(g) }] };
    expect(wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: noFace }).breaks).toEqual([]);
  });

  it('drops a point inside a multi-character unit (a ligature)', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const pts = en.points('internationalization');
    expect(pts.length).toBeGreaterThan(0);
    // Fuse the two glyphs around EVERY pattern point into one unit: no point
    // survives on a unit boundary inside the word.
    const over = new Map<GlyphEvent, WrapUnit[]>();
    for (const q of pts) {
      over.set(word[q - 1], [{ text: word[q - 1].text + word[q].text, width: glyphAdvance(word[q - 1]) + glyphAdvance(word[q]), hyphen: 4 }]);
      over.set(word[q], []);
    }
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(en, over) });
    expect(r.breaks.filter((b) => word.includes(b.glyph))).toEqual([]);
  });

  it('a break inside a multi-unit glyph reports the tail origin', () => {
    // One glyph stands for a whole edit: its units are characters.
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'about');
    const g0 = p.words[k].glyphs[0];
    const units: WrapUnit[] = [...'internationalization'].map((c) => ({ text: c, width: 7, hyphen: 4 }));
    const over = new Map<GlyphEvent, WrapUnit[]>([[g0, units], ...p.words[k].glyphs.slice(1).map((g) => [g, []] as const)]);
    const r = wrapParagraph({ para: p, advanceOf: (g) => (g === g0 ? 140 : over.has(g) ? 0 : glyphAdvance(g)), firstEdited: k, lastEdited: k, hyphen: plain(en, over) });
    const br = r.breaks.find((b) => b.glyph === g0)!;
    expect(br.tail).toBeDefined();
    expect(br.tail![1]).toBeLessThan(r.targets.get(g0)![1]);
    expect(r.boxes.get(g0)!.length).toBe(2);
  });

  it('a word with no break opportunity is not split by UAX #14 (proxies are AL)', () => {
    const doc = block('Some text about internationalization that is long', 40);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(none) });
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const ys = new Set(word.map((g) => r.targets.get(g)![1]));
    expect(ys.size).toBe(1);   // drawn whole, overflowing, as today
  });
});
```

`p.lines[1]?.left` — the left of the box from line 1 on; replace with the `boxLeft` rule (`p.lines.length >= 2 ? p.lines[1].left : p.lines[0].left`) inline if `lines[1]` belongs to the edit.

- [ ] **Step 2: Run** — FAIL (`hyphen` unknown, no `breaks`/`boxes`).

- [ ] **Step 3: Implement**

In `src/reflowwrap.ts`: add the imports `import type { Hyphenator } from './hyphenate.js';`, the types from **Interfaces**, `hyphen?: HyphenWrap` on `WrapInput`, and `breaks`, `boxes`, `suppressed` on `WrapResult`. In `wrapParagraph`, at the top:

```ts
  if (inp.hyphen) {
    const h = wrapHyphenated(inp, inp.hyphen);
    if (h) return h;
  }
```

and at its end return `{ targets, addedLines: shift, lowest, breaks: [], boxes: new Map(), suppressed: [] }`.

Then add (below `wrapParagraph`):

```ts
/** First proxy code point: supplementary private use (plane 15). Its line-break
 *  class resolves to AL, so a proxied word breaks only at the points the
 *  adapter hands `layoutRuns`. Plane 15 holds 65,534 characters before its two
 *  noncharacters; a longer tail falls back to the whole-word wrap. */
const PROXY0 = 0xf0000;
const PROXY_LIMIT = 0xfffd;

/** One drawn unit placed by the hyphenated wrap. */
interface PUnit {
  w: number; g: GlyphEvent; k: number; text: string; lead: number; width: number;
  hyphen?: number;
  /** A drawn hyphen glyph following this unit that rejoining removed (Task 4). */
  own?: GlyphEvent;
}

/**
 * The wrap with hyphenation (6y39). Every drawn unit is its own LayoutRun
 * holding one unique proxy code point, measured at exactly the unit's lead
 * plus advance, so `layoutRuns` — the one wrapping engine — decides breaks
 * and heads exactly as `AddTextBlock({ hyphenate })` does, and `segment.run`
 * names the unit directly.
 *
 * **Invariant:** a separator space is measured by the PRECEDING run's driver,
 * so every unit's driver measures `' '` as the gap after its word; with no
 * hyphenation point the result is the atomic path's, glyph for glyph.
 */
function wrapHyphenated(inp: WrapInput, hy: HyphenWrap): WrapResult | undefined {
  const p = inp.para;
  const L = p.words[inp.firstEdited].line;
  const targets = new Map<GlyphEvent, [number, number]>();
  const boxes = new Map<GlyphEvent, LineBox[]>();
  const breaks: WrapBreak[] = [];
  const suppressed: GlyphEvent[] = [];
  for (let w = 0; w < p.lines[L].first; w++) {
    for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1]]);
  }
  const leadOf = (g: GlyphEvent, i: number) => (i > 0 && inp.leadOf ? inp.leadOf(g) : 0);

  // Joined words from line L on: their units and the gap before each.
  const words: { units: PUnit[]; gap: number; first: number }[] = [];
  for (let w = p.lines[L].first; w < p.words.length; w++) {
    const units: PUnit[] = [];
    p.words[w].glyphs.forEach((g, i) => {
      hy.unitsOf(g).forEach((u, k) => units.push({ w, g, k, text: u.text, lead: k === 0 ? leadOf(g, i) : 0, width: u.width, hyphen: u.hyphen }));
    });
    if (units.length === 0 || units.reduce((s, u) => s + u.lead + u.width, 0) <= 0) continue;
    // (Task 4 inserts the rejoin here.)
    words.push({ units, gap: p.gaps[w], first: w });
  }
  const all = words.flatMap((x) => x.units);
  if (all.length > PROXY_LIMIT) return undefined;

  const runs: LayoutRun[] = [];
  const unitOfRun: number[] = [];   // run -> index into `all`, -1 for a gap run
  let n = 0;
  words.forEach((wd, wi) => {
    const after = wi + 1 < words.length ? words[wi + 1].gap : 0;
    if (wi > 0) { runs.push({ text: ' ', driver: gapDriver(wd.gap), fontSize: p.size }); unitOfRun.push(-1); }
    for (const u of wd.units) {
      runs.push({ text: String.fromCodePoint(PROXY0 + n), driver: unitDriver(u, after), fontSize: p.size });
      unitOfRun.push(n);
      n++;
    }
  });
  const unitAt = (cp: number): PUnit => all[cp - PROXY0];
  const adapter: Hyphenator = {
    points(word) {
      const us = [...word].map((ch) => unitAt(ch.codePointAt(0)!));
      const real = us.map((u) => u.text).join('');
      const at = new Map<number, number>();   // real offset -> proxy code-unit offset
      let r = 0;
      us.forEach((u, i) => { r += u.text.length; if (!at.has(r)) at.set(r, (i + 1) * 2); });
      const out = new Set<number>();
      for (const q of hy.hyphenator.points(real)) {
        const b = at.get(q);
        if (b !== undefined && b < word.length) out.add(b);
      }
      us.forEach((u, i) => { if (u.own && i + 1 < us.length) out.add((i + 1) * 2); });
      return [...out].sort((a, b) => a - b);
    },
  };

  const boxLeft = p.align === 'right' || p.align === 'center'
    ? Math.min(...p.lines.map((l) => l.left))
    : p.lines.length >= 2 ? p.lines[1].left : p.lines[0].left;
  const boxRight = Math.max(...p.lines.map((l) => l.right));
  const indent = L === 0 ? p.indent : 0;
  const laid = layoutRuns(runs, boxRight - boxLeft + BOX_SLACK, 1e9, p.pitch, p.size, indent, adapter).lines;

  // Each laid line as its units, with the hyphen drawn after the last.
  type Ent = { u: PUnit; i: number; hyphen: boolean };
  /** A joined word's first unit -> the gap before that word. */
  const gapOf = new Map(words.map((wd) => [wd.units[0], wd.gap] as const));
  const firstOfWord = new Set(gapOf.keys());
  const lines: Ent[][] = laid.map((ln) => ln.segments
    .filter((s) => unitOfRun[s.run] >= 0)
    .map((s) => ({ u: all[unitOfRun[s.run]], i: unitOfRun[s.run], hyphen: s.text.includes('-') })));

  // Convergence: a line (after the first) starting at the first unit of a
  // joined word that begins an original line, past the last edit. A line
  // beginning mid-word is never one.
  let used = lines.length;
  let shift = lines.length - (p.lines.length - L);
  for (let k = 1; k < lines.length; k++) {
    const e = lines[k][0];
    if (!e || !firstOfWord.has(e.u) || e.u.w <= inp.lastEdited) continue;
    const j = p.lines.findIndex((l) => l.first === e.u.w);
    if (j > L) { used = k; shift = (L + k) - j; break; }
  }

  const riseOf = (g: GlyphEvent, w: number) => g.quad[1] - p.lines[p.words[w].line].baseline;
  const hyphenWidth = (u: PUnit) => (u.own ? u.own.quad[2] - u.own.quad[0] : u.hyphen ?? 0);
  const addBox = (g: GlyphEvent, x: number, y: number, width: number) => {
    const list = boxes.get(g);
    const last = list?.[list.length - 1];
    if (last && last.y === y) last.width = x + width - last.x;
    else if (list) list.push({ x, y, width }); else boxes.set(g, [{ x, y, width }]);
  };
  const baseY = p.lines[L].baseline;
  for (let k = 0; k < used; k++) {
    const ents = lines[k];
    const y0 = baseY - k * p.pitch;
    const gapsBefore = (e: Ent, idx: number) => idx > 0 && firstOfWord.has(e.u);
    let lineWidth = 0;
    ents.forEach((e, idx) => {
      if (gapsBefore(e, idx)) lineWidth += gapOf.get(e.u)!;
      lineWidth += (idx > 0 ? e.u.lead : 0) + e.u.width + (e.hyphen ? hyphenWidth(e.u) : 0);
    });
    const left = boxLeft + (k === 0 ? indent : 0);
    const isLast = k === lines.length - 1 && used === lines.length;
    const gapCount = ents.filter((e, idx) => gapsBefore(e, idx)).length;
    let x = p.align === 'right' ? boxRight - lineWidth
      : p.align === 'center' ? (boxLeft + boxRight) / 2 - lineWidth / 2
      : left;
    const extra = p.align === 'justify' && !isLast && gapCount > 0 ? (boxRight - left - lineWidth) / gapCount : 0;
    ents.forEach((e, idx) => {
      const { u } = e;
      if (gapsBefore(e, idx)) x += gapOf.get(u)! + extra;
      if (idx > 0) x += u.lead;          // a kern does not survive a line start
      const y = y0 + riseOf(u.g, u.w);
      if (u.k === 0) targets.set(u.g, [x, y]);
      else if (idx === 0) {
        const br = breaks.findLast((b) => b.glyph === u.g);
        if (br) br.tail = [x, y];
      }
      addBox(u.g, x, y, u.width);
      x += u.width;
      if (e.hyphen) {
        const hw = hyphenWidth(u);
        if (u.own) {
          targets.set(u.own, [x, y0 + riseOf(u.own, u.w)]);
          breaks.push({ glyph: u.g, unit: u.k, own: u.own });
        } else {
          breaks.push({ glyph: u.g, unit: u.k });
          addBox(u.g, x - u.width, y, u.width + hw);
        }
        x += hw;
      }
    });
  }
  // (Task 4 computes `suppressed` here.)
  if (used < lines.length) {
    const j0 = p.lines.findIndex((l) => l.first === lines[used][0].u.w);
    for (let j = j0; j < p.lines.length; j++) {
      for (let w = p.lines[j].first; w <= p.lines[j].last; w++) {
        for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1] - shift * p.pitch]);
      }
    }
  }
  for (const w of p.words) for (const g of w.glyphs) if (!targets.has(g) && !suppressed.includes(g)) targets.set(g, [g.quad[0], g.quad[1]]);
  let lowest = Infinity;
  for (const [, [, y]] of targets) lowest = Math.min(lowest, y);
  return { targets, addedLines: shift, lowest, breaks, boxes, suppressed };
}

/** A unit's driver: its proxy measures the unit, `' '` the gap after its
 *  word, `'-'` the hyphen it would end with (absent: no face, so `probe`
 *  reports 0 and `layoutRuns` skips the point). */
const unitDriver = (u: PUnit, gapAfter: number): FontDriver => ({
  measure: (t) => {
    let w = 0;
    for (const ch of t) w += ch === ' ' ? gapAfter : ch === '-' ? (u.own ? u.own.quad[2] - u.own.quad[0] : u.hyphen ?? 0) : u.lead + u.width;
    return w;
  },
  encode: () => new Uint8Array(0),
  probe: (t) => (t === '-' ? (u.hyphen !== undefined || u.own ? 1 : 0) : t.length),
});
```

`addBox` merging: the hyphen call re-adds the unit's own span plus `hw` so the merged box extends to the hyphen's end; `last.width = x + width - last.x` with `x - u.width` as start gives the right extent. Keep `Array.prototype.findLast` (Node ≥ 22 per `engines`).

A known approximation, to record in CLAUDE.md in Task 9: `layoutRuns` measures every unit with its kern lead, while placement drops the lead of a unit that STARTS a line (a kern does not survive a line break). For a tail whose first glyph carried a producer kern, the engine's line is that kern wider than what is drawn — a few hundredths of a point, never an overlap, since a kern before a letter is normally negative or zero.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-wrap-hyphen.test.ts test/reflow-wrap.test.ts` — PASS. If the "no points" equivalence case is off by a gap, the space measurement is going to a different run than assumed: read `layout.ts`'s `spaceRun` and make `unitDriver` and `gapDriver` agree before going on — this case is the guarantee that the hyphenated path is the same wrap.

- [ ] **Step 5: Mutation-check** — (a) make the adapter return `hy.hyphenator.points(real)` unmapped: the break case reddens; (b) drop `b < word.length`/the boundary filter (`at.get(q)` → `q * 2`): the ligature case reddens; (c) set `gapAfter` to 0: the equivalence case reddens. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/reflowwrap.ts test/reflow-wrap-hyphen.test.ts
git commit -m "feat(6y39): hyphenated wrap — units as proxy runs through layoutRuns"
```

---

### Task 4: Rejoin in the wrap

**Files:**
- Modify: `src/reflowwrap.ts` (the two `(Task 4 …)` places)
- Modify: `test/reflow-wrap-hyphen.test.ts`

**Interfaces:**
- Consumes: Task 3 types; `HyphenWrap.canSuppress`, `HyphenWrap.manual`.
- Produces: `WrapResult.suppressed` populated; `WrapBreak.own` set when a rejoined hyphen is kept at a line end.

- [ ] **Step 1: Write failing tests** (append to `test/reflow-wrap-hyphen.test.ts`). The fixture is hand-built so the source carries a line-end hyphen whatever `AddTextBlock` would choose:

```ts
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const para = (lines: string[]) => Document.Open(buildSimpleTextPdf(
  `BT /F1 12 Tf 20 280 Td (${lines[0]}) Tj ${lines.slice(1).map((l) => `0 -14 Td (${l}) Tj`).join(' ')} ET`));
const join = (h: Hyphenator): HyphenWrap => ({ ...plain(h), canSuppress: () => true });

describe('rejoin (6y39)', () => {
  it('suppresses a line-end hyphen the patterns confirm once both halves share a line', () => {
    const doc = para(['alpha docu-', 'mentation beta', 'gamma delta']);
    const p = paraOf(doc, 'alpha');
    const k = wordIndex(p, 'alpha');
    // Shrink "alpha" so everything fits on fewer lines.
    const alpha = p.words[k].glyphs;
    const adv = (g: GlyphEvent) => (alpha.includes(g) ? 0.1 : glyphAdvance(g));
    const r = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k,
      hyphen: { ...join(en), unitsOf: (g) => [{ text: g.text, width: adv(g), hyphen: 4 }] } });
    const h = p.words[wordIndex(p, 'docu-')].glyphs.at(-1)!;
    expect(r.suppressed).toEqual([h]);
    expect(r.targets.has(h)).toBe(false);
    const m = p.words[wordIndex(p, 'mentation')].glyphs[0];
    const u = p.words[wordIndex(p, 'docu-')].glyphs.at(-2)!;
    expect(r.targets.get(m)![1]).toBeCloseTo(r.targets.get(u)![1], 6);
    expect(r.targets.get(m)![0]).toBeCloseTo(r.targets.get(u)![0] + glyphAdvance(u), 6);
  });
  it('keeps the original hyphen (no insert) when the line still breaks there', () => {
    const doc = para(['alpha docu-', 'mentation beta', 'gamma delta']);
    const p = paraOf(doc, 'beta');
    const k = wordIndex(p, 'beta');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: join(en) });
    expect(r.suppressed).toEqual([]);
  });
  it('does not rejoin before an uppercase word or at a non-pattern point', () => {
    for (const lines of [['alpha docu-', 'Mentation beta'], ['alpha well-', 'known beta']]) {
      const doc = para(lines);
      const p = paraOf(doc, 'alpha');
      const k = wordIndex(p, 'alpha');
      const alpha = p.words[k].glyphs;
      const adv = (g: GlyphEvent) => (alpha.includes(g) ? 0.1 : glyphAdvance(g));
      const r = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k,
        hyphen: { ...join(en), unitsOf: (g) => [{ text: g.text, width: adv(g), hyphen: 4 }] } });
      expect(r.suppressed).toEqual([]);
    }
  });
  it('manual mode rejoins only a soft hyphen', () => {
    const manual = hyphenator(resolveHyphenation({ mode: 'manual' }));
    const doc = para(['alpha docu-', 'mentation beta']);
    const p = paraOf(doc, 'alpha');
    const k = wordIndex(p, 'alpha');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k,
      hyphen: { ...join(manual), manual: true } });
    expect(r.suppressed).toEqual([]);
  });
  it('never suppresses what canSuppress refuses', () => {
    const doc = para(['alpha docu-', 'mentation beta', 'gamma delta']);
    const p = paraOf(doc, 'alpha');
    const k = wordIndex(p, 'alpha');
    const alpha = p.words[k].glyphs;
    const adv = (g: GlyphEvent) => (alpha.includes(g) ? 0.1 : glyphAdvance(g));
    const r = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k,
      hyphen: { ...plain(en), unitsOf: (g) => [{ text: g.text, width: adv(g), hyphen: 4 }] } });
    expect(r.suppressed).toEqual([]);
  });
});
```

Confirm in Step 2 that `en.points('documentation')` includes 4 (`docu|men...`) — the fixture is meaningless otherwise; if it does not, pick a word whose line-end split the patterns DO allow and adjust the three fixtures together, and assert the point in the test so the fixture cannot silently go stale.

- [ ] **Step 2: Run** — FAIL (`suppressed` always empty).

- [ ] **Step 3: Implement**

Replace `// (Task 4 inserts the rejoin here.)` with:

```ts
    const prev = words[words.length - 1];
    if (prev && rejoins(prev.units, units, w)) {
      const h = prev.units.pop()!;
      prev.units[prev.units.length - 1].own = h.g;
      prev.units.push(...units);
      owns.push(h.g);
      continue;
    }
```

with, above the loop:

```ts
  const SHY = '­';
  const owns: GlyphEvent[] = [];
  /** Whether word `w` (`next`) continues `head` across a line-end hyphen
   *  (6y39): `head` ends its line in a drawn '-' or U+00AD that nothing else
   *  touches, `next` begins the following line with a lower-case letter, and
   *  the hyphen is a real U+00AD or — in 'auto' mode — the patterns break the
   *  joined word exactly there. */
  const rejoins = (head: PUnit[], next: PUnit[], w: number): boolean => {
    if (head.length < 2) return false;
    const h = head[head.length - 1];
    const hw = h.w;
    if (h.k !== 0 || hy.unitsOf(h.g).length !== 1 || (h.text !== '-' && h.text !== SHY) || !hy.canSuppress(h.g)) return false;
    if (p.lines[p.words[hw].line].last !== hw || p.words[w].line !== p.words[hw].line + 1 || p.lines[p.words[w].line].first !== w) return false;
    if (!/^\p{Ll}/u.test(next[0].text)) return false;
    if (h.text === SHY) return true;
    if (hy.manual) return false;
    const a = head.slice(0, -1).map((u) => u.text).join('');
    return hy.hyphenator.points(a + next.map((u) => u.text).join('')).includes(a.length);
  };
```

Replace `// (Task 4 computes \`suppressed\` here.)` with:

```ts
  for (const h of owns) if (!targets.has(h)) suppressed.push(h);
```

and make the after-convergence loop and the final zero-width loop skip suppressed glyphs (already guarded by `!suppressed.includes(g)` in the final loop; the after-convergence loop cannot reach a suppressed glyph because a rejoined pair cannot straddle the convergence line — note that in a comment).

`targets.has(h)` after the placement loop: a kept hyphen got its target from `e.hyphen` with `u.own`; a hyphen in a converged-away region was never popped from placement… it was — `owns` holds every joined `h`. A pair lying wholly in the after-convergence lines must NOT be suppressed: make the check `if (!targets.has(h) && placedUnits.has(h-before-unit))`. Implement by recording, in the placement loop, every glyph placed (`placed.add(u.g)`), and suppress only `h` whose preceding unit's glyph is in `placed`:

```ts
  for (const h of owns) {
    const before = all.find((u) => u.own === h)!;
    if (!targets.has(h) && placed.has(before.g)) suppressed.push(h);
  }
```

(`placed` is a `Set<GlyphEvent>` filled with `placed.add(u.g)` for every entry placed in the `k < used` loop.) A joined pair after convergence then keeps its original hyphen, placed by the after-convergence loop.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-wrap-hyphen.test.ts test/reflow-wrap.test.ts` — PASS.

- [ ] **Step 5: Mutation-check** — drop the lower-case test (uppercase case reddens); drop the pattern test (`well-`/`known` reddens); drop `placed.has` (add a case: edit on line 0, a rejoinable pair on the LAST two lines past convergence — it must keep its hyphen; it reddens). Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/reflowwrap.ts test/reflow-wrap-hyphen.test.ts
git commit -m "feat(6y39): rejoin a line-end hyphen the patterns confirm"
```

---

### Task 5: Wire original-word splits into ReplaceText

**Files:**
- Modify: `src/replaceadjust.ts` (`ShowInsert.piece` union)
- Modify: `src/textedit.ts` (`planReplace` → `planReflow` faces argument; `planReflow`; `writeReflow`; `showPieces`; `applyEdits` path choice)
- Create: `test/reflow-hyphen.test.ts`

**Interfaces:**
- Consumes: `wrapParagraph` with `hyphen`, `WrapBreak`, `LineBox`; `hyphenator`, `resolveHyphenation`; `FontTiers`.
- Produces:
  - `ShowInsert.piece` gains `| { kind: 'run'; run: Run; anchor: GlyphEvent }`.
  - `planReflow(..., faces: ReflowFaces)` where
    ```ts
    interface ReflowFaces { tiersFor(g: GlyphEvent): FontTiers; canSwitch(g: GlyphEvent): boolean }
    ```
  - `hyphenRunFor(g: GlyphEvent, faces: ReflowFaces, unitRun?: Run): Run | undefined` (module-private in `textedit.ts`).
  - In this task an edit anchor's `unitsOf` is ONE unit (the whole edit); Task 6 splits it.

- [ ] **Step 1: Write failing tests**

`test/reflow-hyphen.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout } from '../src/textedit.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const LONG = 'Documentation of internationalization requirements demonstrates extraordinary responsibility and considerable organizational flexibility throughout implementation';
type Align = 'left' | 'justify';
const block = (text: string, o: { align?: Align; width?: number; hyphenate?: boolean } = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], o.width ?? BOX[2], BOX[3]],
    { fontSize: 12, align: o.align, ...(o.hyphenate ? { hyphenate: { lang: 'en' } } : {}) });
  return Document.Open(d.Save());
};
const measured = (doc: Document) =>
  Math.max(...doc.Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.quad[2]))) - BOX[0] + 1e-3;
const unit = (s: string) => s.replace(/ /g, ' ');
const origins = (doc: Document) => {
  const { text, refs } = pageLayout(doc, doc.Pages[0], {});
  const out: [string, number, number][] = [];
  let last;
  for (let i = 0; i < text.length; i++) {
    const g = refs[i];
    if (!g || g === last || g.text.trim() === '') continue;
    last = g;
    out.push([g.text, g.quad[0], g.quad[1]]);
  }
  return out;
};
const same = (a: [string, number, number][], b: [string, number, number][]) => {
  expect(a.map((x) => x[0]).join('')).toBe(b.map((x) => x[0]).join(''));
  a.forEach((x, i) => { expect(x[1]).toBeCloseTo(b[i][1], 3); expect(x[2]).toBeCloseTo(b[i][2], 3); });
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };

describe('ReplaceText reflow hyphenates like AddTextBlock (6y39)', () => {
  for (const align of ['left', 'justify'] as const) {
    it(`an edit on the first line re-wraps with hyphens (${align})`, () => {
      // Edit on line 0, so every line is re-wrapped and the unhyphenated
      // original's lines before the edit play no part.
      const doc = block(LONG, { align });
      doc.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', HY);
      const want = block(LONG.replace('Documentation', unit('Documentation and analysis')),
        { align, hyphenate: true, ...(align === 'justify' ? {} : { width: measured(block(LONG, { align })) }) });
      const got = origins(doc);
      expect(got.some(([c]) => c === '-')).toBe(true);   // non-vacuous: a hyphen WAS drawn
      same(got, origins(want));
    });
  }
  it('hyphenate absent leaves the whole-word reflow', () => {
    const a = block(LONG), b = block(LONG);
    a.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow' });
    b.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: false });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
    expect(origins(a).some(([c]) => c === '-')).toBe(false);
  });
  it('no language and no lang option: whole-word, silently', () => {
    const a = block(LONG), b = block(LONG);
    a.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow' });
    b.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: {} });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
  });
  it('takes the language from the catalog /Lang', () => {
    const doc = block(LONG);
    doc.Lang = 'en-US';
    doc.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: {} });
    expect(origins(doc).some(([c]) => c === '-')).toBe(true);
  });
  it('draws the hyphen in a fallback face when the font has none', () => {
    // Code 45 remapped to /bullet: the font draws no '-'.
    const lines = ['alpha beta gamma', 'internationalization', 'delta epsilon'];
    const s = `BT /F1 12 Tf 20 280 Td (${lines[0]}) Tj 0 -14 Td (${lines[1]}) Tj 0 -14 Td (${lines[2]}) Tj ET`;
    const doc = Document.Open(buildSimpleTextPdf(s, { differences: '45 /bullet' }));
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabeta', HY)).not.toThrow();
    const noFace = origins(doc);
    expect(noFace.some(([c]) => c === '-')).toBe(false);   // no face: point skipped
    const doc2 = Document.Open(buildSimpleTextPdf(s, { differences: '45 /bullet' }));
    doc2.Pages[0].ReplaceText('beta', 'betabetabeta', { ...HY, fallbackFonts: ['Times-Roman'] });
    expect(origins(doc2).some(([c]) => c === '-')).toBe(true);
    expect(new TextDecoder('latin1').decode(doc2.Pages[0].Contents)).toMatch(/Tf[^]*\(-\) Tj[^]*\/F1 12 Tf/);
  });
  // Review Focus 1: a word drawn by two chained show operators.
  it('splits a word drawn by two show operators', () => {
    const s = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (inter) Tj (nationalization) Tj 0 -14 Td (delta) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(s));
    doc.Pages[0].ReplaceText('gamma', 'gammagammagamma', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/-\n/);
    expect(text.replace(/-\n/g, '')).toContain('internationalization');
  });
  // Review Focus 4: two paragraphs, two languages.
  it('each tagged paragraph hyphenates by its own /Lang', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddMarkdown(`${LONG}\n\nDonaudampfschifffahrtsgesellschaftskapitän und Weltmeisterschaftsqualifikation`, { tagged: true });
    // Mark the second paragraph German through its structure element.
    const doc = Document.Open(d.Save());
    const p2 = doc.GetStructTree()!.Children.flatMap((c) => [c, ...c.Children]).filter((e) => e.StandardType === 'P')[1];
    p2.Dict.set('Lang', { kind: 'string', bytes: new TextEncoder().encode('de') } as never);
    doc.Lang = 'en-US';
    doc.ReplaceText(/und/, 'und auch', { adjust: 'reflow', hyphenate: {}, onUnreflowable: () => {} });
    const lines = doc.Pages[0].GetText().split('\n').filter((l) => l.endsWith('-'));
    expect(lines.length).toBeGreaterThan(0);
  });
});
```

Before relying on the last case: check how this repo sets a structure element's `/Lang` (search `test/` for `Lang` on a `StructElement`; use that helper rather than the raw `Dict.set`), and that `AddMarkdown` with a narrow `Flow` actually wraps those words — narrow the page or use `page.AddMarkdown` with a rect if needed. Assert specifically that the German break is one `de` allows and `en` does not (compare `hyphenator(resolveHyphenation({ lang: 'de' })).points(word)` against the `en` points for the chosen word, and pick a word where they differ), so the case cannot pass on English patterns.

Review Focus 2 (justified with `Tw`) is the `justify` iteration of the first case — AddTextBlock justification writes `Tw`; keep it.

- [ ] **Step 2: Run** — FAIL (no hyphen drawn).

- [ ] **Step 3: Implement**

(a) `src/replaceadjust.ts`, `ShowInsert`:

```ts
export interface ShowInsert {
  addr: ContentAddr; elementIndex: number; byteStart: number;
  piece: { kind: 'kern'; value: number } | { kind: 'op'; op: ContentOp }
    /** A hyphen the reflow draws after a glyph (6y39), written in `anchor`'s text state. */
    | { kind: 'run'; run: Run; anchor: GlyphEvent };
}
```

(b) `src/textedit.ts` — in `showPieces`, extract the run conversion used for edit runs into a local helper and use it for both:

```ts
  const runPiece = (r: Run, anchor: GlyphEvent): ShowPiece => {
    if (r.font === 'original' && r.style === undefined) return { kind: 'bytes', bytes: r.bytes };
    const size = r.style?.size;
    return {
      kind: 'foreign',
      ...(r.font === 'original'
        ? { bytes: r.bytes }
        : { key: keyFor(r.font), ...encodeForeign(r.font, r.text, anchor.wordSpacing, size ?? anchor.tfSize) }),
      size, fill: r.style?.fill, stroke: r.style?.stroke,
    };
  };
```

In `kernsUpTo`, push `const pc = kernsHere[ki].piece; pieces.push(pc.kind === 'run' ? runPiece(pc.run, pc.anchor) : pc);`; the edit-run loop becomes `for (const r of x.runs) pieces.push(runPiece(r, x.anchor));`.

(c) `planReplace` → pass faces to `planReflow`:

```ts
    planReflow(doc, page, pageNumber, streams, streamFor, all, text, refs, covered, spans, inks, anchored, unreflowable, annotWrites, targets, opts, { tiersFor, canSwitch });
```

(d) In `textedit.ts`, near `taggedKeys`:

```ts
/** The fonts a reflow may draw a hyphen in (6y39). */
interface ReflowFaces { tiersFor(g: GlyphEvent): FontTiers; canSwitch(g: GlyphEvent): boolean }

/** The run that draws '-' after a unit of `g`, in the unit's own face first
 *  (`unitRun`'s foreign font, else `g`'s font through `drawCode`), then the
 *  registered same face and `fallbackFonts` where `g`'s scope can switch font.
 *  It carries the unit's style, so a styled replacement's hyphen matches it.
 *  Undefined: no face draws '-', and the point is skipped. */
function hyphenRunFor(g: GlyphEvent, faces: ReflowFaces, unitRun?: Run): Run | undefined {
  const style = unitRun?.style;
  if (unitRun && unitRun.font !== 'original') {
    return driverFor(unitRun.font).probe('-') > 0 ? { font: unitRun.font, text: '-', style } : undefined;
  }
  const bytes = g.font.drawCode('-');
  if (bytes) return { font: 'original', bytes, style };
  if (!faces.canSwitch(g)) return undefined;
  const t = faces.tiersFor(g);
  const f = [t.registered, ...t.fallbacks].find((x): x is AuthoringFont => x !== undefined && driverFor(x).probe('-') > 0);
  return f === undefined ? undefined : { font: f, text: '-', style };
}

/** The language a reflowed paragraph hyphenates in: the anchor glyph's
 *  structure element's, which falls back to the catalog's, or the catalog's
 *  on an untagged page. */
function langAt(doc: Document, page: Page, g: GlyphEvent): string | undefined {
  const root = doc.GetStructTree();
  const sp = doc.resolve(page.Dict.get('StructParents'));
  if (root && typeof sp === 'number' && g.mcid !== undefined && g.addr.path.length === 0) {
    const el = root.ElementFor(sp, g.mcid);
    if (el) return el.EffectiveLang;
  }
  return doc.Lang;
}
```

Imports: `import { hyphenator, resolveHyphenation, type Hyphenator } from './hyphenate.js';`, `import { rethrowLimit } from './errors.js';` (merge with the existing `errors.js` import), `FontTiers` from `./replacefont.js`, and `type HyphenWrap, type WrapUnit` from `./reflowwrap.js`.

(e) In `planReflow`, add the `faces: ReflowFaces` parameter and, before the paragraph loop:

```ts
  const h = opts.hyphenate;
  /** The paragraph's hyphenator, or undefined: off, or no bundled language. */
  const hyphenFor = (anchor: GlyphEvent): { h: Hyphenator; manual: boolean } | undefined => {
    if (h === undefined || h === false) return undefined;
    try {
      const r = resolveHyphenation(h, h.lang === undefined ? langAt(doc, page, anchor) : undefined);
      return { h: hyphenator(r), manual: r.mode === 'manual' };
    } catch (e) {
      rethrowLimit(e);
      return undefined;   // no language, or none with patterns: whole words
    }
  };
  const hyphenRuns = new Map<GlyphEvent, Run | undefined>();
  const hyphenOf = (g: GlyphEvent): Run | undefined => {
    if (!hyphenRuns.has(g)) hyphenRuns.set(g, hyphenRunFor(g, faces));
    return hyphenRuns.get(g);
  };
```

In the paragraph loop, build the `HyphenWrap` and pass it:

```ts
    const hy = hyphenFor(anchor);
    const hyphenWrap: HyphenWrap | undefined = hy && {
      hyphenator: hy.h, manual: hy.manual,
      unitsOf: (g): WrapUnit[] => {
        const e = editOfGlyph.get(g);
        if (e && g !== e.anchor) return [];
        const run = hyphenOf(g);
        const hw = run && runsAdvance([run], g);
        // Task 6 splits an edit into its units; here an edit is one unit.
        return [{ text: e ? '￼' : g.text, width: advanceOf(g), hyphen: hw }];
      },
      canSuppress: () => false,   // Task 7
    };
    const wrap = wrapParagraph({ ..., hyphen: hyphenWrap });
```

(the edit's text is U+FFFC in this task so no pattern point falls inside or beside it as if it were letters — Task 6 replaces it with the real units.)

After the `no-room` check, before `writeReflow`, turn breaks into hyphen inserts:

```ts
    const hyphenAfter = new Map<GlyphEvent, Run>();
    for (const b of wrap.breaks) {
      if (b.own) continue;                       // the original hyphen stays
      const run = hyphenOf(b.glyph)!;            // a break exists only where a face does
      hyphenAfter.set(b.glyph, run);
      if (run.font !== 'original') streamFor(b.glyph.addr).restore.set(b.glyph.addr.opIndex, { key: b.glyph.tfKey, size: b.glyph.tfSize });
    }
    writeReflow(p, wrap.targets, all, gap, editOfGlyph, advanceOf, streamFor, wrap.boxes, hyphenAfter);
```

(f) `writeReflow` gains `boxes: Map<GlyphEvent, LineBox[]>` and `hyphenAfter: Map<GlyphEvent, Run>`. After the existing kern/Tm emission for a member glyph with a target:

```ts
    const hr = hyphenAfter.get(g);
    if (hr) {
      const e2 = editOfGlyph.get(g);
      const ins: ShowInsert = { addr: g.addr, elementIndex: g.elementIndex, byteStart: e2 ? e2.end : g.byteStart + g.byteLen, piece: { kind: 'run', run: hr, anchor: g } };
      const map = streamFor(g.addr).inserts;
      const list = map.get(g.addr.opIndex);
      if (list) list.push(ins); else map.set(g.addr.opIndex, [ins]);
    }
    const bx = boxes.get(g);
    const lastBox = bx?.[bx.length - 1];
    st.pen = lastBox ? [lastBox.x + lastBox.width, lastBox.y] : [t[0] + advanceOf(g), t[1]];
```

replacing the old `st.pen = [t[0] + advanceOf(g), t[1]];`. The hyphen insert is pushed after the glyph's own `Tm`/kern insert; the next glyph's `Tm` (it is on a new line) is pushed later, at the same or a later `byteStart`, and `showPieces` sorts stably — so the order is glyph, hyphen, `Tm`.

(g) In `applyEdits`' path choice nothing changes: an op with inserts already takes `showPieces`.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-hyphen.test.ts test/reflow*.test.ts test/restyle-reflow.test.ts test/reflow-hyphen-identity.test.ts` — PASS. The identity fence must stay green unedited.

- [ ] **Step 5: Mutation-check** — (a) drop the `hyphenAfter` insert: the oracle and fallback cases redden; (b) ignore `langAt` (pass `undefined`): the catalog and two-language cases redden; (c) take the hyphen face from `fallbackFonts` before `drawCode`: the fallback-face regex case reddens (the font's own '-' would then be foreign); (d) put the pen back to `t[0] + advanceOf(g)`: the two-show-operator case reddens (the second operator's chained glyphs). Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/replaceadjust.ts src/textedit.ts test/reflow-hyphen.test.ts
git commit -m "feat(6y39): ReplaceText reflow hyphenates words, with fallback hyphen faces"
```

---

### Task 6: Split a replacement across lines

**Files:**
- Modify: `src/textedit.ts` (`StrEdit.breaks`, `unitsOf` for edit anchors, `writeReflow`, `showPieces`, `applyEdits` path choice)
- Create: `test/reflow-hyphen-edit.test.ts`

**Interfaces:**
- Consumes: `runUnits`, `splitRuns` (Task 2); `WrapBreak.tail` (Task 3); `hyphenRunFor` (Task 5).
- Produces: `StrEdit.breaks?: { unit: number; hyphen: Run; tail: [number, number]; tm?: ContentOp }[]` — a hyphen after unit `unit` of the edit's runs, the rest moved to `tail` by `tm` (set by `writeReflow`).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildType0Pdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const block = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };

describe('a replacement hyphenates across lines (6y39)', () => {
  it('splits a long replacement at a pattern point with a Tm between', () => {
    const doc = block();
    doc.Pages[0].ReplaceText('fox', 'internationalization', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/-\n/);
    expect(text.replace(/-\n/g, '')).toContain('internationalization');
  });
  it('matches AddTextBlock of the new text', () => {
    // Same oracle shape as test/reflow-hyphen.test.ts: edit on line 0.
    const doc = block();
    doc.Pages[0].ReplaceText('quick', 'internationalizational', HY);
    const d = Document.New(PageFormat.A4);
    const w = Math.max(...block().Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.quad[2]))) - BOX[0] + 1e-3;
    d.Pages[0].AddTextBlock(T.replace('quick', 'internationalizational'), [BOX[0], BOX[1], w, BOX[3]], { fontSize: 12, hyphenate: { lang: 'en' } });
    const want = Document.Open(d.Save());
    expect(doc.Pages[0].GetText()).toBe(want.Pages[0].GetText());
  });
  it('a styled replacement keeps its style on both halves and on the hyphen', () => {
    const doc = block();
    doc.Pages[0].ReplaceText('fox', 'internationalization', { ...HY, color: [1, 0, 0] });
    const s = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    // Red set before the head, before the hyphen and before the tail.
    expect(s.match(/1 0 0 rg/g)!.length).toBeGreaterThanOrEqual(2);
    expect(doc.Pages[0].GetText().replace(/-\n/g, '')).toContain('internationalization');
  });
  // Review Focus 5: an Identity-H Type0 font, two-byte codes. drawCode answers
  // through /ToUnicode for an /Identity-H font, so the CMap maps every letter,
  // the space and the hyphen.
  it('splits a replacement in an Identity-H font at a character boundary', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const cid = (c: string) => (c === ' ' ? 3 : c === '-' ? 0x2d : 0x10 + letters.indexOf(c));
    const h4 = (n: number) => n.toString(16).padStart(4, '0');
    const hex = (s: string) => `<${[...s].map((c) => h4(cid(c))).join('')}>`;
    const chars = [...letters, ' ', '-'];
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
      + `${chars.length} beginbfchar ${chars.map((c) => `<${h4(cid(c))}> <${h4(c.charCodeAt(0))}>`).join(' ')} endbfchar\n`;
    const s = `BT /F1 12 Tf 20 250 Td ${hex('alpha beta')} Tj 0 -14 Td ${hex('gamma delta')} Tj 0 -14 Td ${hex('zeta eta')} Tj ET`;
    const doc = Document.Open(buildType0Pdf(s, cmap));
    doc.Pages[0].ReplaceText('beta', 'internationalization', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/-\n/);
    expect(text.replace(/-\n/g, '')).toContain('internationalization');
    for (const op of parseContentStream(doc.Pages[0].Contents)) {
      const strs = op.operator === 'TJ' && isArray(op.operands[0]) ? op.operands[0] : op.operator === 'Tj' ? [op.operands[0]] : [];
      for (const x of strs) if (isString(x)) expect(x.bytes.length % 2).toBe(0);
    }
  });
});
```

Add `import { parseContentStream } from '../src/content.js';` and `import { isArray, isString } from '../src/types.js';`. If `buildType0Pdf` carries `/W` or `/DW` that makes the 3-line box too narrow or too wide for "internationalization" to need a break, adjust the line texts (not the assertions) so the replacement overflows the measured box; the `/-\n/` assertion is the non-vacuity check.

- [ ] **Step 2: Run** — FAIL (the replacement moves whole).

- [ ] **Step 3: Implement**

(a) `StrEdit` gains:

```ts
  /** Where a reflow hyphenated the edit's own text (6y39): a hyphen after unit
   *  `unit` of `runUnits(runs, anchor)`, the rest at `tail`, moved there by
   *  `tm` (set by `writeReflow`). Ascending by `unit`. */
  breaks?: { unit: number; hyphen: Run; tail: [number, number]; tm?: ContentOp }[];
```

(b) In `planReflow`'s `unitsOf`, an edit anchor returns its units:

```ts
        if (e) {
          return runUnits(e.runs, g).map((u) => {
            const run = hyphenRunFor(g, faces, e.runs[u.run]);
            return { text: u.text, width: u.width, hyphen: run && runsAdvance([run], g) };
          });
        }
```

(memoize per `(g, run index)` if profiling shows it hot; correctness does not need it).

(c) Turning breaks into work — replace Task 5's loop body:

```ts
    for (const b of wrap.breaks) {
      if (b.own) continue;
      const e = editOfGlyph.get(b.glyph);
      const nUnits = e ? runUnits(e.runs, b.glyph).length : 1;
      const unitRun = e ? e.runs[runUnits(e.runs, b.glyph)[b.unit].run] : undefined;
      const run = hyphenRunFor(b.glyph, faces, unitRun)!;
      if (run.font !== 'original') streamFor(b.glyph.addr).restore.set(b.glyph.addr.opIndex, { key: b.glyph.tfKey, size: b.glyph.tfSize });
      if (e && b.unit < nUnits - 1) (e.breaks ??= []).push({ unit: b.unit, hyphen: run, tail: b.tail! });
      else hyphenAfter.set(b.glyph, run);
    }
```

(d) `writeReflow`: for an edit anchor with `breaks`, after its own `Tm`/kern insert, set each break's `tm` and mark the scope dirty:

```ts
    if (e?.breaks) {
      for (const br of e.breaks) br.tm = tmFor(g, br.tail[0], br.tail[1]);
      st.dirty = true;
    }
```

(e) `showPieces`, the edit loop:

```ts
    for (const x of mine) {
      kernsUpTo(x.start);
      pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, x.start) });
      const segs = x.breaks ? splitRuns(x.runs, x.anchor, x.breaks.map((b) => b.unit + 1)) : [x.runs];
      segs.forEach((seg, si) => {
        for (const r of seg) pieces.push(runPiece(r, x.anchor));
        const b = x.breaks?.[si];
        if (b) { pieces.push(runPiece(b.hyphen, x.anchor)); pieces.push({ kind: 'op', op: b.tm! }); }
      });
      pos = x.end;
    }
```

(f) `applyEdits`' path choice: `else if (ins.length > 0 || e.some(hasForeign) || e.some((x) => x.breaks))` — an edit with breaks must go through `showPieces`, since `spliceShowOp` cannot place an operator.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-hyphen-edit.test.ts test/reflow-hyphen.test.ts test/reflow*.test.ts test/replace*.test.ts test/reflow-hyphen-identity.test.ts` — PASS.

- [ ] **Step 5: Mutation-check** — (a) drop `e.some((x) => x.breaks)` from the path choice: the split cases redden; (b) cut at `b.unit` instead of `b.unit + 1`: the oracle case reddens (one character moves); (c) drop the hyphen run's `style`: the styled case reddens only if it asserts the hyphen's colour — tighten it to count `rg` before the `(-)` string specifically. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/textedit.ts test/reflow-hyphen-edit.test.ts
git commit -m "feat(6y39): a replacement itself hyphenates across lines"
```

---

### Task 7: Rejoin wiring — remove a hyphen the reflow no longer needs

**Files:**
- Modify: `src/textedit.ts` (`canSuppress`, suppression edits)
- Create: `test/reflow-hyphen-rejoin.test.ts`

**Interfaces:**
- Consumes: `WrapResult.suppressed` (Task 4).
- Produces: for each suppressed glyph `h`, a `StrEdit { elementIndex: h.elementIndex, start: h.byteStart, end: h.byteStart + h.byteLen, runs: [], anchor: h, pos: -1, endPos: -1 }` in `perOp` and `editOfGlyph`. It is not a match and is not counted.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const LONG = 'Documentation of internationalization requirements demonstrates extraordinary responsibility and considerable organizational flexibility throughout implementation';
const hblock = (text: string, width = BOX[2]) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], width, BOX[3]], { fontSize: 12, hyphenate: { lang: 'en' } });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };
const hyphens = (d: Document) => (d.Pages[0].GetText().match(/-\n/g) ?? []).length;

describe('rejoin in ReplaceText (6y39)', () => {
  it('a hyphenated original re-wraps exactly like a fresh hyphenated block', () => {
    const doc = hblock(LONG);
    expect(hyphens(doc)).toBeGreaterThan(0);                       // non-vacuous
    doc.Pages[0].ReplaceText('Documentation', 'Docs', HY);
    const want = hblock(LONG.replace('Documentation', 'Docs'));
    expect(doc.Pages[0].GetText()).toBe(want.Pages[0].GetText());
  });
  it('an edit on a later line keeps the lines before it', () => {
    const doc = hblock(LONG);
    const before = doc.Pages[0].GetText().split('\n');
    doc.Pages[0].ReplaceText('considerable', 'big', HY);
    const after = doc.Pages[0].GetText().split('\n');
    const L = before.findIndex((l) => l.includes('considerable'));
    expect(after.slice(0, L)).toEqual(before.slice(0, L));
  });
  it('a second reflow over our own output leaves no stray hyphen', () => {
    const doc = Document.Open((() => { const d = hblock(LONG); d.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', HY); return d.Save(); })());
    doc.Pages[0].ReplaceText('Documentation and analysis', 'Docs', HY);
    expect(doc.Pages[0].GetText()).not.toMatch(/\w-\s+\w/);   // no "docu- ment" mid-line
    expect(doc.Pages[0].GetText()).toBe(hblock(LONG.replace('Documentation', 'Docs')).Pages[0].GetText());
  });
  it('ReplaceText still counts only real matches', () => {
    const doc = hblock(LONG);
    expect(doc.Pages[0].ReplaceText('Documentation', 'Docs', HY)).toBe(1);
  });
  // Review Focus 3: a tagged document stays tagged.
  it('a tagged document reports no new untagged content', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddMarkdown(LONG, { tagged: true, hyphenate: { lang: 'en' } } as never);
    const doc = Document.Open(d.Save());
    const before = doc.ValidatePdfUa().Issues.filter((i) => i.Rule === 'UntaggedContent').length;
    doc.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', HY);
    expect(doc.ValidatePdfUa().Issues.filter((i) => i.Rule === 'UntaggedContent').length).toBe(before);
  });
});
```

Check `page.AddMarkdown`'s real option name for hyphenation and the `ValidationIssue` field names (`Rule` or `Code`) before running; adjust the access, not the assertion. If the markdown page does not wrap at all at A4 width, use `AddMarkdown` into a narrow rect.

- [ ] **Step 2: Run** — FAIL (stray original hyphens mid-line; texts differ).

- [ ] **Step 3: Implement**

In `planReflow`'s `HyphenWrap`: `canSuppress: (g) => !editOfGlyph.has(g)`.

After the `no-room` check, before turning breaks into work:

```ts
    for (const h of wrap.suppressed) {
      const e: StrEdit = { elementIndex: h.elementIndex, start: h.byteStart, end: h.byteStart + h.byteLen, runs: [], anchor: h, pos: -1, endPos: -1 };
      const { perOp } = streamFor(h.addr);
      const list = perOp.get(h.addr.opIndex);
      if (list) list.push(e); else perOp.set(h.addr.opIndex, [e]);
      editOfGlyph.set(h, e);
    }
```

`advanceOf(h)` then reads `runsAdvance([], h)` = 0, `writeReflow` writes nothing for it, and `spliceShowOp`/`showPieces` remove its bytes; a `Tj` left empty is removed by the existing `emptiedTj` rule. Edits within one element must stay sorted by `start`: `showPieces` and `spliceShowOp` already sort by `start`; confirm `spliceShowOp` does too and sort there if not.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-hyphen-rejoin.test.ts test/reflow-hyphen*.test.ts test/reflow*.test.ts` — PASS.

- [ ] **Step 5: Mutation-check** — (a) `canSuppress: () => false`: cases 1 and 3 redden; (b) skip registering the empty edit in `perOp` (only `editOfGlyph`): the glyph stays drawn and case 1 reddens. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/textedit.ts test/reflow-hyphen-rejoin.test.ts
git commit -m "feat(6y39): reflow removes a line-end hyphen it no longer needs"
```

---

### Task 8: Annotations and RestyleText decorations follow split words

**Files:**
- Modify: `src/textedit.ts` (`moveAnnotQuads`, `DecorateContext.boxes`, `planReplace` decorate call)
- Modify: `src/textrestyle.ts` (`planDecorations`)
- Create: `test/reflow-hyphen-annots.test.ts`

**Interfaces:**
- Consumes: `WrapResult.boxes`, `WrapResult.suppressed`.
- Produces: `DecorateContext.boxes: ReadonlyMap<GlyphEvent, readonly LineBox[]>` (empty without hyphenation); `moveAnnotQuads(..., boxes, gone: ReadonlySet<GlyphEvent>)`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream } from '../src/content.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy internationalization dog and then keeps running far away into the woods';
const block = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };

describe('annotations and decorations over a split word (6y39)', () => {
  it('a highlight over a split word gets one quad per line, the head over its hyphen', () => {
    const doc = block();
    const m = doc.Pages[0].Search('internationalization')[0];
    doc.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', HY);
    expect(doc.Pages[0].GetText()).toMatch(/inter[a-z]*-\n/);   // the word WAS split
    const hl = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
    const qp = hl.Dict.get('QuadPoints') as number[];
    expect(qp.length).toBe(16);
    // Top line first, [x0 y1 x1 y1 x0 y0 x1 y0]: the head's x1 reaches the
    // hyphen's end, which Search reports as the end of the head's quad.
    const head = doc.Pages[0].Search(/inter[a-z]*-/)[0].quads[0];
    expect(qp[2]).toBeCloseTo(head[2], 1);
  });
  it('RestyleText underlines both halves of a split match, the head through its hyphen', () => {
    const doc = block();
    doc.Pages[0].RestyleText('internationalization', { fontSize: 18, underline: true }, HY);
    const ops = parseContentStream(doc.Pages[0].Contents);
    const rects = ops.filter((o) => o.operator === 're');
    expect(rects.length).toBe(2);
  });
});
```

For the rule count, read `test/restyle-reflow.test.ts` for how it counts the operators `decorRects` emits for one underline, and assert twice that number. Keep both assertions in the first case: two quads, and the head reaching the hyphen's end.

- [ ] **Step 2: Run** — FAIL (one quad / one rule).

- [ ] **Step 3: Implement**

(a) `moveAnnotQuads(doc, page, p, targets, advanceOf, annotWrites, annotPlan, boxes, gone)`: skip `gone` glyphs in `mine`/`covered`, and replace the per-glyph box with:

```ts
    for (const g of covered) {
      const t = targets.get(g) ?? [g.quad[0], g.quad[1]];
      const bxs = boxes.get(g) ?? [{ x: t[0], y: t[1], width: advanceOf(g) }];
      for (const b of bxs) {
        const key = Math.round(b.y * 1000);
        const box: ParaRect = [b.x, b.y, b.x + b.width, b.y + g.fontSize];
        const cur = byLine.get(key);
        byLine.set(key, cur ? [Math.min(cur[0], box[0]), Math.min(cur[1], box[1]), Math.max(cur[2], box[2]), Math.max(cur[3], box[3])] : box);
      }
    }
```

Call it with `wrap.boxes` and `new Set(wrap.suppressed)`.

(b) `planReflow` collects every paragraph's `wrap.boxes` into a `boxesOut: Map<GlyphEvent, LineBox[]>` parameter (like `targetsOut`); `planReplace` passes it to `restyle.decorate({ ..., boxes })`, and `DecorateContext` gains `boxes: ReadonlyMap<GlyphEvent, readonly LineBox[]>`.

(c) `planDecorations`: after the existing guards, compute the piece's placements and run the existing body once per placement — extract everything from `// The frame:` to the end of the per-piece body into `decorateAt(g, t: [number, number] | undefined, width: number)`, then:

```ts
    const lineBoxes = piece.glyphs.flatMap((x) => (ctx.boxes.get(x) ?? []).map((b) => ({ g: x, b })));
    if (lineBoxes.length === 0) { decorateAt(g, ctx.targets.get(g), width); continue; }
    const byY = new Map<number, { g: GlyphEvent; x: number; y: number; right: number }>();
    for (const { g: x, b } of lineBoxes) {
      const k = Math.round(b.y * 1000);
      const cur = byY.get(k);
      if (!cur) byY.set(k, { g: x, x: b.x, y: b.y, right: b.x + b.width });
      else { cur.right = Math.max(cur.right, b.x + b.width); if (b.x < cur.x) { cur.x = b.x; cur.g = x; } }
    }
    for (const l of byY.values()) decorateAt(l.g, [l.x, l.y], l.right - l.x);
```

The frame inside `decorateAt` already derives the origin from `t` and the glyph's own `quad`, so a tail line's box placed by its first glyph (or the edit anchor itself for a split replacement) is correct.

- [ ] **Step 4: Run** — `npx vitest run test/reflow-hyphen-annots.test.ts test/reflow-annots.test.ts test/restyle*.test.ts test/reflow-hyphen-identity.test.ts` — PASS; the fence's `restyle-reflow` and `replace-link` hashes must not move.

- [ ] **Step 5: Mutation-check** — (a) ignore `boxes` in `moveAnnotQuads`: one quad, case 1 reddens; (b) decorate only the first placement: case 2 reddens. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/textedit.ts src/textrestyle.ts test/reflow-hyphen-annots.test.ts
git commit -m "feat(6y39): links, markup and restyle decorations follow a split word"
```

---

### Task 9: Docs, full suite, close

**Files:**
- Modify: `README.md` (Key Capabilities "Text replace" entry; "Scope and Limitations" line saying reflow never hyphenates; the `ReplaceTextOptions` and `RestyleTextOptions` rows; the `page.ReplaceText` API row)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → **Added**)
- Modify: `CLAUDE.md` (Source list: `reflowwrap.ts`, `textedit.ts`'s reflow notes, `replaceadjust.ts`'s `runUnits`)

- [ ] **Step 1: README** — in the Text replace entry, after the sentence ending "…and links and text-markup annotations over the paragraph move with their words.", add:

> With `hyphenate` (the same options `AddTextBlock` takes), a word that no longer fits breaks at the rightmost hyphenation point that fits and a hyphen is drawn — in the word's own font, else the registered same face or `fallbackFonts`; a point no face can draw is skipped. A replacement hyphenates like any word. Without `lang`, each paragraph uses its own language — its structure element's `/Lang`, then the document's — and a paragraph whose language has no bundled patterns reflows whole words. A hyphen already ending a line is removed when the reflow joins its halves and the patterns confirm it was a break (in `mode: 'manual'`, only a soft hyphen). The drawn hyphen extracts as `-`, as `AddTextBlock`'s do. `hyphenate` requires `adjust: 'reflow'`.

Remove "never hyphenates or breaks inside a word" from Scope and Limitations (rewrite the line to say breaking inside a word needs `hyphenate`). Add `hyphenate` to the two options rows and the `page.ReplaceText` row.

- [ ] **Step 2: CHANGELOG** — under `## [Unreleased]` / **Added**:

> - **Hyphenation in reflow.** `ReplaceText` and `RestyleText` with `adjust: 'reflow'` take `hyphenate` — the options `AddTextBlock` takes — and break a word that no longer fits at a Liang pattern point (or a soft hyphen with `mode: 'manual'`), drawing a hyphen in the word's own font or a fallback. The wrap goes through the same engine as `AddTextBlock`, so a reflowed paragraph breaks exactly as a fresh block of its new text would; that is what the tests compare against. A replacement hyphenates too, split inside its own show operator with a `Tm`. Without `lang` each paragraph uses its own `/Lang`; a hyphen already at a line end is removed when the reflow rejoins its halves and the patterns confirm the break, so reflowing our own output twice leaves no stray `docu- ment`. Off by default, and then output is byte-identical. (6y39)

- [ ] **Step 3: CLAUDE.md** — under the `reflowpara.ts`, `reflowwrap.ts` entry add invariants:
  - **(6y39)** with `hyphenate`, a word is UNITS, each its own `LayoutRun` holding one unique plane-15 private-use proxy — so `layoutRuns` (the one engine) decides breaks and heads, `segment.run` names the unit, and the line-break class (XX→AL) admits no break but the adapter's points. A separator space is measured by the PRECEDING run's driver, so every unit's driver answers `' '` with the gap after its word; the no-points case is pinned glyph-for-glyph against the atomic path.
  - **(6y39)** points come from the word's REAL text and survive only on a unit boundary, so a ligature is never cut.
  - **(6y39)** rejoin: a line-final drawn `-`/U+00AD before a lower-case word on the next line, at a pattern point (or a real U+00AD), becomes the preceding unit's own hyphen; kept → no insert, joined → an empty `StrEdit` removes it. Never past convergence.
  - **(6y39)** language: option, element `EffectiveLang`, catalog; none → silent whole words.
  - Under `replaceadjust.ts`: `runUnits` sums EXACTLY to `runsAdvance`; `splitRuns` cuts an original run at a decoded glyph's byte boundary.
  - Record each mutation result from Tasks 3-8 (which reddened, and any that stayed green with the reason), in this file's "Note, measured" style.

- [ ] **Step 4: Full suite**

Run: `npm run typecheck && npm test`
Expected: both green. `test/readme-api.test.ts` must stay green (no new exports). `test/limits-catch.test.ts` must stay green (every new `catch` calls `rethrowLimit`). `test/import-cycles.test.ts` must stay green (`replacefont.ts` → `hyphenate.ts` is a leaf edge).

- [ ] **Step 5: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(6y39): hyphenation in reflow — README, CHANGELOG, CLAUDE.md"
bd close aspose-pdf-foss-for-ts-6y39
git pull --rebase && git push && git status
```

Expected: `git status` reports up to date with origin.
