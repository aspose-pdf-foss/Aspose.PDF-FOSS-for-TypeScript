# Content Authoring (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a buffered `PageGraphics` vector-drawing API and `page.AddImage` (JPEG + PNG embedding) to the library, reusing the existing content-mutation machinery.

**Architecture:** First extract the page-content helpers shared by stamping into a new `pagecontent.ts` module. Then build `PageGraphics` (a fluent builder that buffers content operators and splices them on `apply()`) and an `addImage` pipeline (sniff format → build an Image XObject → register in `/Resources` → paint with `cm`/`Do`). Both reuse `appendContent`, `registerExtGState`, and `ensureOwn*` from `pagecontent.ts`. The serializer needs no changes — `Save()` mark-sweeps from `/Root` and picks up newly allocated objects.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import specifiers), vitest, `node:zlib` (`deflateSync`/`inflateSync`). Zero npm runtime dependencies.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins (`zlib`, `crypto`, `fs`). Do NOT add npm runtime deps.
- ESM + NodeNext, strict TypeScript; every relative import specifier carries a `.js` extension.
- Live-mutation model: edits act on the live objects map; never mutate inputs during serialization.
- Public error types only: throw `PdfParseError`, `UnsupportedFeatureError`, or `InvalidPasswordError` (from `errors.ts`).
- Number formatting in content streams goes through the shared `num()` helper (rounds to 1e-6, normalizes `-0`).
- Run `npm run typecheck` and `npm test` before considering any task done; both must be green.
- Keep `README.md` in sync when public API changes.

---

### Task 1: Extract shared content-authoring helpers into `pagecontent.ts`

Behaviour-preserving refactor: move the page-content-mutation helpers out of `stamp.ts` so `graphics.ts` and `imageembed.ts` can reuse them. The existing stamp tests are the regression guard — no new test is needed.

**Files:**
- Create: `src/pagecontent.ts`
- Modify: `src/stamp.ts`
- Test (regression only): `test/stamp.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: `Document.resolve`, `Document.allocObject` (existing); `enc` from `serialize.ts`; types from `types.ts`.
- Produces (exported from `src/pagecontent.ts`):
  - `num(n: number): string`
  - `streamOf(bytes: Uint8Array): PdfStream`
  - `freshKey(d: PdfDict, prefix: string): string`
  - `ensureOwnResources(doc: Document, page: Page): PdfDict`
  - `ensureOwnSubdict(doc: Document, resources: PdfDict, key: string): PdfDict`
  - `registerExtGState(doc: Document, page: Page, opacity: number): string`
  - `appendContent(doc: Document, page: Page, body: Uint8Array): void`

- [ ] **Step 1: Create `src/pagecontent.ts` with the moved helpers**

Copy these helpers verbatim out of `src/stamp.ts` into the new file (they currently live there). `normalizeContents` and `concat` are internal to `appendContent` and stay private in this module.

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfObject, PdfDict, PdfRef, PdfStream,
  isDict, isArray, isStream, isRef, name,
} from './types.js';
import { enc } from './serialize.js';

/** Format a number compactly for a content stream (no exponent, no float noise). */
export function num(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

export function streamOf(bytes: Uint8Array): PdfStream {
  return { kind: 'stream', dict: new Map(), raw: bytes };
}

export function freshKey(d: PdfDict, prefix: string): string {
  for (let i = 0; ; i++) {
    const k = `${prefix}${i}`;
    if (!d.has(k)) return k;
  }
}

/** The page's own /Resources, shallow-copying an inherited one onto the page so
 *  we never shadow it (which would hide fonts the existing content depends on). */
export function ensureOwnResources(doc: Document, page: Page): PdfDict {
  const own = page.Dict.get('Resources');
  if (own !== undefined) {
    const d = doc.resolve(own);
    if (isDict(d)) return d;
  }
  const inherited = page.Resources; // resolved inherited dict or undefined
  const copy: PdfDict = new Map(inherited ?? []);
  page.Dict.set('Resources', copy);
  return copy;
}

/** A fresh own sub-dict (e.g. Font), shallow-copying any existing entries so we
 *  mutate only structures this page owns. */
export function ensureOwnSubdict(doc: Document, resources: PdfDict, key: string): PdfDict {
  const d = doc.resolve(resources.get(key));
  const copy: PdfDict = isDict(d) ? new Map(d) : new Map();
  resources.set(key, copy);
  return copy;
}

/** Register (or reuse) an /ExtGState with the given fill/stroke alpha; returns
 *  its resource key. */
export function registerExtGState(doc: Document, page: Page, opacity: number): string {
  const res = ensureOwnResources(doc, page);
  const gs = ensureOwnSubdict(doc, res, 'ExtGState');
  for (const [k, v] of gs) {
    const d = doc.resolve(v);
    if (isDict(d) && doc.resolve(d.get('ca')) === opacity && doc.resolve(d.get('CA')) === opacity)
      return k;
  }
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('ExtGState')],
    ['ca', opacity],
    ['CA', opacity],
  ]);
  const key = freshKey(gs, 'GS');
  gs.set(key, doc.allocObject(dict));
  return key;
}

/** Normalize /Contents to an array of stream refs (allocating for any inline
 *  streams), keeping only entries that resolve to streams. */
function normalizeContents(doc: Document, c: PdfObject | undefined): PdfRef[] {
  if (c === undefined) return [];
  if (isRef(c)) return isStream(doc.resolve(c)) ? [c] : [];
  if (isStream(c)) return [doc.allocObject(c)];
  if (isArray(c)) {
    const out: PdfRef[] = [];
    for (const e of c) {
      if (isRef(e)) { if (isStream(doc.resolve(e))) out.push(e); }
      else if (isStream(e)) out.push(doc.allocObject(e));
    }
    return out;
  }
  return [];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Splice `body` into /Contents, wrapping existing content in q/Q so prior
 *  graphics state cannot leak into the appended body. */
export function appendContent(doc: Document, page: Page, body: Uint8Array): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  if (existing.length === 0) {
    page.Dict.set('Contents', [doc.allocObject(streamOf(body))]);
    return;
  }
  const qRef = doc.allocObject(streamOf(enc('q')));
  const tailRef = doc.allocObject(streamOf(concat([enc('Q\n'), body])));
  page.Dict.set('Contents', [qRef, ...existing, tailRef]);
}
```

