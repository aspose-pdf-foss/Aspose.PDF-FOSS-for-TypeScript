# Redaction Removes Covered Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every redaction path remove the annotations covering the redacted region, so their text stops reaching the saved file and their appearances stop rendering over the marker box.

**Architecture:** A new `redactannots.ts` owns the whole annotation half — the intersection rule, the `/Redact` exemption, popup orphans, and routing a covered widget through field removal. `redactRegions` calls it once, so all four public entry points share one implementation.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-05-redact-annotations-design.md`
**Issue:** `aspose-pdf-foss-for-ts-mssf` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, strict TypeScript.** Every import specifier carries the `.js` extension.
- **Task tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **Assert on raw saved bytes, not `GetText()`.** `GetText()` walks page content only and reports every one of these leaks as gone. A test written against it passes on a document that still carries the secret. This is the single most important rule in this plan.
- **The sweep throws nothing.** An unreadable `/Rect`, a widget whose field cannot be located, and a `/Popup` with no `/Parent` are each skipped. Redaction must not fail on an annotation shape we merely decline to judge.
- **`/Redact` annotations are never swept.** They are redaction machinery. This is also what keeps `applyRedactions` owning its own marks after `paintRedactOverlay` has read them.
- **Check typecheck's exit code directly** (`npm run typecheck; echo "EXIT=$?"`). Piping it through `tail` masks failures — that has already happened once in this repo.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- Commit after every task. Do not push until the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/redactannots.ts` (**create**) | `removeCoveredAnnotations` — the intersection rule, `/Redact` exemption, popup orphans, widget→field routing |
| `src/redact.ts` (modify) | `redactRegions` calls the sweep; `RedactOptions.keepAnnotations` |
| `src/redactapply.ts` (modify) | `ApplyRedactionsOptions.keepAnnotations`, threaded to `redactRegions` |
| `test/redact-annots.test.ts` (**create**) | the whole feature, unit and end-to-end |
| `README.md`, `CLAUDE.md` (modify) | user-facing docs, architecture note |

**On the module cycle.** `redact.ts` imports `redactannots.ts`, so `redactannots.ts` must NOT import `redact.ts` — that would be circular. `norm`/`intersects` are module-private in `redact.ts` and stay there; `redactannots.ts` defines its own four lines of AABB math. Duplicating that is preferable to a cycle, the two uses are independent (content-box vs region, annotation-rect vs region), and `redactapply.ts` already carries its own `normRect` for the same reason.

---

### Task 1: The sweep, for non-widget annotations

**Files:**
- Create: `src/redactannots.ts`
- Create: `test/redact-annots.test.ts`

