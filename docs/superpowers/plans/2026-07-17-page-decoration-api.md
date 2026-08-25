# Page Decoration API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.AddWatermark` / `doc.AddHeaderFooter` / `doc.AddBatesNumbering` — an ergonomic layer that repeats a text or image stamp across a page range with `{page}`/`{total}`/`{bates}` tokens resolved, positioning presets, opacity, and rotation.

**Architecture:** Two new modules. `src/pagerange.ts` owns the page-selection grammar. `src/decorate.ts` holds token resolution, visual-frame geometry, and the three entry points; it draws by calling the existing `stampText` (src/stamp.ts) and `buildImageXObject` (src/imageembed.ts). No new rendering primitives. `src/document.ts` gains three thin delegating methods in the style of the existing `Overlay`/`NUp`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-page-decoration-api-design.md`
**Issue:** `aspose-pdf-foss-for-ts-h8s`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (e.g. `import { Page } from './page.js';`), including in tests.
- **Strict TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green.
- **TDD.** Test first, watch it fail, then implement. Fixtures are built programmatically in `test/helpers/`.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (src/errors.ts). Plain `TypeError`/`RangeError` are used for argument validation, matching `compose.ts`.
- **Both gates green before closing the issue:** `npm run typecheck` and `npm test`.
- **Issue tracking is `bd`**, not TodoWrite or markdown TODO lists.
- **README.md must stay in sync** when public API changes (project convention).
- **Never renumber or mutate source documents.** All edits go through `appendContent`/`prependContent`, which preserve existing content.
- **Commit after every task.** Branch `feat/page-decoration` already exists and holds the spec commit.

---

### Task 1: Page range grammar (`pagerange.ts`)

Self-contained: a string grammar plus its errors. No dependency on any other task.

**Files:**
- Create: `src/pagerange.ts`
- Test: `test/pagerange.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolvePages(spec: number[] | string | undefined, total: number): number[]` — 1-based, ascending, deduped.

- [ ] **Step 1: Write the failing test**

Create `test/pagerange.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolvePages } from '../src/pagerange.js';