- [ ] **Step 2: Trim `src/stamp.ts` down to text-stamping concerns**

Remove from `stamp.ts` the definitions now in `pagecontent.ts` (`num`, `streamOf`, `freshKey`, `ensureOwnResources`, `ensureOwnSubdict`, `registerExtGState`, `normalizeContents`, `concat`, `appendContent`) and import them instead. Keep `registerFont`, `normalizeOptions`, `buildStampBody`, `measureText`, `stampText`, and the `StampOptions`/`NormalizedOptions` types. Update the import block at the top of `stamp.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isDict, isName, name } from './types.js';
import { encodeWinAnsi } from './encoding.js';
import { measureWinAnsi } from './metrics.js';
import { serializeString } from './serialize.js';
import {
  num, ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent,
} from './pagecontent.js';
```

`registerFont` keeps using `ensureOwnResources`/`ensureOwnSubdict`/`freshKey` — import `freshKey` too if `registerFont` references it directly; otherwise inline its single use. (In the current code `registerFont` calls `freshKey(fonts, 'F')`, so add `freshKey` to the import list above.)

- [ ] **Step 3: Run the existing stamp tests to verify the refactor is behaviour-preserving**

Run: `npx vitest run test/stamp.test.ts`
Expected: PASS (same count as before the refactor).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pagecontent.ts src/stamp.ts
git commit -m "refactor: extract shared page-content helpers into pagecontent.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `PageGraphics` builder + `page.Graphics()`

**Files:**
- Create: `src/graphics.ts`
- Modify: `src/page.ts`
- Test: `test/graphics.test.ts`

**Interfaces:**
- Consumes: `num`, `appendContent`, `registerExtGState` from `pagecontent.ts`; `enc` from `serialize.ts`; `Document`, `Page`.
- Produces:
  - `class PageGraphics` with methods returning `this`: `setLineWidth(w)`, `setStrokeColor([r,g,b])`, `setFillColor([r,g,b])`, `setLineCap(0|1|2)`, `setLineJoin(0|1|2)`, `setDash(number[], phase?)`, `setOpacity(alpha)`, `save()`, `restore()`, `transform(a,b,c,d,e,f)`, `moveTo(x,y)`, `lineTo(x,y)`, `curveTo(x1,y1,x2,y2,x3,y3)`, `rect(x,y,w,h)`, `close()`, `drawLine(x1,y1,x2,y2)`, `drawRect(x,y,w,h)`, `circle(cx,cy,r)`, `ellipse(cx,cy,rx,ry)`, `stroke()`, `fill()`, `fillEvenOdd()`, `fillStroke()`; and `apply(): void`.
  - `Page.Graphics(): PageGraphics`.

- [ ] **Step 1: Write the failing test**

