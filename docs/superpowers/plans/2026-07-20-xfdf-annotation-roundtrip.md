# XFDF / FDF Annotation Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry annotations through the FDF and XFDF data-exchange formats, alongside the form-field values that already travel there.

**Architecture:** The format-neutral model is the PDF annotation dictionary itself, made self-contained by inlining every reference it reaches. `annotdata.ts` is the only module that touches pages; `xfdfannot.ts` maps the dict to/from XML through one declarative attribute table; `fdfannot.ts` writes and reads the same dict as a PDF object subgraph. Appearance streams travel verbatim, with property-based regeneration as the fallback.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies (`node:` built-ins only).

Spec: `docs/superpowers/specs/2026-07-20-xfdf-annotation-roundtrip-design.md`
Issue: `aspose-pdf-foss-for-ts-73p`

## Global Constraints

- **Zero runtime dependencies.** Only `node:zlib`, `node:crypto`, `node:fs`. Do not add npm runtime deps.
- **ESM + NodeNext, `strict` TypeScript.** Every import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **`PdfDict` is `Map<string, PdfObject>`** keyed by name *without* the leading `/`. Names, strings, refs and streams are tagged objects — use the `isDict` / `isRef` / `isName` / `isStream` / `isArray` / `isString` guards from `types.js`.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `errors.js`.
- **Annotation-level problems are reported, never thrown.** `PdfParseError` is reserved for a container that cannot be read at all. This is the rule e1p established and it holds throughout.
- **Run `npm run typecheck` and `npm test` before closing.** Both must be green.
- **Target a single test file** with `npx vitest run test/<name>.test.ts`.
- Commit after every task. Message style: `feat(xfdf): …`, `refactor(annot): …`, `test(xfdf): …`, `docs(xfdf): …`, matching recent history.

## Spec Refinement (decided while planning, supersedes the spec on one point)

The spec's §"Cross-references between annotations" said `/Popup` and `/IRT` survive the FDF path "as refs" from the deep copy. Inlining a subgraph that contains `/Popup` → popup annot → `/Parent` → back is a **reference cycle**, and a self-contained dict cannot hold one.

So both formats normalize the same way, in `annotdata.ts` rather than per-format: `/Popup`, `/IRT`, `/P`, `/Parent` and `/StructParent` are **stripped from the dict**, and the two that carry meaning are lifted into explicit neutral-model fields (`popupName`, `inReplyTo`) that reference sibling annotations by `/NM`. Popups are exported as their own `AnnotData` entries. Import's two-pass name resolution then rebuilds real refs, identically for FDF and XFDF.

Outcome is what the spec promised — popup and reply links survive both formats — by a mechanism that cannot cycle and keeps the two formats symmetric. **Record this as an "As built:" note in the spec during Task 10.**

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/annotdraw.ts` | Appearance *generation* moved out of `annotation.ts`: the drawing-body functions, `installShapeAP`, and the new `regenerateAppearance(doc, dict)` that drives them from a dict instead of an options object. |
| `src/annotdata.ts` | Format-neutral middle. `AnnotData`, ref inlining/allocation, `collectAnnots`, `applyAnnots`. The only new module that touches pages or `/Annots`. |
| `src/xfdfannot.ts` | `<annots>` ↔ `AnnotData[]`; owns the attribute table and the `<appearance>` codec. |
| `src/fdfannot.ts` | `/Annots` ↔ `AnnotData[]` as a PDF object subgraph. |
| `test/annotdraw.test.ts`, `test/annotdata.test.ts`, `test/xfdfannot.test.ts`, `test/fdfannot.test.ts`, `test/annot-roundtrip.test.ts` | Per-module and end-to-end tests. |
| `test/helpers/build-annot-roundtrip.ts` | Fixture: one 2-page document carrying one annotation of each exercised subtype. |

**Modify:**

| File | Change |
|---|---|
| `src/annotation.ts` | Drawing helpers move out to `annotdraw.ts`; imports them back. Model and `Add*` API unchanged. |
| `src/fdf.ts` | `writeFdf` emits `/Annots` and the objects it needs; `readFdf` reads them. |
| `src/xfdf.ts` | `writeXfdf`/`readXfdf` emit and read the `<annots>` element. |
| `src/formdata.ts` | `FormData` gains `annots?`; `ExportFormDataOptions` gains `annotations?`; `ImportReport` gains `importedAnnots`/`skippedAnnots`; new `ImportOptions`. |
| `src/document.ts` | The four methods take the new options. |
| `src/node.ts` | The four wrappers take the new options. |
| `src/index.ts` | Export the new public types. |
| `README.md` | Options, report shape, limitations. |

---

### Task 1: Extract appearance generation and drive it from a dict

`annotation.ts` is 1733 lines and its appearance generators are welded into the `add*` creation functions, which take options objects. Import needs to generate an appearance for a dict that already exists. This task moves generation out and adds that entry point. **No behaviour changes** — the `Add*` API and its tests must stay green untouched.

**Files:**
- Create: `src/annotdraw.ts`
- Create: `test/annotdraw.test.ts`
- Modify: `src/annotation.ts` (remove the moved functions, import them back)

**Interfaces:**
- Consumes: `widgetGeom(doc, dict): WidgetGeom | undefined`, `buildAppearanceXObject(doc, g, std, fontKey, body): PdfStream`, `installAP(doc, dict, stream): void` from `appearance.js`.
- Produces:
  ```ts
  export function regenerateAppearance(doc: Document, dict: PdfDict): boolean;
  export function installShapeAP(doc: Document, dict: PdfDict, g: WidgetGeom, body: string, opacity: number): void;
  export function drawRect(g: WidgetGeom, color: RGB, fill: RGB | undefined, width: number): string;
  export function drawEllipse(g: WidgetGeom, color: RGB, fill: RGB | undefined, width: number): string;
  export function drawHighlight(qs: QuadCorners[], color: RGB): string;
  export function drawUnderline(qs: QuadCorners[], color: RGB): string;
  export function drawStrikeOut(qs: QuadCorners[], color: RGB): string;
  export function drawSquiggly(qs: QuadCorners[], color: RGB): string;
  export type RGB = [number, number, number];
  ```

- [ ] **Step 1: Move the drawing helpers verbatim**

Cut these module-private functions from `src/annotation.ts` into a new `src/annotdraw.ts`, **unchanged**, and `export` each: `paintOp`, `drawRect`, `drawEllipse`, `drawHighlight`, `quadSpan`, `strokeLines`, `drawSquiggly`, `installShapeAP`, `rot`, `drawEnding`, `paddedRect`, `toFormSpace`, `unitDir`, `polyPathBody`, `freeTextBoxBody`, and the local `num` helper.

`strokeLines` currently backs underline and strikeout via different `frac` values. Export the two named wrappers the interface block promises:

```ts
/** Underline: a stroke along the bottom edge of each quad. */
export function drawUnderline(qs: QuadCorners[], color: RGB): string {
  return strokeLines(qs, color, 0.06);
}

/** Strike-out: a stroke through the middle of each quad. */
export function drawStrikeOut(qs: QuadCorners[], color: RGB): string {
  return strokeLines(qs, color, 0.5);
}
```

Read the existing `addUnderline` / `addStrikeOut` call sites in `annotation.ts` first and copy **their** `frac` arguments into these two wrappers — the values above are the expected ones, but the call sites are authoritative. Then rewrite those two `add*` functions to call the wrappers.

`src/annotdraw.ts` needs this header:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isStream, name } from './types.js';
import { widgetGeom, buildAppearanceXObject, installAP, type WidgetGeom } from './appearance.js';
import type { QuadCorners } from './annotation.js';

export type RGB = [number, number, number];
```

- [ ] **Step 2: Import them back into `annotation.ts`**

Add to `src/annotation.ts`:

```ts
import {
  installShapeAP, drawRect, drawEllipse, drawHighlight, drawUnderline,
  drawStrikeOut, drawSquiggly, drawEnding, polyPathBody, freeTextBoxBody,
  paddedRect, toFormSpace, unitDir, rot, paintOp,
} from './annotdraw.js';
```

Trim that list to exactly what remains referenced in `annotation.ts` — an unused import is a `strict` build error.

- [ ] **Step 3: Verify the move changed nothing**

Run: `npm run typecheck && npx vitest run test/annotation.test.ts test/annotappearance.test.ts test/annotrender.test.ts test/flatten-annotations.test.ts`
Expected: PASS, no test edits. A failure here means the move was not verbatim — fix it before continuing.

- [ ] **Step 4: Commit the pure refactor separately**

```bash
git add src/annotdraw.ts src/annotation.ts
git commit -m "refactor(annot): move appearance generation into annotdraw.ts"
```

Committing the move on its own keeps the next diff readable as new behaviour.

- [ ] **Step 5: Write the failing test for `regenerateAppearance`**

Create `test/annotdraw.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { regenerateAppearance } from '../src/annotdraw.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';

/** A bare annotation dict of `subtype`, attached to page 0 of a fresh doc. */
function attach(subtype: string, entries: [string, PdfObject][]): { doc: Document; dict: PdfDict } {
  const doc = Document.Open(buildAnnotTarget());
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name(subtype)],
    ...entries,
  ]);
  return { doc, dict };
}

/** The decoded /AP /N content stream, or undefined when there is none. */
function apBody(doc: Document, dict: PdfDict): string | undefined {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve(ap.get('N'));
  return isStream(n) ? new TextDecoder('latin1').decode(n.raw) : undefined;
}

describe('regenerateAppearance', () => {
  it('draws a square from /Rect, /C, /IC and /BS /W', () => {
    const { doc, dict } = attach('Square', [
      ['Rect', [10, 10, 110, 60]],
      ['C', [1, 0, 0]],
      ['IC', [0, 0, 1]],
      ['BS', new Map<string, PdfObject>([['W', 2]])],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' re');          // a rectangle path
    expect(body).toContain('1 0 0 RG');     // stroke colour from /C
    expect(body).toContain('0 0 1 rg');     // fill colour from /IC
    expect(body).toContain('2 w');          // width from /BS /W
  });

  it('draws a circle as Béziers, not a rectangle', () => {
    const { doc, dict } = attach('Circle', [['Rect', [0, 0, 80, 40]], ['C', [0, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' c\n');
    expect(body).not.toContain(' re');
  });

  it('draws a highlight from /QuadPoints and applies /CA', () => {
    const { doc, dict } = attach('Highlight', [
      ['Rect', [0, 0, 100, 20]],
      ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]],
      ['C', [1, 1, 0]],
      ['CA', 0.4],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain('1 1 0 rg');
    expect(body).toContain('/GS0 gs');      // opacity < 1 installs an ExtGState
  });

  it('returns false and installs nothing for a subtype with no generator', () => {
    const { doc, dict } = attach('Sound', [['Rect', [0, 0, 20, 20]]]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });

  it('returns false for a degenerate /Rect rather than dividing by zero', () => {
    const { doc, dict } = attach('Square', [['Rect', [10, 10, 10, 10]], ['C', [0, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: FAIL — `regenerateAppearance is not a function` / not exported.

- [ ] **Step 7: Implement `regenerateAppearance`**

Append to `src/annotdraw.ts`. It reads from the dict what the `add*` functions read from options:

```ts
/** RGB from an annotation colour array; undefined when absent or not 3-component. */
function colorOf(doc: Document, o: PdfObject | undefined): RGB | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length !== 3) return undefined;
  const c = a.map((x) => doc.resolve(x));
  if (!c.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  return [c[0] as number, c[1] as number, c[2] as number];
}

/** Border width from /BS /W, defaulting to 1 as the Add* path does. */
function widthOf(doc: Document, dict: PdfDict): number {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) {
    const w = doc.resolve(bs.get('W'));
    if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w;
  }
  return 1;
}

/** A finite-number list from an array entry; [] when absent or malformed. */
function numsOf(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) {
    const v = doc.resolve(e);
    if (typeof v !== 'number' || !Number.isFinite(v)) return [];
    out.push(v);
  }
  return out;
}

/** Quad-corner list in form space, given the annotation's /Rect origin. */
function quadsOf(doc: Document, dict: PdfDict, minX: number, minY: number): QuadCorners[] {
  const q = numsOf(doc, dict.get('QuadPoints'));
  if (q.length === 0 || q.length % 8 !== 0) return [];
  return offsetQuads(q, minX, minY);
}