describe('resolvePages', () => {
  it('defaults to every page', () => {
    expect(resolvePages(undefined, 3)).toEqual([1, 2, 3]);
  });

  it('accepts a number array and normalizes it', () => {
    expect(resolvePages([3, 1], 3)).toEqual([1, 3]);
  });

  it('parses a single page', () => {
    expect(resolvePages('2', 3)).toEqual([2]);
  });

  it('parses an inclusive range', () => {
    expect(resolvePages('1-3', 5)).toEqual([1, 2, 3]);
  });

  it('parses an open-ended range', () => {
    expect(resolvePages('3-', 5)).toEqual([3, 4, 5]);
  });

  it('parses a from-the-start range', () => {
    expect(resolvePages('-3', 5)).toEqual([1, 2, 3]);
  });

  it('parses comma-separated terms', () => {
    expect(resolvePages('1,3-4', 5)).toEqual([1, 3, 4]);
  });

  it('tolerates whitespace', () => {
    expect(resolvePages(' 1 - 2 , 4 ', 5)).toEqual([1, 2, 4]);
  });

  it('normalizes ascending and collapses duplicates', () => {
    expect(resolvePages('3,1-2,1', 5)).toEqual([1, 2, 3]);
  });

  it('throws TypeError on an empty term', () => {
    expect(() => resolvePages('1,,2', 5)).toThrow(TypeError);
  });

  it('throws TypeError on a malformed term', () => {
    expect(() => resolvePages('1-a', 5)).toThrow(TypeError);
  });

  it('throws TypeError on a reversed range', () => {
    expect(() => resolvePages('5-1', 5)).toThrow(TypeError);
  });

  it('throws RangeError past the end', () => {
    expect(() => resolvePages('4-9', 5)).toThrow(RangeError);
  });

  it('throws RangeError on page 0', () => {
    expect(() => resolvePages('0', 5)).toThrow(RangeError);
  });

  it('throws RangeError for an open range starting past the end', () => {
    expect(() => resolvePages('9-', 5)).toThrow(RangeError);
  });

  it('throws RangeError for an array entry out of range', () => {
    expect(() => resolvePages([9], 5)).toThrow(RangeError);
  });

  it('throws TypeError for a non-integer array entry', () => {
    expect(() => resolvePages([1.5], 5)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pagerange.test.ts`
Expected: FAIL — cannot resolve `../src/pagerange.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/pagerange.ts`:

```ts
// Page selection for the decoration API: an explicit 1-based list (the existing
// Overlay convention) or a range string like "1-5,8,12-".

/** One term of a range string: `N`, `N-M`, `N-`, or `-M` (whitespace tolerated). */
const TERM = /^(?:(\d+)|(\d+)\s*-\s*(\d+)|(\d+)\s*-|-\s*(\d+))$/;

/** Expand a range string to a 1-based page list (unsorted, may repeat).
 *  Bounds are checked per term so the error names the offending term. */
function parseRangeString(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const t = raw.trim();
    if (t === '') throw new TypeError(`page range "${spec}": empty term`);
    const m = TERM.exec(t);
    if (m === null) throw new TypeError(`page range "${spec}": malformed term "${t}"`);
    let lo: number, hi: number;
    if (m[1] !== undefined) { lo = hi = Number(m[1]); }        // N
    else if (m[2] !== undefined) { lo = Number(m[2]); hi = Number(m[3]); } // N-M
    else if (m[4] !== undefined) { lo = Number(m[4]); hi = total; }        // N-
    else { lo = 1; hi = Number(m[5]); }                                     // -M
    // Bounds before ordering, so "9-" on a 5-page doc reports the real problem
    // (out of range) rather than looking like a reversed range.
    if (lo < 1 || lo > total || hi > total)
      throw new RangeError(`page range "${spec}": term "${t}" out of range (1..${total})`);
    if (lo > hi) throw new TypeError(`page range "${spec}": reversed range "${t}"`);
    for (let n = lo; n <= hi; n++) out.push(n);
  }
  return out;
}

/** Resolve a page selection to a normalized 1-based list: ascending, deduped.
 *  `undefined` selects every page. A `number[]` is taken as given (the existing
 *  Overlay convention); a string is parsed as the range grammar.
 *  Throws TypeError for malformed input, RangeError for out-of-bounds pages. */
export function resolvePages(
  spec: number[] | string | undefined, total: number,
): number[] {
  if (spec === undefined) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = Array.isArray(spec) ? spec : parseRangeString(spec, total);
  for (const n of pages) {
    if (!Number.isInteger(n)) throw new TypeError(`page ${n} must be an integer`);
    if (n < 1 || n > total) throw new RangeError(`page ${n} out of range (1..${total})`);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/pagerange.test.ts && npm run typecheck`
Expected: PASS (17 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/pagerange.ts test/pagerange.test.ts
git commit -m "feat(h8s): page range grammar for decoration APIs"
```

---

### Task 2: Token resolution (`decorate.ts`)

Creates `decorate.ts` with only the token layer. Exported `@internal` so tests can hit it directly; the module gains geometry in Task 3 and the public entry points in Task 4.

**Files:**
- Create: `src/decorate.ts`
- Test: `test/decorate-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `validateTemplate(template: string, allowBates: boolean): void`
  - `resolveTemplate(template: string, values: Record<string, string>): string`
  - `stampedNow(): { date: string; time: string }`

- [ ] **Step 1: Write the failing test**

Create `test/decorate-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateTemplate, resolveTemplate, stampedNow } from '../src/decorate.js';

const values = {
  page: '2', total: '10', label: 'ii', bates: 'ABC-000042', date: '2026-07-17', time: '14:32',
};

describe('validateTemplate', () => {
  it('accepts the known tokens', () => {
    expect(() => validateTemplate('{page}/{total} {label} {date} {time}', false)).not.toThrow();
  });

  it('accepts text with no tokens', () => {
    expect(() => validateTemplate('DRAFT', false)).not.toThrow();
  });

  it('throws TypeError on an unknown token', () => {
    expect(() => validateTemplate('Page {pages}', false)).toThrow(TypeError);
  });

  it('names the offending token and lists the valid set', () => {
    expect(() => validateTemplate('Page {pages}', false)).toThrow(/\{pages\}.*\{page\}/s);
  });

  it('rejects {bates} when no counter is in scope', () => {
    expect(() => validateTemplate('{bates}', false)).toThrow(TypeError);
  });

  it('accepts {bates} when a counter is in scope', () => {
    expect(() => validateTemplate('{bates}', true)).not.toThrow();
  });

  it('ignores an escaped brace', () => {
    expect(() => validateTemplate('{{page}', false)).not.toThrow();
  });
});

describe('resolveTemplate', () => {
  it('substitutes each token', () => {
    expect(resolveTemplate('{page} of {total}', values)).toBe('2 of 10');
  });

  it('substitutes the page label', () => {
    expect(resolveTemplate('[{label}]', values)).toBe('[ii]');
  });

  it('substitutes date and time', () => {
    expect(resolveTemplate('{date} {time}', values)).toBe('2026-07-17 14:32');
  });

  it('unescapes {{ to a literal brace', () => {
    expect(resolveTemplate('{{page}', values)).toBe('{page}');
  });

  it('leaves a bare closing brace literal', () => {
    expect(resolveTemplate('a}b', values)).toBe('a}b');
  });

  it('repeats a token as many times as it appears', () => {
    expect(resolveTemplate('{page}{page}', values)).toBe('22');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveTemplate('CONFIDENTIAL', values)).toBe('CONFIDENTIAL');
  });
});

describe('stampedNow', () => {
  it('formats date as YYYY-MM-DD and time as HH:MM', () => {
    const s = stampedNow();
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-tokens.test.ts`
Expected: FAIL — cannot resolve `../src/decorate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/decorate.ts`:

```ts
// Page decoration (issue h8s): watermark / header-footer / Bates numbering as an
// ergonomic layer over the stamping primitives. No new rendering primitives —
// text goes through stampText (stamp.ts), images through buildImageXObject
// (imageembed.ts).

/** Tokens callers may write in any decoration text. */
const TOKENS = ['page', 'total', 'label', 'bates', 'date', 'time'] as const;

/** A fresh matcher each call: the regex is stateful under /g, so sharing one
 *  module-level instance between matchAll and replace would leak lastIndex. */
const tokenRe = (): RegExp => /\{\{|\{([a-z]+)\}/g;

/** @internal Throw a TypeError for any unknown token in `template`.
 *  `allowBates` is false outside AddBatesNumbering, where no counter is in
 *  scope. Validation is eager — callers scan every template before touching a
 *  page — so a typo like {pages} cannot silently stamp literal text onto 400
 *  pages, and a throwing call leaves the document untouched. */
export function validateTemplate(template: string, allowBates: boolean): void {
  const valid: readonly string[] = TOKENS.filter((t) => t !== 'bates' || allowBates);
  for (const m of template.matchAll(tokenRe())) {
    if (m[1] === undefined) continue; // '{{' escape, not a token
    if (!valid.includes(m[1]))
      throw new TypeError(
        `unknown token {${m[1]}}: valid tokens are ${valid.map((t) => `{${t}}`).join(', ')}`);
  }
}

/** @internal Substitute tokens in `template`. `{{` yields a literal `{`; a bare
 *  `}` is literal (so `{{page}` renders as `{page}`). Assumes the template has
 *  already passed validateTemplate. */
export function resolveTemplate(template: string, values: Record<string, string>): string {
  return template.replace(tokenRe(), (_m, tok: string | undefined) =>
    tok === undefined ? '{' : (values[tok] ?? ''));
}

/** @internal The `{date}`/`{time}` values for one call. Computed once per call,
 *  never per page: a long run must not straddle midnight and stamp two dates. */
export function stampedNow(): { date: string; time: string } {
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/decorate-tokens.test.ts && npm run typecheck`
Expected: PASS (15 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/decorate.ts test/decorate-tokens.test.ts
git commit -m "feat(h8s): decoration text token resolution"
```

---

### Task 3: Visual frame and preset anchors

The rotation-aware geometry. Unit-tested directly against the spec's matrix table, because a rotation sign error here is invisible until someone opens a rotated page.

**Files:**
- Modify: `src/decorate.ts` (append)
- Test: `test/decorate-geometry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type StampPosition = 'diagonal' | 'center' | 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'`
  - `const POSITIONS: readonly StampPosition[]`
  - `interface VisualFrame { M: Matrix; VW: number; VH: number; R: number }`
  - `visualFrame(page: Page): VisualFrame`
  - `interface TextAnchor { vx: number; vy: number; align: 'left' | 'center' | 'right'; angle: number }`
  - `textAnchor(position: StampPosition, f: VisualFrame, margin: number, fontSize: number): TextAnchor`
  - `interface ImageAnchor { vx: number; vy: number; fx: number; fy: number; angle: number }`
  - `imageAnchor(position: StampPosition, f: VisualFrame, margin: number): ImageAnchor`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-decorate-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

export interface DecorateTargetOptions {
  /** Number of pages. Default 3. */
  count?: number;
  /** /Rotate on every page. Default 0. */
  rotate?: number;
  /** MediaBox/CropBox origin [x0, y0]. Default [0, 0]. */
  origin?: [number, number];
  /** Page size [w, h]. Default [200, 100]. */
  size?: [number, number];
  /** Add /PageLabels: lowercase roman from page 1. Default false. */
  labels?: boolean;
}

/** `count` pages, each showing "P<n>" so existing content is observable.
 *  Object layout: 1 catalog, 2 pages node, 3 font, then per page a page dict and
 *  a content stream, then optionally the /PageLabels number tree. */
export function buildDecorateTarget(opts: DecorateTargetOptions = {}): Uint8Array {
  const count = opts.count ?? 3;
  const rotate = opts.rotate ?? 0;
  const [x0, y0] = opts.origin ?? [0, 0];
  const [w, h] = opts.size ?? [200, 100];
  const box = `[${x0} ${y0} ${x0 + w} ${y0 + h}]`;
  const rot = rotate ? ` /Rotate ${rotate}` : '';

  const objects: string[] = [];
  const kids: string[] = [];
  let next = 4; // 1 catalog, 2 pages, 3 font
  for (let i = 1; i <= count; i++) {
    const pageNum = next++;
    const contentNum = next++;
    kids.push(`${pageNum} 0 R`);
    const content = `BT /F1 12 Tf ${x0 + 10} ${y0 + 10} Td (P${i}) Tj ET`;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /CropBox ${box}` +
      `${rot} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  }

  let labelsEntry = '';
  if (opts.labels) {
    const labelsNum = next++;
    objects[labelsNum] = `<< /Nums [0 << /S /r >>] >>`;
    labelsEntry = ` /PageLabels ${labelsNum} 0 R`;
  }

  objects[1] = `<< /Type /Catalog /Pages 2 0 R${labelsEntry} >>`;
  objects[2] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(objects, next - 1, 1);
}

/** Two pages of different sizes (200x100 then 400x400), for per-page geometry. */
export function buildDecorateMixedSizes(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [0 0 200 100] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /CropBox [0 0 400 400] >>`;
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/decorate-geometry.test.ts`. The expected matrices come straight from the spec's table; the corner assertions are computed by hand as an independent check.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visualFrame, textAnchor, imageAnchor } from '../src/decorate.js';
import { apply } from '../src/text.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

/** First page of a 200x100 document at the given /Rotate. */
const pageAt = (rotate: number) =>
  Document.Open(buildDecorateTarget({ count: 1, rotate })).Pages[0];

describe('visualFrame', () => {
  it('is the identity on an unrotated page at the origin', () => {
    const f = visualFrame(pageAt(0));
    expect(f.M).toEqual([1, 0, 0, 1, 0, 0]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
    expect(f.R).toBe(0);
  });

  it('swaps the extent and maps corners for /Rotate 90', () => {
    const f = visualFrame(pageAt(90));
    expect(f.M).toEqual([0, 1, -1, 0, 200, 0]);
    expect([f.VW, f.VH]).toEqual([100, 200]);
    // Visual bottom-left is the unrotated page's bottom-right: a 90-degree
    // clockwise display turn brings the right edge down to the bottom.
    expect(apply(f.M, 0, 0)).toEqual([200, 0]);
    // Visual top-right is the unrotated top-left.
    expect(apply(f.M, 100, 200)).toEqual([0, 100]);
  });

  it('maps corners for /Rotate 180', () => {
    const f = visualFrame(pageAt(180));
    expect(f.M).toEqual([-1, 0, 0, -1, 200, 100]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
    expect(apply(f.M, 0, 0)).toEqual([200, 100]);
  });

  it('swaps the extent and maps corners for /Rotate 270', () => {
    const f = visualFrame(pageAt(270));
    expect(f.M).toEqual([0, -1, 1, 0, 0, 100]);
    expect([f.VW, f.VH]).toEqual([100, 200]);
    expect(apply(f.M, 0, 0)).toEqual([0, 100]);
  });

  it('offsets by a non-zero CropBox origin', () => {
    const page = Document.Open(
      buildDecorateTarget({ count: 1, origin: [50, 20] })).Pages[0];
    const f = visualFrame(page);
    expect(f.M).toEqual([1, 0, 0, 1, 50, 20]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
  });
});

describe('textAnchor', () => {
  const f = { M: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    VW: 200, VH: 100, R: 0 };

  it('insets a bottom-left anchor by the margin, on the baseline', () => {
    expect(textAnchor('bottom-left', f, 36, 10))
      .toEqual({ vx: 36, vy: 36, align: 'left', angle: 0 });
  });

  it('drops a top anchor by the margin plus the font size', () => {
    expect(textAnchor('top-left', f, 36, 10))
      .toEqual({ vx: 36, vy: 100 - 36 - 10, align: 'left', angle: 0 });
  });

  it('centers a top-center anchor horizontally', () => {
    expect(textAnchor('top-center', f, 36, 10).vx).toBe(100);
    expect(textAnchor('top-center', f, 36, 10).align).toBe('center');
  });

  it('insets a bottom-right anchor from the right edge', () => {
    expect(textAnchor('bottom-right', f, 36, 10))
      .toEqual({ vx: 164, vy: 36, align: 'right', angle: 0 });
  });

  it('places center at the visual middle with no rotation', () => {
    const a = textAnchor('center', f, 36, 10);
    expect(a.vx).toBe(100);
    expect(a.vy).toBeCloseTo(50 - 3.5, 6);
    expect(a.angle).toBe(0);
  });

  it('rotates diagonal to the page diagonal', () => {
    // atan2(100, 200) = 26.565 degrees
    expect(textAnchor('diagonal', f, 36, 10).angle).toBeCloseTo(26.5651, 3);
  });

  it('uses 45 degrees on a square page', () => {
    const sq = { ...f, VW: 300, VH: 300 };
    expect(textAnchor('diagonal', sq, 36, 10).angle).toBeCloseTo(45, 6);
  });
});

describe('imageAnchor', () => {
  const f = { M: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    VW: 200, VH: 100, R: 0 };

  it('anchors bottom-left at the margin with the bottom-left fraction', () => {
    expect(imageAnchor('bottom-left', f, 36))
      .toEqual({ vx: 36, vy: 36, fx: 0, fy: 0, angle: 0 });
  });

  it('anchors top-right at the inset corner with the top-right fraction', () => {
    expect(imageAnchor('top-right', f, 36))
      .toEqual({ vx: 164, vy: 64, fx: 1, fy: 1, angle: 0 });
  });

  it('centers diagonal on its own middle so it rotates about its center', () => {
    const a = imageAnchor('diagonal', f, 36);
    expect([a.vx, a.vy, a.fx, a.fy]).toEqual([100, 50, 0.5, 0.5]);
    expect(a.angle).toBeCloseTo(26.5651, 3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/decorate-geometry.test.ts`
Expected: FAIL — `visualFrame`/`textAnchor`/`imageAnchor` are not exported from `../src/decorate.js`.

- [ ] **Step 4: Write minimal implementation**

Add these imports to the top of `src/decorate.ts`:

```ts
import type { Page } from './page.js';
import type { Matrix } from './text.js';
```

Append to `src/decorate.ts`:

```ts
/** Where a stamp anchors in the page's visual frame. */
export type StampPosition =
  | 'diagonal' | 'center'
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** @internal Every valid StampPosition (drives validation error messages). */
export const POSITIONS: readonly StampPosition[] = [
  'diagonal', 'center',
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/** @internal The page as the viewer sees it: `M` maps visual-frame coordinates
 *  (origin at the displayed bottom-left, extent VW x VH) into user space, and
 *  `R` is the page's /Rotate. */
export interface VisualFrame {
  M: Matrix;
  VW: number;
  VH: number;
  R: number;
}

/** @internal Build the visual frame for `page` from its CropBox and /Rotate.
 *  /Rotate turns the page clockwise for display, so M is that turn's inverse
 *  (plus the CropBox origin offset). Derived and tabulated in the design spec. */
export function visualFrame(page: Page): VisualFrame {
  const [x0, y0, x1, y1] = page.CropBox;
  const w = x1 - x0, h = y1 - y0;
  const R = page.Rotate;
  switch (R) {
    case 90:  return { M: [0, 1, -1, 0, x0 + w, y0], VW: h, VH: w, R };
    case 180: return { M: [-1, 0, 0, -1, x0 + w, y0 + h], VW: w, VH: h, R };
    case 270: return { M: [0, -1, 1, 0, x0, y0 + h], VW: h, VH: w, R };
    default:  return { M: [1, 0, 0, 1, x0, y0], VW: w, VH: h, R };
  }
}

/** Fraction of the em above the baseline used to optically center a single line
 *  (about half of Helvetica's cap height, 0.7em). */
const CAP_HALF = 0.35;

/** @internal A text stamp's placement in the visual frame: baseline anchor,
 *  the alignment that anchor implies, and the apparent (as-displayed) angle. */
export interface TextAnchor {
  vx: number;
  vy: number;
  align: 'left' | 'center' | 'right';
  angle: number;
}

/** @internal Baseline anchor for `position` in the visual frame. Corner/edge
 *  presets inset by `margin`; a top band drops a further `fontSize` so the
 *  glyphs sit below the margin rather than straddling it. */
export function textAnchor(
  position: StampPosition, f: VisualFrame, margin: number, fontSize: number,
): TextAnchor {
  if (position === 'diagonal' || position === 'center') {
    const angle = position === 'diagonal' ? (Math.atan2(f.VH, f.VW) * 180) / Math.PI : 0;
    return { vx: f.VW / 2, vy: f.VH / 2 - fontSize * CAP_HALF, align: 'center', angle };
  }
  const [band, side] = position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  return {
    vx: side === 'left' ? margin : side === 'right' ? f.VW - margin : f.VW / 2,
    vy: band === 'top' ? f.VH - margin - fontSize : margin,
    align: side,
    angle: 0,
  };
}

/** @internal An image stamp's placement in the visual frame: the anchor point,
 *  the fraction of the image's own box that sits at it (fx/fy in 0..1), and the
 *  apparent angle. */
export interface ImageAnchor {
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  angle: number;
}

/** @internal Anchor for an image stamp. Mirrors textAnchor, but anchors a box
 *  rather than a baseline: `diagonal`/`center` pin the image's own center so it
 *  rotates about itself. */
export function imageAnchor(
  position: StampPosition, f: VisualFrame, margin: number,
): ImageAnchor {
  if (position === 'diagonal' || position === 'center') {
    const angle = position === 'diagonal' ? (Math.atan2(f.VH, f.VW) * 180) / Math.PI : 0;
    return { vx: f.VW / 2, vy: f.VH / 2, fx: 0.5, fy: 0.5, angle };
  }
  const [band, side] = position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  return {
    vx: side === 'left' ? margin : side === 'right' ? f.VW - margin : f.VW / 2,
    vy: band === 'top' ? f.VH - margin : margin,
    fx: side === 'left' ? 0 : side === 'right' ? 1 : 0.5,
    fy: band === 'top' ? 1 : 0,
    angle: 0,
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/decorate-geometry.test.ts && npm run typecheck`
Expected: PASS (15 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/decorate.ts test/decorate-geometry.test.ts test/helpers/build-decorate-pdf.ts
git commit -m "feat(h8s): rotation-aware visual frame and preset anchors"
```

---

### Task 4: `AddWatermark` (text)

Wires geometry + tokens into the first public entry point. Also threads an optional splice through `stampText`, because `mode: 'underlay'` (the watermark default) needs `prependContent` and `stampText` currently hardcodes `appendContent`.

**Files:**
- Modify: `src/stamp.ts:200-234` (`stampText` — add the `splice` parameter)
- Modify: `src/decorate.ts` (append)
- Modify: `src/document.ts` (import + `AddWatermark`, next to `Overlay` at ~line 1658)
- Modify: `src/index.ts` (exports)
- Test: `test/decorate-watermark.test.ts`

**Interfaces:**
- Consumes: `resolvePages` (Task 1); `validateTemplate` / `resolveTemplate` / `stampedNow` (Task 2); `StampPosition` / `POSITIONS` / `VisualFrame` / `visualFrame` / `textAnchor` (Task 3).
- Produces:
  - `type ContentSplice = (doc: Document, page: Page, body: Uint8Array) => void` (src/stamp.ts)
  - `interface Placement { position; margin; opacity; rotate?; font; fontSize?; color; underlay }`
  - `normalizePlacement(p: Placement): Placement`
  - `tokenValuesFor(doc, n, total, now, needsLabel): Record<string, string>`
  - `drawText(doc: Document, page: Page, text: string, p: Placement): void`
  - `interface WatermarkOptions`, `addWatermark(doc: Document, opts: WatermarkOptions): void`
  - `Document.AddWatermark(opts: WatermarkOptions): void`

- [ ] **Step 1: Write the failing test**

Create `test/decorate-watermark.test.ts`. The `Tm` assertions are the heart of this task: `bottom-left` implies `align: 'left'`, which zeroes the width term in `stampText`'s `tx`/`ty`, so each rotation has one exact hand-computable matrix. `stampText` emits `cos sin -sin cos tx ty Tm`, and `num()` rounds the ~1e-16 cosines to `0`.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { buildDecorateTarget, buildDecorateMixedSizes } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

/** A watermark whose Tm depends only on the rotation, not on glyph widths. */
const stampCorner = (rotate: number) => {
  const doc = Document.Open(buildDecorateTarget({ count: 1, rotate }));
  doc.AddWatermark({
    text: 'X', position: 'bottom-left', margin: 36,
    fontSize: 10, opacity: 1, mode: 'overlay',
  });
  return decoded(doc.Pages[0]);
};

describe('AddWatermark placement', () => {
  // 200x100 page, bottom-left, margin 36. Visual anchor (36, 36) maps through
  // the frame matrix to user space, and the stamp counter-rotates by /Rotate so
  // it renders upright.
  it('places upright on an unrotated page', () => {
    expect(stampCorner(0)).toContain('1 0 0 1 36 36 Tm');
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    expect(stampCorner(90)).toContain('0 1 -1 0 164 36 Tm');
  });

  it('counter-rotates on a /Rotate 180 page', () => {
    expect(stampCorner(180)).toContain('-1 0 0 -1 164 64 Tm');
  });

  it('counter-rotates on a /Rotate 270 page', () => {
    expect(stampCorner(270)).toContain('0 -1 1 0 36 64 Tm');
  });

  it('offsets by a non-zero CropBox origin', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, origin: [50, 20] }));
    doc.AddWatermark({
      text: 'X', position: 'bottom-left', margin: 36,
      fontSize: 10, opacity: 1, mode: 'overlay',
    });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 86 56 Tm');
  });

  it('auto-fits a diagonal watermark to ~80% of the page diagonal', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal' });
    const page = doc.Pages[0];
    // hypot(200, 100) = 223.607; target width = 178.885.
    const m = /\/F\d+ ([\d.]+) Tf/.exec(decoded(page));
    expect(m).not.toBeNull();
    const fontSize = Number(m![1]);
    expect(page.MeasureText('DRAFT', fontSize)).toBeCloseTo(178.885, 1);
  });

  it('honors an explicit fontSize instead of auto-fitting', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal', fontSize: 8 });
    expect(decoded(doc.Pages[0])).toMatch(/\/F\d+ 8 Tf/);
  });

  it('fits each page of a mixed-size document independently', () => {
    const doc = Document.Open(buildDecorateMixedSizes());
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal' });
    const size = (i: number) =>
      Number(/\/F\d+ ([\d.]+) Tf/.exec(decoded(doc.Pages[i]))![1]);
    expect(size(1)).toBeGreaterThan(size(0)); // 400x400 page gets larger text
  });
});

describe('AddWatermark options', () => {
  it('defaults to an underlay drawn before existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(DRAFT)')).toBeLessThan(s.indexOf('(P1)'));
  });

  it('draws an overlay after existing content when asked', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', mode: 'overlay' });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(DRAFT)')).toBeGreaterThan(s.indexOf('(P1)'));
  });

  it('emits an /ExtGState for the default 0.3 opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    const page = doc.Pages[0];
    expect(decoded(page)).toMatch(/\/GS\d+ gs/);
    const gs = doc.resolve(page.Resources!.get('ExtGState'));
    expect(isDict(gs)).toBe(true);
    const entry = doc.resolve([...(gs as Map<string, unknown>).values()][0]);
    expect(isDict(entry)).toBe(true);
    expect(doc.resolve((entry as Map<string, unknown>).get('ca'))).toBe(0.3);
  });

  it('omits the /ExtGState at full opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', opacity: 1 });
    expect(decoded(doc.Pages[0])).not.toMatch(/\/GS\d+ gs/);
  });

  it('preserves existing page content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('stamps only the selected pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: 'DRAFT', pages: '2' });
    expect(decoded(doc.Pages[0])).not.toContain('(DRAFT)');
    expect(decoded(doc.Pages[1])).toContain('(DRAFT)');
    expect(decoded(doc.Pages[2])).not.toContain('(DRAFT)');
  });

  it('resolves tokens per page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: '{page}/{total}', position: 'center' });
    expect(decoded(doc.Pages[0])).toContain('(1/3)');
    expect(decoded(doc.Pages[2])).toContain('(3/3)');
  });

  it('resolves {label} from /PageLabels', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3, labels: true }));
    doc.AddWatermark({ text: '{label}', position: 'center' });
    expect(decoded(doc.Pages[1])).toContain('(ii)');
  });
});