Create `test/graphics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseContentStream } from '../src/content.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** Concatenate all decoded content of page 1 as a string for assertions. */
function pageContentText(doc: Document): string {
  return new TextDecoder().decode(doc.Pages[0].Contents);
}

describe('PageGraphics', () => {
  it('emits state, path and paint operators wrapped in q/Q', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeColor([0, 0, 1]).setLineWidth(2).rect(50, 50, 200, 100).stroke();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('0 0 1 RG');
    expect(text).toContain('2 w');
    expect(text).toContain('50 50 200 100 re');
    expect(text).toContain('S');
    // existing content ("Original") is preserved
    expect(text).toContain('Original');
    // the drawing body is self-wrapped: a q ... Q surrounds the new ops
    const ops = parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
    expect(ops).toContain('q');
    expect(ops).toContain('Q');
    expect(ops).toContain('re');
  });

  it('apply() on an empty builder is a no-op and is idempotent', () => {
    const doc = Document.Open(buildStampTarget());
    const before = pageContentText(doc);
    const g = doc.Pages[0].Graphics();
    g.apply();
    expect(pageContentText(doc)).toBe(before);

    g.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    g.apply();
    const after = pageContentText(doc);
    g.apply(); // second apply must not append again
    expect(pageContentText(doc)).toBe(after);
  });

  it('fill opacity registers a single reusable ExtGState', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setOpacity(0.5).rect(0, 0, 10, 10).fill();
    g.setOpacity(0.5).rect(20, 0, 10, 10).fill();
    g.apply();
    const res = doc.Pages[0].Resources!;
    const ext = res.get('ExtGState') as Map<string, unknown>;
    expect(ext.size).toBe(1); // 0.5 reused, not duplicated
  });

  it('circle is emitted as four bezier curves and a close', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.circle(100, 100, 50).stroke();
    g.apply();
    const ops = parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
    expect(ops.filter((o) => o === 'c').length).toBe(4);
    expect(ops).toContain('h');
  });

  it('rejects invalid arguments', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    expect(() => g.setLineWidth(Infinity)).toThrow(TypeError);
    expect(() => g.setFillColor([2, 0, 0] as [number, number, number])).toThrow(TypeError);
    expect(() => g.setOpacity(1.5)).toThrow(TypeError);
    expect(() => g.setLineCap(5 as 0)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`
Expected: FAIL — `doc.Pages[0].Graphics is not a function`.