/** Regenerate the /AP /N appearance for an existing annotation dict, from the
 *  properties the dict already carries. Returns false when this subtype has no
 *  generator, or the geometry is too degenerate to draw — in which case the
 *  dict is left untouched, without an /AP. */
export function regenerateAppearance(doc: Document, dict: PdfDict): boolean {
  const sub = dict.get('Subtype');
  const subtype = isName(sub) ? sub.name : '';
  const g = widgetGeom(doc, dict);
  if (!g) return false;

  const rect = numsOf(doc, dict.get('Rect'));
  const minX = Math.min(rect[0] ?? 0, rect[2] ?? 0);
  const minY = Math.min(rect[1] ?? 0, rect[3] ?? 0);
  const color = colorOf(doc, dict.get('C')) ?? [0, 0, 0];
  const fill = colorOf(doc, dict.get('IC'));
  const width = widthOf(doc, dict);
  const caRaw = doc.resolve(dict.get('CA'));
  const opacity = typeof caRaw === 'number' && caRaw >= 0 && caRaw <= 1 ? caRaw : 1;

  let body: string | undefined;
  switch (subtype) {
    case 'Square':
      body = drawRect(g, color, fill, width);
      break;
    case 'Circle':
      body = drawEllipse(g, color, fill, width);
      break;
    case 'Highlight': case 'Underline': case 'StrikeOut': case 'Squiggly': {
      const qs = quadsOf(doc, dict, minX, minY);
      if (qs.length === 0) return false;
      const draw = subtype === 'Highlight' ? drawHighlight
        : subtype === 'Underline' ? drawUnderline
        : subtype === 'StrikeOut' ? drawStrikeOut
        : drawSquiggly;
      body = draw(qs, color);
      break;
    }
    default:
      return false;   // Text, Stamp, Link, Popup, Sound, Caret, FileAttachment,
                      // Line, Polygon, PolyLine, Ink, FreeText — see Step 8.
  }

  installShapeAP(doc, dict, g, body, opacity);
  return true;
}
```

`offsetQuads` is already exported from `annotation.ts`; import it: `import { offsetQuads, type QuadCorners } from './annotation.js';`

- [ ] **Step 8: Extend the switch to the geometry subtypes**

`Line`, `Polygon`, `PolyLine`, `Ink` and `FreeText` have generators in `annotdraw.ts` (`drawEnding`, `polyPathBody`, `freeTextBoxBody`). Read how `addLine`, `addPolygon`, `addPolyline`, `addInk` and `addFreeText` in `annotation.ts` assemble their bodies, and add a case per subtype that assembles the same body from dict entries instead of options:

- `Line` — `/L` (4 numbers) and `/LE` (2 names) via `drawEnding`
- `Polygon` / `PolyLine` — `/Vertices` via `polyPathBody`
- `Ink` — `/InkList` (array of arrays) via `polyPathBody` per stroke
- `FreeText` — `/Contents`, `/DA` via `freeTextBoxBody`

Each returns `false` when its geometry entry is absent or malformed, exactly as the `Square` path does. `Text`, `Stamp`, `Link`, `Popup`, `Sound`, `Caret` and `FileAttachment` keep returning `false` — a `Text` note is an icon the viewer draws, and a custom `Stamp` has no properties to draw from. Add a test per subtype in `test/annotdraw.test.ts` mirroring the `Square` test: assert `true`, and assert one distinctive operator in the body (`drawEnding` emits `l`/`m` path ops; `freeTextBoxBody` emits `BT`).

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: PASS, all cases.

- [ ] **Step 10: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. The refactor touched a heavily-used module; the whole suite is the gate.

- [ ] **Step 11: Commit**

```bash
git add src/annotdraw.ts test/annotdraw.test.ts
git commit -m "feat(annot): regenerate an appearance from an existing annotation dict"
```

---

### Task 2: Reference inlining and stream allocation

Two primitives the neutral model needs: making a dict self-contained by resolving its references inline, and the reverse — turning inline streams back into allocated indirect objects, since PDF has no inline stream syntax.

**Files:**
- Create: `src/annotdata.ts`
- Create: `test/annotdata.test.ts`

**Interfaces:**
- Consumes: `cloneShallow(o)`, `rewriteRefs(o, map)` from `extractor.js` (available, but the recursive walk below is simpler for this shape and is what the code uses).
- Produces:
  ```ts
  export function inlineRefs(doc: Document, o: PdfObject): PdfObject;
  export function allocStreams(doc: Document, o: PdfObject): PdfObject;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/annotdata.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { inlineRefs, allocStreams } from '../src/annotdata.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isRef, isStream, name } from '../src/types.js';