describe('AddWatermark validation', () => {
  const open = () => Document.Open(buildDecorateTarget({ count: 2 }));

  it('throws TypeError when neither text nor image is given', () => {
    expect(() => open().AddWatermark({})).toThrow(TypeError);
  });

  it('throws TypeError when both text and image are given', () => {
    expect(() => open().AddWatermark({ text: 'a', image: new Uint8Array(1) }))
      .toThrow(TypeError);
  });

  it('throws TypeError on an unknown position', () => {
    expect(() => open().AddWatermark({ text: 'a', position: 'middle' as never }))
      .toThrow(TypeError);
  });

  it('throws TypeError on an out-of-band opacity', () => {
    expect(() => open().AddWatermark({ text: 'a', opacity: 2 })).toThrow(TypeError);
  });

  it('throws TypeError on {bates} outside Bates numbering', () => {
    expect(() => open().AddWatermark({ text: '{bates}' })).toThrow(TypeError);
  });

  it('throws RangeError on an out-of-range page selection', () => {
    expect(() => open().AddWatermark({ text: 'a', pages: '5' })).toThrow(RangeError);
  });

  it('leaves every page untouched when validation throws', () => {
    const doc = open();
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddWatermark({ text: 'a', pages: '1-5' })).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-watermark.test.ts`
Expected: FAIL — `doc.AddWatermark is not a function`.

- [ ] **Step 3: Add the splice parameter to `stampText`**

In `src/stamp.ts`, add the type just above `stampText` (after `normalizeOptions`'s helpers, before the `stampText` doc comment):

```ts
/** @internal How a stamp body is spliced into /Contents. Defaults to
 *  appendContent (draw on top); decorate.ts passes prependContent for an
 *  underlay watermark. */
export type ContentSplice = (doc: Document, page: Page, body: Uint8Array) => void;
```

Change the `stampText` signature from:

```ts
export function stampText(
  doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {},
): void {
```

to:

```ts
export function stampText(
  doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {},
  splice: ContentSplice = appendContent,
): void {
```

Then replace **both** occurrences of `appendContent(doc, page, tagged);` inside `stampText` (one on the shaped path at ~line 220, one on the simple path at ~line 233) with:

```ts
    splice(doc, page, tagged);
```

`Page.AddText` passes no splice and is unchanged. Leave `stampTextBlock` alone — nothing needs an underlay text block.

- [ ] **Step 4: Implement the watermark**

Extend the imports at the top of `src/decorate.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Matrix } from './text.js';
import { apply } from './text.js';
import { stampText, measureText, type AuthoringFont } from './stamp.js';
import { appendContent, prependContent } from './pagecontent.js';
import { resolvePages } from './pagerange.js';
```

Append to `src/decorate.ts`:

```ts
/** @internal The placement options every decoration shares, already defaulted. */
export interface Placement {
  position: StampPosition;
  margin: number;
  opacity: number;
  /** Explicit apparent angle in degrees CCW; undefined uses the preset's own. */
  rotate?: number;
  font: AuthoringFont;
  /** undefined means "derive it" (diagonal auto-fit, else the 24pt default). */
  fontSize?: number;
  color: [number, number, number];
  underlay: boolean;
}

/** @internal Validate a placement up front, before any page is touched, so a
 *  bad call cannot leave a half-decorated document. Returns `p` unchanged. */
export function normalizePlacement(p: Placement): Placement {
  if (!POSITIONS.includes(p.position))
    throw new TypeError(`position must be one of ${POSITIONS.join(', ')}`);
  if (!Number.isFinite(p.margin) || p.margin < 0)
    throw new TypeError('margin must be a non-negative finite number');
  if (!Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 1)
    throw new TypeError('opacity must be in 0..1');
  if (p.rotate !== undefined && !Number.isFinite(p.rotate))
    throw new TypeError('rotate must be a finite number');
  if (p.fontSize !== undefined && (!Number.isFinite(p.fontSize) || p.fontSize <= 0))
    throw new TypeError('fontSize must be a positive finite number');
  if (!Array.isArray(p.color) || p.color.length !== 3 ||
      !p.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  return p;
}

/** Fallback size for a non-diagonal text watermark. */
const DEFAULT_WATERMARK_SIZE = 24;

/** @internal The font size for one text stamp: an explicit size wins; a
 *  diagonal watermark auto-fits to ~80% of the page diagonal (width is linear
 *  in size, so one unit measurement gives the scale). */
function fontSizeFor(text: string, p: Placement, f: VisualFrame): number {
  if (p.fontSize !== undefined) return p.fontSize;
  if (p.position !== 'diagonal') return DEFAULT_WATERMARK_SIZE;
  const unit = measureText(text, 1, p.font);
  if (!(unit > 0)) return DEFAULT_WATERMARK_SIZE; // unmeasurable: don't divide by 0
  return (0.8 * Math.hypot(f.VW, f.VH)) / unit;
}

/** @internal Draw one text stamp on `page` at the placement's preset position.
 *  stampText works in user space and bypasses the frame matrix, so the anchor is
 *  mapped through M by hand and the page's /Rotate is *added* to the angle —
 *  that is the counter-rotation that cancels the viewer's clockwise turn. (The
 *  image path in Task 7 composes with M instead and must not add R.) */
export function drawText(doc: Document, page: Page, text: string, p: Placement): void {
  const f = visualFrame(page);
  const fontSize = fontSizeFor(text, p, f);
  const a = textAnchor(p.position, f, p.margin, fontSize);
  const [x, y] = apply(f.M, a.vx, a.vy);
  stampText(doc, page, text, x, y, {
    font: p.font,
    fontSize,
    color: p.color,
    opacity: p.opacity,
    rotate: (p.rotate ?? a.angle) + f.R,
    align: a.align,
  }, p.underlay ? prependContent : appendContent);
}

/** @internal Token values for page `n`. `needsLabel` gates the /PageLabels
 *  lookup, which re-parses the number tree per call. */
export function tokenValuesFor(
  doc: Document, n: number, total: number,
  now: { date: string; time: string }, needsLabel: boolean,
): Record<string, string> {
  return {
    page: String(n),
    total: String(total),
    label: needsLabel ? doc.PageLabelFor(n - 1) : '',
    date: now.date,
    time: now.time,
  };
}

/** @internal True when `template` actually uses `{label}`. */
export function usesLabel(template: string): boolean {
  return /\{label\}/.test(template);
}

/** Options for {@link Document.AddWatermark}. Provide exactly one of `text` or
 *  `image`. */
export interface WatermarkOptions {
  /** Watermark text; may contain tokens ({page}, {total}, {label}, {date}, {time}). */
  text?: string;
  /** Watermark image as encoded JPEG or PNG bytes. */
  image?: Uint8Array;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** Positioning preset. Default 'diagonal'. */
  position?: StampPosition;
  /** Constant opacity 0..1. Default 0.3. */
  opacity?: number;
  /** Apparent rotation in degrees CCW; default = the preset's own angle. */
  rotate?: number;
  /** 'underlay' draws behind existing content, 'overlay' on top. Default 'underlay'. */
  mode?: 'overlay' | 'underlay';
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default: auto-fit for 'diagonal', else 24. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0.5, 0.5, 0.5]. */
  color?: [number, number, number];
  /** Inset in points for corner/edge presets. Default 36. */
  margin?: number;
  /** Image width in points; default depends on the preset. Ignored for text. */
  width?: number;
}

/** @internal Implementation of {@link Document.AddWatermark}. */
export function addWatermark(doc: Document, opts: WatermarkOptions): void {
  const hasText = typeof opts.text === 'string';
  const hasImage = opts.image !== undefined;
  if (hasText === hasImage)
    throw new TypeError('AddWatermark: provide exactly one of text or image');

  const p = normalizePlacement({
    position: opts.position ?? 'diagonal',
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 0.3,
    rotate: opts.rotate,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize,
    color: opts.color ?? [0.5, 0.5, 0.5],
    underlay: (opts.mode ?? 'underlay') === 'underlay',
  });

  // Everything that can throw runs before the first mutation.
  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const template = opts.text ?? '';
  if (hasText) validateTemplate(template, false);

  const now = stampedNow();
  const needsLabel = usesLabel(template);
  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    drawText(doc, pagesArr[n - 1], resolveTemplate(template, values), p);
  }
}
```

Note: the image branch lands in Task 7; for now `hasImage` only participates in the exactly-one check, and `addWatermark` falls through to the text loop with an empty template. That is why Task 7's test suite is the one that exercises `opts.image` end to end.

- [ ] **Step 5: Add the Document method**

In `src/document.ts`, add to the import block:

```ts
import { addWatermark, type WatermarkOptions } from './decorate.js';
```

Add this method immediately after `Overlay` (~line 1668):

```ts
  /** Stamp a repeating text or image watermark across a page range. Provide
   *  exactly one of `text` or `image`. Text may carry `{page}`/`{total}`/
   *  `{label}`/`{date}`/`{time}` tokens, resolved per page. Positioning presets
   *  anchor to the page as displayed, so a stamp lands correctly (and upright)
   *  regardless of /Rotate. Defaults to a 30%-opacity diagonal underlay. */
  AddWatermark(opts: WatermarkOptions): void {
    addWatermark(this, opts);
  }
```

- [ ] **Step 6: Export the public types**

In `src/index.ts`, add after the `compose.js` export line:

```ts
export type { StampPosition, WatermarkOptions } from './decorate.js';
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/decorate-watermark.test.ts && npm run typecheck`
Expected: PASS (23 tests), typecheck clean.

- [ ] **Step 8: Run the full suite (the `stampText` signature change touches shared code)**

Run: `npm test`
Expected: PASS — no regressions in `test/stamp.test.ts`, `test/stamp-fonts.test.ts`, or the compose suites.

- [ ] **Step 9: Commit**

```bash
git add src/stamp.ts src/decorate.ts src/document.ts src/index.ts test/decorate-watermark.test.ts
git commit -m "feat(h8s): Document.AddWatermark with rotation-aware presets"
```

---

### Task 5: `AddHeaderFooter`

**Files:**
- Modify: `src/decorate.ts` (append)
- Modify: `src/document.ts` (import + method after `AddWatermark`)
- Modify: `src/index.ts`
- Test: `test/decorate-headerfooter.test.ts`

**Interfaces:**
- Consumes: `Placement` / `normalizePlacement` / `drawText` / `tokenValuesFor` / `usesLabel` (Task 4); `validateTemplate` / `resolveTemplate` / `stampedNow` (Task 2); `resolvePages` (Task 1).
- Produces: `interface HeaderFooterOptions`, `addHeaderFooter(doc: Document, opts: HeaderFooterOptions): void`, `Document.AddHeaderFooter(opts: HeaderFooterOptions): void`.

- [ ] **Step 1: Write the failing test**

Create `test/decorate-headerfooter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddHeaderFooter', () => {
  it('stamps a footer slot with tokens resolved', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddHeaderFooter({ footer: { center: 'Page {page} of {total}' } });
    expect(decoded(doc.Pages[0])).toContain('(Page 1 of 3)');
    expect(decoded(doc.Pages[2])).toContain('(Page 3 of 3)');
  });

  it('stamps all six slots', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({
      header: { left: 'HL', center: 'HC', right: 'HR' },
      footer: { left: 'FL', center: 'FC', right: 'FR' },
    });
    const s = decoded(doc.Pages[0]);
    for (const t of ['(HL)', '(HC)', '(HR)', '(FL)', '(FC)', '(FR)']) {
      expect(s).toContain(t);
    }
  });

  it('places the header band above the footer band', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ header: { left: 'H' }, footer: { left: 'F' } });
    const page = doc.Pages[0];
    const frags = page.GetTextFragments();
    const h = frags.find((f) => f.text === 'H')!;
    const f = frags.find((f) => f.text === 'F')!;
    expect(h.quad[1]).toBeGreaterThan(f.quad[1]);
  });

  it('drops a top slot by the margin plus the font size', () => {
    // 200x100 page, margin 36, fontSize 10 -> baseline at 100 - 36 - 10 = 54.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ header: { left: 'H' } });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 36 54 Tm');
  });

  it('honors a custom margin', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' }, margin: 10 });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 10 10 Tm');
  });

  it('defaults to 10pt', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(decoded(doc.Pages[0])).toMatch(/\/F\d+ 10 Tf/);
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(decoded(doc.Pages[0])).toContain('0 1 -1 0 164 36 Tm');
  });

  it('draws as an overlay, after existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(F)')).toBeGreaterThan(s.indexOf('(P1)'));
  });

  it('stamps only the selected pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddHeaderFooter({ footer: { left: 'F' }, pages: '2-3' });
    expect(decoded(doc.Pages[0])).not.toContain('(F)');
    expect(decoded(doc.Pages[1])).toContain('(F)');
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('is a no-op with no slots', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    doc.AddHeaderFooter({});
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('skips empty slot strings', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    doc.AddHeaderFooter({ footer: { left: '' } });
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('throws TypeError on an unknown token in any slot', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddHeaderFooter({ footer: { right: '{pages}' } })).toThrow(TypeError);
  });

  it('throws TypeError on {bates}', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddHeaderFooter({ footer: { left: '{bates}' } })).toThrow(TypeError);
  });

  it('leaves pages untouched when a later slot fails validation', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddHeaderFooter({ footer: { left: 'ok', right: '{nope}' } }))
      .toThrow(TypeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-headerfooter.test.ts`
Expected: FAIL — `doc.AddHeaderFooter is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/decorate.ts`:

```ts
/** One band of a header/footer: up to three independently-positioned cells. */
export interface HeaderFooterBand {
  left?: string;
  center?: string;
  right?: string;
}

/** Options for {@link Document.AddHeaderFooter}. */
export interface HeaderFooterOptions {
  /** Top band cells; text may contain tokens. */
  header?: HeaderFooterBand;
  /** Bottom band cells; text may contain tokens. */
  footer?: HeaderFooterBand;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** Inset in points from the page edges. Default 36. */
  margin?: number;
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default 10. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Constant opacity 0..1. Default 1. */
  opacity?: number;
}

/** @internal Implementation of {@link Document.AddHeaderFooter}. */
export function addHeaderFooter(doc: Document, opts: HeaderFooterOptions): void {
  const slots: Array<{ text: string; position: StampPosition }> = [];
  const bands = [['header', 'top'], ['footer', 'bottom']] as const;
  for (const [key, band] of bands) {
    const cells = opts[key];
    if (cells === undefined) continue;
    for (const side of ['left', 'center', 'right'] as const) {
      const text = cells[side];
      if (typeof text !== 'string' || text === '') continue;
      slots.push({ text, position: `${band}-${side}` as StampPosition });
    }
  }
  if (slots.length === 0) return;

  // Validate every slot before drawing any of them, so a typo in the last slot
  // cannot leave the first already stamped.
  for (const s of slots) validateTemplate(s.text, false);

  const base = normalizePlacement({
    position: slots[0].position, // per-slot below; validated once here
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 1,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize ?? 10,
    color: opts.color ?? [0, 0, 0],
    underlay: false,
  });

  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const now = stampedNow();
  const needsLabel = slots.some((s) => usesLabel(s.text));

  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    for (const s of slots) {
      drawText(doc, pagesArr[n - 1], resolveTemplate(s.text, values),
        { ...base, position: s.position });
    }
  }
}
```

- [ ] **Step 4: Add the Document method**

In `src/document.ts`, extend the decorate import:

```ts
import {
  addWatermark, addHeaderFooter,
  type WatermarkOptions, type HeaderFooterOptions,
} from './decorate.js';
```

Add after `AddWatermark`:

```ts
  /** Stamp header and/or footer text across a page range. Each band has up to
   *  three cells (`left`/`center`/`right`), and each cell may carry
   *  `{page}`/`{total}`/`{label}`/`{date}`/`{time}` tokens, resolved per page —
   *  e.g. `{ footer: { center: 'Page {page} of {total}' } }`. Cells anchor to the
   *  page as displayed, so they stay upright regardless of /Rotate. */
  AddHeaderFooter(opts: HeaderFooterOptions): void {
    addHeaderFooter(this, opts);
  }
