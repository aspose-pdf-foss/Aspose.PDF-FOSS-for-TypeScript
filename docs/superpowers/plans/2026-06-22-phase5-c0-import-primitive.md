# Phase 5 — C0: importPageAsXObject + prependContent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the page-import foundation for Phase 5 composition — an internal `importPageAsXObject` primitive that copies a page (from the same or another document) into a target document as a shareable Form XObject, plus a `prependContent` underlay splice.

**Architecture:** `compose.ts` gains `importPageAsXObject(target, src)`: it reads the source page's decoded content as the XObject stream body, deep-copies the source page's `/Resources` graph into the target document (reusing `extractor.ts`'s `cloneShallow` + `rewriteRefs`), and builds a `/Subtype /Form` XObject with `/BBox` = source CropBox and `/Matrix` oriented per the page `/Rotate`. `pagecontent.ts` gains `prependContent`, the q/Q-wrapped mirror of `appendContent` that splices a body *before* existing content (so it draws as an underlay). No public API yet — both are internal building blocks for C1–C3.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies (only `node:` built-ins).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { Page } from './page.js'`).
- **Live-mutation model** — edits act on the live object map; never mutate a possibly-shared source object in place. Cross-document copy must leave the source document untouched.
- **TDD** — write the failing test first; land with a fixture builder in `test/helpers/` mirroring existing style.
- **Errors** — public errors are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` (`errors.ts`); use `TypeError` / `RangeError` for argument validation.
- **Run before done:** `npm run typecheck` and `npm test` must both be green.

---

### Task 1: `prependContent` underlay splice

**Files:**
- Modify: `src/pagecontent.ts` (add `prependContent` beside `appendContent`)
- Test: `test/compose-prepend.test.ts` (create)

**Interfaces:**
- Consumes: existing module-private `normalizeContents`, `concat`, `streamOf`, and the imported `enc` (from `./serialize.js`) in `src/pagecontent.ts`.
- Produces: `export function prependContent(doc: Document, page: Page, body: Uint8Array): void` — splices `body` (assumed self-contained, i.e. its own `q`/`Q`) before existing `/Contents`, wrapping existing content in `q`/`Q`. When the page has no content streams, sets `/Contents` to a single stream of `body`.

- [ ] **Step 1: Write the failing test**

Create `test/compose-prepend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { prependContent } from '../src/pagecontent.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('prependContent (underlay splice)', () => {
  it('inserts body before existing content, wrapping existing in q/Q', () => {
    const doc = Document.Open(buildMultiStreamPage(['ORIGcontent']));
    const page = doc.Pages[0];
    prependContent(doc, page, enc('q UNDERbody Q'));
    const c = dec(page.Contents);
    expect(c).toContain('UNDERbody');
    expect(c.indexOf('UNDERbody')).toBeLessThan(c.indexOf('ORIGcontent')); // underlay first
    expect(c).toContain('q\n'); // existing wrapped
    expect(c).toMatch(/Q\s*$/); // ...and closed at the end
  });

  it('sets a single content stream when the page has none', () => {
    const doc = Document.Open(buildMultiStreamPage(['X']));
    const page = doc.Pages[0];
    page.Dict.delete('Contents');
    prependContent(doc, page, enc('BODY'));
    expect(dec(page.Contents)).toContain('BODY');
  });

  it('survives a Save/Open round-trip', () => {
    const doc = Document.Open(buildMultiStreamPage(['ORIGcontent']));
    prependContent(doc, doc.Pages[0], enc('q UNDERbody Q'));
    const reopened = Document.Open(doc.Save());
    const c = dec(reopened.Pages[0].Contents);
    expect(c.indexOf('UNDERbody')).toBeLessThan(c.indexOf('ORIGcontent'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose-prepend.test.ts`
Expected: FAIL — `prependContent` is not exported from `../src/pagecontent.js`.

- [ ] **Step 3: Implement `prependContent`**

In `src/pagecontent.ts`, add directly after the `appendContent` function (end of file):

```ts
/** Splice `body` into /Contents BEFORE existing content, so it draws behind it
 *  (an underlay). Existing content is wrapped in q/Q so its state stays
 *  isolated. `body` is assumed self-contained (its own q/Q), mirroring
 *  appendContent. */
export function prependContent(doc: Document, page: Page, body: Uint8Array): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  if (existing.length === 0) {
    page.Dict.set('Contents', [doc.allocObject(streamOf(body))]);
    return;
  }
  const headRef = doc.allocObject(streamOf(concat([body, enc('\nq\n')])));
  const tailRef = doc.allocObject(streamOf(enc('Q\n')));
  page.Dict.set('Contents', [headRef, ...existing, tailRef]);
}
```

(No new imports needed: `normalizeContents`, `concat`, `streamOf` are module-local; `enc` is already imported from `./serialize.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/compose-prepend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add src/pagecontent.ts test/compose-prepend.test.ts
git commit -m "feat(639.2): prependContent underlay splice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `importPageAsXObject` primitive

**Files:**
- Create: `src/compose.ts`
- Create: `test/helpers/build-compose-pdf.ts`
- Test: `test/compose-import.test.ts` (create)

**Interfaces:**
- Consumes: `cloneShallow`, `rewriteRefs` from `./extractor.js`; `mul`, `Matrix` from `./text.js`; `name` from `./types.js`; `Document.allocObject(obj): PdfRef`, `Document.getObject(num): PdfObject`; `Page.Document`, `Page.Contents` (decoded `Uint8Array`), `Page.Resources` (`PdfDict | undefined`, inherited-aware), `Page.CropBox` (`number[]`, falls back to MediaBox), `Page.Rotate` (`number`, normalized 0/90/180/270).
- Produces: `export function importPageAsXObject(target: Document, src: Page): PdfRef` — allocates and returns a `/Subtype /Form` XObject ref in `target` whose stream body is the source page's decoded content, `/BBox` is the source CropBox, `/Matrix` orients the content per `/Rotate`, and `/Resources` is a deep copy of the source page's resources. The XObject is reusable: place it once per target page (C1/C2) or once per N-up cell (C3).

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-compose-pdf.ts`:

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

/** One page, MediaBox/CropBox [0 0 200 100], a /Font /F1 resource, content that
 *  shows "Hi". `rotate` (default 0) sets /Rotate on the page. */
export function buildComposeSource(rotate = 0): Uint8Array {
  const content = `BT /F1 12 Tf 10 40 Td (Hi) Tj ET`;
  const rot = rotate ? ` /Rotate ${rotate}` : '';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [0 0 200 100]` +
    `${rot} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(objects, 5, 1);
}

/** One blank page (no /Contents), MediaBox [0 0 300 300] — an import target. */
export function buildComposeTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 3, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/compose-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { importPageAsXObject } from '../src/compose.js';
import { isDict, isName, isStream } from '../src/types.js';
import { buildComposeSource, buildComposeTarget } from './helpers/build-compose-pdf.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('importPageAsXObject', () => {
  it('imports a page as a /Form XObject with BBox = source CropBox and its content', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);

    const xobj = target.resolve(ref);
    expect(isStream(xobj)).toBe(true);
    const d = (xobj as { dict: Map<string, unknown> }).dict;
    expect(isName(d.get('Subtype')) && (d.get('Subtype') as { name: string }).name).toBe('Form');
    expect(d.get('BBox')).toEqual([0, 0, 200, 100]);
    expect(dec((xobj as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });

  it('deep-copies the source resources into the target document', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);

    const d = (target.resolve(ref) as { dict: Map<string, unknown> }).dict;
    const res = target.resolve(d.get('Resources') as never);
    expect(isDict(res)).toBe(true);
    const fonts = target.resolve((res as Map<string, unknown>).get('Font') as never);
    expect(isDict(fonts)).toBe(true);
    const f1 = target.resolve((fonts as Map<string, unknown>).get('F1') as never);
    expect(isDict(f1)).toBe(true); // the Helvetica font dict now lives in target
  });

  it('leaves the source document untouched', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const beforeContent = dec(src.Pages[0].Contents);
    importPageAsXObject(target, src.Pages[0]);
    expect(dec(src.Pages[0].Contents)).toBe(beforeContent);
    // source resources intact and still resolvable
    const srcFonts = src.resolve(src.Pages[0].Resources!.get('Font') as never);
    expect(isDict(srcFonts)).toBe(true);
  });

  it('orients content per /Rotate via /Matrix', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource(90)); // CropBox [0 0 200 100], w=200 h=100
    const ref = importPageAsXObject(target, src.Pages[0]);
    const d = (target.resolve(ref) as { dict: Map<string, unknown> }).dict;
    // translate(0,0) then rotate 90 -> [0,1,-1,0, h, 0] with h=100
    expect(d.get('Matrix')).toEqual([0, 1, -1, 0, 100, 0]);
  });

  it('round-trips: imported XObject survives Save/Open', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);
    // reference it so mark-sweep keeps it, then round-trip
    target.Pages[0].Dict.set('Keep', ref);
    const reopened = Document.Open(target.Save());
    const kept = reopened.resolve(reopened.Pages[0].Dict.get('Keep'));
    expect(isStream(kept)).toBe(true);
    expect(dec((kept as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/compose-import.test.ts`
Expected: FAIL — cannot resolve `../src/compose.js` (module does not exist).

- [ ] **Step 4: Implement `compose.ts`**

Create `src/compose.ts`:

```ts
// Page composition (Phase 5). C0: import a page (from this or another document)
// into a target document as a shareable Form XObject — the foundation the
// overlay/underlay, N-up, and stamping APIs build on. Append-only consumers.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfRef, name } from './types.js';
import { cloneShallow, rewriteRefs } from './extractor.js';
import { mul, type Matrix } from './text.js';

/** Deep-copy the object graph reachable from `root` (resolved in `srcDoc`) into
 *  `target`, returning a copy of `root` whose refs point at the freshly
 *  allocated target objects. Cycle-safe; allocates one target object per
 *  distinct source object and never mutates the source. */
function importGraphInto(target: Document, srcDoc: Document, root: PdfObject): PdfObject {
  const seen = new Map<number, PdfRef>(); // source obj num -> target ref
  const visit = (r: PdfRef): PdfRef => {
    const existing = seen.get(r.num);
    if (existing) return existing;
    const clone = cloneShallow(srcDoc.getObject(r.num));
    const newRef = target.allocObject(clone);
    seen.set(r.num, newRef);
    rewriteRefs(clone, visit); // recurse into the stored clone (mutates the copy)
    return newRef;
  };
  const rootClone = cloneShallow(root);
  rewriteRefs(rootClone, visit);
  return rootClone;
}

/** Matrix mapping the source CropBox (with /Rotate applied) into an upright
 *  form-space box anchored at the origin. /BBox stays = CropBox; consumers
 *  transform the BBox by this matrix to position the placement. */
function importMatrix(rotate: number, box: number[]): Matrix {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const t: Matrix = [1, 0, 0, 1, -x0, -y0]; // CropBox origin -> (0,0)
  let rot: Matrix;
  switch (rotate) {
    case 90:  rot = [0, 1, -1, 0, h, 0]; break;
    case 180: rot = [-1, 0, 0, -1, w, h]; break;
    case 270: rot = [0, -1, 1, 0, 0, w]; break;
    default:  rot = [1, 0, 0, 1, 0, 0];
  }
  return mul(t, rot); // t then rot
}

/** @internal Import `src` (a page from this or another Document) into `target`
 *  as a shareable Form XObject and return its new ref in `target`. The page's
 *  decoded content becomes the stream body, its resources are deep-copied,
 *  /BBox is the source CropBox, and /Matrix orients the content per /Rotate.
 *  The source document is left untouched. */
export function importPageAsXObject(target: Document, src: Page): PdfRef {
  const srcDoc = src.Document;
  const body = src.Contents; // decoded, concatenated bytes
  const srcRes = src.Resources;
  const resources: PdfObject = srcRes
    ? importGraphInto(target, srcDoc, srcRes)
    : new Map<string, PdfObject>();
  const box = src.CropBox; // falls back to MediaBox
  const matrix = importMatrix(src.Rotate, box);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box[0], box[1], box[2], box[3]]],
    ['Matrix', [...matrix]],
    ['Resources', resources],
  ]);
  return target.allocObject({ kind: 'stream', dict, raw: body });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/compose-import.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output (success).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass (the prior 526 plus the new compose tests).

- [ ] **Step 8: Commit**

```bash
git add src/compose.ts test/compose-import.test.ts test/helpers/build-compose-pdf.ts
git commit -m "feat(639.2): importPageAsXObject page-import primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Closing the issue

After both tasks are green and committed:

- [ ] Record a beads memory:

```bash
bd remember --key compose-c0-shipped "compose-c0-shipped: src/compose.ts importPageAsXObject(target,src)->PdfRef (issue 639.2). Deep-copies src page Resources graph into target (importGraphInto via extractor cloneShallow+rewriteRefs), body=src.Contents (decoded), /Subtype/Form, /BBox=src CropBox, /Matrix=importMatrix(Rotate,box) (translate CropBox origin->0,0 then rotate). Shareable XObject; source untouched. Also src/pagecontent.ts prependContent (underlay: body before existing, existing wrapped q/Q) mirrors appendContent. Next: 639.3 page.StampWith places it (BBox->rect placement like flatten L1) via append/prependContent."
```

- [ ] Close the issue:

```bash
bd close aspose-pdf-foss-for-ts-639.2 --reason "C0 shipped: importPageAsXObject primitive (compose.ts) + prependContent underlay splice (pagecontent.ts). Deep-copies resources cross-document, source untouched, Save/Open round-trips. Tests: test/compose-import.test.ts, test/compose-prepend.test.ts. Typecheck + full suite green."
```

- [ ] Push:

```bash
git pull --rebase && git push && git status  # MUST show up to date with origin
```

## Notes for the next plan (C1, issue 639.3)

`page.StampWith(src, opts)` will call `importPageAsXObject(this.Document, src)` once, register the returned ref under the page's COW `/Resources /XObject` (fresh `Fm` key via `ensureOwnResources` / `ensureOwnSubdict` / `freshKey`), compute the BBox→`rect` placement matrix the same way flatten L1's `placementMatrix` does (transform the XObject `/BBox` by its `/Matrix`, take the aligned bounding box, scale/translate onto `rect`), then emit `q [gs] <cm> /Fmk Do Q` via `appendContent` (overlay) or the new `prependContent` (underlay). Opacity reuses `registerExtGState`. Consider extracting flatten's `placementMatrix` into a shared helper at that point.

## Self-Review

- **Spec coverage (C0 scope):** importPageAsXObject primitive (Task 2) ✓; cross-document copy leaving source untouched (Task 2, test 3) ✓; /BBox = CropBox, /Matrix for /Rotate (Task 2, tests 1 & 4) ✓; shareable XObject (returned ref reused by consumers — documented) ✓; prependContent underlay splice (Task 1) ✓. Self-stamp (src === target) is handled by always cloning (no dedicated test — same code path; covered implicitly).
- **Placeholder scan:** none — every code/test step shows complete code and exact commands.
- **Type consistency:** `importPageAsXObject(target, src) → PdfRef`, `prependContent(doc, page, body) → void`, helper names `importGraphInto` / `importMatrix` are used consistently across tasks and the closing notes. Matrix type from `text.ts`; `mul(t, rot)` matches its "m followed by n" convention.