describe('inlineRefs', () => {
  it('replaces a reference with the object it points at', () => {
    const doc = Document.Open(buildAnnotTarget());
    const inner: PdfDict = new Map<string, PdfObject>([['X', 7]]);
    const dict: PdfDict = new Map<string, PdfObject>([['Sub', doc.allocObject(inner)]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    const sub = out.get('Sub');
    expect(isRef(sub)).toBe(false);
    expect(isDict(sub)).toBe(true);
    expect((sub as PdfDict).get('X')).toBe(7);
  });

  it('copies rather than aliasing, so edits do not touch the document', () => {
    const doc = Document.Open(buildAnnotTarget());
    const inner: PdfDict = new Map<string, PdfObject>([['X', 7]]);
    const dict: PdfDict = new Map<string, PdfObject>([['Sub', doc.allocObject(inner)]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    ((out.get('Sub')) as PdfDict).set('X', 99);
    expect(inner.get('X')).toBe(7);
  });

  it('inlines through arrays and stream dictionaries', () => {
    const doc = Document.Open(buildAnnotTarget());
    const font: PdfDict = new Map<string, PdfObject>([['BaseFont', name('Helvetica')]]);
    const res: PdfDict = new Map<string, PdfObject>([['Font', doc.allocObject(font)]]);
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Resources', doc.allocObject(res)]]),
      raw: new TextEncoder().encode('q Q'),
    };
    const dict: PdfDict = new Map<string, PdfObject>([['AP', [doc.allocObject(stream)]]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    const arr = out.get('AP') as PdfObject[];
    expect(isStream(arr[0])).toBe(true);
    const resOut = (arr[0] as { dict: PdfDict }).dict.get('Resources') as PdfDict;
    expect(isDict(resOut.get('Font'))).toBe(true);
  });

  it('breaks a reference cycle instead of recursing forever', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a: PdfDict = new Map<string, PdfObject>();
    const ref = doc.allocObject(a);
    a.set('Self', ref);
    const out = inlineRefs(doc, a) as PdfDict;
    const self = out.get('Self') as PdfDict;
    expect(self.get('Self')).toBe(null);   // the cycle terminates in null
  });
});

describe('allocStreams', () => {
  it('replaces an inline stream with a reference to an allocated object', () => {
    const doc = Document.Open(buildAnnotTarget());
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>(),
      raw: new TextEncoder().encode('q Q'),
    };
    const dict: PdfDict = new Map<string, PdfObject>([
      ['AP', new Map<string, PdfObject>([['N', stream]])],
    ]);
    const out = allocStreams(doc, dict) as PdfDict;
    const ap = out.get('AP') as PdfDict;
    const n = ap.get('N');
    expect(isRef(n)).toBe(true);
    expect(isStream(doc.resolve(n))).toBe(true);
  });

  it('leaves a dict with no streams unchanged in value', () => {
    const doc = Document.Open(buildAnnotTarget());
    const dict: PdfDict = new Map<string, PdfObject>([['Rect', [0, 0, 1, 1]]]);
    const out = allocStreams(doc, dict) as PdfDict;
    expect(out.get('Rect')).toEqual([0, 0, 1, 1]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/annotdata.test.ts`
Expected: FAIL — cannot resolve `../src/annotdata.js`.

- [ ] **Step 3: Implement the two primitives**

Create `src/annotdata.ts`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isRef, isStream } from './types.js';

/** Deep-copy `o`, resolving every reference to the object it points at, so the
 *  result stands alone with no dependency on the document's object map.
 *
 *  A reference already on the current path resolves to null: annotation
 *  subgraphs can cycle (/Popup → popup → /Parent → back), and a self-contained
 *  value cannot hold a cycle. Callers strip the cycling keys before calling
 *  this, so the guard is a backstop, not the mechanism. */
export function inlineRefs(doc: Document, o: PdfObject): PdfObject {
  const path = new Set<number>();

  const walk = (v: PdfObject): PdfObject => {
    if (isRef(v)) {
      const r = v as PdfRef;
      if (path.has(r.num)) return null;
      path.add(r.num);
      const out = walk(doc.resolve(v));
      path.delete(r.num);
      return out;
    }
    if (isArray(v)) return v.map(walk);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, walk(e));
      return out;
    }
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, walk(e));
      return { kind: 'stream', dict, raw: v.raw };
    }
    return v;
  };

  return walk(o);
}

/** Deep-copy `o`, replacing every inline stream with a reference to a freshly
 *  allocated object. PDF has no inline stream syntax, so a self-contained dict
 *  carrying streams has to be re-hydrated this way before it goes into a
 *  document. */
export function allocStreams(doc: Document, o: PdfObject): PdfObject {
  const walk = (v: PdfObject): PdfObject => {
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, walk(e));
      return doc.allocObject({ kind: 'stream', dict, raw: v.raw });
    }
    if (isArray(v)) return v.map(walk);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, walk(e));
      return out;
    }
    return v;
  };

  return walk(o);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/annotdata.test.ts`
Expected: PASS, six cases.

- [ ] **Step 5: Commit**

```bash
git add src/annotdata.ts test/annotdata.test.ts
git commit -m "feat(annot): reference inlining and stream allocation for the neutral model"
```

---

### Task 3: `collectAnnots` — the export side

**Files:**
- Modify: `src/annotdata.ts`
- Modify: `test/annotdata.test.ts`
- Create: `test/helpers/build-annot-roundtrip.ts`

**Interfaces:**
- Consumes: `inlineRefs` (Task 2); `doc.Pages`, `page.Dict`, `page.Annotations` from `document.js` / `page.js`.
- Produces:
  ```ts
  export interface AnnotData {
    page: number;              // 0-based page index
    dict: PdfDict;             // self-contained; /P /Parent /StructParent /Popup /IRT stripped
    popupName?: string;        // /NM of this annotation's popup
    inReplyTo?: string;        // /NM of the annotation this replies to
  }
  export const XFDF_SUBTYPES: ReadonlySet<string>;
  export function collectAnnots(doc: Document): AnnotData[];
  ```

- [ ] **Step 1: Write the fixture**

Create `test/helpers/build-annot-roundtrip.ts`. Follow the `assemble()` pattern in `test/helpers/build-annot-target.ts` — read that file first and copy its `assemble` helper verbatim rather than inventing another one.

```ts
/** Two pages. Page 0 carries a /Text note with a /Popup, a /Highlight that
 *  replies to the note, a /Square, and a /Widget that must never be exported.
 *  Page 1 carries a /Sound, which has no typed class and no generator. */
export function buildAnnotRoundtrip(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /Annots [9 0 R] >>`;
  objects[5] = `<< /Type /Annot /Subtype /Text /NM (note-1) /Rect [10 20 30 40] ` +
               `/Contents (a note) /C [1 0 0] /T (Ada) /Popup 6 0 R /P 3 0 R >>`;
  objects[6] = `<< /Type /Annot /Subtype /Popup /NM (popup-1) /Rect [40 20 200 90] ` +
               `/Parent 5 0 R /Open true >>`;
  objects[7] = `<< /Type /Annot /Subtype /Highlight /NM (hi-1) /Rect [0 0 100 20] ` +
               `/QuadPoints [0 20 100 20 0 0 100 0] /C [1 1 0] /CA 0.4 /IRT 5 0 R ` +
               `/Contents (a reply) >>`;
  objects[8] = `<< /Type /Annot /Subtype /Widget /FT /Tx /T (field1) /V (v) /Rect [0 100 90 120] >>`;
  objects[9] = `<< /Type /Annot /Subtype /Sound /NM (snd-1) /Rect [5 5 25 25] >>`;
  return assemble(objects, 9, 1);
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/annotdata.test.ts`:

```ts
import { collectAnnots } from '../src/annotdata.js';
import { buildAnnotRoundtrip } from './helpers/build-annot-roundtrip.js';

const byName = (as: AnnotData[], nm: string) =>
  as.find((a) => {
    const v = a.dict.get('NM');
    return v !== undefined && (v as { bytes: Uint8Array }).bytes !== undefined &&
      new TextDecoder('latin1').decode((v as { bytes: Uint8Array }).bytes) === nm;
  });

describe('collectAnnots', () => {
  it('collects every annotation with its 0-based page index', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    const got = collectAnnots(doc);
    expect(got.map((a) => a.page).sort()).toEqual([0, 0, 0, 1]);
  });

  it('excludes widget annotations, which travel as form fields', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    for (const a of collectAnnots(doc)) {
      expect((a.dict.get('Subtype') as { name: string }).name).not.toBe('Widget');
    }
  });

  it('lifts /Popup and /IRT into name references and strips the raw keys', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    const got = collectAnnots(doc);
    const note = byName(got, 'note-1')!;
    expect(note.popupName).toBe('popup-1');
    expect(note.dict.has('Popup')).toBe(false);
    const hi = byName(got, 'hi-1')!;
    expect(hi.inReplyTo).toBe('note-1');
    expect(hi.dict.has('IRT')).toBe(false);
  });

  it('strips the page and structure back-references', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    for (const a of collectAnnots(doc)) {
      expect(a.dict.has('P')).toBe(false);
      expect(a.dict.has('Parent')).toBe(false);
      expect(a.dict.has('StructParent')).toBe(false);
    }
  });

  it('mints an /NM for an annotation that has none', () => {
    const doc = Document.Open(buildAnnotTarget());   // its annots carry no /NM
    const got = collectAnnots(doc);
    expect(got.length).toBe(2);
    for (const a of got) expect(a.dict.has('NM')).toBe(true);
    const names = got.map((a) => String((a.dict.get('NM') as { bytes: Uint8Array }).bytes));
    expect(new Set(names).size).toBe(2);   // distinct
  });

  it('writes the minted /NM back to the live document so it is stable', () => {
    const doc = Document.Open(buildAnnotTarget());
    const first = collectAnnots(doc);
    const second = collectAnnots(doc);
    const nm = (a: AnnotData) => new TextDecoder('latin1')
      .decode((a.dict.get('NM') as { bytes: Uint8Array }).bytes);
    expect(first.map(nm)).toEqual(second.map(nm));
  });

  it('returns an empty list for a document with no annotations', () => {
    const doc = Document.Open(buildFormPdf());   // import from ./helpers/build-form-pdf.js
    expect(collectAnnots(doc)).toEqual([]);
  });
});
```

Check the export name in `test/helpers/build-form-pdf.ts` and import it accordingly.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/annotdata.test.ts`
Expected: FAIL — `collectAnnots is not exported`.

- [ ] **Step 4: Implement `collectAnnots`**

Append to `src/annotdata.ts`:

```ts
import { decodePdfText, encodePdfText } from './metadata.js';
import { isName, isString } from './types.js';

/** The 18 annotation types the XFDF vocabulary covers, as PDF /Subtype names.
 *  Widget is deliberately absent: widgets are form fields. */
export const XFDF_SUBTYPES: ReadonlySet<string> = new Set<string>([
  'Text', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Square', 'Circle',
  'Line', 'Polygon', 'PolyLine', 'Ink', 'FreeText', 'Stamp', 'Caret', 'Sound',
  'Link', 'FileAttachment', 'Popup',
]);

/** Keys that point back into document structure, or sideways at a sibling
 *  annotation. Stripped from the neutral model: the first two cannot be
 *  meaningful in another document, the last two are carried by name instead. */
const STRIPPED = ['P', 'Parent', 'StructParent', 'Popup', 'IRT'];

export interface AnnotData {
  /** 0-based page index — XFDF's own convention. */
  page: number;
  /** Self-contained annotation dict: refs inlined, STRIPPED keys removed. */
  dict: PdfDict;
  /** /NM of this annotation's popup, when it has one. */
  popupName?: string;
  /** /NM of the annotation this one replies to, when it is a reply. */
  inReplyTo?: string;
}

const pdfString = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** An annotation's /NM as a string; undefined when absent. */
function nameOf(doc: Document, dict: PdfDict): string | undefined {
  const nm = doc.resolve(dict.get('NM'));
  return isString(nm) ? decodePdfText(nm.bytes) : undefined;
}

/** The /NM of the annotation `key` points at, minting one if it has none. */
function linkedName(doc: Document, dict: PdfDict, key: string, mint: () => string): string | undefined {
  const target = doc.resolve(dict.get(key));
  if (!isDict(target)) return undefined;
  let nm = nameOf(doc, target);
  if (nm === undefined) {
    nm = mint();
    target.set('NM', pdfString(nm));   // written back: the link needs a stable anchor
  }
  return nm;
}

/** Read every non-widget annotation into the format-neutral model.
 *
 *  Annotations without an /NM get one minted and written back to the live
 *  document, so that a second export produces the same names and an import of
 *  the first file still matches. */
export function collectAnnots(doc: Document): AnnotData[] {
  const out: AnnotData[] = [];
  let seq = 0;
  const mint = (): string => `annot-${++seq}`;

  const pages = doc.Pages;
  for (let p = 0; p < pages.length; p++) {
    for (const annot of pages[p].Annotations) {
      const live = annot.Dict;
      const sub = live.get('Subtype');
      const subtype = isName(sub) ? sub.name : '';
      if (subtype === 'Widget' || !XFDF_SUBTYPES.has(subtype)) continue;

      if (nameOf(doc, live) === undefined) live.set('NM', pdfString(mint()));
      const popupName = linkedName(doc, live, 'Popup', mint);
      const inReplyTo = linkedName(doc, live, 'IRT', mint);

      const copy = inlineRefs(doc, live) as PdfDict;
      for (const k of STRIPPED) copy.delete(k);

      const entry: AnnotData = { page: p, dict: copy };
      if (popupName !== undefined) entry.popupName = popupName;
      if (inReplyTo !== undefined) entry.inReplyTo = inReplyTo;
      out.push(entry);
    }
  }
  return out;
}
```

Note the minting order: names are assigned before `inlineRefs` copies the dict, so the copy carries the `/NM` too.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/annotdata.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/annotdata.ts test/annotdata.test.ts test/helpers/build-annot-roundtrip.ts
git commit -m "feat(annot): collect annotations into the format-neutral model"
```

---

### Task 4: `applyAnnots` — the import side

**Files:**
- Modify: `src/annotdata.ts`
- Modify: `src/formdata.ts` (report types)
- Modify: `test/annotdata.test.ts`

**Interfaces:**
- Consumes: `allocStreams`, `AnnotData`, `XFDF_SUBTYPES` (Tasks 2–3); `regenerateAppearance` (Task 1).
- Produces:
  ```ts
  // formdata.ts
  export interface ImportedAnnot { page: number; subtype: string; name?: string }
  export interface SkippedAnnot { page?: number; subtype?: string; reason: string }
  export interface ImportOptions { annotations?: boolean }
  // ImportReport gains: importedAnnots: ImportedAnnot[]; skippedAnnots: SkippedAnnot[]
  // FormData gains: annots?: AnnotData[]
  // ExportFormDataOptions gains: annotations?: boolean
  // annotdata.ts
  export function applyAnnots(doc: Document, annots: AnnotData[], report: ImportReport): void;
  ```

- [ ] **Step 1: Extend the shared types**

In `src/formdata.ts`, add:

```ts
import type { AnnotData } from './annotdata.js';

export interface ImportedAnnot {
  /** 0-based page index the annotation landed on. */
  page: number;
  subtype: string;
  /** /NM, when the annotation carries one. */
  name?: string;
}

export interface SkippedAnnot {
  page?: number;
  subtype?: string;
  reason: string;
}

/** Options for the four import methods. */
export interface ImportOptions {
  /** Apply annotations from the data file. Default false. */
  annotations?: boolean;
}
```

Add to `FormData`: `annots?: AnnotData[];`
Add to `ExportFormDataOptions`: `/** Include annotations. Default false. */ annotations?: boolean;`
Add to `ImportReport`:

```ts
  /** Annotations applied. Empty unless the import asked for annotations. */
  importedAnnots: ImportedAnnot[];
  /** Annotations present in the data file that were not applied. */
  skippedAnnots: SkippedAnnot[];
```

Both new `ImportReport` members are **required**, so initialize them in `applyFormData`'s report literal:

```ts
  const report: ImportReport = { imported: [], skipped: [], importedAnnots: [], skippedAnnots: [] };
```

- [ ] **Step 2: Write the failing test**

Append to `test/annotdata.test.ts`:

```ts
import { applyAnnots } from '../src/annotdata.js';
import type { ImportReport } from '../src/formdata.js';

const emptyReport = (): ImportReport =>
  ({ imported: [], skipped: [], importedAnnots: [], skippedAnnots: [] });

/** Round-trip through the neutral model only: collect from one doc, apply to another. */
function transplant(from: Document, to: Document): ImportReport {
  const report = emptyReport();
  applyAnnots(to, collectAnnots(from), report);
  return report;
}

describe('applyAnnots', () => {
  it('appends annotations to the right page', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = Document.Open(buildAnnotRoundtrip());
    const before = dst.Pages[0].Annotations.length;
    const report = transplant(src, dst);
    expect(report.importedAnnots.length).toBe(4);
    expect(dst.Pages[1].Annotations.some((a) => a.Subtype === 'Sound')).toBe(true);
    expect(dst.Pages[0].Annotations.length).toBeGreaterThan(before - 1);
  });

  it('replaces by /NM instead of duplicating, so import is idempotent', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = Document.Open(buildAnnotRoundtrip());
    const data = collectAnnots(src);
    applyAnnots(dst, data, emptyReport());
    const afterFirst = dst.Pages[0].Annotations.length;
    applyAnnots(dst, data, emptyReport());
    expect(dst.Pages[0].Annotations.length).toBe(afterFirst);
  });

  it('relinks /Popup and /IRT to the grafted siblings', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = Document.Open(buildAnnotTarget());   // no annotations of these names
    transplant(src, dst);
    const annots = dst.Pages[0].Annotations;
    const note = annots.find((a) => a.Name === 'note-1')!;
    const hi = annots.find((a) => a.Name === 'hi-1')!;
    const popup = dst.resolve(note.Dict.get('Popup'));
    expect(isDict(popup)).toBe(true);
    expect((popup as PdfDict).get('Subtype')).toEqual(name('Popup'));
    expect(dst.resolve(hi.Dict.get('IRT'))).toBe(note.Dict);
  });

  it('drops a dangling name link rather than failing the import', () => {
    const dst = Document.Open(buildAnnotTarget());
    const orphan: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
      ]),
      inReplyTo: 'nobody',
    };
    const report = emptyReport();
    applyAnnots(dst, [orphan], report);
    expect(report.importedAnnots.length).toBe(1);
    expect(report.skippedAnnots).toEqual([]);
    const added = dst.Pages[0].Annotations.at(-1)!;
    expect(added.Dict.has('IRT')).toBe(false);
  });

  it('skips an out-of-range page index', () => {
    const dst = Document.Open(buildAnnotTarget());   // 1 page
    const far: AnnotData = {
      page: 9,
      dict: new Map<string, PdfObject>([['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]]]),
    };
    const report = emptyReport();
    applyAnnots(dst, [far], report);
    expect(report.importedAnnots).toEqual([]);
    expect(report.skippedAnnots).toEqual([{ page: 9, subtype: 'Square', reason: 'no such page' }]);
  });

  it('skips a subtype outside the XFDF vocabulary', () => {
    const dst = Document.Open(buildAnnotTarget());
    const odd: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([['Subtype', name('Movie')], ['Rect', [0, 0, 10, 10]]]),
    };
    const report = emptyReport();
    applyAnnots(dst, [odd], report);
    expect(report.skippedAnnots).toEqual(
      [{ page: 0, subtype: 'Movie', reason: 'unsupported annotation type' }]);
  });

  it('regenerates an appearance when the data carries none', () => {
    const dst = Document.Open(buildAnnotTarget());
    const sq: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')],
        ['Rect', [0, 0, 60, 30]], ['C', [1, 0, 0]],
      ]),
    };
    applyAnnots(dst, [sq], emptyReport());
    const added = dst.Pages[0].Annotations.at(-1)!;
    expect(added.Dict.has('AP')).toBe(true);
  });

  it('keeps an appearance that arrived with the data, without regenerating', () => {
    const dst = Document.Open(buildAnnotTarget());
    const marker = new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q');
    const sq: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 60, 30]],
        ['AP', new Map<string, PdfObject>([['N', {
          kind: 'stream',
          dict: new Map<string, PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 60, 30]]]),
          raw: marker,
        }]])],
      ]),
    };
    applyAnnots(dst, [sq], emptyReport());
    const added = dst.Pages[0].Annotations.at(-1)!;
    const ap = dst.resolve(added.Dict.get('AP')) as PdfDict;
    const n = dst.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    expect((n as { raw: Uint8Array }).raw).toEqual(marker);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/annotdata.test.ts`
Expected: FAIL — `applyAnnots is not exported`.

- [ ] **Step 4: Implement `applyAnnots`**

Append to `src/annotdata.ts`:

```ts
import { regenerateAppearance } from './annotdraw.js';
import type { ImportReport } from './formdata.js';