```

- [ ] **Step 5: Export the public types**

In `src/index.ts`, extend the decorate export:

```ts
export type {
  StampPosition, WatermarkOptions, HeaderFooterOptions, HeaderFooterBand,
} from './decorate.js';
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/decorate-headerfooter.test.ts && npm run typecheck`
Expected: PASS (15 tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/decorate.ts src/document.ts src/index.ts test/decorate-headerfooter.test.ts
git commit -m "feat(h8s): Document.AddHeaderFooter"
```

---

### Task 6: `AddBatesNumbering`

**Files:**
- Modify: `src/decorate.ts` (append)
- Modify: `src/document.ts` (import + method after `AddHeaderFooter`)
- Modify: `src/index.ts`
- Test: `test/decorate-bates.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 4.
- Produces: `interface BatesOptions`, `addBatesNumbering(doc: Document, opts?: BatesOptions): number`, `Document.AddBatesNumbering(opts?: BatesOptions): number`.

- [ ] **Step 1: Write the failing test**

Create `test/decorate-bates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddBatesNumbering', () => {
  it('zero-pads to six digits from 1 with no options', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddBatesNumbering();
    expect(decoded(doc.Pages[0])).toContain('(000001)');
    expect(decoded(doc.Pages[2])).toContain('(000003)');
  });

  it('honors start, step, and digits', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddBatesNumbering({ start: 10, step: 5, digits: 3 });
    expect(decoded(doc.Pages[0])).toContain('(010)');
    expect(decoded(doc.Pages[1])).toContain('(015)');
    expect(decoded(doc.Pages[2])).toContain('(020)');
  });

  it('applies prefix and suffix', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering({ prefix: 'ACME-', suffix: '-X', digits: 4 });
    expect(decoded(doc.Pages[0])).toContain('(ACME-0001-X)');
  });

  it('widens past the digit width instead of throwing', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddBatesNumbering({ start: 999, digits: 3 });
    expect(decoded(doc.Pages[0])).toContain('(999)');
    expect(decoded(doc.Pages[1])).toContain('(1000)');
  });

  it('counts stamped pages, not document pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 5 }));
    doc.AddBatesNumbering({ pages: '3-5', digits: 3 });
    expect(decoded(doc.Pages[0])).not.toContain('(001)');
    expect(decoded(doc.Pages[2])).toContain('(001)');
    expect(decoded(doc.Pages[3])).toContain('(002)');
    expect(decoded(doc.Pages[4])).toContain('(003)');
  });

  it('returns the next unused number', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    expect(doc.AddBatesNumbering()).toBe(4);
  });

  it('returns the next unused number with a step', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    expect(doc.AddBatesNumbering({ start: 10, step: 5 })).toBe(25);
  });

  it('chains across documents', () => {
    const docs = [
      Document.Open(buildDecorateTarget({ count: 2 })),
      Document.Open(buildDecorateTarget({ count: 2 })),
    ];
    let n = 1;
    for (const d of docs) n = d.AddBatesNumbering({ start: n, digits: 3 });
    expect(decoded(docs[0].Pages[0])).toContain('(001)');
    expect(decoded(docs[1].Pages[0])).toContain('(003)');
    expect(decoded(docs[1].Pages[1])).toContain('(004)');
    expect(n).toBe(5);
  });

  it('embeds the counter in a custom template', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddBatesNumbering({ text: '{bates} / page {page}', digits: 2 });
    expect(decoded(doc.Pages[1])).toContain('(02 / page 2)');
  });

  it('defaults to the bottom-right corner at 10pt', () => {
    // 200x100 page, margin 36, align right -> anchor vx = 164, vy = 36.
    // Helvetica '000001' at 10pt is 6 * 5.56 = 33.36 wide, so tx = 164 - 33.36.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering();
    const s = decoded(doc.Pages[0]);
    expect(s).toMatch(/\/F\d+ 10 Tf/);
    expect(s).toContain('1 0 0 1 130.64 36 Tm');
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddBatesNumbering({ position: 'bottom-left' });
    expect(decoded(doc.Pages[0])).toContain('0 1 -1 0 164 36 Tm');
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering();
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('throws TypeError on a non-integer start', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ start: 1.5 })).toThrow(TypeError);
  });

  it('throws TypeError on a negative start', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ start: -1 })).toThrow(TypeError);
  });

  it('throws TypeError on a zero step', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ step: 0 })).toThrow(TypeError);
  });

  it('throws TypeError on zero digits', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ digits: 0 })).toThrow(TypeError);
  });

  it('throws TypeError on an unknown token', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ text: '{nope}' })).toThrow(TypeError);
  });

  it('leaves pages untouched when validation throws', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddBatesNumbering({ pages: '1-9' })).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-bates.test.ts`
Expected: FAIL — `doc.AddBatesNumbering is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/decorate.ts`:

```ts
/** Options for {@link Document.AddBatesNumbering}. */
export interface BatesOptions {
  /** Template; `{bates}` is the counter. Default '{bates}'. */
  text?: string;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** First number. Default 1. */
  start?: number;
  /** Increment per stamped page. Default 1. */
  step?: number;
  /** Minimum zero-padded width; a longer number simply widens. Default 6. */
  digits?: number;
  /** Text before the number. Default ''. */
  prefix?: string;
  /** Text after the number. Default ''. */
  suffix?: string;
  /** Positioning preset. Default 'bottom-right'. */
  position?: StampPosition;
  /** Inset in points from the page edges. Default 36. */
  margin?: number;
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default 10. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Constant opacity 0..1. Default 1. */
  opacity?: number;
}