- [ ] **Step 3: Implement `src/graphics.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { enc } from './serialize.js';
import { num, appendContent, registerExtGState } from './pagecontent.js';

function checkNum(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`${label} must be a finite number`);
  return n;
}

function checkColor(rgb: [number, number, number]): [number, number, number] {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  return rgb;
}

function checkEnum(label: string, v: number): number {
  if (v !== 0 && v !== 1 && v !== 2)
    throw new TypeError(`${label} must be 0, 1 or 2`);
  return v;
}

function checkAlpha(a: number): number {
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 1)
    throw new TypeError('opacity must be in 0..1');
  return a;
}

/** k constant for a 4-bezier circle/ellipse approximation. */
const KAPPA = 0.5522847498307936;

/** A buffered builder for drawing vector content onto a page. Operators are
 *  accumulated in memory and spliced into the page's /Contents on apply(). */
export class PageGraphics {
  private readonly parts: string[] = [];
  private applied = false;

  constructor(private readonly doc: Document, private readonly page: Page) {}

  private op(s: string): this {
    this.parts.push(s);
    return this;
  }

  // ---- graphics state ----
  setLineWidth(w: number): this { return this.op(`${num(checkNum('lineWidth', w))} w`); }
  setStrokeColor(rgb: [number, number, number]): this {
    const [r, g, b] = checkColor(rgb);
    return this.op(`${num(r)} ${num(g)} ${num(b)} RG`);
  }
  setFillColor(rgb: [number, number, number]): this {
    const [r, g, b] = checkColor(rgb);
    return this.op(`${num(r)} ${num(g)} ${num(b)} rg`);
  }
  setLineCap(cap: 0 | 1 | 2): this { return this.op(`${checkEnum('lineCap', cap)} J`); }
  setLineJoin(join: 0 | 1 | 2): this { return this.op(`${checkEnum('lineJoin', join)} j`); }
  setDash(pattern: number[], phase = 0): this {
    if (!Array.isArray(pattern) || !pattern.every((n) => Number.isFinite(n) && n >= 0))
      throw new TypeError('dash pattern must be an array of non-negative finite numbers');
    checkNum('dash phase', phase);
    return this.op(`[${pattern.map(num).join(' ')}] ${num(phase)} d`);
  }
  setOpacity(alpha: number): this {
    const key = registerExtGState(this.doc, this.page, checkAlpha(alpha));
    return this.op(`/${key} gs`);
  }

  // ---- nesting & transform ----
  save(): this { return this.op('q'); }
  restore(): this { return this.op('Q'); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    [a, b, c, d, e, f].forEach((n, i) => checkNum(`transform[${i}]`, n));
    return this.op(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`);
  }

  // ---- path construction ----
  moveTo(x: number, y: number): this {
    return this.op(`${num(checkNum('x', x))} ${num(checkNum('y', y))} m`);
  }
  lineTo(x: number, y: number): this {
    return this.op(`${num(checkNum('x', x))} ${num(checkNum('y', y))} l`);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    [x1, y1, x2, y2, x3, y3].forEach((n, i) => checkNum(`curve[${i}]`, n));
    return this.op(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`);
  }
  rect(x: number, y: number, w: number, h: number): this {
    [x, y, w, h].forEach((n, i) => checkNum(`rect[${i}]`, n));
    return this.op(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
  }
  close(): this { return this.op('h'); }

  // ---- convenience constructors ----
  drawLine(x1: number, y1: number, x2: number, y2: number): this {
    return this.moveTo(x1, y1).lineTo(x2, y2);
  }
  drawRect(x: number, y: number, w: number, h: number): this {
    return this.rect(x, y, w, h);
  }
  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    [cx, cy, rx, ry].forEach((n, i) => checkNum(`ellipse[${i}]`, n));
    const ox = rx * KAPPA, oy = ry * KAPPA;
    return this
      .moveTo(cx + rx, cy)
      .curveTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry)
      .curveTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy)
      .curveTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry)
      .curveTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy)
      .close();
  }

  // ---- paint ----
  stroke(): this { return this.op('S'); }
  fill(): this { return this.op('f'); }
  fillEvenOdd(): this { return this.op('f*'); }
  fillStroke(): this { return this.op('B'); }

  // ---- commit ----
  apply(): void {
    if (this.applied || this.parts.length === 0) return;
    const body = enc('q\n' + this.parts.join('\n') + '\nQ');
    appendContent(this.doc, this.page, body);
    this.parts.length = 0;
    this.applied = true;
  }
}
```

- [ ] **Step 4: Wire `Page.Graphics()` in `src/page.ts`**

Add the import near the other feature-module imports at the top of `src/page.ts`:

```ts
import { PageGraphics } from './graphics.js';
```

Add this method to the `Page` class (e.g. directly after `AddText`):

```ts
  /** Start a buffered vector-drawing session on this page. Operators are
   *  accumulated until you call apply(), which splices them into /Contents
   *  while preserving existing content. */
  Graphics(): PageGraphics {
    return new PageGraphics(this.doc, this);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/graphics.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/graphics.ts src/page.ts test/graphics.test.ts
git commit -m "feat: PageGraphics vector drawing builder (page.Graphics())

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `page.AddImage` — JPEG embedding

**Files:**
- Create: `src/imageembed.ts`
- Modify: `src/page.ts`
- Test: `test/image-embed.test.ts`
- Test helper: `test/helpers/build-embed-images.ts`

**Interfaces:**
- Consumes: `ensureOwnResources`, `ensureOwnSubdict`, `registerExtGState`, `appendContent`, `freshKey`, `num` from `pagecontent.ts`; `enc` from `serialize.ts`; `name`, `PdfDict`, `PdfObject`, `PdfStream` from `types.ts`; `UnsupportedFeatureError`, `PdfParseError` from `errors.ts`; `Document.allocObject`.
- Produces:
  - `interface AddImageOptions { opacity?: number; format?: 'jpeg' | 'png'; }`
  - `function addImage(doc: Document, page: Page, data: Uint8Array, rect: [number, number, number, number], opts?: AddImageOptions): void`
  - `Page.AddImage(data, rect, opts?): void`
  - Internal `interface BuiltImage { stream: PdfStream; smask?: PdfStream; }` and `buildJpegXObject(data): BuiltImage` (consumed by Task 4's PNG path via the same `BuiltImage` shape).

- [ ] **Step 1: Write the JPEG test helper**

Create `test/helpers/build-embed-images.ts` (the JPEG builder; the PNG builders are added in Task 4):

```ts
/** Minimal hand-built JPEG: a valid SOI + SOF0 (baseline) header with the given
 *  dimensions and component count, then EOI. The entropy-coded scan is omitted —
 *  the library never decodes DCT data, it only parses SOF for metadata and stores
 *  the bytes verbatim, so this is sufficient for tests. */
export function buildJpeg(width: number, height: number, components: 1 | 3): Uint8Array {
  const hi = (n: number) => (n >> 8) & 0xff;
  const lo = (n: number) => n & 0xff;
  const sofLen = 8 + components * 3; // 2 len + 1 prec + 2 h + 2 w + 1 nc + comps*3
  const bytes: number[] = [0xff, 0xd8]; // SOI
  bytes.push(0xff, 0xc0, hi(sofLen), lo(sofLen)); // SOF0 marker + length
  bytes.push(8); // precision
  bytes.push(hi(height), lo(height));
  bytes.push(hi(width), lo(width));
  bytes.push(components);
  for (let i = 1; i <= components; i++) bytes.push(i, 0x11, 0); // id, sampling, qtable
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/image-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildJpeg } from './helpers/build-embed-images.js';

function content(doc: Document): string {
  return new TextDecoder().decode(doc.Pages[0].Contents);
}

describe('page.AddImage — JPEG', () => {
  it('embeds an RGB JPEG as a DCTDecode XObject and paints it', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(40, 20, 3), [10, 10, 80, 40]);

    const imgs = doc.Pages[0].Images;
    expect(imgs.length).toBe(1);
    expect(imgs[0].Width).toBe(40);
    expect(imgs[0].Height).toBe(20);
    expect(imgs[0].ColorSpace).toBe('DeviceRGB');
    expect(imgs[0].Filter).toBe('DCTDecode');

    const text = content(doc);
    expect(text).toContain('80 0 0 40 10 10 cm');
    expect(text).toContain('Do');
    expect(text).toContain('Original'); // existing content preserved
  });

  it('grayscale JPEG -> DeviceGray', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(8, 8, 1), [0, 0, 8, 8]);
    expect(doc.Pages[0].Images[0].ColorSpace).toBe('DeviceGray');
  });

  it('passes the JPEG bytes through unchanged (RawData round-trip)', () => {
    const doc = Document.Open(buildStampTarget());
    const jpeg = buildJpeg(16, 16, 3);
    doc.Pages[0].AddImage(jpeg, [0, 0, 16, 16]);
    expect(doc.Pages[0].Images[0].RawData).toEqual(jpeg);
  });

  it('opacity registers an ExtGState and emits gs', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(8, 8, 3), [0, 0, 8, 8], { opacity: 0.3 });
    expect(content(doc)).toMatch(/\/GS\d+ gs/);
  });

  it('rejects a non-image buffer', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddImage(new Uint8Array([1, 2, 3]), [0, 0, 1, 1]))
      .toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `doc.Pages[0].AddImage is not a function`.