/** Index of a page's existing annotations by /NM, for replace-on-import. */
function namedOnPage(doc: Document, pageDict: PdfDict): Map<string, PdfObject> {
  const out = new Map<string, PdfObject>();
  const arr = doc.resolve(pageDict.get('Annots'));
  if (!isArray(arr)) return out;
  for (const e of arr) {
    const d = doc.resolve(e);
    if (!isDict(d)) continue;
    const nm = nameOf(doc, d);
    if (nm !== undefined) out.set(nm, e);
  }
  return out;
}

/** The page's /Annots array, created and attached when absent. */
function annotsArray(doc: Document, pageDict: PdfDict): PdfObject[] {
  const arr = doc.resolve(pageDict.get('Annots'));
  if (isArray(arr)) return arr;
  const made: PdfObject[] = [];
  pageDict.set('Annots', made);
  return made;
}

/** Graft annotations into the document, reporting what landed and what did not.
 *
 *  An annotation whose /NM matches one already on the target page replaces it,
 *  so importing the same data twice is idempotent. Name links (/Popup, /IRT)
 *  are resolved in a second pass, once every dict has a reference to point at. */
export function applyAnnots(doc: Document, annots: AnnotData[], report: ImportReport): void {
  const pages = doc.Pages;
  /** /NM → the ref of the dict we grafted for it, for the second pass. */
  const grafted = new Map<string, PdfObject>();
  const pending: { data: AnnotData; dict: PdfDict }[] = [];

  for (const a of annots) {
    const sub = a.dict.get('Subtype');
    const subtype = isName(sub) ? sub.name : '';

    if (!XFDF_SUBTYPES.has(subtype)) {
      report.skippedAnnots.push({ page: a.page, subtype, reason: 'unsupported annotation type' });
      continue;
    }
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pages.length) {
      report.skippedAnnots.push({ page: a.page, subtype, reason: 'no such page' });
      continue;
    }

    const pageDict = pages[a.page].Dict;
    const dict = allocStreams(doc, a.dict) as PdfDict;
    if (!dict.has('AP')) regenerateAppearance(doc, dict);

    const ref = doc.allocObject(dict);
    const arr = annotsArray(doc, pageDict);
    const nm = nameOf(doc, dict);
    const existing = nm === undefined ? undefined : namedOnPage(doc, pageDict).get(nm);
    if (existing !== undefined) {
      const at = arr.findIndex((e) => e === existing);
      if (at >= 0) arr[at] = ref; else arr.push(ref);
    } else {
      arr.push(ref);
    }

    if (nm !== undefined) grafted.set(nm, ref);
    pending.push({ data: a, dict });
    const entry: ImportedAnnot = { page: a.page, subtype };
    if (nm !== undefined) entry.name = nm;
    report.importedAnnots.push(entry);
  }

  // Second pass: rebuild the sibling links now that every target has a ref.
  for (const { data, dict } of pending) {
    if (data.popupName !== undefined) {
      const target = grafted.get(data.popupName);
      if (target !== undefined) dict.set('Popup', target);
    }
    if (data.inReplyTo !== undefined) {
      const target = grafted.get(data.inReplyTo);
      if (target !== undefined) dict.set('IRT', target);
    }
  }

  if (report.importedAnnots.length > 0) doc.markModified();
}
```

Add `ImportedAnnot` to the `formdata.js` import in this file.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/annotdata.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the report change across the codebase**

Run: `npm run typecheck`
Expected: PASS. `ImportReport` gained two required members; if any other construction site exists, this finds it. Fix by adding `importedAnnots: [], skippedAnnots: []`.

- [ ] **Step 7: Run the existing form-data tests**

Run: `npx vitest run test/fdf.test.ts test/xfdf.test.ts test/formdata.test.ts`
Expected: PASS — e1p's behaviour is unchanged. (Check which of these files exist; run the ones that do.)

- [ ] **Step 8: Commit**

```bash
git add src/annotdata.ts src/formdata.ts test/annotdata.test.ts
git commit -m "feat(annot): apply annotations from the neutral model, replacing by /NM"
```

---

### Task 5: XFDF write — the attribute table

**Files:**
- Create: `src/xfdfannot.ts`
- Create: `test/xfdfannot.test.ts`

**Interfaces:**
- Consumes: `XmlNode`, `escapeXml` from `xml.js`; `AnnotData` from `annotdata.js`; `serializeObject` from `serialize.js`.
- Produces:
  ```ts
  export function writeAnnots(annots: AnnotData[]): XmlNode;   // the <annots> element
  export const XFDF_ELEMENT: ReadonlyMap<string, string>;      // subtype -> element name
  export const XFDF_SUBTYPE: ReadonlyMap<string, string>;      // element name -> subtype
  ```

- [ ] **Step 1: Write the failing test**

Create `test/xfdfannot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { writeAnnots } from '../src/xfdfannot.js';
import { writeXml } from '../src/xml.js';
import type { AnnotData } from '../src/annotdata.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const encStr = (s: string): PdfObject =>
  ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const annot = (subtype: string, entries: [string, PdfObject][], extra: Partial<AnnotData> = {}): AnnotData =>
  ({ page: 0, dict: new Map<string, PdfObject>([['Subtype', name(subtype)], ...entries]), ...extra });

const xml = (annots: AnnotData[]) => writeXml(writeAnnots(annots));

