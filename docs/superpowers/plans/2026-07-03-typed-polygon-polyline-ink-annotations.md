# Typed Polygon / Polyline / Ink Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed handle classes, `Page.Add*` create APIs, live accessors, and generated `/AP /N` appearance streams for `/Polygon`, `/PolyLine`, and `/Ink`.

**Architecture:** Mirror the Line/Square/Circle work in `src/annotation.ts`: a live-dict handle subclass per shape (`PolyAnnotation` shared by Polygon/PolyLine, `InkAnnotation` for Ink), a `createAnnotation`-based `add*` factory that validates before allocating, and a content-stream `/AP` built via `installShapeAP`. `Page` methods are thin wrappers. Reuse existing helpers: `checkOptColor`, `checkOptWidth`, `checkOptOpacity`, `installShapeAP`, `paintOp`, `drawEnding`, `widgetGeom`, `quadsBBox`, `LINE_ENDINGS`, `setBorderWidth`, `readBorderWidth`, `num`, `numArray`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest, zero runtime deps.

## Global Constraints
- Zero runtime deps; ESM + NodeNext (`.js` specifiers).
- Live-mutation model; validate-before-attach (no stranded objects on invalid input).
- Errors: `TypeError`/`RangeError` for bad public input.
- Colors RGB 0..1; coordinates PDF user space (points).
- `npm run typecheck` and `npm test` green before closing.
- Keep `README.md` in sync.

---

### Task 1: `PolyAnnotation` + `InkAnnotation` read model + dispatch + fixture

**Files:** `src/annotation.ts` (classes after `LineAnnotation`; dispatch in `wrapAnnotation`), `test/helpers/build-annot-target.ts` (`buildPathReadTarget`), `test/annotation.test.ts`.

**Produces:**
- `export type PolyType = 'polygon' | 'polyline'`
- module helper `readNumList(doc, o): number[]` (all resolved finite numbers, `[]` otherwise) and `checkVertices(key, v): number[]` (even length ≥ 4).
- `export class PolyAnnotation extends Annotation` — `PolyType`, `Vertices`, `InteriorColor`, `BorderWidth`, `LineEndings`.
- `export class InkAnnotation extends Annotation` — `InkList` (`number[][]`), `BorderWidth`.
- `export function buildPathReadTarget(): Uint8Array`.

**Steps:**
- [ ] Write failing tests: wrap `/Polygon`→`PolyAnnotation` (`PolyType==='polygon'`, `Vertices`, `InteriorColor`, `BorderWidth`), `/PolyLine`→`PolyAnnotation` (`PolyType==='polyline'`, `LineEndings`), `/Ink`→`InkAnnotation` (`InkList` two strokes, `BorderWidth`). Round-trip setters + rejection (odd/short vertices, bad IC, bad ink stroke).
- [ ] Run `npx vitest run test/annotation.test.ts -t "read model"` for the new blocks → FAIL.
- [ ] Add `buildPathReadTarget` fixture: page with `/Polygon` (`/Vertices [10 10 90 10 50 60] /IC [1 1 0] /BS <</Type/Border/W 2>>`), `/PolyLine` (`/Vertices [10 100 90 100 90 160] /LE [/None /OpenArrow]`), `/Ink` (`/InkList [[10 10 40 40] [50 50 80 20]]`).
- [ ] Add the two handle classes + `readNumList`/`checkVertices` helpers + dispatch cases (`Polygon`, `PolyLine` → `PolyAnnotation`; `Ink` → `InkAnnotation`).
- [ ] Run tests → PASS.
- [ ] Commit `feat(g6p): Polygon/Polyline/Ink read model + dispatch`.

Handle sketch:
```ts
export type PolyType = 'polygon' | 'polyline';

/** All resolved finite numbers in array `o`; [] when not an array. */
function readNumList(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number' && Number.isFinite(v)) out.push(v); }
  return out;
}

/** Validate an even-length (≥4) list of finite numbers; returns a copy. */
function checkVertices(key: string, v: number[]): number[] {
  if (!Array.isArray(v) || v.length < 4 || v.length % 2 !== 0 ||
      !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError(`${key} must be an even-length list of ≥4 finite numbers`);
  return [...v];
}

export class PolyAnnotation extends Annotation {
  get PolyType(): PolyType { return this.Subtype === 'PolyLine' ? 'polyline' : 'polygon'; }
  get Vertices(): number[] { return readNumList(this.doc, this.Dict.get('Vertices')); }
  set Vertices(v: number[]) { this.Dict.set('Vertices', checkVertices('Vertices', v)); this.touch(); }
  get InteriorColor() { /* /IC, as SquareCircle */ }
  set InteriorColor(v) { /* … */ }
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }
  get LineEndings(): [LineEnding, LineEnding] | undefined { /* /LE, as LineAnnotation */ }
  set LineEndings(v) { /* … */ }
}

export class InkAnnotation extends Annotation {
  get InkList(): number[][] {
    const a = this.doc.resolve(this.Dict.get('InkList'));
    return isArray(a) ? a.map((s) => readNumList(this.doc, s)).filter((s) => s.length >= 2) : [];
  }
  set InkList(v: number[][]) {
    if (!Array.isArray(v) || v.length === 0) throw new TypeError('InkList must be a non-empty array of strokes');
    this.Dict.set('InkList', v.map((s) => checkVertices('ink stroke', s)));
    this.touch();
  }
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }
}
```