**Interfaces:**
- Consumes: `Page.RemoveAnnotation(a: Annotation | PdfDict): void` (already accepts a raw dict, and is what calls `untagObjects`).
- Produces: `removeCoveredAnnotations(doc: Document, page: Page, rects: Rect[]): number` exported from `src/redactannots.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/redact-annots.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { removeCoveredAnnotations } from '../src/redactannots.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import type { Rect } from '../src/text.js';

const REGION: Rect = [40, 80, 260, 140];

/** A page with text inside REGION, annotations over it, and one far away. */
function build(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
  const p = doc.Pages[0];
  p.AddTextNote({ rect: [60, 90, 80, 110], contents: 'NoteSecret', author: 'AuthorSecret' });
  p.AddFreeText({ rect: [90, 85, 250, 135], contents: 'FreeTextSecret' });
  p.AddHighlight({ quads: [45, 115, 255, 115, 45, 85, 255, 85], contents: 'HighlightSecret' });
  p.AddLink({
    rect: [45, 85, 255, 135],
    action: { type: 'uri', uri: 'https://secret.example/LinkSecret' },
  });
  p.AddTextNote({ rect: [500, 500, 520, 520], contents: 'FarAwaySecret' });
  return doc;
}

describe('removeCoveredAnnotations', () => {
  it('removes every annotation intersecting the region and counts them', () => {
    const doc = build();
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(4);
    expect(doc.Pages[0].Annotations.map((a) => a.Contents)).toEqual(['FarAwaySecret']);
  });

  it('leaves an annotation outside the region untouched', () => {
    const doc = build();
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    const kept = doc.Pages[0].Annotations;
    expect(kept).toHaveLength(1);
    expect(kept[0].Rect).toEqual([500, 500, 520, 520]);
  });

  it('removes on any intersection, not only full containment', () => {
    // Clips the region's top-right corner and hangs well outside it.
    const doc = build();
    doc.Pages[0].AddStamp({ rect: [250, 135, 400, 200], text: 'ClipSecret' });
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    expect(doc.Pages[0].Annotations.map((a) => a.Rect))
      .toEqual([[500, 500, 520, 520]]);
  });

  it('never sweeps a /Redact mark', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'X' });
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    expect(doc.Pages[0].Annotations.map((a) => a.Subtype).sort())
      .toEqual(['Redact', 'Text']);
  });

  it('removes a popup orphaned by its parent', () => {
    const doc = build();
    const p = doc.Pages[0];
    // A markup inside the region, with a popup parked far outside it.
    p.AddSquare({ rect: [50, 90, 100, 130], popup: { rect: [600, 600, 700, 700] } });
    expect(p.Annotations.some((a) => a.Subtype === 'Popup')).toBe(true);

    removeCoveredAnnotations(doc, p, [REGION]);
    expect(p.Annotations.some((a) => a.Subtype === 'Popup')).toBe(false);
  });

  it('skips an annotation with no readable /Rect rather than throwing', () => {
    const doc = build();
    const p = doc.Pages[0];
    const note = p.Annotations[0];
    note.Dict.delete('Rect');
    expect(() => removeCoveredAnnotations(doc, p, [REGION])).not.toThrow();
    expect(p.Annotations).toContain(p.Annotations.find((a) => a.Dict === note.Dict));
  });

  it('returns 0 and changes nothing when given no regions', () => {
    const doc = build();
    const before = doc.Pages[0].Annotations.length;
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [])).toBe(0);
    expect(doc.Pages[0].Annotations).toHaveLength(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: FAIL — cannot resolve `../src/redactannots.js`.

- [ ] **Step 3: Create the module**

Create `src/redactannots.ts`:

```ts
// The annotation half of redaction. Content surgery in redact.ts works only on
// content streams through EditableContent; /Annots is a separate object graph it
// never visits, so an annotation over a redacted region keeps its text — and,
// when it has an /AP, keeps drawing it on top of the marker box, because
// annotations composite after page content.
//
// Imports nothing from redact.ts: redact.ts imports this module, and the reverse
// would be a cycle. The four lines of AABB math below are therefore local.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isDict, isName } from './types.js';
import type { Rect } from './text.js';

/** A rect as [minX, minY, maxX, maxY], however the corners were ordered. */
function normRect(r: Rect): Rect {
  return [
    Math.min(r[0], r[2]), Math.min(r[1], r[3]),
    Math.max(r[0], r[2]), Math.max(r[1], r[3]),
  ];
}

/** Inclusive AABB overlap: touching edges count as intersecting. */
function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** /Subtype name without the leading slash; '' when absent. */
function subtypeOf(doc: Document, d: PdfDict): string {
  const s = doc.resolve(d.get('Subtype'));
  return isName(s) ? s.name : '';
}

/** /Rect as four finite numbers, or undefined when missing or malformed. */
function rectOf(doc: Document, d: PdfDict): Rect | undefined {
  const a = doc.resolve(d.get('Rect'));
  if (!isArray(a) || a.length < 4) return undefined;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return [out[0], out[1], out[2], out[3]];
}

/**
 * Remove every annotation on `page` whose /Rect intersects one of `rects`, and
 * return how many went. Intersection rather than containment: a /FreeText
 * hanging half out of the region carries its whole text and draws all of it.
 *
 * A /Redact annotation is never removed — it is redaction machinery, not page
 * content, and applyRedactions owns removing its own marks after the overlay
 * painter has read them.
 *
 * Nothing here throws: an annotation with no readable /Rect is skipped, because
 * redaction must not fail on a shape we merely decline to judge.
 */