describe('writeAnnots', () => {
  it('maps the subtype to its XFDF element name, lowercased', () => {
    const out = xml([annot('StrikeOut', [['Rect', [1, 2, 3, 4]]])]);
    expect(out).toContain('<strikeout');
    const poly = xml([annot('PolyLine', [['Rect', [1, 2, 3, 4]]])]);
    expect(poly).toContain('<polyline');
  });

  it('writes rect and page, with page 0-based', () => {
    const out = xml([{ page: 2, dict: new Map<string, PdfObject>([
      ['Subtype', name('Square')], ['Rect', [1, 2, 3, 4.5]],
    ]) }]);
    expect(out).toContain('rect="1,2,3,4.5"');
    expect(out).toContain('page="2"');
  });

  it('writes colours as #RRGGBB', () => {
    const out = xml([annot('Square', [['Rect', [0, 0, 1, 1]], ['C', [1, 0, 0]], ['IC', [0, 0.5, 1]]])]);
    expect(out).toContain('color="#FF0000"');
    expect(out).toContain('interior-color="#0080FF"');
  });

  it('writes /F as a comma-separated flag name list', () => {
    const out = xml([annot('Square', [['Rect', [0, 0, 1, 1]], ['F', 6]])]);  // hidden|print
    expect(out).toContain('flags="hidden,print"');
  });

  it('writes /Contents as a child element, not an attribute', () => {
    const out = xml([annot('Text', [['Rect', [0, 0, 1, 1]], ['Contents', encStr('a & b')]])]);
    expect(out).toContain('<contents>a &amp; b</contents>');
  });

  it('writes /QuadPoints as coords and /Vertices as vertices', () => {
    const hi = xml([annot('Highlight', [['Rect', [0, 0, 1, 1]], ['QuadPoints', [0, 1, 2, 3, 4, 5, 6, 7]]])]);
    expect(hi).toContain('coords="0,1,2,3,4,5,6,7"');
    const pg = xml([annot('Polygon', [['Rect', [0, 0, 1, 1]], ['Vertices', [0, 0, 5, 5]]])]);
    expect(pg).toContain('vertices="0,0,5,5"');
  });

  it('writes /InkList with semicolon-separated subpaths', () => {
    const out = xml([annot('Ink', [['Rect', [0, 0, 1, 1]], ['InkList', [[0, 0, 1, 1], [2, 2, 3, 3]]]])]);
    expect(out).toContain('inklist="0,0,1,1;2,2,3,3"');
  });

  it('writes /L as start and end', () => {
    const out = xml([annot('Line', [['Rect', [0, 0, 9, 9]], ['L', [1, 2, 8, 9]]])]);
    expect(out).toContain('start="1,2"');
    expect(out).toContain('end="8,9"');
  });

  it('writes the popup as a nested element and a reply as inreplyto', () => {
    const out = xml([
      annot('Text', [['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')]], { popupName: 'p1' }),
      annot('Highlight', [['Rect', [0, 0, 1, 1]], ['NM', encStr('h1')]], { inReplyTo: 'n1' }),
    ]);
    expect(out).toContain('inreplyto="n1"');
    expect(out).toContain('<popup');
  });

  it('emits an empty <annots/> for no annotations', () => {
    expect(xml([])).toContain('<annots/>');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/xfdfannot.test.ts`
Expected: FAIL — cannot resolve `../src/xfdfannot.js`.

- [ ] **Step 3: Implement the table and the writer**

Create `src/xfdfannot.ts`:

```ts
import { XmlNode } from './xml.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import type { AnnotData } from './annotdata.js';

/** PDF /Subtype → XFDF element name. The XFDF names are the PDF ones
 *  lowercased, with no other transformation. */
export const XFDF_ELEMENT: ReadonlyMap<string, string> = new Map([
  ['Text', 'text'], ['Highlight', 'highlight'], ['Underline', 'underline'],
  ['Squiggly', 'squiggly'], ['StrikeOut', 'strikeout'], ['Square', 'square'],
  ['Circle', 'circle'], ['Line', 'line'], ['Polygon', 'polygon'],
  ['PolyLine', 'polyline'], ['Ink', 'ink'], ['FreeText', 'freetext'],
  ['Stamp', 'stamp'], ['Caret', 'caret'], ['Sound', 'sound'], ['Link', 'link'],
  ['FileAttachment', 'fileattachment'], ['Popup', 'popup'],
]);

export const XFDF_SUBTYPE: ReadonlyMap<string, string> =
  new Map(Array.from(XFDF_ELEMENT, ([k, v]) => [v, k] as const));

type AttrKind = 'text' | 'name' | 'num' | 'nums' | 'color' | 'date' | 'flags' | 'inklist';

interface AttrSpec { attr: string; key: string; kind: AttrKind }

/** Attributes common to every annotation type. */
const COMMON: readonly AttrSpec[] = [
  { attr: 'rect', key: 'Rect', kind: 'nums' },
  { attr: 'color', key: 'C', kind: 'color' },
  { attr: 'interior-color', key: 'IC', kind: 'color' },
  { attr: 'opacity', key: 'CA', kind: 'num' },
  { attr: 'flags', key: 'F', kind: 'flags' },
  { attr: 'date', key: 'M', kind: 'date' },
  { attr: 'creationdate', key: 'CreationDate', kind: 'date' },
  { attr: 'title', key: 'T', kind: 'text' },
  { attr: 'subject', key: 'Subj', kind: 'text' },
  { attr: 'name', key: 'NM', kind: 'text' },
  { attr: 'intent', key: 'IT', kind: 'name' },
  { attr: 'icon', key: 'Name', kind: 'name' },
  { attr: 'symbol', key: 'Sy', kind: 'name' },
  { attr: 'rotation', key: 'Rotate', kind: 'num' },
  { attr: 'coords', key: 'QuadPoints', kind: 'nums' },
  { attr: 'vertices', key: 'Vertices', kind: 'nums' },
  { attr: 'inklist', key: 'InkList', kind: 'inklist' },
  { attr: 'fringe', key: 'RD', kind: 'nums' },
];

/** Child elements that carry text rather than markup. */
const TEXT_CHILDREN: readonly { el: string; key: string }[] = [
  { el: 'contents', key: 'Contents' },
  { el: 'defaultappearance', key: 'DA' },
  { el: 'defaultstyle', key: 'DS' },
];

/** /F bit values, low bit first, in the order XFDF names them. */
const FLAG_NAMES: readonly string[] = [
  'invisible', 'hidden', 'print', 'nozoom', 'norotate', 'noview', 'readonly',
  'locked', 'togglenoview',
];

const el = (name: string, attrs: Record<string, string> = {}): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children: [], text: '' });

/** A number as XFDF writes it: no exponent, no trailing zeros. */
const numStr = (n: number): string => String(Number(n.toFixed(6)));

const hex2 = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0').toUpperCase();

/** A flat number list from an array; undefined when absent or malformed. */
function nums(o: PdfObject | undefined): number[] | undefined {
  if (!isArray(o)) return undefined;
  const out: number[] = [];
  for (const e of o) {
    if (typeof e !== 'number' || !Number.isFinite(e)) return undefined;
    out.push(e);
  }
  return out;
}

/** Format one dict entry as its XFDF attribute value; undefined to omit it. */
function format(kind: AttrKind, v: PdfObject | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  switch (kind) {
    case 'text':
      return isString(v) ? decodePdfText(v.bytes) : undefined;
    case 'name':
      return isName(v) ? v.name : undefined;
    case 'date':
      return isString(v) ? decodePdfText(v.bytes) : undefined;
    case 'num':
      return typeof v === 'number' && Number.isFinite(v) ? numStr(v) : undefined;
    case 'nums': {
      const a = nums(v);
      return a === undefined || a.length === 0 ? undefined : a.map(numStr).join(',');
    }
    case 'color': {
      const a = nums(v);
      return a === undefined || a.length !== 3 ? undefined : `#${hex2(a[0])}${hex2(a[1])}${hex2(a[2])}`;
    }
    case 'flags': {
      if (typeof v !== 'number' || !Number.isInteger(v) || v === 0) return undefined;
      const on = FLAG_NAMES.filter((_, i) => (v & (1 << i)) !== 0);
      return on.length === 0 ? undefined : on.join(',');
    }
    case 'inklist': {
      if (!isArray(v)) return undefined;
      const paths: string[] = [];
      for (const stroke of v) {
        const a = nums(stroke);
        if (a === undefined || a.length === 0) return undefined;
        paths.push(a.map(numStr).join(','));
      }
      return paths.length === 0 ? undefined : paths.join(';');
    }
  }
}

/** Serialize one annotation as its XFDF element. */
function writeOne(a: AnnotData): XmlNode | undefined {
  const sub = a.dict.get('Subtype');
  const subtype = isName(sub) ? sub.name : '';
  const elName = XFDF_ELEMENT.get(subtype);
  if (elName === undefined) return undefined;

  const node = el(elName, { page: String(a.page) });
  for (const spec of COMMON) {
    const text = format(spec.kind, a.dict.get(spec.key));
    if (text !== undefined) node.attrs.set(spec.attr, text);
  }

  // /L is one array in the dict but two attributes in XFDF.
  const l = nums(a.dict.get('L'));
  if (l !== undefined && l.length === 4) {
    node.attrs.set('start', `${numStr(l[0])},${numStr(l[1])}`);
    node.attrs.set('end', `${numStr(l[2])},${numStr(l[3])}`);
  }
  // /LE likewise.
  const le = a.dict.get('LE');
  if (isArray(le) && le.length === 2 && isName(le[0]) && isName(le[1])) {
    node.attrs.set('head', (le[0] as { name: string }).name);
    node.attrs.set('tail', (le[1] as { name: string }).name);
  }
  // Border width lives at /BS /W.
  const bs = a.dict.get('BS');
  if (isDict(bs)) {
    const w = (bs as PdfDict).get('W');
    if (typeof w === 'number' && Number.isFinite(w)) node.attrs.set('width', numStr(w));
  }
  if (a.inReplyTo !== undefined) node.attrs.set('inreplyto', a.inReplyTo);

  for (const { el: name_, key } of TEXT_CHILDREN) {
    const v = a.dict.get(key);
    if (!isString(v)) continue;
    const child = el(name_);
    child.text = decodePdfText(v.bytes);
    node.children.push(child);
  }
  // /RC is markup: emitted verbatim, not escaped.
  const rc = a.dict.get('RC');
  if (isString(rc)) {
    const child = el('contents-richtext');
    child.raw = decodePdfText(rc.bytes);
    node.children.push(child);
  }
  return node;
}

/** Serialize the annotation list as an <annots> element. */
export function writeAnnots(annots: AnnotData[]): XmlNode {
  const root = el('annots');
  /** Popups are emitted nested inside the annotation that owns them. */
  const popupOf = new Map<string, AnnotData>();
  const nameOf = (a: AnnotData): string | undefined => {
    const nm = a.dict.get('NM');
    return isString(nm) ? decodePdfText(nm.bytes) : undefined;
  };
  for (const a of annots) {
    const nm = nameOf(a);
    if (nm !== undefined) popupOf.set(nm, a);
  }
  const nested = new Set<AnnotData>();
  for (const a of annots) {
    if (a.popupName === undefined) continue;
    const p = popupOf.get(a.popupName);
    if (p !== undefined) nested.add(p);
  }

  for (const a of annots) {
    if (nested.has(a)) continue;   // emitted inside its parent below
    const node = writeOne(a);
    if (node === undefined) continue;
    if (a.popupName !== undefined) {
      const p = popupOf.get(a.popupName);
      const pn = p === undefined ? undefined : writeOne(p);
      if (pn !== undefined) node.children.push(pn);
    }
    root.children.push(node);
  }
  return root;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/xfdfannot.test.ts`
Expected: PASS, ten cases.

- [ ] **Step 5: Commit**

```bash
git add src/xfdfannot.ts test/xfdfannot.test.ts
git commit -m "feat(xfdf): write annotations through the attribute table"
```

---

### Task 6: XFDF read, and the `<appearance>` codec

The table drives the reverse direction. Appearance transport is added here in both directions at once, since writer and reader define one codec.

**Files:**
- Modify: `src/xfdfannot.ts`
- Modify: `test/xfdfannot.test.ts`

**Interfaces:**
- Consumes: `parseXml`, `XmlNode` from `xml.js`; `serializeObject` from `serialize.js`; `Lexer` from `lexer.js`; `ObjectParser` from `object-parser.js`.
- Produces:
  ```ts
  export function readAnnots(node: XmlNode, skipped: SkippedAnnot[]): AnnotData[];
  export function encodeAppearance(stream: PdfStream): string;          // base64
  export function decodeAppearance(b64: string): PdfStream | undefined; // undefined = unusable
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/xfdfannot.test.ts`:

```ts
import { readAnnots, encodeAppearance, decodeAppearance } from '../src/xfdfannot.js';
import { parseXml } from '../src/xml.js';
import type { SkippedAnnot } from '../src/formdata.js';
import { isName, isStream, isString } from '../src/types.js';

const parse = (xmlText: string): { annots: AnnotData[]; skipped: SkippedAnnot[] } => {
  const skipped: SkippedAnnot[] = [];
  const annots = readAnnots(parseXml(new TextEncoder().encode(xmlText)), skipped);
  return { annots, skipped };
};

describe('readAnnots', () => {
  it('maps the element name back to the PDF subtype', () => {
    const { annots } = parse('<annots><strikeout page="0" rect="1,2,3,4"/></annots>');
    expect((annots[0].dict.get('Subtype') as { name: string }).name).toBe('StrikeOut');
  });

  it('parses rect, colour and flags back into dict entries', () => {
    const { annots } = parse(
      '<annots><square page="1" rect="1,2,3,4.5" color="#FF0000" flags="hidden,print"/></annots>');
    const a = annots[0];
    expect(a.page).toBe(1);
    expect(a.dict.get('Rect')).toEqual([1, 2, 3, 4.5]);
    expect(a.dict.get('C')).toEqual([1, 0, 0]);
    expect(a.dict.get('F')).toBe(6);
  });

  it('reads coords, vertices, inklist and start/end', () => {
    const hi = parse('<annots><highlight page="0" rect="0,0,1,1" coords="0,1,2,3,4,5,6,7"/></annots>');
    expect(hi.annots[0].dict.get('QuadPoints')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const ink = parse('<annots><ink page="0" rect="0,0,1,1" inklist="0,0,1,1;2,2,3,3"/></annots>');
    expect(ink.annots[0].dict.get('InkList')).toEqual([[0, 0, 1, 1], [2, 2, 3, 3]]);
    const ln = parse('<annots><line page="0" rect="0,0,9,9" start="1,2" end="8,9"/></annots>');
    expect(ln.annots[0].dict.get('L')).toEqual([1, 2, 8, 9]);
  });

  it('reads <contents> and carries <contents-richtext> verbatim', () => {
    const { annots } = parse(
      '<annots><text page="0" rect="0,0,1,1"><contents>a &amp; b</contents>' +
      '<contents-richtext><b>hi</b></contents-richtext></text></annots>');
    const c = annots[0].dict.get('Contents');
    expect(isString(c)).toBe(true);
    expect(new TextDecoder('latin1').decode((c as { bytes: Uint8Array }).bytes)).toBe('a & b');
    const rc = annots[0].dict.get('RC');
    expect(new TextDecoder('latin1').decode((rc as { bytes: Uint8Array }).bytes)).toBe('<b>hi</b>');
  });

  it('lifts a nested <popup> into its own entry and a popupName link', () => {
    const { annots } = parse(
      '<annots><text page="0" rect="0,0,1,1" name="n1">' +
      '<popup page="0" rect="5,5,9,9" name="p1"/></text></annots>');
    expect(annots.length).toBe(2);
    const note = annots.find((a) => (a.dict.get('Subtype') as { name: string }).name === 'Text')!;
    expect(note.popupName).toBe('p1');
    expect(annots.some((a) => (a.dict.get('Subtype') as { name: string }).name === 'Popup')).toBe(true);
  });

  it('reads inreplyto into the neutral model', () => {
    const { annots } = parse('<annots><highlight page="0" rect="0,0,1,1" inreplyto="n1"/></annots>');
    expect(annots[0].inReplyTo).toBe('n1');
  });

  it('skips an element outside the vocabulary and keeps going', () => {
    const { annots, skipped } = parse(
      '<annots><movie page="0" rect="0,0,1,1"/><square page="0" rect="0,0,1,1"/></annots>');
    expect(annots.length).toBe(1);
    expect(skipped).toEqual([{ reason: 'unsupported annotation type' }]);
  });

  it('skips an annotation with a missing or non-numeric page', () => {
    const { annots, skipped } = parse('<annots><square rect="0,0,1,1"/></annots>');
    expect(annots).toEqual([]);
    expect(skipped[0].reason).toBe('missing page index');
  });

  it('skips an annotation whose coordinate list is malformed', () => {
    const { annots, skipped } = parse('<annots><square page="0" rect="1,two,3,4"/></annots>');
    expect(annots).toEqual([]);
    expect(skipped[0].reason).toBe('malformed rect');
  });
});

describe('appearance codec', () => {
  const stream = () => ({
    kind: 'stream' as const,
    dict: new Map<string, PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 10, 10]]]),
    raw: new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q'),
  });

  it('round-trips a form XObject byte-for-byte', () => {
    const back = decodeAppearance(encodeAppearance(stream()));
    expect(back).toBeDefined();
    expect(back!.raw).toEqual(stream().raw);
    expect(back!.dict.get('BBox')).toEqual([0, 0, 10, 10]);
  });

  it('returns undefined for base64 that is not a PDF stream', () => {
    expect(decodeAppearance('bm90IGEgcGRmIHN0cmVhbQ==')).toBeUndefined();
  });

  it('returns undefined for input that is not base64 at all', () => {
    expect(decodeAppearance('!!! not base64 !!!')).toBeUndefined();
  });

  it('reads an <appearance> child into /AP /N', () => {
    const b64 = encodeAppearance(stream());
    const { annots } = parse(
      `<annots><square page="0" rect="0,0,10,10"><appearance>${b64}</appearance></square></annots>`);
    const ap = annots[0].dict.get('AP') as PdfDict;
    expect(isStream(ap.get('N'))).toBe(true);
  });

  it('ignores an unusable <appearance> without reporting a skip', () => {
    const { annots, skipped } = parse(
      '<annots><square page="0" rect="0,0,10,10"><appearance>@@@</appearance></square></annots>');
    expect(annots.length).toBe(1);
    expect(annots[0].dict.has('AP')).toBe(false);
    expect(skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/xfdfannot.test.ts`
Expected: FAIL — `readAnnots is not exported`.

- [ ] **Step 3: Implement the appearance codec**

Append to `src/xfdfannot.ts`. `Buffer` is a `node:` global and needs no dependency:

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { serializeObject } from './serialize.js';
import { PdfStream, isStream } from './types.js';

/** Encode an appearance stream for the <appearance> element: the Form XObject
 *  serialized as a single-object PDF fragment, base64-encoded.
 *
 *  The XFDF standard does not pin this payload down and producers disagree, so
 *  this is our convention. decodeAppearance treats anything it cannot read as
 *  absent, which keeps a foreign file importable at property fidelity. */
export function encodeAppearance(stream: PdfStream): string {
  const body = serializeObject(stream);
  const head = new TextEncoder().encode('1 0 obj\n');
  const tail = new TextEncoder().encode('\nendobj\n');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return Buffer.from(out).toString('base64');
}

/** Decode an <appearance> payload. Returns undefined for anything unusable —
 *  a foreign encoding, corrupt base64, or an object that is not a stream. */
export function decodeAppearance(b64: string): PdfStream | undefined {
  const trimmed = b64.trim();
  if (trimmed === '' || /[^A-Za-z0-9+/=\s]/.test(trimmed)) return undefined;
  try {
    const bytes = new Uint8Array(Buffer.from(trimmed, 'base64'));
    if (bytes.length === 0) return undefined;
    const { value } = new ObjectParser(new Lexer(bytes, 0)).parseIndirectObject();
    return isStream(value) ? value : undefined;
  } catch {
    return undefined;   // unreadable is not an error: we regenerate instead
  }
}
```

- [ ] **Step 4: Add the `<appearance>` child to the writer**

`writeOne` needs `doc` to resolve the `/AP` ref — except it does not: `AnnotData.dict` is already self-contained from `inlineRefs`, so `/AP` `/N` is an inline stream. Add to `writeOne`, before the `return`:

```ts
  const ap = a.dict.get('AP');
  if (isDict(ap)) {
    const n = (ap as PdfDict).get('N');
    if (isStream(n)) {
      const child = el('appearance');
      child.text = encodeAppearance(n);
      node.children.push(child);
    }
  }
```

- [ ] **Step 5: Implement the reader**

Append to `src/xfdfannot.ts`:

```ts
import { PdfDict, name as pdfName } from './types.js';
import { encodePdfText } from './metadata.js';
import type { SkippedAnnot } from './formdata.js';

/** Thrown internally when an attribute cannot be parsed; caught per annotation
 *  and turned into a skip, so one bad element never fails a whole import. */
class AttrError extends Error {
  constructor(readonly attr: string) { super(`malformed ${attr}`); }
}

/** Comma-separated finite numbers. */
function parseNums(attr: string, text: string): number[] {
  const parts = text.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const out: number[] = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v)) throw new AttrError(attr);
    out.push(v);
  }
  if (out.length === 0) throw new AttrError(attr);
  return out;
}

/** #RRGGBB → RGB components in 0..1. */
function parseColor(attr: string, text: string): number[] {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(text.trim());
  if (!m) throw new AttrError(attr);
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Comma-separated flag names → the /F bitfield. Unknown names are ignored. */
function parseFlags(text: string): number {
  let f = 0;
  for (const part of text.split(',')) {
    const i = FLAG_NAMES.indexOf(part.trim().toLowerCase());
    if (i >= 0) f |= 1 << i;
  }
  return f;
}

/** Turn one attribute into its dict value; undefined when it maps to nothing. */
function parseAttr(spec: AttrSpec, text: string): PdfObject | undefined {
  switch (spec.kind) {
    case 'text': case 'date':
      return { kind: 'string', bytes: encodePdfText(text) };
    case 'name':
      return pdfName(text);
    case 'num': {
      const v = Number(text);
      if (!Number.isFinite(v)) throw new AttrError(spec.attr);
      return v;
    }
    case 'nums':
      return parseNums(spec.attr, text);
    case 'color':
      return parseColor(spec.attr, text);
    case 'flags':
      return parseFlags(text);
    case 'inklist':
      return text.split(';').map((p) => parseNums(spec.attr, p));
  }
}

/** Build one AnnotData from an element, or throw AttrError. */
function readOne(node: XmlNode, subtype: string): AnnotData {
  const pageText = node.attrs.get('page');
  const page = pageText === undefined ? NaN : Number(pageText);
  if (!Number.isInteger(page) || page < 0) throw new AttrError('__page');

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', pdfName('Annot')],
    ['Subtype', pdfName(subtype)],
  ]);

  for (const spec of COMMON) {
    const text = node.attrs.get(spec.attr);
    if (text === undefined) continue;
    const v = parseAttr(spec, text);
    if (v !== undefined) dict.set(spec.key, v);
  }

  // start + end recombine into /L; head + tail into /LE.
  const start = node.attrs.get('start');
  const end = node.attrs.get('end');
  if (start !== undefined && end !== undefined)
    dict.set('L', [...parseNums('start', start), ...parseNums('end', end)]);
  const head = node.attrs.get('head');
  const tail = node.attrs.get('tail');
  if (head !== undefined && tail !== undefined) dict.set('LE', [pdfName(head), pdfName(tail)]);

  const width = node.attrs.get('width');
  if (width !== undefined) {
    const w = Number(width);
    if (!Number.isFinite(w)) throw new AttrError('width');
    dict.set('BS', new Map<string, PdfObject>([['W', w]]));
  }

  for (const child of node.children) {
    for (const { el: elName, key } of TEXT_CHILDREN)
      if (child.name === elName) dict.set(key, { kind: 'string', bytes: encodePdfText(child.text) });
    if (child.name === 'contents-richtext')
      dict.set('RC', { kind: 'string', bytes: encodePdfText(child.raw ?? child.text) });
    if (child.name === 'appearance') {
      const stream = decodeAppearance(child.text);
      if (stream !== undefined)
        dict.set('AP', new Map<string, PdfObject>([['N', stream]]));
    }
  }

  const out: AnnotData = { page, dict };
  const irt = node.attrs.get('inreplyto');
  if (irt !== undefined) out.inReplyTo = irt;
  return out;
}

/** Read the <annots> element into the format-neutral model. A nested <popup>
 *  becomes its own entry, linked from its parent by name. Problems are
 *  reported per annotation; nothing here throws. */
export function readAnnots(root: XmlNode, skipped: SkippedAnnot[]): AnnotData[] {
  const out: AnnotData[] = [];
  const annots = root.name === 'annots'
    ? root
    : root.children.find((c) => c.name === 'annots');
  if (annots === undefined) return out;

  let seq = 0;
  for (const node of annots.children) {
    const subtype = XFDF_SUBTYPE.get(node.name);
    if (subtype === undefined) {
      skipped.push({ reason: 'unsupported annotation type' });
      continue;
    }
    let entry: AnnotData;
    try {
      entry = readOne(node, subtype);
    } catch (err) {
      const attr = err instanceof AttrError ? err.attr : '';
      const pageText = node.attrs.get('page');
      const page = pageText === undefined ? undefined : Number(pageText);
      skipped.push({
        ...(Number.isInteger(page) ? { page: page as number } : {}),
        subtype,
        reason: attr === '__page' ? 'missing page index' : `malformed ${attr}`,
      });
      continue;
    }

    const popupEl = node.children.find((c) => c.name === 'popup');
    if (popupEl !== undefined) {
      try {
        const popup = readOne(popupEl, 'Popup');
        let nm = popup.dict.get('NM');
        if (!isString(nm)) {
          const minted = `popup-${++seq}`;
          nm = { kind: 'string', bytes: encodePdfText(minted) };
          popup.dict.set('NM', nm);
        }
        entry.popupName = decodePdfText((nm as { bytes: Uint8Array }).bytes);
        out.push(popup);
      } catch {
        // A malformed popup loses the popup, not the annotation that owns it.
      }
    }
    out.push(entry);
  }
  return out;
}
```

Note `readOne` is called for the popup child too — that is why `<popup>` needs its own `page` attribute; a popup element without one loses the popup and keeps its parent.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/xfdfannot.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/xfdfannot.ts test/xfdfannot.test.ts
git commit -m "feat(xfdf): read annotations, with a defined <appearance> codec"
```

---

### Task 7: FDF `/Annots` as a PDF object subgraph

**Files:**
- Create: `src/fdfannot.ts`
- Create: `test/fdfannot.test.ts`

**Interfaces:**
- Consumes: `AnnotData` from `annotdata.js`; `serializeObject` from `serialize.js`.
- Produces:
  ```ts
  export interface FdfObjects { array: PdfObject[]; objects: Map<number, PdfObject> }
  export function writeFdfAnnots(annots: AnnotData[], firstObj: number): FdfObjects;
  export function readFdfAnnots(
    arr: PdfObject, resolve: (o: PdfObject) => PdfObject, skipped: SkippedAnnot[],
  ): AnnotData[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/fdfannot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { writeFdfAnnots, readFdfAnnots } from '../src/fdfannot.js';
import type { AnnotData } from '../src/annotdata.js';
import type { SkippedAnnot } from '../src/formdata.js';
import { PdfDict, PdfObject, isDict, isRef, isStream, name } from '../src/types.js';

const encStr = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const square = (extra: [string, PdfObject][] = []): AnnotData => ({
  page: 1,
  dict: new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name('Square')],
    ['Rect', [0, 0, 10, 10]], ['NM', encStr('sq-1')], ...extra,
  ]),
});

describe('writeFdfAnnots', () => {
  it('emits one indirect object per annotation, numbered from firstObj', () => {
    const { array, objects } = writeFdfAnnots([square(), square()], 5);
    expect(array.length).toBe(2);
    expect(array.every(isRef)).toBe(true);
    expect([...objects.keys()].sort((a, b) => a - b)).toEqual([5, 6]);
  });

  it('records the page index as /Page, XFDF-style 0-based', () => {
    const { objects } = writeFdfAnnots([square()], 1);
    const d = objects.get(1) as PdfDict;
    expect(d.get('Page')).toBe(1);
  });

  it('allocates an inline appearance stream as its own object', () => {
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Subtype', name('Form')]]),
      raw: new TextEncoder().encode('q Q'),
    };
    const a = square([['AP', new Map<string, PdfObject>([['N', stream]])]]);
    const { objects } = writeFdfAnnots([a], 1);
    const d = objects.get(1) as PdfDict;
    const ap = d.get('AP') as PdfDict;
    expect(isRef(ap.get('N'))).toBe(true);
    expect(objects.size).toBe(2);
  });

  it('writes popup and reply links as refs between the emitted objects', () => {
    const note: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Text')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')],
      ]),
      popupName: 'p1',
    };
    const popup: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('p1')],
      ]),
    };
    const { objects } = writeFdfAnnots([note, popup], 1);
    const noteDict = objects.get(1) as PdfDict;
    expect(isRef(noteDict.get('Popup'))).toBe(true);
    expect((noteDict.get('Popup') as { num: number }).num).toBe(2);
  });
});