- [ ] **Step 4: Implement `src/imageembed.ts` (sniff + JPEG path + register + paint)**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfStream, name } from './types.js';
import { enc } from './serialize.js';
import {
  ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent, freshKey, num,
} from './pagecontent.js';
import { UnsupportedFeatureError, PdfParseError } from './errors.js';

export interface AddImageOptions {
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png';
}

export interface BuiltImage {
  stream: PdfStream;
  smask?: PdfStream;
}

/** Detect 'jpeg' or 'png' from leading magic bytes. */
function sniff(data: Uint8Array): 'jpeg' | 'png' {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 &&
      data[2] === 0x4e && data[3] === 0x47) return 'png';
  throw new UnsupportedFeatureError('AddImage: unrecognized image format (expected JPEG or PNG)');
}

/** Parse a baseline/progressive JPEG SOF marker into an Image XObject. */
export function buildJpegXObject(data: Uint8Array): BuiltImage {
  let i = 2; // skip SOI (FF D8)
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    let marker = data[i + 1];
    i += 2;
    while (marker === 0xff && i < data.length) marker = data[i++]; // skip fill bytes
    if (marker === 0xd8 || marker === 0xd9) continue;              // SOI/EOI: no length
    if (marker >= 0xd0 && marker <= 0xd7) continue;               // RSTn: no length
    if (i + 1 >= data.length) break;
    const segLen = (data[i] << 8) | data[i + 1];
    // SOF markers carry frame geometry; exclude DHT(C4), JPG(C8), DAC(CC).
    const isSOF = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const precision = data[i + 2];
      const height = (data[i + 3] << 8) | data[i + 4];
      const width = (data[i + 5] << 8) | data[i + 6];
      const nc = data[i + 7];
      const cs = nc === 1 ? 'DeviceGray' : nc === 3 ? 'DeviceRGB' : undefined;
      if (cs === undefined)
        throw new UnsupportedFeatureError(`AddImage: unsupported JPEG with ${nc} components (CMYK not supported)`);
      const dict: PdfDict = new Map<string, PdfObject>([
        ['Type', name('XObject')],
        ['Subtype', name('Image')],
        ['Width', width],
        ['Height', height],
        ['BitsPerComponent', precision],
        ['ColorSpace', name(cs)],
        ['Filter', name('DCTDecode')],
      ]);
      return { stream: { kind: 'stream', dict, raw: data } };
    }
    i += segLen; // skip this segment
  }
  throw new PdfParseError('AddImage: no SOF marker found in JPEG');
}