export function removeCoveredAnnotations(
  doc: Document, page: Page, rects: Rect[],
): number {
  if (rects.length === 0) return 0;
  const regions = rects.map(normRect);

  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return 0;
  // Snapshot before mutating: removal splices the very array we are walking.
  const entries: PdfObject[] = [...annots];

  const doomed: PdfDict[] = [];
  const dead = new Set<PdfDict>();
  for (const e of entries) {
    const d = doc.resolve(e);
    if (!isDict(d)) continue;
    if (subtypeOf(doc, d) === 'Redact') continue;
    const r = rectOf(doc, d);
    if (r === undefined) continue;
    const box = normRect(r);
    if (!regions.some((g) => intersects(box, g))) continue;
    doomed.push(d);
    dead.add(d);
  }

  // A markup's popup follows its parent wherever the popup itself sits, the same
  // orphan rule flatten.ts applies when it bakes a markup away.
  for (const e of entries) {
    const d = doc.resolve(e);
    if (!isDict(d) || dead.has(d)) continue;
    if (subtypeOf(doc, d) !== 'Popup') continue;
    const parent = doc.resolve(d.get('Parent'));
    if (isDict(parent) && dead.has(parent)) { doomed.push(d); dead.add(d); }
  }

  let removed = 0;
  for (const d of doomed) {
    if (subtypeOf(doc, d) === 'Widget') continue; // field removal lands in Task 2
    // RemoveAnnotation, not a raw splice: it is what calls untagObjects, so a
    // tagged annotation does not survive via its /OBJR.
    page.RemoveAnnotation(d);
    removed++;
  }
  return removed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/redactannots.ts test/redact-annots.test.ts
git commit -m "feat(redact): sweep annotations covering a redacted region (mssf)"
```

---

### Task 2: A covered widget takes its whole field

**Files:**
- Modify: `src/redactannots.ts`
- Modify: `test/redact-annots.test.ts`

**Interfaces:**
- Consumes: `removeField(doc: Document, field: PdfDict): boolean` from `src/formremove.ts` — unwires the field from `/AcroForm /Fields`, detaches every widget it owns on every page, and untags.
- Produces: no new exported names; `removeCoveredAnnotations` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append to `test/redact-annots.test.ts`:

```ts
/** The saved file as latin1 text, for byte-level leak assertions. */
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('removeCoveredAnnotations — form fields', () => {
  it('removes the whole field, not just the widget', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.Form.AddTextField({ page: 1, rect: [50, 90, 250, 130], name: 'ssn', value: '123-45-6789' });

    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);

    expect(doc.Form.Get('ssn')).toBeUndefined();          // unwired from /AcroForm
    expect(doc.Pages[0].Annotations).toHaveLength(0);      // widget detached
    expect(savedText(doc)).not.toContain('123-45-6789');   // the value is gone
  });

  it('takes a radio group entirely, including a widget on an untouched page', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.AddPage();
    doc.Form.AddRadioGroup({
      name: 'choice',
      options: [
        { page: 1, export: 'CoveredSecret', rect: [50, 90, 70, 110] },
        { page: 2, export: 'OtherPageSecret', rect: [50, 500, 70, 520] },
      ],
    });

    // Only page 1's widget is in the region; the group's value is shared, so the
    // whole group goes.
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);

    expect(doc.Form.Get('choice')).toBeUndefined();
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(doc.Pages[1].Annotations).toHaveLength(0); // other page cleaned too
    expect(savedText(doc)).not.toContain('OtherPageSecret');
  });

  it('skips a widget whose field is not in the tree rather than throwing', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.Form.AddTextField({ page: 1, rect: [50, 90, 250, 130], name: 'orphan', value: 'v' });
    // Unwire /AcroForm /Fields so the widget's field can no longer be located.
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    acro.set('Fields', []);

    expect(() => removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).not.toThrow();
  });
});
```

Add `PdfDict` to the `../src/types.js` import at the top of the file (Task 1 did not need it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: FAIL — the widget is skipped, so the count is 0, `Form.Get('ssn')` still resolves, and the value is still in the bytes.

- [ ] **Step 3: Implement the widget path**

In `src/redactannots.ts`, add the import:

```ts
import { removeField } from './formremove.js';
```

Add this helper above `removeCoveredAnnotations`:

```ts
/** The terminal field a widget belongs to: the widget itself when it is a merged
 *  field/widget dict (it carries /FT), otherwise the nearest /Parent that does.
 *  The hop cap stops a cyclic /Parent from hanging the sweep. */