---

### Task 2: `AddPolygon` / `AddPolyline` create API + appearance

**Files:** `src/annotation.ts` (`PolygonOptions`, `PolylineOptions`, `addPolygon`, `addPolyline`, shared `verticesRect`/`polyBody`), `src/page.ts` (import + methods), `test/annotation.test.ts`.

**Produces:**
- `export interface PolygonOptions { vertices; popup?; color?; fill?; width?; contents?; opacity? }`
- `export interface PolylineOptions { vertices; popup?; color?; width?; startEnding?; endEnding?; contents?; opacity? }`
- `export function addPolygon(doc, page, opts): PolyAnnotation`
- `export function addPolyline(doc, page, opts): PolyAnnotation`
- `Page.AddPolygon`, `Page.AddPolyline`.

**Steps:**
- [ ] Write failing tests (use `apOps` helper + `buildBlankPage` as in the AddSquare block):
  - `AddPolygon` closed filled+stroked: `/Subtype Polygon`, `Vertices` set, `InteriorColor`, `BorderWidth`; `/Rect` encloses vertices; ops contain `m`,`l`,`h`,`B` (no `re`).
  - `AddPolyline` open with `endEnding:'OpenArrow'`: `LineEndings==['None','OpenArrow']`; ops contain `m`,`l`,`S` and no `h`.
  - opacity via `/GS0`; validation before attach (odd vertices, bad ending, bad color) leaves `Annotations` empty.
- [ ] Run `-t "AddPolygon"` / `-t "AddPolyline"` → FAIL.
- [ ] Implement. `verticesRect(vertices, margin)` → `[minX-margin,…]` via `quadsBBox`. `polyBody(pts, close, color, fill, width)` emits `m`/`l`/(optional `h`)/paint. Polyline adds `drawEnding` at both ends. Translate points into form space with `x - rectMinX`, `y - rectMinY`.
- [ ] Run → PASS.
- [ ] Commit `feat(g6p): AddPolygon/AddPolyline with generated appearance`.

---

### Task 3: `AddInk` create API + appearance

**Files:** `src/annotation.ts` (`InkOptions`, `addInk`), `src/page.ts` (import + method), `test/annotation.test.ts`.

**Produces:**
- `export interface InkOptions { paths; popup?; color?; width?; contents?; opacity? }`
- `export function addInk(doc, page, opts): InkAnnotation`
- `Page.AddInk`.

**Steps:**
- [ ] Write failing tests: `AddInk` with two strokes → `/Subtype Ink`, `InkList` length 2, `/Rect` encloses all points, ops contain two `m` + `l` + `S`; opacity `/GS0`; validation before attach (empty paths, odd stroke) leaves `Annotations` empty.
- [ ] Run `-t "AddInk"` → FAIL.
- [ ] Implement: bbox over all points, per-stroke `m`…`l` `S` body, `installShapeAP`.
- [ ] Run → PASS; then `npx vitest run test/annotation.test.ts && npm run typecheck`.
- [ ] Commit `feat(g6p): AddInk with multi-stroke appearance`.

---

### Task 4: README docs + full-suite verification + close

**Files:** `README.md`.

**Steps:**
- [ ] Add to the annotations example: `page.AddPolygon(...)`, `page.AddPolyline(...)`, `page.AddInk(...)`.
- [ ] Typed-handle paragraph: add `PolyAnnotation` (`PolyType`/`Vertices`/`InteriorColor`/`BorderWidth`/`LineEndings`) and `InkAnnotation` (`InkList`/`BorderWidth`).
- [ ] API table: rows for `page.AddPolygon/AddPolyline/AddInk`.
- [ ] Limitations note: replace the residual set — drop `Ink`, `Polygon`/`Polyline`; the create/edit list gains the path shapes.
- [ ] `npm run typecheck && npm test` → green.
- [ ] Commit `docs(g6p): document AddPolygon/AddPolyline/AddInk`.
- [ ] `bd close aspose-pdf-foss-for-ts-g6p`.

---

## Notes for the implementer
- `quadsBBox(flat)` iterates coordinate pairs over any even-length flat list — reuse it for vertices and (concatenated) ink points.
- `drawEnding(px,py,dx,dy,ending,size,color)` expects an outward unit direction; reuse the Line derivation.
- Keep the `/GS0` opacity path identical to `installShapeAP` (already handles it).
- Zero-area `/Rect` → skip appearance (annotation still created), matching `addLine`.
