# Vector/Path Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `page.GetPaths()` — extract a page's painted vector graphics as a positioned path model (subpaths + CTM, device bbox, resolved fill/stroke color + colorspace family, fill rule, line width, clip, mcid/artifact), covering nested Form XObjects.

**Architecture:** A new self-contained module `src/paths.ts` owns its content walk (CTM/XObject/mcid threading + path construction + color tracking), following the `imageusage.ts` precedent rather than extending the shared `visitContent` walker in `text.ts` (keeps `text.ts`/`table.ts` untouched). `Page.GetPaths()` delegates to `extractPaths(doc, page)`. Color resolution reuses `colorspace.ts`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only). Fixtures built programmatically in `test/helpers/`.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must be green before closing.
- Never throw on malformed content — a stream that fails to parse/decode contributes no paths; wrong-arity ops are skipped; unknown colorspaces resolve to gray with `space:'Unknown'`.
- `Rgb` is `[number, number, number]` with **0–255 integer** channels (the library convention from `colorspace.ts`).
- Spec: `docs/superpowers/specs/2026-07-17-vector-path-extraction-design.md`.

---

### Task 1: Module scaffold — geometry, CTM, device colors, emission

**Files:**
- Create: `src/paths.ts`
- Modify: `src/page.ts` (add `GetPaths()` + import), `src/index.ts` (exports)
- Create: `test/helpers/build-paths-pdf.ts`
- Create: `test/paths.test.ts`

**Interfaces:**
- Consumes: `contentStreamBytes(doc, page): Uint8Array[]`, `Matrix`, `IDENTITY`, `mul(m,n)`, `apply(m,x,y)`, `vscale(m)` (from `./text.js`); `parseContentStream(bytes): ContentOp[]` (from `./content.js`); `Rgb`, `cmykToRgb(c,m,y,k)` (from `./colorspace.js`); `ContentAddr` (from `./editcontent.js`).
- Produces:
  - `extractPaths(doc: Document, page: Page): PagePath[]`
  - `interface PagePath { subpaths: PathSubpath[]; ctm: Matrix; bbox: [number,number,number,number]; fill: PathPaint | null; stroke: PathPaint | null; fillRule: 'nonzero'|'evenodd'|null; lineWidth: number; clip: 'nonzero'|'evenodd'|null; mcid?: number; artifact?: boolean; addr: ContentAddr; }`
  - `interface PathSubpath { closed: boolean; segments: PathSegment[]; }`
  - `type PathSegment = { op:'move'; pt:[number,number] } | { op:'line'; pt:[number,number] } | { op:'cubic'; c1:[number,number]; c2:[number,number]; pt:[number,number] }`
  - `interface PathPaint { rgb: Rgb; space: string; }`
  - `Page.GetPaths(): PagePath[]`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-paths-pdf.ts`. It mirrors `build-stamp-target.ts`'s `assemble`/`streamObj` helpers (copy them — those helpers are not exported). The content stream draws distinct shapes.

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
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** A page drawing: a filled-RGB rectangle, a stroked-CMYK line, a filled+stroked
 *  bezier via `B`, an even-odd clip, and a `v`/`y` curve. MediaBox 0 0 200 200. */
export function buildPathsPdf(): Uint8Array {
  const content = [
    // filled red rectangle (DeviceRGB), 10 10 -> 60 40
    '1 0 0 rg 10 10 50 30 re f',
    // stroked line (DeviceCMYK cyan), width 4
    '0 1 1 0 0 K 4 w 10 100 m 90 120 l S',
    // fill+stroke bezier with B (nonzero), green fill / black stroke
    '0 1 0 rg 0 0 0 RG 2 w 100 100 m 120 180 160 180 180 100 c B',
    // even-odd clip rectangle then n (clip-only)
    '20 20 40 40 re W* n',
    // v and y curves in their own subpath, stroked
    '10 150 m 10 160 30 160 v 50 150 50 y S',
  ].join('\n');
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPathsPdf } from './helpers/build-paths-pdf.js';

const paths = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetPaths();

describe('GetPaths — geometry, device color, emission', () => {
  it('extracts a filled RGB rectangle', () => {
    const p = paths(buildPathsPdf());
    const rect = p.find((x) => x.fill?.space === 'DeviceRGB' && x.subpaths[0]?.closed);
    expect(rect).toBeDefined();
    expect(rect!.fill!.rgb).toEqual([255, 0, 0]);
    expect(rect!.stroke).toBeNull();
    expect(rect!.fillRule).toBe('nonzero');
    expect(rect!.subpaths[0].closed).toBe(true);
    // device bbox = user-space rect (identity CTM): [10,10,60,40]
    expect(rect!.bbox).toEqual([10, 10, 60, 40]);
  });

  it('extracts a stroked CMYK line with scaled line width', () => {
    const p = paths(buildPathsPdf());
    const line = p.find((x) => x.stroke?.space === 'DeviceCMYK');
    expect(line).toBeDefined();
    expect(line!.fill).toBeNull();
    expect(line!.lineWidth).toBe(4);                 // identity CTM
    expect(line!.stroke!.rgb).toEqual([0, 255, 255]); // cyan cmyk -> rgb
    expect(line!.subpaths[0].segments.map((s) => s.op)).toEqual(['move', 'line']);
  });

  it('emits fill+stroke for B', () => {
    const p = paths(buildPathsPdf());
    const bez = p.find((x) => x.fill?.rgb[1] === 255 && x.stroke !== null);
    expect(bez).toBeDefined();
    const seg = bez!.subpaths[0].segments.find((s) => s.op === 'cubic') as any;
    expect(seg.c1).toEqual([120, 180]);
    expect(seg.pt).toEqual([180, 100]);
  });

  it('emits a clip-only path for W* n', () => {
    const p = paths(buildPathsPdf());
    const clip = p.find((x) => x.clip === 'evenodd');
    expect(clip).toBeDefined();
    expect(clip!.fill).toBeNull();
    expect(clip!.stroke).toBeNull();
  });

  it('normalizes v and y into cubic segments', () => {
    const p = paths(buildPathsPdf());
    // the v/y subpath starts at 10 150; find the path whose first segment moves there
    const vy = p.find((x) => x.subpaths[0]?.segments[0]?.op === 'move' &&
      (x.subpaths[0].segments[0] as any).pt[0] === 10 &&
      (x.subpaths[0].segments[0] as any).pt[1] === 150);
    expect(vy).toBeDefined();
    const segs = vy!.subpaths[0].segments;
    // v: c1 = current point (10,150); c2 = (10,160); pt = (30,160)
    expect(segs[1]).toEqual({ op: 'cubic', c1: [10, 150], c2: [10, 160], pt: [30, 160] });
    // y: c1 = (50,150); c2 = pt = (50,150)   (operands: 50 150 50 150 wait see builder)
    expect(segs[2].op).toBe('cubic');
  });
});
```