/** Embed `data` as an Image XObject and paint it into rect [x, y, w, h]. */
export function addImage(
  doc: Document, page: Page, data: Uint8Array,
  rect: [number, number, number, number], opts: AddImageOptions = {},
): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] (4 finite numbers)');
  const fmt = opts.format ?? sniff(data);
  const built = fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);

  if (built.smask) {
    built.stream.dict.set('SMask', doc.allocObject(built.smask));
  }
  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, doc.allocObject(built.stream));

  const [x, y, w, h] = rect;
  const opacity = opts.opacity;
  const gsKey = opacity !== undefined && opacity < 1
    ? registerExtGState(doc, page, opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n`;
  s += `/${key} Do\nQ`;
  appendContent(doc, page, enc(s));
}

// PNG support is added in Task 4. Until then this throws so the JPEG path links.
function buildPngXObject(_data: Uint8Array): BuiltImage {
  throw new UnsupportedFeatureError('AddImage: PNG support not yet implemented');
}
```

Note: `buildPngXObject` is a temporary stub here so the module compiles; Task 4 replaces it with the real implementation. This is the one place where two adjacent tasks touch the same function — Task 4 overwrites the stub.

- [ ] **Step 5: Wire `Page.AddImage()` in `src/page.ts`**

Add the import:

```ts
import { addImage, AddImageOptions } from './imageembed.js';
```

Add to the `Page` class (after `Graphics()`):

```ts
  /** Embed `data` (JPEG or PNG) as an Image XObject and paint it into the
   *  rectangle [x, y, w, h] (PDF user space). Existing content is preserved. */
  AddImage(data: Uint8Array, rect: [number, number, number, number], opts?: AddImageOptions): void {
    addImage(this.doc, this, data, rect, opts ?? {});
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS (all JPEG cases).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/imageembed.ts src/page.ts test/image-embed.test.ts test/helpers/build-embed-images.ts
git commit -m "feat: page.AddImage embeds and paints JPEG images

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `page.AddImage` — PNG embedding (grayscale, RGB, palette, alpha→SMask)

**Files:**
- Modify: `src/imageembed.ts` (replace the `buildPngXObject` stub)
- Modify: `test/helpers/build-embed-images.ts` (add PNG builders)
- Modify: `test/image-embed.test.ts` (add PNG cases)

**Interfaces:**
- Consumes: `applyPredictor` from `predictor.ts`; `inflateSync`, `deflateSync` from `node:zlib`; `BuiltImage`, types/helpers already imported in `imageembed.ts`.
- Produces: real `buildPngXObject(data: Uint8Array): BuiltImage` (replaces the stub; same signature, so Task 3's `addImage` is unchanged).

- [ ] **Step 1: Add PNG fixture builders to `test/helpers/build-embed-images.ts`**

```ts
import { deflateSync } from 'node:zlib';

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** A PNG chunk: length + type + data + (zero) CRC. The library does not verify
 *  CRCs, so a zero placeholder is fine for fixtures. */
function chunk(type: string, data: number[]): number[] {
  const t = [...type].map((c) => c.charCodeAt(0));
  return [...u32(data.length), ...t, ...data, 0, 0, 0, 0];
}

/** Build an 8-bit PNG. colorType: 0 gray, 2 RGB, 3 palette, 6 RGBA.
 *  `rows` is the unfiltered sample data, one number per byte, row-major. */
function buildPng(
  width: number, height: number, colorType: 0 | 2 | 3 | 6,
  rows: number[], opts: { palette?: number[] } = {},
): Uint8Array {
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : 4;
  const rowLen = width * channels;
  // prefix each scanline with filter byte 0 (None)
  const filtered: number[] = [];
  for (let r = 0; r < height; r++) {
    filtered.push(0);
    filtered.push(...rows.slice(r * rowLen, (r + 1) * rowLen));
  }
  const idat = [...deflateSync(Buffer.from(filtered))];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(width), ...u32(height), 8, colorType, 0, 0, 0];
  const out = [...sig, ...chunk('IHDR', ihdr)];
  if (colorType === 3 && opts.palette) out.push(...chunk('PLTE', opts.palette));
  out.push(...chunk('IDAT', idat));
  out.push(...chunk('IEND', []));
  return new Uint8Array(out);
}

/** 2x1 RGB image: red, green. */
export function buildPngRgb(): Uint8Array {
  return buildPng(2, 1, 2, [255, 0, 0, 0, 255, 0]);
}

/** 2x1 grayscale image. */
export function buildPngGray(): Uint8Array {
  return buildPng(2, 1, 0, [0x10, 0x20]);
}

/** 2x1 palette image (palette: red, green). */
export function buildPngPalette(): Uint8Array {
  return buildPng(2, 1, 3, [0, 1], { palette: [255, 0, 0, 0, 255, 0] });
}

/** 1x1 RGBA image: opaque-ish red at 50% alpha. Returns the raw color samples
 *  and alpha so tests can assert the SMask split. */
export const RGBA_PIXEL = { r: 255, g: 0, b: 0, a: 128 };
export function buildPngRgba(): Uint8Array {
  const p = RGBA_PIXEL;
  return buildPng(1, 1, 6, [p.r, p.g, p.b, p.a]);
}

/** An interlaced (Adam7) PNG, for the rejection test. */
export function buildPngInterlaced(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(1), ...u32(1), 8, 2, 0, 0, 1]; // interlace=1
  const idat = [...deflateSync(Buffer.from([0, 0, 0, 0]))];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}
```

- [ ] **Step 2: Write the failing PNG tests**

Append to `test/image-embed.test.ts`:

```ts
import {
  buildPngRgb, buildPngGray, buildPngPalette, buildPngRgba, buildPngInterlaced, RGBA_PIXEL,
} from './helpers/build-embed-images.js';
import { inflateStream } from '../src/flate.js';