/** @internal Implementation of {@link Document.AddBatesNumbering}. Returns the
 *  next unused number so a sequence chains across a document set. */
export function addBatesNumbering(doc: Document, opts: BatesOptions = {}): number {
  const text = opts.text ?? '{bates}';
  validateTemplate(text, true);

  const start = opts.start ?? 1;
  const step = opts.step ?? 1;
  const digits = opts.digits ?? 6;
  if (!Number.isInteger(start) || start < 0)
    throw new TypeError('AddBatesNumbering: start must be a non-negative integer');
  if (!Number.isInteger(step) || step < 1)
    throw new TypeError('AddBatesNumbering: step must be a positive integer');
  if (!Number.isInteger(digits) || digits < 1)
    throw new TypeError('AddBatesNumbering: digits must be a positive integer');
  const prefix = opts.prefix ?? '';
  const suffix = opts.suffix ?? '';

  const p = normalizePlacement({
    position: opts.position ?? 'bottom-right',
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 1,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize ?? 10,
    color: opts.color ?? [0, 0, 0],
    underlay: false,
  });

  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const now = stampedNow();
  const needsLabel = usesLabel(text);

  // The counter follows the selection, not the page number: stamping a subset
  // must not leave gaps in a legal-numbering sequence.
  selected.forEach((n, i) => {
    const counter = start + step * i;
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    // `digits` is a minimum width (padStart semantics), so overflow widens.
    values.bates = prefix + String(counter).padStart(digits, '0') + suffix;
    drawText(doc, pagesArr[n - 1], resolveTemplate(text, values), p);
  });

  return start + step * selected.length;
}
```

- [ ] **Step 4: Add the Document method**

In `src/document.ts`, extend the decorate import:

```ts
import {
  addWatermark, addHeaderFooter, addBatesNumbering,
  type WatermarkOptions, type HeaderFooterOptions, type BatesOptions,
} from './decorate.js';
```

Add after `AddHeaderFooter`:

```ts
  /** Stamp a Bates sequence across a page range (bottom-right, `{bates}`, 10pt
   *  by default). The counter follows the selection, not the page number, so a
   *  subset numbers contiguously from `start`. `digits` is a minimum width: a
   *  number that outgrows it simply widens. Returns the next unused number, so a
   *  sequence chains across a document set:
   *  `let n = 1; for (const d of docs) n = d.AddBatesNumbering({ start: n });` */
  AddBatesNumbering(opts: BatesOptions = {}): number {
    return addBatesNumbering(this, opts);
  }