Note: the builder's `y` op is `50 150 50 y` — that is only 3 numbers, which is malformed. **Fix the builder line** to a valid `y` (4 operands): change `'50 150 50 y S'` to `'50 160 30 150 y S'`. Update the test's `y` expectation accordingly: `expect(segs[2]).toEqual({ op:'cubic', c1:[50,160], c2:[30,150], pt:[30,150] })`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL — `GetPaths` is not a function / module `../src/paths.js` not found.

- [ ] **Step 4: Implement `src/paths.ts`**

```ts
// Vector/path content extraction: walk a page's content (and nested Form
// XObjects), tracking the CTM, paint color, line width and clip, and emit one
// positioned path per paint operation. A focused walker (cf. imageusage.ts),
// deliberately separate from text.ts's shared visitContent.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import { PdfObject } from './types.js';
import { parseContentStream } from './content.js';
import { Matrix, IDENTITY, mul, apply, vscale, contentStreamBytes } from './text.js';
import { Rgb, cmykToRgb } from './colorspace.js';

export type PathSegment =
  | { op: 'move'; pt: [number, number] }
  | { op: 'line'; pt: [number, number] }
  | { op: 'cubic'; c1: [number, number]; c2: [number, number]; pt: [number, number] };

export interface PathSubpath { closed: boolean; segments: PathSegment[]; }
export interface PathPaint { rgb: Rgb; space: string; }

export interface PagePath {
  subpaths: PathSubpath[];
  ctm: Matrix;
  bbox: [number, number, number, number];
  fill: PathPaint | null;
  stroke: PathPaint | null;
  fillRule: 'nonzero' | 'evenodd' | null;
  lineWidth: number;
  clip: 'nonzero' | 'evenodd' | null;
  mcid?: number;
  artifact?: boolean;
  addr: ContentAddr;
}

const MAX_XOBJECT_DEPTH = 8;
type Pt = [number, number];

const nums = (ops: readonly PdfObject[]): number[] =>
  ops.filter((x): x is number => typeof x === 'number');
const num = (o: PdfObject | undefined): number => (typeof o === 'number' ? o : 0);
const cl255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

function deviceBbox(subpaths: PathSubpath[], ctm: Matrix): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    const [dx, dy] = apply(ctm, p[0], p[1]);
    if (dx < x0) x0 = dx; if (dy < y0) y0 = dy;
    if (dx > x1) x1 = dx; if (dy > y1) y1 = dy;
  };
  for (const sp of subpaths) for (const s of sp.segments) {
    if (s.op === 'cubic') { add(s.c1); add(s.c2); add(s.pt); } else add(s.pt);
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

interface Ctx { doc: Document; out: PagePath[]; }
interface Stream { bytes: Uint8Array; streamIndex: number; }

function walk(
  ctx: Ctx, streams: Stream[], resources: import('./types.js').PdfDict | undefined,
  path: string[], baseCtm: Matrix, depth: number, seen: Set<object>,
): void {
  let ctm = baseCtm;
  let lineWidth = 1;
  let fill: PathPaint = { rgb: [0, 0, 0], space: 'DeviceGray' };
  let stroke: PathPaint = { rgb: [0, 0, 0], space: 'DeviceGray' };
  const gsStack: { ctm: Matrix; lineWidth: number; fill: PathPaint; stroke: PathPaint }[] = [];

  let subpaths: PathSubpath[] = [];
  let cur: PathSubpath | undefined;
  let curPt: Pt | undefined;
  let startPt: Pt | undefined;
  let pendingClip: 'nonzero' | 'evenodd' | null = null;

  const reset = () => { subpaths = []; cur = undefined; curPt = undefined; startPt = undefined; pendingClip = null; };

  const emit = (addr: ContentAddr, f: boolean, s: boolean, rule: 'nonzero' | 'evenodd' | null) => {
    if (!f && !s && !pendingClip) { reset(); return; }
    if (subpaths.length === 0) { reset(); return; }
    ctx.out.push({
      subpaths: subpaths.map((sp) => ({ closed: sp.closed, segments: sp.segments.slice() })),
      ctm,
      bbox: deviceBbox(subpaths, ctm),
      fill: f ? { rgb: fill.rgb, space: fill.space } : null,
      stroke: s ? { rgb: stroke.rgb, space: stroke.space } : null,
      fillRule: f ? rule : null,
      lineWidth: s ? lineWidth * vscale(ctm) : 0,
      clip: pendingClip,
      addr,
    });
    reset();
  };

  for (const { bytes, streamIndex } of streams) {
    let ops;
    try { ops = parseContentStream(bytes); } catch { continue; }
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      const addr: ContentAddr = { path: [...path], streamIndex, opIndex };
      const n = nums(op.operands);
      switch (op.operator) {
        case 'q': gsStack.push({ ctm, lineWidth, fill, stroke }); break;
        case 'Q': { const g = gsStack.pop(); if (g) { ctm = g.ctm; lineWidth = g.lineWidth; fill = g.fill; stroke = g.stroke; } break; }
        case 'cm': if (n.length === 6) ctm = mul(n as Matrix, ctm); break;
        case 'w': lineWidth = num(op.operands[0]); break;
        // path construction
        case 'm': cur = { closed: false, segments: [{ op: 'move', pt: [n[0], n[1]] }] }; subpaths.push(cur); curPt = [n[0], n[1]]; startPt = [n[0], n[1]]; break;
        case 'l': if (cur && n.length >= 2) { cur.segments.push({ op: 'line', pt: [n[0], n[1]] }); curPt = [n[0], n[1]]; } break;
        case 'c': if (cur && n.length >= 6) { cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[4], n[5]] }); curPt = [n[4], n[5]]; } break;
        case 'v': if (cur && curPt && n.length >= 4) { cur.segments.push({ op: 'cubic', c1: [curPt[0], curPt[1]], c2: [n[0], n[1]], pt: [n[2], n[3]] }); curPt = [n[2], n[3]]; } break;
        case 'y': if (cur && n.length >= 4) { cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[2], n[3]] }); curPt = [n[2], n[3]]; } break;
        case 're': if (n.length >= 4) {
          const [x, y, w, h] = n;
          cur = { closed: true, segments: [
            { op: 'move', pt: [x, y] }, { op: 'line', pt: [x + w, y] },
            { op: 'line', pt: [x + w, y + h] }, { op: 'line', pt: [x, y + h] },
          ] };
          subpaths.push(cur); curPt = [x, y]; startPt = [x, y];
        } break;
        case 'h': if (cur) { cur.closed = true; if (startPt) curPt = startPt; } break;
        // device colors
        case 'g': { const v = cl255(num(op.operands[0])); fill = { rgb: [v, v, v], space: 'DeviceGray' }; break; }
        case 'G': { const v = cl255(num(op.operands[0])); stroke = { rgb: [v, v, v], space: 'DeviceGray' }; break; }
        case 'rg': fill = { rgb: [cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)], space: 'DeviceRGB' }; break;
        case 'RG': stroke = { rgb: [cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)], space: 'DeviceRGB' }; break;
        case 'k': fill = { rgb: cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0), space: 'DeviceCMYK' }; break;
        case 'K': stroke = { rgb: cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0), space: 'DeviceCMYK' }; break;
        // clip
        case 'W': pendingClip = 'nonzero'; break;
        case 'W*': pendingClip = 'evenodd'; break;
        // paint
        case 'S': emit(addr, false, true, null); break;
        case 's': if (cur) cur.closed = true; emit(addr, false, true, null); break;
        case 'f': case 'F': emit(addr, true, false, 'nonzero'); break;
        case 'f*': emit(addr, true, false, 'evenodd'); break;
        case 'B': emit(addr, true, true, 'nonzero'); break;
        case 'B*': emit(addr, true, true, 'evenodd'); break;
        case 'b': if (cur) cur.closed = true; emit(addr, true, true, 'nonzero'); break;
        case 'b*': if (cur) cur.closed = true; emit(addr, true, true, 'evenodd'); break;
        case 'n': emit(addr, false, false, null); break;
        default: break;
      }
    }
  }
  void resources; void depth; void seen; // used from Task 3 onward
}

/** Extract painted vector paths from a page (top-level content and, from a later
 *  task, nested Form XObjects). Never throws; returns [] on decode failure. */
export function extractPaths(doc: Document, page: Page): PagePath[] {
  const ctx: Ctx = { doc, out: [] };
  let bytes: Uint8Array[];
  try { bytes = contentStreamBytes(doc, page); } catch { return []; }
  walk(ctx, bytes.map((b, i) => ({ bytes: b, streamIndex: i })), page.Resources, [], IDENTITY, 0, new Set());
  return ctx.out;
}
```