describe('page.AddImage — PNG', () => {
  it('RGB PNG -> DeviceRGB FlateDecode XObject, samples round-trip', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngRgb(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.Width).toBe(2);
    expect(img.Height).toBe(1);
    expect(img.ColorSpace).toBe('DeviceRGB');
    expect(img.Filter).toBe('FlateDecode');
    expect([...img.Decode()]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('grayscale PNG -> DeviceGray', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngGray(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceGray');
    expect([...img.Decode()]).toEqual([0x10, 0x20]);
  });

  it('palette PNG -> Indexed color space, index samples round-trip', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngPalette(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('Indexed');
    expect([...img.Decode()]).toEqual([0, 1]);
  });

  it('RGBA PNG splits alpha into an /SMask DeviceGray image', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngRgba(), [0, 0, 1, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceRGB');
    expect([...img.Decode()]).toEqual([RGBA_PIXEL.r, RGBA_PIXEL.g, RGBA_PIXEL.b]);
    // SMask present and holds the alpha byte
    const smaskRef = img.Dict.get('SMask');
    expect(smaskRef).toBeDefined();
    const smask = doc.resolve(smaskRef);
    expect((smask as any).kind).toBe('stream');
    expect([...inflateStream(smask as any)]).toEqual([RGBA_PIXEL.a]);
  });

  it('rejects interlaced PNG', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddImage(buildPngInterlaced(), [0, 0, 1, 1]))
      .toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 3: Run to verify the PNG tests fail**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `AddImage: PNG support not yet implemented` (the stub).

- [ ] **Step 4: Replace the `buildPngXObject` stub in `src/imageembed.ts`**

Add these imports at the top of `src/imageembed.ts`:

```ts
import { inflateSync, deflateSync } from 'node:zlib';
import { applyPredictor } from './predictor.js';
```

Replace the stub function with the real implementation:

```ts
/** PNG chunk reader: yields { type, data } in order. */
function* pngChunks(data: Uint8Array): Generator<{ type: string; data: Uint8Array }> {
  let i = 8; // skip signature
  while (i + 8 <= data.length) {
    const len = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    const start = i + 8;
    yield { type, data: data.subarray(start, start + len) };
    i = start + len + 4; // + CRC
  }
}

function flate(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(bytes)));
}

function imageStream(
  width: number, height: number, bpc: number,
  colorSpace: PdfObject, raw: Uint8Array,
): PdfStream {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Image')],
    ['Width', width],
    ['Height', height],
    ['BitsPerComponent', bpc],
    ['ColorSpace', colorSpace],
    ['Filter', name('FlateDecode')],
  ]);
  return { kind: 'stream', dict, raw };
}

function buildPngXObject(data: Uint8Array): BuiltImage {
  let width = 0, height = 0, bitDepth = 0, colorType = -1;
  let palette: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];
  for (const { type, data: cd } of pngChunks(data)) {
    if (type === 'IHDR') {
      width = (cd[0] << 24) | (cd[1] << 16) | (cd[2] << 8) | cd[3];
      height = (cd[4] << 24) | (cd[5] << 16) | (cd[6] << 8) | cd[7];
      bitDepth = cd[8];
      colorType = cd[9];
      if (cd[12] !== 0)
        throw new UnsupportedFeatureError('AddImage: interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = cd;
    } else if (type === 'IDAT') {
      idatParts.push(cd);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (colorType < 0) throw new PdfParseError('AddImage: PNG has no IHDR');

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1
    : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new UnsupportedFeatureError(`AddImage: unsupported PNG color type ${colorType}`);
  const hasAlpha = colorType === 4 || colorType === 6;
  if (hasAlpha && bitDepth !== 8)
    throw new UnsupportedFeatureError('AddImage: PNG with alpha is only supported at 8-bit depth');

  // Concatenate and inflate IDAT, then reverse PNG row filters via predictor 15.
  const idatLen = idatParts.reduce((n, p) => n + p.length, 0);
  const idat = new Uint8Array(idatLen);
  { let o = 0; for (const p of idatParts) { idat.set(p, o); o += p.length; } }
  const inflated = new Uint8Array(inflateSync(Buffer.from(idat)));
  const samples = applyPredictor(inflated, {
    predictor: 15, colors: channels, bpc: bitDepth, columns: width,
  });

  if (hasAlpha) {
    // Split interleaved color+alpha (8-bit) into separate color and alpha planes.
    const colorChannels = channels - 1; // 1 (gray+a) or 3 (rgb+a)
    const px = width * height;
    const color = new Uint8Array(px * colorChannels);
    const alpha = new Uint8Array(px);
    for (let p = 0; p < px; p++) {
      for (let c = 0; c < colorChannels; c++) color[p * colorChannels + c] = samples[p * channels + c];
      alpha[p] = samples[p * channels + colorChannels];
    }
    const cs = colorChannels === 1 ? name('DeviceGray') : name('DeviceRGB');
    const stream = imageStream(width, height, 8, cs, flate(color));
    const smask = imageStream(width, height, 8, name('DeviceGray'), flate(alpha));
    return { stream, smask };
  }

  if (colorType === 3) {
    if (!palette) throw new PdfParseError('AddImage: palette PNG missing PLTE');
    const hival = Math.floor(palette.length / 3) - 1;
    const cs: PdfObject = [
      name('Indexed'), name('DeviceRGB'), hival,
      { kind: 'string', bytes: new Uint8Array(palette) } as PdfObject,
    ];
    return { stream: imageStream(width, height, bitDepth, cs, flate(samples)) };
  }

  const cs = colorType === 0 ? name('DeviceGray') : name('DeviceRGB');
  return { stream: imageStream(width, height, bitDepth, cs, flate(samples)) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS (JPEG and PNG cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/imageembed.ts test/image-embed.test.ts test/helpers/build-embed-images.ts
git commit -m "feat: page.AddImage embeds PNG (gray/RGB/palette/alpha->SMask)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Public exports + README

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `PageGraphics` from `graphics.ts`; `AddImageOptions` from `imageembed.ts`.
- Produces: public re-exports.

- [ ] **Step 1: Add exports to `src/index.ts`**

Add (matching the existing export style in the file):

```ts
export { PageGraphics } from './graphics.js';
export type { AddImageOptions } from './imageembed.js';
```

- [ ] **Step 2: Verify the public surface compiles and resolves**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Update README**

In the **Features** list, add two bullets after the "Text stamping" bullet:

```markdown
- **Vector drawing** — `page.Graphics()` returns a buffered `PageGraphics` builder for lines, rectangles, circles/ellipses, and arbitrary paths with stroke/fill state (color, line width/cap/join/dash, constant opacity); `apply()` splices the drawing into the page, preserving existing content.
- **Image insertion** — `page.AddImage(data, [x, y, w, h], opts?)` embeds a JPEG (`DCTDecode` passthrough) or PNG (`FlateDecode`; palette and alpha→`/SMask` handled) as an Image XObject and paints it at the given rectangle.
```

Add two usage subsections after the "Text stamping" section:

````markdown
### Vector drawing

```ts
const g = doc.Pages[0].Graphics();
g.setStrokeColor([0, 0, 1]).setLineWidth(2).rect(50, 50, 200, 100).stroke();
g.setFillColor([1, 0, 0]).circle(300, 400, 40).fill();
g.apply();                       // nothing is written until apply()
```

Operators buffer in memory and are spliced into `/Contents` on `apply()` (a
no-op if nothing was drawn, and idempotent). Coordinates are PDF user space
(origin bottom-left, points). `save()`/`restore()` map to `q`/`Q` and
`transform(a,b,c,d,e,f)` to `cm`.

### Image insertion

```ts
import { readFileSync } from 'node:fs';

const png = new Uint8Array(readFileSync('logo.png'));
doc.Pages[0].AddImage(png, [40, 700, 120, 60]);          // x, y, w, h in points
doc.Pages[0].AddImage(png, [40, 700, 120, 60], { opacity: 0.5 });
```

JPEG bytes are stored verbatim (`DCTDecode`); PNG is decoded with `node:zlib`
and re-stored as `FlateDecode`, expanding palettes to `/Indexed` and splitting an
alpha channel into an `/SMask`. CMYK JPEG and interlaced PNG throw
`UnsupportedFeatureError`.
````

In the **API overview** table, add these rows (after the `page.AddText`-related rows / near the page members):

```markdown
| `page.Graphics()` | Buffered `PageGraphics` builder for vector drawing |
| `page.AddImage(data, rect, opts?)` | Embed and paint a JPEG/PNG raster at `[x, y, w, h]` |
```

In the **Limitations** section, remove or amend any wording implying images cannot be added, and add:

```markdown
- **Image insertion is JPEG/PNG only** — `AddImage` accepts JPEG (`DCTDecode`) and PNG (`FlateDecode`); CMYK JPEG, interlaced PNG, palette transparency (`tRNS`), and 16-bit-with-alpha are not supported. Other raster formats are out of scope.
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS (all suites, including the new graphics and image-embed tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs: document PageGraphics and page.AddImage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** Module A (PageGraphics) → Task 2; Module B JPEG → Task 3; Module B PNG (palette + alpha→SMask + interlace rejection) → Task 4; the `pagecontent.ts` refactor → Task 1; exports + README → Task 5. Non-goal "no richer text" respected (no font work here). CMYK-JPEG and interlaced-PNG rejections covered by tests.
- **Type consistency:** `BuiltImage { stream; smask? }` is defined in Task 3 and reused unchanged in Task 4; `addImage` reads `built.smask`/`built.stream` consistently. `AddImageOptions` shape identical in `imageembed.ts` and the `Page.AddImage` signature. `PageGraphics` method names match between the test (Task 2) and the implementation.
- **Stub hand-off:** Task 3 ships a throwing `buildPngXObject` stub so the module compiles with only the JPEG path; Task 4 replaces it. This is the single intentional cross-task edit to one function, called out in Task 3 Step 4 and Task 4 Step 4.
- **Predictor reuse:** PNG un-filtering uses the existing `applyPredictor(..., { predictor: 15, colors: channels, bpc: bitDepth, columns: width })`; for `predictor >= 10` it dispatches to the PNG path (per-row filter byte), which is exactly the inflated IDAT layout.
```