describe('readFdfAnnots', () => {
  it('reads dicts back, inlining refs and lifting /Page', () => {
    const { array, objects } = writeFdfAnnots([square()], 1);
    const resolve = (o: PdfObject): PdfObject =>
      isRef(o) ? objects.get((o as { num: number }).num) ?? null : o;
    const skipped: SkippedAnnot[] = [];
    const back = readFdfAnnots(array, resolve, skipped);
    expect(back.length).toBe(1);
    expect(back[0].page).toBe(1);
    expect(back[0].dict.has('Page')).toBe(false);
    expect(back[0].dict.get('Rect')).toEqual([0, 0, 10, 10]);
    expect(skipped).toEqual([]);
  });

  it('lifts /Popup and /IRT refs back into name links', () => {
    const note: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Text')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')],
      ]),
      popupName: 'p1',
    };
    const popup: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('p1')],
      ]),
    };
    const { array, objects } = writeFdfAnnots([note, popup], 1);
    const resolve = (o: PdfObject): PdfObject =>
      isRef(o) ? objects.get((o as { num: number }).num) ?? null : o;
    const back = readFdfAnnots(array, resolve, []);
    const n = back.find((a) => (a.dict.get('Subtype') as { name: string }).name === 'Text')!;
    expect(n.popupName).toBe('p1');
    expect(n.dict.has('Popup')).toBe(false);
  });

  it('skips an entry with no usable page index', () => {
    const arr: PdfObject[] = [new Map<string, PdfObject>([
      ['Subtype', name('Square')], ['Rect', [0, 0, 1, 1]],
    ])];
    const skipped: SkippedAnnot[] = [];
    const back = readFdfAnnots(arr, (o) => o, skipped);
    expect(back).toEqual([]);
    expect(skipped[0].reason).toBe('missing page index');
  });

  it('returns nothing for a non-array /Annots', () => {
    const skipped: SkippedAnnot[] = [];
    expect(readFdfAnnots(null, (o) => o, skipped)).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/fdfannot.test.ts`
Expected: FAIL — cannot resolve `../src/fdfannot.js`.

- [ ] **Step 3: Implement**

Create `src/fdfannot.ts`:

```ts
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isStream, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import type { AnnotData } from './annotdata.js';
import type { SkippedAnnot } from './formdata.js';

/** The annotation array plus the indirect objects it references. */
export interface FdfObjects {
  /** The value for the FDF's /Annots key: one ref per annotation. */
  array: PdfObject[];
  /** Object number → object body, for the writer to emit. */
  objects: Map<number, PdfObject>;
}

const ref = (num: number): PdfRef => ({ kind: 'ref', num, gen: 0 });

/** An annotation's /NM as a string; undefined when absent. */
function nameOf(dict: PdfDict): string | undefined {
  const nm = dict.get('NM');
  return isString(nm) ? decodePdfText(nm.bytes) : undefined;
}

/** Serialize annotations as an FDF /Annots subgraph, numbering objects from
 *  `firstObj`. Inline streams become their own objects (PDF has no inline
 *  stream syntax) and name links become real refs between the emitted dicts. */
export function writeFdfAnnots(annots: AnnotData[], firstObj: number): FdfObjects {
  const objects = new Map<number, PdfObject>();
  let next = firstObj;
  const alloc = (o: PdfObject): PdfRef => { const n = next++; objects.set(n, o); return ref(n); };

  /** Copy, promoting every inline stream to an indirect object. */
  const promote = (v: PdfObject): PdfObject => {
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, promote(e));
      return alloc({ kind: 'stream', dict, raw: v.raw });
    }
    if (isArray(v)) return v.map(promote);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, promote(e));
      return out;
    }
    return v;
  };

  // Pass 1: allocate a number for every annotation, so links can be resolved.
  const slot = new Map<AnnotData, number>();
  for (const a of annots) slot.set(a, next++);
  const byName = new Map<string, number>();
  for (const a of annots) {
    const nm = nameOf(a.dict);
    if (nm !== undefined) byName.set(nm, slot.get(a)!);
  }

  // Pass 2: fill each slot.
  const array: PdfObject[] = [];
  for (const a of annots) {
    const dict: PdfDict = new Map<string, PdfObject>();
    for (const [k, v] of a.dict) dict.set(k, promote(v));
    dict.set('Page', a.page);   // FDF's own record of the target page, 0-based
    if (a.popupName !== undefined) {
      const target = byName.get(a.popupName);
      if (target !== undefined) dict.set('Popup', ref(target));
    }
    if (a.inReplyTo !== undefined) {
      const target = byName.get(a.inReplyTo);
      if (target !== undefined) dict.set('IRT', ref(target));
    }
    const n = slot.get(a)!;
    objects.set(n, dict);
    array.push(ref(n));
  }
  return { array, objects };
}