- [ ] **Step 5: Wire `Page.GetPaths()`**

In `src/page.ts`, add the import near line 18 (after the `extractTables` import):

```ts
import { extractPaths, type PagePath } from './paths.js';
```

Add the method after `GetTables` (around line 344):

```ts
  /** Extract painted vector paths (fills/strokes/clips) as positioned shapes:
   *  each carries its subpaths in user space, the CTM at paint time, a
   *  device-space bounding box, resolved fill/stroke color + colorspace family,
   *  fill rule, stroke line width, and clip usage. Descends into Form XObjects.
   *  Returns [] for pages with no painted paths. */
  GetPaths(): PagePath[] {
    return extractPaths(this.doc, this);
  }
```

- [ ] **Step 6: Wire `src/index.ts` exports**

After line 29 (`export { extractTables, Table } from './table.js';`) add:

```ts
export { extractPaths } from './paths.js';
```

In the type-export block (near line 32) add:

```ts
export type { PagePath, PathSubpath, PathSegment, PathPaint } from './paths.js';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` — clean.

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/page.ts src/index.ts test/helpers/build-paths-pdf.ts test/paths.test.ts
git commit -m "feat(8i9): page.GetPaths geometry, device color, emission"
```

---

### Task 2: Colorspace resolution (cs/CS, sc/scn, Separation/ICC/Indexed/Pattern)

**Files:**
- Modify: `src/paths.ts`
- Modify: `test/helpers/build-paths-pdf.ts` (add a fixture with a named colorspace)
- Modify: `test/paths.test.ts`

**Interfaces:**
- Consumes: `resolveColorSpace(cs, resolve, inflate): ColorConverter`, `deviceGray(): ColorConverter`, `ColorConverter` (from `./colorspace.js`); `inflateStream(stream)` (from `./flate.js`); `PdfDict`, `PdfObject`, `isName`, `isArray`, `isDict`, `isStream` (from `./types.js`).
- Produces: `paths.ts` now resolves non-device colorspaces; `PathPaint.space` reports the family (`'ICCBased'`, `'Separation'`, `'Indexed'`, `'DeviceN'`, `'Lab'`, `'CalGray'`, `'CalRGB'`, `'Pattern'`, `'Unknown'`).

- [ ] **Step 1: Add a Separation-colorspace shape to the fixture**

In `test/helpers/build-paths-pdf.ts`, add a new exported builder (leave `buildPathsPdf` unchanged so Task 1 tests still pass):

```ts
/** A page whose /Resources define a Separation "Spot" colorspace (tint -> CMYK),
 *  used to fill a rectangle at tint 1.0. MediaBox 0 0 100 100. */