```

- [ ] **Step 5: Export the public type**

In `src/index.ts`, extend the decorate export:

```ts
export type {
  StampPosition, WatermarkOptions, HeaderFooterOptions, HeaderFooterBand, BatesOptions,
} from './decorate.js';
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/decorate-bates.test.ts && npm run typecheck`
Expected: PASS (18 tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/decorate.ts src/document.ts src/index.ts test/decorate-bates.test.ts
git commit -m "feat(h8s): Document.AddBatesNumbering"
```

---

### Task 7: Image watermark with a shared XObject

The image branch of `AddWatermark`. `addImage` builds a fresh Image XObject per call, so a naive loop would embed one copy of the JPEG per page; this builds once and registers the single ref on every selected page.

**Files:**
- Modify: `src/decorate.ts` (append + wire the image branch into `addWatermark`)
- Test: `test/decorate-image.test.ts`

**Interfaces:**
- Consumes: `Placement` / `normalizePlacement` (Task 4); `imageAnchor` / `visualFrame` / `VisualFrame` (Task 3); `buildImageXObject` (src/imageembed.ts); `mul` (src/text.ts).
- Produces: `drawImageOnPages(doc, pages, data, p, width?): void`.

- [ ] **Step 1: Write the failing test**

Create `test/decorate-image.test.ts`. `buildPngRgb()` from the existing helper is a 2x2 RGB PNG.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isStream, isRef } from '../src/types.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb, buildPngRgba } from './helpers/build-embed-images.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