function fieldOf(doc: Document, widget: PdfDict): PdfDict | undefined {
  let node: PdfDict | undefined = widget;
  for (let hops = 0; node !== undefined && hops < 32; hops++) {
    if (node.has('FT')) return node;
    const p = doc.resolve(node.get('Parent'));
    node = isDict(p) ? p : undefined;
  }
  return undefined;
}
```

Then replace the `Widget` line in the removal loop:

```ts
  let removed = 0;
  for (const d of doomed) {
    if (subtypeOf(doc, d) === 'Widget') {
      // A widget's value lives on the field, so detaching the widget alone would
      // leave the field and its /V in /AcroForm /Fields — a leak and a stranded
      // object both. removeField unwires the field, detaches every widget it
      // owns (on any page), and untags. A radio group therefore goes whole,
      // which is the honest consequence of a shared /V.
      const field = fieldOf(doc, d);
      if (field !== undefined && removeField(doc, field)) removed++;
      continue;
    }
    // RemoveAnnotation, not a raw splice: it is what calls untagObjects, so a
    // tagged annotation does not survive via its /OBJR.
    page.RemoveAnnotation(d);
    removed++;
  }
  return removed;
```

Note `removeField` already detaches the widget from `/Annots`, so there is no `RemoveAnnotation` call on this branch. It returns `false` when the field is not in the tree, which is the skip case.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: PASS, all ten.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/redactannots.ts test/redact-annots.test.ts
git commit -m "feat(redact): a covered widget takes its whole field (mssf)"
```

---

### Task 3: Wire it into every redaction path

**Files:**
- Modify: `src/redact.ts`, `src/redactapply.ts`
- Modify: `test/redact-annots.test.ts`

**Interfaces:**
- Consumes: `removeCoveredAnnotations(doc, page, rects): number` (Tasks 1–2).
- Produces: `RedactOptions.keepAnnotations?: boolean` and `ApplyRedactionsOptions.keepAnnotations?: boolean`, both defaulting to `false`. `redactRegions` gains a fifth parameter: `redactRegions(doc, page, rects, paint, keepAnnotations = false)`.

- [ ] **Step 1: Write the failing end-to-end tests**

Append to `test/redact-annots.test.ts`:

```ts
const SECRETS = [
  'NoteSecret', 'AuthorSecret', 'FreeTextSecret', 'HighlightSecret', 'LinkSecret',
];

describe('redaction removes covered annotations end to end', () => {
  it('leaves no annotation secret in the bytes after page.Redact', () => {
    const doc = build();
    doc.Pages[0].Redact([REGION]);
    const bytes = savedText(doc);
    // Assert on raw bytes: GetText() walks page content only and reports every
    // one of these as gone even when the file still carries them.
    for (const s of ['PageSecret', ...SECRETS]) expect(bytes).not.toContain(s);
    expect(bytes).toContain('FarAwaySecret'); // untouched annotation survives
  });

  it('leaves no annotation secret in the bytes after ApplyRedactions', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION });
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);
    const bytes = savedText(doc);
    for (const s of ['PageSecret', ...SECRETS]) expect(bytes).not.toContain(s);
  });

  it('stops the covered FreeText ink from rendering over the marker box', () => {
    // The visible half of the leak: the marker box is page content and
    // annotations composite on top of it, so before this fix ToSvg still drew
    // the FreeText's text across the redacted region.
    const doc = build();
    doc.Pages[0].Redact([REGION]);
    expect(Document.Open(doc.Save()).Pages[0].ToSvg()).not.toContain('FreeTextSecret');
  });

  it('keeps them — and the secrets — under keepAnnotations', () => {
    const doc = build();
    doc.Pages[0].Redact([REGION], { keepAnnotations: true });
    const bytes = savedText(doc);
    expect(bytes).not.toContain('PageSecret');  // content still redacted
    expect(bytes).toContain('NoteSecret');      // annotation deliberately kept
    expect(doc.Pages[0].Annotations.length).toBeGreaterThan(1);
  });

  it('honours keepAnnotations on ApplyRedactions too', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION });
    doc.Pages[0].ApplyRedactions({ keepAnnotations: true });
    expect(savedText(doc)).toContain('NoteSecret');
  });

  it('redacts by text without stranding the covered annotations', () => {
    const doc = build();
    expect(doc.Pages[0].RedactText('PageSecret')).toBe(1);
    expect(savedText(doc)).not.toContain('NoteSecret');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: FAIL — the annotation secrets are still in the bytes, `ToSvg` still contains the ink, and `keepAnnotations` is not a known option (a TS error at build, and the runtime behaviour is unchanged).

- [ ] **Step 3: Add the option and the call in `redact.ts`**

Add the field to `RedactOptions`:

```ts
export interface RedactOptions {
  /** Fill colour of the redaction marker box as [r, g, b] in 0..1 (default black). */
  color?: [number, number, number];
  /** Also clear document metadata (/Info + XMP) when true. */
  scrubMetadata?: boolean;
  /** Keep annotations overlapping a redacted region instead of removing them.
   *  Default false. Setting it preserves their text in the saved file — and, for
   *  an annotation with an /AP, keeps drawing it over the marker box. */
  keepAnnotations?: boolean;
}
```

Add the import:

```ts
import { removeCoveredAnnotations } from './redactannots.js';
```

Extend `redactRegions` and its one existing caller:

```ts
export function redactRegions(
  doc: Document, page: Page, rects: Rect[], paint: (rects: Rect[]) => void,
  keepAnnotations = false,
): void {
  const valid = rects.map(checkRect); // validate up front: no partial mutation on bad input
  const ec = new EditableContent(doc, page);
  removeRegionContent(doc, page, valid, ec); // text + images in one per-stream rebuild
  sanitizeResources(doc, page, ec);
  ec.commit();
  paint(valid);
  // Last, so the painter saw an unchanged annotation set. Nothing here touches
  // content streams, so the position is otherwise free.
  if (!keepAnnotations) removeCoveredAnnotations(doc, page, valid);
}