export function buildSeparationPathPdf(): Uint8Array {
  const content = '/CS0 cs 1 scn 10 10 50 50 re f';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /ColorSpace << /CS0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  // Separation: 1-in -> 4-out CMYK identity-ish tint transform (exponential C=1).
  objects[5] = `[ /Separation /Spot /DeviceCMYK 6 0 R ]`;
  objects[6] = `<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 1 0] /N 1 >>`;
  return assemble(objects, 6, 1);
}
```

At tint 1.0 the function outputs CMYK `[0 1 1 0]` → `cmykToRgb(0,1,1,0)` = `[255,0,0]` (red).

- [ ] **Step 2: Write the failing test**

Add to `test/paths.test.ts`:

```ts
import { buildSeparationPathPdf } from './helpers/build-paths-pdf.js';

describe('GetPaths — colorspace resolution', () => {
  it('resolves a Separation fill to its alternate color and reports the family', () => {
    const p = Document.Open(buildSeparationPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(1);
    expect(p[0].fill!.space).toBe('Separation');
    expect(p[0].fill!.rgb).toEqual([255, 0, 0]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/paths.test.ts -t Separation`
Expected: FAIL — `space` is `'DeviceGray'` and `rgb` is `[0,0,0]` (cs/scn not yet handled).

- [ ] **Step 4: Implement colorspace tracking**

In `src/paths.ts`, extend the imports:

```ts
import { PdfDict, PdfObject, isName, isArray, isDict, isStream } from './types.js';
import { Rgb, cmykToRgb, resolveColorSpace, deviceGray, ColorConverter } from './colorspace.js';
import { inflateStream } from './flate.js';
```

Add module-level helpers (after `cl255`):

```ts
function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** The colorspace family label for a /ColorSpace operand (name or array). */
function csFamily(doc: Document, obj: PdfObject | undefined): string {
  const r = doc.resolve(obj);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return 'DeviceGray';
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return 'DeviceRGB';
      case 'DeviceCMYK': case 'CMYK': return 'DeviceCMYK';
      case 'Pattern': return 'Pattern';
      default: return 'Unknown';
    }
  }
  if (isArray(r) && r.length > 0) {
    const head = doc.resolve(r[0]);
    const fam = isName(head) ? head.name : '';
    switch (fam) {
      case 'ICCBased': return 'ICCBased';
      case 'Indexed': case 'I': return 'Indexed';
      case 'Separation': return 'Separation';
      case 'DeviceN': return 'DeviceN';
      case 'Lab': return 'Lab';
      case 'CalRGB': return 'CalRGB';
      case 'CalGray': return 'CalGray';
      case 'Pattern': return 'Pattern';
      default: return 'Unknown';
    }
  }
  return 'Unknown';
}

const DEVICE_CS = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK']);

/** Resolve a cs/CS operand to a converter + family, looking names up in
 *  /Resources /ColorSpace when they are not device spaces. */
function lookupCs(
  doc: Document, resources: PdfDict | undefined, operand: PdfObject | undefined,
): { conv: ColorConverter; space: string } {
  let csObj = operand;
  if (isName(operand) && !DEVICE_CS.has(operand.name)) {
    const csDict = resolveDict(doc, resources?.get('ColorSpace'));
    const found = csDict?.get(operand.name);
    if (found !== undefined) csObj = found;
  }
  const resolve = (o: PdfObject | undefined) => doc.resolve(o);
  const inflate = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
  const conv = resolveColorSpace(csObj as PdfObject, resolve, inflate);
  return { conv, space: csFamily(doc, csObj) };
}
```

Inside `walk`, add converter state next to `fill`/`stroke`:

```ts
  let fillConv: ColorConverter = deviceGray();
  let strokeConv: ColorConverter = deviceGray();
```

Add `fillConv`/`strokeConv` to the `gsStack` entry type and to `q`/`Q`:

```ts
  const gsStack: { ctm: Matrix; lineWidth: number; fill: PathPaint; stroke: PathPaint; fillConv: ColorConverter; strokeConv: ColorConverter }[] = [];
```
```ts
        case 'q': gsStack.push({ ctm, lineWidth, fill, stroke, fillConv, strokeConv }); break;
        case 'Q': { const g = gsStack.pop(); if (g) { ctm = g.ctm; lineWidth = g.lineWidth; fill = g.fill; stroke = g.stroke; fillConv = g.fillConv; strokeConv = g.strokeConv; } break; }
```

Add a `setColor` closure inside `walk` (before the `for` loop):

```ts
  const setColor = (operands: readonly PdfObject[], isStroke: boolean) => {
    const hasPattern = operands.length > 0 && isName(operands[operands.length - 1]);
    const comps = nums(operands);
    const conv = isStroke ? strokeConv : fillConv;
    const space = isStroke ? stroke.space : fill.space;
    const paint: PathPaint = hasPattern
      ? { rgb: comps.length ? conv.toRgb(comps) : [0, 0, 0], space: 'Pattern' }
      : { rgb: conv.toRgb(comps), space };
    if (isStroke) stroke = paint; else fill = paint;
  };
```

Add the color-space cases to the switch (alongside the device color ops):

```ts
        case 'cs': { const { conv, space } = lookupCs(ctx.doc, resources, op.operands[0]); fillConv = conv; fill = { rgb: conv.initial(), space }; break; }
        case 'CS': { const { conv, space } = lookupCs(ctx.doc, resources, op.operands[0]); strokeConv = conv; stroke = { rgb: conv.initial(), space }; break; }
        case 'sc': case 'scn': setColor(op.operands, false); break;
        case 'SC': case 'SCN': setColor(op.operands, true); break;
```

Remove the `void resources;` from the end of `walk` (resources is now used); keep `void depth; void seen;` until Task 3.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (6 tests). `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts test/helpers/build-paths-pdf.ts test/paths.test.ts
git commit -m "feat(8i9): resolve colorspaces for GetPaths fill/stroke paint"
```

---

### Task 3: Form XObject recursion

**Files:**
- Modify: `src/paths.ts`
- Modify: `test/helpers/build-paths-pdf.ts`
- Modify: `test/paths.test.ts`

**Interfaces:**
- Consumes: `isStream`, `isName` (already imported); `inflateStream` (already imported); `mul` (already imported).
- Produces: `walk` recurses on `Do` into Form XObjects; child paths carry the composed CTM and `addr.path` = the XObject-name chain.

- [ ] **Step 1: Add a Form-XObject fixture**

In `test/helpers/build-paths-pdf.ts`:

```ts
/** A page that draws a Form XObject (named /Fm0) under a 2x scale + (100,100)
 *  translate. The form fills a 0 0 20 20 rectangle in blue. So in device space
 *  the rectangle is [100,100,140,140]. MediaBox 0 0 200 200. */
export function buildXObjectPathPdf(): Uint8Array {
  const page = 'q 2 0 0 2 100 100 cm /Fm0 Do Q';
  const form = '0 0 1 rg 0 0 20 20 re f';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(page);
  objects[5] = `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${byteLen(form)} >>\nstream\n${form}\nendstream`;
  return assemble(objects, 5, 1);
}
```

- [ ] **Step 2: Write the failing test**

Add to `test/paths.test.ts`:

```ts
import { buildXObjectPathPdf } from './helpers/build-paths-pdf.js';

describe('GetPaths — Form XObjects', () => {
  it('descends into a Form XObject and composes the CTM', () => {
    const p = Document.Open(buildXObjectPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(1);
    expect(p[0].fill!.space).toBe('DeviceRGB');
    expect(p[0].fill!.rgb).toEqual([0, 0, 255]);
    // 0 0 20 20 rect scaled 2x + translate (100,100) -> [100,100,140,140]
    expect(p[0].bbox).toEqual([100, 100, 140, 140]);
    expect(p[0].addr.path).toEqual(['Fm0']);
    // subpaths remain in the form's own user space (unscaled)
    expect(p[0].bbox).not.toEqual([0, 0, 20, 20]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/paths.test.ts -t "Form XObject"`
Expected: FAIL — `p.length` is 0 (`Do` not handled).

- [ ] **Step 4: Implement the `Do` case**

In `src/paths.ts`, extend imports to include `isStream`/`isName` (add to the `./types.js` import) and add a `Do` case to the switch:

```ts
        case 'Do': {
          const xn = op.operands[0];
          const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
          if (!isName(xn) || !xobjects) break;
          const xo = ctx.doc.resolve(xobjects.get(xn.name));
          if (!isStream(xo)) break;
          const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
          if (!(isName(sub) && sub.name === 'Form')) break;   // images/others: no paths
          if (depth >= MAX_XOBJECT_DEPTH || seen.has(xo.dict)) break;
          seen.add(xo.dict);
          const mat = nums(ctx.doc.resolve(xo.dict.get('Matrix')) as PdfObject[] | undefined ?? []);
          const childCtm = mat.length === 6 ? mul(mat as Matrix, ctm) : ctm;
          const childRes = resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources;
          let childBytes: Uint8Array;
          try { childBytes = inflateStream(xo as Parameters<typeof inflateStream>[0]); }
          catch { seen.delete(xo.dict); break; }
          walk(ctx, [{ bytes: childBytes, streamIndex: 0 }], childRes, [...path, xn.name], childCtm, depth + 1, seen);
          seen.delete(xo.dict);
          break;
        }
```

Remove the remaining `void depth; void seen;` line (both are now used).

Note: `nums(ctx.doc.resolve(...) as PdfObject[] | undefined ?? [])` — when `/Matrix` is absent, `resolve` returns the passed value; guard with `?? []` and rely on `nums` filtering. If `resolve(undefined)` does not return an array, `nums` receives `[]` — verify `nums` tolerates a non-array by wrapping: use `const mo = ctx.doc.resolve(xo.dict.get('Matrix')); const mat = isArray(mo) ? nums(mo) : [];` instead, and ensure `isArray` is imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (7 tests). `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts test/helpers/build-paths-pdf.ts test/paths.test.ts
git commit -m "feat(8i9): recurse into Form XObjects in GetPaths"
```

---

### Task 4: Marked-content (mcid / artifact)

**Files:**
- Modify: `src/paths.ts`
- Modify: `test/helpers/build-paths-pdf.ts`
- Modify: `test/paths.test.ts`

**Interfaces:**
- Consumes: `isDict`, `isName` (already imported).
- Produces: `PagePath.mcid` and `PagePath.artifact` populated from the active `BDC`/`BMC`/`EMC` scope.

- [ ] **Step 1: Add a marked-content fixture**

In `test/helpers/build-paths-pdf.ts`:

```ts
/** A page with a path inside a tagged marked-content sequence (MCID 3) and a
 *  second path inside an /Artifact scope. MediaBox 0 0 100 100. */
export function buildTaggedPathPdf(): Uint8Array {
  const content = [
    '/P0 BDC 0 0 0 rg 10 10 20 20 re f EMC',
    '/Artifact BMC 1 0 0 rg 40 40 20 20 re f EMC',
  ].join('\n');
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /P0 << /MCID 3 >> >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  return assemble(objects, 4, 1);
}
```

Note the `BDC` operand is `/P0 <</MCID 3>>` in the file — but here `/P0 BDC` references a named property in `/Resources /Properties`. Both forms occur; the implementation handles both. This fixture uses the **named** form.

- [ ] **Step 2: Write the failing test**

Add to `test/paths.test.ts`:

```ts
import { buildTaggedPathPdf } from './helpers/build-paths-pdf.js';

describe('GetPaths — marked content', () => {
  it('carries MCID and artifact flags', () => {
    const p = Document.Open(buildTaggedPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(2);
    const tagged = p.find((x) => x.mcid === 3);
    expect(tagged).toBeDefined();
    expect(tagged!.artifact).toBeFalsy();
    const art = p.find((x) => x.artifact === true);
    expect(art).toBeDefined();
    expect(art!.mcid).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/paths.test.ts -t "marked content"`
Expected: FAIL — `mcid`/`artifact` are undefined on both paths.

- [ ] **Step 4: Implement marked-content tracking**

In `src/paths.ts`, add module-level helpers (after `csFamily`):

```ts
const isArtifactTag = (o: PdfObject | undefined): boolean =>
  !!o && isName(o) && o.name === 'Artifact';

/** MCID from a BDC properties operand: an inline dict, or a name resolved via
 *  /Resources /Properties. undefined when absent. */
function mcidOf(doc: Document, properties: PdfDict | undefined, operand: PdfObject | undefined): number | undefined {
  let d: PdfDict | undefined;
  if (isDict(operand)) d = operand;
  else if (isName(operand)) d = resolveDict(doc, properties?.get(operand.name));
  const m = d ? doc.resolve(d.get('MCID')) : undefined;
  return typeof m === 'number' ? m : undefined;
}
```

Inside `walk`, after computing `resources`-derived dicts, add marked-content state (before the `for` loop):

```ts
  const properties = resolveDict(ctx.doc, resources?.get('Properties'));
  const mcidStack: (number | undefined)[] = [];
  const artStack: boolean[] = [];
  let activeMcid: number | undefined;
  let inArtifact = false;
```

Add cases to the switch:

```ts
        case 'BMC': mcidStack.push(activeMcid); artStack.push(inArtifact); if (isArtifactTag(op.operands[0])) inArtifact = true; break;
        case 'BDC': {
          mcidStack.push(activeMcid); artStack.push(inArtifact);
          if (isArtifactTag(op.operands[0])) inArtifact = true;
          const m = mcidOf(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) activeMcid = m;
          break;
        }
        case 'EMC': if (mcidStack.length) activeMcid = mcidStack.pop(); if (artStack.length) inArtifact = artStack.pop()!; break;
```

Update `emit` to record them (add to the pushed object, before `addr`):

```ts
      mcid: activeMcid,
      artifact: inArtifact || undefined,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (8 tests). `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts test/helpers/build-paths-pdf.ts test/paths.test.ts
git commit -m "feat(8i9): track mcid/artifact for extracted paths"
```

---

### Task 5: Round-trip test, README docs, full green, close issue

**Files:**
- Modify: `test/paths.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation + save round-trip coverage; issue closed.

- [ ] **Step 1: Add a save round-trip test**

Add to `test/paths.test.ts`:

```ts
describe('GetPaths — round-trip', () => {
  it('extracts identically after Save/Open', () => {
    const before = Document.Open(buildPathsPdf()).Pages[0].GetPaths();
    const saved = Document.Open(buildPathsPdf()).Save();
    const after = Document.Open(saved).Pages[0].GetPaths();
    expect(after.length).toBe(before.length);
    expect(after.map((x) => x.bbox)).toEqual(before.map((x) => x.bbox));
    expect(after.map((x) => x.fill?.rgb ?? null)).toEqual(before.map((x) => x.fill?.rgb ?? null));
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Document in README**

In `README.md`, add a bullet to the Features list (near the text/image extraction and barcode entries) and an API-overview subsection. Feature bullet:

```markdown
- **Vector path extraction** — `page.GetPaths()` returns the page's painted
  vector graphics as positioned `PagePath` objects: subpaths (lines + cubic
  beziers) in user space, the CTM at paint time, a device-space bounding box,
  resolved fill/stroke color (sRGB 0–255) with its colorspace family, fill rule,
  stroke line width, clip usage, and marked-content (`mcid`/`artifact`).
  Descends into nested Form XObjects. Shadings/gradients are reported as
  `space:'Pattern'` (not evaluated); dash/cap/join are out of scope.
```

Place the API-overview subsection next to the "Text extraction" section, describing the `PagePath`/`PathSubpath`/`PathSegment`/`PathPaint` shape and that geometry is raw user-space + CTM (multiply to get device coordinates), while `bbox` is precomputed device-space. Keep it consistent with the wording in the design spec's "Public API" section.

- [ ] **Step 4: Full suite + typecheck**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; all tests pass (existing 1963 + the new paths tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add README.md test/paths.test.ts
git commit -m "docs(8i9): document page.GetPaths vector path extraction"
```

- [ ] **Step 6: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-8i9 --reason "page.GetPaths() extracts positioned vector paths (subpaths+CTM, device bbox, resolved fill/stroke color+space, fill rule, line width, clip, mcid/artifact); covers nested Form XObjects; README documented."
```

---

## Self-Review Notes

- **Spec coverage:** device-space geometry + CTM (Task 1 bbox/ctm), paint color + space (Tasks 1–2), stroke/fill kind + fill rule + line width + clip (Task 1), nested Form XObjects (Task 3), mcid/artifact (Task 4), fixture match + round-trip (Tasks 1–5), README (Task 5). All acceptance criteria mapped.
- **Emission rule:** one path per paint op; `n` emits only with a pending clip (Task 1 `emit`).
- **Type consistency:** `PagePath`/`PathSubpath`/`PathSegment`/`PathPaint`, `extractPaths`, `GetPaths` names are identical across tasks; `fill`/`stroke`/`fillConv`/`strokeConv`/`pendingClip`/`activeMcid`/`inArtifact` state names are consistent.
- **No-throw invariant:** parse/decode failures `continue`/`break` without throwing; wrong-arity ops guarded by `n.length` checks.