/** Read an FDF /Annots array into the neutral model. References are inlined so
 *  each dict stands alone; /Popup and /IRT are lifted back into name links,
 *  which is what keeps the inlining acyclic. */
export function readFdfAnnots(
  arr: PdfObject, resolve: (o: PdfObject) => PdfObject, skipped: SkippedAnnot[],
): AnnotData[] {
  if (!isArray(arr)) return [];

  /** Deep copy with refs resolved; a ref already on the path becomes null. */
  const inline = (v: PdfObject, path: Set<number>): PdfObject => {
    if (isRef(v)) {
      const num = (v as PdfRef).num;
      if (path.has(num)) return null;
      path.add(num);
      const out = inline(resolve(v), path);
      path.delete(num);
      return out;
    }
    if (isArray(v)) return v.map((e) => inline(e, path));
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, inline(e, path));
      return out;
    }
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, inline(e, path));
      return { kind: 'stream', dict, raw: v.raw };
    }
    return v;
  };

  const out: AnnotData[] = [];
  for (const entry of arr) {
    const d = resolve(entry);
    if (!isDict(d)) continue;
    const sub = d.get('Subtype');
    const subtype = isName(sub) ? sub.name : undefined;

    const pageRaw = resolve(d.get('Page') ?? null);
    if (typeof pageRaw !== 'number' || !Number.isInteger(pageRaw) || pageRaw < 0) {
      skipped.push({ ...(subtype ? { subtype } : {}), reason: 'missing page index' });
      continue;
    }

    // Lift the sibling links to names before inlining, so no cycle is possible.
    const popupTarget = resolve(d.get('Popup') ?? null);
    const irtTarget = resolve(d.get('IRT') ?? null);
    const popupName = isDict(popupTarget) ? nameOf(popupTarget) : undefined;
    const inReplyTo = isDict(irtTarget) ? nameOf(irtTarget) : undefined;

    const dict: PdfDict = new Map<string, PdfObject>();
    for (const [k, v] of d) {
      if (k === 'Page' || k === 'Popup' || k === 'IRT' || k === 'P' ||
          k === 'Parent' || k === 'StructParent') continue;
      dict.set(k, inline(v, new Set<number>()));
    }

    const a: AnnotData = { page: pageRaw, dict };
    if (popupName !== undefined) a.popupName = popupName;
    if (inReplyTo !== undefined) a.inReplyTo = inReplyTo;
    out.push(a);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/fdfannot.test.ts`
Expected: PASS, eight cases.

- [ ] **Step 5: Commit**

```bash
git add src/fdfannot.ts test/fdfannot.test.ts
git commit -m "feat(fdf): annotations as a PDF object subgraph in /Annots"
```

---

### Task 8: Wire annotations into the two containers

**Files:**
- Modify: `src/fdf.ts`
- Modify: `src/xfdf.ts`
- Modify: `test/fdf.test.ts`, `test/xfdf.test.ts`

**Interfaces:**
- Consumes: `writeFdfAnnots` / `readFdfAnnots` (Task 7), `writeAnnots` / `readAnnots` (Tasks 5–6).
- Produces: `readFdf(bytes): FormData` and `readXfdf(bytes): FormData` now populate `annots`; `writeFdf(data)` / `writeXfdf(data)` emit them. Signatures are unchanged — the payload travels on `FormData`.

- [ ] **Step 1: Write the failing tests**

Append to `test/fdf.test.ts`:

```ts
import type { AnnotData } from '../src/annotdata.js';
import { name } from '../src/types.js';

const sq = (): AnnotData => ({
  page: 1,
  dict: new Map([
    ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
  ] as [string, PdfObject][]),
});

describe('FDF annotations', () => {
  it('writes /Annots and its objects when annots are present', () => {
    const out = dec(writeFdf({ fields: [], annots: [sq()] }));
    expect(out).toContain('/Annots');
    expect(out).toContain('/Subtype /Square');
    expect(out).toContain('2 0 obj');   // the annotation, after the FDF catalog
  });

  it('omits /Annots entirely when there are none', () => {
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/Annots');
  });

  it('round-trips an annotation through write and read', () => {
    const back = readFdf(writeFdf({ fields: [], annots: [sq()] }));
    expect(back.annots?.length).toBe(1);
    expect(back.annots![0].page).toBe(1);
    expect(back.annots![0].dict.get('Rect')).toEqual([0, 0, 10, 10]);
  });

  it('reads a file with no /Annots as having no annotations', () => {
    const back = readFdf(writeFdf({ fields: [] }));
    expect(back.annots ?? []).toEqual([]);
  });
});
```

Append the equivalent to `test/xfdf.test.ts`, asserting on `<annots>` and `<square` in the emitted XML, and the same round-trip through `readXfdf(writeXfdf(...))`.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/fdf.test.ts test/xfdf.test.ts`
Expected: FAIL — no `/Annots` in the output.

- [ ] **Step 3: Wire up `fdf.ts`**

The FDF catalog is object 1, so annotations number from 2. Replace the body of `writeFdf`:

```ts
export function writeFdf(data: FormData): Uint8Array {
  const fields: PdfObject[] = data.fields.map((f) => {
    const d: PdfDict = new Map<string, PdfObject>();
    d.set('T', str(f.name));
    d.set('V', fieldValue(f));
    if (f.richText !== undefined) d.set('RV', str(f.richText));
    return d;
  });

  const fdf: PdfDict = new Map<string, PdfObject>();
  fdf.set('Fields', fields);
  if (data.file !== undefined) fdf.set('F', str(data.file));
  if (data.id !== undefined)
    fdf.set('ID', [hexString(data.id[0]), hexString(data.id[1])]);

  // Annotations become indirect objects numbered from 2; the catalog is 1.
  let extra = '';
  if (data.annots !== undefined && data.annots.length > 0) {
    const { array, objects } = writeFdfAnnots(data.annots, 2);
    fdf.set('Annots', array);
    for (const [num, obj] of [...objects].sort((a, b) => a[0] - b[0]))
      extra += `${num} 0 obj\n${latin1(serializeObject(obj))}\nendobj\n`;
  }

  const root: PdfDict = new Map<string, PdfObject>([['FDF', fdf]]);
  return enc(
    '%FDF-1.2\n' +
    `1 0 obj\n${serializeValue(root)}\nendobj\n` +
    extra +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n');
}
```

`serializeObject` handles streams as well as values; import it from `./serialize.js`. `enc` encodes latin1-safe text — `serializeObject` returns bytes, so `latin1()` converts them back to the string being assembled. Stream `raw` bytes survive this because `latin1` is byte-transparent in both directions.

In `readFdf`, after the `/Fields` walk:

```ts
  const annots = resolve(fdf.get('Annots') ?? null);
  const skippedAnnots: SkippedAnnot[] = [];
  const list = readFdfAnnots(annots, resolve, skippedAnnots);
  if (list.length > 0) data.annots = list;
```

`skippedAnnots` is discarded here — `readFdf` returns only `FormData`. Task 9 wires the reported skips through `document.ts`, which re-runs the read with a report in hand. **Simpler:** give `FormData` an optional `annotSkips?: SkippedAnnot[]` field, set it here when non-empty, and have `applyFormData` copy it into the report. Do that.

- [ ] **Step 4: Wire up `xfdf.ts`**

In `writeXfdf`, after `root.children.push(fields);`:

```ts
  if (data.annots !== undefined && data.annots.length > 0)
    root.children.push(writeAnnots(data.annots));
```

In `readXfdf`, after the fields walk:

```ts
  const skips: SkippedAnnot[] = [];
  const list = readAnnots(root, skips);
  if (list.length > 0) data.annots = list;
  if (skips.length > 0) data.annotSkips = skips;
```

- [ ] **Step 5: Add `annotSkips` to `FormData`**

In `src/formdata.ts`:

```ts
  /** Annotations the format module could not read. Surfaced on ImportReport. */
  annotSkips?: SkippedAnnot[];
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/fdf.test.ts test/xfdf.test.ts test/fdfannot.test.ts test/xfdfannot.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fdf.ts src/xfdf.ts src/formdata.ts test/fdf.test.ts test/xfdf.test.ts
git commit -m "feat(fdf,xfdf): carry annotations in the data-file containers"
```

---

### Task 9: Public API — options on the four methods

**Files:**
- Modify: `src/formdata.ts`, `src/document.ts`, `src/node.ts`, `src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // document.ts
  ExportFdf(opts?: ExportFormDataOptions): Uint8Array
  ExportXfdf(opts?: ExportFormDataOptions): Uint8Array
  ImportFdf(bytes: Uint8Array, opts?: ImportOptions): ImportReport
  ImportXfdf(bytes: Uint8Array, opts?: ImportOptions): ImportReport
  // node.ts
  importFdfFile(pdfPath, fdfPath, outPath?, options?: ImportOptions): Promise<ImportReport>
  importXfdfFile(pdfPath, xfdfPath, outPath?, options?: ImportOptions): Promise<ImportReport>
  ```

- [ ] **Step 1: Route the flag through `formdata.ts`**

In `collectFormData`, before the `return`:

```ts
  if (opts.annotations) {
    const annots = collectAnnots(doc);
    if (annots.length > 0) out.annots = annots;
  }
```

Change `applyFormData`'s signature to `applyFormData(doc: Document, data: FormData, opts: ImportOptions = {})` and add, before the `return report`:

```ts
  if (data.annotSkips !== undefined) report.skippedAnnots.push(...data.annotSkips);
  if (opts.annotations && data.annots !== undefined) applyAnnots(doc, data.annots, report);
```

Note the field-level early return for a document with no AcroForm sits above this. Move that early return's body so annotations are still applied when the document has no form: a document can legitimately carry annotations and no fields. Restructure as:

```ts
  if (!hasAcroForm(doc)) {
    for (const e of data.fields)
      report.skipped.push({ name: e.name, reason: 'document has no form' });
  } else {
    // ... the existing field loop, unchanged ...
  }
  if (data.annotSkips !== undefined) report.skippedAnnots.push(...data.annotSkips);
  if (opts.annotations && data.annots !== undefined) applyAnnots(doc, data.annots, report);
  return report;
```

- [ ] **Step 2: Update `document.ts`**

```ts
  /** Import field values from an FDF data file. Fields with no match in this
   *  document, and values the field rejects, are reported rather than thrown.
   *  Appearance streams are regenerated for every field that is set.
   *  Pass `{ annotations: true }` to apply the file's annotations too. */
  ImportFdf(bytes: Uint8Array, opts: ImportOptions = {}): ImportReport {
    return applyFormData(this, readFdf(bytes), opts);
  }

  /** Import field values from an XFDF data file. See ImportFdf. */
  ImportXfdf(bytes: Uint8Array, opts: ImportOptions = {}): ImportReport {
    return applyFormData(this, readXfdf(bytes), opts);
  }
```

`ExportFdf` / `ExportXfdf` need no change — the flag rides on `ExportFormDataOptions`, which they already forward. Add `ImportOptions` to the `formdata.js` import.

- [ ] **Step 3: Update `node.ts`**

```ts
export async function importFdfFile(
  pdfPath: string,
  fdfPath: string,
  outPath = pdfPath,
  options?: ImportOptions,
): Promise<ImportReport> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  const report = doc.ImportFdf(new Uint8Array(await readFile(fdfPath)), options);
  await writeFile(outPath, doc.Save());
  return report;
}
```

Same shape for `importXfdfFile`. The export wrappers already forward `options` and need no change.

- [ ] **Step 4: Export the new types from `index.ts`**

Add to the existing `formdata.js` type export line: `ImportOptions`, `ImportedAnnot`, `SkippedAnnot`; and from `annotdata.js`: `AnnotData`. Match the existing `export type { … } from './…js';` style in that file.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/formdata.ts src/document.ts src/node.ts src/index.ts
git commit -m "feat(fdf,xfdf): annotations option on the import and export API"
```

---

### Task 10: End-to-end round-trip tests, README, spec note

**Files:**
- Create: `test/annot-roundtrip.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-20-xfdf-annotation-roundtrip-design.md`

**Interfaces:**
- Consumes: the whole public surface from Task 9.

- [ ] **Step 1: Write the end-to-end tests**

Create `test/annot-roundtrip.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotRoundtrip } from './helpers/build-annot-roundtrip.js';
import { PdfDict, isDict, isStream } from '../src/types.js';