/** Image XObject refs registered on a page's /Resources /XObject. */
function imageRefs(doc: Document, page: import('../src/page.js').Page): number[] {
  const xo = doc.resolve(page.Resources!.get('XObject')) as Map<string, unknown>;
  const out: number[] = [];
  for (const v of xo.values()) if (isRef(v)) out.push(v.num);
  return out;
}

describe('AddWatermark with an image', () => {
  it('embeds one shared XObject across every stamped page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 10 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const first = imageRefs(doc, doc.Pages[0]);
    expect(first).toHaveLength(1);
    // Every page points at the same object number: built once, placed ten times.
    for (let i = 1; i < 10; i++) expect(imageRefs(doc, doc.Pages[i])).toEqual(first);
  });

  it('draws the image on each selected page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ image: buildPngRgb(), pages: '1,3' });
    expect(decoded(doc.Pages[0])).toMatch(/\/Im\d+ Do/);
    expect(decoded(doc.Pages[1])).not.toMatch(/\/Im\d+ Do/);
    expect(decoded(doc.Pages[2])).toMatch(/\/Im\d+ Do/);
  });

  it('wires an /SMask for an alpha PNG, shared too', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgba() });
    const [num] = imageRefs(doc, doc.Pages[0]);
    const img = doc.getObject(num);
    expect(isStream(img)).toBe(true);
    expect(isRef((img as { dict: Map<string, unknown> }).dict.get('SMask'))).toBe(true);
  });

  it('preserves the image aspect ratio', () => {
    // buildPngRgb() is 2x2, so height must equal width.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left', width: 40 });
    // cm = [40 0 0 40 36 36] on an unrotated page: square image, no rotation.
    expect(decoded(doc.Pages[0])).toContain('40 0 0 40 36 36 cm');
  });

  it('defaults a corner image to a quarter of the visual width', () => {
    // 200x100 page -> width 50, square image -> height 50, bottom-left at margin.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left' });
    expect(decoded(doc.Pages[0])).toContain('50 0 0 50 36 36 cm');
  });

  it('anchors a top-right image by its own top-right corner', () => {
    // width 50, anchor (164, 64) with fx=1, fy=1 -> origin (114, 14).
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'top-right' });
    expect(decoded(doc.Pages[0])).toContain('50 0 0 50 114 14 cm');
  });

  it('maps through the frame matrix on a /Rotate 180 page', () => {
    // Visual bottom-left (36, 36) with M = [-1 0 0 -1 200 100]: the image is
    // laid out in the visual frame and mapped, so it is flipped in user space
    // and lands at the unrotated top-right.
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 180 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left', width: 40 });
    expect(decoded(doc.Pages[0])).toContain('-40 0 0 -40 164 64 cm');
  });

  it('defaults to an underlay at 0.3 opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const s = decoded(doc.Pages[0]);
    expect(s).toMatch(/\/GS\d+ gs/);
    expect(s.indexOf('Do')).toBeLessThan(s.indexOf('(P1)'));
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb() });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('throws UnsupportedFeatureError for a non-image payload', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddWatermark({ image: new Uint8Array([1, 2, 3, 4]) }))
      .toThrow(/unrecognized image format/);
  });

  it('ignores fontSize for an image stamp', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddWatermark({ image: buildPngRgb(), fontSize: 12 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-image.test.ts`
Expected: FAIL — no `/Im0 Do` in the content (Task 4's `addWatermark` ignores `opts.image`).

- [ ] **Step 3: Write minimal implementation**

Extend the `src/decorate.ts` imports:

```ts
import { apply, mul } from './text.js';
import { buildImageXObject } from './imageembed.js';
import {
  appendContent, prependContent, ensureOwnResources, ensureOwnSubdict,
  freshKey, registerExtGState, num,
} from './pagecontent.js';
import { enc } from './serialize.js';
import { isStream, type PdfRef } from './types.js';
```

Append to `src/decorate.ts`:

```ts
/** @internal Default drawn width for an image stamp, per preset. */
function imageWidthFor(position: StampPosition, f: VisualFrame): number {
  if (position === 'diagonal') return 0.8 * Math.hypot(f.VW, f.VH);
  if (position === 'center') return 0.5 * f.VW;
  return 0.25 * f.VW;
}

/** @internal Place the already-embedded image `imgRef` (intrinsic `iw` x `ih`
 *  pixels) on `page`. Unlike the text path, the image is laid out in the visual
 *  frame and composed with M, which already carries the /Rotate turn — so the
 *  local angle is the apparent angle and R is NOT added. */
function drawImage(
  doc: Document, page: Page, imgRef: PdfRef, iw: number, ih: number,
  p: Placement, width: number | undefined,
): void {
  const f = visualFrame(page);
  const a = imageAnchor(p.position, f, p.margin);
  const w = width ?? imageWidthFor(p.position, f);
  const h = w * (ih / iw); // never scaled anisotropically
  const rad = ((p.rotate ?? a.angle) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  // unit square -> w x h -> anchor fraction to the origin -> rotate -> move to
  // the anchor -> visual frame to user space. mul(m, n) applies m then n.
  const scale: Matrix = [w, 0, 0, h, 0, 0];
  const toAnchor: Matrix = [1, 0, 0, 1, -a.fx * w, -a.fy * h];
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
  const move: Matrix = [1, 0, 0, 1, a.vx, a.vy];
  const cm = mul(mul(mul(mul(scale, toAnchor), rot), move), f.M);

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, imgRef);

  const gsKey = p.opacity < 1 ? registerExtGState(doc, page, p.opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${cm.map(num).join(' ')} cm\n/${key} Do\nQ`;
  const body = enc(s);
  if (p.underlay) prependContent(doc, page, body);
  else appendContent(doc, page, body);
}

/** @internal Embed `data` ONCE and place the single shared Image XObject on each
 *  page. Building per page would put one copy of the JPEG in the file per page. */
export function drawImageOnPages(
  doc: Document, pages: Page[], data: Uint8Array, p: Placement, width?: number,
): void {
  const built = buildImageXObject(data);
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const imgRef = doc.allocObject(built.stream);
  const img = doc.resolve(imgRef);
  if (!isStream(img)) return; // unreachable: buildImageXObject always yields a stream
  const iw = img.dict.get('Width') as number;
  const ih = img.dict.get('Height') as number;
  for (const page of pages) drawImage(doc, page, imgRef, iw, ih, p, width);
}
```

- [ ] **Step 4: Wire the image branch into `addWatermark`**

In `src/decorate.ts`, replace the drawing loop at the end of `addWatermark`:

```ts
  const now = stampedNow();
  const needsLabel = usesLabel(template);
  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    drawText(doc, pagesArr[n - 1], resolveTemplate(template, values), p);
  }
```

with:

```ts
  if (hasImage) {
    drawImageOnPages(doc, selected.map((n) => pagesArr[n - 1]), opts.image!, p, opts.width);
    return;
  }

  const now = stampedNow();
  const needsLabel = usesLabel(template);
  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    drawText(doc, pagesArr[n - 1], resolveTemplate(template, values), p);
  }
```

Also add `width` validation to `addWatermark`, just after the `normalizePlacement` call:

```ts
  if (opts.width !== undefined && (!Number.isFinite(opts.width) || opts.width <= 0))
    throw new TypeError('width must be a positive finite number');
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/decorate-image.test.ts && npm run typecheck`
Expected: PASS (11 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/decorate.ts test/decorate-image.test.ts
git commit -m "feat(h8s): image watermark with a shared Image XObject"
```

---

### Task 8: Acceptance round-trip, README, and issue close

Proves the acceptance criteria end to end and syncs the docs.

**Files:**
- Modify: `README.md`
- Test: `test/decorate-roundtrip.test.ts`

**Interfaces:**
- Consumes: all three public methods.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/decorate-roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

describe('decoration round-trips', () => {
  it('survives Save and Open with all three decorations applied', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: 'DRAFT' });
    doc.AddHeaderFooter({ footer: { center: 'Page {page} of {total}' } });
    doc.AddBatesNumbering({ prefix: 'ACME-', digits: 4 });

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages).toHaveLength(3);
    const text = reopened.Pages[1].GetText();
    expect(text).toContain('P2');            // original content survived
    expect(text).toContain('DRAFT');
    expect(text).toContain('Page 2 of 3');
    expect(text).toContain('ACME-0002');
  });

  it('round-trips through a compressed save', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ text: 'CONFIDENTIAL', position: 'center' });
    const reopened = Document.Open(doc.Save({ compressed: true }));
    expect(reopened.Pages[0].GetText()).toContain('CONFIDENTIAL');
  });

  it('round-trips an image watermark', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Images).toHaveLength(1);
    expect(reopened.Pages[0].GetText()).toContain('P1');
  });

  it('renders each decorated page to PNG without throwing', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddWatermark({ text: 'DRAFT' });
    doc.AddBatesNumbering();
    const png = Document.Open(doc.Save()).Pages[0].ToImage({ scale: 1 });
    expect(png.length).toBeGreaterThan(0);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('leaves an undecorated page byte-identical after a decoration of others', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    const before = new TextDecoder('latin1').decode(doc.Pages[1].Contents);
    doc.AddWatermark({ text: 'DRAFT', pages: '1' });
    expect(new TextDecoder('latin1').decode(doc.Pages[1].Contents)).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/decorate-roundtrip.test.ts`
Expected: PASS (5 tests). Unlike earlier tasks this is a pure integration check over already-built code, so it should pass immediately. **If it fails, that is a real defect** in Tasks 4–7 — fix the source, not the test.

- [ ] **Step 3: Update the README**

In `README.md`, add to the Features list (next to the existing composition/stamping entries):

```markdown
- **Page decoration** — watermarks (text or image, diagonal/corner presets,
  opacity), headers and footers with `{page}`/`{total}` tokens, and Bates
  numbering across a page range.
```

In the API overview, add next to the other `Document` methods:

```markdown
| `doc.AddWatermark(opts)` | Stamp a text or image watermark across a page range. |
| `doc.AddHeaderFooter(opts)` | Stamp header/footer cells with `{page}`/`{total}` tokens. |
| `doc.AddBatesNumbering(opts?)` | Stamp a Bates sequence; returns the next unused number. |
```

Match the surrounding table/list formatting exactly — read the neighbouring rows first and follow whatever shape they use.

- [ ] **Step 4: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: both green, no regressions anywhere.

- [ ] **Step 5: Commit**

```bash
git add README.md test/decorate-roundtrip.test.ts
git commit -m "feat(h8s): decoration round-trip tests and README"
```

- [ ] **Step 6: Record the knowledge and close the issue**

```bash
bd remember --key page-decoration-shipped "page-decoration-shipped: src/decorate.ts + src/pagerange.ts shipped (issue h8s). doc.AddWatermark/AddHeaderFooter/AddBatesNumbering over stampText + buildImageXObject; no new rendering primitives. pagerange.ts resolvePages(spec,total) parses '1-5,8,12-' (TypeError malformed / RangeError out of range), normalizes ascending+deduped; Overlay could adopt it. Tokens {page}{total}{label}{bates}{date}{time}, '{{'->'{', unknown throws TypeError; all validation eager so a throwing call mutates nothing. Geometry: visualFrame(page) maps visual->user per CropBox+/Rotate; text adds R to stampText's rotate (bypasses M), images compose with M and must NOT add R. Bates counts stamped pages not page numbers, digits is a MINIMUM width (overflow widens), returns next unused number for cross-document chaining. Image watermark builds the XObject once and shares the ref across pages. stampText gained an optional trailing ContentSplice param (default appendContent) so watermarks can underlay."
bd close aspose-pdf-foss-for-ts-h8s
```

- [ ] **Step 7: Push (mandatory — work is not complete until this succeeds)**

```bash
git pull --rebase
git push -u origin feat/page-decoration
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

**The rotation sign is the likeliest bug in this whole feature.** `rotate = presetAngle + R` reconciles two opposing conventions: `/Rotate` turns the page clockwise as displayed, while `stampText`'s `rotate` is counter-clockwise in user space. Task 4's four `Tm` assertions pin it exactly — if you find yourself editing those expected matrices to make a test pass, stop and re-derive instead. They were computed by hand from the spec's matrix table:

| /Rotate | M | visual (36,36) → user | stamp rotate | emitted Tm |
|---|---|---|---|---|
| 0 | `[1,0,0,1,0,0]` | (36, 36) | 0 | `1 0 0 1 36 36` |
| 90 | `[0,1,-1,0,200,0]` | (164, 36) | 90 | `0 1 -1 0 164 36` |
| 180 | `[-1,0,0,-1,200,100]` | (164, 64) | 180 | `-1 0 0 -1 164 64` |
| 270 | `[0,-1,1,0,0,100]` | (36, 64) | 270 | `0 -1 1 0 36 64` |

(200x100 page, `bottom-left`, margin 36. `align: 'left'` zeroes the width term in `tx`/`ty`, so the matrix depends only on the rotation. `num()` rounds the ~1e-16 cosines to `0`.)

**Text and images deliberately differ.** Text bypasses the frame matrix (`stampText` takes user-space coordinates), so it maps the anchor by hand and adds `R`. Images compose `cm` with `M`, which already carries the rotation, so they must not add `R`. Adding `R` in both places double-rotates the image; adding it in neither leaves text sideways.

**Do not "fix" `stampTextBlock`.** Only `stampText` gains the splice parameter. Nothing here needs an underlay text block, and widening the change surface risks the existing block-layout tests.
