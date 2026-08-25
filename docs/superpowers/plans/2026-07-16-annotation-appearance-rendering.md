# Annotation /AP Appearance Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `page.ToImage()` and `page.ToSvg()` composite annotation and form-field `/AP /N` appearance streams over the page content, at the correct position and scale, skipping hidden/noview/popup annotations.

**Architecture:** Both backends already funnel through `interpret()` in `src/pagerender.ts`, whose `drawForm()` already does `/Matrix ∘ CTM` + `/BBox` clip + own `/Resources` + depth/cycle guards. The feature is a post-content pass over `/Annots` that reuses `drawForm`, so SVG and raster both light up with no backend changes. The `/AP` selection rules already exist in `src/flatten.ts` but in a doc-mutating form; they move to a new read-only `src/annotappearance.ts` that both consumers build on.

**Tech Stack:** TypeScript (strict, ESM + NodeNext — import specifiers carry `.js`), vitest. Zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-16-annotation-appearance-rendering-design.md`
Issue: `aspose-pdf-foss-for-ts-57b`

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, `strict: true`** — every relative import specifier ends in `.js` (e.g. `import { isDict } from './types.js'`).
- **`tsconfig.json` does NOT set `noUnusedLocals`** — unused imports will *not* fail `npm run typecheck`. When a refactor orphans an import, you must remove it by hand.
- **Both gates must be green before closing:** `npm run typecheck` and `npm test`.
- **Rendering never mutates the document.** `src/annotappearance.ts` must not call `doc.allocObject` or any setter. That mutation belongs to `src/flatten.ts` alone.
- **Render entry points never throw** — `renderPageToSvg` / `renderPageToPng` degrade instead.
- **`/D` (down) appearances are out of scope.** Only `/N`, with `/AS` selecting a sub-state within it.
- **Flatten's behavior must not change in this plan.** It keeps its own Hidden|NoView visibility check and does *not* adopt `isAnnotVisible` (which also excludes `/Popup`). Converging them is issue `aspose-pdf-foss-for-ts-vdp`.
- **Task tracking is `bd`, not TodoWrite/markdown TODOs** (see `CLAUDE.md`).

## File Structure

| File | Responsibility |
|---|---|
| `src/annotappearance.ts` (create) | The single home for `/AP` display rules: visibility predicate + read-only appearance resolution (`/N`, `/AS`, `/Rect`+`/BBox`+`/Matrix` placement). |
| `src/flatten.ts` (modify) | Keeps baking + its own visibility policy; delegates appearance *resolution* to `annotappearance.ts`, adds ref promotion on top. |
| `src/pagerender.ts` (modify) | Adds the post-content `/Annots` pass + `InterpretOptions`. |
| `src/svgrender.ts` (modify) | `SvgOptions.annotations` → `interpret`. |
| `src/raster.ts` (modify) | `ImageOptions.annotations` → `interpret`. |
| `test/helpers/build-annot-render-target.ts` (create) | Fixture for the render-only edge cases (Popup, NoView, missing `/AS` state, no `/BBox`, throwing `/AP`). |
| `test/annotappearance.test.ts` (create) | Unit tests for the new module. |
| `test/annotrender.test.ts` (create) | End-to-end render tests, both backends. |

**Fixture reuse:** `test/helpers/build-flatten-target.ts` already exports `buildFlattenTarget()` (visible identity-`/Matrix` stamp, `/Matrix [2 0 0 2 0 0]` stamp, Hidden stamp, no-`/AP` stamp) and `buildFlattenStateTarget()` (widget with an `/N` state subdict + `/AS`). Import them; do **not** duplicate. The new builder covers only what they lack.

---

### Task 1: `src/annotappearance.ts` — read-only /AP resolution

**Files:**
- Create: `src/annotappearance.ts`
- Create: `test/helpers/build-annot-render-target.ts`
- Create: `test/annotappearance.test.ts`

**Interfaces:**
- Consumes: `Document.resolve`, `placementMatrix(bbox: number[], m: Matrix, rect: number[]): Matrix | undefined` from `src/text.ts`, type guards from `src/types.ts`.
- Produces (later tasks rely on these exact names):
  - `FLAG_HIDDEN: number`, `FLAG_NOVIEW: number` (exported consts)
  - `annotFlags(doc: Document, annot: PdfDict): number`
  - `isAnnotVisible(doc: Document, annot: PdfDict): boolean`
  - `interface AnnotAppearance { entry: PdfObject; stream: PdfStream; place: Matrix }`
  - `resolveAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined`

- [ ] **Step 1: Write the render-only fixture builder**

Create `test/helpers/build-annot-render-target.ts`. The local `assemble` / `formXObject` helpers are copied from `build-flatten-target.ts` — that duplication is the established house pattern (12 builders in `test/helpers/` each roll their own `assemble`).

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
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

/** A Form XObject stream object body with the given dict extras and content. */
function formXObject(extra: string, content: string): string {
  return `<< /Type /XObject /Subtype /Form ${extra} /Length ${byteLen(content)} >>\n` +
    `stream\n${content}\nendstream`;
}

/**
 * One 200x200 page of render-only annotation edge cases. Every annotation sits
 * in the y range [10 30] so a single device row (y=180) probes them all.
 *
 *  - obj 4:  /Popup at x [10 30] with a usable /AP (obj 5, green) — a viewer
 *            draws popups only when open, so a static render must skip it.
 *  - obj 6:  NoView (/F 32) stamp at x [40 60] sharing that /AP — skipped.
 *  - obj 7:  widget at x [70 90] whose /AS names a state absent from the /N
 *            subdict — no usable appearance.
 *  - obj 8:  stamp at x [100 120] whose /AP /N stream (obj 9) has no /BBox —
 *            unplaceable.
 *  - obj 12: stamp at x [160 180] whose /AP /N (obj 13) declares /FlateDecode
 *            over non-deflate bytes — inflating it throws inside drawForm.
 *  - obj 10: a well-formed BLUE stamp at x [130 150], listed in /Annots AFTER
 *            the throwing one, proving a malformed appearance does not suppress
 *            the annotations that follow it.
 */
export function buildAnnotRenderTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 6 0 R 7 0 R 8 0 R 12 0 R 10 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Popup /Rect [10 10 30 30] /F 4 /AP << /N 5 0 R >> >>`;
  objects[5] = formXObject(`/BBox [0 0 20 20]`, `q 0 1 0 rg 0 0 20 20 re f Q`);  // green
  objects[6] = `<< /Type /Annot /Subtype /Stamp /Rect [40 10 60 30] /F 32 /AP << /N 5 0 R >> >>`;
  objects[7] = `<< /Type /Annot /Subtype /Widget /Rect [70 10 90 30] /F 4 ` +
    `/AS /Missing /AP << /N << /On 5 0 R >> >> >>`;
  objects[8] = `<< /Type /Annot /Subtype /Stamp /Rect [100 10 120 30] /F 4 /AP << /N 9 0 R >> >>`;
  objects[9] = formXObject(``, `q 0 1 0 rg 0 0 20 20 re f Q`);                   // no /BBox
  objects[10] = `<< /Type /Annot /Subtype /Stamp /Rect [130 10 150 30] /F 4 /AP << /N 11 0 R >> >>`;
  objects[11] = formXObject(`/BBox [0 0 20 20]`, `q 0 0 1 rg 0 0 20 20 re f Q`); // blue
  objects[12] = `<< /Type /Annot /Subtype /Stamp /Rect [160 10 180 30] /F 4 /AP << /N 13 0 R >> >>`;
  objects[13] = formXObject(`/BBox [0 0 20 20] /Filter /FlateDecode`, `not-deflate-data`);
  return assemble(objects, 13, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/annotappearance.test.ts`.

`buildFlattenTarget()`'s `/Annots` is `[4 0 R 6 0 R 8 0 R 9 0 R]` → index 0 = visible identity-`/Matrix` stamp (`/Rect [10 20 110 60]`, `/BBox [0 0 100 40]`), index 1 = `/Matrix [2 0 0 2 0 0]` stamp (`/Rect [0 100 100 140]`, `/BBox [0 0 50 20]`), index 2 = Hidden (`/F 2`), index 3 = no `/AP`.

`buildAnnotRenderTarget()`'s `/Annots` is `[4 0 R 6 0 R 7 0 R 8 0 R 12 0 R 10 0 R]` → index 0 = Popup, 1 = NoView, 2 = `/AS` missing state, 3 = no `/BBox`, 4 = throwing `/AP`, 5 = good blue stamp.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isAnnotVisible, resolveAppearance, annotFlags } from '../src/annotappearance.js';
import { isDict, PdfDict } from '../src/types.js';
import { buildFlattenTarget, buildFlattenStateTarget } from './helpers/build-flatten-target.js';
import { buildAnnotRenderTarget } from './helpers/build-annot-render-target.js';

/** The i-th entry of page 0's /Annots, resolved to a dict. */
function annotAt(doc: Document, i: number): PdfDict {
  const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
  const d = doc.resolve(annots[i] as never);
  if (!isDict(d)) throw new Error(`/Annots[${i}] is not a dict`);
  return d;
}

/** An unfiltered appearance stream's raw content, as text. */
const streamText = (s: { raw: Uint8Array }) => new TextDecoder('latin1').decode(s.raw);

describe('isAnnotVisible', () => {
  it('accepts a normal printable annotation', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(isAnnotVisible(doc, annotAt(doc, 0))).toBe(true);
  });

  it('rejects a Hidden annotation (/F bit 2)', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(annotFlags(doc, annotAt(doc, 2))).toBe(2);
    expect(isAnnotVisible(doc, annotAt(doc, 2))).toBe(false);
  });

  it('rejects a NoView annotation (/F bit 6)', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(annotFlags(doc, annotAt(doc, 1))).toBe(32);
    expect(isAnnotVisible(doc, annotAt(doc, 1))).toBe(false);
  });

  it('rejects a /Popup annotation even when it has a usable appearance', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(isAnnotVisible(doc, annotAt(doc, 0))).toBe(false);
    // it *does* have a resolvable appearance — visibility is the only reason to skip
    expect(resolveAppearance(doc, annotAt(doc, 0))).toBeDefined();
  });

  it('treats a missing /F as 0 (visible)', () => {
    const doc = Document.Open(buildFlattenTarget());
    const a = annotAt(doc, 0);
    a.delete('F');
    expect(annotFlags(doc, a)).toBe(0);
    expect(isAnnotVisible(doc, a)).toBe(true);
  });
});

describe('resolveAppearance', () => {
  it('maps an identity-/Matrix /BBox onto /Rect', () => {
    const doc = Document.Open(buildFlattenTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(ap).toBeDefined();
    // /BBox 100x40 -> /Rect [10 20 110 60] (100x40) -> sx=sy=1, translate to origin
    expect(ap.place).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it('accounts for the appearance /Matrix when computing placement', () => {
    const doc = Document.Open(buildFlattenTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 1))!;
    // /BBox 50x20 scaled x2 by /Matrix -> apparent 100x40 -> /Rect 100x40 -> sx=sy=1
    expect(ap.place).toEqual([1, 0, 0, 1, 0, 100]);
  });

  it('returns the un-promoted entry and the resolved stream, without mutating', () => {
    const doc = Document.Open(buildFlattenTarget());
    const before = doc.Pages[0].Dict.get('Annots');
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(ap.entry).toEqual({ kind: 'ref', num: 5, gen: 0 });
    expect(streamText(ap.stream)).toContain('0 0 1 rg');
    expect(doc.Pages[0].Dict.get('Annots')).toBe(before);
  });

  it('selects the /N sub-state named by /AS', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(streamText(ap.stream)).toContain('0 1 0 rg');  // the /On (green) state
  });

  it('returns undefined when /AS names a state absent from the /N subdict', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(resolveAppearance(doc, annotAt(doc, 2))).toBeUndefined();
  });

  it('returns undefined when the annotation has no /AP', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(resolveAppearance(doc, annotAt(doc, 3))).toBeUndefined();
  });

  it('returns undefined when the appearance stream has no /BBox', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(resolveAppearance(doc, annotAt(doc, 3))).toBeUndefined();
  });

  it('returns undefined for a degenerate (zero-extent) /BBox', () => {
    const doc = Document.Open(buildFlattenTarget());
    const a = annotAt(doc, 0);
    const ap = doc.resolve(a.get('AP')) as PdfDict;
    const s = doc.resolve(ap.get('N')) as { dict: PdfDict };
    s.dict.set('BBox', [0, 0, 0, 0]);
    expect(resolveAppearance(doc, a)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run test/annotappearance.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/annotappearance.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/annotappearance.ts`:

```ts
// Read-only resolution of an annotation's /AP appearance: which stream a viewer
// draws, and where. The single home for the /AP display rules, shared by the
// render pass (pagerender.ts) and the flatten pass (flatten.ts).
//
// Never mutates the document. Flatten layers its own ref promotion on top —
// rendering must not, so the raw /N entry is returned un-promoted alongside the
// resolved stream and each consumer takes what it needs.
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream } from './types.js';
import { placementMatrix, type Matrix } from './text.js';

// Annotation flag bits (/F), PDF 32000-1 §12.5.3.
export const FLAG_HIDDEN = 1 << 1; // bit 2, value 2 — not displayed at all
export const FLAG_NOVIEW = 1 << 5; // bit 6, value 32 — displayed on print only, not on screen

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Resolve `o` to a fixed-length array of finite numbers, or undefined. */
function numArray(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

/** The annotation's /F flag bitfield (0 when absent). */
export function annotFlags(doc: Document, annot: PdfDict): number {
  const f = doc.resolve(annot.get('F'));
  return typeof f === 'number' ? f : 0;
}

/**
 * True when a static page render should draw this annotation: not Hidden, not
 * NoView, and not a /Popup — a popup is the note window belonging to a parent
 * markup annotation, which viewers draw only while the note is open.
 *
 * Note flatten.ts deliberately does NOT use this: it bakes /Popup today, and
 * changing that is issue -vdp.
 */
export function isAnnotVisible(doc: Document, annot: PdfDict): boolean {
  if ((annotFlags(doc, annot) & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0) return false;
  const s = doc.resolve(annot.get('Subtype'));
  return !(isName(s) && s.name === 'Popup');
}

export interface AnnotAppearance {
  /** The raw /N (or /AS-selected) entry, un-promoted: a ref, or an inline stream. */
  entry: PdfObject;
  /** The resolved appearance stream. */
  stream: PdfStream;
  /** Maps the /Matrix-transformed /BBox onto /Rect (PDF 32000-1 §12.5.5). */
  place: Matrix;
}

/** The raw /AP /N entry to draw. /N is either a single appearance stream or a
 *  state subdictionary keyed by the annotation's /AS appearance state. */
function normalEntry(doc: Document, annot: PdfDict): PdfObject | undefined {
  const ap = doc.resolve(annot.get('AP'));
  if (!isDict(ap)) return undefined;

  const n = ap.get('N');
  const resolved = doc.resolve(n);
  if (isStream(resolved)) return n;

  if (isDict(resolved)) {
    const as = doc.resolve(annot.get('AS'));
    if (!isName(as)) return undefined;
    const entry = resolved.get(as.name);
    if (entry === undefined || !isStream(doc.resolve(entry))) return undefined;
    return entry;
  }
  return undefined;
}

/**
 * The appearance to draw for `annot` and where to place it, or undefined when
 * there is none usable: no /AP, an /N state subdict with no matching /AS, a
 * missing /Rect or /BBox, or a degenerate placement.
 */
export function resolveAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const entry = normalEntry(doc, annot);
  if (entry === undefined) return undefined;
  const stream = doc.resolve(entry);
  if (!isStream(stream)) return undefined;

  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const bbox = numArray(doc, stream.dict.get('BBox'), 4);
  if (bbox === undefined) return undefined;
  const m = (numArray(doc, stream.dict.get('Matrix'), 6) as Matrix | undefined) ?? IDENTITY;

  const place = placementMatrix(bbox, m, rect);
  if (place === undefined) return undefined;
  return { entry, stream, place };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/annotappearance.test.ts
npm run typecheck
```

Expected: PASS (all tests in the file), and typecheck clean.

If `expect(ap.entry).toEqual({ kind: 'ref', num: 5, gen: 0 })` fails, read the `PdfRef` shape in `src/types.ts` and correct the literal to match — the *intent* is "the entry is the original indirect reference, not a promoted copy".

- [ ] **Step 6: Commit**

```bash
git add src/annotappearance.ts test/annotappearance.test.ts test/helpers/build-annot-render-target.ts
git commit -m "feat(57b): add read-only /AP appearance resolution

New annotappearance.ts: isAnnotVisible (/F Hidden|NoView, /Popup) and
resolveAppearance (/N, /AS, /Rect+/BBox+/Matrix placement). Read-only —
the render pass must not mutate the document, so the raw /N entry is
returned un-promoted for flatten to promote itself.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Refactor `src/flatten.ts` onto the shared module

Behavior-preserving. The existing `test/flatten-annotations.test.ts`, `test/flatten-api.test.ts`, and `test/flatten-form.test.ts` are the regression net proving the extracted rules did not change meaning — **they must pass unchanged. Do not edit them.**

**Files:**
- Modify: `src/flatten.ts:1-115`

**Interfaces:**
- Consumes: `annotFlags`, `FLAG_HIDDEN`, `FLAG_NOVIEW`, `resolveAppearance` from Task 1.
- Produces: no public API change. `flattenAnnotations` / `flattenForm` signatures are untouched.

- [ ] **Step 1: Run the flatten tests to record the green baseline**

```bash
npx vitest run test/flatten-annotations.test.ts test/flatten-api.test.ts test/flatten-form.test.ts
```

Expected: PASS. Note the test count — it must be identical after the refactor.

- [ ] **Step 2: Replace the imports**

In `src/flatten.ts`, replace the import block (lines 1-20) with:

```ts
// Flatten track (Phase 4). L1: bake each annotation's /AP /N appearance stream
// into the page content as a Form XObject draw at its /Rect, then drop the
// annotation from /Annots. Append-only — no content rewriting (no F1 needed).
//
// The /AP resolution rules live in annotappearance.ts, shared with the render
// pass. Flatten adds the ref promotion (rendering must stay read-only) and keeps
// its own visibility check: unlike a renderer it bakes /Popup annotations today,
// and changing that is issue -vdp.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef } from './types.js';
import {
  appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, num,
} from './pagecontent.js';
import { annotFlags, resolveAppearance, FLAG_HIDDEN, FLAG_NOVIEW } from './annotappearance.js';
import { enc } from './serialize.js';
```

This drops the now-unused `PdfRef`, `isStream`, `placementMatrix`, `Matrix`, the local `IDENTITY`, and the local flag constants. `tsconfig.json` does not set `noUnusedLocals`, so typecheck will not catch a leftover — remove them deliberately.

- [ ] **Step 3: Delete the superseded local helpers**

Delete these three from `src/flatten.ts` entirely — `annotappearance.ts` now owns them:
- `numArray` (was lines ~23-33)
- `flags` (was lines ~36-39)
- `normalAppearanceRef` (was lines ~48-65)

- [ ] **Step 4: Rewrite the `flattenPageAnnots` loop body**

Replace the `for (const entry of annots) { ... }` loop in `flattenPageAnnots` with:

```ts
  for (const entry of annots) {
    const annot = doc.resolve(entry);
    if (!isDict(annot) || (annotFlags(doc, annot) & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0 || !accept(annot)) {
      keep.push(entry);
      continue;
    }
    const ap = resolveAppearance(doc, annot);
    if (ap === undefined) { keep.push(entry); continue; }

    // Rendering must not mutate, so resolveAppearance leaves /N un-promoted;
    // baking needs an indirect object to share from /Resources /XObject.
    const apRef = isRef(ap.entry) ? ap.entry : doc.allocObject(ap.stream);

    if (xobjs === undefined) {
      xobjs = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'XObject');
    }
    const key = freshKey(xobjs, 'Fm');
    xobjs.set(key, apRef);
    body += `q ${ap.place.map(num).join(' ')} cm /${key} Do Q\n`;
    count++;
    // annotation intentionally dropped from /Annots (not pushed to keep)
  }
```

- [ ] **Step 5: Run the flatten tests to verify no behavior change**

```bash
npx vitest run test/flatten-annotations.test.ts test/flatten-api.test.ts test/flatten-form.test.ts
npm run typecheck
```

Expected: PASS, with the same test count as Step 1. Typecheck clean.

If a flatten test now fails, the extraction changed meaning — fix `annotappearance.ts` or the loop, **do not edit the flatten tests.**

- [ ] **Step 6: Commit**

```bash
git add src/flatten.ts
git commit -m "refactor(57b): flatten builds on shared /AP resolution

Behavior-preserving: numArray/flags/normalAppearanceRef collapse into
annotappearance.ts. Flatten keeps its own Hidden|NoView check (it bakes
/Popup today — see -vdp) and its ref promotion. Existing flatten tests
pass unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The annotation render pass + SVG backend

**Files:**
- Modify: `src/pagerender.ts:159-166` (entry point) and its import block
- Modify: `src/svgrender.ts:12-15` (`SvgOptions`) and `:249-259` (`renderPageToSvg`)
- Create: `test/annotrender.test.ts`

**Interfaces:**
- Consumes: `isAnnotVisible`, `resolveAppearance` from Task 1; the existing private `drawForm(ctx: RenderCtx, gs: GState, stream: PdfStream): void` and `initialState(base: Matrix): GState` in `src/pagerender.ts`.
- Produces:
  - `interface InterpretOptions { annotations?: boolean }` exported from `src/pagerender.ts`
  - `interpret(doc, page, base, sink, opts?: InterpretOptions): void` — the 5th parameter is new and optional, so `src/raster.ts`'s existing call keeps compiling until Task 4.
  - `SvgOptions.annotations?: boolean`

**Matrix math (do not re-derive — assert exactly these):** `mul(A, B)` applies `A` then `B`. For `buildFlattenTarget()` (MediaBox `[0 0 300 200]`, so `base = [1,0,0,-1,0,200]`):
- annot 0: `place = [1,0,0,1,10,20]` → `gs.ctm = mul(place, base) = [1,0,0,-1,10,180]`; its `/Matrix` is identity, so `drawForm`'s `childCtm` is the same.
- annot 1: `place = [1,0,0,1,0,100]` → `mul(place, base) = [1,0,0,-1,0,100]`; `/Matrix [2 0 0 2 0 0]` → `childCtm = [2,0,0,-2,0,100]`.

`SvgSink.fill` emits attributes in the order `d`, `transform`, `fill` — match that order in regexes.

- [ ] **Step 1: Write the failing test**

Create `test/annotrender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFlattenTarget, buildFlattenStateTarget } from './helpers/build-flatten-target.js';
import { buildAnnotRenderTarget } from './helpers/build-annot-render-target.js';

describe('Page.ToSvg — annotation appearances', () => {
  it('composites a stamp /AP at its /Rect', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // /BBox 100x40 -> /Rect [10 20 110 60]; base flip [1 0 0 -1 0 200] -> [1 0 0 -1 10 180]
    expect(svg).toMatch(
      /<path d="M0 0L100 0L100 40L0 40Z" transform="matrix\(1 0 0 -1 10 180\)" fill="#0000ff"/);
  });

  it('applies the appearance /Matrix on top of the /Rect placement', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // /BBox 50x20, /Matrix [2 0 0 2 0 0], /Rect [0 100 100 140] -> [2 0 0 -2 0 100]
    expect(svg).toMatch(
      /<path d="M0 0L50 0L50 20L0 20Z" transform="matrix\(2 0 0 -2 0 100\)" fill="#ff0000"/);
  });

  it('skips Hidden and appearance-less annotations', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // exactly the two visible, appearance-bearing annots painted a fill
    const fills = svg.match(/<path [^>]*fill="#(?!none)[0-9a-f]{6}"/g) ?? [];
    expect(fills.length).toBe(2);
  });

  it('selects the /N sub-state named by /AS on a widget', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('fill="#00ff00"');   // /AS /On -> green
    expect(svg).not.toContain('fill="#ffffff"'); // the /Off state must not paint
  });

  it('skips /Popup and NoView annotations', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).not.toContain('fill="#00ff00"'); // the green /AP is only reachable via Popup/NoView
  });

  it('renders a good annotation listed after a malformed one', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('fill="#0000ff"');   // the blue stamp follows the throwing /AP
  });

  it('suppresses the pass with annotations: false', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg({ annotations: false });
    expect(svg).not.toContain('fill="#0000ff"');
    expect(svg).not.toContain('fill="#ff0000"');
  });

  it('does not mutate the document', () => {
    const doc = Document.Open(buildFlattenTarget());
    const annots = doc.Pages[0].Dict.get('Annots');
    const before = doc.Pages[0].Dict.get('Resources');
    doc.Pages[0].ToSvg();
    expect(doc.Pages[0].Dict.get('Annots')).toBe(annots);
    expect(doc.Pages[0].Dict.get('Resources')).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/annotrender.test.ts
```

Expected: FAIL — the appearance assertions find no `<path>` (annotations are not drawn yet), and `ToSvg({ annotations: false })` is a type error.

- [ ] **Step 3: Add the render pass to `src/pagerender.ts`**

Add to the import block:

```ts
import { isAnnotVisible, resolveAppearance } from './annotappearance.js';
```

Replace the entry point (currently lines 159-166) with:

```ts
// ---------- Entry point ----------

export interface InterpretOptions {
  /** Composite annotation /AP appearances after the page content. Default true. */
  annotations?: boolean;
}

/** Walk the page content under the base CTM, driving `sink`, then composite the
 *  annotation appearances over it. Never throws here; callers
 *  (renderPageToSvg / renderPageToPng) wrap with degrade-on-error. */
export function interpret(
  doc: Document, page: Page, base: Matrix, sink: RenderSink, opts: InterpretOptions = {},
): void {
  const ctx: RenderCtx = { doc, sink, resources: page.Resources, depth: 0, seen: new Set() };
  walk(ctx, page.Contents, initialState(base));
  if (opts.annotations !== false) drawAnnots(ctx, page, base);
}

/** Composite each visible annotation's /AP /N appearance over the page content
 *  (PDF 32000-1 §12.5.5). Each annotation is independent: it starts from a fresh
 *  graphics state — annotations do not inherit the page's, and one must not leak
 *  color/clip/text state into the next — and gets its own try/catch, so one
 *  malformed appearance cannot drop the annotations that follow it. */
function drawAnnots(ctx: RenderCtx, page: Page, base: Matrix): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const e of annots) {
    const annot = ctx.doc.resolve(e);
    if (!isDict(annot) || !isAnnotVisible(ctx.doc, annot)) continue;
    const ap = resolveAppearance(ctx.doc, annot);
    if (ap === undefined) continue;
    try {
      drawForm(ctx, initialState(mul(ap.place, base)), ap.stream);
    } catch {
      // Degrade: a malformed appearance costs only itself.
    }
  }
}
```

`drawForm` re-applies the stream's `/Matrix` on top of `mul(ap.place, base)`, giving the spec's `Matrix × place × base` — `placementMatrix` already mapped the *`/Matrix`-transformed* BBox onto `/Rect`, so this composition is correct, not a double-apply.

- [ ] **Step 4: Plumb the option through `src/svgrender.ts`**

Extend `SvgOptions` (currently lines 12-15):

```ts
export interface SvgOptions {
  /** Which page box defines the viewport. Default 'crop'. */
  box?: 'crop' | 'media';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
}
```

In `renderPageToSvg`, change the `interpret` call:

```ts
    interpret(doc, page, matrix, sink, { annotations: opts.annotations });
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/annotrender.test.ts
npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Run the full suite — existing render tests must stay green**

```bash
npm test
```

Expected: PASS. No current render fixture carries annotations, so the default-on change should disturb none of them. If a test outside `test/annot*` fails, stop and report it rather than adjusting the test — it means the pass is firing where it should not.

- [ ] **Step 7: Commit**

```bash
git add src/pagerender.ts src/svgrender.ts test/annotrender.test.ts
git commit -m "feat(57b): composite annotation /AP appearances in ToSvg

interpret() gains a post-content pass over /Annots that reuses drawForm,
so appearances get /Matrix, the /BBox clip, and their own /Resources for
free. Each annot starts from a fresh graphics state and is individually
try/caught. Opt out with { annotations: false }.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Raster backend

**Files:**
- Modify: `src/raster.ts:17-28` (`ImageOptions`) and `:1077-1081` (the `interpret` call)
- Modify: `test/annotrender.test.ts` (append a raster describe block)

**Interfaces:**
- Consumes: `InterpretOptions` behavior from Task 3; `decodePng` from `test/helpers/decode-png.js`.
- Produces: `ImageOptions.annotations?: boolean`.

**Device mapping:** default `scale: 1`, so user `(x, y)` on a 200-tall page → device `(x, 200 - y)`. On `buildAnnotRenderTarget` every annotation spans user y `[10 30]`, so device row `y = 180` cuts through all of them.

- [ ] **Step 1: Write the failing test**

Append to `test/annotrender.test.ts`:

```ts
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 6) => Math.abs(v - target) <= tol;

describe('Page.ToImage — annotation appearances', () => {
  it('paints a stamp /AP inside its /Rect and leaves the outside alone', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    // blue /AP at /Rect [10 20 110 60]; user (50,40) -> device (50,160)
    const [r, g, b] = png.at(50, 160);
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
    // user (150,100) -> device (150,100): outside every /Rect -> white
    expect(png.at(150, 100)).toEqual([255, 255, 255, 255]);
  });

  it('skips /Popup and NoView annotations', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(20, 180)).toEqual([255, 255, 255, 255]); // Popup   /Rect [10 10 30 30]
    expect(png.at(50, 180)).toEqual([255, 255, 255, 255]); // NoView  /Rect [40 10 60 30]
  });

  it('skips annotations with no usable appearance', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(80, 180)).toEqual([255, 255, 255, 255]);  // /AS names a missing state
    expect(png.at(110, 180)).toEqual([255, 255, 255, 255]); // /AP /N has no /BBox
  });

  it('renders a good annotation listed after one whose /AP throws', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(170, 180)).toEqual([255, 255, 255, 255]); // the throwing /AP paints nothing
    const [r, g, b] = png.at(140, 180);                     // ...but the blue stamp after it does
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
  });

  it('suppresses the pass with annotations: false', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage({ annotations: false }));
    expect(png.at(50, 160)).toEqual([255, 255, 255, 255]);
  });

  it('honors scale when placing an appearance', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage({ scale: 2 }));
    expect(png.width).toBe(600);
    // user (50,40) -> device (100,320) at scale 2
    const [r, g, b] = png.at(100, 320);
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/annotrender.test.ts
```

Expected: FAIL — the raster block finds white where the appearance should be, and `ToImage({ annotations: false })` is a type error.

- [ ] **Step 3: Plumb the option through `src/raster.ts`**

Add to `ImageOptions` (after the `background` field, ending line 27):

```ts
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
```

In `renderPageToPng`, change the `interpret` call:

```ts
    interpret(doc, page, device, sink, { annotations: opts.annotations });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/annotrender.test.ts
npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/raster.ts test/annotrender.test.ts
git commit -m "feat(57b): composite annotation /AP appearances in ToImage

The raster backend needs no changes beyond passing the option through —
the pass lives in the shared interpreter, so pixel output follows.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md:46` (Rendering bullet), `README.md:916` (SVG rendering limitation), `README.md:915` (stale flatten claim), the API-overview table (~line 828-868 region)
- Modify: `CLAUDE.md` (module map — the `svgrender.ts` / `raster.ts` / `pagerender.ts` bullet, and the `annotation.ts` bullet)

**Interfaces:**
- Consumes: the shipped public API — `SvgOptions.annotations`, `ImageOptions.annotations`, both default `true`.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the README Rendering bullet**

In the `- **Rendering (page → PNG)**` bullet (line 46), insert this sentence immediately before the closing `Unsupported content degrades rather than throwing.`:

```markdown
Annotation and form-field appearances composite over the page content: each visible annotation's `/AP /N` stream (with `/AS` selecting the sub-state for checkbox/radio widgets) is drawn as a Form XObject mapped from its `/BBox`+`/Matrix` onto its `/Rect`, so stamps, filled fields, and signature appearances render — pass `annotations: false` to draw page content only. Hidden (`/F` bit 2), NoView (`/F` bit 6), and `/Popup` annotations are skipped, as are those without a usable appearance; a malformed appearance degrades on its own without affecting the rest of the page.
```

- [ ] **Step 2: Update the README SVG rendering limitation bullet**

In the `- **SVG rendering is preview-grade**` bullet (line 916), insert after the first sentence (the one ending `depend on the viewer's fonts.`):

```markdown
Annotation and form-field `/AP` appearances composite by default (`annotations: false` to opt out), sharing the interpreter with `page.ToImage()`.
```

- [ ] **Step 3: Fix the stale flatten claim**

`README.md` line 915 (the `- **Annotation subtypes are a curated set**` bullet) ends with `..., and annotation flattening is out of scope.` — stale since flatten shipped. Change that clause to:

```markdown
and `/D` (down) appearances are not rendered (`page.ToImage`/`ToSvg` composite `/N` only, as a static render has no mouse state).
```

- [ ] **Step 4: Add the options to the API overview table**

In the API-overview table, find the `page.ToImage` / `page.ToSvg` rows and extend their descriptions to mention `annotations` (default true, opt out with `false`). If no such rows exist, add them adjacent to the other `page.*` rows:

```markdown
| `page.ToSvg(opts?)` | Render the page to a standalone SVG string (`box`, `annotations`) |
| `page.ToImage(opts?)` | Render the page to PNG bytes (`scale`/`width`/`height`, `box`, `background`, `annotations`) |
```

- [ ] **Step 5: Update the CLAUDE.md module map**

In the `- **svgrender.ts**, **raster.ts**, **pagerender.ts** — rendering (`ToSvg` / `ToImage`)` bullet, add `**annotappearance.ts**` to the backing-module list with a short gloss:

```markdown
  **annotappearance.ts** (read-only `/AP` resolution — the visibility predicate and
  the `/N`+`/AS`+`/Rect`/`/BBox`/`/Matrix` placement, shared with flatten.ts),
```

And in the `- **annotation.ts**` bullet, append:

```markdown
  Appearance *resolution* for both rendering and flattening lives in
  **annotappearance.ts**.
```

- [ ] **Step 6: Verify the docs match the shipped API**

```bash
npm run typecheck && npm test
grep -n "annotations: false" README.md
grep -n "annotappearance" CLAUDE.md
```

Expected: both gates PASS; each `grep` returns at least one hit. Re-read the two edited README bullets end-to-end and confirm they read as one sentence flow, not a bolted-on fragment.

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(57b): annotation appearances render by default

Also fixes a stale claim that annotation flattening is out of scope.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Close out

- [ ] **Step 1: Run both gates one final time**

```bash
npm run typecheck
npm test
```

Expected: both PASS. Do not proceed otherwise.

- [ ] **Step 2: Verify the acceptance criteria by hand**

Re-read `bd show aspose-pdf-foss-for-ts-57b`. Confirm each criterion maps to a passing test in `test/annotrender.test.ts`:
- appearances composite at correct position/scale → the `/Rect` + `/Matrix` + `scale: 2` tests
- hidden/noview skipped → the Hidden and Popup/NoView tests
- stamp/link/filled-field/signature appearance renders → the stamp and widget `/AS` tests

**Note the honest gap:** the fixtures exercise stamp and widget appearances. Link and signature annotations are the *same* code path (any `/Subtype` with an `/AP /N` is drawn identically) — there is nothing subtype-specific to test. State that in the close-out rather than implying broader fixture coverage than exists.

- [ ] **Step 3: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-57b
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

`aspose-pdf-foss-for-ts-vdp` (flatten bakes `/Popup`) stays open — it is deliberately out of scope here.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `src/annotappearance.ts` (new) | Task 1 |
| `src/flatten.ts` (refactor) | Task 2 |
| `src/pagerender.ts` (extend) — pass + fresh state | Task 3 |
| Matrix composition | Task 3 (Step 3 + the asserted values) |
| Public API (`SvgOptions`/`ImageOptions.annotations`) | Task 3 (SVG), Task 4 (raster) |
| Error handling (per-annot try/catch) | Task 3 Step 3; proven Task 3 + Task 4 ("after a malformed one") |
| Testing — placement, /BBox scale, /Matrix | Tasks 1, 3, 4 |
| Testing — Hidden, NoView, Popup | Tasks 1, 3, 4 |
| Testing — widget /AS sub-state | Tasks 1, 3 |
| Testing — `annotations: false` | Tasks 3, 4 |
| Testing — no /AP, /AS missing state | Tasks 1, 3, 4 |
| Testing — existing render tests green | Task 3 Step 6, Task 4 Step 5 |
| Testing — flatten tests green across refactor | Task 2 Steps 1 + 5 |
| Documentation (README + CLAUDE.md) | Task 5 |
| Out of scope: `/D`, flatten `/Popup` | Global Constraints; Task 5 Step 3; Task 6 Step 3 |

One spec item is deliberately *not* a task: the spec's "a filled text field and a signature appearance render" test. Those are the same code path as the stamp/widget tests with no subtype-specific branch, so a dedicated fixture would assert nothing new. Task 6 Step 2 records this gap explicitly instead of papering over it.

**Placeholder scan:** No TBD/TODO. Every code step carries complete code. Task 5's steps quote exact insertion text.

**Type consistency:** `resolveAppearance` → `AnnotAppearance { entry, stream, place }` used identically in Tasks 2 and 3. `isAnnotVisible` / `annotFlags` / `FLAG_HIDDEN` / `FLAG_NOVIEW` named consistently across Tasks 1-3. `InterpretOptions { annotations?: boolean }` defined in Task 3 and consumed in Task 4; `interpret`'s 5th parameter is optional, so Task 4's `raster.ts` compiles between the two tasks.