/** Export from a fresh fixture, import into another, in the named format. */
function roundTrip(format: 'fdf' | 'xfdf') {
  const src = Document.Open(buildAnnotRoundtrip());
  const bytes = format === 'fdf'
    ? src.ExportFdf({ annotations: true })
    : src.ExportXfdf({ annotations: true });
  const dst = Document.Open(buildAnnotRoundtrip());
  // Strip the target's own annotations so we observe only what was imported.
  for (const p of dst.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
  const report = format === 'fdf'
    ? dst.ImportFdf(bytes, { annotations: true })
    : dst.ImportXfdf(bytes, { annotations: true });
  return { src, dst, report, bytes };
}

/** The decoded /AP /N bytes of an annotation, or undefined. */
function apBytes(doc: Document, dict: PdfDict): Uint8Array | undefined {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve((ap as PdfDict).get('N'));
  return isStream(n) ? n.raw : undefined;
}

for (const format of ['fdf', 'xfdf'] as const) {
  describe(`${format} annotation round-trip`, () => {
    it('carries every non-widget annotation to the right page', () => {
      const { dst, report } = roundTrip(format);
      expect(report.importedAnnots.length).toBe(4);
      expect(dst.Pages[0].Annotations.length).toBe(3);
      expect(dst.Pages[1].Annotations.length).toBe(1);
    });

    it('never carries the widget annotation', () => {
      const { dst } = roundTrip(format);
      for (const p of dst.Pages)
        for (const a of p.Annotations) expect(a.Subtype).not.toBe('Widget');
    });

    it('preserves properties on the highlight', () => {
      const { dst } = roundTrip(format);
      const hi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(hi.Rect).toEqual([0, 0, 100, 20]);
      expect(hi.Color).toEqual([1, 1, 0]);
      expect(hi.Opacity).toBeCloseTo(0.4, 6);
      expect(hi.Contents).toBe('a reply');
    });

    it('preserves the appearance stream byte-for-byte', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      // Give the square an appearance so there is one to preserve.
      const sq = src.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      const before = apBytes(src, sq.Dict);
      const bytes = format === 'fdf'
        ? src.ExportFdf({ annotations: true })
        : src.ExportXfdf({ annotations: true });
      const dst = Document.Open(buildAnnotRoundtrip());
      for (const p of dst.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
      if (format === 'fdf') dst.ImportFdf(bytes, { annotations: true });
      else dst.ImportXfdf(bytes, { annotations: true });
      const after = apBytes(dst, dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!.Dict);
      if (before !== undefined) expect(after).toEqual(before);
    });

    it('relinks the popup and the reply', () => {
      const { dst } = roundTrip(format);
      const note = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Text')!;
      const hi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(isDict(dst.resolve(note.Dict.get('Popup')))).toBe(true);
      expect(dst.resolve(hi.Dict.get('IRT'))).toBe(note.Dict);
    });

    it('is idempotent: importing twice does not duplicate', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = format === 'fdf'
        ? src.ExportFdf({ annotations: true })
        : src.ExportXfdf({ annotations: true });
      const dst = Document.Open(buildAnnotRoundtrip());
      const imp = () => format === 'fdf'
        ? dst.ImportFdf(bytes, { annotations: true })
        : dst.ImportXfdf(bytes, { annotations: true });
      imp();
      const afterFirst = dst.Pages.map((p) => p.Annotations.length);
      imp();
      expect(dst.Pages.map((p) => p.Annotations.length)).toEqual(afterFirst);
    });

    it('carries no annotations when the flag is off', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = format === 'fdf' ? src.ExportFdf() : src.ExportXfdf();
      const dst = Document.Open(buildAnnotRoundtrip());
      for (const p of dst.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
      const report = format === 'fdf'
        ? dst.ImportFdf(bytes, { annotations: true })
        : dst.ImportXfdf(bytes, { annotations: true });
      expect(report.importedAnnots).toEqual([]);
    });

    it('ignores annotations in the file when the import flag is off', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = format === 'fdf'
        ? src.ExportFdf({ annotations: true })
        : src.ExportXfdf({ annotations: true });
      const dst = Document.Open(buildAnnotRoundtrip());
      for (const p of dst.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
      const report = format === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
      expect(report.importedAnnots).toEqual([]);
      expect(dst.Pages[0].Annotations.length).toBe(0);
    });

    it('still carries field values alongside the annotations', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = format === 'fdf'
        ? src.ExportFdf({ annotations: true })
        : src.ExportXfdf({ annotations: true });
      const dst = Document.Open(buildAnnotRoundtrip());
      const report = format === 'fdf'
        ? dst.ImportFdf(bytes, { annotations: true })
        : dst.ImportXfdf(bytes, { annotations: true });
      expect(report.imported).toContain('field1');
    });

    it('survives a Save/Open cycle', () => {
      const { dst } = roundTrip(format);
      const reopened = Document.Open(dst.Save());
      expect(reopened.Pages[0].Annotations.length).toBe(3);
      expect(reopened.Pages[1].Annotations.length).toBe(1);
    });
  });
}
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/annot-roundtrip.test.ts`
Expected: PASS, both formats. Failures here are integration bugs in Tasks 3–9 — fix the module at fault, not the test, unless the test's expectation is provably wrong.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, everything.

- [ ] **Step 4: Update the README**

In the forms section, document `{ annotations: true }` on all four methods and the extended `ImportReport` (`importedAnnots`, `skippedAnnots`). Under Limitations, add:

> Annotation round-trip carries the 18 XFDF annotation types. Appearance
> streams travel verbatim in FDF, and in XFDF through an `<appearance>`
> encoding this library defines (the standard does not specify one); an
> appearance from another producer that cannot be read is regenerated from the
> annotation's properties instead. Annotation coordinates are exchanged in
> unrotated PDF user space — `/Rotate` and `/UserUnit` are not applied.
> Annotations of types outside the XFDF vocabulary are reported in
> `skippedAnnots` rather than carried.

- [ ] **Step 5: Record the "As built" note in the spec**

Add to the spec's §"Cross-references between annotations":

> **As built:** `/Popup` and `/IRT` are normalized to `/NM` name links in
> `annotdata.ts` for *both* formats, rather than surviving as refs on the FDF
> path. A self-contained dict cannot hold the reference cycle those keys form
> (`/Popup` → popup → `/Parent` → back). Import's two-pass resolution rebuilds
> real refs identically for FDF and XFDF, so the outcome is as specified.

Add to §"Appearance transport", if implementation found any further divergence, a matching **As built:** note.

- [ ] **Step 6: Commit**

```bash
git add test/annot-roundtrip.test.ts README.md docs/superpowers/specs/2026-07-20-xfdf-annotation-roundtrip-design.md
git commit -m "test(xfdf): end-to-end annotation round-trip, docs and spec notes"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-73p
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Per `CLAUDE.md`, the work is not complete until `git push` succeeds.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Neutral model (`AnnotData`) | 3 |
| Three modules (`annotdata`, `xfdfannot`, `fdfannot`) | 2–3, 5–6, 7 |
| Widget exclusion | 3 (`collectAnnots`), verified in 10 |
| FDF deep copy, `/P`+`/StructParent` dropped | 7 |
| XFDF vocabulary table, all attribute groups | 5 (write), 6 (read) |
| Coordinates untransformed | 5–6 (no transform in either direction); documented in 10 |
| Unknown types reported | 6 (XFDF), 4 (`applyAnnots` guard) |
| `sound` / `caret` synthesized without a typed class | 3 (`XFDF_SUBTYPES` includes them), 4 |
| Appearance transport + codec | 6 |
| Fallback regeneration + the `annotation.ts` split | 1 |
| Popup / IRT by name, two-pass resolution | 3 (collect), 4 (apply), 5–7 (both formats) |
| Public API, options, extended report | 9 |
| Replace-by-`/NM` idempotence | 4, verified in 10 |
| Error-handling table | 4 (page range, unsupported type), 6 (missing page, malformed attr, unusable appearance) |
| Testing plan | every task; end-to-end in 10 |
| Documentation | 10 |

Every spec section maps to a task.

**Placeholder scan:** No TBD/TODO. Three steps direct the implementer to read existing code rather than quoting it — Task 1 Step 1 (the `frac` values at the `addUnderline`/`addStrikeOut` call sites), Task 1 Step 8 (the five geometry generators), and Task 9 Step 4 (`index.ts` export style). These are deliberate: quoting ~400 lines of `annotation.ts` into the plan would be a copy that silently rots against the file it duplicates. Each names the exact functions to read and states the acceptance criterion.

**Type consistency:** `AnnotData` / `ImportedAnnot` / `SkippedAnnot` / `ImportOptions` / `FdfObjects` are defined once and used with the same shape in every later task. `regenerateAppearance` returns `boolean` in Tasks 1 and 4. `readAnnots(node, skipped)` and `readFdfAnnots(arr, resolve, skipped)` keep their argument order across Tasks 6–8. `annotSkips` on `FormData` is introduced in Task 8 Step 5 and consumed in Task 9 Step 1.

**One risk worth naming:** Task 1 is a refactor of a 1733-line module that four test files depend on. It is deliberately split into two commits — the verbatim move (Steps 1–4, gated on the existing tests passing untouched) and the new entry point (Steps 5–11). If the move cannot be made verbatim, stop and reconsider the split rather than rewriting tests to fit.