export function redactPage(doc: Document, page: Page, rects: Rect[], opts: RedactOptions = {}): void {
  redactRegions(doc, page, rects, (rs) => paintRedactionBoxes(doc, page, rs, opts.color),
    opts.keepAnnotations);
  if (opts.scrubMetadata) doc.ClearMetadata();
}
```

`redactText` already forwards its whole `opts` to `redactPage`, so it needs no change.

- [ ] **Step 4: Thread it through `redactapply.ts`**

Add the field to `ApplyRedactionsOptions`:

```ts
export interface ApplyRedactionsOptions {
  /** Also clear document metadata (/Info + XMP) when true. */
  scrubMetadata?: boolean;
  /** Keep annotations overlapping a redacted region instead of removing them.
   *  Default false. Setting it preserves their text in the saved file. */
  keepAnnotations?: boolean;
}
```

and pass it at the `redactRegions` call inside `applyRedactions`:

```ts
  redactRegions(doc, page, marks.flatMap((m) => m.rects), () => {
    for (const m of marks) paintRedactOverlay(doc, page, m.annot, m.rects);
  }, opts.keepAnnotations);
```

The `/Redact` exemption in `removeCoveredAnnotations` is what keeps this safe: the sweep cannot remove the marks that `applyRedactions` is about to remove itself.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/redact-annots.test.ts`
Expected: PASS, all sixteen.

- [ ] **Step 6: Run the whole redaction and flatten suites for regressions**

Run: `npx vitest run test/redact.test.ts test/redact-box.test.ts test/redact-image.test.ts test/redact-sanitize.test.ts test/redact-search.test.ts test/redact-text.test.ts test/redact-apply.test.ts test/redact-annot.test.ts test/flatten-annotations.test.ts test/flatten-struct.test.ts`
Expected: PASS. `ApplyRedactions` removing its own marks and the sweep skipping them must both still hold.

- [ ] **Step 7: Prove the two silent assertions are load-bearing**

Both pass trivially on a correct implementation and both cover a failure invisible in the object model.

1. **The render assertion.** In `src/redactannots.ts`, make the sweep skip `/FreeText`:
   ```ts
       if (subtypeOf(doc, d) === 'FreeText') continue;
   ```
   Run: `npx vitest run test/redact-annots.test.ts` → "stops the covered FreeText ink from rendering over the marker box" MUST fail. Revert.

2. **The untag path.** Replace `page.RemoveAnnotation(d)` with a raw splice of the page's `/Annots`:
   ```ts
       const arr = doc.resolve(page.Dict.get('Annots'));
       if (isArray(arr)) {
         const i = arr.findIndex((e) => doc.resolve(e) === d);
         if (i >= 0) arr.splice(i, 1);
       }
   ```
   Add the tagged-annotation test below, run it, and confirm it fails — then revert the splice and keep the test.

Append the tagged test to `test/redact-annots.test.ts`:

```ts
it('untags a tagged annotation instead of stranding its /OBJR', () => {
  // /StructTreeRoot is reachable from /Root, so an /OBJR naming the annotation
  // keeps it in the saved bytes with no /Annots entry anywhere.
  const doc = build();
  const note = doc.Pages[0].Annotations[0];
  doc.CreateStructTree().Append('Note').AddAnnotation(note);

  doc.Pages[0].Redact([REGION]);
  expect(savedText(doc)).not.toContain('NoteSecret');
});
```

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/redact.ts src/redactapply.ts test/redact-annots.test.ts
git commit -m "feat(redact): every redaction path sweeps covered annotations (mssf)"
```

---

### Task 4: Documentation and wrap-up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces no new names.

- [ ] **Step 1: Replace the README limitation with the new behaviour**

The mark-and-apply section currently ends with a "Two limitations" paragraph naming this as a known gap. The annotation half is now fixed, so that paragraph must not keep claiming it. Replace it with:

```markdown
Redaction also removes annotations covering the region. Any annotation whose
`/Rect` intersects a redacted rect is removed — its text would otherwise survive
in the file, and an annotation with an appearance would keep drawing it over the
marker box, since annotations composite on top of page content. A covered form
field is removed whole (value included), so a radio group with one widget in the
region loses the group. Pass `keepAnnotations: true` to opt out, remembering that
doing so preserves exactly the text the redaction was meant to destroy.

The remaining limitation: the painted overlay is untagged content.
```

- [ ] **Step 2: Add the row to the README options table**

Wherever `RedactOptions` fields are documented, add:

```
| `keepAnnotations` | Keep annotations overlapping the region instead of removing them. Default `false` |
```

- [ ] **Step 3: Update CLAUDE.md**

The `redact.ts` bullet says redact.ts "owns the destructive content surgery and imports no annotation code". That is now contradicted. Reword the module list to name `redactannots.ts` and record the invariant:

```
  **redactannots.ts** removes the annotations covering a redacted region, called
  from `redactRegions` so every entry point shares it. It is its own module
  because `redact.ts` is content-stream surgery and this is object-graph work;
  it must not import `redact.ts` (which imports it), so its AABB helpers are
  local by design.
  **Invariant:** content surgery alone does not redact. `/Annots` is a separate
  object graph that `EditableContent` never visits, so an annotation over the
  region keeps its text — and with an `/AP`, keeps drawing it *over* the marker
  box, because annotations composite after page content. `GetText()` cannot see
  any of this, so the guarantee is asserted on saved bytes and on `ToSvg`.
  **Invariant:** a `/Redact` annotation is never swept. Marks are redaction
  machinery, and exempting them is what lets `applyRedactions` remove its own
  marks after `paintRedactOverlay` has read them.
  **Invariant:** a covered widget is removed through `removeField`, never by
  detaching the widget — the value lives on the field, so a detached widget
  leaves the `/V` in `/AcroForm /Fields`.
```

- [ ] **Step 4: Run the full suite and typecheck**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
npm test
```
Expected: both green. Do not proceed on a red suite.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(redact): document annotation removal and keepAnnotations (mssf)"
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-mssf
git add .beads/          # .beads/ is tracked in this repo
git commit -m "chore(bd): close mssf"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Intersection rule (not containment) | 1 |
| `/Redact` never swept | 1 (impl + test), 3 (why it matters for apply) |
| Unreadable `/Rect` skipped, never throws | 1 |
| Popups follow their parent | 1 |
| Covered widget → `removeField`, radio group goes whole | 2 |
| Widget whose field cannot be located is skipped | 2 |
| `keepAnnotations` on both options interfaces | 3 |
| Called from `redactRegions`, shared by all entry points | 3 |
| Sweep runs last, after `paint` | 3 |
| Module owns its own AABB math (no cycle) | File Structure note, Task 1 |
| `Page.RemoveAnnotation` for the untag path | 1 (impl), 3 Step 7 (mutation-checked) |
| Byte-level assertions, not `GetText()` | Global Constraints, Task 3 |
| `ToSvg` assertion for the visible leak | 3 |
| README + CLAUDE.md | 4 |

No gaps.

**Type consistency:** `removeCoveredAnnotations(doc, page, rects): number` is defined in Task 1, extended (not re-signed) in Task 2, and called in Task 3. `redactRegions` gains its fifth parameter in Task 3 and both call sites — `redactPage` and `applyRedactions` — are updated in the same task. `keepAnnotations` is spelled identically on both options interfaces and at both call sites. `fieldOf` and `removeField` are Task 2-local.

**Two places the plan says to check rather than assume:** Task 2 Step 1 notes `PdfDict` must be added to the test file's imports (Task 1 does not need it); Task 4 Step 2 says to add the options row "wherever `RedactOptions` fields are documented" rather than citing a line number, since Task 4 runs after three commits have shifted the file.
